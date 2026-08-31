/**
 * Boss enemy entity — "The Central AI" (GDD §4.3).
 *
 * Renders as a large, imposing neon geometric structure at the centre of
 * the screen with a visible, pulsing central core. The Boss has a 4-phase
 * health bar; each phase has a distinct visual representation and attack
 * pattern:
 *
 *   Phase 1 — **Scan (Spread):** fires bullets in a wide spread pattern.
 *   Phase 2 — **Firestorm (Spiral):** bullets spiral outward from the Boss.
 *   Phase 3 — **Pulse:** a screen-wide pulse wave expands from the Boss,
 *              followed by aimed shots at the player's last known position.
 *   Phase 4 — **Desperation:** all previous patterns combined at higher
 *              speed; the core becomes more exposed / brighter (visual cue).
 *
 * Each attack phase begins with a clear telegraph (glow + audio cue) at
 * least 500 ms before the visual event fires.
 *
 * 4-phase health — the Boss is destroyed only when all four phases are
 * depleted. The gym scene provides a damage button for testing phase
 * transitions.
 *
 * Audio cues: spawn, phase transition, each phase's unique attack cue,
 * and destruction.
 */

import Phaser from 'phaser';

import { FormationOffset } from '../utils/formations';


// ── Visual / behaviour tuning (per GDD §4.3) ────────────────────────

/** Neon red body colour — phases shift to brighter red. */
export const BOSS_COLOR = 0xff0000;
/** Brighter red for phase 4 (desperation core exposure). */
export const BOSS_DESPERATION_COLOR = 0xff4444;
/** Neon yellow for the central core glow. */
export const BOSS_CORE_COLOR = 0xffff00;
/** Darker red for the phase health bar fill. */
export const BOSS_HEALTH_BAR_COLOR = 0xcc0000;

/** Boss body radius in px (the main geometric structure). */
export const BOSS_RADIUS = 50;
/** Core radius in px. */
export const BOSS_CORE_RADIUS = 16;
/** Core glow radius in px. */
export const BOSS_CORE_GLOW_RADIUS = 30;

/** Bullet colour for Boss attacks (bright white/cyan). */
export const BOSS_BULLET_COLOR = 0xffffff;
/** Bullet radius in px for Boss attacks. */
export const BOSS_BULLET_SIZE = 4;

/** Boss bullet base speed in px/s. */
export const BOSS_BULLET_SPEED = 160;
/** Desperation speed multiplier (1.6×). */
const BOSS_DESPERATION_SPEED_MULT = 1.6;

/** Interval between attack volleys in ms (phase 1 baseline). */
export const BOSS_ATTACK_INTERVAL = 1200;
/** Desperation interval (faster). */
const BOSS_DESPERATION_ATTACK_INTERVAL = 700;

/** Telegraph duration in ms — minimum lead time before attack fires (GDD §7.3). */
export const BOSS_TELEGRAPH_MS = 600;

/** Boss spawn audio: low rumble (GDD §7.3). */
export function playBossSpawnSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  // Low rumble ascending to signal boss entrance.
  blip(80, 220, 0.45, 'sine', 0.18);
}

/** Boss phase transition: rising tone. */
export function playBossPhaseTransitionSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  blip(220, 880, 0.35, 'square', 0.12);
}

/** Boss destruction: heavy, deep sound. */
export function playBossDestructionSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  blip(180, 20, 0.6, 'sawtooth', 0.22);
}

/** Boss phase audio cue per attack phase (distinct per phase). */
export function playBossPhaseCue(phase: BossPhase): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const cues: Record<number, [number, number]> = {
    1: [440, 660],  // Spread — moderate rise
    2: [330, 990],  // Spiral — steep rise
    3: [220, 440],  // Pulse — slow rise
    4: [660, 1320], // Desperation — sharp rise
  };
  const [start, end] = cues[phase] ?? cues[1];
  blip(start, end, 0.3, 'square', 0.1);
}

// ── Audio helpers (module-level, shared with effects.ts pattern) ────

let bossAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (bossAudioCtx) return bossAudioCtx;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    bossAudioCtx = new Ctor();
  } catch {
    bossAudioCtx = null;
  }
  return bossAudioCtx;
}

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
  gain.gain.exponentialRampToValueAtTime(
    0.0001,
    ctx.currentTime + duration,
  );

  osc.connect(gain).connect(ctx.destination);
  osc.start(ctx.currentTime);
  osc.stop(ctx.currentTime + duration + 0.02);
}

