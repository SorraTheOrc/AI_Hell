/**
 * Gym scene — combat-coupled power-ups (P3 Shield, P4 Bomb, P6 Phase Shift,
 * P7 Teleport) with low-level enemy threats (AH-0MTC2P6G3007PJ40).
 *
 * Dedicated combat gym (companion to the threat-free `GymPowerUps` gym):
 * demonstrates P3/P4/P6/P7 FULL behaviour which requires threats:
 *
 * - **P3 Shield** — 15 s bubble, absorbs one hit before popping.
 * - **P4 Bomb** — instant clear of on-screen enemy bullets (does not damage
 *   1-HP scouts, GDD §4.4); no enemy damage.
 * - **P6 Phase Shift** — charge-based auto-trigger: collecting P6 stores one
 *   use, and the shared danger feed activates a 1.5 s pass-through when three
 *   or more hostile bodies/bullets close within 40 px (parent
 *   AH-0MUIYX1EE008FVS8).
 * - **P7 Teleport** — stored FIFO stacks; S or ↓ teleports to the nearest
 *   safe spot free of enemies/bullets in the direction of travel,
 *   clamped to screen bounds; grants P6 (1.5 s) on arrival. If no safe
 *   spot exists, teleports to the nearest on-screen position along
 *   the heading ray.
 *
 * Threat model: a small E1 Scout V-formation (3 scouts) drifting slowly
 * and firing aimed shots toward the player when shooting is enabled
 * (SHOOT button, on by default for the gym). Bullets and enemy bodies
 * are the threats that make P3/P4/P6/P7 meaningful — the gym is not
 * used to farm lives or score.
 *
 * Spawn cadence mirrors `GymPowerUps`: one drop at a time, round-robin
 * P3 → P4 → P6 → P7, each living `POWER_UP_LIFETIME` (12.5 s, grow →
 * hold → shrink, framerate-independent via `PowerUp`), collection
 * gated at >3% full-size scale, same `POWER_UP_DROP_SIZE` (16 px)
 * bubble + icon visuals. NEXT spawn coincides with previous despawn
 * while nothing is collected — one drop on screen.
 *
 * Hit response (with threats): when a bullet/body hits the player
 * - if P6 phased → pass-through (no hit)
 * - else if P3 shielded → shield pops, bullet/body consumed, short
 *   invulnerability blink; no respawn damage
 * - else → hit recorded, short invulnerability blink + respawn to
 *   centre (no lives/score — gym is for observation).
 *
 * Teleport (S/↓): routed through the shared `CombatScene.triggerTeleport`
 * so the game and every gym resolve teleports through one implementation;
 * it consumes one P7 stack FIFO, warps to the nearest safe spot along the
 * heading ray, clamped to screen bounds, then applies P6. The gym supplies
 * only its hit radii (`getTeleportEnemyHitRadius` / `getTeleportBulletHitRadius`)
 * and its enemy list (`getEnemyEntities`); destination selection, FIFO
 * consumption and the P6-on-arrival grant are shared (gap 7,
 * AH-0MUII3EPU0039R5O).
 *
 * The drop lifecycle, collection gate, P9 magnet, P4 bomb notice and
 * per-type pickup cues run through the shared `src/scenes/core/dropLayer.ts`
 * template methods and `BombNotice`, so this gym cannot drift from the game;
 * only the round-robin spawn *source* is gym-specific
 * (AH-0MUII3CXX0023H24, gap 4).
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically via
 * `gameHarness` without a real render loop.
 */

import Phaser from 'phaser';

import { CombatScene } from '../core/CombatScene';
import { advanceWrappingBullets } from '../core/bulletLifecycle';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';
import {
  applyPhaseGhost,
  drawShieldBubble,
} from '../core/CombatEffectVisuals';
import { Player } from '../../entities/Player';
import { Scout, ScoutBullet, SCOUT_SIZE } from '../../entities/Scout';
import { fireForEnemy } from '../../entities/enemyFire';
import { HUD } from '../../ui/HUD';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import {
  PowerUpId,
  COMBAT_POWER_UP_IDS,
  getPowerUpById,
} from '../../powerups/types';
import { drawPowerUpDrop } from '../../powerups/icons';
import { BombNotice } from '../core/BombNotice';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';
export { findTeleportDestination } from '../../powerups/teleport';
import { playSpawnSound } from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { addHelpButton, type GymHelpHandle } from '../../utils/gymHelp';
import { buildVFormationOffsets } from '../../utils/formations';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  POWER_UP_SPAWN_INTERVAL,
  COMBAT_HIT_INVULNERABLE_DURATION,
} from '../../core/constants';

