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

// ── Diver enemy cues (GDD §4.1 — E2 Diver) ─────────────────────────

/**
 * Short low/nasal crack — E2 Diver fire sound (GDD §7.3).
 *
 * A quick sawtooth burst that dips from ~280 Hz to ~120 Hz over 80 ms
 * — evokes a mechanical "crack" appropriate to a diver breaking formation
 * and firing. Played exactly once per spread burst (not per projectile).
 * Distinct from the Scout blip, the Swarm buzz, and the Tank thump.
 * Safe no-op without an AudioContext.
 */
export function playDiverFireSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(280, ctx.currentTime);
  osc.frequency.linearRampToValueAtTime(120, ctx.currentTime + 0.08);
  gain.gain.setValueAtTime(0.15, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.08);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.1);
}

/**
 * Distinct Diver destruction sound — deeper, more resonant than the
 * shared destruction burst.
 *
 * A slower, lower sawtooth fall (280 → 40 Hz over 0.35 s) with a
 * sine undertone, giving the diver's explosion a heavier, more
 * resonant quality than the generic enemy destruction. Played exactly
 * once per diver destruction via the optional `playDestructionAudio?()`
 * seam; the Diver entity must NOT call `playDestructionSound()` in
 * `playExplosion()` to avoid double-play (design doc §7). Safe no-op
 * without an AudioContext.
 */
export function playDiverDestructionSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  // Main descent: deeper than the shared burst (440→60).
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(280, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.35);
  gain.gain.setValueAtTime(0.25, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + 0.37);

  // Sine undertone for weight.
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(80, ctx.currentTime);
  body.frequency.exponentialRampToValueAtTime(25, ctx.currentTime + 0.35);
  bodyGain.gain.setValueAtTime(0.15, ctx.currentTime);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
  body.connect(bodyGain).connect(ctx.destination);
  body.start(ctx.currentTime);
  body.stop(ctx.currentTime + 0.37);
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

// ── Player weapon shoot cues (GDD §2.3, §7.3) ─────────────────────

/**
 * Solid medium blip — player Cannon fire sound (GDD §2.3, §7.3).
 *
 * A short square-wave sweep (800 → 400 Hz, ~80 ms) — the "default"
 * gun feel: punchy but not harsh, instantly readable as the baseline
 * weapon. Distinct from the Scout laser (1400 → 700 Hz square), the
 * Tank thump (90 → 28 Hz sawtooth), and the Swarm buzz. Safe no-op
 * without an AudioContext.
 */
export function playCannonFireSound(): void {
  blip(800, 400, 0.08, 'square', 0.15);
}

/**
 * Wide multi-tone sweep — player Spread fire sound (GDD §2.3, §7.3).
 *
 * A triangle-wave fan that sweeps up and down (600 → 1200 → 800 Hz,
 * ~120 ms) — wider and rounder than the cannon blip, evoking three
 * bullets fanning out. Distinct wave type (triangle) and longer
 * duration than the cannon/square. Safe no-op without an AudioContext.
 */
export function playSpreadFireSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(600, t);
  osc.frequency.exponentialRampToValueAtTime(1200, t + 0.06);
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.12);
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}

/**
 * Sharp crack — player Dual fire sound (GDD §2.3, §7.3).
 *
 * A quick sawtooth burst (900 → 300 Hz, ~60 ms) with a layered sine
 * tick on top — a crisp double-punch crack evoking two side-by-side
 * bullets. Shortest and sharpest of the four shoot cues, so the rapid
 * fire-rate of the dual weapon stays legible. Safe no-op without an
 * AudioContext.
 */
export function playDualFireSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;

  // Main crack: fast sawtooth fall.
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(900, t);
  osc.frequency.exponentialRampToValueAtTime(300, t + 0.06);
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.08);

  // Second tick: short sine blip offset 20 ms — the "second barrel".
  const tick = ctx.createOscillator();
  const tickGain = ctx.createGain();
  tick.type = 'sine';
  tick.frequency.setValueAtTime(1200, t + 0.02);
  tick.frequency.exponentialRampToValueAtTime(800, t + 0.06);
  tickGain.gain.setValueAtTime(0, t + 0.02);
  tickGain.gain.linearRampToValueAtTime(0.1, t + 0.025);
  tickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
  tick.connect(tickGain).connect(ctx.destination);
  tick.start(t + 0.02);
  tick.stop(t + 0.08);
}

/**
 * Tight staccato blip — player Rapid fire sound (GDD §2.3, §7.3).
 *
 * A very short triangle blip (500 → 900 Hz, ~50 ms) — soft and
 * percussive, tuned for the rapid weapon's 125 ms fire rate so
 * consecutive shots read as a staccato rattle rather than mush.
 * Lowest volume of the four (0.12) to avoid overpowering the
 * fast cadence. Safe no-op without an AudioContext.
 */
export function playRapidFireSound(): void {
  blip(500, 900, 0.05, 'triangle', 0.12);
}

