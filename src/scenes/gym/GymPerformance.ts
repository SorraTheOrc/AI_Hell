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
 * ## Sweep parameterisation (AH-0MW5IUDQD001WOXI)
 *
 * The same scene is the measured step of the enemy-count sweep
 * (AH-0MW3MGY3Z003R1M6): its launch data carries the enemy `count`, the
 * per-step shoot/dive `enemyMix` and an `autoFire` flag, and the player
 * loadout arrives through the shared `SceneSetupState` (`applySceneSetup`).
 * Nothing is forked for the sweep:
 *
 * - `count` is written to the existing `config.count` seam and laid out by
 *   {@link layoutForCount}, which keeps the whole block on screen at every
 *   swept count — and reproduces the historical 10 × 10, 66 × 34 geometry at
 *   the default count;
 * - `enemyMix` assigns one archetype per grid slot from the slot index (never
 *   a mutable spawn counter), still built by `createEnemyFromConfig` and fired
 *   by `fireForEnemy`;
 * - `autoFire` (default **off**) enables the shared player auto-fire step, so
 *   a sweep step measures the player's own bullets and kills.
 *
 * Absent launch data reproduces the shipped 100-enemy stress scenario exactly
 * (10 × 10 block, no player fire); `GymPerformance.test.ts` pins both the
 * default and the parameterised behaviour, so the sweep parameters cannot
 * silently change the shipped scenario.
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
 * - there is **no wave timeout** — the configured enemy count stays at the
 *   launch-data count for the whole measured window;
 * - there is **no seeded mineral field** and no power-up drop layer — with no
 *   launch data the measured scenario is exactly the 100 enemies and their
 *   fire, nothing else (a sweep setup may grant a loadout through the shared
 *   `applySceneSetup`; it enables no drop layer of its own);
 * - the spawn is a fixed row-major grid, and every enemy's archetype is
 *   derived from its grid offset or slot index (never from a mutable spawn
 *   counter), so two boots of the scene produce the identical roster;
 * - the player ship is present (enemy aimed/spread fire targets it) and its
 *   auto-fire defaults to **disabled**, so the shipped 100-enemy load cannot
 *   decay during the measured window; a sweep step opts in with
 *   `autoFire: true` to measure the player's own bullets and kills.
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

/**
 * The mutable scene parameters a boot resolves from its launch data.
 *
 * Shared by reference with the constructor-built {@link EnemyFormationConfig}
 * closures, so `init` can re-point the geometry and the slot roster before
 * `create()` spawns anything — without rebuilding (or forking) the config.
 */
interface GymPerformanceParameters {
  /** Resolved block geometry for this boot's count. */
  layout: GymPerformanceLayout;
  /** Configured mix, or `null` for the historical round-robin roster. */
  mix: readonly GymPerformanceMixEntry[] | null;
  /** Archetype per grid slot, in spawn order (`layout.count` entries). */
  roster: GymPerformanceArchetypeKey[];
  /** Whether the shared player auto-fire step runs for this boot. */
  autoFire: boolean;
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
export function layoutForCount(count: number): GymPerformanceLayout {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(
      `layoutForCount(${count}): expected a positive integer enemy count`,
    );
  }

  // As square as the count allows: the block stays closest to the historical
  // 10 × 10 shape as the sweep walks the count upward.
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);

  // Use the historical spacing when it still fits, otherwise the widest
  // integer spacing the playfield box can hold. Below the documented minimum
  // the block would overlap into one blurred mass, so that count is refused
  // rather than measured at an invalid load.
  const spacingX =
    columns > 1
      ? Math.min(
          GYM_PERFORMANCE_SPACING_X,
          Math.floor(GYM_PERFORMANCE_PLAYFIELD.width / (columns - 1)),
        )
      : GYM_PERFORMANCE_SPACING_X;
  const spacingY =
    rows > 1
      ? Math.min(
          GYM_PERFORMANCE_SPACING_Y,
          Math.floor(GYM_PERFORMANCE_PLAYFIELD.height / (rows - 1)),
        )
      : GYM_PERFORMANCE_SPACING_Y;

  if (
    spacingX < GYM_PERFORMANCE_MIN_SPACING_X ||
    spacingY < GYM_PERFORMANCE_MIN_SPACING_Y
  ) {
    throw new Error(
      `layoutForCount(${count}): no on-screen ${columns} × ${rows} grid fits `
        + `the ${GYM_PERFORMANCE_PLAYFIELD.width} × `
        + `${GYM_PERFORMANCE_PLAYFIELD.height} px playfield at the documented `
        + `minimum spacing (${GYM_PERFORMANCE_MIN_SPACING_X} × `
        + `${GYM_PERFORMANCE_MIN_SPACING_Y} px)`,
    );
  }

  const blockWidth = (columns - 1) * spacingX;
  // The block is centred horizontally and top-aligned at the playfield top —
  // which is exactly the historical base at the default count.
  const startX =
    GYM_PERFORMANCE_PLAYFIELD.left +
    Math.round((GYM_PERFORMANCE_PLAYFIELD.width - blockWidth) / 2);
  const startY = GYM_PERFORMANCE_PLAYFIELD.top;

  return {
    count,
    columns,
    rows,
    spacingX,
    spacingY,
    startX,
    startY,
    offsets: buildStressGridOffsets(count, columns),
  };
}

