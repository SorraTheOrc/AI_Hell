/**
 * Reusable headless Web Audio test doubles (AH-0MUTYV8RJ009MWKJ,
 * AH-0MV55O991003XOT8).
 *
 * A recording `AudioContext` implementation and a recording
 * `SfxSoundProvider` used by the audio suites. They record the nodes, gain
 * automation events and cue dispatch decisions (asset URL, delay, volume,
 * loop) that the production cue code requests, so tests can assert the
 * playback contract without any real audio hardware.
 *
 * `RecordingAudioContext` is shared by the master volume/mute checks and the
 * cue-contract suite (`src/audio/effects.contract.test.ts`).
 * `RecordingSfxProvider` is the cue-layer seam consumed by
 * `src/audio/effects.test.ts` and the hold-full overlay suites.
 */

import type {
  SfxPlayOptions,
  SfxSoundHandle,
  SfxSoundProvider,
} from '../audio/sfxPlayback';

/** A single scheduled `AudioParam` automation event. */
export interface RecordedGainEvent {
  method:
    | 'setValueAtTime'
    | 'linearRampToValueAtTime'
    | 'exponentialRampToValueAtTime'
    | 'cancelScheduledValues';
  value: number;
  time: number;
}

/** A recorded gain node: its automation events, returned node and targets. */
export interface RecordedGain {
  gainEvents: RecordedGainEvent[];
  node?: unknown;
  connectTargets: unknown[];
}

/** A single scheduled `AudioParam` automation event on a filter parameter. */
export interface RecordedParamEvent {
  method:
    | 'setValueAtTime'
    | 'exponentialRampToValueAtTime'
    | 'linearRampToValueAtTime'
    | 'cancelScheduledValues';
  value: number;
  time: number;
}

/** A recorded biquad filter: its frequency/Q automation events. */
export interface RecordedFilter {
  type: string;
  frequencyEvents: RecordedParamEvent[];
  qEvents: RecordedParamEvent[];
}

/** A recorded oscillator / buffer source with its scheduled start/stop times. */
export interface RecordedSource {
  kind: 'oscillator' | 'bufferSource';
  type: string;
  starts: number[];
  stops: number[];
}

/**
 * Minimal recording `AudioContext` covering the surface used by
 * `src/audio/effects.ts`: oscillator, gain, buffer, buffer-source and
 * biquad-filter nodes, plus `currentTime`, `sampleRate` and `destination`.
 */
export class RecordingAudioContext {
  static instances: RecordingAudioContext[] = [];

  currentTime = 0;
  sampleRate = 44100;
  destination: unknown = {};

  oscillators: RecordedSource[] = [];
  gains: RecordedGain[] = [];
  /** Every biquad filter created, in creation order (frequency/Q events recorded). */
  filters: RecordedFilter[] = [];
  /** Every target passed to `connect()` on this context's nodes. */
  connections: unknown[] = [];

  constructor() {
    RecordingAudioContext.instances.push(this);
  }

  private recordSource(kind: RecordedSource['kind'], type: string): RecordedSource {
    const rec: RecordedSource = { kind, type, starts: [], stops: [] };
    this.oscillators.push(rec);
    return rec;
  }

  createOscillator(): unknown {
    const rec = this.recordSource('oscillator', 'sine');
    const self = this;
    return {
      get type(): string {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: {
        setValueAtTime: (_value: number, _time: number) => {},
        exponentialRampToValueAtTime: (_value: number, _time: number) => {},
        linearRampToValueAtTime: (_value: number, _time: number) => {},
      },
      detune: { setValueAtTime: () => {} },
      connect: (target: unknown) => {
        self.connections.push(target);
        return {
          connect: (next: unknown) => {
            self.connections.push(next);
            return {};
          },
        };
      },
      start: (t: number) => {
        rec.starts.push(t);
      },
      stop: (t: number) => {
        rec.stops.push(t);
      },
    };
  }

  createGain(): unknown {
    const rec: RecordedGain = { gainEvents: [], connectTargets: [] };
    const self = this;
    this.gains.push(rec);
    const node = {
      context: self,
      gain: {
        setValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'setValueAtTime', value, time });
        },
        linearRampToValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'linearRampToValueAtTime', value, time });
        },
        exponentialRampToValueAtTime: (value: number, time: number) => {
          rec.gainEvents.push({ method: 'exponentialRampToValueAtTime', value, time });
        },
        cancelScheduledValues: (time: number) => {
          rec.gainEvents.push({ method: 'cancelScheduledValues', value: -1, time });
        },
      },
      connect: (target: unknown) => {
        rec.connectTargets.push(target);
        self.connections.push(target);
        return {};
      },
    };
    rec.node = node;
    return node;
  }

  createBuffer(_channels: number, length: number, _sampleRate: number): unknown {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return { getChannelData: () => data };
  }

  createBufferSource(): unknown {
    const rec = this.recordSource('bufferSource', 'noise');
    const self = this;
    return {
      buffer: null as unknown,
      loop: false,
      connect: (target: unknown) => {
        self.connections.push(target);
        return {
          connect: (next: unknown) => {
            self.connections.push(next);
            return {};
          },
        };
      },
      start: (t: number) => {
        rec.starts.push(t);
      },
      stop: (t: number) => {
        rec.stops.push(t);
      },
    };
  }

  createBiquadFilter(): unknown {
    const rec: RecordedFilter = {
      type: 'lowpass',
      frequencyEvents: [],
      qEvents: [],
    };
    const self = this;
    this.filters.push(rec);
    const frequency: RecordedParamEvent[] = rec.frequencyEvents;
    const qEvents: RecordedParamEvent[] = rec.qEvents;
    const push = (list: RecordedParamEvent[]) =>
      (method: RecordedParamEvent['method']) =>
      (value: number, time: number) => {
        list.push({ method, value, time });
      };
    const freqPush = push(frequency);
    const qPush = push(qEvents);
    return {
      get type(): string {
        return rec.type;
      },
      set type(v: string) {
        rec.type = v;
      },
      frequency: {
        setValueAtTime: freqPush('setValueAtTime'),
        exponentialRampToValueAtTime: freqPush('exponentialRampToValueAtTime'),
        linearRampToValueAtTime: freqPush('linearRampToValueAtTime'),
        cancelScheduledValues: freqPush('cancelScheduledValues'),
      },
      Q: {
        setValueAtTime: qPush('setValueAtTime'),
        exponentialRampToValueAtTime: qPush('exponentialRampToValueAtTime'),
        linearRampToValueAtTime: qPush('linearRampToValueAtTime'),
        cancelScheduledValues: qPush('cancelScheduledValues'),
      },
      connect: (target: unknown) => {
        self.connections.push(target);
        return {};
      },
    };
  }
}

