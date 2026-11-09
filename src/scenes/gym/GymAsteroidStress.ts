/**
 * Asteroid stress gym — ~200 live asteroids plus a representative late-game
 * wave (AH-0MW507M5L0084TSW, parent AH-0MW4857B0004GMWR).
 *
 * The asteroid batched-rendering work (parent epic) is measured against a
 * reproducible field of hundreds of live rocks. The shipped curated waves
 * never field that many, and the existing `GymPerformance` stress gym is 100
 * firing *ships*, not asteroids, so there was no before/after scenario for
 * asteroid rendering. This gym is that scenario on demand:
 *
 * ```bash
 * npm run perf:measure -- --scene GymAsteroidStress --seconds 60 --warmup 3
 * ```
 *
 * ## What the scenario is
 *
 * - **200 live asteroids** (`GYM_ASTEROID_STRESS_ASTEROID_COUNT`), mixed
 *   `large`/`medium` tiers, scattered over the whole playfield by a
 *   deterministic seeded planner ({@link buildAsteroidStressSpawnEvents}).
 *   Every one is the shared `Asteroid` entity, materialised by the shared
 *   `createAsteroidFromEvent` seam — the *same code* `PlayScene` runs for its
 *   scheduled asteroid hazard — so the stress field renders through exactly
 *   the game's asteroid path (AH-0MW2IRYAH0055WCN). The rocks are
 *   **stationary** (zero velocity, with a rock-free pocket around the ship) so
 *   a ram can never split a rock and change the load mid-window; they still
 *   rotate through the shared entity every frame.
 * - **A representative late-game wave** of 12 firing enemies, two of each
 *   archetype the campaign's final third fields (`tank`, `swarm`, `phaser`,
 *   `diver`, `raider`, `march` — the roster `GymPerformance` pins). They are
 *   built by the shared `createEnemyFromConfig` factory and fire through the
 *   shared `fireForEnemy` dispatcher, exactly as the game does.
 * - **Player auto-fire is disabled** (`autoFireEnabled()` is `false`, the
 *   documented divergence `GymPerformance` also records): the measured
 *   scenario is "200 rocks alive plus the wave", and a firing player would
 *   shoot the load down during the window. Enemies still aim and fire at the
 *   live ship. Disabling a feature is the permitted gym difference; a
 *   divergent copy never is (see `docs/GYM_PARITY.md`).
 *
 * ## Determinism of the load
 *
 * - the field planner is a pure function of an injected RNG, seeded with
 *   {@link GYM_ASTEROID_STRESS_FIELD_SEED} by default (or the capture setup's
 *   `seed`, through the shared `resolveSetupSeed`), so two boots produce the
 *   identical rock positions, velocities, tiers, rotations and count;
 * - the wave roster is derived from the grid offset (never a mutable spawn
 *   counter), so the archetype mix is identical on every boot;
 * - formation drift is **0** and there is **no wave timeout**
 *   (`timeoutDuration` is omitted → the shared timeout stays disabled), so
 *   nothing scrolls away or refreshes mid-measurement;
 * - there is **no seeded mineral field** and no power-up layer
 *   (`minerals: false`): the measured load is exactly the rocks, the wave and
 *   their fire.
 *
 * ## Parity by construction
 *
 * Thin `GymFormationScene` subclass: the wave is spawned by the inherited
 * `_spawnFormation` seam (portal + wormhole transit), the field is spawned
 * through the shared asteroid materialiser and registered with
 * `registerDynamicEntity`, and movement, wrapping, collisions, asteroid
 * splitting and every per-frame update are the inherited shared core. No loop
 * body, movement law or fire rule is copied here — see `docs/GYM_PARITY.md`
 * for the recorded row.
 *
 * @module src/scenes/gym/GymAsteroidStress
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { loadEnemyConfig } from '../../core/enemyConfig';
import type { EnemyConfig } from '../../core/enemyConfig';
import type { PerformanceCounts } from '../../core/perfProbe';
import { createSeededRng } from '../../core/rng';
import { Asteroid } from '../../entities/Asteroid';
import {
  createEnemyFromConfig,
  type EnemyEntity,
} from '../../entities/enemyFactory';
import { fireForEnemy } from '../../entities/enemyFire';
import {
  createAsteroidFromEvent,
  type AsteroidSpawnEvent,
} from '../core/asteroidHazard';
import { splitAsteroid } from '../core/asteroidSplit';
import {
  resolveSetupSeed,
  type SceneSetupState,
} from '../core/sceneSetup';
import type { FormationSceneBullet } from './core/GymFormationScene';
import {
  GymFormationScene,
  type EnemyFormationConfig,
} from './core/GymFormationScene';
import {
  GYM_PERFORMANCE_ARCHETYPE_KEYS,
  archetypeForOffset,
  buildStressGridOffsets,
  type GymPerformanceArchetypeKey,
} from './GymPerformance';

/** Scene key (== class name, per the `Gym<Name>.ts` discovery convention). */
export const GYM_ASTEROID_STRESS_SCENE_KEY = 'GymAsteroidStress';

