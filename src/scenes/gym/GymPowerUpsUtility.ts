/**
 * Gym scene — non-combat power-ups (Speed Boost, Extra Life,
 * Magnet, Mineral Scoop) with round-robin spawning, grow/hold/shrink
 * lifecycle, overlap collection, and the standalone HUD (parent AC1–AC6).
 *
 * Threat-free: no enemies, no bullets. The player ship flies around
 * collecting drops; each collected drop applies its FULL GDD §4.4
 * behaviour observable without threats:
 *
 * - **Speed Boost** — +50% thrust/max-speed and +50% rate of fire live
 *   for 10 s (refresh on re-collect), applied to the ship via
 *   `Player.setSpeedMultiplier` + `Player.setFireRateMultiplier`.
 * - **Extra Life** — +1 life immediately (starts 3, cap 5).
 * - **Magnet** — drops within `1× ship size +50%/stack` are pulled
 *   toward the ship at `MAGNET_ATTRACTION_SPEED` (slower than ship max
 *   speed); a timed 15 s field pickup (refresh-only) or a permanent
 *   stacking upgrade (cap 5).
 * - **Mineral Scoop** — attracts the gym's live mineral field toward the
 *   ship at the same range/speed curve (timed 15 s as a field pickup,
 *   permanent stacking when chosen as a hold-full reward).
 *
 * Spawn cadence: one drop every `POWER_UP_SPAWN_INTERVAL` (default 12.5 s),
 * cycling Speed Boost → Extra Life → Magnet → Mineral Scoop; each drop lives for the same interval, so the
 * next spawn coincides with the previous drop's despawn (exactly one drop on
 * screen while nothing is collected).
 *
 * The drop lifecycle, collection gate, Magnet magnet and per-type pickup cues
 * run through the shared `src/scenes/core/dropLayer.ts` template methods
 * (`_updateDropLayer`, `_advanceDropLifecycles`, `_collectOverlappingDrops`,
 * `_applyDropMagnet`, `_playPickupCue`), so this gym cannot drift from the
 * game; only the round-robin spawn *source* is gym-specific
 * (AH-0MUII3CXX0023H24, gap 4). The Mineral Scoop mineral attraction runs through the
 * shared `_applyMineralScoop` template method and the shared
 * `collectMinerals` pass, exactly as in `PlayScene` and `GymFormationScene`.
 *
 * All per-frame logic lives in the public `tick(dt)` method (called by
 * Phaser's `update`), so tests can drive the scene deterministically.
 *
 * Scripted-scene setup (AH-0MVRMHYJR000Y9H8): the scene consumes the shared
 * `applySceneSetup` applier through `_adoptCaptureSetup`, so a capture setup's
 * player loadout, power-up levels and determinism seed are live before the
 * first captured frame. The seed drives the demonstration mineral field, so a
 * scripted capture's mineral layout is reproducible. The round-robin drop
 * cadence and mineral count stay fixed gym-only scenarios (documented in
 * `docs/GYM_PARITY.md` and `docs/dev/gameplay-capture.md`).
 */

import Phaser from 'phaser';

import { CombatCoreScene, type CombatEnemyBullet, type CombatEnemyEntity } from '../core/CombatCoreScene';
import type { SceneSetupState } from '../core/sceneSetup';
import { Player } from '../../entities/Player';
import { Mineral } from '../../entities/Mineral';
import { collectMinerals } from '../core/mineralLayer';
import type { DroneMineralSink } from '../core/combatDrone';
import { MineralHold } from '../../core/mineralHold';
import { HUD } from '../../ui/HUD';
import { combatHudOptions } from '../core/hudWiring';
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

/** Round-robin spawner, ascending by GDD ID (Speed Boost → Extra Life → Magnet → Mineral Scoop → Mystery UFO). */
const NON_COMBAT_ORDER: readonly PowerUpId[] = [
  'speed_boost',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'mystery_ufo',
];

/** Number of minerals seeded on the gym's demonstration mineral field. */
export const UTILITY_MINERAL_SEED_COUNT = 40;

