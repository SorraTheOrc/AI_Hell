/**
 * Gym scene — non-combat power-ups (P5 Speed Boost, P8 Extra Life,
 * P9 Magnet) with round-robin spawning, grow/hold/shrink lifecycle,
 * overlap collection, and the standalone HUD (parent AC1–AC6).
 *
 * Threat-free: no enemies, no bullets. The player ship flies around
 * collecting drops; each collected drop applies its FULL GDD §4.4
 * behaviour observable without threats:
 *
 * - **P5 Speed Boost** — +50% thrust/max-speed and +50% rate of fire live
 *   for 10 s (refresh on re-collect), applied to the ship via
 *   `Player.setSpeedMultiplier` + `Player.setFireRateMultiplier`.
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

import { CombatCoreScene, type CombatEnemyBullet, type CombatEnemyEntity } from '../core/CombatCoreScene';
import { Player } from '../../entities/Player';
import { HUD } from '../../ui/HUD';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp, PowerUpState } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import { getPowerUpById, PowerUpId } from '../../powerups/types';
import { drawPowerUpDrop, dropCollectRadius } from '../../powerups/icons';
import { applyMagnetAttraction } from '../../powerups/magnet';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';
import {
  playPowerUpCollectPopSound,
  playSpeedBoostCollectSound,
  playExtraLifeCollectSound,
  playMagnetCollectSound,
} from '../../audio/effects';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { addHelpButton, type GymHelpHandle } from '../../utils/gymHelp';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  POWER_UP_SPAWN_INTERVAL,
  SHIP_SIZE,
} from '../../core/constants';

/** Round-robin spawner, ascending by GDD ID (P5 → P8 → P9). */
const NON_COMBAT_ORDER: readonly PowerUpId[] = ['P5', 'P8', 'P9'];

/** Deterministic spawn positions (cycling) — never under the ship start. */
const SPAWN_POSITIONS: readonly { x: number; y: number }[] = [
  { x: 720, y: 135 },
  { x: 240, y: 405 },
  { x: 720, y: 405 },
];

/** A live drop on the field: pure lifecycle + its world position + visuals. */
export interface ActiveDrop {
  /** The drop's lifecycle/state (grow/hold/shrink/collect). */
  powerUp: PowerUp;
  /** World x position. */
  x: number;
  /** World y position. */
  y: number;
  /** Graphics object rendering the drop's glowing bubble + icon (scaled by lifecycle). */
  graphics: Phaser.GameObjects.Graphics;
  /** True once collected and playing its absorb VFX (AC4). */
  absorbing?: boolean;
  /** Unified drop id for the shared collect path. */
  dropId: PowerUpId;
}

/**
 * Non-combat power-ups gym. Extends the narrower shared
 * {@link CombatCoreScene} so drop collection and the input path flow
 * through the one shared implementation; the gym supplies its P5/P8/P9
 * pickup cues through hooks.
 */
export class GymPowerUpsUtility extends CombatCoreScene<
  CombatEnemyEntity,
  CombatEnemyBullet,
  ActiveDrop