/** Number of live asteroids the stress scenario hosts (the parent's ~200). */
export const GYM_ASTEROID_STRESS_ASTEROID_COUNT = 200;

/** Default seed for the deterministic asteroid field. */
export const GYM_ASTEROID_STRESS_FIELD_SEED = 0x5eed_a57e;

/** Field grid columns — 20 × 10 cells covers the 960 × 540 playfield. */
export const GYM_ASTEROID_STRESS_GRID_COLUMNS = 20;

/** Field grid rows (derived: `count / columns`). */
export const GYM_ASTEROID_STRESS_GRID_ROWS = Math.ceil(
  GYM_ASTEROID_STRESS_ASTEROID_COUNT / GYM_ASTEROID_STRESS_GRID_COLUMNS,
);

/** Half-size (px) of the largest asteroid tier — the on-screen spawn margin. */
const FIELD_EDGE_MARGIN = 46;

/** Probability that a field slot is a `large` asteroid; the rest are `medium`
 * (the two tiers the shared `computeSpawns` planner itself produces). Small
 * rocks only appear through shared splits.
 */
export const GYM_ASTEROID_STRESS_LARGE_TIER_CHANCE = 0.25;

/**
 * Radius (px) of the rock-free pocket around the player spawn.
 *
 * The field is **stationary** (see {@link buildAsteroidStressSpawnEvents}), so
 * keeping every rock outside this pocket means the ship can never ram one: a
 * ram destroys a large/medium rock and splits it into two children, which
 * would change the measured load mid-window. The player does not move in a
 * measured run (no input, auto-fire disabled).
 */
export const GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS = 90;

/** Number of late-game enemies in the representative wave (two per archetype). */
export const GYM_ASTEROID_STRESS_WAVE_COUNT =
  GYM_PERFORMANCE_ARCHETYPE_KEYS.length * 2;

/** Wave grid columns (one column per archetype). */
export const GYM_ASTEROID_STRESS_WAVE_COLUMNS =
  GYM_PERFORMANCE_ARCHETYPE_KEYS.length;

/** Wave horizontal slot spacing (px). */
export const GYM_ASTEROID_STRESS_WAVE_SPACING_X = 120;

/** Wave vertical row spacing (px). */
export const GYM_ASTEROID_STRESS_WAVE_SPACING_Y = 60;

/** Wave formation base x (px): the two-row block is centred on the canvas. */
export const GYM_ASTEROID_STRESS_WAVE_START_X =
  (GAME_WIDTH -
    (GYM_ASTEROID_STRESS_WAVE_COLUMNS - 1) * GYM_ASTEROID_STRESS_WAVE_SPACING_X) /
  2;

/** Wave formation base y (px): the block sits above the asteroid field's middle. */
export const GYM_ASTEROID_STRESS_WAVE_START_Y = 50;

/**
 * Formation drift speed (px/s). Zero: the wave must stay put for the whole
 * measured window so the load cannot change.
 */
export const GYM_ASTEROID_STRESS_WAVE_DRIFT_SPEED = 0;

/** Player spawn (bottom centre), mirroring the other combat gyms. */
export const GYM_ASTEROID_STRESS_PLAYER_SPAWN = {
  x: GAME_WIDTH / 2,
  y: GAME_HEIGHT - 40,
} as const;

/** Overlay refresh interval (ms) — 4 Hz, off the measured hot path. */
export const GYM_ASTEROID_STRESS_OVERLAY_INTERVAL_MS = 250;

/** `name` of the stress overlay text object (stable selector for tests). */
export const GYM_ASTEROID_STRESS_OVERLAY_NAME = 'asteroid-stress-gym-overlay';

