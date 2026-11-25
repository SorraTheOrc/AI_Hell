/**
 * Read-only bot snapshot — type definition and builder.
 *
 * The bot decision logic (`decideBotIntent`) is a pure function over a
 * `BotSnapshot` so it can be unit-tested without a browser, a Phaser scene
 * or any wall-clock state. This module is the adapter between the live
 * `PlayScene` and that pure decision layer: `buildBotSnapshot(scene)` reads
 * the scene's existing public getters and copies the relevant state into a
 * frozen, plain-object snapshot.
 *
 * ## Design
 *
 * - The snapshot is a **deep-frozen** plain object (AC4): neither the
 *   snapshot nor its nested arrays/entries can be mutated after
 *   construction, so the decision layer cannot accidentally write back into
 *   live game state. The freeze is optional (AH-0MW2DC20A007TAVY): the dev
 *   telemetry recorder builds a snapshot purely to copy it into the telemetry
 *   state vector and never keeps it, so it passes `freeze: false` and skips a
 *   second full traversal of a graph that can hold thousands of entries —
 *   the returned tree is identically shaped and reads the same game state.
 * - The builder depends on a minimal **structural** scene interface
 *   (`BotSnapshotScene`) rather than `PlayScene` itself. `PlayScene`
 *   satisfies it via its existing getters, and tests can pass lightweight
 *   stubs instead of booting Phaser (AC3).
 * - Every enemy entry carries a **stable bot-side id** (`BotEnemy.id`),
 *   assigned here from a module-local `WeakMap` (AH-0MVI4QDN90037DIN · AC1).
 *   Decision-layer state that must correlate an entity across ticks keys on
 *   it; no per-archetype entity code is involved.
 * - `PlayScene` is wired to the builder in a later child; this module does
 *   not import `PlayScene` (avoiding a scene → AI → scene import cycle).
 * - Every enemy entry also carries its **movement class**
 *   (`BotEnemy.movementClass`, AH-0MWM0C6OW006G5SE): the class is resolved
 *   bot-side from the archetype by {@link resolveEnemyMovementClass}, the
 *   frozen map mirroring `src/data/enemy-configs.csv`. Nothing consumes it
 *   yet — it is additive plumbing for class-shaped hazard prediction.
 *
 * @module src/ai/botSnapshot
 */

import type { EnemyMovementClass } from '../core/configTypes';
import { resolveEnemyMovementClass } from './framework/enemyMovementClass';

/** Discriminator stored on every snapshot mineral entry (AC1). */
export const BOT_MINERAL_TYPE = 'mineral';

// ── Snapshot shape (consumed by the pure decision logic) ─────────────

/** An immutable 2-D point. */
export interface BotVec2 {
  readonly x: number;
  readonly y: number;
}

/**
 * The ship's live thruster physics — forward acceleration / speed cap /
 * friction plus the reverse trio (AH-0MV85WFWD0029DL7). Field names match the
 * `ShipConfig`/`Player.getThrusterConfig()` terms the player exposes, so the
 * snapshot carries the player's tuning unchanged.
 */
export interface BotThrusterConfig {
  /** Acceleration applied while thrusting (px/s²). */
  readonly thrustAcceleration: number;
  /** Absolute forward speed cap (px/s). */
  readonly maxSpeed: number;
  /** Linear deceleration when no thrust is held (px/s²). */
  readonly frictionDeceleration: number;
  /** Whether the reverse (retro) thruster is enabled. */
  readonly reverseEnabled: boolean;
  /** Reverse-thrust acceleration (px/s²). */
  readonly reverseAcceleration: number;
  /** Speed cap under reverse thrust (px/s). */
  readonly reverseMaxSpeed: number;
}

/**
 * The ship's live rotation tuning (Asteroids scheme): top spin rate, spin-up
 * and spin-down rates. Field names match `Player.getRotationConfig()` so the
 * snapshot carries the player's tuning unchanged
 * (AH-0MWR04ZDU0005O8J · AC2).
 */
