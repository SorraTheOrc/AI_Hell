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

/** A heavier, lower destruction cue — for Tank enemies. */
export function playTankDestructionSound(): void {
  blip(220, 30, 0.45, 'sawtooth', 0.2);
}

// ── Power-up / weapon cues ─────────────────────────────────────────

/**
 * A bright ascending blip — power-up / weapon drop spawn cue.
 * Higher pitch than the enemy spawn to signal "collectible item".
 */
export function playPowerUpSpawnSound(): void {
  blip(440, 1760, 0.25, 'sine', 0.1);
}

/**
 * A quick descending blip — power-up despawn cue (drop fades away).
 * Same pitch contour as spawn but lower volume and shorter.
 */
export function playPowerUpDespawnSound(): void {
  blip(880, 220, 0.15, 'sine', 0.08);
}

/**
 * A cheerful chime — power-up collection cue.
 * Two-tone ascending pattern to signal "success".
 */
export function playPowerUpCollectSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // First tone: quick ascending blip.
  blip(523, 659, 0.1, 'sine', 0.12); // C5 → E5
  // Second tone: slightly after, higher.
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(784, ctx.currentTime + 0.08);
  osc2.frequency.exponentialRampToValueAtTime(1047, ctx.currentTime + 0.2);
  gain2.gain.setValueAtTime(0, ctx.currentTime + 0.08);
  gain2.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 0.1);
  gain2.gain.exponentialRampToValueAtTime(
    0.0001,
    ctx.currentTime + 0.2,
  );
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(ctx.currentTime + 0.08);
  osc2.stop(ctx.currentTime + 0.22);
}

/**
 * A distinctive whoosh — weapon change cue (weapon power-up collected,
 * replacing the current weapon).  Different from the collection chime
 * to signal "armed with new weapon".
 */
export function playWeaponChangeSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Rapid ascending arpeggio (three quick tones).
  const tones = [523, 659, 784]; // C5, E5, G5
  for (let i = 0; i < tones.length; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    const t = i * 0.06;
    osc.frequency.setValueAtTime(tones[i], ctx.currentTime + t);
    gain.gain.setValueAtTime(0, ctx.currentTime + t);
    gain.gain.linearRampToValueAtTime(0.1, ctx.currentTime + t + 0.01);
    gain.gain.exponentialRampToValueAtTime(
      0.0001,
      ctx.currentTime + t + 0.08,
    );
    osc.connect(gain).connect(ctx.destination);
    osc.start(ctx.currentTime + t);
    osc.stop(ctx.currentTime + t + 0.1);
  }
}

// ── Swarm enemy cues (GDD §4.1 — E5 Swarm) ─────────────────────────

/**
 * A buzzing / whoosh — Swarm coordinated-burst volley sound.
 * A rapid low-frequency pulse layered with a sweeping whoosh to evoke
 * a swarm of insects charging forward.
 */
export function playSwarmBurstSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Low buzzing pulse (simulates insect swarm).
  const buzz = ctx.createOscillator();
  const buzzGain = ctx.createGain();
  buzz.type = 'sawtooth';
  buzz.frequency.setValueAtTime(120, ctx.currentTime);
  buzz.frequency.linearRampToValueAtTime(80, ctx.currentTime + 0.15);
  buzzGain.gain.setValueAtTime(0.1, ctx.currentTime);
  buzzGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
  buzz.connect(buzzGain).connect(ctx.destination);
  buzz.start(ctx.currentTime);
  buzz.stop(ctx.currentTime + 0.22);

  // Sweeping whoosh on top.
  const whoosh = ctx.createOscillator();
  const whooshGain = ctx.createGain();
  whoosh.type = 'sine';
  whoosh.frequency.setValueAtTime(200, ctx.currentTime);
  whoosh.frequency.exponentialRampToValueAtTime(
    600,
    ctx.currentTime + 0.15,
  );
  whooshGain.gain.setValueAtTime(0.06, ctx.currentTime);
  whooshGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
  whoosh.connect(whooshGain).connect(ctx.destination);
  whoosh.start(ctx.currentTime);
  whoosh.stop(ctx.currentTime + 0.2);
}

/**
 * A rising chirp — Swarm firing advance cue (≥ 500 ms before the burst).
 * Two quick ascending tones that signal "swarm about to fire".
 */
export function playSwarmAdvanceCue(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // First chirp: quick ascending tone.
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'square';
  osc1.frequency.setValueAtTime(440, ctx.currentTime);
  osc1.frequency.exponentialRampToValueAtTime(
    880,
    ctx.currentTime + 0.12,
  );
  gain1.gain.setValueAtTime(0.06, ctx.currentTime);
  gain1.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.15);
  osc1.connect(gain1).connect(ctx.destination);
  osc1.start(ctx.currentTime);
  osc1.stop(ctx.currentTime + 0.17);

  // Second chirp: slightly after, higher.
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'square';
  osc2.frequency.setValueAtTime(550, ctx.currentTime + 0.1);
  osc2.frequency.exponentialRampToValueAtTime(
    1100,
    ctx.currentTime + 0.22,
  );
  gain2.gain.setValueAtTime(0, ctx.currentTime + 0.1);
  gain2.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 0.12);
  gain2.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(ctx.currentTime + 0.1);
  osc2.stop(ctx.currentTime + 0.27);
}