// ── Phase definitions ───────────────────────────────────────────────

/** The four attack phases of the Central AI Boss. */
export enum BossPhase {
  /** Phase 1: Scan — spread pattern. */
  Spread = 1,
  /** Phase 2: Firestorm — spiral pattern. */
  Spiral = 2,
  /** Phase 3: Pulse — wave + aimed shots. */
  Pulse = 3,
  /** Phase 4: Desperation — all patterns combined, faster. */
  Desperation = 4,
}

/** Total number of health phases. */
export const BOSS_PHASE_COUNT = 4;

/** Health bar width in px. */
export const BOSS_HEALTH_BAR_WIDTH = 300;
/** Health bar height in px. */
export const BOSS_HEALTH_BAR_HEIGHT = 14;
/** Health bar vertical padding from top of screen. */
export const BOSS_HEALTH_BAR_Y = 60;
/** Health bar horizontal centering offset. */
export const BOSS_HEALTH_BAR_X_OFFSET = 0; // centre-aligned

/** Number of health segments (visual divisions per phase). */
export const BOSS_HEALTH_SEGMENTS = 4;

// ── Entity configuration ────────────────────────────────────────────

export interface BossConfig {
  x: number;
  y: number;
  /** Offset within the formation (unused for Boss, but required by the interface). */
  formationOffset: FormationOffset;
}

// ── Bullet types ────────────────────────────────────────────────────

export interface BossBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly color: number;
  vx: number;
  vy: number;
  /** Whether this is a pulse wave (traveling ring). */
  isPulseWave?: boolean;
  /** Current radius of a pulse wave (used for ring animation). */
  pulseRadius?: number;
}

// ── Telegraph state ─────────────────────────────────────────────────

/** State machine for the Boss's attack telegraphing. */
enum TelegraphState {
  Idle = 0,
  Telegraphing = 1,
  Attacking = 2,
}

// ── The Boss entity ─────────────────────────────────────────────────

/**
 * "The Central AI" — a large, glowing neon geometric structure with
 * a visible central core.
 *
 * The Boss cycles through 4 attack phases. Each phase has a distinct
 * visual style (core brightness, body colour shift) and attack pattern.
 *
 * Telegraphing: before each attack volley, the Boss glows intensely
 * and plays an audio cue ≥ 500 ms in advance.
 */
export class Boss extends Phaser.GameObjects.Container {
  private readonly bodyGraphics: Phaser.GameObjects.Graphics;
  private readonly coreGraphics: Phaser.GameObjects.Graphics;
  private readonly coreGlowGraphics: Phaser.GameObjects.Graphics;
  private readonly explosionGraphics: Phaser.GameObjects.Graphics;
  protected readonly healthBarGraphics: Phaser.GameObjects.Graphics;

  private readonly formationOffset: FormationOffset;

  private _alive = true;
  private _shootEnabled = true; // Boss always "shoots" (pattern-driven)
  private _currentPhase = BossPhase.Spread;
  private _currentPhaseNumber = 1;
  private _healthSegmentsRemaining = BOSS_PHASE_COUNT;
  private _telegraphState: TelegraphState = TelegraphState.Idle;
  private _telegraphStartTime = 0;
  private _lastAttackTime = 0;
  private _attackAngle = 0; // for spiral pattern rotation

  // Pulse wave state
  private _pulseWaveGraphics: Phaser.GameObjects.Graphics | null = null;
  private _pulseWaveRadius = 0;
  private _pulseWaveSpeed = 300;

  // Core pulsing animation
  private _corePulsePhase = 0;
  private _corePulseSpeed = 2.0;

  // Player tracking for pulse aimed shots
  private _playerTargetX = 480;
  private _playerTargetY = 500;

  // ── Construction ────────────────────────────────────────────────

