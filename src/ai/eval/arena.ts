/**
 * Deterministic headless arena for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC1/AC5/AC6).
 *
 * The arena drives a real {@link BotPolicy} — the competent brain, the legacy
 * ladder, or any registered configuration — through the shipped
 * {@link AsteroidsModel} ship physics and the real human-like
 * {@link BotInputGovernor}, closed-loop over a **seed-derived** scenario. It
 * emits telemetry-shaped records (see {@link ./types}) so the existing
 * recording analysis produces the evaluation metrics.
 *
 * ## Determinism (AC5)
 *
 * Every entity position, every hazard cadence and the governor's thrust-press
 * jitter come from the run seed (`createSeededRng`), and the simulation never
 * reads the wall clock. Two {@link runArena} calls with the same policy and
 * config therefore produce byte-identical records. The run header's
 * `startedAt` is fixed at `0` for the same reason.
 *
 * ## Config-driven (AC1, AH-0MV81YPBG0028WNM)
 *
 * The arena consumes a resolved balance config ({@link ArenaBalanceConfig})
 * built through the shared config loaders — enemy archetypes, ship stats and
 * the difficulty curve — instead of hardcoding `['scout','diver','phaser']`,
 * a fixed fire cadence and a fixed ship config. Each hostile derives its
 * radius, hit points, fire cadence, bullet speed and shot probability from
 * its archetype's `EnemyConfig`; the ship physics come from `ShipConfig`;
 * and the difficulty curves set the campaign itself (see
 * {@link ArenaConfig.campaign}) or, in the seeded skirmish, how many hostile
 * waves the spawn reservoir holds. A CSV edit therefore measurably changes
 * simulated outcomes for the same seed.
 *
 * ## Fidelity boundary
 *
 * This is a *closed-loop headless arena*, not Phaser. It models the parts the
 * bot reasons about — player Newtonian physics, collectable/hazard positions,
 * auto-fire from the owned weapon loadout, enemy fire and collisions — so it
 * runs under Node/vitest in milliseconds. The **full-campaign** and
 * **per-level** modes additionally drive the shared wave/level sequencer and
 * upgrade-choice flow (below), so `waveReached`/`levelReached`/
 * `upgradesSelected` are populated from real runs. What stays simplified:
 * boss/mini-boss encounters (the boss trigger ends the run), formation
 * movement, VFX and all rendering, plus the weapon-output gaps listed under
 * "Player weapon fire" below. It is the evaluation harness's counterpart to
 * the browser capture path; both feed the same telemetry schema.
 *
 * ## Player weapon fire (AH-0MW5DV9I6001D4HN, AH-0MW5DVAME0062GQO)
 *
 * The arena fires from the run's **ownership context**, never from a fixed
 * cadence or a hardcoded bullet. {@link resolveWeaponLoadout} resolves the
 * always-active cannon (level 0) plus every permanent weapon grant the
 * hold-full choice flow recorded, at each grant's level-resolved upgrade
 * index — mirroring the shipped `Player.getActiveWeapons()` /
 * `getWeaponLevel()` semantics. Cadence comes from the resolved `fireRateMs`,
 * the projectile pattern from the resolved `offsets`/`sideOffsets`, and AOE
 * weapons (nova/mortar/arc) resolve their blast **at fire time** through the
 * shared `utils/aoe` geometry with `AOE_RADII[id] × level aoeRadius` (the
 * radius `resolveWeaponDefinition` produces). Every shot is pure geometry
 * over the existing seeded simulation, so the same seed + policy + build stays
 * byte-identical.
 *
 * **Modelled:** active permanent weapons (cannon + choice grants), their
 * levels, cadence (`fireRateMs`), pattern count/offsets/side offsets, bullet
 * lifetime, bullet size, damage multiplier, AOE radius/AOE damage, and the
 * AOE bullet clear at the blast radius.
 *
 * **Not modelled (documented, per the parent's fidelity boundary):** timed
 * field-pickup weapons (only permanent ownership fires; the arena's drop
 * model stays generic), homing arcs and chain jumps (the Arc resolves as one
 * radius blast with no hop path or along-path bullet clear), cluster split
 * trajectories, the Wave Laser's hitscan ray and the Options pods' orbits
 * (both fire as a travelling bullet), wall bounce, the max-hit-point pierce
 * budget, crit/status/knockback, per-weapon impact feedback, and the game's
 * beat clock (an integer tick interval derived from the same `fireRateMs`
 * replaces it — see {@link fireRateTicks}).
 *
 * ## Per-level campaign mode (AH-0MVLJFB1I0099X4Z)
 *
 * Setting {@link ArenaConfig.level} switches the arena to an **additive**
 * per-level campaign mode: it plays the **real campaign waves** of that level
 * — the shared `Formations.LEVELS` data through the level-scaling seam —
 * instead of the single-level spawn reservoir, and power-up supply comes from
 * the **real per-kill drop rule** (the shared `levelScaling` module, as the
 * game's `PlayScene` uses) rather than the seeded power-up reservoir. Wave
 * progression follows the level skeleton: wave `n+1` spawns the moment wave
 * `n` is wiped, and clearing the final wave emits `level_cleared`, so the
 * batch report's `levelReached` faithfully reflects the selected level.
 *
 * - {@link ArenaConfig.scaleLevels} defaults to `true` in this mode; `false`
 *   resolves the enemy-count multiplier and the per-kill drop chance to
 *   level 1, so a **pre-change baseline** is captured with the same harness
 *   code and seeds. Level 1 is the identity: scaling on/off runs
 *   byte-identically.
 * - **Determinism** is unchanged: every position, every shot-probability draw
 *   and every drop roll come from seeded streams (`createSeededRng`), so the
 *   same policy + config + seed ⇒ byte-identical records in per-level mode
 *   (and in baseline mode) exactly as in the skirmish.
 * - **Fidelity boundary** (same approximation as the rest of the arena):
 *   wave members are stationary hostiles whose stats come from their
 *   archetype's `EnemyConfig` — formation movement and Phaser spawner
 *   behaviour are not modelled. A wave's opt-in `ghosts`/`horde`/
 *   `centipede`/`laneTraffic` flags add those archetypes as ordinary
 *   config-driven hostiles so the roster matches the game's wave accounting.
 *   The asteroid shadow-hazard stays live (seeded, respawning) so the
 *   small-asteroid Extra Life roll is exercised.
 *
 * ## Full-campaign mode (AH-0MVD1RGKM005GW0C)
 *
 * Setting {@link ArenaConfig.campaign} plays the **whole shipped campaign**
 * through the shared core rather than a per-level slice:
 *
 * - `buildSequencedLevels(rows, defaultCandidatePool(), { seed })` builds the
 *   campaign from the resolved difficulty curves, honouring every wave's
 *   `fixed`/`curve`/`dynamic` generation mode, then
 *   {@link scaleCampaignLevelCounts} applies the shared level enemy-count
 *   scaling exactly once — the same build the game's
 *   `PlayScene.resolveCampaignLevels` runs.
 * - The shared {@link WaveManager} drives progression: `beginGame()`,
 *   `planSpawns(seededRng)` for each wave (plus the opt-in spawner archetypes,
 *   registered through the shared `registerDynamicSpawn` seam), and
 *   `onEnemyDestroyed()` for every non-asteroid kill. The arena owns no wave
 *   or level state of its own.
 * - The canonical `wave_start` (`{ level, waveNumber, waveCount }`),
 *   `wave_cleared`/`level_cleared` (the **now-current** wave/level, exactly as
 *   `runTelemetry` records them) and `boss_triggered` events are emitted from
 *   the manager's transitions, so `waveReached`/`levelReached` become real
 *   distributions in balance reports.
 * - Power-up supply uses the real per-kill drop rule at the **current**
 *   campaign level (the shared `levelScaling` curves), never a seeded
 *   reservoir.
 * - **Fidelity boundary (parent AC4):** clearing the final level triggers the
 *   boss encounter, which is treated as the **end of the run**. No boss or
 *   mini-boss entity is simulated this round; a mini-boss wave is its
 *   authored group composition. Determinism is unchanged: the campaign is a
 *   pure function of `(rows, candidates, seed)` and every draw is seeded.
 *
 * ## Hold-full upgrade choices (AH-0MVD1RIH2008YCNV)
 *
 * Minerals collect into the **shared {@link MineralHold} model** (capacity,
 * growth multiplier, overflow carry — the same model `GameState` and the
 * gyms use, seeded from the shipped rules or `config.hold`). When the hold
 * fills, the arena runs the **same shared choice flow the game ships**
 * (`chooseOptions(3, randomChoiceStrategy, seededRng, context)` from
 * `src/powerups/choice.ts`): it emits `hold_full` with the offered option
 * ids, the bot picks an option from the run's seeded RNG stream, the arena
 * emits `choice_selected` `{ index, id }`, applies the reward through the
 * shared `applyMineralChoiceReward` path (with the headless player adapter),
 * and resolves the hold (capacity grows, overflow carries).
 *
 * Rewards permanently affect the run: owned weapons/power-ups feed the
 * `choice` context, so later offers carry `weapon-level`/`power-up-level`
 * upgrades exactly as the game does, and the chosen weapon's **fire output**
 * is simulated from that ownership context (see "Player weapon fire" below).
 * **Fidelity boundary:** the arena does **not** model the non-weapon reward
 * effects — shield/effect timing and Extra Life lifegain — in the closed-loop
 * simulation.
 *
 * The offer/selection draws come from a **dedicated stream seeded from the
 * run seed** (like the campaign/sim streams), so the choice sequence is
 * reproducible per seed and never perturbs the scenario/behaviour draws.
 *
 * @module src/ai/eval/arena
 */

