/**
 * Gym scene — non-combat power-ups (P5 Speed Boost, P8 Extra Life,
 * P9 Magnet) with round-robin spawning, grow/hold/shrink lifecycle,
 * overlap collection, and the standalone HUD (parent AC1–AC6).
 *
 * Threat-free: no enemies, no bullets. The player ship flies around
 * collecting drops; each collected drop applies its FULL GDD §4.4
 * behaviour observable without threats:
 *
 * - **P5 Speed Boost** — +50% thrust/max-speed live for 10 s (refresh on
 *   re-collect), applied to the ship via `Player.setSpeedMultiplier`.
 * - **P8 Extra Life** — +1 life immediately (starts 3, cap 5).
 * - **P9 Magnet** — permanent stack (cap 5); drops within
 *   `2× ship size +50%/stack` are pulled toward the ship at
 *   `MAGNET_ATTRACTION_SPEED` (slower than ship max speed).
 *
 * Spawn cadence: one drop every `POWER_UP_SPAWN_INTERVAL` (5 s), cycling
 * P5 → P8 → P9; each drop lives `POWER_UP_LIFECYCLE_TOTAL_LIFETIME` (5 s),
 * so the next spawn coincides with the previous drop's despawn (exactly
 * one drop on screen while nothing is collected).
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically.
 */

import Phaser from 'phaser';

import { Player } from '../../entities/Player';
import { HUD } from '../../ui/HUD';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { PowerUpId } from '../../powerups/types';
import { keysToInput, WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton } from '../../utils/gymNavigation';
import { MovementInput } from '../../utils/movement';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  POWER_UP_SPAWN_INTERVAL,
  SHIP_SIZE,
  MAGNET_ATTRACTION_SPEED,
} from '../../core/constants';

/** Round-robin spawn order, ascending by GDD ID (P5 → P8 → P9). */
const ROUND_ROBIN: readonly PowerUpId[] = ['P5', 'P8', 'P9'];

/** Deterministic spawn positions (cycling) — never under the ship start. */
const SPAWN_POSITIONS: readonly { x: number; y: number }[] = [
  { x: 720, y: 135 },
  { x: 240, y: 405 },
  { x: 720, y: 405 },
];

/** A live drop on the field: pure lifecycle + its world position. */
export interface ActiveDrop {
  /** The drop's lifecycle/state (grow/hold/shrink/collect). */
  powerUp: PowerUp;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
}

export class GymPowerUps extends Phaser.Scene {
  private player: Player | null = null;
  private effectsRegistry = new EffectsRegistry();
  private drops: ActiveDrop[] = [];
  private spawnIndex = 0;
  /** Countdown to the next round-robin spawn (starts at 0 → immediate first drop). */
  private spawnTimer = 0;
  private hud: HUD | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;

  constructor() {
    super({ key: 'GymPowerUps' });
  }

  create(): void {
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);

    // Shared "← INDEX" button (AC5 of the parent), reused by every gym.
    addBackToIndexButton(this);