// ── Spawn / formation tuning ───────────────────────────────────────

/** Round-robin order for the combat gym (GDD asc: P3 → P4 → P6 → P7). */
const COMBAT_ORDER: readonly PowerUpId[] = COMBAT_POWER_UP_IDS;

/** Deterministic spawn positions (cycling) — upper/mid screen, clear of formation. */
const SPAWN_POSITIONS: readonly { x: number; y: number }[] = [
  { x: 700, y: 120 },
  { x: 500, y: 400 },
  { x: 750, y: 300 },
];

/** Small threat formation: 3 scouts in a V (1 + 2), mirrors E1 but tiny. */
export const COMBAT_SCOUT_COUNT = 3;
const COMBAT_SPACING_X = 32;
const COMBAT_SPACING_Y = 28;
const COMBAT_START_X = GAME_WIDTH * 0.2;
const COMBAT_START_Y = 110;
const COMBAT_DRIFT_SPEED = 18;

/** Teleport-avoidance hit radii supplied through the shared hooks (px). */
const ENEMY_HIT_RADIUS = SCOUT_SIZE / 2 + 4;
const BULLET_HIT_RADIUS = 5;

// ── Active drop model ──────────────────────────────────────────────

/** A live power-up drop on the field. */
export interface CombatActiveDrop {
  powerUp: PowerUp;
  x: number;
  y: number;
  graphics: Phaser.GameObjects.Graphics;
  /** Unified drop id, consumed by the shared collect path. */
  dropId: PowerUpId;
  /** True once collected and playing its absorb VFX (AC4). */
  absorbing?: boolean;
}

/**
 * Combat-coupled power-ups gym. Extends the shared {@link CombatScene}
 * core so its collision, teleport and hit lifecycle flow through the one
 * shared implementation; the gym supplies scene specifics through hooks.
 */
export class GymPowerUpsCombat extends CombatScene<
  Scout,
  ScoutBullet,
  CombatActiveDrop