import { createSeededRng } from '../../core/rng';
import { MAX_LIVES } from '../../core/GameState';
import { loadBalanceConfig } from './balanceConfig';
import {
  applyEnemyCountScaling,
  clampLevel,
  extraLifeDropChance,
  powerUpDropChance,
  scaleCampaignLevelCounts,
} from '../../core/levelScaling';
import { enemyForceFieldHits } from '../../core/enemyForceField';
import { DEFAULT_RULES } from '../../core/rules';
import { defaultCandidatePool } from '../../core/difficultySequencer';
import { isNonBlockingHazard } from '../../scenes/core/waveTimeout';
import {
  getLevelDefinition,
  type LevelDefinition,
  type WaveDefinition,
} from '../../waves/Formations';
import { WaveManager, type WaveEvent } from '../../waves/WaveManager';
import { buildSequencedLevels } from '../../waves/sequencedLevels';
import { GHOST_ENEMY_KEYS } from '../../waves/GhostSpawner';
import { GRUNT_ENEMY_KEY } from '../../waves/HordeSpawner';
import { CENTIPEDE_ENEMY_KEY } from '../../waves/CentipedeSpawner';
import { LANE_TRAFFIC_ENEMY_KEY } from '../../waves/LaneTrafficSpawner';
import type { DifficultyCurveRow, EnemyConfig, ShipConfig } from '../../core/configTypes';
import { MineralHold } from '../../core/mineralHold';
import { PowerUpLevelStore } from '../../powerups/powerUpLevels';
import { EffectsRegistry } from '../../powerups/effects';
import {
  chooseOptions,
  createRandomChoiceStrategy,
  randomChoiceStrategy,
  type ChoiceContext,
} from '../../powerups/choice';
import { applyMineralChoiceReward, type MineralChoicePlayer } from '../../powerups/choiceReward';
import type { PowerUpId } from '../../powerups/types';
import {
  createBulletsFromHeading,
  WEAPON_CATALOGUE,
  type AoEDescriptor,
  type WeaponDefinition,
  type WeaponId,
} from '../../utils/weapons';
import {
  resolveWeaponAtLevel,
  resolveWeaponDefinition,
  type WeaponLevelStats,
} from '../../utils/weaponLevels';
import {
  isInAoEArea,
  selectAoETargets,
  selectRandomPoint,
} from '../../utils/aoe';
import { PLAYER_BULLET_RADIUS, PLAYER_BULLET_SPEED } from '../../core/constants';
import { AsteroidsModel } from '../../utils/movementModel';
import { wrapAxis, wrappedAxisDelta } from '../../utils/wrapGeometry';
import { scaleShipConfigForHull } from '../../core/hangarWar/hullSpeed';
import type {
  AsteroidsConfig,
  AsteroidsInput,
  BaseMovementConfig,
  RotatingMovementState,
} from '../../utils/movementModel';
import type { BotSnapshot } from '../botSnapshot';
import type { BotPolicy } from '../framework/botBrain';
import { BotInputGovernor } from '../botHumanLike';
import {
  DEFAULT_ARENA_SPAWNS,
  EVAL_TELEMETRY_SCHEMA_VERSION,
  type ArenaBalanceConfig,
  type ArenaConfig,
  type ArenaInput,
  type ArenaRunResult,
  type ArenaSpawns,
  type ArenaState,
  type EvalBuild,
  type TelemetryEventRecord,
  type TelemetryRecord,
} from './types';

/** Fixed simulation step when the config omits one (~60 fps). */
const DEFAULT_DT = 1 / 60;
const DEFAULT_WIDTH = 960;
const DEFAULT_HEIGHT = 540;

/** Player collision/life model. */
const PLAYER_HIT_RADIUS = 14;
const PLAYER_START_LIVES = 3;
/** Ticks of invulnerability after a hit (1.5 s at 60 fps). */
const INVULNERABLE_TICKS = 90;
/** Distance at which a collectable is scooped up (matches the bot tunable). */
const COLLECT_RADIUS = 18;
/** Ticks between replenishing the collectable/hostile reservoirs. */
const COLLECTABLE_RESPAWN_TICKS = 150;
const HOSTILE_RESPAWN_TICKS = 240;
/** Enemy-bullet lifetime (seconds), matching the game's enemy-bullet default. */
const ENEMY_BULLET_LIFETIME = 1.5;
/**
 * Ticks a freshly spawned hostile waits before its first volley (arena
 * tuning — a small grace period so the opening is not instantly lethal).
 */
const HOSTILE_FIRE_WARMUP_TICKS = 40;
/** Hostile "waves" in the reservoir when the difficulty curve is empty. */
const DEFAULT_HOSTILE_WAVES = 2;
/**
 * Defensive fallbacks when a resolved enemy config is absent or carries a
 * degenerate value (should not happen: the store coerces sane values).
 */
const FALLBACK_HOSTILE_RADIUS = 16;
const FALLBACK_FIRE_INTERVAL_MS = 1200;
const FALLBACK_ENEMY_BULLET_SPEED = 200;

const asteroidModel = new AsteroidsModel();

interface Vec {
  x: number;
  y: number;
}

interface Hostile {
  id: number;
  x: number;
  y: number;
  alive: boolean;
  archetype: string;
  isAsteroid: boolean;
  /**
   * Campaign wave index this hostile belongs to; `-1` for hostiles outside
   * wave accounting (the seeded reservoir and the asteroid shadow-hazard).
   */
  wave: number;
  /** Body-collision radius in px, from the archetype's config `size`. */
  radius: number;
  /** Remaining hit points (config `health`); reaches 0 → destroyed. */
  health: number;
  /**
   * Remaining **force-field** hits (epic AH-0MVJ8W4GE007OMNT), resolved at
   * spawn from the shared `enemyForceFieldHits(level, config)` curve — the
   * same resolver the game and the level gym use. Barrier hits are spent
   * **before** the hull: a player bullet that hits a shielded hostile
   * decrements `fieldHits` and leaves `health` untouched, mirroring
   * `BaseEnemy.takeDamage` (barrier first, hull second). `0` = unshielded.
   */
  fieldHits: number;
  /** Ticks between fire volleys, derived from config `fireInterval` (ms). */
  fireTicks: number;
  /** Ticks until this hostile next fires; never fires when `isAsteroid`. */
  fireCooldown: number;
  /** Projectile speed (px/s) from config `bulletSpeed`. */
  bulletSpeed: number;
  /** Chance (0..1) of firing per cycle, from config `shotProbability`. */
  shotProbability: number;
  /**
   * Body radius for the shared AOE geometry (`utils/aoe`), so a blast catches
   * a hostile when its edge intersects the effect area (AH-0MW5DVAME0062GQO).
   */
  getHitRadius(): number;
}

interface Bullet extends Vec {
  vx: number;
  vy: number;
  /** Lifetime in seconds (game parity: player 0.75 s, enemy 1.5 s). */
  lifetime: number;
  /** Seconds elapsed since creation. */
  elapsed: number;
}

/**
 * A player projectile: a {@link Bullet} whose size and damage come from the
 * resolved weapon definition (AH-0MW5DV9I6001D4HN). Hostile bullets carry
 * neither — they only ever hit the player, and collide as points.
 */
interface PlayerBullet extends Bullet {
  /**
   * Collision radius in px (`PLAYER_BULLET_RADIUS × levelBulletSize`) — the
   * size the game's player bullet spawns with.
   */
  radius: number;
  /**
   * Damage dealt to a hostile hull on a non-barrier hit, from the resolved
   * weapon's `damage` multiplier (1 at the base level).
   */
  damage: number;
}

/** A seed-derived hostile spec held in the spawn reservoir. */
interface HostileSpec {
  x: number;
  y: number;
  archetype: string;
  isAsteroid: boolean;
}

/** The internal mutable arena state. */
interface ArenaWorld {
  player: { x: number; y: number; vx: number; vy: number; facing: number; angularVelocity: number };
  lives: number;
  invulnerableTicks: number;
  minerals: Vec[];
  drops: Vec[];
  hostiles: Hostile[];
  playerBullets: PlayerBullet[];
  enemyBullets: Bullet[];
  /** The run-scoped shared mineral hold (capacity/growth/overflow). */
  hold: MineralHold;
}

/** Coerces a finite positive number, else `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

/**
 * Converts a resolved weapon cadence (`fireRateMs`) into an integer tick
 * interval for the headless harness (AH-0MW5DV9I6001D4HN).
 *
 * Documented harness divergence: the game schedules shots on the shared beat
 * clock (`Player.tryFire` resolves Euclidean onsets on the beat lattice),
 * while a fixed-step simulation has no beat clock. Deriving the interval from
 * the **same** resolved `fireRateMs` keeps the harness's fire output a
 * function of the shared weapon data — the cadence lever the sensitivity
 * tests need — and stays seed-deterministic (no clock, no RNG).
 */
function fireRateTicks(fireRateMs: number, dt: number): number {
  const ticks = Math.round(fireRateMs / 1000 / dt);
  return Number.isFinite(ticks) && ticks > 0 ? ticks : 1;
}

/** Resolves the full spawn config from a partial override. */
function resolveSpawns(partial: Partial<ArenaSpawns> | undefined): ArenaSpawns {
  return {
    minerals: Math.max(0, Math.trunc(partial?.minerals ?? DEFAULT_ARENA_SPAWNS.minerals)),
    powerUps: Math.max(0, Math.trunc(partial?.powerUps ?? DEFAULT_ARENA_SPAWNS.powerUps)),
    enemies: Math.max(0, Math.trunc(partial?.enemies ?? DEFAULT_ARENA_SPAWNS.enemies)),
    asteroids: Math.max(0, Math.trunc(partial?.asteroids ?? DEFAULT_ARENA_SPAWNS.asteroids)),
  };
}

