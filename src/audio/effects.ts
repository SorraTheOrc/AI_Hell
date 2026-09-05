
// <!-- REFACTOR-AH-0MTP19JIB004ORC0
// smell: duplicate_code
// severity: medium
// description: Thruster teardown sequence duplicated across _resetThrusterHumForTests/stopThrusterSound/_resetAudioContextForTests (AH-0MTP19JIB004ORC0).
// -->

// <!-- REFACTOR-AH-0MTP19DG100472CV
// smell: unused_export
// severity: low
// description: THRUSTER_HUM_DETUNE_SPREAD_CENTS exported but never imported anywhere; dead compat constant (AH-0MTP19DG100472CV).
// -->
/**
 * Procedural audio effects for enemy gym scenes and the player ship (GDD §7.3).
 *
 * Sounds are synthesised at runtime with the Web Audio API — no audio
 * assets to ship. Each enemy kind maps to distinct tones: spawn uses a
 * high rising blip, destruction a quick descending noise burst. The
 * player ship's thruster hum is a continuous jet-engine roar:
 * soft triangle + sine oscillators (low rumble) + band-pass
 * filtered white noise (whoosh) through one reused gain node
 * section below).
 *
 * Thruster-scaling rationale: the hum gain tracks
 * `MovementModel.getEngineSoundLevel(state, input, thrustAcceleration)`
 * (level in [0, 1] = min(1, thrustAcceleration / FLAME_REF_THRUST),
 * GDD §2.2 `ShipConfig`), so the tuning slider stays audible and
 * halved/doubled thrust halves/caps the hum — the same thrust value
 * that drives the flame animation drives audio.
 *
 * In environments without a working AudioContext (headless tests, some
 * browsers, autoplay-blocked) every function degrades to a safe no-op:
 * the game never depends on audio being available — `updateThrusterSound`
 * simply does nothing and never throws.
 */


// ── Thruster hum (player SFX, AH-0MTFOSOHN001Q620, GDD §7.3) ───────
//
// Single ship-level continuous hum — NOT per-engine flame port (see
// docs/Game Design Document.md §7.3 Player Audio Character). Driven
// once per frame from Player.preUpdate via the level returned by
// getEngineSoundLevel(state, input, thrustAcceleration) so audio stays
// in lockstep with the tuning slider and both control schemes. Gain
// never exceeds THRUSTER_HUM_MAX_VOLUME (0.15) and the smoothed envelope
// mirrors the flame growth/shrink timing (30 ms growth, ~4× decay).
// Safe no-op without an AudioContext (headless tests / autoplay-blocked).
// Architecture: triangle (60 Hz) + sine (35 Hz) for soft low rumble +
// white noise through a band-pass filter for jet-engine "whoosh"; no
// harsh sawtooth — the filtered noise is the dominant jet texture.

/** Maximum thruster hum gain (≤ 0.2 per GDD §7.3 "All player cues keep volume ≤ 0.2"). */
export const THRUSTER_HUM_MAX_VOLUME = 0.15;
/** Base thruster hum frequency — soft triangle hum (GDD §7.3 continuous hum, jet roar). */
export const THRUSTER_HUM_BASE_FREQ = 60;
/** Undertone frequency (sine) — adds body to the low jet rumble. */
export const THRUSTER_HUM_UNDERTONE_FREQ = 35;
/** Detune spread retained for compat (jet roar no longer uses harsh detune). */
export const THRUSTER_HUM_DETUNE_SPREAD_CENTS = 12;
/** Maximum detune drift range in cents for organic tonal variation. */
const THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS = 8;
/** Per-frame detune drift step size in cents (random-walk). */
const THRUSTER_HUM_DETUNE_DRIFT_STEP_CENTS = 2;
/** Noise filter centre range for jet texture (band-pass). */
export const THRUSTER_HUM_NOISE_FILTER_MIN = 700;
export const THRUSTER_HUM_NOISE_FILTER_MAX = 1100;
/** Gain ramp time at FLAME_REF_THRUST: mirrors flame growth (mirrors FLAME_GROWTH_TIME_AT_REF). */
export const THRUSTER_HUM_GROWTH_TIME = 0.03;
/** Decay is ~4× growth, mirroring FLAME_SHRINK_MULTIPLIER (quick silence on release). */
export const THRUSTER_HUM_SHRINK_MULTIPLIER = 4;

/** Clamp level to [0, 1]. */
function clampLevel(level: number): number {
  if (level <= 0 || !Number.isFinite(level)) return 0;
  if (level >= 1) return 1;
  return level;
}

let thrusterHum: ThrusterHumState | null = null;

interface ThrusterHumState {
  ctx: AudioContext;
  osc: OscillatorNode;
  sub: OscillatorNode;
  /** White-noise source for jet-engine whoosh character. */
  noise: AudioBufferSourceNode;
  /** Low-pass filter shaping the noise into jet-like roar. */
  noiseFilter: BiquadFilterNode;
  gain: GainNode;
  /** Current gain — tracks the visual flame model analogously. */
  currentGain: number;
  /** Subtle detune drift in cents — slow random-walk variation for organic tonal character. */
  detuneOsc: number;
  /** Subtle detune drift in cents for the undertone oscillator. */
  detuneSub: number;
}