// ── Player weapon pickup activation cues (GDD §4.4, §7.3) ──────────

/**
 * Widening fan sweep — Spread weapon pickup activation sound.
 *
 * A triangle-wave fan that climbs then broadens (500 → 1500 → 800 Hz,
 * ~0.15 s) — distinct from the generic collection chime and weapon
 * change arpeggio, signalling "fan of bullets armed". Safe no-op
 * without an AudioContext.
 */
export function playSpreadPickupSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(500, t);
  osc.frequency.exponentialRampToValueAtTime(1500, t + 0.08);
  osc.frequency.exponentialRampToValueAtTime(800, t + 0.15);
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.17);
}

/**
 * Crisp two-note crack — Dual weapon pickup activation sound.
 *
 * A tight sawtooth drop (1000 → 500 Hz) followed 60 ms later by a
 * second, slightly higher drop (1200 → 700 Hz) — the audio twin of the
 * dual side-by-side barrels. Distinct from every other cue. Safe no-op
 * without an AudioContext.
 */
export function playDualPickupSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;

  const notes: Array<{ delay: number; from: number; to: number }> = [
    { delay: 0, from: 1000, to: 500 },
    { delay: 0.06, from: 1200, to: 700 },
  ];
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(note.from, t + note.delay);
    osc.frequency.exponentialRampToValueAtTime(note.to, t + note.delay + 0.08);
    gain.gain.setValueAtTime(0, t + note.delay);
    gain.gain.linearRampToValueAtTime(0.14, t + note.delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + note.delay + 0.08);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + note.delay);
    osc.stop(t + note.delay + 0.1);
  }
}

/**
 * Accelerating rise — Rapid weapon pickup activation sound.
 *
 * A fast triangle climb (400 → 1600 Hz over 0.1 s) that gets brighter
 * as it goes — evoking the rapid weapon's escalating fire rate.
 * Short and energetic, distinct from all other cues. Safe no-op
 * without an AudioContext.
 */
export function playRapidPickupSound(): void {
  blip(400, 1600, 0.1, 'triangle', 0.14);
}

/**
 * Gentle unwind to baseline — Reset (back to Cannon) activation sound.
 *
 * A soft sine fall (900 → 300 Hz, ~0.2 s) — calmer than the weapon
 * pickups, signalling a return to the default cannon. Distinct from
 * the generic collection chime and weapon-change arpeggio. Safe no-op
 * without an AudioContext.
 */
export function playResetPickupSound(): void {
  blip(900, 300, 0.2, 'sine', 0.12);
}

// ── Non-combat pickup activation cues (GDD §4.4, §7.3) ─────────────

/**
 * Quick ascending zip — P5 Speed Boost activation sound.
 *
 * A rapid square climb (600 → 1800 Hz, ~0.1 s) with a bright edge,
 * evoking the ship lurching forward faster. Distinct from weapon
 * pickups and the collection chime. Safe no-op without an
 * AudioContext.
 */
export function playSpeedBoostCollectSound(): void {
  blip(600, 1800, 0.1, 'square', 0.13);
}

/**
 * Warm two-note chime — P8 Extra Life activation sound.
 *
 * A slow, comforting sine pair (440 → 880 Hz then 660 → 990 Hz) —
 * warmer and more melodic than any other cue, signalling a life
 * gained. Distinct from the generic collection chime. Safe no-op
 * without an AudioContext.
 */
export function playExtraLifeCollectSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;

  const notes: Array<{ delay: number; from: number; to: number }> = [
    { delay: 0, from: 440, to: 880 },
    { delay: 0.12, from: 660, to: 990 },
  ];
  for (const note of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(note.from, t + note.delay);
    osc.frequency.exponentialRampToValueAtTime(note.to, t + note.delay + 0.18);
    gain.gain.setValueAtTime(0, t + note.delay);
    gain.gain.linearRampToValueAtTime(0.13, t + note.delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + note.delay + 0.18);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t + note.delay);
    osc.stop(t + note.delay + 0.2);
  }
}

/**
 * Magnetic pulse-hum — P9 Magnet activation sound.
 *
 * A low square pulse oscillating 180 → 90 → 180 Hz with a sine
 * undertone — a subtle "power field" hum evoking the attraction
 * effect. Deeper than the other non-combat cues, distinct from all
 * weapon pickups. Safe no-op without an AudioContext.
 */
export function playMagnetCollectSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const t = ctx.currentTime;

  // Low pulsing square: the "field" layer.
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.12);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.24);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.26);

  // Soft sine undertone for body.
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.type = 'sine';
  body.frequency.setValueAtTime(80, t);
  body.frequency.exponentialRampToValueAtTime(50, t + 0.24);
  bodyGain.gain.setValueAtTime(0.08, t);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  body.connect(bodyGain).connect(ctx.destination);
  body.start(t);
  body.stop(t + 0.26);
}