/** Euclidean distance between two points. */
function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Advances a bullet's position by `dt` and wraps it at all four edges — the
 * game's bullet model (AH-0MU960UTE001PTV0). Exported so the wrap parity is
 * directly testable per edge (AH-0MVT2W5EL004OXNN).
 */
export function advanceBulletPosition(
  bullet: Vec,
  vx: number,
  vy: number,
  dt: number,
  width: number,
  height: number,
): void {
  bullet.x = wrapAxis(bullet.x + vx * dt, width);
  bullet.y = wrapAxis(bullet.y + vy * dt, height);
}

/**
 * The velocity a hostile fires along: the shortest wrapped route to the
 * player, so a hostile near one edge shoots across the seam at a player near
 * the opposite edge (AH-0MVT2W5EL004OXNN). Delegates to the shared torus
 * maths — the eval layer carries no second seam implementation.
 */
export function hostileAimVelocity(
  from: Vec,
  to: Vec,
  speed: number,
  width: number,
  height: number,
): { vx: number; vy: number } {
  const dx = wrappedAxisDelta(from.x, to.x, width);
  const dy = wrappedAxisDelta(from.y, to.y, height);
  const length = Math.hypot(dx, dy) || 1;
  return { vx: (dx / length) * speed, vy: (dy / length) * speed };
}

/** Clamps a probability into [0, 1]. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Maps the shared CSV-backed {@link ShipConfig} onto the movement model's
 * {@link AsteroidsConfig} (config-driven arena, AH-0MV81YPBG0028WNM). The
 * forward-thrust and rotation tunables map 1:1; the Asteroids-scheme reverse
 * thruster (AH-0MV13LXOR001X15X) is carried through so the governor's
 * reverse input behaves like the shipped ship.
 */
function shipToAsteroidsConfig(ship: ShipConfig): AsteroidsConfig {
  return {
    thrust: ship.thrustAcceleration,
    maxSpeed: ship.maxSpeed,
    friction: ship.frictionDeceleration,
    rotationSpeed: ship.asteroidsRotationSpeed,
    rotationAcceleration: ship.asteroidsRotationAcceleration,
    rotationDeceleration: ship.asteroidsRotationDeceleration,
    reverseEnabled: ship.asteroidsReverseEnabled,
    reverseAcceleration: ship.asteroidsReverseThrustAcceleration,
    reverseMaxSpeed: ship.asteroidsReverseMaxSpeed,
  };
}

/**
 * The enemy archetypes the arena seeds into its skirmish, from the resolved
 * balance config — no hardcoded `['scout','diver','phaser']`. Spawner-
 * delivered archetypes — the asteroid (dedicated offscreen spawner, not
 * wave-accounted), the grunt homing horde and the harvester — are excluded,
 * mirroring the auto-sequencer's candidate-pool rationale
 * (`src/core/difficultySequencer.ts` `defaultCandidatePool`). The order is
 * the store's sorted key order, so the selection is deterministic per config.
 */
function arenaArchetypes(enemies: readonly EnemyConfig[]): string[] {
  const excluded = new Set(['asteroid', 'grunt', 'harvester']);
  const keys = enemies.map((enemy) => enemy.key).filter((key) => !excluded.has(key));
  return keys.length > 0 ? keys : ['scout'];
}

/**
 * The number of hostile "waves" the reservoir holds, taken from the opening
 * level's difficulty-curve row count (each row is one wave of the campaign
 * skeleton). Falls back to {@link DEFAULT_HOSTILE_WAVES} when the curve is
 * empty or unreadable, so a missing config keeps the historical two-wave
 * skirmish. Deterministic: derived from the curve, never the wall clock.
 */
function openingHostileWaves(
  curve: readonly DifficultyCurveRow[],
  fallback = DEFAULT_HOSTILE_WAVES,
): number {
  if (curve.length === 0) return fallback;
  const openingLevel = curve[0].level;
  const rows = curve.filter((row) => row.level === openingLevel).length;
  return Math.max(1, rows);
}

/** Indexes the resolved enemy configs by key for hostile lookups. */
function enemiesByKey(enemies: readonly EnemyConfig[]): Map<string, EnemyConfig> {
  const map = new Map<string, EnemyConfig>();
  for (const enemy of enemies) map.set(enemy.key, enemy);
  return map;
}

/**
 * Builds the shipped campaign the arena plays in **full-campaign mode**.
 *
 * The campaign is `buildSequencedLevels` over the resolved difficulty curves
 * (honouring every wave's `fixed`/`curve`/`dynamic` generation mode), seeded
 * with the run seed so `dynamic` waves regenerate per run, then the shared
 * level-scaling seam applied **exactly once** — the same build
 * `PlayScene.resolveCampaignLevels` runs.
 *
 * Exported so a consumer that plays a **slice** of the campaign (the ring
 * timing harness deploys at a hex's aggression-selected level, exactly as
 * `PlayScene.beginGame(startLevel)` does) builds the same campaign instead of
 * copying the construction. Passing the slice through
 * {@link ArenaConfig.campaignLevels} keeps the arena's wave/level progression
 * on the shared {@link WaveManager}.
 *
 * @param seed — the run seed (drives `dynamic` wave generation).
 * @param balance — the resolved balance config (difficulty curves).
 * @returns the shipped campaign, levels in order.
 */
export function buildArenaCampaign(
  seed: number,
  balance: ArenaBalanceConfig,
): LevelDefinition[] {
  return scaleCampaignLevelCounts(
    buildSequencedLevels(
      [...balance.difficultyCurves],
      defaultCandidatePool(),
      { seed },
    ),
    DEFAULT_RULES,
  );
}

/**
 * The campaign a deployment plays: the shipped campaign from `startLevel` to
 * its end.
 *
 * A hangar deployment starts the classic run at the target hex's
 * aggression-selected level and plays on (`PlayScene.beginGame(startLevel)`),
 * so a deployment's arena counterpart is the campaign **slice** from that
 * level. The slice keeps every level's original `level` number, so the shared
 * `WaveManager` reports the same levels as the full campaign.
 *
 * @param campaign — the shipped campaign (see {@link buildArenaCampaign}).
 * @param startLevel — the 1-based campaign level to start at.
 * @returns the campaign from `startLevel` on (empty only for an empty input).
 */
export function campaignFromLevel(
  campaign: readonly LevelDefinition[],
  startLevel: number,
): LevelDefinition[] {
  const index = campaign.findIndex((level) => level.level >= startLevel);
  return index < 0 ? [...campaign] : campaign.slice(index);
}

/** Ticks between fire volleys for a config fire interval (ms). */
function fireIntervalTicks(ms: number, dt: number): number {
  return Math.max(1, Math.round(Math.max(0, ms) / 1000 / dt) || 1);
}

/**
 * Builds the seed-derived spawn reservoirs. Positions are laid out on a
 * margin inside the playfield so the bot has to travel to reach them.
 */
function buildSpawnPlan(
  seed: number,
  width: number,
  height: number,
  spawns: ArenaSpawns,
  archetypes: readonly string[],
  hostileWaves: number,
): {
  mineralReservoir: Vec[];
  powerUpReservoir: Vec[];
  hostileReservoir: HostileSpec[];
} {
  const rng = createSeededRng(seed);
  const margin = 60;
  const point = (): Vec => ({
    x: margin + rng() * (width - margin * 2),
    y: margin + rng() * (height - margin * 2),
  });

  // Three waves of collectables per target count, so a long run keeps refilling.
  const mineralReservoir = Array.from({ length: spawns.minerals * 3 }, point);
  const powerUpReservoir = Array.from({ length: spawns.powerUps * 3 }, point);

  // Config-driven hostile waves (AH-0MV81YPBG0028WNM): the difficulty-curve
  // opening level's row count sets how many hostile waves the reservoir
  // holds. The first wave carries the requested enemy/asteroid split; later
  // waves refill with a mixed composition so a long run stays populated.
  const hostileReservoir: HostileSpec[] = [];
  const total = spawns.enemies + spawns.asteroids;
  for (let wave = 0; wave < hostileWaves; wave += 1) {
    const length = wave === 0 ? total : Math.ceil(total / 2);
    for (let i = 0; i < length; i += 1) {
      const isAsteroid =
        wave === 0 ? i >= spawns.enemies : i % 2 === 0 && spawns.asteroids > 0;
      hostileReservoir.push({
        ...point(),
        archetype: isAsteroid ? 'asteroid' : archetypes[i % archetypes.length],
        isAsteroid,
      });
    }
  }

  return { mineralReservoir, powerUpReservoir, hostileReservoir };
}

/** A per-level campaign wave plan: one `HostileSpec[]` per wave, in play order. */
type LevelWavePlan = readonly (readonly HostileSpec[])[];

/**
 * A seeded field position drawn from a stream, inset from the playfield edge
 * (the same margin the spawn reservoirs use).
 */
function seededPoint(rng: () => number, width: number, height: number): Vec {
  const margin = 60;
  return {
    x: margin + rng() * (width - margin * 2),
    y: margin + rng() * (height - margin * 2),
  };
}

/** Draws `count` seeded field positions from a stream. */
function seededFieldPoints(
  rng: () => number,
  count: number,
  width: number,
  height: number,
): Vec[] {
  return Array.from({ length: count }, () => seededPoint(rng, width, height));
}

/**
 * The spawner-delivered archetypes a wave opts into, in the game's spawn
 * order (`horde`, `ghosts`, `centipede`, `laneTraffic`), one key per
 * config-driven hostile in the arena's simplified accounting.
 */