/**
 * Expands a configured mix into one archetype per grid slot, in spawn order.
 *
 * The slot's archetype is derived from its **slot index** (the concatenated
 * mix), never from a mutable spawn counter, so two boots of the same setup
 * produce the identical slot-by-slot roster. Slots the mix does not cover fall
 * back to the historical round-robin roster at that index.
 *
 * @param layout - Resolved geometry whose slot count bounds the roster.
 * @param mix - Configured per-archetype shares, or `null` for the default.
 */
function buildSlotArchetypes(
  layout: GymPerformanceLayout,
  mix: readonly GymPerformanceMixEntry[] | null | undefined,
): GymPerformanceArchetypeKey[] {
  const roster: GymPerformanceArchetypeKey[] = [];
  for (const entry of mix ?? []) {
    const copies = Math.max(0, Math.floor(entry.count));
    for (let i = 0; i < copies && roster.length < layout.count; i += 1) {
      roster.push(entry.archetype);
    }
    if (roster.length >= layout.count) break;
  }
  for (let index = roster.length; index < layout.count; index += 1) {
    roster.push(archetypeForOffset(layout.offsets[index], layout.columns));
  }
  return roster;
}

/**
 * The bottom hint line for a configured count (the historical string at the
 * default count, with the count interpolated so no label advertises the
 * default load at a parameterised count).
 */