> {
  private player: Player | null = null;
  private effectsRegistry = new EffectsRegistry();
  private drops: CombatActiveDrop[] = [];
  private roundRobinSpawner = new RoundRobinSpawner<PowerUpId>(COMBAT_ORDER);
  private spawnIndex = 0;
  private spawnTimer = 0;
  private hud: HUD | null = null;

  // Threats
  private scouts: Scout[] = [];
  private scoutBullets: ScoutBullet[] = [];
  private formationBaseX = COMBAT_START_X;
  private formationBaseY = COMBAT_START_Y;
  private shootEnabled = true;

  // Visual feedback
  private shieldBubble: Phaser.GameObjects.Graphics | null = null;
  private bombNotice: BombNotice | null = null;

  // UI
  private shootButton: Phaser.GameObjects.Text | null = null;
  /** Shared help affordance (AH-0MUAYB67I002REOZ). */
  private helpHandle: GymHelpHandle | null = null;

  constructor() {
    super({ key: 'GymPowerUpsCombat' });
  }

  create(): void {
    // Reset shared + scene-owned per-run state so a stop/restart of the
    // same instance starts clean (AH-0MUII3FYN0072QRT, gap 10).
    this.resetRunState();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);

    addBackToIndexButton(this);
    // Shared "Help (?)" button + overlay: lists every drop this gym can
    // spawn, sourced from the shared catalogues (AH-0MUAYB67I002REOZ).
    this.helpHandle = addHelpButton(this, {
      gymKey: 'GymPowerUpsCombat',
      drops: COMBAT_ORDER,
    });
    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);
    this.hud = new HUD(this, this.effectsRegistry, { showLives: false });

    // Tear down all scene-owned objects on shutdown so a stop/restart of
    // the same instance leaks nothing (AH-0MUII3FYN0072QRT, gap 10).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());

    this.shieldBubble = this.add.graphics();
    this.shieldBubble.setDepth(50);
    this.bombNotice = new BombNotice(this, {
      x: GAME_WIDTH / 2,
      y: 24,
      fontSize: '14px',
      padding: { x: 6, y: 2 },
    });

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as WasdKeysLike | undefined;
    this.teleportKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.S) ?? null;
    this.downKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN) ?? null;

    // Spawn the small scout formation.
    this._spawnScoutFormation();
    playSpawnSound();
    this.shootEnabled = true;

    // Small threats = a wave: arm the shared wave-timeout so survivors
    // detonate and the formation refreshes, mirroring the shipped game
    // (AH-0MUNR5LM1004B223).
    this.startWaveTimeout();

    // SHOOT toggle (mirrors GymFormationScene)
    this.shootButton = this.add.text(10, 10, 'SHOOT: ON', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#00ff00',
      backgroundColor: '#1a1a1a',
      padding: { x: 8, y: 4 },
    });
    this.shootButton.setInteractive({ useHandCursor: true });
    this.shootButton.on('pointerdown', () => this.toggleShooting());

    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, 'P3 Shield · P4 Bomb · P6 Phase · P7 Teleport (S/↓) — scouts fire aimed shots', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#555555',
    }).setOrigin(0.5);

    // First drop immediately.
    this._spawnRoundRobin();
    this.spawnTimer = POWER_UP_SPAWN_INTERVAL;
  }

  /**
   * Resets shared per-run state (effects registry + bullet/effect
   * registries via the core) plus this gym's player, drops, scout
   * formation, HUD and visual state (AH-0MUII3FYN0072QRT, gap 10).
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.drops = [];
    this.spawnIndex = 0;
    this.spawnTimer = 0;
    this.hud = null;
    this.scouts = [];
    this.scoutBullets = [];
    this.formationBaseX = COMBAT_START_X;
    this.formationBaseY = COMBAT_START_Y;
    this.shootEnabled = true;
    this.shieldBubble = null;
    this.bombNotice = null;
    this.shootButton = null;
    this.helpHandle = null;
  }

  /**
   * Destroys every scene-owned object on `SHUTDOWN` after the shared core
   * teardown has run, so a stop/restart leaks nothing (AC2).
   */
  protected override teardownRunState(): void {
    super.teardownRunState();
    for (const drop of this.drops) drop.graphics.destroy();
    this.drops = [];
    for (const scout of this.scouts) scout.destroy();
    this.scouts = [];
    for (const bullet of this.scoutBullets) bullet.graphics.destroy();
    this.scoutBullets = [];
    this.player?.destroy();
    this.player = null;
    this.hud?.destroy();
    this.hud = null;
    this.shieldBubble?.destroy();
    this.shieldBubble = null;
    this.bombNotice?.destroy();
    this.bombNotice = null;
    this.shootButton?.destroy();
    this.shootButton = null;
    this.helpHandle = null;
  }

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * This gym's scouts are persistent demonstration threats and must never
   * be destroyed, and it has no weapon drops, so the player does not
   * auto-fire; the shared step's auto-fire resolves to a no-op
   * (AH-0MUII39KX007YUQ0, AC1/AC4).
   */
  protected override autoFireEnabled(): boolean {
    return false;
  }

  /**
   * One deterministic simulation step (seconds). Drives ship movement,
   * formation drift, scout aim + firing, bullet lifecycle, spawner,
   * drop lifecycles, collection (with P4 bomb), effect timers,
   * teleport (S/↓), hit response, and HUD.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // ── Shared player-control step: timers → multipliers → input →
    // physics → auto-fire (AH-0MUII39KX007YUQ0, AC1/AC4). The player is
    // advanced from the supplied `dt`; auto-fire is a no-op here.
    this._tickPlayer(dt);

    // ── Teleport (S/↓) — before hit checks so arrival phase protects ─
    this._handleTeleport();

    // ── Formation drift ─────────────────────────────────────────
    this._tickFormation(dt);

    // ── Scout aim + shooting ────────────────────────────────────
    this._tickScouts();

    // ── Enemy bullets ───────────────────────────────────────────
    this._advanceEnemyBullets(dt);

    // ── Spawner: one drop per interval, round-robin ─────────────
    if (this.spawnTimer <= 0) {
      this.spawnTimer += POWER_UP_SPAWN_INTERVAL;
      this._spawnRoundRobin();
    } else {
      this.spawnTimer -= dt;
    }

    // ── Shared drop layer (gap 4): P4 notice, P9 magnet,
    //    lifecycle, overlap collection, absorb VFX ──
    this.drops = this._updateDropLayer(this.drops, dt);

    // ── Automatic Phase Shift (P6): feed live danger before gating ──
    this._updatePhaseShiftAutoTrigger(dt);

    // ── Hit response (bullets + bodies), gated by phase/shield ──
    this._handleCollisions();

    // ── Invulnerability blink ───────────────────────────────────
    this._updateInvulnerability(dt);

    // ── Effect timers ───────────────────────────────────────────
    this.effectsRegistry.tick(dt);

    // ── Visuals (shield bubble + phase ghost + bomb notice) ─
    this._updateVisuals();
    this._updatePhaseShiftJuice(dt);

    // ── Shared wave-timeout: detonate survivors, then refresh ──────
    // Runs before wipe/countdown tick so a timeout wipe is observed by
    // the shared lifecycle (AH-0MUNR5LM1004B223).
    this._advanceWaveTimeout(dt);
    this._drawWaveTimeoutBar();
    this._tickRespawnCountdown(dt);

    // ── HUD ─────────────────────────────────────────────────────
    this.hud?.refresh();
  }

  // ── Scout formation lifecycle (AH-0MUNR5LM1004B223) ─────────────

  /**
   * Spawns the small V-formation of scouts at the current formation base.
   * Called on create and after a wave-timeout refresh.
   */
  private _spawnScoutFormation(): void {
    const offsets = buildVFormationOffsets(COMBAT_SCOUT_COUNT);
    for (const offset of offsets) {
      const scout = new Scout(this, {
        x: this.formationBaseX + offset.col * COMBAT_SPACING_X,
        y: this.formationBaseY + offset.row * COMBAT_SPACING_Y,
        formationOffset: offset,
      });
      this.add.existing(scout);
      scout.shootEnabled = this.shootEnabled;
      this.scouts.push(scout);
    }
  }

  /**
   * Opt the combat gym into the shared wave-timeout (AH-0MUNR5LM1004B223).
   * The scouts are a wave of threats, so the same 30 s window the game and
   * the enemy gyms run applies here.
   */
  protected override getWaveTimeoutDuration(): number {
    return WAVE_TIME_LIMIT_SECONDS;
  }

  /**
   * Wave-timeout expiry: survivors are **kept** (the shared helper is a no-op;
   * carry-over parity with `PlayScene`, AH-0MUNS3ZQ1002DJ9S) and the wave
   * refreshes through the shared 3 s countdown.
   */
  protected override onWaveTimeoutExpired(): void {
    this._startRespawnCountdown();
  }

  /**
   * Refreshes the scout wave after the shared countdown elapses: clears stale
   * bullets, keeps the live scouts in place, spawns a fresh V-formation
   * alongside them, then restarts the shared wave-timeout (carry-over parity,
   * AH-0MUNS3ZQ1002DJ9S). A full wipe (no survivors) resets the base, matching
   * the previous clean-slate behaviour.
   */
  protected override respawnWave(): void {
    for (const bullet of this.scoutBullets) bullet.graphics.destroy();
    this.scoutBullets = [];

    // Keep live scouts; drop only the dead ones.
    const survivors = this.scouts.filter((scout) => scout.alive);
    for (const scout of this.scouts) {
      if (!scout.alive) scout.destroy();
    }
    this.scouts = survivors;

    // A clean-slate respawn (ordinary wipe) resets the base; a carry-over
    // refresh keeps the current base so survivors do not jump.
    if (survivors.length === 0) {
      this.formationBaseX = COMBAT_START_X;
      this.formationBaseY = COMBAT_START_Y;
    }

    this._spawnScoutFormation();
    playSpawnSound();
    this.startWaveTimeout();
  }

  // ── Visuals ──────────────────────────────────────────────────────

  private _updateVisuals(): void {
    // Shield bubble: drawn around the ship while P3 is active (shared helper,
    // including the continuous rim pulse and ending fade).
    if (this.shieldBubble) {
      drawShieldBubble(this.shieldBubble, this.player, this.effectsRegistry);
    }
    // Phase ghost: semi-transparent ship while P6 is active (keeps the
    // blink alpha when invulnerable) — shared helper.
    applyPhaseGhost(this.player, this.effectsRegistry, this.invulnerable > 0);
  }

  // ── Spawning / lifecycle ─────────────────────────────────────────

  private _spawnRoundRobin(): void {
    const id = this.roundRobinSpawner.next();
    const pos = SPAWN_POSITIONS[this.spawnIndex % SPAWN_POSITIONS.length];
    this.spawnIndex += 1;
    this._spawnDrop(id, pos.x, pos.y);
  }

  /** Spawns a drop of the given type at a world position (public for tests). */
  spawnDrop(id: PowerUpId, x: number, y: number): CombatActiveDrop {
    return this._spawnDrop(id, x, y);
  }

  private _spawnDrop(id: PowerUpId, x: number, y: number): CombatActiveDrop {
    const graphics = this.add.graphics();
    graphics.setPosition(x, y);
    const entry = getPowerUpById(id);
    drawPowerUpDrop(graphics, entry.type, 0, 0, POWER_UP_DROP_SIZE);
    graphics.setScale(0);
    const drop: CombatActiveDrop = { powerUp: new PowerUp(id), x, y, graphics, dropId: id };
    this.drops.push(drop);
    return drop;
  }

  /**
   * Advances every drop's lifecycle by `dt` seconds through the shared
   * helper. Public test seam.
   */
  advanceDrops(dt: number): void {
    this.drops = this._advanceDropLifecycles(this.drops, dt);
  }

  // ── Scouts / formation ───────────────────────────────────────────

  private _tickFormation(dt: number): void {
    this.formationBaseX += COMBAT_DRIFT_SPEED * dt;
    if (this.formationBaseX > GAME_WIDTH + 80) {
      this.formationBaseX = -COMBAT_SPACING_X * 2 - 40;
    }
    for (const scout of this.scouts) {
      scout.applyFormationPosition(
        this.formationBaseX,
        this.formationBaseY,
        dt,
        COMBAT_SPACING_X,
        COMBAT_SPACING_Y,
      );
      if (this.player) {
        scout.setAimTarget(this.player.x, this.player.y);
      }
    }
  }

  private _tickScouts(): void {
    if (!this.shootEnabled) return;
    // Real scene clock — the same time base the game and the other gyms
    // use (AH-0MUII3BBW000XZ46, AC2). No frame-count accumulator.
    const now = this.time.now;
    for (const scout of this.scouts) {
      if (!scout.alive) continue;
      this.scoutBullets.push(
        ...fireForEnemy<ScoutBullet>(scout, 'scout', now),
      );
    }
  }

  private _advanceEnemyBullets(dt: number): void {
    // Shared projectile lifecycle: four-edge wrap + lifetime expiry, the
    // same helper PlayScene and the formation gym use (AH-0MUII3CF00024EDM,
    // gap 3). The helper keeps the defensive destruction this gym had.
    advanceWrappingBullets(this.scoutBullets, dt, GAME_WIDTH, GAME_HEIGHT);
  }

  // ── Shared combat-core hooks ─────────────────────────────────────

  // Teleports (S/↓) run through the single shared
  // `CombatScene.triggerTeleport` path; the gym supplies only its
  // specifics below. Destination selection, FIFO stack consumption and
  // the P6-on-arrival grant all live in the shared core (gap 7,
  // AH-0MUII3EPU0039R5O). `canTeleport` keeps the shared default
  // (always allowed) — this gym has no opt-in drop layer to gate on.

  /** Enemy hit radius used for teleport destination avoidance (px). */
  protected override getTeleportEnemyHitRadius(): number {
    return ENEMY_HIT_RADIUS;
  }

  /** Enemy-bullet hit radius used for teleport avoidance (px). */
  protected override getTeleportBulletHitRadius(): number {
    return BULLET_HIT_RADIUS;
  }

  /** Combat gym invulnerability window (0.8 s, operator decision Q2-B). */
  protected override getInvulnerabilityDuration(): number {
    return COMBAT_HIT_INVULNERABLE_DURATION;
  }

  /** The scene's P4 bomb notice — shown by the shared collect path (AC3). */
  protected override _getBombNotice(): BombNotice | null {
    return this.bombNotice;
  }

  /** Scouts are persistent threats — ramming does not destroy them. */
  protected override onPlayerRamsEnemy(_enemy: Scout): void {}

  /** Enemy-destruction seam (no-op: the gym never destroys its scouts). */
  protected override onEnemyDestroyed(_enemy: Scout): void {}

  /** Live enemy entities for the shared collision/teleport passes. */
  protected override getEnemyEntities(): readonly Scout[] {
    return this.scouts;
  }

  /** Live enemy bullets for the shared collision/teleport passes. */
  getEnemyBullets(): ScoutBullet[] {
    return this.scoutBullets.slice();
  }

  /** Replaces the enemy-bullet collection after a shared collision pass. */
  protected override setEnemyBullets(bullets: ScoutBullet[]): void {
    this.scoutBullets = bullets;
  }

  // ── Shooting toggle ──────────────────────────────────────────────

  /** Toggles aimed firing for the whole formation. */
  toggleShooting(): void {
    this.shootEnabled = !this.shootEnabled;
    for (const s of this.scouts) s.shootEnabled = this.shootEnabled;
    this.shootButton?.setText(this.shootEnabled ? 'SHOOT: ON' : 'SHOOT: OFF');
  }

  // ── Test accessors for visuals ─────────────────────────────────

  /** Whether the shield bubble is currently visible (for tests). */
  isShieldBubbleVisible(): boolean {
    return this.effectsRegistry.isShielded;
  }
  /** Whether the phase ghost is currently active (for tests). */
  isPhaseGhostActive(): boolean {
    return this.effectsRegistry.isPhased;
  }
  /** Whether the bomb notice is currently visible (for tests). */
  isBombNoticeVisible(): boolean {
    return this.bombNotice?.isVisible() ?? false;
  }
  /** Player explosion VFX graphics (empty once tweens end; for tests). */
  getPlayerExplosions(): Phaser.GameObjects.Graphics[] {
    return this.playerExplosions.slice();
  }

  /** Active composed player-death juice effects (empty once torn down). */
  getPlayerDeathEffects(): Phaser.GameObjects.GameObject[] {
    return this.playerDeathEffects.slice();
  }

  /** Exposes a bullet directly (for tests: place a bullet deterministically). */
  spawnEnemyBullet(x: number, y: number, vx: number, vy: number): ScoutBullet {
    const graphics = this.add.graphics();
    graphics.fillStyle(0xff4444, 1);
    graphics.fillCircle(0, 0, 3);
    graphics.setPosition(x, y);
    const b: ScoutBullet = { graphics, color: 0xff4444, vx, vy, lifetime: 1.5, elapsed: 0 };
    this.scoutBullets.push(b);
    return b;
  }

  // ── Public test accessors ────────────────────────────────────────

  getPlayer(): Player | null { return this.player; }
  getEffectsRegistry(): EffectsRegistry { return this.effectsRegistry; }
  getDrops(): CombatActiveDrop[] { return [...this.drops]; }

  /** In-flight absorb animations for collected drops (test seam). */
  getCollectAnimations(): CollectAnimationHandle[] { return [...this.collectAnimations]; }
  getHud(): HUD | null { return this.hud; }
  getScouts(): Scout[] { return [...this.scouts]; }
  getPlayerHitCount(): number { return this.playerHitCount; }
  isPlayerInvulnerable(): boolean { return this.invulnerable > 0; }
  getPlayerInvulnerableRemaining(): number { return Math.max(0, this.invulnerable); }
  get shootingEnabled(): boolean { return this.shootEnabled; }
  get formationX(): number { return this.formationBaseX; }
  get formationY(): number { return this.formationBaseY; }
  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined { return this.cursors; }
  getWasd(): WasdKeysLike | undefined { return this.wasd; }

  /** The shared help button/overlay handle (AH-0MUAYB67I002REOZ). */
  getHelpHandle(): GymHelpHandle | null { return this.helpHandle; }
}