function waveSpawnerExtras(wave: WaveDefinition | null): string[] {
  if (!wave) return [];
  const extras: string[] = [];
  if (wave.horde) extras.push(GRUNT_ENEMY_KEY);
  if (wave.ghosts) extras.push(...GHOST_ENEMY_KEYS);
  if (wave.centipede) extras.push(CENTIPEDE_ENEMY_KEY);
  if (wave.laneTraffic) extras.push(LANE_TRAFFIC_ENEMY_KEY);
  return extras;
}

/**
 * Builds the per-level campaign fleet for an explicit level
 * (AH-0MVLJFB1I0099X4Z) from the **real** `Formations.LEVELS` data: every
 * wave's groups (scaled through the shared level-scaling seam when `scale`
 * is true) plus the spawner-delivered archetypes the wave opts in to
 * (`ghosts` / `horde` / `centipede` / `laneTraffic`), one seeded position
 * per hostile, in wave order — the same wave skeleton the game plays.
 * Returns an empty plan for a level with no definition.
 *
 * `definition` is the deployment seam (AH-0MWCQ4FWN009J9DM): a caller that
 * plays a **hex deployment** passes the truncated five-wave sortie (the
 * level's first four regular waves plus the wave-5 mini-boss composition,
 * `truncateCampaignForDeployment`), so the arena plays exactly the wave set
 * the game plays while `level` still drives scaling, drops and the
 * `level_cleared` payload. Absent → the authored level.
 */
function buildLevelWavePlan(
  level: number,
  scale: boolean,
  seed: number,
  width: number,
  height: number,
  definition: LevelDefinition | null = getLevelDefinition(level),
): LevelWavePlan {
  if (!definition) return [];
  const rng = createSeededRng(seed);
  const pushGroup = (members: HostileSpec[], archetype: string, count: number): void => {
    for (let i = 0; i < count; i += 1) {
      members.push({ ...seededPoint(rng, width, height), archetype, isAsteroid: false });
    }
  };
  return definition.waves.map((wave) => {
    const members: HostileSpec[] = [];
    const scaledGroups = scale
      ? applyEnemyCountScaling(level, wave.groups, DEFAULT_RULES)
      : wave.groups;
    for (const group of scaledGroups) {
      pushGroup(members, group.enemyKey, Math.max(1, Math.trunc(group.count)));
    }
    for (const key of waveSpawnerExtras(wave)) pushGroup(members, key, 1);
    return members;
  });
}

/**
 * The life count a launch loadout's `lives` resolves to (AH-0MW9QA2YC009PSF5).
 *
 * A launch loadout is model/data input, not a value the arena can trust: a
 * missing, non-finite or non-positive count falls back to the arena's shipped
 * {@link PLAYER_START_LIVES}, and a valid count is truncated and capped at
 * {@link MAX_LIVES} — the run's own cap — so a malformed or absurd loadout
 * degrades to a playable run instead of crashing it or starting an uncapped
 * one. Mirrors the hangar deployment model's `1..MAX_LIVES` clamp
 * (`resolveDeploymentLoadout` in `src/ai/eval/ringTiming.ts`).
 *
 * @param lives — the loadout's requested life count, if any.
 * @returns the life count the world starts with (always in `1..MAX_LIVES`).
 */
export function resolveStartingLives(lives: number | undefined): number {
  if (typeof lives !== 'number' || !Number.isFinite(lives) || lives < 1) {
    return PLAYER_START_LIVES;
  }
  return Math.min(MAX_LIVES, Math.trunc(lives));
}

/**
 * Builds a fresh world: the player starts centred, facing right.
 *
 * `startingLives` is the launch loadout's life count (a hull's run stat plus
 * its `extra-lives` modifiers, AH-0MW9QA2YC009PSF5); omitted it keeps the
 * arena's own {@link PLAYER_START_LIVES}.
 */
function createWorld(
  width: number,
  height: number,
  hold: MineralHold,
  startingLives: number = PLAYER_START_LIVES,
): ArenaWorld {
  return {
    player: {
      x: width / 2,
      y: height / 2,
      vx: 0,
      vy: 0,
      facing: 0,
      angularVelocity: 0,
    },
    lives: startingLives,
    invulnerableTicks: 0,
    minerals: [],
    drops: [],
    hostiles: [],
    playerBullets: [],
    enemyBullets: [],
    hold,
  };
}

/** Copies the world into the opaque snapshot shape the bot consumes. */
function snapshotOf(
  world: ArenaWorld,
  enemies: readonly Hostile[],
  seed: number,
): BotSnapshot {
  return {
    player: {
      x: world.player.x,
      y: world.player.y,
      vx: world.player.vx,
      vy: world.player.vy,
    },
    enemies: enemies
      .filter((hostile) => hostile.alive)
      .map((hostile) => ({
        x: hostile.x,
        y: hostile.y,
        alive: true,
        archetype: hostile.archetype,
      })),
    enemyBullets: world.enemyBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    playerBullets: world.playerBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: world.drops.map((drop, index) => ({
      x: drop.x,
      y: drop.y,
      type: index % 2 === 0 ? 'spread' : 'shield',
    })),
    minerals: world.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: 'mineral',
    })),
    boss: null,
    aliveCount: enemies.filter((hostile) => hostile.alive).length,
    wave: null,
    runSeed: seed,
    lives: world.lives,
    livesCap: MAX_LIVES,
  };
}

/** Copies the world state into the telemetry `state` payload. */
function stateOf(world: ArenaWorld): ArenaState {
  return {
    player: {
      x: world.player.x,
      y: world.player.y,
      vx: world.player.vx,
      vy: world.player.vy,
      facing: world.player.facing,
    },
    enemies: world.hostiles
      .filter((hostile) => hostile.alive)
      .map((hostile) => ({
        x: hostile.x,
        y: hostile.y,
        alive: true,
        archetype: hostile.archetype,
      })),
    enemyBullets: world.enemyBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    playerBullets: world.playerBullets.map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: world.drops.map((drop, index) => ({
      x: drop.x,
      y: drop.y,
      type: index % 2 === 0 ? 'spread' : 'shield',
    })),
    minerals: world.minerals.map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: 'mineral',
    })),
    hold: { minerals: world.hold.store, capacity: world.hold.capacity },
    boss: null,
  };
}

/**
 * Headless run-scoped ownership for the hold-full choice (AC3) — the
 * arena's counterpart to the game's {@link Player} weapon/power-up level
 * stores. Rewards are applied through the **shared**
 * {@link applyMineralChoiceReward} path; this object only *records* the
 * resulting ownership so later offers carry accurate `weapon-level` /
 * `power-up-level` context (no invented option model in `src/ai/eval/`).
 *
 * Mirrors the game's semantics: a permanent weapon grant raises the owned
 * level by one (like `Player.equipWeapon(id, true)`), and power-up levels
 * live in the same shared {@link PowerUpLevelStore} the `EffectsRegistry`
 * consumes.
 */
export class HeadlessChoicePlayer implements MineralChoicePlayer {
  readonly powerUpStore = new PowerUpLevelStore();
  private readonly _weaponLevels = new Map<WeaponId, number>();

  /** Permanent weapon grants raise the run-scoped level by one (AC3). */
  equipWeapon(weaponId: WeaponId, permanent = false): void {
    if (!permanent) return;
    // An id the catalogue does not itemise is dropped, exactly like the shipped
    // `Player.equipWeapon` (AH-0MW9QA2YC009PSF5): a launch loadout is model/data
    // input, so a stale id must degrade to "not owned" rather than crash the
    // run later in `resolveWeaponLoadout` (`getWeaponById` throws on it).
    if (!WEAPON_CATALOGUE[weaponId]) return;
    this._weaponLevels.set(
      weaponId,
      (this._weaponLevels.get(weaponId) ?? 0) + 1,
    );
  }

  /** Owned weapon levels (id → level ≥ 1), the choice context shape. */
  getWeaponLevels(): Array<{ id: WeaponId; level: number }> {
    return [...this._weaponLevels.entries()].map(([id, level]) => ({
      id,
      level,
    }));
  }

  /** Owned power-up levels (id → level ≥ 1), from the shared store. */
  getPowerUpLevels(): Array<{ id: PowerUpId; level: number }> {
    return this.powerUpStore.getLevels();
  }

  /** The `ChoiceContext` the shared flow consumes for offers. */
  context(): ChoiceContext {
    return {
      weaponLevels: this.getWeaponLevels(),
      powerUpLevels: this.getPowerUpLevels(),
    };
  }
}

/**
 * One weapon the arena fires, resolved from the run's ownership context
 * (AH-0MW5DVAME0062GQO).
 */
export interface ArenaWeaponLoadout {
  /** The catalogued weapon id. */
  readonly id: WeaponId;
  /**
   * The **owned** level as the choice flow records it: `0` for the
   * always-active cannon, otherwise the permanent grant count
   * (`getWeaponLevels()`).
   */
  readonly ownedLevel: number;
  /**
   * The **upgrade index** the shared resolvers are called with:
   * `max(0, ownedLevel − 1)`, mirroring `Player._weaponUpgradeIndex`
   * (`collections − 1`), so a weapon's first permanent grant fires at its
   * base stats exactly as it does in the game.
   */
  readonly level: number;
  /** The level-resolved catalogue definition (pattern, cadence, AOE). */
  readonly definition: WeaponDefinition;
  /** The level-resolved scalar statistics (damage, `aoeRadius`, …). */
  readonly stats: WeaponLevelStats;
}

/** The two shared-resolver outputs for one `(weapon, level)` pair. */
interface ResolvedWeapon {
  definition: WeaponDefinition;
  stats: WeaponLevelStats;
}

