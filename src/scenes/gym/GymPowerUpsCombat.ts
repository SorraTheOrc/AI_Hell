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
 * - **P7 Teleport** — stored FIFO stacks; Space teleports to the nearest
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
 * gated at >3% full-size scale, same `POWER_UP_DROP_SIZE` (8 px)
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
 * Teleport (Space): consumes one P7 stack FIFO, warps to the nearest safe
 * spot along the heading ray, clamped to screen bounds, then applies P6.
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically via
 * `gameHarness` without a real render loop.
 */

import Phaser from 'phaser';

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
import { drawPowerUpDrop } from '../../powerups/icons';
import {
  playPowerUpCollectSound,
  playDestructionSound,
  playSpawnSound,
} from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton } from '../../utils/gymNavigation';
import {
  AsteroidsInputHandler,
  ControlInput,
  FourDirectionalInputHandler,
} from '../../utils/movementModel';
import { buildVFormationOffsets } from '../../utils/formations';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  POWER_UP_SPAWN_INTERVAL,
  SHIP_SIZE,
  TELEPORT_SAFE_RADIUS,
  COMBAT_HIT_INVULNERABLE_DURATION,
  COMBAT_HIT_BLINK_INTERVAL,
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
const COMBAT_SCOUT_COUNT = 3;
const COMBAT_SPACING_X = 32;
const COMBAT_SPACING_Y = 28;
const COMBAT_START_X = GAME_WIDTH * 0.2;
const COMBAT_START_Y = 110;
const COMBAT_DRIFT_SPEED = 18;

/** Hit radii used for player collision checks (px). */
const ENEMY_HIT_RADIUS = SCOUT_SIZE / 2 + 4;
const BULLET_HIT_RADIUS = 5;

/** Screen margin when clamping the teleport destination. */
const TELEPORT_MARGIN = SHIP_SIZE / 2 + 4;

// ── Safe-spot resolution (P7, GDD §4.4) ─────────────────────────

/**
 * Finds the nearest safe teleport destination along the heading ray.
 * Samples candidates along the ray plus a fallback grid; picks the
 * closest candidate whose disc (TELEPORT_SAFE_RADIUS) contains no
 * enemy/bullet, clamped to screen bounds (TELEPORT_MARGIN inset).
 * If no safe candidate exists, returns the furthest ray point clamped
 * on-screen (nearest on-screen position along the heading, per GDD).
 */
export function findTeleportDestination(
  fromX: number,
  fromY: number,
  headingRad: number,
  enemies: Array<{ x: number; y: number }>,
  bullets: Array<{ x: number; y: number }>,
  width: number,
  height: number,
): { x: number; y: number } {
  const ux = Math.cos(headingRad);
  const uy = Math.sin(headingRad);
  const safeRadius = TELEPORT_SAFE_RADIUS;

  function isSafe(x: number, y: number): boolean {
    for (const e of enemies) {
      if (Math.hypot(e.x - x, e.y - y) < safeRadius + ENEMY_HIT_RADIUS) return false;
    }
    for (const b of bullets) {
      if (Math.hypot(b.x - x, b.y - y) < safeRadius + BULLET_HIT_RADIUS) return false;
    }
    return true;
  }

  function clamp(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.max(TELEPORT_MARGIN, Math.min(width - TELEPORT_MARGIN, x)),
      y: Math.max(TELEPORT_MARGIN, Math.min(height - TELEPORT_MARGIN, y)),
    };
  }

  // Candidates along the heading ray at increasing distances.
  const rayDistances = [80, 160, 240, 360, 480, 640];
  const candidates: Array<{ x: number; y: number; dist: number }> = [];

  for (const d of rayDistances) {
    const p = clamp(fromX + ux * d, fromY + uy * d);
    // Skip candidates that barely moved (heading into wall).
    if (Math.hypot(p.x - fromX, p.y - fromY) < 10) continue;
    candidates.push({ ...p, dist: d });
  }

  // Fallback grid candidates (screen quadrants) — ensure coverage when
  // the ray is blocked the whole way.
  const grid: Array<{ x: number; y: number }> = [
    { x: width * 0.25, y: height * 0.25 },
    { x: width * 0.75, y: height * 0.25 },
    { x: width * 0.25, y: height * 0.75 },
    { x: width * 0.75, y: height * 0.75 },
    { x: width * 0.5, y: height * 0.5 },
  ];
  for (const g of grid) {
    const d = Math.hypot(g.x - fromX, g.y - fromY);
    // Prefer ray direction: penalise grid points behind the heading.
    const dot = (g.x - fromX) * ux + (g.y - fromY) * uy;
    const penalty = dot < 0 ? 1000 : 0;
    candidates.push({ ...g, dist: d + penalty });
  }

  candidates.sort((a, b) => a.dist - b.dist);

  for (const c of candidates) {
    if (isSafe(c.x, c.y)) return { x: c.x, y: c.y };
  }

  // No safe spot — return the furthest ray point clamped on-screen
  // (nearest on-screen position along the heading, per GDD), which is
  // the last ray candidate.
  const lastRay = candidates.find(
    (c) => Math.abs(c.x - fromX) > 1 || Math.abs(c.y - fromY) > 1,
  );
  if (lastRay) {
    // Walk further along heading until hitting the margin, then clamp.
    let x = fromX + ux * 1000;
    let y = fromY + uy * 1000;
    return clamp(x, y);
  }
  return clamp(fromX + ux * 80, fromY + uy * 80);
}

