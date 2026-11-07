/**
 * Performance stress gym — 100 late-game enemies with live fire
 * (AH-0MVXV0DT50028RF8, parent AH-0MVWJQUN6009IS87).
 *
 * The game's performance budget is **60 FPS with 100 late-game enemies
 * alive** (see `docs/PERFORMANCE.md`), but the shipped curated waves cap far
 * below that, so there is no reproducible worst case. This gym is that worst
 * case on demand: a fixed 10 × 10 formation of late-game archetypes, all
 * firing from the first frame, with the shared player ship and the shared
 * combat/collision loop — measurable with
 * `npm run perf:measure -- --scene GymPerformance --seconds 60`.
 *
 * ## Status: test-first skeleton (AH-0MW5IUD410063FSI)
 *
 * The 100-enemy scenario above is shipped and unchanged. The **sweep**
 * parameters (enemy count, per-step shoot/dive mix, player auto-fire and the
 * seeded loadout) are pinned first by the red specs in
 * `GymPerformance.test.ts` against the declarations below — the launch-data
 * type, the documented layout limits and the {@link layoutForCount} signature.
 * Only the declarations exist today: {@link layoutForCount} throws
 * `not implemented` and {@link GymPerformance.init} merely widens the
 * launch-data type, so
 *
 * - `npm run typecheck` stays clean (fully typed, no `any` escape), and
 * - every parameterisation spec fails for that documented reason rather than
 *   passing vacuously against today's hard-coded scene.
 *
 * The paired implementation (AH-0MW5IUDQD001WOXI) fills the bodies and flips
 * each `it.fails` marker back to `it`; the default-behaviour specs in
 * `GymPerformance.test.ts` (100 enemies, 10 × 10 grid, no player fire) pin the
 * shipped scenario throughout, so the sweep parameters cannot silently change
 * it.
 *
 * ## Parity by construction
 *
 * The scene is a thin `GymFormationScene` subclass: every enemy is built by
 * the shared `createEnemyFromConfig` factory, fires through the shared
 * `fireForEnemy` dispatcher, and is advanced by the inherited
 * `GymFormationScene`/`CombatScene` loop (movement, firing, collisions,
 * player auto-fire, wrap). No loop body, fire rule or movement law is copied
 * here — see `docs/GYM_PARITY.md` for the recorded row.
 *
 * ## What "late-game" means here
 *
 * The roster is the **firing** archetypes the campaign's final third fields
 * (levels 6–10 of `LEVELS`, `src/waves/Formations.ts`): `tank`, `swarm`,
 * `phaser`, `diver`, `raider` and `march`. The non-firing late-game threats
 * are deliberately excluded — the `capturer` (tractor beam, no bullets), the
 * `harvester` and the `grunt` horde — because the measured scenario is
 * *enemies plus their bullet load*, and `scout` is excluded as the early-game
 * identity. `GymPerformance.test.ts` pins the roster against both the campaign
 * and the shared `ENEMY_FIRE_METHODS` table, so neither can drift silently.
 *
 * ## Determinism of the load
 *
 * - formation drift is **0** — the block does not scroll off mid-measurement;
 * - there is **no wave timeout** — the enemy count stays at 100 for the whole
 *   measured window;
 * - there is **no seeded mineral field** and no power-up layer — the measured
 *   scenario is exactly the 100 enemies and their fire, nothing else;
 * - the spawn is a fixed row-major grid, and every enemy's archetype is
 *   derived from its grid offset (never from a mutable spawn counter), so two
 *   boots of the scene produce the identical roster;
 * - the player ship is present (enemy aimed/spread fire targets it) but its
 *   auto-fire is **disabled**, so the 100-enemy load cannot decay during the
 *   measured window.
 *
 * The live readout (top-left) reports FPS and the live entity counts the
 * performance probe samples (`getPerformanceCounts()`); it refreshes at a low
 * cadence ({@link GYM_PERFORMANCE_OVERLAY_INTERVAL_MS}) so the overlay itself
 * never becomes a hot-path allocation during a measurement.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { loadEnemyConfig } from '../../core/enemyConfig';
import type { EnemyConfig } from '../../core/enemyConfig';
import type { PerformanceCounts } from '../../core/perfProbe';
import type { SceneSetupState } from '../core/sceneSetup';
import type { FormationOffset } from '../../utils/formations';
import {
  createEnemyFromConfig,
  type EnemyEntity,
} from '../../entities/enemyFactory';
import { fireForEnemy } from '../../entities/enemyFire';
import type { FormationSceneBullet } from './core/GymFormationScene';
import {
  GymFormationScene,
  type EnemyFormationConfig,
} from './core/GymFormationScene';

/** Scene key (== class name, per the `Gym<Name>.ts` discovery convention). */
export const GYM_PERFORMANCE_SCENE_KEY = 'GymPerformance';