/**
 * Resolves the arena's fire loadout from the run's ownership context
 * (AH-0MW5DVAME0062GQO): the **always-active cannon** at upgrade level 0 plus
 * one entry per permanent weapon grant recorded by the hold-full choice flow,
 * in the context's order — mirroring `Player.getActiveWeapons()` (cannon
 * first) and `Player.getWeaponLevel()` / `_weaponUpgradeIndex`.
 *
 * Every entry is resolved through the **shared** `resolveWeaponDefinition` /
 * `resolveWeaponAtLevel` seams, so the fire model reads the one weapon
 * catalogue and level curves the game reads (gym↔game parity,
 * AH-0MUGZDTFX004RBD1). Timed field-pickup weapons never appear here: the
 * arena models permanent ownership only (see the module's fidelity boundary).
 *
 * Pure and deterministic. The optional `cache` lets a long run memoise the
 * resolved pair per `(id, level)` — a level change is the only invalidation a
 * run needs, and the key includes the level.
 *
 * @param owned - The run's permanent weapon grants (id → level ≥ 1).
 * @param cache - Optional per-run resolution cache.
 */
export function resolveWeaponLoadout(
  owned: ReadonlyArray<{ id: WeaponId; level: number }> = [],
  cache: Map<string, ResolvedWeapon> = new Map(),
): ArenaWeaponLoadout[] {
  // The cannon is always active at its base level, exactly like the game's
  // `Player._permanentWeapons = new Set(['cannon'])`.
  const ownedLevels = new Map<WeaponId, number>([['cannon', 0]]);
  for (const { id, level } of owned) {
    // Defensive merge: the choice flow records one entry per weapon, but a
    // duplicate must never make a weapon fire twice or lose an earned level.
    const current = ownedLevels.get(id) ?? 0;
    ownedLevels.set(
      id,
      Number.isFinite(level) ? Math.max(current, Math.max(0, Math.floor(level))) : current,
    );
  }
  return [...ownedLevels.entries()].map(([id, ownedLevel]) => {
    const level = Math.max(0, ownedLevel - 1);
    const key = `${id}:${level}`;
    let resolved = cache.get(key);
    if (!resolved) {
      resolved = {
        definition: resolveWeaponDefinition(id, level),
        stats: resolveWeaponAtLevel(id, level),
      };
      cache.set(key, resolved);
    }
    return { id, ownedLevel, level, ...resolved };
  });
}

/**
 * Runs one headless arena run for `policy` (AC1).
 *
 * The returned {@link ArenaRunResult.records} are telemetry-shaped and can be
 * parsed by `scripts/recording.mjs` / analysed by
 * `scripts/recording-analysis.mjs`. The run is deterministic in `config.seed`
 * and the policy's own decision sequence (AC5).
 */