export interface BotRotationConfig {
  /** Top angular rate (rad/s). */
  readonly rotationSpeed: number;
  /** Spin-up acceleration (rad/s²). */
  readonly rotationAcceleration: number;
  /** Spin-down deceleration (rad/s²). */
  readonly rotationDeceleration: number;
}

/** Player position and velocity. */
export interface BotPlayer {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  /**
   * The ship's live thruster physics, sourced from the player's effective
   * config via the structural `BotPlayerSource` seam
   * (AH-0MV85WFWD0029DL7 · AC1/AC2). Optional so snapshots from sources that
   * do not expose the config keep their existing shape (no-config fallback
   * semantics hold).
   */
  readonly thruster?: BotThrusterConfig;
  /**
   * The ship's live rotation tuning, sourced through the same structural
   * seam (AH-0MWR04ZDU0005O8J · AC2). The competent aim solve derives its
   * turn-time (alignment) term from it; absent on snapshots whose source does
   * not expose the config, where the compiled fallback constant applies.
   */
  readonly rotation?: BotRotationConfig;
  /**
   * The ship's live primary travelling-shot speed (px/s), sourced through the
   * same structural seam (AH-0MWR04ZDU0005O8J · AC2). The aim solve uses it
   * as the projectile speed for its time of flight. Absent on snapshots whose
   * source does not expose it, where the compiled `PLAYER_BULLET_SPEED`
   * applies.
   */
  readonly shotSpeed?: number;
  /**
   * The ship's live **effective weapon reach** (px), sourced through the same
   * structural seam (AH-0MWPOET5A002IPTP · fire-discipline remediation). The
   * aim fire solution uses it to tell a target that can be hit from one that
   * is simply too far away, and the bot's fire gate uses it to only fire when
   * a shot has a target. Absent on snapshots whose source does not expose it,
   * where the range gate is disabled (today's behaviour exactly).
   */
  readonly weaponRange?: number;
}