/** The exact enemy count the performance budget is measured at (100). */
export const GYM_PERFORMANCE_ENEMY_COUNT = 100;

/** Grid columns == rows for the 10 × 10 stress block. */
export const GYM_PERFORMANCE_GRID_COLUMNS = 10;

/** Horizontal slot spacing (px) — a 10-column block spans 9 × 66 = 594 px. */
export const GYM_PERFORMANCE_SPACING_X = 66;

/** Vertical row spacing (px) — a 10-row block spans 9 × 34 = 306 px. */
export const GYM_PERFORMANCE_SPACING_Y = 34;

/** Formation base x (px): the block is horizontally centred on the canvas. */
export const GYM_PERFORMANCE_START_X =
  (GAME_WIDTH - (GYM_PERFORMANCE_GRID_COLUMNS - 1) * GYM_PERFORMANCE_SPACING_X) / 2;

/** Formation base y (px): the block sits in the upper two thirds. */
export const GYM_PERFORMANCE_START_Y = 80;

/**
 * Formation drift speed (px/s). Zero, so the 100-enemy load stays on screen
 * for the whole measurement window (a scrolling block would change the load).
 */
export const GYM_PERFORMANCE_DRIFT_SPEED = 0;

/**
 * The on-screen box a formation block must stay inside (px).
 *
 * The measured load must be visible: a fixed 66 × 34 spacing puts a
 * 400-enemy block ~1300 px below the canvas, which would measure an
 * off-screen load. {@link layoutForCount} therefore chooses the block's
 * columns, rows and spacing so the whole block fits this box, which itself
 * sits inside the canvas (30 px margins either side, top at
 * {@link GYM_PERFORMANCE_START_Y}, bottom clear of the HUD controls).
 */
export const GYM_PERFORMANCE_PLAYFIELD = {
  left: (GAME_WIDTH - 900) / 2,
  top: GYM_PERFORMANCE_START_Y,
  width: 900,
  height: 380,
} as const;

/**
 * Documented minimum horizontal slot spacing (px) for a parameterised block.
 *
 * Below this the archetype bodies overlap enough to blur the measured load;
 * the historical 66 px default spacing is well above it.
 */
export const GYM_PERFORMANCE_MIN_SPACING_X = 20;

/**
 * Documented minimum vertical slot spacing (px) for a parameterised block.
 *
 * Below this the rows overlap; the historical 34 px default spacing is well
 * above it.
 */
export const GYM_PERFORMANCE_MIN_SPACING_Y = 18;

/** Player spawn (bottom centre), mirroring the other combat gyms. */
export const GYM_PERFORMANCE_PLAYER_SPAWN = {
  x: GAME_WIDTH / 2,
  y: GAME_HEIGHT - 40,
} as const;

/**
 * Late-game firing archetypes (round-robin over the grid, in this order).
 * See the module docblock for the definition and its exclusions.
 */
export const GYM_PERFORMANCE_ARCHETYPE_KEYS = [
  'tank',
  'swarm',
  'phaser',
  'diver',
  'raider',
  'march',
] as const;

/** One roster archetype key. */
export type GymPerformanceArchetypeKey =
  (typeof GYM_PERFORMANCE_ARCHETYPE_KEYS)[number];

/** Overlay refresh interval (ms) — 4 Hz, off the measured hot path. */
export const GYM_PERFORMANCE_OVERLAY_INTERVAL_MS = 250;

/** `name` of the stress overlay text object (stable selector for tests). */
export const GYM_PERFORMANCE_OVERLAY_NAME = 'performance-gym-overlay';

/** Overlay text style (top-left, monospace, neon). */
const OVERLAY_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '13px',
  color: '#00ff88',
  backgroundColor: '#101010',
  padding: { x: 8, y: 6 },
};

/** One archetype's share of a step's configured enemy count. */
export interface GymPerformanceMixEntry {
  /** Roster archetype the slots spawn. */
  readonly archetype: GymPerformanceArchetypeKey;
  /** How many grid slots this archetype fills. */
  readonly count: number;
}

/** The resolved block geometry for one enemy count. */
export interface GymPerformanceLayout {
  /** Enemy count this geometry lays out. */
  readonly count: number;
  /** Grid columns in the block. */
  readonly columns: number;
  /** Grid rows in the block (`columns × rows >= count`). */
  readonly rows: number;
  /** Horizontal slot spacing (px), at least the documented minimum. */
  readonly spacingX: number;
  /** Vertical slot spacing (px), at least the documented minimum. */
  readonly spacingY: number;
  /** Formation base x (px): the left edge of the block. */
  readonly startX: number;
  /** Formation base y (px): the top edge of the block. */
  readonly startY: number;
  /** Deterministic row-major slot offsets, exactly `count` of them. */
  readonly offsets: readonly FormationOffset[];
}

