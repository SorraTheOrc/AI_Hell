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
  // Volume 0.3 (doubled from initial 0.15) so explosion feedback is
  // clearly audible over the action (feedback from Swarm audio playtest).
  blip(440, 60, 0.28, 'sawtooth', 0.3);
}

/**
 * A heavier, lower destruction cue — for Tank enemies.
 *
 * Intentionally UNWIRED (dead code): Tank destruction reuses the shared
 * `playDestructionSound()` owned by `GymFormationScene` so it plays
 * exactly once per destruction (see AH-0MTCNZAPS007WTQE / enemy design
 * doc §7). Do not wire this into the Tank explosion path — it would
 * double-play the destruction sound.
 */
export function playTankDestructionSound(): void {
  blip(220, 30, 0.45, 'sawtooth', 0.2);
}

/**
 * Duration (seconds) of the Tank advance-cue mechanical whine.
 *
 * The whine itself provides the ≥ 500 ms advance lead required by
 * GDD §7.3: the cue sounds for this long before the cannon thump lands,
 * and `playTankFireSound()` schedules its thump to start exactly at the
 * cue's end time so the two flow together with no gap.
 */
export const TANK_ADVANCE_CUE_DURATION = 0.6;

/**
 * Rising mechanical whine — E3 Tank firing advance cue (GDD §7.3).
 *
 * A grinding two-layer sawtooth/square whine (heavy, mechanical — like a
 * tank turret powering up) that rises over `TANK_ADVANCE_CUE_DURATION`
 * (≥ 500 ms) and flows directly into the cannon-thump fire sound.
 * Designed to be called immediately before `playTankFireSound()` in the
 * same tick: no dead gap between warning and shot (deliberate deviation
 * from the Scout two-phase tell). Safe no-op without an AudioContext.
 */
export function playTankAdvanceCue(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;
  const dur = TANK_ADVANCE_CUE_DURATION;

  // Whine layer: rising sawtooth (mechanical grind).
  const whine = ctx.createOscillator();
  const whineGain = ctx.createGain();
  whine.type = 'sawtooth';
  whine.frequency.setValueAtTime(150, t);
  whine.frequency.exponentialRampToValueAtTime(320, t + dur);
  whineGain.gain.setValueAtTime(0.12, t);
  whineGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  whine.connect(whineGain).connect(ctx.destination);
  whine.start(t);
  whine.stop(t + dur + 0.02);

  // Sub-octave square layer: adds the "heavy machinery" body.
  const sub = ctx.createOscillator();
  const subGain = ctx.createGain();
  sub.type = 'square';
  sub.frequency.setValueAtTime(75, t);
  sub.frequency.exponentialRampToValueAtTime(160, t + dur);
  subGain.gain.setValueAtTime(0.06, t);
  subGain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  sub.connect(subGain).connect(ctx.destination);
  sub.start(t);
  sub.stop(t + dur + 0.02);
}

/**
 * Heavy low cannon thump — E3 Tank fire sound (GDD §7.3).
 *
 * A deep sawtooth + sine body thumping down from ~90 Hz to ~25 Hz — the
 * "cannon" counterpart to the mechanical whine. Called exactly once per
 * radial burst (scene-level, not per projectile).
 *
 * The thump is scheduled at `currentTime + TANK_ADVANCE_CUE_DURATION`
 * (the cue's end time) so that, when called back-to-back with
 * `playTankAdvanceCue()` in the same tick, it lands exactly as the whine
 * ends — flowing into the shot with no dead gap. Safe no-op without an
 * AudioContext.
 */
export function playTankFireSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime + TANK_ADVANCE_CUE_DURATION;

  // Main thump: low sawtooth fall.
  const thump = ctx.createOscillator();
  const thumpGain = ctx.createGain();
  thump.type = 'sawtooth';
  thump.frequency.setValueAtTime(90, t);
  thump.frequency.exponentialRampToValueAtTime(28, t + 0.35);
  thumpGain.gain.setValueAtTime(0.35, t);
  thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  thump.connect(thumpGain).connect(ctx.destination);
  thump.start(t);
  thump.stop(t + 0.37);

  // Sub-sine body for weight.
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(55, t);
  body.frequency.exponentialRampToValueAtTime(24, t + 0.35);
  bodyGain.gain.setValueAtTime(0.25, t);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  body.connect(bodyGain).connect(ctx.destination);
  body.start(t);
  body.stop(t + 0.37);
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

// ── Scout enemy cues (GDD §4.1 — E1 Scout) ─────────────────────────

/**
 * Duration (seconds) of the Scout advance-cue rising blip.
 *
 * Mirrors `TANK_ADVANCE_CUE_DURATION` so `playScoutFireSound()` can
 * schedule its shot to start exactly at the cue's end time, flowing
 * back-to-back with no dead gap between warning and shot.
 */
export const SCOUT_ADVANCE_CUE_DURATION = 0.6;

/**
 * Rising warning blip — E1 Scout firing advance cue.
 *
 * A rising sine mirroring the Phaser tell but pitched higher to stay
 * distinct. Plays at the start of the per-entity tell, ≥ 500 ms before
 * the aimed shot (GDD §7.3); duration must stay ≤ SCOUT_FIRE_INTERVAL
 * in src/entities/Scout.ts (600 ms tell, 1200 ms fire interval).
 *
 * Called immediately before `playScoutFireSound()` in the same tick:
 * no dead gap between warning and shot (the fire sound is scheduled
 * to start at `currentTime + SCOUT_ADVANCE_CUE_DURATION`, i.e. exactly
 * as the cue ends). Safe no-op without an AudioContext.
 */
export function playScoutAdvanceCue(): void {
  blip(880, 1320, SCOUT_ADVANCE_CUE_DURATION, 'sine', 0.08);
}

/**
 * Sharp laser-like blip — E1 Scout fire sound (GDD §7.3).
 *
 * A short high square-wave sweep, distinct from the destruction burst
 * and the Swarm buzz, fired exactly once per aimed shot. The blip is
 * scheduled at `currentTime + SCOUT_ADVANCE_CUE_DURATION` (the cue's
 * end time) so that, when called back-to-back with `playScoutAdvanceCue()`
 * in the same tick, it lands exactly as the cue ends — flowing into the
 * shot with no dead gap. Safe no-op without an AudioContext.
 */
export function playScoutFireSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime + SCOUT_ADVANCE_CUE_DURATION;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'square';
  osc.frequency.setValueAtTime(1400, t);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(1, 700),
    t + 0.12,
  );

  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}