/** Overlay text style (top-left, monospace, neon). */
const OVERLAY_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '13px',
  color: '#00ff88',
  backgroundColor: '#101010',
  padding: { x: 8, y: 6 },
};

/**
 * Moves a planned rock just outside the player's safe pocket, keeping it
 * inside the playfield. Pure and deterministic.
 *
 * The rock is first pushed radially away from the player spawn. A push that
 * would leave the field (the ship sits near the bottom edge, so "away" can
 * mean "off screen") is clamped by the edge margin, and if the clamped point
 * still lies in the pocket the rock is placed on the pocket's upper boundary
 * instead — every returned point is at least
 * {@link GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS} from the ship, inside the
 * field, and strictly off the bottom edge (so the shared wrap never relocates
 * it to the top).
 */
function keepClearOfPlayer(x: number, y: number): { x: number; y: number } {
  const { x: px, y: py } = GYM_ASTEROID_STRESS_PLAYER_SPAWN;
  const clampX = (value: number): number =>
    Math.min(GAME_WIDTH - FIELD_EDGE_MARGIN, Math.max(FIELD_EDGE_MARGIN, value));
  const clampY = (value: number): number =>
    Math.min(GAME_HEIGHT - FIELD_EDGE_MARGIN, Math.max(FIELD_EDGE_MARGIN, value));

  const dx = x - px;
  const dy = y - py;
  const distance = Math.hypot(dx, dy);
  if (distance >= GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS) {
    return { x: clampX(x), y: clampY(y) };
  }

  const nx = distance > 0 ? dx / distance : 0;
  const ny = distance > 0 ? dy / distance : -1;
  const movedX = clampX(px + nx * GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS);
  let movedY = clampY(py + ny * GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS);
  if (
    Math.hypot(movedX - px, movedY - py) <
    GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS
  ) {
    // The clamp pulled the point back into the pocket: use its upper edge.
    movedY = py - GYM_ASTEROID_STRESS_PLAYER_SAFE_RADIUS;
  }
  return { x: movedX, y: movedY };
}

/** Hint line shown at the bottom of the gym. */
export const GYM_ASTEROID_STRESS_HINT =
  'STRESS — 200 asteroids + 12 late-game enemies (perf: npm run perf:measure -- --scene GymAsteroidStress)';

/**
 * Builds the deterministic asteroid-field spawn events.
 *
 * Pure and side-effect free apart from advancing the injected `rng`: index `i`
 * maps to a cell in a {@link GYM_ASTEROID_STRESS_GRID_COLUMNS}-wide row-major
 * lattice, then the rock is jittered inside its cell and given a mixed tier.
 * The result is exactly `count` events, so the scene's "200 live asteroids"
 * contract is this function's length.
 *
 * The events are shaped like the shared `computeSpawns` output so the shared
 * `createAsteroidFromEvent` materialiser can consume them unchanged; a stress
 * field is planned in one step (`timeFraction`/`timeSeconds` are 0) rather than
 * released over a wave window.
 *
 * **The rocks are stationary** (`vx`/`vy` are 0) so the field's composition
 * cannot change during the measured window: a moving rock can be rammed by the
 * ship, and a ram destroys a large/medium rock and splits it into two children.
 * The measured load is the *rendering* of the field (every rock still updates
 * its rotation through the shared `Asteroid` path), so freezing the positions
 * is scenario configuration only — the same permitted difference as the zero
 * formation drift in `GymPerformance`, not a copied or altered rule.
 *
 * @param rng — deterministic random source (returns `[0, 1)`).
 * @param count — number of rocks to plan.
 */