/**
 * Scene launch data: the shared capture setup plus the sweep's parameters
 * (AH-0MW5IUDQD001WOXI).
 *
 * Extends {@link SceneSetupState} rather than nesting it, so the seeded
 * loadout arrives through the one shared `applySceneSetup` seam the game and
 * every other gym use — no test-only grant path.
 */
export interface GymPerformanceLaunchData extends SceneSetupState {
  /** Enemy count for this run; the only source of the number. */
  count?: number;
  /**
   * Per-archetype shares of {@link count}, in spawn order. The scene assigns
   * each grid slot from this roster deterministically; absent keeps the
   * historical late-game round-robin roster.
   */
  enemyMix?: readonly GymPerformanceMixEntry[];
  /**
   * Whether the shared player auto-fire path runs. Default `false`: the
   * shipped 100-enemy stress scenario must not decay during a measurement.
   */
  autoFire?: boolean;
}

/**
 * Resolves the block geometry for `count` enemies.
 *
 * The block must be fully **on screen** (inside
 * {@link GYM_PERFORMANCE_PLAYFIELD}) with slot spacing at or above the
 * documented minimums, and the default count keeps the historical 10 × 10,
 * 66 × 34 geometry. Pure and deterministic: the same count always yields the
 * same geometry.
 */
export function layoutForCount(_count: number): GymPerformanceLayout {
  throw new Error('not implemented');
}

/**
 * Builds the deterministic row-major grid offsets for `count` enemies.
 *
 * Pure and side-effect free: index `i` maps to `row = floor(i / columns)`,
 * `col = i % columns`, so the spawn order is the reading order of the block
 * and two boots are identical. Returns exactly `count` offsets (the scene's
 * "exactly 100 enemies" contract is this function's length).
 */
export function buildStressGridOffsets(
  count: number,
  columns: number = GYM_PERFORMANCE_GRID_COLUMNS,
): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  if (count <= 0) return offsets;
  const safeColumns = Math.max(1, Math.floor(columns));
  for (let index = 0; index < count; index += 1) {
    offsets.push({
      row: Math.floor(index / safeColumns),
      col: index % safeColumns,
    });
  }
  return offsets;
}

/**
 * The archetype a grid slot spawns. Derived strictly from the offset, so the
 * roster is deterministic and independent of spawn call order.
 */
export function archetypeForOffset(
  offset: FormationOffset,
  columns: number = GYM_PERFORMANCE_GRID_COLUMNS,
): GymPerformanceArchetypeKey {
  const index = offset.row * Math.max(1, Math.floor(columns)) + offset.col;
  return GYM_PERFORMANCE_ARCHETYPE_KEYS[
    index % GYM_PERFORMANCE_ARCHETYPE_KEYS.length
  ];
}

/**
 * Builds the scene's formation config. `archetypesByEntity` is the closure
 * seam that lets `collectBullets` resolve an entity's archetype for the
 * shared firing dispatcher (an entity does not carry its config key).
 */
function buildFormationConfig(
  archetypesByEntity: WeakMap<EnemyEntity, GymPerformanceArchetypeKey>,
): EnemyFormationConfig<EnemyEntity, FormationSceneBullet> {
  const configs = new Map<GymPerformanceArchetypeKey, EnemyConfig>();
  for (const key of GYM_PERFORMANCE_ARCHETYPE_KEYS) {
    // Config-store lookup (CSV-backed, seed-default fallback) — the same
    // resolver the game and every formation gym use, so tuning applies here.
    configs.set(key, loadEnemyConfig(key));
  }

  return {
    sceneKey: GYM_PERFORMANCE_SCENE_KEY,
    buildOffsets: (count) => buildStressGridOffsets(count),
    count: GYM_PERFORMANCE_ENEMY_COUNT,
    spacingX: GYM_PERFORMANCE_SPACING_X,
    spacingY: GYM_PERFORMANCE_SPACING_Y,
    driftSpeed: GYM_PERFORMANCE_DRIFT_SPEED,
    startX: GYM_PERFORMANCE_START_X,
    startY: GYM_PERFORMANCE_START_Y,
    statusLabel: 'late-game enemies',
    hintText:
      'STRESS — 100 late-game enemies + live fire (perf: npm run perf:measure -- --scene GymPerformance)',
    player: { ...GYM_PERFORMANCE_PLAYER_SPAWN },
    // The measured scenario is *enemies and their fire*: the scene boots with
    // the HUD SHOOT toggle ON and every spawned entity firing.
    shootEnabled: true,
    // No demonstration mineral field: the only load is the 100 enemies + fire.
    minerals: false,
    createEntity: (scene, x, y, offset) => {
      const key = archetypeForOffset(offset);
      const entity = createEnemyFromConfig(scene, configs.get(key)!, x, y, offset);
      archetypesByEntity.set(entity, key);
      return entity;
    },
    // Shared archetype→tryFire dispatch: each entity fires with its own
    // archetype's rule and cadence, exactly as the game does.
    collectBullets: (entity, now) =>
      fireForEnemy<FormationSceneBullet>(
        entity,
        archetypesByEntity.get(entity) ?? GYM_PERFORMANCE_ARCHETYPE_KEYS[0],
        now,
      ),
  };
}