  constructor(scene: Phaser.Scene, config: BossConfig) {
    super(scene, config.x, config.y);

    this.formationOffset = config.formationOffset;

    // Body — a hexagonal/geometric shape in neon red.
    this.bodyGraphics = scene.add.graphics();
    this.bodyGraphics.setDepth(1);
    this.add(this.bodyGraphics);

    // Outer glow ring.
    this.coreGlowGraphics = scene.add.graphics();
    this.coreGlowGraphics.setDepth(0);
    this.add(this.coreGlowGraphics);

    // Central core — bright, pulsing.
    this.coreGraphics = scene.add.graphics();
    this.coreGraphics.setDepth(2);
    this.add(this.coreGraphics);

    // Explosion graphics.
    this.explosionGraphics = scene.add.graphics();
    this.explosionGraphics.setDepth(3);
    this.add(this.explosionGraphics);

    // Health bar — rendered at screen top, positioned in create().
    this.healthBarGraphics = scene.add.graphics();
    this.healthBarGraphics.setDepth(100);
    this.healthBarGraphics.setScrollFactor(0); // fixed on screen
    this.add(this.healthBarGraphics);

    this._drawBody();
    this._drawHealthBar();
    playBossSpawnSound();
  }

  // ── Drawing ─────────────────────────────────────────────────────

