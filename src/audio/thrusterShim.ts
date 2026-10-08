/**
 * Thruster-hum runtime shim (AH-0MUTYV92Y000WJ8Z, parent AH-0MUTUOB7X007PR9J).
 *
 * The thruster hum is the game's **single runtime-synthesised exception**: it
 * is continuous and thrust-coupled, so a baked one-shot WAV cannot reproduce
 * it (the baked-multi-variant and Tone.js routes were evaluated on the parent
 * epic; the shim route was chosen). It is isolated here so
 * `src/audio/effects.ts` contains no procedural synthesis — every other cue is
 * a baked ToneForge asset.
 *
 * The hum is driven once per frame from `Player.preUpdate` via
 * `updateThrusterSound(level)` where `level` is the `getEngineSoundLevel`
 * value in [0, 1]. It reuses one gain node and never exceeds
 * {@link THRUSTER_HUM_MAX_VOLUME}. In an environment without an
 * `AudioContext` every entry point is a safe no-op.
 *
 * Context and master-gain access are injected by `effects.ts` so the shim
 * routes through the same shared context/master gain as the baked cues and
 * never constructs a context of its own.
 *
 * ## Dependency choice (AH-0MUTYV9ES003A3HJ)
 *
 * The plan originally specified a Tone.js shim. It is implemented directly on
 * the shared Web Audio API instead: Tone.js was evaluated but **not adopted**,
 * because it would add a new browser runtime dependency for no functional
 * gain, and the runtime-generation evaluation
 * (`docs/AUDIO_RUNTIME_GENERATION_EVALUATION.md`) recommends keeping this
 * lightweight shim. Every functional requirement — continuous gain tracking
 * bounded by {@link THRUSTER_HUM_MAX_VOLUME}, click-free retrigger with the
 * documented growth/decay timing, a safe no-op without audio, and no retained
 * nodes after stop — is met by this implementation.
 */

/** Maximum thruster hum gain (≤ 0.2 per GDD §7.3 "all player cues"). */
export const THRUSTER_HUM_MAX_VOLUME = 0.075;
/** Base thruster hum frequency — soft triangle hum (GDD §7.3 continuous hum). */
export const THRUSTER_HUM_BASE_FREQ = 60;
/** Undertone frequency (sine) — adds body to the low jet rumble. */
export const THRUSTER_HUM_UNDERTONE_FREQ = 35;
/** Noise filter centre range for jet texture (band-pass). */
export const THRUSTER_HUM_NOISE_FILTER_MIN = 700;
export const THRUSTER_HUM_NOISE_FILTER_MAX = 1100;
/** Gain ramp time at reference thrust: mirrors the flame growth time. */
export const THRUSTER_HUM_GROWTH_TIME = 0.03;
/** Decay is ~4× growth (quick silence on release). */
export const THRUSTER_HUM_SHRINK_MULTIPLIER = 4;
/** Maximum detune drift range in cents for organic tonal variation. */
const THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS = 8;
/** Per-frame detune drift step size in cents (random walk). */
const THRUSTER_HUM_DETUNE_DRIFT_STEP_CENTS = 2;

/** Audio resources the shim borrows from the shared playback layer. */
export interface ThrusterShimDeps {
  /** The shared context, or null when audio is unavailable. */
  getContext(): AudioContext | null;
  /** The shared master SFX gain for `context`, or null. */
  getMasterGain(context: AudioContext): GainNode | null;
}

const NO_CONTEXT: ThrusterShimDeps = {
  getContext: () => null,
  getMasterGain: () => null,
};

let deps: ThrusterShimDeps = NO_CONTEXT;

/** Injects the shared context/master-gain accessors (called by effects.ts). */
export function configureThrusterShim(next: ThrusterShimDeps): void {
  deps = next;
}

/** Live thruster hum nodes (one shared voice). */
export interface ThrusterHumState {
  ctx: AudioContext;
  osc: OscillatorNode;
  sub: OscillatorNode;
  /** White-noise source for the jet-engine whoosh character. */
  noise: AudioBufferSourceNode;
  /** Band-pass filter shaping the noise into a jet-like roar. */
  noiseFilter: BiquadFilterNode;
  gain: GainNode;
  /** Current gain — tracks the visual flame model. */
  currentGain: number;
  /** Subtle detune drift in cents — slow random-walk variation. */
  detuneOsc: number;
  detuneSub: number;
}

let thrusterHum: ThrusterHumState | null = null;

/** Clamps a level to [0, 1]. */
function clampLevel(level: number): number {
  if (level <= 0 || !Number.isFinite(level)) return 0;
  if (level >= 1) return 1;
  return level;
}

/** For tests: the current thruster hum state (or null when not started). */
export function _getThrusterHumStateForTests(): ThrusterHumState | null {
  return thrusterHum;
}

function teardownThrusterHum(ctxTime: number, stopOffset: number): void {
  if (thrusterHum === null) return;
  try {
    thrusterHum.gain.gain.cancelScheduledValues(ctxTime);
    thrusterHum.gain.gain.setValueAtTime(0, ctxTime);
    thrusterHum.osc.stop(ctxTime + stopOffset);
    thrusterHum.sub.stop(ctxTime + stopOffset);
    thrusterHum.noise.stop(ctxTime + stopOffset);
  } catch {
    /* Already stopped / dead context. */
  }
  thrusterHum = null;
}

/** Stops any active hum and clears module state. */
export function resetThrusterHumForTests(): void {
  if (thrusterHum !== null) {
    teardownThrusterHum(thrusterHum.ctx.currentTime, 0);
  }
  thrusterHum = null;
}