function stressHintText(count: number): string {
  return (
    `STRESS — ${count} late-game enemies + live fire `
    + '(perf: npm run perf:measure -- --scene GymPerformance)'
  );
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
  parameters: GymPerformanceParameters,
): EnemyFormationConfig<EnemyEntity, FormationSceneBullet> {
  const configs = new Map<GymPerformanceArchetypeKey, EnemyConfig>();
  for (const key of GYM_PERFORMANCE_ARCHETYPE_KEYS) {
    // Config-store lookup (CSV-backed, seed-default fallback) — the same
    // resolver the game and every formation gym use, so tuning applies here.
    configs.set(key, loadEnemyConfig(key));
  }

  return {
    sceneKey: GYM_PERFORMANCE_SCENE_KEY,
    // The block geometry and roster are resolved per boot by `init`; the
    // closures read the shared parameters object, so they follow a
    // parameterised count without a second scene or a forked spawn loop.
    buildOffsets: (count) =>
      buildStressGridOffsets(count, parameters.layout.columns),
    count: parameters.layout.count,
    spacingX: parameters.layout.spacingX,
    spacingY: parameters.layout.spacingY,
    driftSpeed: GYM_PERFORMANCE_DRIFT_SPEED,
    startX: parameters.layout.startX,
    startY: parameters.layout.startY,
    statusLabel: 'late-game enemies',
    hintText: stressHintText(parameters.layout.count),
    player: { ...GYM_PERFORMANCE_PLAYER_SPAWN },
    // The measured scenario is *enemies and their fire*: the scene boots with
    // the HUD SHOOT toggle ON and every spawned entity firing.
    shootEnabled: true,
    // No demonstration mineral field: the only load is the configured
    // enemies + fire.
    minerals: false,
    createEntity: (scene, x, y, offset) => {
      // Slot index, derived from the offset (never a spawn counter), selects
      // the configured mix entry; the fallback keeps the historical roster.
      const index = offset.row * parameters.layout.columns + offset.col;
      const key =
        parameters.roster[index] ??
        archetypeForOffset(offset, parameters.layout.columns);
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
 * The stress gym — 100 late-game enemies + live fire by default, and the
 * parameterisable measured scene of the enemy-count sweep (count, shoot/dive
 * mix and player auto-fire, all through the shared core seams).
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

  /**
   * The boot's parameters, shared by reference with the config closures above
   * so {@link init} can re-point them before {@link create} spawns.
   */
  private readonly parameters: GymPerformanceParameters;

  private stressOverlay: Phaser.GameObjects.Text | null = null;

  private overlayClockMs = 0;

  constructor() {
    const archetypesByEntity = new WeakMap<
      EnemyEntity,
      GymPerformanceArchetypeKey
    >();
    const layout = layoutForCount(GYM_PERFORMANCE_ENEMY_COUNT);
    const parameters: GymPerformanceParameters = {
      layout,
      mix: null,
      roster: buildSlotArchetypes(layout, null),
      autoFire: false,
    };
    super(buildFormationConfig(archetypesByEntity, parameters));
    this.archetypesByEntity = archetypesByEntity;
    this.parameters = parameters;
  }

  /**
   * Resolves the sweep parameters from the scene launch data
   * (AH-0MW5IUDQD001WOXI).
   *
   * `count`/`enemyMix`/`autoFire` are scene configuration: the count and its
   * layout go into the existing `config.count`/`buildOffsets` seam, the mix
   * becomes one archetype per grid slot, and `autoFire` gates the shared
   * player auto-fire step. The loadout itself is *not* read here — it is the
   * shared {@link SceneSetupState} half of the launch data, applied by the
   * inherited `applySceneSetup` path in `create()`. Absent launch data keeps
   * the shipped 100-enemy, no-player-fire scenario (and resets a restarted
   * scene to it).
   */
  override init(data?: GymPerformanceLaunchData | null): void {
    const layout = layoutForCount(data?.count ?? GYM_PERFORMANCE_ENEMY_COUNT);
    const mix = data?.enemyMix ?? null;
    this.parameters.layout = layout;
    this.parameters.mix = mix;
    this.parameters.roster = buildSlotArchetypes(layout, mix);
    this.parameters.autoFire = data?.autoFire === true;
    this.applyLayoutToConfig(layout);
    super.init(data);
  }

  /** Writes the resolved geometry into the shared formation config seam. */
  private applyLayoutToConfig(layout: GymPerformanceLayout): void {
    this.config.count = layout.count;
    this.config.spacingX = layout.spacingX;
    this.config.spacingY = layout.spacingY;
    this.config.startX = layout.startX;
    this.config.startY = layout.startY;
    this.config.hintText = stressHintText(layout.count);
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
   * Player auto-fire follows the sweep step's `autoFire` flag (default
   * **off**).
   *
   * The shipped stress scenario is "100 enemies alive", and a firing player
   * would shoot the top rows out during the measured window, turning the worst
   * case into an easier one. Enemies still aim and fire at the live ship, so
   * their fire is unchanged; disabling a feature is the permitted gym
   * difference (a divergent copy never is). See `docs/GYM_PARITY.md`. A sweep
   * step opts in (`autoFire: true`) so its measured load includes the player's
   * own bullets and kills through the same shared step; a capture setup that
   * grants weapons does not re-enable it on its own.
   */
  protected override autoFireEnabled(): boolean {
    return this.parameters.autoFire;
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

  /** Writes the FPS + live-count readout, naming the configured load. */
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
        `STRESS — ${this.parameters.layout.count} late-game enemies`
          + `${this.mixLabel()}, live fire`,
        `FPS ${fpsText} | enemies ${counts.enemies} | enemy bullets ${counts.enemyBullets} | player bullets ${counts.playerBullets}`,
      ].join('\n'),
    );
  }

  /**
   * The configured shoot/dive mix, as a parenthesised overlay suffix — empty
   * when the boot uses the historical round-robin roster.
   */
  private mixLabel(): string {
    const mix = this.parameters.mix;
    if (!mix || mix.length === 0) return '';
    return ` (${mix.map((entry) => `${entry.archetype} ${entry.count}`).join(', ')})`;
  }
}
