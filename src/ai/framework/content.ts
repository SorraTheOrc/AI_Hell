/**
 * Content registry for the bot framework (AH-0MUY08X98002TRHT).
 *
 * Goals, behaviours and the world model never switch on a concrete enemy
 * archetype or drop id. Instead they look the content up in a
 * {@link BotContent} registry: adding a new enemy, power-up or weapon is a
 * **config entry**, not a core edit (AC1–AC3). Unknown content resolves to a
 * documented default profile so a custom/Save-As entity still gets sensible
 * behaviour instead of crashing or freezing the bot (AC4).
 *
 * Two profiles are described:
 *
 * - {@link EnemyContentProfile} — per enemy archetype: a relative **threat**
 *   weight, a preferred **engagement range**, the **aim/lead** behaviour and
 *   whether the archetype is an **asteroid-like hazard** (partitioned into the
 *   asteroid band rather than the combat band).
 * - {@link DropContentProfile} — per power-up/weapon drop id: a collection
 *   **desirability** value the goal scorer and collect behaviour consume.
 *
 * Values are relative, not absolute: a threat of `1` and a drop value of `1`
 * are the neutral defaults, so an entry only has to say how it differs.
 *
 * @module src/ai/framework/content
 */

import { Registry, type Identified } from './registry';

/**
 * How the bot should hold its aim against an enemy archetype.
 *
 * - `none` — no aim reasoning; the bot simply closes/avoids (e.g. a roaming
 *   hazard it does not need to track).
 * - `direct` — once inside the engagement range, point the hull straight at
 *   the target and coast so a forward-firing weapon stays on it.
 * - `lead` — reserved for predictive lead. The read-only snapshot exposes no
 *   enemy velocity, so today `lead` resolves to the same hold as `direct`;
 *   it is accepted so content can declare the intent for a future predictor.
 */
export type EnemyAimBehaviour = 'none' | 'direct' | 'lead';

/** Bot-relevant description of one enemy archetype (AC1). */
export interface EnemyContentProfile extends Identified {
  /**
   * Relative threat weight (neutral `1`). It scales the enemy band's target
   * proximity so a more dangerous archetype is prioritised; it never lets the
   * enemy band outrank the collection bands.
   */
  readonly threat: number;
  /**
   * Preferred standoff distance (px). Omitted means "use the behaviour's
   * tunable `engagementRange`", which keeps ranges single-sourced in
   * `competent/tunables.ts` unless an archetype genuinely needs its own.
   */
  readonly engagementRange?: number;
  /** Whether the bot should hold its aim axis against this archetype. */
  readonly aim: EnemyAimBehaviour;
  /**
   * Whether the archetype is an asteroid-like hazard (obstacle) rather than a
   * combat target. The world model partitions these into `liveAsteroids` so
   * the `engage-asteroid` band handles them.
   */
  readonly asteroidLike: boolean;
}

/** Bot-relevant description of one power-up/weapon drop (AC2). */
export interface DropContentProfile extends Identified {
  /**
   * Collection desirability (neutral `1`, bounded to the power-up band).
   * The goal scorer and collect behaviour prefer a higher-value drop even
   * when it is slightly farther away.
   */
  readonly value: number;
}

/**
 * Profile used for an enemy archetype that has no registered entry.
 *
 * The documented graceful default (AC4): a neutral, non-asteroid combat
 * target with direct aim and the behaviour's own engagement range (mirroring
 * the legacy decision layer, which treats an unknown archetype as a Scout).
 */
export const DEFAULT_ENEMY_PROFILE: EnemyContentProfile = Object.freeze({
  id: 'default',
  threat: 1,
  aim: 'direct',
  asteroidLike: false,
});

/**
 * Profile used for a drop id that has no registered entry. A neutral
 * desirability of `1` means an unknown drop is collected exactly like a
 * generic power-up (AC4).
 */
export const DEFAULT_DROP_PROFILE: DropContentProfile = Object.freeze({
  id: 'default',
  value: 1,
});

/** Specification accepted by {@link createBotContent}. */
export interface BotContentSpec {
  /** Registered enemy archetype profiles. */
  readonly enemies?: Iterable<EnemyContentProfile>;
  /** Registered power-up/weapon drop profiles. */
  readonly drops?: Iterable<DropContentProfile>;
  /** Override for the unknown-enemy default (defaults to {@link DEFAULT_ENEMY_PROFILE}). */
  readonly defaultEnemy?: EnemyContentProfile;
  /** Override for the unknown-drop default (defaults to {@link DEFAULT_DROP_PROFILE}). */
  readonly defaultDrop?: DropContentProfile;
}

/**
 * The bot's content registry: enemy archetype profiles and drop profiles,
 * each with a documented fallback for unknown ids.
 *
 * Registration is append-only (a duplicate id throws, so a content typo fails
 * loudly) and lookup is id-keyed, so core code never switches on ids.
 */
export class BotContent {
  private readonly enemies: Registry<EnemyContentProfile>;
  private readonly drops: Registry<DropContentProfile>;
  private readonly defaultEnemy: EnemyContentProfile;
  private readonly defaultDrop: DropContentProfile;

  constructor(spec: BotContentSpec = {}) {
    this.enemies = new Registry<EnemyContentProfile>().registerAll(
      spec.enemies ?? [],
    );
    this.drops = new Registry<DropContentProfile>().registerAll(
      spec.drops ?? [],
    );
    this.defaultEnemy = spec.defaultEnemy ?? DEFAULT_ENEMY_PROFILE;
    this.defaultDrop = spec.defaultDrop ?? DEFAULT_DROP_PROFILE;
  }

  /**
   * The profile for `archetype`, or the documented default when it is not
   * registered (AC4).
   */
  resolveEnemy(archetype: string): EnemyContentProfile {
    return this.enemies.get(archetype) ?? this.defaultEnemy;
  }

  /**
   * The profile for drop `type`, or the documented default when it is not
   * registered (AC4).
   */
  resolveDrop(type: string): DropContentProfile {
    return this.drops.get(type) ?? this.defaultDrop;
  }

  /** Whether `archetype` is an asteroid-like hazard (AC1). */
  isAsteroidLike(archetype: string): boolean {
    return this.resolveEnemy(archetype).asteroidLike;
  }

  /** Whether an archetype has an explicit (non-default) entry. */
  hasEnemy(archetype: string): boolean {
    return this.enemies.has(archetype);
  }

  /** Whether a drop id has an explicit (non-default) entry. */
  hasDrop(type: string): boolean {
    return this.drops.has(type);
  }

  /** Every registered enemy profile in registration order. */
  enemyProfiles(): readonly EnemyContentProfile[] {
    return this.enemies.all();
  }

  /** Every registered drop profile in registration order. */
  dropProfiles(): readonly DropContentProfile[] {
    return this.drops.all();
  }
}

/** Builds a {@link BotContent} registry from a spec. */
export function createBotContent(spec: BotContentSpec = {}): BotContent {
  return new BotContent(spec);
}

/** An empty content registry (every lookup resolves to the default). */
export const EMPTY_BOT_CONTENT: BotContent = createBotContent();