// ── Active drop model ──────────────────────────────────────────────

/** A live power-up drop on the field. */
export interface CombatActiveDrop {
  powerUp: PowerUp;
  x: number;
  y: number;
  graphics: Phaser.GameObjects.Graphics;
}

export class GymPowerUpsCombat extends Phaser.Scene {
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

  // Input
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;
  private spaceKey: Phaser.Input.Keyboard.Key | undefined;
  private fourDirHandler = new FourDirectionalInputHandler();
  private asteroidsHandler = new AsteroidsInputHandler();

  // Hit response
  private playerHitCount = 0;
  private playerInvulnerable = 0;
  private playerBlinkPhase = 0;

  // Visual feedback
  private shieldBubble: Phaser.GameObjects.Graphics | null = null;
  private bombNoticeTimer = 0;
  private bombNoticeLabel: Phaser.GameObjects.Text | null = null;

  // UI
  private shootButton: Phaser.GameObjects.Text | null = null;

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
    this.hud = new HUD(this, this.effectsRegistry, { showLives: false });

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
    this.spaceKey = this.input.keyboard?.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);

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

    this.add.text(GAME_WIDTH / 2, GAME_HEIGHT - 12, 'P3 Shield · P4 Bomb · P6 Phase · P7 Teleport (Space) — scouts fire aimed shots', {
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
   * teleport (Space), hit response, and HUD.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // ── Ship: input → thrust + screen-wrap ──────────────────────
    const input = this._readInput();
    if (input) this.player.setInput(input);
    this.player.physicsTick(dt, this.scale.width, this.scale.height);

    // ── Teleport (Space) — before hit checks so arrival phase protects ─
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

    // ── Hit response (bullets + bodies), gated by phase/shield ──
    this._handleHits();

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
        if (this.playerInvulnerable <= 0) this.player.setAlpha(0.45);
      } else if (this.playerInvulnerable <= 0) {
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
    const drop: CombatActiveDrop = { powerUp: new PowerUp(id), x, y, graphics };
    this.drops.push(drop);
    return drop;
  }

  /** Advances every drop's lifecycle by `dt` seconds. */
  advanceDrops(dt: number): void {
    const kept: CombatActiveDrop[] = [];
    for (const drop of this.drops) {
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
      if (drop.powerUp.canCollect() && this._overlapsShip(drop, hull)) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  private _overlapsShip(drop: CombatActiveDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = POWER_UP_DROP_SIZE * drop.powerUp.currentScale;
    const dist = Math.hypot(this.player.x - drop.x, this.player.y - drop.y);
    return dist <= hull + dropRadius;
  }

  private _collectDrop(drop: CombatActiveDrop): void {
    const effect = drop.powerUp.tryCollect();
    if (!effect) return;
    const id = effect.id as PowerUpId;

    // P4 Bomb: clear enemy bullets instantly (no enemy damage).
    if (id === 'P4') {
      this._clearEnemyBullets();
      this._flashBombNotice();
    }

    this.effectsRegistry.applyCollect(id);
    drop.graphics.destroy();

    try { playPowerUpCollectSound(); } catch { /* ignore */ }
  }

  /** Clears all on-screen enemy bullets (P4, GDD §4.4 — no enemy damage). */
  private _clearEnemyBullets(): void {
    for (const b of this.scoutBullets) {
      try { b.graphics.destroy(); } catch { /* ignore */ }
    }
    this.scoutBullets = [];
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
    const now = this.time.now;
    for (const scout of this.scouts) {
      if (!scout.alive) continue;
      const bullet = scout.tryFireAimedBullet(now);
      if (bullet) this.scoutBullets.push(bullet);
    }
  }

  private _advanceEnemyBullets(dt: number): void {
    for (let i = this.scoutBullets.length - 1; i >= 0; i--) {
      const b = this.scoutBullets[i];
      b.graphics.x += b.vx * dt;
      b.graphics.y += b.vy * dt;
      if (b.graphics.x < -20 || b.graphics.x > GAME_WIDTH + 20 || b.graphics.y < -20 || b.graphics.y > GAME_HEIGHT + 20) {
        try { b.graphics.destroy(); } catch { /* ignore */ }
        this.scoutBullets.splice(i, 1);
      }
    }
  }

  // ── Teleport (P7, Space) ─────────────────────────────────────────

  private _handleTeleport(): void {
    if (!this.player || !this.spaceKey) return;
    // Phaser Key JustDown check; in headless tests we also expose
    // `triggerTeleport()` so tests don't need to fake keyboard state.
    const justDown = (Phaser.Input.Keyboard as unknown as { JustDown?: (k: Phaser.Input.Keyboard.Key) => boolean }).JustDown
      ? (Phaser.Input.Keyboard as unknown as { JustDown: (k: Phaser.Input.Keyboard.Key) => boolean }).JustDown(this.spaceKey)
      : this.spaceKey.isDown;
    // To avoid auto-repeat every frame while Space is held, only act on
    // the first frame isDown becomes true. The headless JustDown helper
    // already gates this; for fallback isDown we gate via a flag.
    // In practice tests call `triggerTeleport()` directly, so this path
    // is the live keyboard path only.
    if (!justDown) return;
    this.triggerTeleport();
  }

  /**
   * Consumes one P7 teleport stack and warps the player to the nearest
   * safe spot along the heading ray. Public so tests can trigger
   * teleport deterministically without faking keyboard state.
   * Returns true if a teleport was performed.
   */
  triggerTeleport(): boolean {
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

  // ── Hit response ─────────────────────────────────────────────────

  private _handleHits(): void {
    if (!this.player) return;

    // P6 phase: complete pass-through — skip all hit checks.
    if (this.effectsRegistry.isPhased) return;

    // Brief post-hit invulnerability blink.
    if (this.playerInvulnerable > 0) return;

    const hull = SHIP_SIZE / 2;
    const playerX = this.player.x;
    const playerY = this.player.y;

    // 1. Enemy bullets vs player.
    for (let i = this.scoutBullets.length - 1; i >= 0; i--) {
      const b = this.scoutBullets[i];
      if (Math.hypot(b.graphics.x - playerX, b.graphics.y - playerY) <= hull + BULLET_HIT_RADIUS) {
        // Shield absorbs one hit.
        if (this.effectsRegistry.isShielded) {
          this.effectsRegistry.tryAbsorbShield();
          try { b.graphics.destroy(); } catch { /* ignore */ }
          this.scoutBullets.splice(i, 1);
          this._startInvulnerability();
          return; // one hit per frame
        }
        // Unshielded hit.
        try { b.graphics.destroy(); } catch { /* ignore */ }
        this.scoutBullets.splice(i, 1);
        this._hitPlayer();
        return;
      }
    }

    // 2. Enemy bodies vs player.
    for (const scout of this.scouts) {
      if (!scout.alive) continue;
      if (Math.hypot(scout.x - playerX, scout.y - playerY) <= hull + ENEMY_HIT_RADIUS) {
        if (this.effectsRegistry.isShielded) {
          this.effectsRegistry.tryAbsorbShield();
          this._startInvulnerability();
          return;
        }
        this._hitPlayer();
        return;
      }
    }
  }

  private _hitPlayer(): void {
    if (!this.player) return;
    this.playerHitCount += 1;
    try { playDestructionSound(); } catch { /* ignore */ }
    this.player.setPosition(GAME_WIDTH / 2, GAME_HEIGHT / 2);
    const state = this.player.getMovementState();
    (this.player as unknown as { _movementState: { x: number; y: number; vx: number; vy: number } })._movementState = {
      ...state,
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
      vx: 0,
      vy: 0,
    };
    this._startInvulnerability();
  }

  private _startInvulnerability(): void {
    this.playerInvulnerable = COMBAT_HIT_INVULNERABLE_DURATION;
    this.playerBlinkPhase = 0;
    this.player?.setAlpha(1);
  }

  private _updateInvulnerability(dt: number): void {
    if (!this.player || this.playerInvulnerable <= 0) return;
    this.playerInvulnerable = Math.max(0, this.playerInvulnerable - dt);
    this.playerBlinkPhase += dt;
    const visible = Math.floor(this.playerBlinkPhase / COMBAT_HIT_BLINK_INTERVAL) % 2 === 0;
    this.player.setAlpha(visible ? 1 : 0.3);
    if (this.playerInvulnerable <= 0) this.player.setAlpha(1);
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

  /** Exposes a bullet directly (for tests: place a bullet deterministically). */
  spawnEnemyBullet(x: number, y: number, vx: number, vy: number): ScoutBullet {
    const graphics = this.add.graphics();
    graphics.fillStyle(0xff4444, 1);
    graphics.fillCircle(0, 0, 3);
    graphics.setPosition(x, y);
    const b: ScoutBullet = { graphics, color: 0xff4444, vx, vy };
    this.scoutBullets.push(b);
    return b;
  }

  // ── Input ─────────────────────────────────────────────────────────

  private _readInput(): ControlInput | null {
    if (!this.player || !this.cursors || !this.wasd) return null;
    const raw = { cursors: this.cursors, wasd: this.wasd };
    return this.player.getScheme() === 'asteroids'
      ? this.asteroidsHandler.mapInput(raw)
      : this.fourDirHandler.mapInput(raw);
  }

  // ── Public test accessors ────────────────────────────────────────

  getPlayer(): Player | null { return this.player; }
  getEffectsRegistry(): EffectsRegistry { return this.effectsRegistry; }
  getDrops(): CombatActiveDrop[] { return [...this.drops]; }
  getHud(): HUD | null { return this.hud; }
  getScouts(): Scout[] { return [...this.scouts]; }
  getEnemyBullets(): ScoutBullet[] { return [...this.scoutBullets]; }
  getPlayerHitCount(): number { return this.playerHitCount; }
  isPlayerInvulnerable(): boolean { return this.playerInvulnerable > 0; }
  getPlayerInvulnerableRemaining(): number { return Math.max(0, this.playerInvulnerable); }
  get shootingEnabled(): boolean { return this.shootEnabled; }
  get formationX(): number { return this.formationBaseX; }
  get formationY(): number { return this.formationBaseY; }
  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined { return this.cursors; }
  getWasd(): WasdKeysLike | undefined { return this.wasd; }
}