/** Backwards-compatible test-seam alias (kept for existing callers). */
export { resetThrusterHumForTests as _resetThrusterHumForTests };

function ensureThrusterHum(ctx: AudioContext): ThrusterHumState | null {
  if (thrusterHum !== null && thrusterHum.ctx === ctx) return thrusterHum;
  if (thrusterHum !== null) resetThrusterHumForTests();

  const master = deps.getMasterGain(ctx);
  if (master === null) return null;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.connect(master);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(THRUSTER_HUM_BASE_FREQ, ctx.currentTime);
  osc.connect(gain);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(THRUSTER_HUM_UNDERTONE_FREQ, ctx.currentTime);
  sub.connect(gain);

  // White noise → band-pass filter → gain: the jet-engine "whoosh".
  const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const noiseData = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) {
    noiseData[i] = Math.random() * 2 - 1;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;

  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  const initCutoff =
    THRUSTER_HUM_NOISE_FILTER_MIN +
    Math.random() * (THRUSTER_HUM_NOISE_FILTER_MAX - THRUSTER_HUM_NOISE_FILTER_MIN);
  noiseFilter.frequency.setValueAtTime(initCutoff, ctx.currentTime);
  noiseFilter.Q.setValueAtTime(0.6 + Math.random() * 0.5, ctx.currentTime);

  noise.connect(noiseFilter);
  noiseFilter.connect(gain);
  noise.start(ctx.currentTime);

  osc.start(ctx.currentTime);
  sub.start(ctx.currentTime);

  const initDetuneOsc =
    (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS;
  const initDetuneSub =
    (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS;
  osc.detune.setValueAtTime(initDetuneOsc, ctx.currentTime);
  sub.detune.setValueAtTime(initDetuneSub, ctx.currentTime);

  thrusterHum = {
    ctx,
    osc,
    sub,
    noise,
    noiseFilter,
    gain,
    currentGain: 0,
    detuneOsc: initDetuneOsc,
    detuneSub: initDetuneSub,
  };
  return thrusterHum;
}

/**
 * Sustained thruster hum — the continuous player SFX (GDD §7.3).
 *
 * `level` in [0, 1] comes from `MovementModel.getEngineSoundLevel`; the gain
 * target is `level * THRUSTER_HUM_MAX_VOLUME` (≤ 0.075). Call once per frame
 * from `Player.preUpdate`; 0 silences the hum, > 0 reuses the same nodes and
 * ramps the gain. Safe no-op without an `AudioContext` (never throws).
 */
export function updateThrusterHum(level: number): void {
  const clamped = clampLevel(level);
  const targetGain = clamped * THRUSTER_HUM_MAX_VOLUME;

  const ctx = deps.getContext();
  if (ctx === null) return;

  if (clamped === 0) {
    if (thrusterHum === null) return;
    const decayTime = THRUSTER_HUM_GROWTH_TIME / THRUSTER_HUM_SHRINK_MULTIPLIER;
    const t = ctx.currentTime;
    thrusterHum.gain.gain.cancelScheduledValues(t);
    thrusterHum.gain.gain.setValueAtTime(thrusterHum.currentGain, t);
    thrusterHum.gain.gain.linearRampToValueAtTime(0, t + decayTime);
    thrusterHum.currentGain = 0;
    return;
  }

  const hum = ensureThrusterHum(ctx);
  if (hum === null) return;

  const pitchScale = 1 + clamped * 0.12;
  hum.sub.frequency.setValueAtTime(
    THRUSTER_HUM_UNDERTONE_FREQ * pitchScale,
    ctx.currentTime,
  );
  hum.osc.frequency.setValueAtTime(
    THRUSTER_HUM_BASE_FREQ * pitchScale,
    ctx.currentTime,
  );
  try {
    const driftOsc = Math.max(
      -THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
      Math.min(
        THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
        hum.detuneOsc + (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_STEP_CENTS,
      ),
    );
    const driftSub = Math.max(
      -THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
      Math.min(
        THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
        hum.detuneSub + (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_STEP_CENTS,
      ),
    );
    hum.osc.detune.setValueAtTime(driftOsc, ctx.currentTime);
    hum.sub.detune.setValueAtTime(driftSub, ctx.currentTime);
    hum.detuneOsc = driftOsc;
    hum.detuneSub = driftSub;
  } catch {
    /* detune not supported */
  }
  try {
    const cutoff =
      THRUSTER_HUM_NOISE_FILTER_MIN +
      Math.random() * (THRUSTER_HUM_NOISE_FILTER_MAX - THRUSTER_HUM_NOISE_FILTER_MIN);
    hum.noiseFilter.frequency.setValueAtTime(cutoff, ctx.currentTime);
  } catch {
    /* filter params not supported */
  }

  const t = ctx.currentTime;
  const delta = Math.abs(targetGain - hum.currentGain);
  const ramp = THRUSTER_HUM_GROWTH_TIME * (delta / THRUSTER_HUM_MAX_VOLUME);
  hum.gain.gain.cancelScheduledValues(t);
  hum.gain.gain.setValueAtTime(hum.currentGain, t);
  hum.gain.gain.linearRampToValueAtTime(targetGain, t + Math.max(0.005, ramp));
  hum.currentGain = targetGain;
}

/**
 * Forces the thruster hum to stop and frees its nodes. Called on release,
 * respawn, player destroy and scene shutdown so no nodes leak.
 */
export function stopThrusterHum(): void {
  if (thrusterHum === null) return;
  teardownThrusterHum(thrusterHum.ctx.currentTime, 0.02);
}