/**
 * Clearance radius, in pixels, that seeded minerals keep away from the
 * ship's start position. Well above the pickup threshold
 * (`MINERAL_SIZE + SHIP_SIZE/2` = 15 px) so a mineral is never silently
 * collected the moment the gym opens, and below the nearest play-area edge
 * from the centre (150 px) so a radially-pushed sample stays in bounds.
 */
export const MINERAL_SEED_CLEARANCE = 60;

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
 * through the one shared implementation; the gym supplies its Speed Boost/Extra Life/Magnet
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
  /** Live mineral field seeded so the Mineral Scoop scoop is demonstrable (AC5). */
  private minerals: Mineral[] = [];
  /**
   * Run-scoped ship's hold, shared with the game. Collecting minerals fills it
   * and the Mystery UFO collector drone pays its ferried minerals into it, so
   * the hold progression shown by the HUD is the same model the game uses
   * (AH-0MV9G113S009B37I).
   */
  private mineralHold = new MineralHold();
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

  create(data?: SceneSetupState): void {
    // Reset shared + scene-owned per-run state so a stop/restart of the
    // same instance starts clean (AH-0MUII3FYN0072QRT, gap 10).
    this.resetRunState();
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });
    this.add.existing(this.player);

    // Scripted-scene setup (AH-0MVRMHYJR000Y9H8): loadout, power-up levels
    // and the content seed are applied before the mineral field is seeded
    // below, so a seeded capture reproduces the same field. No setup ⇒ no
    // behaviour change.
    this._adoptCaptureSetup(data);

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

    // Standalone HUD — attaches to this scene, renders above gameplay. One
    // shared wiring supplies the weapon levels and the six-slot budget
    // (AH-0MVVJRRN10038VFR AC4).
    this.hud = new HUD(
      this,
      this.effectsRegistry,
      combatHudOptions(() => this.player),
    );
    // Show the shared mineral hold bar so the Mystery UFO collector drone and
    // mineral pickups are observable here (AH-0MV9G113S009B37I).
    this._syncMineralHud();

    // Mineral field: seeded so the Mineral Scoop runs the same shared
    // attraction + collection pass as the game and the formation gyms (AC5).
    // Scenario parameter (AH-0MVRMI0Q7001KG4Y): a capture setup may resize
    // the field (`setup.minerals`, schema-bounded to 0–200); absent ⇒ the
    // historical 40-mineral demonstration field.
    this.seedMinerals(
      typeof data?.minerals === 'number'
        ? data.minerals
        : UTILITY_MINERAL_SEED_COUNT,
    );

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
    this.mineralHold.reset();
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
    // physics → auto-fire (AH-0MUII39KX007YUQ0, AC1). The Speed Boost multipliers
    // land here so the boost is live on this frame.
    this._tickPlayer(dt);

    // ── Spawner: one drop per interval, round-robin ─────────────
    if (this.spawnTimer <= 0) {
      this.spawnTimer += POWER_UP_SPAWN_INTERVAL;
      this._spawnRoundRobin();
    } else {
      this.spawnTimer -= dt;
    }

    // ── Shared drop layer (gap 4): Bomb notice, Magnet magnet,
    //    lifecycle, overlap collection, absorb VFX ──
    this.drops = this._updateDropLayer(this.drops, dt);

    // ── Mineral field: Mineral Scoop scoop attraction then shared collection ──
    // Same order and same helpers as PlayScene and GymFormationScene, so an
    // enabled scoop behaves identically here (AC4/AC5).
    if (this.minerals.length > 0) {
      this._applyMineralScoop(this.minerals, dt);
      this.minerals = collectMinerals(
        this.minerals,
        this.player,
        [],
        (mineral) => this._collectGymMineral(mineral),
        { playerPhased: this.isPlayerPhased() },
      );
    }

    // ── Effect timers ───────────────────────────────────────────
    this.effectsRegistry.tick(dt);

    // ── HUD ─────────────────────────────────────────────────────
    this.hud?.refresh();
  }

  // ── Spawning / lifecycle ─────────────────────────────────────────

  /** Spawns the next round-robin drop (Speed Boost → Extra Life → Magnet) at the next position. */
  private _spawnRoundRobin(): void {
    const id = this._drawNextDrop(
      this.roundRobinSpawner,
      this._resolveDropSlotState(),
    );
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
    drawPowerUpDrop(graphics, entry.id, 0, 0, POWER_UP_DROP_SIZE);
    // Start at scale 0 — the lifecycle grows it in.
    graphics.setScale(0);

    const drop: ActiveDrop = { powerUp: new PowerUp(id), x, y, graphics, dropId: id };
    this.drops.push(drop);
    return drop;
  }

  /**
   * Collects one mineral into the ship's hold and syncs the HUD bar — the
   * gym's analogue of `PlayScene._collectMineral`, using the shared
   * {@link MineralHold} so the hold progression matches the game. The gym does
   * not open the hold-full choice; the bar demonstrates the shared hold.
   */
  /**
   * Collects a mineral into the shared hold, crediting its **worth** (1 for an
   * ordinary dot, `MINERAL_DEPOSIT_VALUE` = 10 for a red deposit —
   * AH-0MVJ79739008396I).
   */
  private _collectGymMineral(mineral: Mineral): void {
    this.mineralHold.collect(mineral.value);
    this._syncMineralHud();
  }

  /** Mirrors the shared hold onto the HUD mineral bar. */
  private _syncMineralHud(): void {
    this.hud?.setMineralStore(
      this.mineralHold.store,
      this.mineralHold.capacity,
    );
  }

  /**
   * Advances every drop's lifecycle by `dt` seconds through the shared
   * helper (grow/hold/shrink). Public test seam.
   */
  advanceDrops(dt: number): void {
    this.drops = this._advanceDropLifecycles(this.drops, dt);
  }

  /**
   * Seeds `count` minerals scattered across the play area, clear of the
   * ship's start position (the disc around the centre bounded by
   * {@link MINERAL_SEED_CLEARANCE}), so the gym never opens with a mineral
   * already overlapping the ship and instantly collected into the hold.
   * Public so tests can verify the clearance contract (mirrors
   * `GymFormationScene.seedMinerals` / `GymLevel.seedMinerals`).
   */
  seedMinerals(count: number): Mineral[] {
    const cx = GAME_WIDTH / 2;
    const cy = GAME_HEIGHT / 2;
    const seeded: Mineral[] = [];
    for (let i = 0; i < count; i++) {
      const x = 20 + this.sceneRng() * (GAME_WIDTH - 40);
      const y = 20 + this.sceneRng() * (GAME_HEIGHT - 120);
      let px = x;
      let py = y;
      const distance = Math.hypot(x - cx, y - cy);
      if (distance < MINERAL_SEED_CLEARANCE) {
        // Push the sample radially out onto the clearance ring instead of
        // re-drawing: deterministic, and always in bounds because the ring
        // radius stays under the nearest play-area edge from the centre.
        if (distance === 0) {
          px = cx + MINERAL_SEED_CLEARANCE;
        } else {
          const scale = MINERAL_SEED_CLEARANCE / distance;
          px = cx + (x - cx) * scale;
          py = cy + (y - cy) * scale;
        }
      }
      const mineral = new Mineral(this, { x: px, y: py });
      this.minerals.push(mineral);
      seeded.push(mineral);
    }
    return seeded;
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

  /**
   * Mineral field the collector drones (Mystery UFO reward) seek, vacuum and
   * drop into — the gym's live field (gym↔game parity, AC6 of
   * AH-0MV9G113S009B37I).
   */
  protected override getDroneMineralField(): Mineral[] {
    return this.minerals;
  }

  /**
   * Hold sink for a collector drone's ferried minerals: the gym's local
   * mineral hold, mirrored onto the HUD exactly like every other pickup.
   */
  protected override getDroneMineralSink(): DroneMineralSink {
    return {
      addMinerals: (amount: number) => {
        this.mineralHold.collect(amount);
        this._syncMineralHud();
      },
    };
  }

  /** The gym's shared run-scoped mineral hold (test seam). */
  getMineralHold(): MineralHold {
    return this.mineralHold;
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