/** The most recent recording context, or `undefined` when none was created. */
export function latestRecordingContext(): RecordingAudioContext | undefined {
  return RecordingAudioContext.instances[RecordingAudioContext.instances.length - 1];
}

/** The most recently created gain node (the master SFX gain is created first). */
export function latestGain(): RecordedGain | undefined {
  const ctx = latestRecordingContext();
  return ctx?.gains[ctx.gains.length - 1];
}

/** The master SFX gain of the first context (the first gain created there). */
export function masterGain(): RecordedGain | undefined {
  return RecordingAudioContext.instances[0]?.gains[0];
}

/** The most recent non-automation gain value scheduled on *gain*. */
export function lastGainValue(gain: RecordedGain): number | undefined {
  for (const ev of [...gain.gainEvents].reverse()) {
    if (ev.method === 'setValueAtTime' || ev.method === 'linearRampToValueAtTime') {
      return ev.value;
    }
  }
  return undefined;
}

/** The most recent non-automation frequency scheduled on *filter*. */
export function lastFilterFrequency(filter: RecordedFilter): number | undefined {
  for (const ev of [...filter.frequencyEvents].reverse()) {
    if (ev.method === 'setValueAtTime' || ev.method === 'linearRampToValueAtTime') {
      return ev.value;
    }
  }
  return undefined;
}

/** Clears recorded instances/events without touching the module cache. */
export function resetRecordingAudioContext(): void {
  RecordingAudioContext.instances.length = 0;
}

// ── Recording SFX provider ──────────────────────────────────────────

/** A single `play()` call recorded by {@link RecordingSfxProvider}. */
export interface RecordedSfxPlay {
  /** Baked asset URL passed to `play()` (e.g. `audio/sfx/card-token-earn.1.wav`). */
  url: string;
  /** Scheduled start delay in seconds, normalised from `options.delay` (default 0). */
  delay: number;
  /** Per-play gain in [0, 1], normalised from `options.volume` (default 1). */
  volume: number;
  /** Whether the play loops, normalised from `options.loop` (default false). */
  loop: boolean;
}

/**
 * In-memory {@link SfxSoundProvider} that records every cue dispatch instead
 * of touching Web Audio. Inject it with
 * `setSfxSoundProvider(new RecordingSfxProvider())` to assert the cue layer's
 * decisions — resolved asset URL, per-play delay/volume/loop — and the master
 * volume/mute/stop lifecycle.
 *
 * It is a faithful no-op substitute (no real audio, no `AudioContext`), so it
 * is safe in headless environments and deterministic across runs.
 */
export class RecordingSfxProvider implements SfxSoundProvider {
  /** Every recorded `play()` call, in dispatch order. */
  readonly plays: RecordedSfxPlay[] = [];
  /** Every value passed to `setVolume()`, in call order. */
  readonly volumes: number[] = [];
  /** Every value passed to `setMuted()`, in call order. */
  readonly mutes: boolean[] = [];
  /** How many returned handles have been stopped. */
  stops = 0;

  private context: AudioContext | null = null;

  getAudioContext(): AudioContext | null {
    return this.context;
  }

  useAudioContext(context: AudioContext | null): void {
    this.context = context;
  }

  play(url: string, options: SfxPlayOptions = {}): SfxSoundHandle {
    this.plays.push({
      url,
      delay: options.delay ?? 0,
      volume: options.volume ?? 1,
      loop: options.loop ?? false,
    });
    return {
      stop: () => {
        this.stops += 1;
      },
    };
  }

  setVolume(value: number): void {
    this.volumes.push(value);
  }

  setMuted(muted: boolean): void {
    this.mutes.push(muted);
  }

  reset(): void {
    this.plays.length = 0;
    this.volumes.length = 0;
    this.mutes.length = 0;
    this.stops = 0;
    this.context = null;
  }
}