export function runArena(policy: BotPolicy, config: ArenaConfig): ArenaRunResult {
  const dt = positiveOr(config.dt, DEFAULT_DT);
  const width = positiveOr(config.width, DEFAULT_WIDTH);
  const height = positiveOr(config.height, DEFAULT_HEIGHT);
  const sampleEvery = Math.max(1, Math.trunc(positiveOr(config.sampleEveryTicks, 1)));
  const build: EvalBuild = config.build ?? { appVersion: '0.0.0-eval', commit: 'eval' };
  const spawns = resolveSpawns(config.spawns);
  // Config-driven (AH-0MV81YPBG0028WNM): consume the resolved balance config
  // (enemy archetypes, ship, difficulty curves) through the shared config
  // loaders — never a hardcoded copy of enemy/ship/wave stats.
  const balance = config.balance ?? loadBalanceConfig();
  const enemyByKey = enemiesByKey(balance.enemies);
  const archetypes = arenaArchetypes(balance.enemies);
  const hostileWaves = openingHostileWaves(balance.difficultyCurves);
  // The launch loadout (AH-0MW9QA2YC009PSF5): a hangar deployment does not
  // start from the arena's bare defaults, so the hull's speed multiplier scales
  // the ship config through the **same** helper a shipped deployment uses
  // (`scaleShipConfigForHull`), and the resolved life count seeds the world.
  const startingLoadout = config.startingLoadout;
  const hullSpeedMultiplier =
    typeof startingLoadout?.speedMultiplier === 'number' &&
    Number.isFinite(startingLoadout.speedMultiplier)
      ? startingLoadout.speedMultiplier
      : 1;
  const startingLives = resolveStartingLives(startingLoadout?.lives);
  const shipAsteroids = shipToAsteroidsConfig(
    scaleShipConfigForHull(balance.ship, hullSpeedMultiplier),
  );

  // Per-level campaign mode (AH-0MVLJFB1I0099X4Z): an explicit `level` swaps
  // the single-level spawn reservoir for the **real campaign waves** of that
  // level and the **real per-kill drop rule** (the shared levelScaling
  // module). `scaleLevels: false` resolves the level curves (enemy-count
  // multiplier and per-kill drop chance) to level 1 so a pre-change baseline
  // is captured with identical harness code and seeds. Level 1 is the
  // identity: scaling on/off at level 1 runs byte-identically.
  //
  // Full-campaign mode (AH-0MVD1RGKM005GW0C): `campaign: true` plays the
  // **whole shipped campaign** through the shared WaveManager process (see
  // the module doc). An explicit `level` always takes precedence, so the
  // per-level mode stays reachable when a batch defaults to the campaign.
  const perLevelEnabled = config.level !== undefined && config.level !== null;
  const scaleLevels = perLevelEnabled ? config.scaleLevels !== false : false;
  const campaignLevel = perLevelEnabled
    ? clampLevel(config.level, DEFAULT_RULES.levelScalingMaxLevel)
    : 1;
  const resolvedLevel = scaleLevels ? campaignLevel : 1;
  const campaignEnabled = !perLevelEnabled && config.campaign === true;
  // Both campaign paths (per-level and full) source power-up supply from the
  // real per-kill drop rule; only the seeded skirmish keeps its reservoir.
  const realSupplyMode = perLevelEnabled || campaignEnabled;
  const wavePlan = perLevelEnabled
    ? buildLevelWavePlan(
        campaignLevel,
        scaleLevels,
        config.seed,
        width,
        height,
        // The deployment seam (AH-0MWCQ4FWN009J9DM): a hex deployment passes
        // its truncated five-wave sortie so the arena plays the shipped wave
        // set; absent (undefined) → the authored level (unchanged historical
        // behaviour). Note the default parameter: only `undefined` falls back.
        config.levelDefinition,
      )
    : [];
  // The shared WaveManager owns the full-campaign state machine. The
  // campaign is the exact build the game plays: `buildSequencedLevels` from
  // the resolved difficulty curves (honouring `fixed`/`curve`/`dynamic`
  // generations) seeded with the run seed, then the shared level-scaling
  // seam applied exactly once. `campaignLevels` (a documented test seam) is
  // played through the same manager without the merge.
  const campaignManager = campaignEnabled
    ? new WaveManager(
        config.campaignLevels && config.campaignLevels.length > 0
          ? [...config.campaignLevels]
          : buildArenaCampaign(config.seed, balance),
      )
    : null;
  // A dedicated seeded stream for campaign formation/spawner positioning
  // (independent of the reservoir, governor and sim streams).
  const campaignRng = campaignEnabled ? createSeededRng(config.seed) : null;

  // ── Shared mineral hold + hold-full upgrade choices ────────────────
  // (AH-0MVD1RIH2008YCNV) The hold is the **shared** `MineralHold` model
  // (capacity, growth multiplier, overflow carry), seeded from the shipped
  // rules or `config.hold`. The offer/selection draws share one dedicated
  // seeded stream, so the choice sequence is a pure function of the run seed
  // (AC4) and never perturbs the scenario/behaviour draws.
  const hold = new MineralHold({
    capacity: config.hold?.capacity ?? DEFAULT_RULES.mineralHoldCapacity,
    collectAmount:
      config.hold?.collectAmount ?? DEFAULT_RULES.mineralCollectAmount,
    growthMultiplier:
      config.hold?.growthMultiplier ?? DEFAULT_RULES.mineralHoldGrowthMultiplier,
  });
  const choiceRng = createSeededRng(config.seed);
  // Hold-full option supply comes from the shared choice flow. The shipped
  // `CHOICE_POOL` + `randomChoiceStrategy` are the default; `config.choicePool`
  // (AH-0MVD1RLGZ002LT7B AC3) is a test/experiment seam, like `campaignLevels`
  // and `balance`, that lets a caller play the campaign against an edited
  // upgrade-definition set while every draw still comes from the shared
  // weighted strategy and the run's seeded stream. Omitting it keeps the exact
  // shipped singleton, so default runs stay byte-identical.
  const choiceStrategy = config.choicePool
    ? createRandomChoiceStrategy([...config.choicePool])
    : randomChoiceStrategy;
  // The headless equivalents of the scene's player + effect registry: the
  // reward is applied through the **shared** `applyMineralChoiceReward` path,
  // so a hold-full grant advances the same run-scoped level stores the game
  // uses and later offers carry accurate ownership context (AC3).
  const holdChoice = new HeadlessChoicePlayer();
  // The launch loadout's weapon ownership seeds the run's ownership context, so
  // the same resolvers that fire in-run grants also fire what the fleet brought
  // (`resolveWeaponLoadout`, below). One `ownedLevel` = that many permanent
  // grants, exactly like `Player.equipWeapon(id, true)` called repeatedly.
  for (const weapon of startingLoadout?.weapons ?? []) {
    const grants = Math.max(1, Math.trunc(weapon.ownedLevel));
    for (let grant = 0; grant < grants; grant += 1) {
      holdChoice.equipWeapon(weapon.id, true);
    }
  }
  const effects = new EffectsRegistry(holdChoice.powerUpStore);
  effects.setRng(choiceRng);
  let mineralsCollected = 0;

  let mineralReservoir: Vec[];
  let powerUpReservoir: Vec[];
  let hostileReservoir: HostileSpec[];
  let asteroidReservoir: Vec[];
  if (realSupplyMode) {
    // Campaign modes keep the seeded mineral harvest and the asteroid
    // shadow-hazard (so the Extra Life roll stays live) but **never** seed
    // power-up drops — supply comes from kills through the real drop rule.
    const modeRng = createSeededRng(config.seed + 1);
    mineralReservoir = seededFieldPoints(modeRng, spawns.minerals * 3, width, height);
    powerUpReservoir = [];
    hostileReservoir = [];
    asteroidReservoir = seededFieldPoints(modeRng, spawns.asteroids * 3, width, height);
  } else {
    const plan = buildSpawnPlan(
      config.seed,
      width,
      height,
      spawns,
      archetypes,
      hostileWaves,
    );
    mineralReservoir = plan.mineralReservoir;
    powerUpReservoir = plan.powerUpReservoir;
    hostileReservoir = plan.hostileReservoir;
    asteroidReservoir = [];
  }
  // A dedicated seeded stream for the per-cycle shot-probability draws. It is
  // independent of the reservoir and governor streams, so the closed loop
  // stays deterministic without perturbing already-drawn scenario positions.
  const simRng = createSeededRng(config.seed);

  const governor = new BotInputGovernor(config.humanInput ?? {});
  governor.seed(config.seed);
  const reset = (policy as { reset?: () => void }).reset;
  if (typeof reset === 'function') reset.call(policy);

  const world = createWorld(width, height, hold, startingLives);
  const records: TelemetryRecord[] = [
    {
      kind: 'run_header',
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      runSeed: config.seed >>> 0,
      build,
      startedAt: 0,
    },
  ];

  const pushEvent = (
    tick: number,
    event: string,
    payload: Readonly<Record<string, unknown>>,
  ): void => {
    const record: TelemetryEventRecord = {
      kind: 'event',
      schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
      tick,
      event,
      payload,
    };
    records.push(record);
  };

  /**
   * Offers and resolves the hold-full choice exactly as the game does: the
   * **shared** strategy (`chooseOptions` + `randomChoiceStrategy`) draws three
   * distinct options from the run's owned weapon/power-up context, `hold_full`
   * records the offered ids, the bot picks one from the run's seeded stream,
   * `choice_selected` records the canonical `{ index, id }` payload, the shared
   * reward path applies the grant permanently, and the hold resolves (capacity
   * grows, overflow carries).
   */
  const resolveHoldFull = (tick: number): void => {
    const options = chooseOptions(
      3,
      choiceStrategy,
      choiceRng,
      holdChoice.context(),
    );
    pushEvent(tick, 'hold_full', { options: options.map((option) => option.id) });
    if (options.length > 0) {
      const index = Math.min(
        options.length - 1,
        Math.max(0, Math.floor(choiceRng() * options.length)),
      );
      const chosen = options[index];
      pushEvent(tick, 'choice_selected', { index, id: chosen.id });
      applyMineralChoiceReward(chosen, effects, holdChoice);
    }
    world.hold.resolve();
  };

  const initialHostiles = spawns.enemies + spawns.asteroids;
  const targetHostiles = Math.min(initialHostiles, hostileReservoir.length);
  let nextMineral = spawns.minerals * 3;
  let nextPowerUp = realSupplyMode ? 0 : spawns.powerUps * 3;
  let nextAsteroid = spawns.asteroids * 3;

  // Seed the opening batch: the first `spawns.*` entries of each reservoir.
  const spawnMineral = (): void => {
    const point = mineralReservoir[mineralReservoir.length - nextMineral];
    if (point) {
      nextMineral -= 1;
      world.minerals.push({ ...point });
    }
  };
  const spawnPowerUp = (): void => {
    const point = powerUpReservoir[powerUpReservoir.length - nextPowerUp];
    if (point) {
      nextPowerUp -= 1;
      world.drops.push({ ...point });
    }
  };
  const spawnHostile = (
    spec: HostileSpec | undefined,
    index: number,
    wave: number,
    shootEnabled = true,
  ): void => {
    if (!spec) return;
    // Hostile behaviour comes from the archetype's shared EnemyConfig:
    // radius (size), hit points (health), fire cadence (fireInterval in ms),
    // projectile speed (bulletSpeed) and fire chance (shotProbability).
    // Asteroids carry their own config and never fire. The full-campaign
    // path honours the wave's `shootEnabled` gate (GDD §2.4/§2.5: Levels
    // 1–3 do not fire), exactly as the shared manager tells the game.
    const enemy = enemyByKey.get(spec.archetype);
    const health = Math.max(1, Math.trunc(positiveOr(enemy?.health, 1)));
    const radius = positiveOr(enemy?.size, FALLBACK_HOSTILE_RADIUS);
    // Force-field hits for evidence mode (epic AH-0MVJ8W4GE007OMNT, AC5):
    // resolved from the SAME shared curve as the game and the level gym, so
    // a before/after bot batch reflects the barrier's durability cost. The
    // resolution level mirrors the run's level context — per-level mode uses
    // the resolved campaign level (`resolvedLevel`; `1` under `--scale-levels
    // off`, matching the level-curve baseline), the full-campaign mode uses
    // the current wave's level, and the seeded skirmish stays unshielded
    // (level 1, all neutral defaults are `0`). `config.forceFields === false`
    // resolves at level 1 — 0 hits for every shipped archetype — so a
    // pre-change (hull-only) baseline is captured with identical harness
    // code and seeds. `fieldHits` is `0` for unshielded hostiles, so the
    // hull-only model is unchanged wherever no enemy carries a field.
    const fieldHits = enemy && (config.forceFields ?? true)
      ? enemyForceFieldHits(
          campaignEnabled && campaignManager ? campaignManager.level : resolvedLevel,
          enemy,
        )
      : 0;
    world.hostiles.push({
      id: index,
      x: spec.x,
      y: spec.y,
      alive: true,
      archetype: spec.archetype,
      isAsteroid: spec.isAsteroid,
      wave,
      radius,
      getHitRadius: () => radius,
      health,
      fieldHits,
      fireTicks: fireIntervalTicks(
        enemy ? enemy.fireInterval : FALLBACK_FIRE_INTERVAL_MS,
        dt,
      ),
      fireCooldown: HOSTILE_FIRE_WARMUP_TICKS + index * 7,
      bulletSpeed: positiveOr(enemy?.bulletSpeed, FALLBACK_ENEMY_BULLET_SPEED),
      shotProbability: shootEnabled ? clamp01(enemy?.shotProbability ?? 1) : 0,
    });
  };

  // Per-level campaign: a per-run hostile id counter staggers the fire
  // warm-up across wave members (the skirmish uses reservoir indices).
  let hostileId = 0;
  const nextHostileId = (): number => {
    const id = hostileId;
    hostileId += 1;
    return id;
  };
  /** Set when the shared manager triggers the final boss (run ends). */
  let campaignFinished = false;

  /** Spawns every member of one per-level campaign wave. */
  const spawnWave = (waveIndex: number): void => {
    for (const member of wavePlan[waveIndex] ?? []) {
      spawnHostile(member, nextHostileId(), waveIndex);
    }
  };

  /** Spawns the next asteroid from the per-level shadow-hazard reservoir. */
  const spawnAsteroid = (): void => {
    const point = asteroidReservoir[asteroidReservoir.length - nextAsteroid];
    if (point) {
      nextAsteroid -= 1;
      spawnHostile({ ...point, archetype: 'asteroid', isAsteroid: true }, nextHostileId(), -1);
    }
  };

  /**
   * Spawns the shared WaveManager's current full-campaign wave: the
   * `planSpawns` list (formation-positioned group enemies) plus the wave's
   * opt-in spawner archetypes as seeded hostiles. Extras are registered
   * through the shared `registerDynamicSpawn` seam so they gate wave
   * completion exactly as they do in the game.
   */
  const spawnCampaignWave = (tick: number): void => {
    const manager = campaignManager;
    const rng = campaignRng;
    if (!manager || !rng) return;
    for (const spawn of manager.planSpawns(rng)) {
      spawnHostile(
        { x: spawn.x, y: spawn.y, archetype: spawn.enemyKey, isAsteroid: false },
        nextHostileId(),
        -1,
        spawn.shootEnabled,
      );
    }
    const extras = waveSpawnerExtras(manager.currentWave());
    const waveShoot = manager.currentWave()?.shootEnabled ?? true;
    for (const key of extras) {
      spawnHostile(
        { ...seededPoint(rng, width, height), archetype: key, isAsteroid: false },
        nextHostileId(),
        -1,
        waveShoot,
      );
    }
    // Blocking spawner archetypes (ghosts, centipede, horde) gate the wave
    // through the shared seam exactly as in the game; lane traffic is a
    // non-blocking hazard (Asteroid accounting) and is spawned but never
    // registered.
    manager.registerDynamicSpawn(
      extras.filter((key) => !isNonBlockingHazard(key)).length,
    );
    pushEvent(tick, 'wave_start', {
      level: manager.level,
      waveNumber: manager.waveNumber,
      waveCount: manager.waveCount,
    });
  };

  /**
   * Advances the shared WaveManager after one non-asteroid kill and emits the
   * canonical transition events for the **now-current** wave/level (the
   * payloads `runTelemetry.waveCleared`/`levelCleared` record). Clearing the
   * final level triggers the boss, which ends the run without simulating the
   * encounter (parent AC4 fidelity boundary).
   */
  const onCampaignEnemyDestroyed = (tick: number): void => {
    const manager = campaignManager;
    if (!manager) return;
    const event: WaveEvent = manager.onEnemyDestroyed();
    switch (event) {
      case 'continue':
        return;
      case 'waveCleared':
        pushEvent(tick, 'wave_cleared', {
          level: manager.level,
          waveNumber: manager.waveNumber,
        });
        spawnCampaignWave(tick);
        return;
      case 'levelCleared':
        pushEvent(tick, 'level_cleared', { level: manager.level });
        spawnCampaignWave(tick);
        return;
      case 'bossTriggered':
        pushEvent(tick, 'boss_triggered', {});
        campaignFinished = true;
        return;
      case 'gameComplete':
        campaignFinished = true;
        return;
    }
  };

  for (let i = 0; i < spawns.minerals; i += 1) spawnMineral();
  for (let i = 0; i < spawns.powerUps; i += 1) spawnPowerUp();
  if (campaignEnabled) {
    // Full-campaign mode: the shared manager starts at Level 1 Wave 1 and its
    // first wave spawns immediately; later waves spawn from its transitions.
    campaignManager?.beginGame();
    spawnCampaignWave(0);
    for (let i = 0; i < spawns.asteroids; i += 1) spawnAsteroid();
  } else if (perLevelEnabled) {
    // Per-level campaign mode: wave 1 spawns at the level start; the
    // remaining waves spawn as each wave is cleared (wave gating in the loop).
    if (wavePlan.length > 0) {
      spawnWave(0);
      pushEvent(0, 'wave_start', {
        waveNumber: 1,
        level: campaignLevel,
        waveCount: wavePlan.length,
      });
    }
    for (let i = 0; i < spawns.asteroids; i += 1) spawnAsteroid();
  } else {
    for (let i = 0; i < targetHostiles; i += 1) {
      spawnHostile(hostileReservoir[i], i, -1);
    }
  }

  /**
   * Destroys one hostile through the single kill seam: the destruction event,
   * the real per-kill drop rolls and the shared campaign accounting run
   * exactly once per kill, whichever damage source (bullet or AOE) landed the
   * lethal blow (AH-0MW5DVAME0062GQO).
   */
  const destroyHostile = (hostile: Hostile, tick: number): void => {
    hostile.alive = false;
    pushEvent(
      tick,
      hostile.isAsteroid ? 'asteroid_destroyed' : 'enemy_killed',
      {
        x: hostile.x,
        y: hostile.y,
        archetype: hostile.archetype,
      },
    );
    // Campaign modes: the **real per-kill drop rule** (the shared
    // levelScaling module) replaces the seeded power-up reservoir. The
    // level is the wave's current campaign level (identified before the
    // manager advances on this kill), so the supply tightens through the
    // campaign exactly as it does in the game. A kill rolls the per-kill
    // drop chance once; a destroyed asteroid additionally rolls the
    // level-scaled Extra Life chance — at most one generic drop plus one
    // Extra Life per kill.
    if (realSupplyMode) {
      const supplyLevel = campaignEnabled ? campaignManager!.level : resolvedLevel;
      if (simRng() < powerUpDropChance(supplyLevel, DEFAULT_RULES)) {
        world.drops.push({ x: hostile.x, y: hostile.y });
      }
      if (hostile.isAsteroid && simRng() < extraLifeDropChance(supplyLevel, DEFAULT_RULES)) {
        world.drops.push({ x: hostile.x, y: hostile.y });
      }
    }
    // Wave/level progression is driven exclusively by the shared manager
    // (full-campaign mode). Asteroids and lane traffic are non-blocking
    // hazards (shared `isNonBlockingHazard`) and never advance it.
    if (campaignEnabled && !isNonBlockingHazard(hostile.archetype)) {
      onCampaignEnemyDestroyed(tick);
    }
  };

  /**
   * Resolves one AOE blast at fire time through the shared `utils/aoe`
   * geometry (AH-0MW5DVAME0062GQO). Mirrors the game's
   * `CombatScene.applyAoEDescriptor`: every live hostile inside the radius
   * takes the resolved damage **barrier first** (the same ordering every
   * player damage source obeys), and a descriptor that clears enemy bullets
   * removes those inside the radius.
   */
  const applyAoeBlast = (
    aoe: AoEDescriptor,
    originX: number,
    originY: number,
    damage: number,
    tick: number,
  ): void => {
    if (aoe.damagesEnemies) {
      // Pure shared target selection (`utils/aoe`) keeps the arena and the
      // game identical for the same blast geometry.
      const targets = selectAoETargets(originX, originY, aoe.radius, world.hostiles);
      for (const hostile of targets) {
        if (!hostile.alive || campaignFinished) continue;
        if (hostile.fieldHits > 0) {
          // Barrier first (epic AH-0MVJ8W4GE007OMNT AC2).
          hostile.fieldHits -= 1;
          continue;
        }
        hostile.health -= damage;
        if (hostile.health > 0) continue;
        destroyHostile(hostile, tick);
      }
    }
    if (aoe.clearsEnemyBullets) {
      world.enemyBullets = world.enemyBullets.filter(
        (bullet) => !isInAoEArea(originX, originY, aoe.radius, bullet),
      );
    }
  };

  /**
   * Fires one resolved weapon (AH-0MW5DVAME0062GQO): an AOE weapon resolves
   * its blast at fire time through {@link applyAoeBlast} (no travelling
   * projectile, exactly like the game's shared combat core), every other
   * weapon spawns its resolved pattern through the shared
   * `createBulletsFromHeading` seam.
   */
  const fireWeapon = (weapon: ArenaWeaponLoadout, tick: number): void => {
    const aoe = weapon.definition.aoe;
    if (aoe) {
      if (aoe.trigger === 'onRandom') {
        // Mortar: one detonation per pattern bullet (`def.offsets.length`, so
        // the `projectileCount` leveling adds detonations), each sampled
        // uniformly over the disc the game uses (speed × lifetime) from the
        // run's existing seeded stream — never the wall clock or Math.random.
        const range =
          (aoe.projectileSpeed ?? 0) * weapon.definition.bulletLifetime;
        const detonations = Math.max(1, weapon.definition.offsets.length);
        for (let i = 0; i < detonations; i += 1) {
          const point = selectRandomPoint(
            world.player.x,
            world.player.y,
            range,
            simRng,
          );
          applyAoeBlast(aoe, point.x, point.y, weapon.stats.damage, tick);
        }
        return;
      }
      // Nova / Arc: an `'onFire'` effect resolves at the ship. (The Arc's chain
      // hops and along-path bullet clear are not modelled — see the module's
      // fidelity boundary.)
      applyAoeBlast(
        aoe,
        world.player.x,
        world.player.y,
        weapon.stats.damage,
        tick,
      );
      return;
    }
    const headingDeg = (world.player.facing * 180) / Math.PI;
    for (const shot of createBulletsFromHeading(
      weapon.definition,
      headingDeg,
      world.player.x,
      world.player.y,
    )) {
      const headingRad = (shot.angleDeg * Math.PI) / 180;
      world.playerBullets.push({
        x: shot.x,
        y: shot.y,
        vx: Math.cos(headingRad) * PLAYER_BULLET_SPEED,
        vy: Math.sin(headingRad) * PLAYER_BULLET_SPEED,
        lifetime: weapon.definition.bulletLifetime,
        elapsed: 0,
        radius:
          PLAYER_BULLET_RADIUS * (weapon.definition.levelBulletSize ?? 1),
        damage: weapon.stats.damage,
      });
    }
  };

  /**
   * Per-weapon fire cooldowns in ticks. Each weapon keeps its own countdown
   * derived from its resolved `fireRateMs` at the owned level, so a levelled
   * weapon fires on its own cadence instead of sharing one global counter.
   */
  const weaponCooldowns = new Map<WeaponId, number>();
  /** Memoises the shared `(id, level)` resolution for the length of the run. */
  const weaponCache = new Map<string, ResolvedWeapon>();

  let simulated = 0;
  let won = false;
  const hostileSpawned = targetHostiles;
  let currentWave = 0;
  let allWavesCleared = false;

  for (let tick = 0; tick < config.ticks; tick += 1) {
    simulated = tick + 1;

    // Per-level campaign wave gate: the level plays its waves in order — the
    // next wave spawns the moment the current wave's members are all dead,
    // and clearing the final wave marks the level cleared. Wave-accounted
    // hostiles carry their wave index; the asteroid shadow-hazard (wave −1)
    // and the seeded reservoir never gate progression.
    if (perLevelEnabled && wavePlan.length > 0 && !allWavesCleared) {
      const waveLive = world.hostiles.some(
        (hostile) => hostile.alive && hostile.wave === currentWave,
      );
      if (!waveLive) {
        pushEvent(tick, 'wave_cleared', {
          waveNumber: currentWave + 1,
          level: campaignLevel,
        });
        if (currentWave >= wavePlan.length - 1) {
          allWavesCleared = true;
          pushEvent(tick, 'level_cleared', { level: campaignLevel });
        } else {
          currentWave += 1;
          spawnWave(currentWave);
          pushEvent(tick, 'wave_start', {
            waveNumber: currentWave + 1,
            level: campaignLevel,
            waveCount: wavePlan.length,
          });
        }
      }
    }

    // 1. Decide + resolve input (the bot loop).
    const snapshot = snapshotOf(world, world.hostiles, config.seed);
    const intent = policy.decide(snapshot, dt);
    const input = governor.update(intent, dt, {
      scheme: 'asteroids',
      facing: world.player.facing,
    }) as AsteroidsInput;
    const moved = asteroidModel.tick(
      world.player as unknown as RotatingMovementState,
      input,
      dt,
      width,
      height,
      shipAsteroids as BaseMovementConfig,
    ) as unknown as RotatingMovementState;
    world.player = {
      x: moved.x,
      y: moved.y,
      vx: moved.vx,
      vy: moved.vy,
      facing: moved.facing,
      angularVelocity: moved.angularVelocity ?? 0,
    };
    if (world.invulnerableTicks > 0) world.invulnerableTicks -= 1;

    // 2. Auto-fire every owned weapon along the facing (AH-0MW5DV9I6001D4HN,
    // AH-0MW5DVAME0062GQO). The loadout comes from the run's ownership context
    // — the always-active cannon at level 0 plus every permanent grant the
    // hold-full choice flow recorded, each at its level-resolved upgrade index
    // — and fires through the same shared resolvers the game's `Player` uses
    // (`resolveWeaponAtLevel` / `resolveWeaponDefinition` /
    // `createBulletsFromHeading` / `utils/aoe`). Cadence, pattern offsets /
    // side offsets, lifetime, bullet size, damage and AOE radius therefore all
    // come from the shared weapon data (gym↔game parity,
    // AH-0MUGZDTFX004RBD1); no arena-local weapon constant or resolver exists.
    //
    // Cadence divergence: the game's beat clock is replaced by an integer tick
    // interval derived from the resolved `fireRateMs` (see `fireRateTicks`).
    for (const weapon of resolveWeaponLoadout(
      holdChoice.getWeaponLevels(),
      weaponCache,
    )) {
      const cooldown = weaponCooldowns.get(weapon.id) ?? 0;
      if (cooldown > 0) {
        weaponCooldowns.set(weapon.id, cooldown - 1);
        continue;
      }
      weaponCooldowns.set(
        weapon.id,
        fireRateTicks(weapon.definition.fireRateMs, dt),
      );
      fireWeapon(weapon, tick);
      if (campaignFinished) break;
    }
    if (campaignFinished) break;

    // 3. Hostile fire (config-driven cadence, speed and shot probability).
    for (const hostile of world.hostiles) {
      if (!hostile.alive || hostile.isAsteroid) continue;
      hostile.fireCooldown -= 1;
      if (hostile.fireCooldown > 0) continue;
      hostile.fireCooldown = hostile.fireTicks;
      // Per-archetype shot probability (config `shotProbability`): the draw
      // uses the run's seeded stream, so it is reproducible per seed+config.
      if (!(simRng() < hostile.shotProbability)) continue;
      // Seam-aware hostile aim (AH-0MVT2W5EL004OXNN): fire along the shortest
      // wrapped route, so a hostile near one edge shoots a player near the
      // opposite edge across the seam, matching the wrap-aware enemies in the
      // game. Shared torus maths — no duplicate implementation here.
      const aim = hostileAimVelocity(
        hostile,
        world.player,
        hostile.bulletSpeed,
        width,
        height,
      );
      world.enemyBullets.push({
        x: hostile.x,
        y: hostile.y,
        vx: aim.vx,
        vy: aim.vy,
        lifetime: ENEMY_BULLET_LIFETIME,
        elapsed: 0,
      });
    }

    // 4. Advance projectiles: integrate, wrap at all four edges and expire by
    // lifetime — the game's bullet model (AH-0MU960UTE001PTV0), not the old
    // off-field cull (AH-0MVT2W5EL004OXNN).
    for (const bullet of world.playerBullets) {
      advanceBulletPosition(bullet, bullet.vx, bullet.vy, dt, width, height);
      bullet.elapsed += dt;
    }
    for (const bullet of world.enemyBullets) {
      advanceBulletPosition(bullet, bullet.vx, bullet.vy, dt, width, height);
      bullet.elapsed += dt;
    }
    world.playerBullets = world.playerBullets.filter(
      (bullet) => bullet.elapsed < bullet.lifetime,
    );
    world.enemyBullets = world.enemyBullets.filter(
      (bullet) => bullet.elapsed < bullet.lifetime,
    );

    // 5. Player bullets vs hostiles (per-archetype radius and health).
    for (const bullet of world.playerBullets) {
      if (campaignFinished) break;
      for (const hostile of world.hostiles) {
        if (!hostile.alive) continue;
        if (distance(bullet, hostile) > hostile.radius + bullet.radius) continue;
        bullet.x = Number.NaN; // retired below (one bullet never passes through)
        if (hostile.fieldHits > 0) {
          // Barrier first (epic AH-0MVJ8W4GE007OMNT AC2): the force field
          // absorbs the hit, the hull is untouched, and the bullet is still
          // consumed — one hit per bullet, mirroring the entity seam.
          hostile.fieldHits -= 1;
          break;
        }
        hostile.health -= bullet.damage;
        if (hostile.health > 0) break; // wounded, but alive
        destroyHostile(hostile, tick);
        break;
      }
    }
    world.playerBullets = world.playerBullets.filter(
      (bullet) => Number.isFinite(bullet.x),
    );
    // The final level's wipe triggered the boss: the run is over (AC4).
    if (campaignFinished) break;

    // 6. Enemy bullets vs player (avoidable hits).
    const playerPoint: Vec = { x: world.player.x, y: world.player.y };
    for (const bullet of world.enemyBullets) {
      if (distance(bullet, playerPoint) > PLAYER_HIT_RADIUS) continue;
      bullet.x = Number.NaN;
      if (world.invulnerableTicks > 0) {
        pushEvent(tick, 'player_hit_absorbed', { x: world.player.x, y: world.player.y });
      } else {
        world.lives -= 1;
        world.invulnerableTicks = INVULNERABLE_TICKS;
        pushEvent(tick, 'player_hit', { x: world.player.x, y: world.player.y });
      }
    }
    world.enemyBullets = world.enemyBullets.filter(
      (bullet) => Number.isFinite(bullet.x),
    );

    // 7. Collectables.
    world.minerals = world.minerals.filter((mineral) => {
      if (distance(mineral, playerPoint) > COLLECT_RADIUS) return true;
      // Shared hold model: collect into the hold, and run the shared
      // hold-full choice flow the moment it fills (AH-0MVD1RIH2008YCNV).
      world.hold.collect();
      mineralsCollected += 1;
      pushEvent(tick, 'mineral_collected', {
        x: mineral.x,
        y: mineral.y,
        total: world.hold.store,
      });
      if (world.hold.isFull) resolveHoldFull(tick);
      return false;
    });
    world.drops = world.drops.filter((drop, index) => {
      if (distance(drop, playerPoint) > COLLECT_RADIUS) return true;
      pushEvent(tick, 'pickup', {
        x: drop.x,
        y: drop.y,
        type: index % 2 === 0 ? 'spread' : 'shield',
      });
      return false;
    });

    // 8. Replenish reservoirs so a long run stays populated. In the campaign
    // modes the seeded power-up reservoir never refills (supply comes from
    // kills through the real drop rule); the asteroid shadow-hazard refills
    // on the same cadence as the skirmish.
    if (tick > 0 && tick % COLLECTABLE_RESPAWN_TICKS === 0) {
      if (world.minerals.length < spawns.minerals) spawnMineral();
      if (!realSupplyMode && world.drops.length < spawns.powerUps) spawnPowerUp();
    }
    if (tick > 0 && tick % HOSTILE_RESPAWN_TICKS === 0) {
      if (realSupplyMode) {
        const liveAsteroids = world.hostiles.filter(
          (hostile) => hostile.alive && hostile.isAsteroid,
        ).length;
        if (liveAsteroids < spawns.asteroids) spawnAsteroid();
      } else {
        const live = world.hostiles.filter((hostile) => hostile.alive).length;
        const nextIndex =
          hostileSpawned + Math.max(0, Math.floor(tick / HOSTILE_RESPAWN_TICKS) - 1);
        if (live < spawns.enemies && nextIndex < hostileReservoir.length) {
          spawnHostile(hostileReservoir[nextIndex], nextIndex, -1);
        }
      }
    }

    // 9. Sample the tick.
    if (tick % sampleEvery === 0) {
      const inputRecord: ArenaInput = {
        scheme: 'asteroids',
        forward: input.forward === true,
        turnLeft: input.turnLeft === true,
        turnRight: input.turnRight === true,
      };
      records.push({
        kind: 'tick',
        schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
        tick,
        state: stateOf(world),
        input: inputRecord,
      });
    }

    // 10. Death ends the run early.
    if (world.lives <= 0) {
      pushEvent(tick, 'player_death', {});
      break;
    }
  }

  const aliveHostiles = world.hostiles.filter((hostile) => hostile.alive).length;
  // In full-campaign mode the regular campaign is won when the shared manager
  // has cleared the final wave (the boss trigger ends the run, AC4); lingering
  // asteroids are a non-blocking hazard and do not negate the win. The other
  // modes keep the original "every hostile cleared" meaning.
  won = campaignEnabled
    ? campaignFinished && world.lives > 0
    : world.lives > 0 && aliveHostiles === 0;

  const eventCounts: Record<string, number> = {};
  for (const record of records) {
    if (record.kind === 'event') {
      eventCounts[record.event] = (eventCounts[record.event] ?? 0) + 1;
    }
  }
  const score = Math.round(
    mineralsCollected * 4 +
      (eventCounts.pickup ?? 0) * 3 +
      (eventCounts.enemy_killed ?? 0) * 2 +
      (eventCounts.asteroid_destroyed ?? 0) * 1 +
      simulated * 0.01 -
      (eventCounts.player_hit ?? 0) * 100,
  );

  records.push({
    kind: 'event',
    schemaVersion: EVAL_TELEMETRY_SCHEMA_VERSION,
    tick: Math.max(0, simulated - 1),
    event: 'run_end',
    payload: { won, score },
  });

  return { seed: config.seed >>> 0, records, won, ticksSimulated: simulated };
}
