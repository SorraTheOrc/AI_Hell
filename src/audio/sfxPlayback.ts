/**
 * Web Audio SFX playback layer (AH-0MUTYV92Y000WJ8Z).
 *
 * The ToneForge migration replaces the procedural synthesis in
 * `src/audio/effects.ts` with playback of build-time baked WAV assets. This
 * module owns the *one* shared `AudioContext` and the master SFX gain, and
 * plays a baked asset through them as an `AudioBufferSourceNode`.
 *
 * ## Single shared context (parent AC6)
 *
 * In the game the context is **pinned to Phaser's audio context** via
 * `useAudioContext()` (wired from `MenuScene`), so the whole lifecycle
 * constructs exactly one `AudioContext`. In headless tests, or before Phaser
 * is available, it lazily falls back to `window.AudioContext`; when neither
 * exists every cue degrades to a safe no-op (parent AC7).
 *
 * ## Loading
 *
 * Decoded buffers are cached per asset URL. A request for an asset that is
 * not yet decoded schedules a best-effort background `fetch` + `decodeAudioData`
 * and plays a one-frame silent placeholder so the cue's *timing* is still
 * exact. `preloadSfxAssets()` warms the cache at boot so gameplay cues are
 * audible from the first invocation.
 */

/** Per-play options for {@link SfxSoundProvider.play}. */
export interface SfxPlayOptions {
  /** Seconds from `context.currentTime` to schedule the start (default 0). */
  readonly delay?: number;
  /** Loop the asset until {@link SfxSoundHandle.stop} (default false). */
  readonly loop?: boolean;
  /** Per-play gain in [0, 1] (default 1); the master gain still applies. */
  readonly volume?: number;
}

/** A playing cue that can be stopped (used by continuous cues). */
export interface SfxSoundHandle {
  /** Stops the playback immediately. Safe to call more than once. */
  stop(): void;
}

/**
 * The playback seam consumed by `effects.ts`. A provider owns (or borrows) an
 * `AudioContext` and the master SFX gain, so cues never construct their own
 * context and can be redirected onto Phaser's audio system.
 */
export interface SfxSoundProvider {
  /** The shared context, or null when audio is unavailable (headless). */
  getAudioContext(): AudioContext | null;
  /** Pins playback to an external context (e.g. Phaser's). Idempotent. */
  useAudioContext(context: AudioContext | null): void;
  /** Plays a baked asset, returning a handle or null when audio is off. */
  play(assetUrl: string, options?: SfxPlayOptions): SfxSoundHandle | null;
  /** Sets the shared master volume (clamped to [0, 1]). */
  setVolume(value: number): void;
  /** Mutes/unmutes the shared master gain, preserving the volume level. */
  setMuted(muted: boolean): void;
  /** Forgets the context, master gain and decoded buffers (test seam). */
  reset(): void;
}

/** Clamps a value to the [0, 1] volume range; non-finite values become 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

/**
 * Default {@link SfxSoundProvider}: a single lazily-created `AudioContext`
 * with a master SFX gain, playing baked WAV assets as buffer sources.
 */
export class WebAudioSfxProvider implements SfxSoundProvider {
  private context: AudioContext | null = null;
  private pinnedContext: AudioContext | null = null;
  private master: GainNode | null = null;
  private placeholder: AudioBuffer | null = null;
  private volume = 1;
  private muted = false;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly pending = new Set<string>();

  getAudioContext(): AudioContext | null {
    if (this.context !== null) return this.context;
    const context = this.pinnedContext ?? this.createContext();
    if (context === null) return null;
    this.context = context;
    this.ensureMaster(context);
    return context;
  }

  useAudioContext(context: AudioContext | null): void {
    if (context === this.pinnedContext) return;
    this.pinnedContext = context;
    // Decoded buffers are bound to their context; drop them when it changes.
    if (context !== this.context) {
      this.context = null;
      this.master = null;
      this.buffers.clear();
      this.pending.clear();
    }
  }

