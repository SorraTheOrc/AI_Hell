/**
 * Gym scene — non-combat power-ups (P5 Speed Boost, P8 Extra Life,
 * P9 Magnet, P10 Mineral Scoop) with round-robin spawning, grow/hold/shrink
 * lifecycle, overlap collection, and the standalone HUD (parent AC1–AC6).
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
 * - **P10 Mineral Scoop** — attracts the gym's live mineral field toward the
 *   ship at the same range/speed curve (timed 15 s as a field pickup,
 *   permanent stacking when chosen as a hold-full reward).
 *
 * Spawn cadence: one drop every `POWER_UP_SPAWN_INTERVAL` (default 12.5 s),
 * cycling P5 → P8 → P9 → P10; each drop lives for the same interval, so the
 * next spawn coincides with the previous drop's despawn (exactly one drop on
 * screen while nothing is collected).
 *
 * The drop lifecycle, collection gate, P9 magnet and per-type pickup cues
 * run through the shared `src/scenes/core/dropLayer.ts` template methods
 * (`_updateDropLayer`, `_advanceDropLifecycles`, `_collectOverlappingDrops`,
 * `_applyDropMagnet`, `_playPickupCue`), so this gym cannot drift from the
 * game; only the round-robin spawn *source* is gym-specific
 * (AH-0MUII3CXX0023H24, gap 4). The P10 mineral attraction runs through the
 * shared `_applyMineralScoop` template method and the shared
 * `collectMinerals` pass, exactly as in `PlayScene` and `GymFormationScene`.
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically.
 */

import Phaser from 'phaser';

import { CombatCoreScene, type CombatEnemyBullet, type CombatEnemyEntity } from '../core/CombatCoreScene';
import { Player } from '../../entities/Player';
import { Mineral } from '../../entities/Mineral';
import { collectMinerals } from '../core/mineralLayer';
import { HUD } from '../../ui/HUD';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { RoundRobinSpawner } from '../../powerups/spawner';
import { getPowerUpById, PowerUpId } from '../../powerups/types';
import { drawPowerUpDrop } from '../../powerups/icons';
import type { CollectAnimationHandle } from '../../powerups/collectAnimation';
import { WasdKeysLike } from '../../utils/input';
import { addBackToIndexButton, addBackToMenuOnEsc } from '../../utils/gymNavigation';
import { addHelpButton, type GymHelpHandle } from '../../utils/gymHelp';
import {
  GAME_HEIGHT,
  GAME_WIDTH,
  POWER_UP_DROP_SIZE,
  POWER_UP_SPAWN_INTERVAL,
} from '../../core/constants';

/** Round-robin spawner, ascending by GDD ID (P5 → P8 → P9 → P10). */
const NON_COMBAT_ORDER: readonly PowerUpId[] = ['P5', 'P8', 'P9', 'P10'];

/** Number of minerals seeded on the gym's demonstration mineral field. */
export const UTILITY_MINERAL_SEED_COUNT = 40;

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
  /** Live mineral field seeded so the P10 scoop is demonstrable (AC5). */
  private minerals: Mineral[] = [];
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

    // Mineral field: seeded so the P10 Mineral Scoop runs the same shared
    // attraction + collection pass as the game and the formation gyms (AC5).
    this._seedMinerals(UTILITY_MINERAL_SEED_COUNT);

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
    this.minerals = [];
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
    for (const mineral of this.minerals) mineral.destroy();
    this.minerals = [];
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
   * This gym demonstrates non-combat power-ups only: it has no weapon
   * drops and its player must not fire, so the shared step's auto-fire
   * resolves to a no-op (AH-0MUII39KX007YUQ0, AC1).
   */
  protected override autoFireEnabled(): boolean {
    return false;
  }

  /**
   * One deterministic simulation step (seconds). Drives ship movement,
   * the spawner, drop lifecycles, magnet attraction, collection, effect
   * timers, and the HUD — used by the scene loop and by tests.
   */
  tick(dt: number): void {
    if (!this.player) return;

    // ── Shared player-control step: timers → multipliers → input →
    // physics → auto-fire (AH-0MUII39KX007YUQ0, AC1). The P5 multipliers
    // land here so the boost is live on this frame.
    this._tickPlayer(dt);

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

    // ── Mineral field: P10 scoop attraction then shared collection ──
    // Same order and same helpers as PlayScene and GymFormationScene, so an
    // enabled scoop behaves identically here (AC4/AC5).
    if (this.minerals.length > 0) {
      this._applyMineralScoop(this.minerals, dt);
      this.minerals = collectMinerals(
        this.minerals,
        this.player,
        [],
        () => {},
        { playerPhased: this.isPlayerPhased() },
      );
    }

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

  /**
   * Advances every drop's lifecycle by `dt` seconds through the shared
   * helper (grow/hold/shrink). Public test seam.
   */
  advanceDrops(dt: number): void {
    this.drops = this._advanceDropLifecycles(this.drops, dt);
  }

  /**
   * Seeds `count` minerals scattered across the play area, away from the
   * ship's start position, so the P10 scoop has a field to attract.
   */
  private _seedMinerals(count: number): void {
    for (let i = 0; i < count; i++) {
      const x = 20 + Math.random() * (GAME_WIDTH - 40);
      const y = 20 + Math.random() * (GAME_HEIGHT - 120);
      this.minerals.push(new Mineral(this, { x, y }));
    }
  }

  /** Places a mineral at an exact position (public test/demo seam). */
  spawnMineral(x: number, y: number): Mineral {
    const mineral = new Mineral(this, { x, y });
    this.minerals.push(mineral);
    return mineral;
  }

  /** Live minerals on the gym's demonstration field. */
  getMinerals(): Mineral[] {
    return [...this.minerals];
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