> {
  private player: Player | null = null;
  private effectsRegistry = new EffectsRegistry();
  private drops: ActiveDrop[] = [];
  /** Per-scene round-robin spawner (fresh index per scene instance). */
  private roundRobinSpawner = new RoundRobinSpawner(NON_COMBAT_ORDER);
  /** Index into the deterministic spawn positions. */
  private spawnIndex = 0;
  /** Countdown to the next round-robin spawn (starts at 0 → immediate first drop). */
  private spawnTimer = 0;
  private hud: HUD | null = null;
  /** Shared help affordance (AH-0MUAYB67I002REOZ). */
  private helpHandle: GymHelpHandle | null = null;

  constructor() {
    super({ key: 'GymPowerUpsUtility' });
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

    // Shared "← INDEX" button (AC5 of the parent), reused by every gym.
    addBackToIndexButton(this);
    // Shared "Help (?)" button + overlay: lists every drop this gym can
    // spawn, sourced from the shared catalogues (AH-0MUAYB67I002REOZ).
    this.helpHandle = addHelpButton(this, {
      gymKey: 'GymPowerUpsUtility',
      drops: NON_COMBAT_ORDER,
    });
    // ESC key — return to main menu (AH-0MU9LRTK3004KR04).
    addBackToMenuOnEsc(this);

    // Standalone HUD — attaches to this scene, renders above gameplay.
    this.hud = new HUD(this, this.effectsRegistry);

    // Tear down all scene-owned objects on shutdown so a stop/restart of
    // the same instance leaks nothing (AH-0MUII3FYN0072QRT, gap 10).
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.teardownRunState());

    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;
  }

  /**
   * Resets shared per-run state (effects registry + bullet/animation
   * registries via the core) plus this gym's player, drops and spawn
   * timer (AH-0MUII3FYN0072QRT, gap 10).
   */
  protected override resetRunState(): void {
    super.resetRunState();
    this.player = null;
    this.drops = [];
    this.spawnIndex = 0;
    this.spawnTimer = 0;
    this.hud = null;
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
    this.player?.destroy();
    this.player = null;
    this.hud?.destroy();
    this.hud = null;
    this.helpHandle = null;
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
    const input = this._readPlayerInput();
    if (input) {
      this.player.setInput(input);
    }
    // P5 live boost: scale thrust/max-speed each frame.
    this.player.setSpeedMultiplier(this.effectsRegistry.speedMultiplier());
    // P5 live boost: scale fire rate each frame (same 1.5× multiplier).
    this.player.setFireRateMultiplier(this.effectsRegistry.fireRateMultiplier());
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
    // Advance the absorb VFX for collected drops (cosmetic only).
    this._updateCollectAnimations(dt);

    // ── Effect timers ───────────────────────────────────────────
    this.effectsRegistry.tick(dt);

    // ── HUD ─────────────────────────────────────────────────────
    this.hud?.refresh();
  }

  // ── Spawning / lifecycle ─────────────────────────────────────────

  /** Spawns the next round-robin drop (P5 → P8 → P9) at the next position. */
  private _spawnRoundRobin(): void {
    const id = this.roundRobinSpawner.next();
    const pos = SPAWN_POSITIONS[this.spawnIndex % SPAWN_POSITIONS.length];
    this.spawnIndex += 1;
    this._spawnDrop(id, pos.x, pos.y);
  }

  /**
   * Spawns a drop of the given type at a world position. Public so tests
   * can place a drop deterministically under the ship.
   */
  spawnDrop(id: PowerUpId, x: number, y: number): ActiveDrop {
    return this._spawnDrop(id, x, y);
  }

  private _spawnDrop(id: PowerUpId, x: number, y: number): ActiveDrop {
    const graphics = this.add.graphics();
    // Bubble + icon drawn in local space centred at the Graphics' own
    // origin (0,0) so `setScale` grows it about its centre; position the
    // Graphics at the drop's world position.
    graphics.setPosition(x, y);
    const entry = getPowerUpById(id);
    drawPowerUpDrop(graphics, entry.type, 0, 0, POWER_UP_DROP_SIZE);
    // Start at scale 0 — the lifecycle grows it in.
    graphics.setScale(0);

    const drop: ActiveDrop = { powerUp: new PowerUp(id), x, y, graphics, dropId: id };
    this.drops.push(drop);
    return drop;
  }

  /** Advances every drop's lifecycle by `dt` seconds (grow/hold/shrink). */
  advanceDrops(dt: number): void {
    const kept: ActiveDrop[] = [];
    for (const drop of this.drops) {
      // An absorbing drop is owned by its animation — never re-process it.
      if (drop.absorbing) continue;
      drop.powerUp.advance(dt);
      // Bubble + icon scale tracks the lifecycle scale factor (0 → 1 → 0).
      drop.graphics.setScale(drop.powerUp.currentScale);
      if (drop.powerUp.state !== PowerUpState.DESPAWNED) {
        kept.push(drop);
      } else {
        // Fully despawned — remove the drop's visuals from the display list.
        drop.graphics.destroy();
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
    applyMagnetAttraction(this.drops, this.player, stacks, dt);
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
      if (!drop.absorbing && drop.powerUp.canCollect() && this._overlapsShip(drop, hull)) {
        this._collectDrop(drop);
      } else {
        kept.push(drop);
      }
    }
    this.drops = kept;
  }

  private _overlapsShip(drop: ActiveDrop, hull: number): boolean {
    if (!this.player) return false;
    const dropRadius = dropCollectRadius(POWER_UP_DROP_SIZE, drop.powerUp.currentScale);
    const dist = Math.hypot(this.player.x - drop.x, this.player.y - drop.y);
    return dist <= hull + dropRadius;
  }

  // ── Shared collect-path hooks (AC2) ──────────────────────────────

  /**
   * Non-combat pickup activation audio: each pickup type plays its own
   * unique activation sound on collection (the shared path has already
   * applied the effect). Safe no-op without an AudioContext.
   */
  protected override onPowerUpCollected(drop: ActiveDrop): void {
    try {
      switch (drop.dropId) {
        case 'P5':
          playSpeedBoostCollectSound();
          break;
        case 'P8':
          playExtraLifeCollectSound();
          break;
        case 'P9':
          playMagnetCollectSound();
          break;
      }
    } catch {
      // Audio is best-effort (headless tests have no AudioContext).
    }
  }

  /** Generic collection pop, played alongside the per-type pickup cue. */
  protected override _playPickupCue(_drop: ActiveDrop): void {
    try {
      playPowerUpCollectPopSound();
    } catch {
      // Audio is best-effort (headless tests have no AudioContext).
    }
  }

  // ── Public test accessors ─────────────────────────────────────────

  getPlayer(): Player | null {
    return this.player;
  }

  /** Arrow-key bindings for the player (undefined when no keyboard). */
  getCursors(): Phaser.Types.Input.Keyboard.CursorKeys | undefined {
    return this.cursors;
  }

  /** WASD bindings for the player (undefined when no keyboard). */
  getWasd(): WasdKeysLike | undefined {
    return this.wasd;
  }

  getEffectsRegistry(): EffectsRegistry {
    return this.effectsRegistry;
  }

  getDrops(): ActiveDrop[] {
    return [...this.drops];
  }

  /** In-flight absorb animations for collected drops (test seam). */
  getCollectAnimations(): CollectAnimationHandle[] {
    return [...this.collectAnimations];
  }

  getHud(): HUD | null {
    return this.hud;
  }

  /** The shared help button/overlay handle (AH-0MUAYB67I002REOZ). */
  getHelpHandle(): GymHelpHandle | null {
    return this.helpHandle;
  }
}