  /** Draws the Boss body (hexagonal geometric structure). */
  private _drawBody(): void {
    this.bodyGraphics.clear();
    const isDesperation = this._currentPhaseNumber === 4;
    const color = isDesperation ? BOSS_DESPERATION_COLOR : BOSS_COLOR;

    this.bodyGraphics.lineStyle(3, color, 1);
    this.bodyGraphics.fillStyle(color, 0.15);

    // Hexagon.
    this.bodyGraphics.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = Math.cos(angle) * BOSS_RADIUS;
      const py = Math.sin(angle) * BOSS_RADIUS;
      if (i === 0) this.bodyGraphics.moveTo(px, py);
      else this.bodyGraphics.lineTo(px, py);
    }
    this.bodyGraphics.closePath();
    this.bodyGraphics.fillPath();
    this.bodyGraphics.strokePath();
  }

  /** Draws the pulsing central core. */
  /** Draws the pulsing central core. */
  _drawCore(): void {
    this.coreGraphics.clear();
    const isDesperation = this._currentPhaseNumber === 4;
    const baseAlpha = isDesperation ? 0.9 : 0.6;
    // Pulse effect: brightness oscillates.
    const pulse =
      0.5 + 0.5 * Math.sin(this._corePulsePhase * this._corePulseSpeed);
    const alpha = baseAlpha * (0.7 + 0.3 * pulse);
    const coreSize = BOSS_CORE_RADIUS * (isDesperation ? 1.15 : 1.0);

    this.coreGraphics.lineStyle(2, BOSS_CORE_COLOR, alpha);
    this.coreGraphics.fillStyle(BOSS_CORE_COLOR, alpha * 0.5);
    this.coreGraphics.fillCircle(0, 0, coreSize);
    this.coreGraphics.strokeCircle(0, 0, coreSize);

    // Inner bright dot.
    this.coreGraphics.fillStyle(0xffffff, alpha);
    this.coreGraphics.fillCircle(0, 0, coreSize * 0.35);
  }

  /** Draws the outer core glow ring. */
  /** Draws the outer core glow ring. */
  _drawCoreGlow(): void {
    this.coreGlowGraphics.clear();
    const isDesperation = this._currentPhaseNumber === 4;
    const pulse =
      0.5 + 0.5 * Math.sin(this._corePulsePhase * this._corePulseSpeed * 0.7);
    const baseAlpha = isDesperation ? 0.3 : 0.15;
    const alpha = baseAlpha * (0.6 + 0.4 * pulse);
    const radius = BOSS_CORE_GLOW_RADIUS * (isDesperation ? 1.4 : 1.0);

    this.coreGlowGraphics.lineStyle(2, BOSS_CORE_COLOR, alpha);
    this.coreGlowGraphics.strokeCircle(0, 0, radius);
  }

  /** Draws the multi-phase health bar at the top of the screen. */
  /** Draws the multi-phase health bar at the top of the screen. */
  _drawHealthBar(): void {
    this.healthBarGraphics.clear();
    const scene = this.scene as Phaser.Scene;
    const w = BOSS_HEALTH_BAR_WIDTH;
    const h = BOSS_HEALTH_BAR_HEIGHT;
    const x = (scene.scale.width - w) / 2;
    const y = BOSS_HEALTH_BAR_Y;

    // Background (dark).
    this.healthBarGraphics.fillStyle(0x220000, 1);
    this.healthBarGraphics.fillRect(x, y, w, h);

    // Border.
    this.healthBarGraphics.lineStyle(2, 0xff4444, 1);
    this.healthBarGraphics.strokeRect(x, y, w, h);

    // Health fill — green in phase 1, yellow in 2, orange in 3, red in 4.
    const fillWidth = (this._healthSegmentsRemaining / BOSS_PHASE_COUNT) * w;
    const healthColors: Record<number, number> = {
      4: 0xff0000,
      3: 0xff8800,
      2: 0xffcc00,
      1: 0x00ff00,
    };
    const healthColor =
      healthColors[this._healthSegmentsRemaining] ?? 0xff0000;
    this.healthBarGraphics.fillStyle(healthColor, 0.85);
    this.healthBarGraphics.fillRect(x, y, fillWidth, h);

    // Segment dividers.
    const segWidth = w / BOSS_HEALTH_SEGMENTS;
    this.healthBarGraphics.lineStyle(1, 0x666666, 0.5);
    for (let i = 1; i < BOSS_HEALTH_SEGMENTS; i++) {
      const segX = x + i * segWidth;
      this.healthBarGraphics.moveTo(segX, y);
      this.healthBarGraphics.lineTo(segX, y + h);
    }
    this.healthBarGraphics.strokePath();

    this.healthBarGraphics.lineStyle(1, 0xcccccc, 0.3);
    this.healthBarGraphics.strokeRect(x, y - 2, w, h + 4);

    this.healthBarGraphics.setDepth(100);
  }

  // ── Telegraphing ────────────────────────────────────────────────

  /**
   * Starts the telegraph for the current phase's attack pattern.
   * Glows brighter and plays an audio cue ≥ 500 ms before firing.
   */
  startTelegraph(now: number): void {
    if (!this._alive || !this._shootEnabled) return;
    this._telegraphState = TelegraphState.Telegraphing;
    this._telegraphStartTime = now;
    this._corePulseSpeed = 5.0; // speed up pulse during telegraph
    playBossPhaseCue(this._currentPhase);
  }

  /** Checks if the telegraph period has elapsed; fires the attack if so. */
  checkTelegraph(now: number): void {
    if (this._telegraphState !== TelegraphState.Telegraphing) return;
    if (now - this._telegraphStartTime < BOSS_TELEGRAPH_MS) return;

    // Telegraph period elapsed — mark the attack as ready to fire.
    // (Do NOT set _lastAttackTime here: the fire methods set it after a
    // volley actually fires, otherwise _shouldFire would compare against
    // this same frame and never fire.)
    this._telegraphState = TelegraphState.Attacking;
    this._corePulseSpeed = this._currentPhaseNumber === 4 ? 4.0 : 2.5;
  }

  /** Checks if the attack phase has completed and resets to idle. */
  checkAttackComplete(now: number): boolean {
    if (this._telegraphState !== TelegraphState.Attacking) return false;
    // Attack is considered complete after one volley interval.
    const interval =
      this._currentPhaseNumber === 4
        ? BOSS_DESPERATION_ATTACK_INTERVAL
        : BOSS_ATTACK_INTERVAL;
    if (now - this._lastAttackTime > interval) {
      this._telegraphState = TelegraphState.Idle;
      this._corePulseSpeed = this._currentPhaseNumber === 4 ? 4.0 : 2.0;
      return true;
    }
    return false;
  }

  // ── Attack pattern fire methods ─────────────────────────────────

  /**
   * Spread pattern (Phase 1): fires bullets in a wide arc.
   */
  tryFireSpreadBullets(now: number): BossBullet[] {
    if (!this._shouldFire(now)) return [];
    if (this._telegraphState === TelegraphState.Telegraphing) return [];

    const speed = this._bulletSpeed();
    const bullets: BossBullet[] = [];
    const count = this._currentPhaseNumber === 4 ? 9 : 7;
    const spreadAngle = Math.PI * 0.6; // 108° total spread
    const startAngle = Math.PI / 2 + spreadAngle / 2;

    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const angle = startAngle - t * spreadAngle;
      bullets.push(this._createBullet(angle, speed));
    }
    this._lastAttackTime = now; // mark volley as fired
    return bullets;
  }

  /**
   * Spiral pattern (Phase 2): bullets spiral outward from the Boss.
   */
  tryFireSpiralBullets(now: number): BossBullet[] {
    if (!this._shouldFire(now)) return [];
    if (this._telegraphState === TelegraphState.Telegraphing) return [];

    const speed = this._bulletSpeed();
    const bullets: BossBullet[] = [];
    const count = this._currentPhaseNumber === 4 ? 16 : 12;

    for (let i = 0; i < count; i++) {
      const angle = this._attackAngle + (Math.PI * 2 * i) / count;
      bullets.push(this._createBullet(angle, speed));
    }
    this._attackAngle += 0.3; // rotate the spiral next volley
    this._lastAttackTime = now; // mark volley as fired
    return bullets;
  }

  /**
   * Pulse pattern (Phase 3): a screen-wide wave + aimed shots.
   */
  tryFirePulseBullets(now: number): BossBullet[] {
    if (!this._shouldFire(now)) return [];
    if (this._telegraphState === TelegraphState.Telegraphing) return [];

    const bullets: BossBullet[] = [];

    // Create a pulse wave (ring expanding from the Boss).
    const pulse = (this.scene as Phaser.Scene).add.graphics();
    pulse.fillStyle(BOSS_CORE_COLOR, 0.4);
    pulse.setDepth(2);
    pulse.setPosition(this.x, this.y);
    this._pulseWaveRadius = BOSS_CORE_GLOW_RADIUS;
    this._pulseWaveGraphics = pulse;

    bullets.push({
      graphics: pulse,
      color: BOSS_CORE_COLOR,
      vx: 0,
      vy: 0,
      isPulseWave: true,
      pulseRadius: BOSS_CORE_GLOW_RADIUS,
    });

    // Aimed shots toward player's last known position.
    const speed = this._bulletSpeed();
    const aimCount = this._currentPhaseNumber === 4 ? 4 : 3;
    for (let i = 0; i < aimCount; i++) {
      const dx = this._playerTargetX - this.x;
      const dy = this._playerTargetY - this.y;
      const baseAngle = Math.atan2(dy, dx);
      // Fan out slightly around the aim direction.
      const fanSpread = 0.2;
      const angle = baseAngle + (i - (aimCount - 1) / 2) * fanSpread;
      bullets.push(this._createBullet(angle, speed));
    }

    this._lastAttackTime = now; // mark volley as fired
    return bullets;
  }

  /**
   * Desperation pattern (Phase 4): all patterns combined at higher speed.
   */
  tryFireDesperationBullets(now: number): BossBullet[] {
    if (!this._shouldFire(now)) return [];
    if (this._telegraphState === TelegraphState.Telegraphing) return [];

    const bullets: BossBullet[] = [];
    const speed = this._bulletSpeed();

    // Layer 1: spread (5 bullets).
    const spreadCount = 5;
    const spreadAngle = Math.PI * 0.5;
    for (let i = 0; i < spreadCount; i++) {
      const t = i / (spreadCount - 1);
      const angle = Math.PI / 2 + spreadAngle / 2 - t * spreadAngle;
      bullets.push(this._createBullet(angle, speed));
    }

    // Layer 2: spiral (8 bullets).
    for (let i = 0; i < 8; i++) {
      const angle =
        this._attackAngle + (Math.PI * 2 * i) / 8 + Math.PI / 8;
      bullets.push(this._createBullet(angle, speed));
    }
    this._attackAngle += 0.5;

    // Layer 3: aimed shot.
    const dx = this._playerTargetX - this.x;
    const dy = this._playerTargetY - this.y;
    const aimAngle = Math.atan2(dy, dx);
    bullets.push(this._createBullet(aimAngle, speed));

    // Pulse wave.
    const pulse = (this.scene as Phaser.Scene).add.graphics();
    pulse.fillStyle(BOSS_CORE_COLOR, 0.5);
    pulse.setDepth(2);
    pulse.setPosition(this.x, this.y);
    this._pulseWaveRadius = BOSS_CORE_GLOW_RADIUS;
    this._pulseWaveGraphics = pulse;
    bullets.push({
      graphics: pulse,
      color: BOSS_CORE_COLOR,
      vx: 0,
      vy: 0,
      isPulseWave: true,
      pulseRadius: BOSS_CORE_GLOW_RADIUS,
    });

    this._lastAttackTime = now; // mark volley as fired
    return bullets;
  }

  /**
   * Advances a pulse wave outward (called from update).
   * Returns true if the wave has left the screen.
   */
  advancePulseWave(dt: number, sceneWidth: number, sceneHeight: number): boolean {
    if (!this._pulseWaveGraphics) return false;

    this._pulseWaveRadius += this._pulseWaveSpeed * dt;
    const maxRadius = Math.sqrt(
      (sceneWidth / 2) ** 2 + (sceneHeight / 2) ** 2,
    );
    if (this._pulseWaveRadius > maxRadius) {
      this._pulseWaveGraphics.destroy();
      this._pulseWaveGraphics = null;
      return true;
    }

    const pulse = this._pulseWaveGraphics;
    pulse.clear();
    const alpha = Math.max(0, 1 - this._pulseWaveRadius / maxRadius) * 0.4;
    pulse.lineStyle(Math.max(1, 6 - this._pulseWaveRadius / 100), BOSS_CORE_COLOR, alpha);
    pulse.strokeCircle(0, 0, this._pulseWaveRadius);

    return false;
  }

  // ── Helper methods ──────────────────────────────────────────────

  private _shouldFire(now: number): boolean {
    if (!this._alive || !this._shootEnabled) return false;
    const interval =
      this._currentPhaseNumber === 4
        ? BOSS_DESPERATION_ATTACK_INTERVAL
        : BOSS_ATTACK_INTERVAL;
    return now - this._lastAttackTime >= interval;
  }

  private _bulletSpeed(): number {
    return this._currentPhaseNumber === 4
      ? BOSS_BULLET_SPEED * BOSS_DESPERATION_SPEED_MULT
      : BOSS_BULLET_SPEED;
  }

  private _createBullet(angle: number, speed: number): BossBullet {
    const graphics = (this.scene as Phaser.Scene).add.graphics();
    graphics.fillStyle(BOSS_BULLET_COLOR, 1);
    graphics.fillCircle(0, 0, BOSS_BULLET_SIZE);
    graphics.setPosition(this.x, this.y);
    graphics.setDepth(3);

    return {
      graphics,
      color: BOSS_BULLET_COLOR,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    };
  }

  // ── Phase management ────────────────────────────────────────────

  /**
   * Applies damage: decrements health by one segment and advances the
   * phase number. Returns the new phase number (or 0 if destroyed).
   */
  takeDamage(): number {
    if (!this._alive) return 0;
    this._healthSegmentsRemaining--;

    if (this._healthSegmentsRemaining <= 0) {
      // Boss destroyed — play destruction animation.
      this.destroySelf();
      return 0;
    }

    // Advance to the next phase.
    this._currentPhaseNumber++;
    if (this._currentPhaseNumber > BOSS_PHASE_COUNT) {
      this._currentPhaseNumber = BOSS_PHASE_COUNT;
    }
    this._currentPhase = this._currentPhaseNumber as BossPhase;

    // Update visuals.
    this._drawBody();
    this._drawHealthBar();

    playBossPhaseTransitionSound();
    return this._currentPhaseNumber;
  }

  /** Returns the current phase number (1–4). */
  getPhaseNumber(): number {
    return this._currentPhaseNumber;
  }

  /** Returns the current phase. */
  getPhase(): BossPhase {
    return this._currentPhase;
  }

  /** Returns remaining health segments. */
  getHealthSegments(): number {
    return this._healthSegmentsRemaining;
  }

  /** Returns true if in desperation phase. */
  isDesperation(): boolean {
    return this._currentPhaseNumber === 4;
  }

  /** Returns true if currently telegraphing an attack. */
  isTelegraphing(): boolean {
    return this._telegraphState === TelegraphState.Telegraphing;
  }

  /**
   * Test helper: sets the telegraph state to Attacking so the next
   * update call fires the attack immediately (bypasses telegraph delay).
   */
  _simulateTelegraphElapsed(): void {
    this._telegraphState = TelegraphState.Attacking;
    this._lastAttackTime = 0;
  }

  // ── Public state (FormationSceneEntity contract) ────────────────

  get alive(): boolean {
    return this._alive;
  }

  get shootEnabled(): boolean {
    return this._shootEnabled;
  }

  set shootEnabled(value: boolean) {
    this._shootEnabled = value;
  }

  get offset(): FormationOffset {
    return { ...this.formationOffset };
  }

  get bodyVisible(): boolean {
    return this.bodyGraphics.alpha > 0 && this.bodyGraphics.visible;
  }

  // ── Behaviour ───────────────────────────────────────────────────

  destroySelf(): void {
    if (!this._alive) return;
    this._alive = false;
    this.bodyGraphics.setAlpha(0);
    this.coreGraphics.setAlpha(0);
    this.coreGlowGraphics.setAlpha(0);
    this._playExplosion();
    playBossDestructionSound();
    this._drawHealthBar(); // health bar goes dark
  }

  /**
   * Applies the formation position — keeps the Boss centered on screen.
   * The Boss does not drift; it stays at its spawn position.
   */
  applyFormationPosition(
    baseX: number,
    baseY: number,
    _dt: number,
    _spacingX: number,
    _spacingY: number,
  ): void {
    if (!this._alive) return;
    this.setPosition(baseX, baseY);
  }

  // ── Animation ───────────────────────────────────────────────────

  /**
   * Plays the destruction animation: expanding, fading rings.
   */
  private _playExplosion(): void {
    const scene = this.scene as Phaser.Scene;
    scene.tweens.add({
      targets: this.explosionGraphics,
      alpha: { from: 1, to: 0 },
      duration: 800,
      onUpdate: () => {
        const alpha = this.explosionGraphics.alpha;
        const radius = BOSS_RADIUS * 2.5 * (1 - alpha) + BOSS_RADIUS;
        this.explosionGraphics.clear();
        this.explosionGraphics.lineStyle(
          Math.max(1, Math.round(4 * alpha)),
          BOSS_COLOR,
          alpha,
        );
        this.explosionGraphics.strokeCircle(0, 0, radius);
        // Cross lines.
        this.explosionGraphics.beginPath();
        this.explosionGraphics.moveTo(-radius, 0);
        this.explosionGraphics.lineTo(radius, 0);
        this.explosionGraphics.moveTo(0, -radius);
        this.explosionGraphics.lineTo(0, radius);
        this.explosionGraphics.strokePath();
      },
      onComplete: () => {
        this.explosionGraphics.destroy();
      },
    });
  }

  /**
   * Per-frame update for animation and attack logic.
   * Returns bullets that should be collected by the scene.
   */
  update(now: number, delta: number, sceneWidth: number, sceneHeight: number): BossBullet[] {
    const dt = delta / 1000;
    const bullets: BossBullet[] = [];

    if (!this._alive) return bullets;

    // Update core pulse.
    this._corePulsePhase += dt;

    // Draw core and glow (pulsing).
    this._drawCore();
    this._drawCoreGlow();

    // Attack logic.
    if (this._telegraphState === TelegraphState.Idle) {
      // Start telegraphing.
      this.startTelegraph(now);
    } else {
      // Check if telegraph period elapsed — fire attack.
      this.checkTelegraph(now);

      // Fire the attack pattern for the current phase.
      switch (this._currentPhase) {
        case BossPhase.Spread:
          bullets.push(...this.tryFireSpreadBullets(now));
          break;
        case BossPhase.Spiral:
          bullets.push(...this.tryFireSpiralBullets(now));
          break;
        case BossPhase.Pulse:
          bullets.push(...this.tryFirePulseBullets(now));
          break;
        case BossPhase.Desperation:
          bullets.push(...this.tryFireDesperationBullets(now));
          break;
      }

      // Advance pulse wave if active.
      this.advancePulseWave(dt, sceneWidth, sceneHeight);

      // Check if attack phase is complete.
      this.checkAttackComplete(now);
    }

    return bullets;
  }

  // ── Cleanup ─────────────────────────────────────────────────────

  destroy(fromScene?: boolean): void {
    this.bodyGraphics.destroy();
    this.coreGraphics.destroy();
    this.coreGlowGraphics.destroy();
    this.explosionGraphics.destroy();
    this.healthBarGraphics.destroy();
    if (this._pulseWaveGraphics) {
      this._pulseWaveGraphics.destroy();
    }
    super.destroy(fromScene);
  }
}