export function buildAsteroidStressSpawnEvents(
  rng: () => number,
  count: number = GYM_ASTEROID_STRESS_ASTEROID_COUNT,
): AsteroidSpawnEvent[] {
  const events: AsteroidSpawnEvent[] = [];
  if (count <= 0) return events;

  const columns = GYM_ASTEROID_STRESS_GRID_COLUMNS;
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellWidth = GAME_WIDTH / columns;
  const cellHeight = GAME_HEIGHT / rows;
  const usableWidth = Math.max(0, cellWidth - FIELD_EDGE_MARGIN * 2);
  const usableHeight = Math.max(0, cellHeight - FIELD_EDGE_MARGIN * 2);

  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / columns);
    const col = index % columns;
    const plannedX =
      col * cellWidth + FIELD_EDGE_MARGIN + rng() * usableWidth;
    const plannedY =
      row * cellHeight + FIELD_EDGE_MARGIN + rng() * usableHeight;
    const sizeTier: AsteroidSpawnEvent['sizeTier'] =
      rng() < GYM_ASTEROID_STRESS_LARGE_TIER_CHANCE ? 'large' : 'medium';
    const { x, y } = keepClearOfPlayer(plannedX, plannedY);
    events.push({
      sizeTier,
      // Stationary: the measured load must not decay (see the docblock).
      x,
      y,
      vx: 0,
      vy: 0,
      timeFraction: 0,
      timeSeconds: 0,
    });
  }
  return events;
}

/**
 * Builds the wave's formation config. `archetypesByEntity` is the closure seam
 * that lets `collectBullets` resolve an entity's archetype for the shared
 * firing dispatcher (an entity does not carry its config key).
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
    sceneKey: GYM_ASTEROID_STRESS_SCENE_KEY,
    buildOffsets: (count) =>
      buildStressGridOffsets(count, GYM_ASTEROID_STRESS_WAVE_COLUMNS),
    count: GYM_ASTEROID_STRESS_WAVE_COUNT,
    spacingX: GYM_ASTEROID_STRESS_WAVE_SPACING_X,
    spacingY: GYM_ASTEROID_STRESS_WAVE_SPACING_Y,
    driftSpeed: GYM_ASTEROID_STRESS_WAVE_DRIFT_SPEED,
    startX: GYM_ASTEROID_STRESS_WAVE_START_X,
    startY: GYM_ASTEROID_STRESS_WAVE_START_Y,
    statusLabel: 'late-game enemies',
    hintText: GYM_ASTEROID_STRESS_HINT,
    player: { ...GYM_ASTEROID_STRESS_PLAYER_SPAWN },
    // The measured scenario is *the field and the wave plus their fire*: the
    // wave boots already firing, through the shared dispatcher.
    shootEnabled: true,
    // No demonstration mineral field: the only load is the rocks and the wave.
    minerals: false,
    // No `timeoutDuration`: the shared wave timeout stays disabled, so the
    // wave never refreshes and the load cannot change mid-measurement.
    createEntity: (scene, x, y, offset) => {
      const key = archetypeForOffset(offset, GYM_ASTEROID_STRESS_WAVE_COLUMNS);
      const entity = createEnemyFromConfig(scene, configs.get(key)!, x, y, offset);
      archetypesByEntity.set(entity, key);
      return entity;
    },
    // Shared archetype→tryFire dispatch for the wave; the asteroid field is
    // spawned separately and never fires (an `Asteroid` is not registered
    // here, so it resolves to the no-op branch below).
    collectBullets: (entity, now) => {
      const key = archetypesByEntity.get(entity);
      if (!key) return [];
      return fireForEnemy<FormationSceneBullet>(entity, key, now);
    },
    // Asteroid split seam: a destroyed large/medium rock spawns two smaller
    // children through the shared helper the game and the other asteroid gyms
    // consume. With player auto-fire disabled the field normally cannot decay
    // — this keeps the behaviour correct if it is ever enabled.
    onEntityDestroyed: (entity) => {
      if (!(entity instanceof Asteroid)) return;
      const scene = entity.scene as
        | GymAsteroidStress
        | null;
      if (!scene) return;
      splitAsteroid({
        scene,
        parent: entity,
        register: (child) => scene.registerDynamicEntity(child),
      });
    },
  };
}

/**
 * 200 live asteroids plus a representative late-game wave — the reproducible
 * asteroid-rendering load.
 */
export class GymAsteroidStress extends GymFormationScene<
  EnemyEntity,
  FormationSceneBullet