/** A single enemy (or asteroid) and its threat-relevant state. */
export interface BotEnemy {
  /**
   * Stable bot-side identity assigned by {@link buildBotSnapshot}
   * (AH-0MVI4QDN90037DIN · AC1). Decision-layer state that must correlate an
   * entity across ticks — today the hazard-velocity tracker — keys on it.
   * Absent on snapshots hand-built by tests/fixtures, which the tracker then
   * treats as stationary.
   */
  readonly id?: number;
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  /** Archetype key, e.g. `'scout'`, `'diver'`, `'asteroid'`. */
  readonly archetype: string;
  /**
   * Whether the enemy is inside a fire "tell" (advance cue) window and is
   * therefore about to shoot.  Exposed by the firing archetypes that use a
   * tell (Scout, Phaser); absent for enemies that fire without a tell
   * (Diver, Tank) and for non-firing entities.  The bot uses this to steer
   * off an aimed shot's line before it is fired (best-effort
   * fire-pattern avoidance).
   */
  readonly isTelling?: boolean;
  /**
   * Enemy velocity (px/s) when the source exposes a physics body, used for
   * the competent bot's aim-lead prediction (AH-0MV1DUSM2005HL98 · AC2).
   * Absent for formation-positioned entities with no velocity; the bot
   * consumer treats an absent or zero velocity as "stationary" (no lead).
   */
  readonly vx?: number;
  readonly vy?: number;
  /**
   * The enemy's movement class (AH-0MWM0C6OW006G5SE), resolved bot-side from
   * its `archetype` by {@link resolveEnemyMovementClass} — never a config
   * lookup on the decision path. Additive: hand-built fixtures may omit it and
   * consumers resolve it themselves; the builder always populates it.
   */
  readonly movementClass?: EnemyMovementClass;
}
export interface BotBullet {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** A live power-up / weapon drop. */
export interface BotDrop {
  readonly x: number;
  readonly y: number;
  /** Drop id, e.g. `'shield'`, `'spread'`. */
  readonly type: string;
}

/** A live mineral collectable. */
export interface BotMineral {
  readonly x: number;
  readonly y: number;
  /** Mineral discriminator (currently always {@link BOT_MINERAL_TYPE}). */
  readonly type: string;
  /**
   * Minerals this collectable is worth (`MINERAL_DEPOSIT_VALUE` for a red
   * deposit, `1` for an ordinary gold dot) when the source exposes it
   * (AH-0MWJ1680Z001QYV2 · AC4). Absent on value-less sources, treated as `1`.
   */
  readonly value?: number;
}

/** The Central AI boss and its current phase. */
export interface BotBoss {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  readonly phase: number;
}

/**
 * The active wave's time-limit state.
 *
 * Regular waves run against a countdown ({@link WAVE_TIME_LIMIT_SECONDS} in
 * the game); when it expires the surviving enemies carry over into the next
 * wave, so the bot uses the remaining time to prioritise clearing them.
 */
export interface BotWave {
  /** Whether a timed wave is currently counting down. */
  readonly active: boolean;
  /** Seconds left before the wave-time limit carries survivors over. */
  readonly timeRemaining: number;
  /** The full wave time limit (seconds). */
  readonly timeLimit: number;
}

/**
 * The complete read-only game state the bot decides from. Every field is
 * `readonly`; at runtime the object is deep-frozen by
 * {@link buildBotSnapshot} (AC4).
 */
export interface BotSnapshot {
  readonly player: BotPlayer | null;
  readonly enemies: readonly BotEnemy[];
  readonly enemyBullets: readonly BotBullet[];
  readonly playerBullets: readonly BotBullet[];
  readonly drops: readonly BotDrop[];
  readonly minerals: readonly BotMineral[];
  readonly boss: BotBoss | null;
  readonly aliveCount: number;
  /**
   * The active timed wave, or `null` when no wave timer is running (boss
   * fights, transitions, or between waves).
   */
  readonly wave: BotWave | null;
  /**
   * The per-run RNG seed (AH-0MUY08V6W001SJJN AC4), so telemetry and the
   * bot layer can correlate observations with a reproducible run.
   */
  readonly runSeed: number;
  /**
   * The ship's current life count (AH-0MV03GXZQ00801T4). Read from the run
   * state so the bot can prioritise an Extra Life while it is below the cap.
   */
  readonly lives: number;
  /**
   * The run's life cap (AH-0MV03GXZQ00801T4). The scene supplies it from the
   * existing game data (`MAX_LIVES` / the Extra Life catalogue entry), so the
   * bot never introduces its own cap constant (AC3).
   */
  readonly livesCap: number;
  /**
   * Whether the ship's reverse (retro) thruster is enabled
   * (AH-0MV1J0OHP0072XA5 · AC4).  The decision layer gates every reverse
   * intent on this so a player who disabled the thruster never sees the bot
   * use it.  Defaults to `false` (opt-in) when the source does not expose the
   * flag, so consumers that predate the reverse thruster behave exactly as
   * before.
   */
  readonly reverseEnabled?: boolean;
}

// ── Structural scene seam (PlayScene satisfies this) ─────────────────

/** Minimal player source: position plus the scene's movement state seam. */
export interface BotPlayerSource {
  readonly x: number;
  readonly y: number;
  getMovementState(): { readonly x: number; readonly y: number; readonly vx: number; readonly vy: number };
  /**
   * Whether the ship's reverse thruster is enabled
   * (AH-0MV1J0OHP0072XA5 · AC4).  Optional so older structural sources remain
   * valid; an absent flag is treated as **disabled** (opt-in), preserving the
   * pre-reverse behaviour for consumers that do not expose it.
   */
  isReverseEnabled?(): boolean;
  /**
   * The ship's live thruster physics (forward + reverse)
   * (AH-0MV85WFWD0029DL7 · AC2).  Optional so older structural sources remain
   * valid; an absent getter omits the `thruster` field from the snapshot
   * player, preserving the existing no-config shape.
   */
  getThrusterConfig?(): BotThrusterConfig;
  /**
   * The ship's live rotation tuning (Asteroids scheme)
   * (AH-0MWR04ZDU0005O8J · AC2). Optional so older structural sources remain
   * valid; an absent getter omits the `rotation` field from the snapshot
   * player, preserving the no-config shape and fallback semantics.
   */
  getRotationConfig?(): BotRotationConfig;
  /**
   * The ship's live primary travelling-shot speed (px/s)
   * (AH-0MWR04ZDU0005O8J · AC2). Optional so older structural sources remain
   * valid; an absent getter omits the `shotSpeed` field, leaving the compiled
   * `PLAYER_BULLET_SPEED` as the fallback.
   */
  getProjectileSpeed?(): number;
  /**
   * The ship's live **effective weapon reach** (px)
   * (AH-0MWPOET5A002IPTP · fire-discipline remediation). Optional so older
   * structural sources remain valid; an absent getter omits the `weaponRange`
   * field, leaving the range gate disabled (the pre-change behaviour).
   */
  getEffectiveWeaponRange?(): number;
}

/** Minimal enemy source (a `BaseEnemy`/`EnemyEntity` satisfies this). */
export interface BotEnemySource {
  /**
   * Optional pre-existing stable id. When absent the builder assigns one from
   * a module-local `WeakMap` keyed by the source object, so the identity is
   * stable for the lifetime of the entity without any per-archetype edits
   * (AH-0MVI4QDN90037DIN · AC1).
   */
  readonly id?: number;
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  readonly archetype: string;
  /** Present on tell-using archetypes (Scout, Phaser); see {@link BotEnemy.isTelling}. */
  readonly isTelling?: boolean;
  /**
   * Velocity (px/s) when the entity exposes a physics body (e.g. `Asteroid`,
   * `LaneTraffic`); see {@link BotEnemy.vx}. Absent for formation-positioned
   * enemies and other velocity-less sources.
   */
  readonly vx?: number;
  readonly vy?: number;
  /**
   * An already-known movement class (AH-0MWM0C6OW006G5SE). Optional: no live
   * entity exposes one today — the builder resolves the class from the
   * `archetype` map — but a structural source (e.g. a gym-only hazard with no
   * CSV row) may declare it explicitly, and an explicit value wins over the
   * archetype lookup.
   */
  readonly movementClass?: EnemyMovementClass;
}

/** Minimal enemy-bullet source: position lives on the drawn `graphics`. */
export interface BotEnemyBulletSource {
  readonly graphics: { readonly x: number; readonly y: number };
  readonly vx: number;
  readonly vy: number;
}

/** Minimal player-bullet source. */
export interface BotPlayerBulletSource {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}

/** Minimal drop source. */
export interface BotDropSource {
  readonly x: number;
  readonly y: number;
  readonly dropId: string;
}

/** Minimal mineral source. */
export interface BotMineralSource {
  readonly x: number;
  readonly y: number;
  /**
   * The mineral's value when the source exposes it (a `Mineral` carries
   * `value`; lightweight gym minerals may not). Optional so the snapshot
   * shape stays additive for value-less sources
   * (AH-0MWJ1680Z001QYV2 · AC4).
   */
  readonly value?: number;
}

/** Minimal boss source. */
export interface BotBossSource {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
}

/** Minimal wave-timer source (satisfied by `PlayScene.getWaveState`). */
export interface BotWaveSource {
  readonly active: boolean;
  readonly timeRemaining: number;
  readonly timeLimit: number;
}

/**
 * The slice of the owning scene the snapshot builder reads. `PlayScene`
 * satisfies it through its existing public getters; tests provide stubs.
 */
export interface BotSnapshotScene {
  getPlayer(): BotPlayerSource | null;
  getBoss(): BotBossSource | null;
  getBossPhase(): number;
  getEnemies(): readonly BotEnemySource[];
  getEnemyBullets(): readonly BotEnemyBulletSource[];
  getPlayerBullets(): readonly BotPlayerBulletSource[];
  getDrops(): readonly BotDropSource[];
  getMinerals(): readonly BotMineralSource[];
  getAliveCount(): number;
  /** The active timed wave's state (satisfied by `PlayScene.getWaveState`). */
  getWaveState(): BotWaveSource;
  /** The current run's seed (satisfied by `PlayScene.getRunSeed`). */
  getRunSeed(): number;
  /** The ship's current life count (satisfied by `PlayScene.getLives`). */
  getLives(): number;
  /** The run's life cap (satisfied by `PlayScene.getLivesCap`). */
  getLivesCap(): number;
}

// ── Builder ──────────────────────────────────────────────────────────

/** Selection of behaviours for {@link buildBotSnapshot}. */
export interface BuildBotSnapshotOptions {
  /**
   * Deep-freezes the snapshot (default `true`, AC4). Set `false` when the
   * caller consumes the tree immediately and never mutates it — the dev
   * telemetry recorder copies the snapshot into a telemetry state vector and
   * discards it, so freezing was a second full traversal of a graph that can
   * hold thousands of entries per recorded frame (AH-0MW2DC20A007TAVY).
   */
  readonly freeze?: boolean;
}

/**
 * Builds a deep-frozen {@link BotSnapshot} from the scene's existing
 * read-only getters (AC2). The source scene is never mutated: every nested
 * array and entry in the result is a fresh plain object.
 *
 * @param scene - A `PlayScene` (or a structural stub in tests).
 * @param options - Optional behaviours (e.g. `freeze: false`).
 */
export function buildBotSnapshot(
  scene: BotSnapshotScene,
  options: BuildBotSnapshotOptions = {},
): BotSnapshot {
  const freeze = options.freeze !== false;
  const playerSource = scene.getPlayer();
  const bossSource = scene.getBoss();
  // Read the live shot speed once: the getter may be stateful in a source.
  const liveShotSpeed = playerSource?.getProjectileSpeed?.();
  // Read the live weapon reach once, on the same structural seam.
  const liveWeaponRange = playerSource?.getEffectiveWeaponRange?.();

  const player: BotPlayer | null = playerSource
    ? {
        ...copyMovement(playerSource.getMovementState()),
        // Carry the live thruster physics only when the source exposes it,
        // so snapshots from sources without the getter keep their existing
        // shape (the no-config fallback semantics hold) (AH-0MV85WFWD0029DL7).
        ...(playerSource.getThrusterConfig
          ? { thruster: playerSource.getThrusterConfig() }
          : {}),
        // Carry the live rotation tuning and the primary travelling-shot
        // speed the same way (AH-0MWR04ZDU0005O8J · AC2): the aim solve reads
        // the ship's physics through this snapshot seam, never a bot-layer
        // constant.
        ...(playerSource.getRotationConfig
          ? { rotation: playerSource.getRotationConfig() }
          : {}),
        ...(typeof liveShotSpeed === 'number' && Number.isFinite(liveShotSpeed)
          ? { shotSpeed: liveShotSpeed }
          : {}),
        // The ship's effective weapon reach (AH-0MWPOET5A002IPTP): carried the
        // same way as the shot speed, so the aim/fire solve can tell an
        // in-reach target from a firing-at-nothing one through the snapshot
        // seam rather than a bot-layer weapon constant.
        ...(typeof liveWeaponRange === 'number' &&
        Number.isFinite(liveWeaponRange)
          ? { weaponRange: liveWeaponRange }
          : {}),
      }
    : null;

  const boss: BotBoss | null = bossSource
    ? {
        x: bossSource.x,
        y: bossSource.y,
        alive: bossSource.alive,
        phase: scene.getBossPhase(),
      }
    : null;

  const snapshot = {
    player,
    enemies: scene.getEnemies().map((enemy) => ({
      id: botEntityId(enemy),
      x: enemy.x,
      y: enemy.y,
      alive: enemy.alive,
      archetype: enemy.archetype,
      // Carry the tell flag only when the source exposes it, so snapshots
      // from non-tell archetypes keep their original shape.
      ...(enemy.isTelling !== undefined ? { isTelling: enemy.isTelling } : {}),
      // Carry velocity only when the source exposes a physics body; the
      // lead-prediction consumer treats an absent velocity as zero (AC2).
      ...(typeof enemy.vx === 'number' && typeof enemy.vy === 'number'
        ? { vx: enemy.vx, vy: enemy.vy }
        : {}),
      // The movement class is resolved bot-side from the archetype
      // (AH-0MWM0C6OW006G5SE); a source that already declares one keeps it.
      movementClass:
        enemy.movementClass ?? resolveEnemyMovementClass(enemy.archetype),
    })),
    enemyBullets: scene.getEnemyBullets().map((bullet) => ({
      x: bullet.graphics.x,
      y: bullet.graphics.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    playerBullets: scene.getPlayerBullets().map((bullet) => ({
      x: bullet.x,
      y: bullet.y,
      vx: bullet.vx,
      vy: bullet.vy,
    })),
    drops: scene.getDrops().map((drop) => ({
      x: drop.x,
      y: drop.y,
      type: drop.dropId,
    })),
    minerals: scene.getMinerals().map((mineral) => ({
      x: mineral.x,
      y: mineral.y,
      type: BOT_MINERAL_TYPE,
      // Carry the value only when the source exposes it, so value-less gym
      // minerals keep their original shape (AH-0MWJ1680Z001QYV2 · AC4).
      ...(typeof mineral.value === 'number' && Number.isFinite(mineral.value)
        ? { value: mineral.value }
        : {}),
    })),
    boss,
    aliveCount: scene.getAliveCount(),
    wave: copyWave(scene.getWaveState()),
    runSeed: scene.getRunSeed(),
    lives: scene.getLives(),
    livesCap: scene.getLivesCap(),
    reverseEnabled: playerSource?.isReverseEnabled?.() ?? false,
  };

  return freeze ? deepFreeze(snapshot) : (snapshot as BotSnapshot);
}

/** Module-local identity map: the source object -> its stable bot-side id. */
const enemyIds = new WeakMap<object, number>();
let nextEnemyId = 1;

/**
 * Allocates (or returns) the stable bot-side id for an entity source
 * (AH-0MVI4QDN90037DIN · AC1).
 *
 * A source that already exposes a numeric `id` keeps it; otherwise the builder
 * assigns one from the module-local `WeakMap` and counter above. The map is
 * keyed by object identity, so the same live entity keeps its id across every
 * snapshot (and the id is released with the entity) — no per-archetype entity
 * changes and no snapshot-seam mutation of the source.
 *
 * Exported so the shared aim-hit seam resolves identity through the **same**
 * map the snapshot builder uses (AH-0MWR054VE006YSLN): the id a hit reports is
 * exactly the id the governor aimed at, never a parallel identity scheme.
 */
export function botEntityId(source: object): number {
  const declaredId = (source as { readonly id?: unknown }).id;
  if (typeof declaredId === 'number') return declaredId;
  const existing = enemyIds.get(source);
  if (existing !== undefined) return existing;
  const id = nextEnemyId;
  nextEnemyId += 1;
  enemyIds.set(source, id);
  return id;
}

/**
 * Whether the snapshot's ship is below the run's life cap. The competent bot
 * uses this to gate its Extra Life preference (AH-0MV03GXZQ00801T4 · AC2/AC3).
 */
export function livesBelowCap(snapshot: BotSnapshot): boolean {
  return snapshot.lives < snapshot.livesCap;
}

/** Copies the wave-timer state into a plain `BotWave` object. */
function copyWave(source: BotWaveSource): BotWave {
  return {
    active: source.active,
    timeRemaining: source.timeRemaining,
    timeLimit: source.timeLimit,
  };
}

/** Copies the movement state into a plain `BotPlayer` object. */
function copyMovement(state: {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
}): BotPlayer {
  return { x: state.x, y: state.y, vx: state.vx, vy: state.vy };
}

/**
 * Recursively freezes an object graph (the snapshot, its arrays and the
 * plain entries inside them). Cycles are impossible here — the builder
 * constructs a fresh tree — but `Object.isFrozen` guards re-freezing in
 * case a future change shares a subtree.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
