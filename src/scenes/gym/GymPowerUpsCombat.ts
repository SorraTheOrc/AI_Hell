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
 * - **P6 Phase Shift** — 3 s intangibility, pass-through enemies/bullets.
 * - **P7 Teleport** — stored FIFO stacks; S or ↓ teleports to the nearest
 *   safe spot free of enemies/bullets in the direction of travel,
 *   clamped to screen bounds; grants P6 (3 s) on arrival. If no safe
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
 * Teleport (S/↓): consumes one P7 stack FIFO, warps to the nearest safe
 * spot along the heading ray, clamped to screen bounds, then applies P6.
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically via
 * `gameHarness` without a real render loop.
 */

import Phaser from 'phaser';

import { CombatScene } from '../core/CombatScene';
import { Player } from '../../entities/Player';
import { Scout, ScoutBullet, SCOUT_SIZE } from '../../entities/Scout';
import { HUD } from '../../ui/HUD';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import {
  PowerUpId,
  COMBAT_POWER_UP_IDS,
  getPowerUpById,
} from '../../powerups/types';
import { drawPowerUpDrop, dropCollectRadius } from '../../powerups/icons';
import { findTeleportDestination } from '../../powerups/teleport';
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
  SHIP_SIZE,
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

/** Hit radii used for player collision checks (px). */
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
  private bombNoticeTimer = 0;
  private bombNoticeLabel: Phaser.GameObjects.Text | null = null;

  // UI
  private shootButton: Phaser.GameObjects.Text | null = null;
  /** Shared help affordance (AH-0MUAYB67I002REOZ). */
  private helpHandle: GymHelpHandle | null = null;

  constructor() {
    super({ key: 'GymPowerUpsCombat' });
  }

  create(): void {
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

    // Clean up on shutdown to prevent stale references on restart.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      for (const exp of this.playerExplosions) exp.destroy();
      this.playerExplosions.length = 0;
      // Composed player-death juice registry (flash/debris/shockwave/particles)
      // must not survive a stop/restart (parent AH-0MUAYB4R3002ZIZY AC6).
      for (const effect of this.playerDeathEffects) effect.destroy();
      this.playerDeathEffects.length = 0;
      // Release any in-flight absorb animations on shutdown/restart.
      for (const anim of this.collectAnimations) anim.destroy();
      this.collectAnimations = [];
    });

    this.shieldBubble = this.add.graphics();
    this.shieldBubble.setDepth(50);
    this.bombNoticeLabel = this.add.text(GAME_WIDTH / 2, 24, '', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#ff4444',
      backgroundColor: '#1a1a1a',
      padding: { x: 6, y: 2 },
    }).setOrigin(0.5).setVisible(false);

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as WasdKeysLike | undefined;
    this.teleportKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.S) ?? null;
    this.downKey =
      this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN) ?? null;

    // Spawn the small scout formation.
    const offsets = buildVFormationOffsets(COMBAT_SCOUT_COUNT);
    for (const offset of offsets) {
      const scout = new Scout(this, {
        x: this.formationBaseX + offset.col * COMBAT_SPACING_X,
        y: this.formationBaseY + offset.row * COMBAT_SPACING_Y,
        formationOffset: offset,
      });
      this.add.existing(scout);
      scout.shootEnabled = true;
      this.scouts.push(scout);
    }
    playSpawnSound();
    this.shootEnabled = true;

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

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds). Drives ship movement,
   * formation drift, scout aim + firing, bullet lifecycle, spawner,
   * drop lifecycles, collection (with P4 bomb), effect timers,
   * teleport (S/↓), hit response, and HUD.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // ── Ship: input → thrust + screen-wrap ──────────────────────
    const input = this._readPlayerInput();
    if (input) this.player.setInput(input);
    this.player.physicsTick(dt, this.scale.width, this.scale.height);

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

    // ── Drop lifecycles ─────────────────────────────────────────
    this.advanceDrops(dt);

    // ── Overlap collection ──────────────────────────────────────
    this._collectOverlapping();
    // Advance the absorb VFX for collected drops (cosmetic only).
    this._updateCollectAnimations(dt);

    // ── Hit response (bullets + bodies), gated by phase/shield ──
    this._handleCollisions();

    // ── Invulnerability blink ───────────────────────────────────
    this._updateInvulnerability(dt);

    // ── Effect timers ───────────────────────────────────────────
    this.effectsRegistry.tick(dt);

    // ── Visuals (shield bubble + phase ghost + bomb notice) ─
    this._updateVisuals(dt);

    // ── HUD ─────────────────────────────────────────────────────
    this.hud?.refresh();
  }

  // ── Visuals ──────────────────────────────────────────────────────

  private _updateVisuals(dt: number): void {
    // Shield bubble: drawn around the ship while P3 is active.
    if (this.shieldBubble && this.player) {
      this.shieldBubble.clear();
      if (this.effectsRegistry.isShielded) {
        this.shieldBubble.lineStyle(2, 0x3399ff, 0.9);
        this.shieldBubble.strokeCircle(this.player.x, this.player.y, SHIP_SIZE * 1.6);
        this.shieldBubble.fillStyle(0x3399ff, 0.12);
        this.shieldBubble.fillCircle(this.player.x, this.player.y, SHIP_SIZE * 1.6);
      }
    }
    // Phase ghost: semi-transparent ship while P6 is active.
    if (this.player) {
      if (this.effectsRegistry.isPhased) {
        // Ghost outline — keep blink alpha if invulnerable, else ghost alpha.
        if (this.invulnerable <= 0) this.player.setAlpha(0.45);
      } else if (this.invulnerable <= 0) {
        this.player.setAlpha(1);
      }
    }
    // Bomb notice: brief centered flash after P4.
    if (this.bombNoticeTimer > 0) {
      this.bombNoticeTimer = Math.max(0, this.bombNoticeTimer - dt);
      if (this.bombNoticeTimer <= 0) this.bombNoticeLabel?.setVisible(false);
    }
  }

  private _flashBombNotice(): void {
    this.bombNoticeTimer = 1.2;
    this.bombNoticeLabel?.setText('BOMB! Bullets cleared').setVisible(true);
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

  /** Advances every drop's lifecycle by `dt` seconds. */
  advanceDrops(dt: number): void {
    const kept: CombatActiveDrop[] = [];
    for (const drop of this.drops) {
      // An absorbing drop is owned by its animation — never re-process it.
      if (drop.absorbing) continue;
      drop.powerUp.advance(dt);
      drop.graphics.setScale(drop.powerUp.currentScale);
      if (drop.powerUp.state !== PowerUpState.DESPAWNED) {
        kept.push(drop);
      } else {
        drop.graphics.destroy();
      }
    }
    this.drops = kept;
  }

  // ── Collection ───────────────────────────────────────────────────

  private _collectOverlapping(): void {
    if (!this.player) return;
    const hull = SHIP_SIZE / 2;
    const kept: CombatActiveDrop[] = [];
    for (const drop of this.drops) {
      if (!drop.absorbing && drop.powerUp.canCollect() && this._overlapsShip(drop, hull)) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  private _overlapsShip(drop: CombatActiveDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = dropCollectRadius(POWER_UP_DROP_SIZE, drop.powerUp.currentScale);
    const dist = Math.hypot(this.player.x - drop.x, this.player.y - drop.y);
    return dist <= hull + dropRadius;
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

  /** Headless clock for scouts: advances with the deterministic dt. */
  private _nextFireTime = 0;

  private _tickScouts(): void {
    if (!this.shootEnabled) return;
    // Advance the virtual clock by the scene's dt accumulated elsewhere.
    // Use a fixed step that mirrors the test harness tick() cadence so
    // scouts fire deterministically without relying on this.time.now
    // (which is 0 in headless happy-dom).
    this._nextFireTime += 16; // ms — one 60 Hz tick
    const now = this._nextFireTime;
    for (const scout of this.scouts) {
      if (!scout.alive) continue;
      const bullet = scout.tryFireAimedBullet(now);
      if (bullet) this.scoutBullets.push(bullet);
    }
  }

  private _advanceEnemyBullets(dt: number): void {
    for (let i = this.scoutBullets.length - 1; i >= 0; i--) {
      const b = this.scoutBullets[i];
      b.elapsed += dt;
      b.graphics.x += b.vx * dt;
      b.graphics.y += b.vy * dt;
      // Four-edge wrap + lifetime expiry, matching the shipped game
      // (AH-0MU960UTE001PTV0). Bullets are never culled off-screen.
      if (b.graphics.x < 0) b.graphics.x += GAME_WIDTH;
      if (b.graphics.x >= GAME_WIDTH) b.graphics.x -= GAME_WIDTH;
      if (b.graphics.y < 0) b.graphics.y += GAME_HEIGHT;
      if (b.graphics.y >= GAME_HEIGHT) b.graphics.y -= GAME_HEIGHT;
      if (b.elapsed >= b.lifetime) {
        try { b.graphics.destroy(); } catch { /* ignore */ }
        this.scoutBullets.splice(i, 1);
      }
    }
  }

  // ── Teleport (P7, S/↓) ─────────────────────────────────────────

  /**
   * Consumes one P7 teleport stack and warps the player to the nearest
   * safe spot along the heading ray. Public so tests can trigger
   * teleport deterministically without faking keyboard state.
   * Returns true if a teleport was performed.
   */
  override triggerTeleport(): boolean {
    if (!this.player) return false;
    if (!this.effectsRegistry.hasTeleport()) return false;

    const heading = this.player.getHeading();
    const enemies = this.scouts.filter((s) => s.alive).map((s) => ({ x: s.x, y: s.y }));
    const bullets = this.scoutBullets.map((b) => ({ x: b.graphics.x, y: b.graphics.y }));

    const dest = findTeleportDestination(
      this.player.x,
      this.player.y,
      heading,
      enemies,
      bullets,
      this.scale.width,
      this.scale.height,
      { enemyHitRadius: ENEMY_HIT_RADIUS, bulletHitRadius: BULLET_HIT_RADIUS },
    );

    // Consume one stack FIFO and grant P6 phase shift at landing.
    this.effectsRegistry.consumeTeleport();
    this.player.setPosition(dest.x, dest.y);
    // Keep the movement state's position in sync (physicsTick base).
    const state = this.player.getMovementState();
    (this.player as unknown as { _movementState: { x: number; y: number } })._movementState = {
      ...state,
      x: dest.x,
      y: dest.y,
    };
    return true;
  }

  // ── Shared combat-core hooks ─────────────────────────────────────

  /** Combat gym invulnerability window (0.8 s, operator decision Q2-B). */
  protected override getInvulnerabilityDuration(): number {
    return COMBAT_HIT_INVULNERABLE_DURATION;
  }

  /** P6 phase shift: complete pass-through while active. */
  protected override isPlayerPhased(): boolean {
    return this.effectsRegistry.isPhased;
  }

  /**
   * P3 shield absorbs one hit: pop the shield and start the shared
   * post-hit invulnerability blink (per the parent risk mitigation).
   *
   * @returns whether the hit was absorbed.
   */
  protected override tryAbsorbPlayerHit(_player: Player): boolean {
    if (!this.effectsRegistry.isShielded) return false;
    this.effectsRegistry.tryAbsorbShield();
    this._startInvulnerability();
    return true;
  }

  /** P4 bomb notice (the shared collect path already cleared bullets). */
  protected override onPowerUpCollected(drop: CombatActiveDrop): void {
    if (drop.dropId === 'P4') this._flashBombNotice();
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
    return this.bombNoticeTimer > 0;
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