> {
  /** Archetype of every wave entity (the field is asteroid-only). */
  private readonly archetypesByEntity: WeakMap<
    EnemyEntity,
    GymPerformanceArchetypeKey
  >;

  private stressOverlay: Phaser.GameObjects.Text | null = null;

  private overlayClockMs = 0;

  /** Seed of the deterministic asteroid field (capture setup seed, or default). */
  private fieldSeed = GYM_ASTEROID_STRESS_FIELD_SEED;

  constructor() {
    const archetypesByEntity = new WeakMap<
      EnemyEntity,
      GymPerformanceArchetypeKey
    >();
    super(buildFormationConfig(archetypesByEntity));
    this.archetypesByEntity = archetypesByEntity;
  }

  /**
   * Adopts the capture setup's seed for the asteroid field, through the same
   * shared `resolveSetupSeed` the base class uses for its content RNG, so a
   * scripted capture can reproduce a seeded field. A setup-less start keeps
   * the default seed (the field is deterministic either way).
   */
  override init(data?: SceneSetupState | null): void {
    super.init(data);
    const seed = resolveSetupSeed(data ?? null);
    this.fieldSeed = seed ?? GYM_ASTEROID_STRESS_FIELD_SEED;
  }

  override create(): void {
    super.create();
    this.spawnAsteroidField();
    // Reset the overlay throttle so a scene restart re-renders immediately.
    this.overlayClockMs = 0;
    this.stressOverlay = this.add
      .text(10, 10, '', OVERLAY_STYLE)
      .setDepth(200)
      .setName(GYM_ASTEROID_STRESS_OVERLAY_NAME);
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
    if (this.overlayClockMs >= GYM_ASTEROID_STRESS_OVERLAY_INTERVAL_MS) {
      this.overlayClockMs = 0;
      this.renderStressOverlay();
    }
  }

  /**
   * Player auto-fire is **disabled**: the scenario is "200 rocks plus the
   * wave alive", and a firing player would shoot the load down during the
   * measured window. Enemies still aim and fire at the live ship; disabling a
   * feature is the permitted gym difference (a divergent copy never is). See
   * `docs/GYM_PARITY.md`. Capture setups that grant weapons do not re-enable
   * it — the load must stay put.
   */
  protected override autoFireEnabled(): boolean {
    return false;
  }

  /**
   * Live entity counts the performance probe samples, matching `PlayScene`'s
   * report shape. Asteroids are counted as enemies by the shared seam — they
   * are hostiles — and this gym deliberately seeds no minerals.
   */
  override getPerformanceCounts(): PerformanceCounts {
    return {
      ...super.getPerformanceCounts(),
      minerals: this.getMinerals().length,
    };
  }

  /** Live counts for the harness/tests (alias of the probe seam). */
  get liveCounts(): PerformanceCounts {
    return this.getPerformanceCounts();
  }

  /** Number of live asteroids in the field (`Asteroid` entities). */
  getAsteroidCount(): number {
    return this.formationEntities.filter(
      (entity) => entity instanceof Asteroid && entity.alive,
    ).length;
  }

  /** Number of live late-game wave enemies (everything the field did not spawn). */
  getWaveCount(): number {
    return this.formationEntities.filter(
      (entity) => !(entity instanceof Asteroid) && entity.alive,
    ).length;
  }

  /** Archetype key of every wave entity, in spawn (grid) order. */
  get waveArchetypes(): GymPerformanceArchetypeKey[] {
    return this.formationEntities
      .filter((entity) => !(entity instanceof Asteroid))
      .map(
        (entity) =>
          this.archetypesByEntity.get(entity) ??
          GYM_PERFORMANCE_ARCHETYPE_KEYS[0],
      );
  }

  /** The overlay text currently displayed (empty before `create()`). */
  get stressOverlayText(): string {
    return this.stressOverlay?.text ?? '';
  }

  /**
   * Spawns the deterministic asteroid field through the shared
   * `createAsteroidFromEvent` materialiser (the same code the game's scheduled
   * asteroid hazard uses) and registers each rock with the live list so the
   * shared collision pass and the performance probe see it.
   */
  private spawnAsteroidField(): void {
    const rng = createSeededRng(this.fieldSeed);
    for (const event of buildAsteroidStressSpawnEvents(rng)) {
      this.registerDynamicEntity(createAsteroidFromEvent(this, event, rng));
    }
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
        `STRESS — ${GYM_ASTEROID_STRESS_ASTEROID_COUNT} asteroids + ${GYM_ASTEROID_STRESS_WAVE_COUNT} late-game enemies`,
        `FPS ${fpsText} | asteroids ${this.getAsteroidCount()} | wave ${this.getWaveCount()} | enemies ${counts.enemies} | enemy bullets ${counts.enemyBullets} | player bullets ${counts.playerBullets}`,
      ].join('\n'),
    );
  }
}