/**
 * 100 late-game enemies + live fire — the reproducible performance worst case.
 */
export class GymPerformance extends GymFormationScene<
  EnemyEntity,
  FormationSceneBullet
> {
  /** Archetype of every spawned entity (spawn-order accessible via {@link archetypes}). */
  private readonly archetypesByEntity: WeakMap<
    EnemyEntity,
    GymPerformanceArchetypeKey
  >;

  private stressOverlay: Phaser.GameObjects.Text | null = null;

  private overlayClockMs = 0;

  constructor() {
    const archetypesByEntity = new WeakMap<
      EnemyEntity,
      GymPerformanceArchetypeKey
    >();
    super(buildFormationConfig(archetypesByEntity));
    this.archetypesByEntity = archetypesByEntity;
  }

  /**
   * Captures the sweep launch data (test-first skeleton, AH-0MW5IUD410063FSI;
   * paired implementation AH-0MW5IUDQD001WOXI).
   *
   * The signature is widened to {@link GymPerformanceLaunchData} so the
   * parameterisation specs can supply their parameters, but today it only
   * forwards to the shared scene-setup handling — reading and applying `count`,
   * `enemyMix` and `autoFire` is the paired implementation's body.
   */
  override init(data?: GymPerformanceLaunchData | null): void {
    super.init(data);
  }

  override create(): void {
    super.create();
    // Reset the overlay throttle so a scene restart re-renders immediately.
    this.overlayClockMs = 0;
    this.stressOverlay = this.add
      .text(10, 10, '', OVERLAY_STYLE)
      .setDepth(200)
      .setName(GYM_PERFORMANCE_OVERLAY_NAME);
    this.renderStressOverlay();
  }

  /**
   * Advances the shared simulation loop, then refreshes the stress overlay at
   * a low cadence. The overlay update itself allocates one text per interval
   * (4 Hz), never per frame, so it stays off the measured hot path.
   */
  override tick(dt: number): void {
    super.tick(dt);
    this.overlayClockMs += dt * 1000;
    if (this.overlayClockMs >= GYM_PERFORMANCE_OVERLAY_INTERVAL_MS) {
      this.overlayClockMs = 0;
      this.renderStressOverlay();
    }
  }

  /**
   * Player auto-fire is **disabled**: the stress scenario is "100 enemies
   * alive", and a firing player would shoot the top rows out during the
   * measured window, turning the worst case into an easier one. Enemies still
   * aim and fire at the live ship, so their fire is unchanged; disabling a
   * feature is the permitted gym difference (a divergent copy never is). See
   * `docs/GYM_PARITY.md`. Capture setups that grant weapons do not re-enable
   * it — the load must stay at 100 enemies.
   */
  protected override autoFireEnabled(): boolean {
    return false;
  }

  /**
   * Live entity counts the performance probe samples, matching `PlayScene`'s
   * report shape. `minerals` is 0 because this gym deliberately seeds none.
   */
  override getPerformanceCounts(): PerformanceCounts {
    return { ...super.getPerformanceCounts(), minerals: this.getMinerals().length };
  }

  /** Live counts for the harness/tests (alias of the probe seam). */
  get liveCounts(): PerformanceCounts {
    return this.getPerformanceCounts();
  }

  /** Archetype key of every spawned entity, in spawn (grid) order. */
  get archetypes(): GymPerformanceArchetypeKey[] {
    const keys = this.formationEntities.map(
      (entity) =>
        this.archetypesByEntity.get(entity) ?? GYM_PERFORMANCE_ARCHETYPE_KEYS[0],
    );
    return keys;
  }

  /** The overlay text currently displayed (empty before `create()`). */
  get stressOverlayText(): string {
    return this.stressOverlay?.text ?? '';
  }

  /** Writes the FPS + live-count readout. */
  private renderStressOverlay(): void {
    if (!this.stressOverlay) return;
    const counts = this.getPerformanceCounts();
    const fps = this.game?.loop?.actualFps;
    const fpsText =
      typeof fps === 'number' && Number.isFinite(fps) && fps > 0
        ? fps.toFixed(0)
        : '—';
    this.stressOverlay.setText(
      [
        'STRESS — 100 late-game enemies, live fire',
        `FPS ${fpsText} | enemies ${counts.enemies} | enemy bullets ${counts.enemyBullets} | player bullets ${counts.playerBullets}`,
      ].join('\n'),
    );
  }
}