/** For tests: returns the current thruster hum state (or null if not started). */
export function _getThrusterHumStateForTests(): ThrusterHumState | null {
  return thrusterHum;
}

/**
 * Resets the thruster hum AudioNode lifecycle — stops any active hum and
 * clears module state. Exported under _ for tests so worktrees can re-test
 * the hum lifecycle in isolation.
 */
export function _resetThrusterHumForTests(): void {
  if (thrusterHum) {
    try {
      thrusterHum.gain.gain.cancelScheduledValues(thrusterHum.ctx.currentTime);
      thrusterHum.gain.gain.setValueAtTime(0, thrusterHum.ctx.currentTime);
      thrusterHum.osc.stop(thrusterHum.ctx.currentTime);
      thrusterHum.sub.stop(thrusterHum.ctx.currentTime);
      thrusterHum.noise.stop(thrusterHum.ctx.currentTime);
    } catch { /* already stopped / no ctx */ }
    thrusterHum = null;
  }
  // Also allow tests to re-seed the AudioContext with a new mock.
  // getAudioContext() caches the ctor instance; thruster tests need a fresh ctx.
}

/** Ensures the thruster hum has a live oscillator+gain. Lazily creates the nodes. */
function ensureThrusterHum(ctx: AudioContext): ThrusterHumState {
  if (thrusterHum && thrusterHum.ctx === ctx) return thrusterHum;
  // Orphaned context → tear down old hum first.
  if (thrusterHum) {
    _resetThrusterHumForTests();
  }
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.connect(ctx.destination);

  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(THRUSTER_HUM_BASE_FREQ, ctx.currentTime);
  osc.connect(gain);

  const sub = ctx.createOscillator();
  sub.type = 'sine';
  sub.frequency.setValueAtTime(THRUSTER_HUM_UNDERTONE_FREQ, ctx.currentTime);
  sub.connect(gain);

  // ── Jet-engine noise layer ──────────────────────────────────────
  // White noise → lowpass filter → gain.  The noise gives the hum
  // its jet-engine "whoosh" quality instead of a pure oscillator buzz.
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
  // Initial jet texture: band-pass centre 700–1100 Hz, moderate Q.
  const initCutoff = THRUSTER_HUM_NOISE_FILTER_MIN + Math.random() * (THRUSTER_HUM_NOISE_FILTER_MAX - THRUSTER_HUM_NOISE_FILTER_MIN);
  const initQ = 0.6 + Math.random() * 0.5;
  noiseFilter.frequency.setValueAtTime(initCutoff, ctx.currentTime);
  noiseFilter.Q.setValueAtTime(initQ, ctx.currentTime);

  noise.connect(noiseFilter);
  noiseFilter.connect(gain);
  noise.start(ctx.currentTime);

  osc.start(ctx.currentTime);
  sub.start(ctx.currentTime);

  // ── Subtle detune drift — organic tonal variation (AC1, AH-0MTK9JP37003MJQ4) ──
  // Small random-walk in cents, independent of thrust level.
  const initDetuneOsc = (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS;
  const initDetuneSub = (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS;
  osc.detune.setValueAtTime(initDetuneOsc, ctx.currentTime);
  sub.detune.setValueAtTime(initDetuneSub, ctx.currentTime);

  thrusterHum = { ctx, osc, sub, noise, noiseFilter, gain, currentGain: 0, detuneOsc: initDetuneOsc, detuneSub: initDetuneSub };
  return thrusterHum;
}

/**
 * Sustained thruster hum — player SFX (AH-0MTFOSOHN001Q620, GDD §7.3).
 *
 * A single reused soft triangle + sine undertone through one gain node
 * plus a dominant band-pass filtered white-noise whoosh (jet roar).
 * The gain envelope ramps smoothly so thrust onset/decay never clicks:
 * rise mirrors the flame growth time (30 ms at reference thrust),
 * decay is ~4× faster. `level` in [0, 1] comes from
 * `MovementModel.getEngineSoundLevel(state, input, thrustAcceleration)`
 * scaled by thrustAcceleration; the gain target is
 * `level * THRUSTER_HUM_MAX_VOLUME` (≤ 0.15).
 *
 * Call once per frame from `Player.preUpdate` — 0 silences the hum,
 * > 0 reuses the same nodes and ramps the gain. Does not leak oscillators.
 * Safe no-op without an AudioContext (headless tests / autoplay-blocked
 * browsers) — never throws.
 *
 * Thruster hum is NOT wired to per-engine flame ports — single ship-level
 * hum per the intake's single-hum assumption; VFX stays per-engine visual.
 */
export function updateThrusterSound(level: number): void {
  const clamped = clampLevel(level);
  const targetGain = clamped * THRUSTER_HUM_MAX_VOLUME;

  const ctx = getAudioContext();
  if (!ctx) {
    // Headless: track gain target so tests can still assert ramping
    // semantics without real audio; without a ctx the hum stays no-op
    // to the player but the module state mirrors "what the gain would be".
    if (clamped === 0 && thrusterHum) {
      // Silencing with no ctx — just forget the state, same as stop.
      thrusterHum = null;
      // Keep gainTracking for test assertions when headless (not used at runtime).
    }
    return;
  }

  if (clamped === 0) {
    if (!thrusterHum) return;
    // 4× decay: time to silence is growthTime / SHRINK_MULTIPLIER
    const decayTime = THRUSTER_HUM_GROWTH_TIME / THRUSTER_HUM_SHRINK_MULTIPLIER;
    const t = ctx.currentTime;
    thrusterHum.gain.gain.cancelScheduledValues(t);
    thrusterHum.gain.gain.setValueAtTime(thrusterHum.currentGain, t);
    thrusterHum.gain.gain.linearRampToValueAtTime(0, t + decayTime);
    thrusterHum.currentGain = 0;
    // Leave nodes live so retriggering ramps up from the decay tail
    // (no click) — stop only on explicit scene destroy via `stopThrusterSound`.
    return;
  }

  const hum = ensureThrusterHum(ctx);
  // Gentle pitch follows level — subtle, no buzzy jitter.
  const pitchScale = 1 + clamped * 0.12;
  hum.sub.frequency.setValueAtTime(THRUSTER_HUM_UNDERTONE_FREQ * pitchScale, ctx.currentTime);
  hum.osc.frequency.setValueAtTime(THRUSTER_HUM_BASE_FREQ * pitchScale, ctx.currentTime);
  // Subtle detune drift — slow random-walk for organic tonal variation (AC1).
  try {
    const driftOsc = Math.max(
      -THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
      Math.min(THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
        hum.detuneOsc + (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_STEP_CENTS
      )
    );
    const driftSub = Math.max(
      -THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
      Math.min(THRUSTER_HUM_DETUNE_DRIFT_MAX_CENTS,
        hum.detuneSub + (Math.random() * 2 - 1) * THRUSTER_HUM_DETUNE_DRIFT_STEP_CENTS
      )
    );
    hum.osc.detune.setValueAtTime(driftOsc, ctx.currentTime);
    hum.sub.detune.setValueAtTime(driftSub, ctx.currentTime);
    hum.detuneOsc = driftOsc;
    hum.detuneSub = driftSub;
  } catch { /* detune not supported */ }
  // Gentle jet filter drift — small variance per frame, filtered noise stays dominant.
  try {
    const cutoff = THRUSTER_HUM_NOISE_FILTER_MIN + Math.random() * (THRUSTER_HUM_NOISE_FILTER_MAX - THRUSTER_HUM_NOISE_FILTER_MIN);
    hum.noiseFilter.frequency.setValueAtTime(cutoff, ctx.currentTime);
  } catch { /* filter params not supported */ }

  const t = ctx.currentTime;
  // Rise time at this level = growthTime * (level's currentGain-distance / 1)
  // — faster at higher thrust analogously, but we approximate with linear
  // ramping from currentGain to target over growthTime scaled by remaining delta.
  const delta = Math.abs(targetGain - hum.currentGain);
  const ramp = THRUSTER_HUM_GROWTH_TIME * (delta / THRUSTER_HUM_MAX_VOLUME);
  hum.gain.gain.cancelScheduledValues(t);
  hum.gain.gain.setValueAtTime(hum.currentGain, t);
  hum.gain.gain.linearRampToValueAtTime(targetGain, t + Math.max(0.005, ramp));
  hum.currentGain = targetGain;
}

/**
 * Forces the thruster hum to stop and frees its AudioNodes.
 * Called when the ship is destroyed/respawned or the scene shuts down
 * (AC5 — no orphaned audio). Safe no-op without a live hum.
 */
export function stopThrusterSound(): void {
  if (!thrusterHum) return;
  try {
    thrusterHum.gain.gain.cancelScheduledValues(thrusterHum.ctx.currentTime);
    thrusterHum.gain.gain.setValueAtTime(0, thrusterHum.ctx.currentTime);
    thrusterHum.osc.stop(thrusterHum.ctx.currentTime + 0.02);
    thrusterHum.sub.stop(thrusterHum.ctx.currentTime + 0.02);
    thrusterHum.noise.stop(thrusterHum.ctx.currentTime + 0.02);
  } catch { /* ignore */ }
  thrusterHum = null;
}

/**
 * Resets the internal AudioContext cache — needed only in tests when
 * window.AudioContext is swapped between the recording mock and the
 * absence case. Production code never calls this.
 */
export function _resetAudioContextForTests(): void {
  try { thrusterHum?.gain?.gain?.cancelScheduledValues?.(thrusterHum.ctx.currentTime); } catch { /* ignore */ }
  thrusterHum = null;
  audioCtx = null;
}

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