  /**
   * The shared master SFX gain, creating the context and gain when needed.
   * Exposed so the thruster runtime shim can route through the same node.
   */
  getMasterGain(): GainNode | null {
    const context = this.getAudioContext();
    return context === null ? null : this.ensureMaster(context);
  }

  setVolume(value: number): void {
    this.volume = clamp01(value);
    this.applyMasterGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
  }

  play(assetUrl: string, options: SfxPlayOptions = {}): SfxSoundHandle | null {
    const context = this.getAudioContext();
    if (context === null) return null;

    const buffer = this.buffers.get(assetUrl) ?? this.ensurePlaceholder(context);
    if (!this.buffers.has(assetUrl)) void this.loadAsset(context, assetUrl);

    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    gain.gain.setValueAtTime(clamp01(options.volume ?? 1), context.currentTime);
    source.connect(gain);
    gain.connect(this.ensureMaster(context));

    const startAt = context.currentTime + Math.max(0, options.delay ?? 0);
    try {
      source.start(startAt);
      if (!(options.loop ?? false)) {
        const duration =
          typeof buffer.duration === 'number' && Number.isFinite(buffer.duration)
            ? buffer.duration
            : 0;
        source.stop(startAt + duration + 0.02);
      }
    } catch {
      /* Dead context — degrade to a no-op rather than throw. */
    }

    return {
      stop: () => {
        try {
          source.stop(context.currentTime);
        } catch {
          /* Already stopped — safe no-op. */
        }
      },
    };
  }

  /**
   * Fetches and decodes an asset into the cache. Best-effort: any failure
   * (offline, unsupported codec, dead context) leaves the cue on its silent
   * placeholder rather than throwing.
   */
  async loadAsset(context: AudioContext, assetUrl: string): Promise<void> {
    if (this.buffers.has(assetUrl) || this.pending.has(assetUrl)) return;
    const decode = context.decodeAudioData;
    if (typeof decode !== 'function' || typeof fetch !== 'function') return;
    this.pending.add(assetUrl);
    try {
      const response = await fetch(assetUrl);
      if (!response.ok) return;
      const data = await response.arrayBuffer();
      const decoded = await new Promise<AudioBuffer>((resolve, reject) => {
        decode.call(context, data, resolve, reject);
      });
      if (this.context === context) this.buffers.set(assetUrl, decoded);
    } catch {
      /* Best-effort preload; the cue stays on its placeholder. */
    } finally {
      this.pending.delete(assetUrl);
    }
  }

  reset(): void {
    this.context = null;
    this.pinnedContext = null;
    this.master = null;
    this.placeholder = null;
    this.volume = 1;
    this.muted = false;
    this.buffers.clear();
    this.pending.clear();
  }

  private createContext(): AudioContext | null {
    try {
      const ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      return typeof ctor === 'function' ? new ctor() : null;
    } catch {
      return null;
    }
  }

  private ensureMaster(context: AudioContext): GainNode {
    if (this.master !== null) return this.master;
    const gain = context.createGain();
    gain.gain.setValueAtTime(this.muted ? 0 : this.volume, context.currentTime);
    gain.connect(context.destination);
    this.master = gain;
    return gain;
  }

  private applyMasterGain(): void {
    if (this.master === null) return;
    try {
      const context = this.master.context;
      this.master.gain.cancelScheduledValues(context.currentTime);
      this.master.gain.setValueAtTime(
        this.muted ? 0 : this.volume,
        context.currentTime,
      );
    } catch {
      /* Dead context — no-op. */
    }
  }

  private ensurePlaceholder(context: AudioContext): AudioBuffer {
    if (this.placeholder !== null) return this.placeholder;
    this.placeholder = context.createBuffer(1, 1, context.sampleRate);
    return this.placeholder;
  }
}

/** The process-wide default provider used by `effects.ts`. */
export const webAudioSfxProvider = new WebAudioSfxProvider();