    // Standalone HUD — attaches to this scene, renders above gameplay.
    this.hud = new HUD(this, this.effectsRegistry);

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;
  }

  /** Phaser per-frame hook — delegates to the deterministic `tick`. */
  update(_time: number, delta: number): void {
    this.tick(delta / 1000);
  }

  /**
   * One deterministic simulation step (seconds). Drives ship movement,
   * the spawner, drop lifecycles, magnet attraction, collection, effect
   * timers, and the HUD — used by the scene loop and by tests.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // ── Ship: input → thrust movement + screen-wrap ─────────────
    const input = this._readInput();
    if (input) {
      this.player.setInput(input);
    }
    // P5 live boost: scale thrust/max-speed each frame.
    this.player.setSpeedMultiplier(this.effectsRegistry.speedMultiplier());
    this.player.physicsTick(dt, this.scale.width, this.scale.height);

    // ── Spawner: one drop per interval, round-robin ─────────────
    if (this.spawnTimer <= 0) {
      this.spawnTimer += POWER_UP_SPAWN_INTERVAL;
      this._spawnRoundRobin();
    } else {
      this.spawnTimer -= dt;
    }

    // ── Drop lifecycles ─────────────────────────────────────────
    this.advanceDrops(dt);

    // ── Magnet attraction (P9) ──────────────────────────────────
    this._applyMagnet(dt);

    // ── Overlap collection (gated by the >3% scale threshold) ──
    this._collectOverlapping();

    // ── Effect timers ───────────────────────────────────────────
    this.effectsRegistry.tick(dt);

    // ── HUD ─────────────────────────────────────────────────────
    this.hud?.refresh();
  }

  // ── Spawning / lifecycle ─────────────────────────────────────────

  /** Spawns the next round-robin drop (P5 → P8 → P9) at the next position. */
  private _spawnRoundRobin(): void {
    const id = ROUND_ROBIN[this.spawnIndex % ROUND_ROBIN.length];
    const pos = SPAWN_POSITIONS[this.spawnIndex % SPAWN_POSITIONS.length];
    this.spawnIndex += 1;
    this.drops.push({ powerUp: new PowerUp(id), x: pos.x, y: pos.y });
  }

  /**
   * Spawns a drop of the given type at a world position. Public so tests
   * can place a drop deterministically under the ship.
   */
  spawnDrop(id: PowerUpId, x: number, y: number): ActiveDrop {
    const drop: ActiveDrop = { powerUp: new PowerUp(id), x, y };
    this.drops.push(drop);
    return drop;
  }

  /** Advances every drop's lifecycle by `dt` seconds (grow/hold/shrink). */
  advanceDrops(dt: number): void {
    const kept: ActiveDrop[] = [];
    for (const drop of this.drops) {
      drop.powerUp.advance(dt);
      if (drop.powerUp.state !== PowerUpState.DESPAWNED) {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  // ── Magnet / collection ──────────────────────────────────────────

  /** P9: pulls collectible drops within range toward the ship. */
  private _applyMagnet(dt: number): void {
    if (!this.player) return;
    const stacks = this.effectsRegistry.magnetStacks();
    if (stacks <= 0) return;

    const radius = this._magnetRadius(stacks);
    for (const drop of this.drops) {
      if (!drop.powerUp.canCollect()) continue;
      const dx = this.player.x - drop.x;
      const dy = this.player.y - drop.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= 0.001 || dist > radius) continue;
      const step = Math.min(MAGNET_ATTRACTION_SPEED * dt, dist);
      drop.x += (dx / dist) * step;
      drop.y += (dy / dist) * step;
    }
  }

  /** Magnet attraction radius: 2× ship size, +50% per stack. */
  private _magnetRadius(stacks: number): number {
    return 2 * SHIP_SIZE * (1 + 0.5 * stacks);
  }

  /**
   * Collects drops overlapping the ship hull when they are above the 3%
   * scale threshold. A collected drop applies its effect exactly once and
   * is removed; an uncollected drop that fades away applies nothing.
   */
  private _collectOverlapping(): void {
    if (!this.player) return;
    const hull = SHIP_SIZE / 2;
    const kept: ActiveDrop[] = [];
    for (const drop of this.drops) {
      if (drop.powerUp.canCollect() && this._overlapsShip(drop, hull)) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  private _overlapsShip(drop: ActiveDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = POWER_UP_DROP_SIZE * drop.powerUp.currentScale;
    const dist = Math.hypot(this.player.x - drop.x, this.player.y - drop.y);
    return dist <= hull + dropRadius;
  }

  /** Applies the drop's effect to the registry; marks it collected. */
  private _collectDrop(drop: ActiveDrop): void {
    const effect = drop.powerUp.tryCollect();
    if (!effect) return;
    this.effectsRegistry.applyCollect(effect.id as PowerUpId);
  }

  // ── Input ─────────────────────────────────────────────────────────

  /** Reads the current held-key state (null when no keyboard available). */
  private _readInput(): MovementInput | null {
    if (!this.cursors || !this.wasd) return null;
    return keysToInput(this.cursors, this.wasd);
  }

  // ── Public test accessors ─────────────────────────────────────────

  getPlayer(): Player | null {
    return this.player;
  }

  getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  getDrops(): ActiveDrop[] {
    return [...this.drops];
  }

  getHud(): HUD | null {
    return this.hud;
  }
}