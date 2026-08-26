/**
 * Procedural audio effects for enemy gym scenes (GDD §7.3).
 *
 * Sounds are synthesised at runtime with the Web Audio API — no audio
 * assets to ship. Each enemy kind maps to distinct tones: spawn uses a
 * high rising blip, destruction a quick descending noise burst.
 *
 * In environments without a working AudioContext (headless tests, some
 * browsers) every function degrades to a safe no-op: the game never
 * depends on audio being available.
 */


let audioCtx: AudioContext | null = null;

/** Lazily creates the shared AudioContext, or returns null if unavailable. */
function getAudioContext(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

/** Plays a single oscillator blip with a gain envelope. */
function blip(
  freqStart: number,
  freqEnd: number,
  duration: number,
  type: OscillatorType,
  volume: number,
): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freqStart, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(1, freqEnd),
    ctx.currentTime + duration,
  );

  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);

  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration + 0.02);
}

/** A short rising square-wave blip — enemy spawn cue. */
export function playSpawnSound(): void {
  blip(220, 880, 0.18, 'square', 0.12);
}

/** A quick descending saw-wave burst — enemy destruction cue. */
export function playDestructionSound(): void {
  blip(440, 60, 0.28, 'sawtooth', 0.15);
}