/**
 * Weapon catalogue + heading-relative angle math (GDD §2.3, §4.4).
 *
 * The classic-arcade weapons (`wave_laser`, `ricochet`, `cluster`, `options`)
 * are the implemented weapon picks from the research catalogue
 * `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md` (epic AH-0MV14SO0G0095IJ4), which
 * records each concept's source game, adaptation, catalogue seam and gym.
 *
 * Provides pure, unit-testable weapon definitions — each with a pattern
 * (relative angle offsets), fire rate, bullet colour, and bullet shape —
 * plus utilities to convert a heading into absolute bullet angles and
 * velocities.
 *
 * Weapons are **cumulative and timed** (GDD §4.4 revision): collecting a
 * weapon power-up (Spread, Dual, Rapid) **adds** it to the ship's active
 * set for **10 seconds** (each with its own independent countdown from the
 * moment of collection), after which it expires and stops firing. The
 * **cannon** is the permanent starting weapon — always active, never
 * expires; a **reset** power-up clears all timed weapons, leaving only the
 * cannon.
 *
 * Five conventional/beam weapons:
 * - **cannon** — single bullet straight ahead (permanent default starting weapon)
 * - **spread** — 3-bullet fan at -30° / 0° / +30° relative to heading (timed)
 * - **dual**   — 2 bullets offset perpendicular (±90°) to heading (timed)
 * - **rapid**  — single bullets at a much higher fire rate (timed)
 * - **wave_laser** — a single slow, wide beam with a total damage budget: it
 *   blows through the enemies it destroys and spends the rest on the ones
 *   behind them (R-Type homage, timed; see
 *   {@link WeaponDefinition.maxHitPoints})
 * - **ricochet** — a single shot that reflects off the arena edges up to a
 *   budget of bounces (Centipede homage, timed; see
 *   {@link WeaponDefinition.bounce})
 * - **cluster** — a single missile that splits once, on impact or expiry,
 *   into a radial cluster of warheads (Missile Command MIRV homage, timed;
 *   see {@link WeaponDefinition.splits})
 * - **options** — orbiting satellite pods that each fire radially outward
 *   along their own orbit direction (Gradius Options homage, timed; see
 *   {@link WeaponDefinition.orbit})
 *
 * Distances use **radians** for math (Phaser convention, positive =
 * clockwise); the scene-facing helpers (`createBulletsFromHeading`,
 * `angleToVelocity`) accept heading in **degrees** for readability.
 *
 * Fire rates are **beat subdivisions** (AH-0MUAYB8EH005RJ8B): each weapon's
 * interval is an exact fraction of the shared 80 BPM beat period, derived
 * from the pure beat-clock module (`utils/beat.ts`) rather than hard-coded.
 * This keeps every current and future weapon on-grid by construction, and
 * `isOnBeatGrid` is the catalogue-wide invariant that guards it.
 */

import {
  DEFAULT_BPM,
  beatPeriodMs,
  beatSubdivisionMs,
} from './beat';

// ── Weapon IDs ───────────────────────────────────────────────────────

/**
 * Unique weapon identifiers. `'cannon'` is the starting weapon; the
 * `'reset'` drop type returns the ship to it (not a weapon itself).
 *
 * The `'nova' | 'mortar' | 'arc'` ids are the **area-of-effect (AOE)**
 * family (parent AH-0MUOOB3OR001V8CD): each carries an {@link AoEDescriptor}
 * that the shared combat core reads to resolve its area effect.
 */
export type WeaponId =
  | 'cannon'
  | 'spread'
  | 'dual'
  | 'rapid'
  | 'wave_laser'
  | 'ricochet'
  | 'cluster'
  | 'options'
  | 'nova'
  | 'mortar'
  | 'arc'
  // Net-new (epic AH-0MVCC8XSS007P01Z, AH-0MVCRC52P001YIPW): the unlock-pool
  // weapons spread across the campaign's later levels.
  | 'rear_guard'
  | 'broadside'
  | 'railgun'
  | 'shard_swarm'
  | 'heavy_slug';

// ── AOE descriptors ─────────────────────────────────────────────────

/**
 * When an area-of-effect weapon resolves its effect:
 * - `'onFire'` — the area resolves at the ship the instant the weapon fires
 *   (e.g. an expanding nova ring or a chaining arc — no travelling shot).
 * - `'onImpact'` — the weapon launches a projectile whose area resolves when
 *   it hits an enemy/bullet or expires. Retained for potential future
 *   weapons; no catalogue weapon currently uses it (the Mortar moved to
 *   `'onRandom'`), but the projectile-detonation machinery stays in place.
 * - `'onRandom'` — the area resolves immediately at one or more points
 *   sampled uniformly at random within the weapon's effective range, centred
 *   on the ship (no travelling shot, no forward bias; e.g. the Mortar).
 * - `'screenPulse'` — a non-weapon, once-per-activation screen-wide pulse
 *   (the Defender Smart Bomb power-up, AH-0MV1BIWP9003EHRQ). It is resolved
 *   by the shared power-up pulse path via {@link AoEDescriptor}, reusing the
 *   same target-selection and effect-application seam as the AOE weapons.
 */
export type AoETrigger = 'onFire' | 'onImpact' | 'onRandom' | 'screenPulse';

/**
 * Declarative orbit-emitter descriptor attached to the Gradius Options weapon
 * (AH-0MV1BIVVK0043TEM). The shared combat core reads it to spawn and drive
 * the orbiting satellite pods identically in the game and every gym — the
 * descriptor carries only data, never behaviour. The pure pod geometry lives
 * in `scenes/core/optionsEscort.ts`.
 */
export interface OrbitDescriptor {
  /**
   * Level-resolved number of orbiting pods (base grown by the
   * `projectileCount` upgrade, capped at {@link OPTIONS_MAX_PODS}).
   */
  pods: number;
  /** Orbit radius (px) of the pods around the ship. */
  radius: number;
}

/**
 * Declarative area-of-effect descriptor attached to an AOE weapon
 * (parent AH-0MUOOB3OR001V8CD). The shared combat core reads it once and
 * resolves the effect identically in the game and every gym — the descriptor
 * carries only data, never behaviour.
 */
export interface AoEDescriptor {
  /** When the area effect resolves (see {@link AoETrigger}). */
  trigger: AoETrigger;
  /** Effect radius in pixels, measured from the effect origin. */
  radius: number;
  /** Whether the effect damages enemies inside the radius. */
  damagesEnemies: boolean;
  /** Whether the effect clears enemy bullets inside the radius. */
  clearsEnemyBullets: boolean;
  /**
   * Hit points each affected enemy takes per resolution (default 1). The
   * AOE weapons omit this (one hit per blast); the Defender Smart Bomb
   * resolves a level-derived value so a single screen pulse can chip a
   * multi-hit enemy harder (AH-0MV1BIWP9003EHRQ).
   */
  damage?: number;
  /**
   * Maximum number of additional targets an `'onFire'` effect may chain to
   * after the primary target (0/undefined = no chaining). Reserved for the
   * Arc weapon's chain mechanic.
   */
  chains?: number;
  /**
   * Projectile speed (px/s) for an `'onImpact'` weapon. The shared auto-fire
   * loop launches the projectile at this speed; when omitted it falls back to
   * the shared `BULLET_SPEED`. An `'onFire'` descriptor never launches a
   * projectile, so the field is ignored for it. For an `'onRandom'` weapon
   * the field is **required** and supplies the range basis: the random
   * detonation points are sampled within
   * `projectileSpeed × def.bulletLifetime` px of the ship.
   */
  projectileSpeed?: number;
}

/**
 * The AOE weapon ids, in catalogue order. Exposed so dispatch and tests can
 * iterate the family without hard-coding the membership list.
 */
export const AOE_WEAPON_IDS: readonly WeaponId[] = ['nova', 'mortar', 'arc'];

/** Returns true when `id` is an AOE weapon (carries an {@link AoEDescriptor}). */
export function isAoeWeapon(id: WeaponId): boolean {
  return AOE_WEAPON_IDS.includes(id);
}

/**
 * Returns true when the weapon is a timed power-up (Spread, Dual, Rapid)
 * — collected weapons that expire after `WEAPON_TIMEOUT_MS`. The cannon
 * is the only permanent weapon (never expires).
 */
export function isTimedWeapon(id: WeaponId): boolean {
  return id !== 'cannon';
}

// ── Tunable weapon constants (fire rates, bullet tuning) ────────────

/**
 * Shots per beat for each weapon — the musical subdivision that defines
 * its fire rate. The cannon is double-time (2/beat, 160 BPM); spread and
 * dual are whole-time (1/beat, 80 BPM); rapid is six-per-beat (6/beat,
 * 480 BPM). These are the **defaults**; the live values are configurable
 * through `core/rules.ts` (`weaponSubdivisions`), and every fire rate is
 * derived from them so it is an exact subdivision of the beat period
 * (AH-0MUAYB8EH005RJ8B).
 */
export type WeaponSubdivisions = Record<WeaponId, number>;

/**
 * Default shots-per-beat for each weapon. The four conventional weapons are
 * integer subdivisions (cannon 2, spread 1, dual 1, rapid 6). The AOE family
 * fires **slower than the beat**, so its entries are fractional subdivisions:
 * Nova fires once every 4 beats (`0.25`), Mortar once every 2 beats (`0.5`)
 * and Arc once per beat (`1`). `beatSubdivisionMs` accepts any positive
 * number, and every derived rate stays an exact subdivision/multiple of the
 * beat, so the on-grid invariant holds for the whole catalogue.
 */
export const DEFAULT_WEAPON_SUBDIVISIONS: WeaponSubdivisions = {
  cannon: 2,
  spread: 1,
  dual: 1,
  rapid: 6,
  wave_laser: 1,
  ricochet: 1,
  cluster: 0.5,
  options: 1,
  nova: 0.25,
  mortar: 0.5,
  arc: 1,
  rear_guard: 2,
  broadside: 0.5,
  railgun: 0.25,
  shard_swarm: 1,
  heavy_slug: 0.5,
};

/** Default cannon subdivision (2 shots per beat). */
export const WEAPON_CANNON_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.cannon;
/** Default spread subdivision (1 shot per beat). */
export const WEAPON_SPREAD_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.spread;
/** Default dual subdivision (1 shot per beat). */
export const WEAPON_DUAL_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.dual;
/** Default rapid subdivision (6 shots per beat). */
export const WEAPON_RAPID_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.rapid;
/** Default wave-laser subdivision (1 shot per beat → 750 ms at 80 BPM). */
export const WEAPON_WAVE_LASER_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.wave_laser;
/** Default ricochet subdivision (1 shot per beat → 750 ms at 80 BPM). */
export const WEAPON_RICOCHET_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.ricochet;
/**
 * Default cluster-missile subdivision (once every 2 beats → 1500 ms at
 * 80 BPM). The slow cadence is what the split payload pays for.
 */
export const WEAPON_CLUSTER_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.cluster;
/**
 * Default Options subdivision (1 shot per beat → 750 ms at 80 BPM). The pods
 * fire on the same whole-beat cadence as the spread/dual weapons.
 */
export const WEAPON_OPTIONS_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.options;
/** Default Nova subdivision (once every 4 beats → 3000 ms at 80 BPM). */
export const WEAPON_NOVA_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.nova;
/** Default Mortar subdivision (once every 2 beats → 1500 ms at 80 BPM). */
export const WEAPON_MORTAR_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.mortar;
/** Default Arc subdivision (once per beat → 750 ms at 80 BPM). */
export const WEAPON_ARC_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.arc;
/** Default Rear Guard subdivision (2 shots per beat → 375 ms at 80 BPM). */
export const WEAPON_REAR_GUARD_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.rear_guard;
/** Default Broadside subdivision (once every 2 beats → 1500 ms at 80 BPM). */
export const WEAPON_BROADSIDE_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.broadside;
/** Default Railgun subdivision (once every 4 beats → 3000 ms at 80 BPM). */
export const WEAPON_RAILGUN_SUBDIVISION = DEFAULT_WEAPON_SUBDIVISIONS.railgun;
/** Default Shard Swarm subdivision (once per beat → 750 ms at 80 BPM). */
export const WEAPON_SHARD_SWARM_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.shard_swarm;
/** Default Heavy Slug subdivision (once every 2 beats → 1500 ms at 80 BPM). */
export const WEAPON_HEAVY_SLUG_SUBDIVISION =
  DEFAULT_WEAPON_SUBDIVISIONS.heavy_slug;

/**
 * Derives a weapon's fire interval (ms) from a subdivision of the beat:
 * `beatPeriodMs(bpm) / subdivisions`. Every rate is therefore an exact
 * subdivision of the beat by construction, so the catalogue-wide on-grid
 * invariant holds for any configured BPM/subdivisions (AH-0MUAYB8EH005RJ8B).
 *
 * @param weaponId - The weapon whose interval to derive.
 * @param subdivisions - Shots per beat per weapon (defaults to the catalogue).
 * @param bpm - Tempo in beats per minute (default 80).
 */
export function weaponFireRateMs(
  weaponId: WeaponId,
  subdivisions: WeaponSubdivisions = DEFAULT_WEAPON_SUBDIVISIONS,
  bpm: number = DEFAULT_BPM,
): number {
  const count =
    subdivisions[weaponId] ?? DEFAULT_WEAPON_SUBDIVISIONS[weaponId];
  return beatSubdivisionMs(count, bpm);
}

/**
 * Fire rate interval for the cannon (ms between shots) — 2 shots per beat
 * of the default 80 BPM grid (375 ms).
 */
export const WEAPON_CANNON_FIRE_RATE = beatSubdivisionMs(WEAPON_CANNON_SUBDIVISION);

/**
 * Fire rate interval for the spread weapon (ms) — 1 shot per beat (750 ms).
 */
export const WEAPON_SPREAD_FIRE_RATE = beatSubdivisionMs(WEAPON_SPREAD_SUBDIVISION);

/**
 * Fire rate interval for the dual weapon (ms) — 1 shot per beat (750 ms).
 */
export const WEAPON_DUAL_FIRE_RATE = beatSubdivisionMs(WEAPON_DUAL_SUBDIVISION);

/**
 * Fire rate interval for the rapid weapon (ms) — 6 shots per beat (125 ms),
 * the fastest weapon on the grid.
 */
export const WEAPON_RAPID_FIRE_RATE = beatSubdivisionMs(WEAPON_RAPID_SUBDIVISION);

/**
 * Fire rate interval for the R-Type wave laser (ms) — 1 shot per beat
 * (750 ms at the default 80 BPM). Deliberately slow so the beam reads as a
 * committed, aimed shot rather than a rapid stream.
 */
export const WEAPON_WAVE_LASER_FIRE_RATE = beatSubdivisionMs(
  WEAPON_WAVE_LASER_SUBDIVISION,
);

/**
 * Fire rate interval for the Centipede ricochet (ms) — 1 shot per beat
 * (750 ms at the default 80 BPM). A measured cadence so each bank shot is a
 * deliberate aimed reflection rather than a spray.
 */
export const WEAPON_RICOCHET_FIRE_RATE = beatSubdivisionMs(
  WEAPON_RICOCHET_SUBDIVISION,
);

/**
 * Fire rate interval for the Missile Command cluster missile (ms) — 1 shot
 * every 2 beats (1500 ms at the default 80 BPM). Slow and committed: each
 * shell is a deliberate split payload rather than a stream of fire.
 */
export const WEAPON_CLUSTER_FIRE_RATE = beatSubdivisionMs(
  WEAPON_CLUSTER_SUBDIVISION,
);

/**
 * Fire rate interval for the Gradius Options escort (ms) — 1 shot per beat
 * (750 ms at the default 80 BPM). Every pod fires on this cadence.
 */
export const WEAPON_OPTIONS_FIRE_RATE = beatSubdivisionMs(
  WEAPON_OPTIONS_SUBDIVISION,
);

/**
 * Fire rate interval for the Nova AOE weapon (ms) — 1 shot every 4 beats
 * (3000 ms at the default 80 BPM). Slow and defensive: a sparse pulse that
 * clears the ship's immediate surroundings.
 */
export const WEAPON_NOVA_FIRE_RATE = beatSubdivisionMs(WEAPON_NOVA_SUBDIVISION);

/**
 * Fire rate interval for the Mortar AOE weapon (ms) — 1 shot every 2 beats
 * (1500 ms at the default 80 BPM). The blast resolves at a random point
 * within range on fire.
 */
export const WEAPON_MORTAR_FIRE_RATE = beatSubdivisionMs(WEAPON_MORTAR_SUBDIVISION);

/**
 * Fire rate interval for the Arc AOE weapon (ms) — 1 shot per beat (750 ms at
 * the default 80 BPM), the fastest AOE cadence.
 */
export const WEAPON_ARC_FIRE_RATE = beatSubdivisionMs(WEAPON_ARC_SUBDIVISION);
/** Fire rate interval for the Rear Guard (ms) — 2 shots per beat (375 ms). */
export const WEAPON_REAR_GUARD_FIRE_RATE = beatSubdivisionMs(
  WEAPON_REAR_GUARD_SUBDIVISION,
);
/** Fire rate interval for the Broadside (ms) — once every 2 beats (1500 ms). */
export const WEAPON_BROADSIDE_FIRE_RATE = beatSubdivisionMs(
  WEAPON_BROADSIDE_SUBDIVISION,
);
/** Fire rate interval for the Railgun (ms) — once every 4 beats (3000 ms). */
export const WEAPON_RAILGUN_FIRE_RATE = beatSubdivisionMs(
  WEAPON_RAILGUN_SUBDIVISION,
);
/** Fire rate interval for the Shard Swarm (ms) — once per beat (750 ms). */
export const WEAPON_SHARD_SWARM_FIRE_RATE = beatSubdivisionMs(
  WEAPON_SHARD_SWARM_SUBDIVISION,
);
/** Fire rate interval for the Heavy Slug (ms) — once every 2 beats (1500 ms). */
export const WEAPON_HEAVY_SLUG_FIRE_RATE = beatSubdivisionMs(
  WEAPON_HEAVY_SLUG_SUBDIVISION,
);

/** Bullet speed in pixels per second (used by all weapons). */
export const BULLET_SPEED = 350;

/** Per-bullet perpendicular offset (px) for the Dual weapon's side-by-side pattern. */
export const DUAL_SIDE_OFFSET = 8;

/**
 * Per-weapon bullet lifetime (seconds). Bullets wrap across all four screen
 * edges while alive and are destroyed once this many seconds elapse; the
 * effective range is therefore `BULLET_SPEED × bulletLifetime`. Each weapon
 * is tuned independently (AH-0MU960UTE001PTV0); the base lifetimes were
 * halved to bring engagements closer and reduce on-screen bullet saturation
 * (AH-0MUU131PU006O7ZD). Because `resolveWeaponDefinition` applies the level
 * multipliers to these base values, every weapon's range at every level is
 * halved too.
 */
export const WEAPON_BULLET_LIFETIME = {
  /** Cannon — long reach for the default weapon (~262 px). */
  cannon: 0.75,
  /** Spread — slightly shorter than cannon (~245 px). */
  spread: 0.7,
  /** Dual — matches spread (~245 px). */
  dual: 0.7,
  /** Rapid — short reach balanced by its high fire rate (~131 px). */
  rapid: 0.375,
  /**
   * Wave laser — long reach so the beam crosses the arena (~350 px); the
   * slow cadence and the pass-through budget are its identity.
   */
  wave_laser: 1.0,
  /**
   * Ricochet — a long reach so the shot can reach a wall and bank back
   * (~560 px); the bounce budget, not the lifetime, bounds the number of
   * wall reflections.
   */
  ricochet: 1.6,
  /**
   * Cluster missile — a moderate reach (~315 px) so the shell can travel a
   * little before its split; the warhead spread, not the range, is its
   * identity.
   */
  cluster: 0.9,
  /**
   * Options pods — a modest reach (~245 px) matching the spread/dual; the pod
   * count (not the range) is the weapon's identity.
   */
  options: 0.7,
  /** Nova — the ring resolves instantly; no travelling bullet. */
  nova: 0.25,
  /**
   * Mortar — supplies the random-detonation range basis
   * (`projectileSpeed × lifetime` = 180 px at level 0); no travelling shell.
   */
  mortar: 1.0,
  /** Arc — the bolt resolves instantly; no travelling bullet. */
  arc: 0.25,
  /**
   * Rear Guard — matches the cannon's reach (~262 px); its identity is the
   * backward coverage, not range.
   */
  rear_guard: 0.75,
  /** Broadside — a generous reach (~280 px) for the perpendicular pair. */
  broadside: 0.8,
  /**
   * Railgun — a very long reach (~490 px) so the piercing tracer crosses the
   * arena; the slow cadence and pass-through budget are its identity.
   */
  railgun: 1.4,
  /** Shard Swarm — short reach (~193 px); the fan density is its identity. */
  shard_swarm: 0.55,
  /**
   * Heavy Slug — a long, slow reach (~420 px); the heavy size and slow cadence
   * are its identity.
   */
  heavy_slug: 1.2,
} as const;

// ── Bullet visual definitions ───────────────────────────────────────

/** Bullet colour constants — neon palette matching the project aesthetic. */
export const BULLET_COLORS = {
  /** Default cannon bullet — bright cyan. */
  cannon: 0x00ffff,
  /** Spread weapon bullet — warm orange. */
  spread: 0xffaa00,
  /** Dual weapon bullet — vivid magenta. */
  dual: 0xff00ff,
  /** Rapid weapon bullet — electric yellow. */
  rapid: 0xffff00,
  /** Wave laser beam — vivid neon blue, distinct from the cyan cannon. */
  wave_laser: 0x3366ff,
  /** Ricochet pellet — neon green, distinct from every other weapon. */
  ricochet: 0x33ff66,
  /** Cluster missile / warheads — neon hot pink, distinct from every weapon. */
  cluster: 0xff3366,
  /**
   * Options pod bullets — neon aquamarine, distinct from the cannon's cyan
   * and the ricochet's green.
   */
  options: 0x00ffcc,
  /** Nova ring / projectile — pale cyan. */
  nova: 0x66ffff,
  /** Mortar shell / blast — deep orange. */
  mortar: 0xff6600,
  /** Arc chaining bolt — electric purple. */
  arc: 0xcc66ff,
  /** Rear Guard — warm rose, matching its backward-covering shot. */
  rear_guard: 0xff5599,
  /** Broadside — bright teal, matching its perpendicular pair. */
  broadside: 0x44ffdd,
  /** Railgun — sky blue, matching its long piercing tracer. */
  railgun: 0x66aaff,
  /** Shard Swarm — lime, matching its narrow shard fan. */
  shard_swarm: 0xc0ff33,
  /** Heavy Slug — deep red, matching its slow heavy shell. */
  heavy_slug: 0xff2222,
};

/**
 * AOE effect radii (px) — the single source of truth read by the catalogue
 * descriptors and (later) the distinctive VFX helpers. Halved alongside the
 * conventional bullet ranges so AOE coverage is tighter and more positional
 * (AH-0MUU131PU006O7ZD).
 */
export const AOE_RADII = {
  /** Nova ring radius — a defensive pulse around the ship. */
  nova: 45,
  /** Mortar blast radius — a focused detonation at the impact point. */
  mortar: 35,
  /** Arc chaining reach — the longest AOE, spanning nearby targets. */
  arc: 60,
} as const;

/**
 * AOE `'onImpact'` projectile speeds (px/s). Slower than the standard
 * `BULLET_SPEED` (350), so a shell visibly arcs across the screen and its
 * detonation point stays legible. Also the **range basis** for the Mortar's
 * `'onRandom'` detonation spread: `projectileSpeed × bulletLifetime`
 * (180 px at level 0).
 */
export const AOE_PROJECTILE_SPEEDS = {
  /** Mortar — deliberate travel scale, and the random-detonation range basis. */
  mortar: 180,
} as const;

// ── Cluster/MIRV split tuning ───────────────────────────────────────

/**
 * Base number of warheads a cluster missile splits into before leveling — the
 * un-upgraded cluster size. The `splitCount` weapon-level variable grows the
 * effective count toward its finite spec cap (3). A cluster always spawns at
 * least two warheads, so the base weapon already reads as a split payload.
 *
 * The warheads fan **evenly around the full 360° circle** with a constant
 * +90° phase offset from the missile's heading (shared `splitProjectile`
 * seam): at this base count of 2 they split to 90°/270° — perpendicular,
 * never straight ahead (0°) or backwards (180°).
 */
export const CLUSTER_BASE_WARHEADS = 2;

/**
 * Warhead lifetime (seconds) once a cluster missile splits. Short, so the
 * radial spray covers a burst of nearby space and then expires rather than
 * saturating the arena with long-lived bullets.
 */
export const CLUSTER_WARHEAD_LIFETIME = 0.4;

/**
 * Warhead radius as a fraction of the spawned projectile's radius. Smaller
 * than the parent missile so the split reads as a cluster of fragments.
 */
export const CLUSTER_WARHEAD_RADIUS_SCALE = 0.7;

/**
 * Radius (px) of the code-drawn split-burst VFX spawned at the split point,
 * scaled to the number of warheads by the shared VFX helper.
 */
export const CLUSTER_SPLIT_BURST_RADIUS = 24;

// ── Gradius Options orbit tuning ────────────────────────────────────

/**
 * Base number of orbiting pods before leveling — the un-upgraded Options
 * escort. The `projectileCount` weapon-level variable adds one pod per point,
 * capped at {@link OPTIONS_MAX_PODS}.
 */
export const OPTIONS_BASE_PODS = 2;

/**
 * Hard cap on the number of orbiting pods. Keeps the orbit legible (and the
 * per-frame spawn cost bounded) as `projectileCount` grows toward its spec cap.
 */
export const OPTIONS_MAX_PODS = 6;

/**
 * Orbit radius (px) of the pods around the ship. Shallow enough that the pods
 * read as an escort rather than a separate formation.
 */
export const OPTIONS_ORBIT_RADIUS = 28;

/**
 * Time (ms) for one full pod orbit revolution. A slow, readable circle so the
 * player can steer the escort.
 *
 * Deliberately not a whole-number multiple of the Options fire interval
 * (`WEAPON_OPTIONS_FIRE_RATE`, 750 ms at 80 BPM): 750 / 2000 = 0.375 rotates
 * per trigger, so beat-triggered volleys aim in different radial directions
 * instead of re-aiming identically (`isOptionsOrbitTriggerAligned`,
 * AH-0MV5DFBVW002J2XO).
 */
export const OPTIONS_ORBIT_PERIOD_MS = 2000;

/** Radius (px) of a code-drawn pod. */
export const OPTIONS_POD_RADIUS = 4;

/**
 * Pod bullet speed (px/s) — slower than the shared `BULLET_SPEED` so the pod
 * shots read as a lighter escort than the main gun.
 */
export const OPTIONS_POD_BULLET_SPEED = 300;

/**
 * Bullet shape type — determines how the bullet is drawn.
 *
 * Extends the original `'circle' | 'line'` pair into the full code-drawn
 * shape family consumed by the shared bullet-shape rendering seam
 * (`src/utils/bulletVisuals.ts`, parent AH-0MV8228MD009UBF7):
 *
 * - `circle` — filled disc (legacy name, renders exactly like `disc`)
 * - `disc` — filled disc
 * - `line` — line/beam (the Wave Laser and Dual must render as a beam)
 * - `teardrop` — teardrop/streak
 * - `missile` — capsule + nose + fins
 * - `ring` — hollow ring
 * - `shell` — two-tone round shell with a hot core
 * - `heavy-shell` — the Tank's large two-tone shell with a slow breathing glow
 *   (AH-0MV822DF60001EPA)
 * - `shard` — the Diver's sharp splinter/arrowhead, spine-glint shimmer
 *   (AH-0MV822D2U000LRFV)
 * - `bolt` — jagged bolt
 * - `phaser-bolt` — the Phaser's crisply-edged hexagonal bolt with a bright
 *   velocity-aligned core streak (AH-0MV822DRX009RYUB)
 * - `fleck` — the Swarm's tiny fast cometary fleck, massed-fire micro-shard
 *   (AH-0MV822E4T006F37Y)
 * - `dart` — the Raider's slim sharp-nosed dart with a short trail
 *   (AH-0MV822EH800780GI)
 * - `boss-pellet` — the Boss spread pattern's dense pellet with a menacing
 *   concentric ring accent (AH-0MV822ETD008LLZX)
 * - `spiral-pellet` — the Boss spiral pattern's pellet carrying the boss
 *   phase colour, with a short spiral-wake arc (AH-0MV822F5J006WFR0)
 * - `pulse-ring` — the Boss pulse pattern's slow wide pulse ring
 *   (AH-0MV822FHN005PK37)
 * - `tracer` — the Boss desperation burst's bright velocity-aligned tracer
 *   (AH-0MV822FTS00156F5)
 * - `warhead` — the OrbitalStrike's falling shell with a fiery tail
 *   (AH-0MV822GIO005B685)
 * - `diamond` — four-point rhombus
 * - `spark` — four-point star
 * - `chevron` — forward-opening V
 *
 * The catalogue assigns one distinct shape per weapon so every weapon is
 * visually unique in flight (`canonicalShape` collapses the `circle`/`disc`
 * alias so the roster test never counts them as two signatures).
 *   projectile-identity roster and the RosterTest-guarded per-weapon visual
 */
export type BulletShape =
  | 'circle'
  | 'disc'
  | 'line'
  | 'teardrop'
  | 'missile'
  | 'ring'
  | 'shell'
  | 'heavy-shell'
  | 'shard'
  | 'bolt'
  | 'phaser-bolt'
  | 'fleck'
  | 'dart'
  | 'boss-pellet'
  | 'spiral-pellet'
  | 'pulse-ring'
  | 'tracer'
  | 'warhead'
  | 'diamond'
  | 'spark'
  | 'chevron'
  | 'pellet';

// ── Weapon definition ───────────────────────────────────────────────

/**
 * A single weapon definition: human-readable name, relative angle
 * offsets (the shot pattern, in radians), fire rate in milliseconds,
 * bullet colour, shape, and size multiplier.
 */
export interface WeaponDefinition {
  /** Unique weapon ID (e.g. `'cannon'`). */
  id: WeaponId;
  /** Human-readable display name. */
  name: string;
  /**
   * One-line player-facing effect description (GDD §4.4). Rendered by the
   * gym help overlay so help copy cannot drift from the catalogue.
   */
  description: string;
  /** Relative angle offsets in radians — each fires at `heading + offset`. */
  offsets: ReadonlyArray<number>;
  /**
   * Per-bullet positional offset (px) **perpendicular** to the heading
   * (one per pattern bullet; defaults to 0s). Lets a pattern place
   * parallel bullets side-by-side offset across the direction of travel
   * (e.g. Dual) without changing their flight angles.
   */
  sideOffsets?: ReadonlyArray<number>;
  /** Milliseconds between shots. */
  fireRateMs: number;
  /** Bullet colour (Phaser integer). */
  bulletColor: number;
  /** Bullet visual shape. */
  bulletShape: BulletShape;
  /**
   * Elongation multiplier for elongated shapes (line/teardrop/missile/bolt/
   * chevron): the bullet's long axis is `radius × length` px. Absent → the
   * shared shape's default (`DEFAULT_SHAPE_LENGTH` in `bulletVisuals.ts`).
   * Visual metadata only (AH-0MV8228MD009UBF7).
   */
  bulletShapeLength?: number;
  /**
   * Optional neon rim/outline colour (Phaser integer) for shapes that
   * support a rim (disc/shell/teardrop/diamond/spark/ring). Visual metadata
   * only (AH-0MV8228MD009UBF7).
   */
  bulletRim?: number;
  /**
   * Stroke-thickness multiplier for stroked shapes (line/ring/bolt/chevron);
   * `1` uses the default 2 px stroke. Visual metadata only
   * (AH-0MV8228MD009UBF7).
   */
  bulletThickness?: number;
  /** Bullet radius multiplier relative to the default. */
  bulletSize: number;
  /**
   * Additional bullet-radius multiplier granted by **weapon leveling**
   * (parent AH-0MUPMPCB2009J54J). `1`/absent on a base definition; a
   * level-resolved definition carries the level's `bulletSize` upgrade so the
   * shared combat core can grow the bullet without changing the base visual
   * size (AC8).
   */
  levelBulletSize?: number;
  /**
   * Bullet lifetime in seconds. The bullet wraps across all four screen
   * edges while alive and expires once this elapses; effective range is
   * `BULLET_SPEED × bulletLifetime` (AH-0MU960UTE001PTV0).
   */
  bulletLifetime: number;
  /**
   * Base **hit-point budget** a fired bullet may deal before it is consumed —
   * the R-Type wave-laser damage seam (AH-0MV1BIUSJ0090W92,
   * AH-0MV97RISJ002WR2S). The beam spends one budget point per hit point of
   * damage: it passes through the ships it destroys and spends its remaining
   * budget on the ships behind them. `0`/absent means an ordinary single-hit
   * bullet.
   *
   * A bullet's effective budget is this base value plus the weapon's
   * level-resolved `maxHitPoints` upgrade (from `weaponLevels.ts`); the shared
   * combat core tracks already-damaged enemies so each is charged once (see
   * `resolveWeaponDefinition`).
   */
  maxHitPoints?: number;
  /**
   * Base **wall-bounce budget** — how many times a fired bullet reflects off
   * the arena edges before it expires instead of wrapping (Centipede ricochet
   * homage, AH-0MV1BIV5L005NJAI). `undefined`/absent means an ordinary
   * wrapping bullet (the default four-edge wrap). `0` is a degenerate value
   * (expires on the first wall contact).
   *
   * A bullet's effective budget is this base value plus the weapon's
   * level-resolved `bounce` upgrade (from `weaponLevels.ts`), clamped to that
   * variable's spec cap; the shared player-bullet step reflects the velocity
   * component at the edge, decrements the budget, and expires the bullet once
   * the budget is spent (see `resolveWeaponDefinition` and
   * `PlayerBullet.advance`).
   */
  bounce?: number;
  /**
   * Base **split warhead count** — how many radial warheads a fired
   * projectile splits into exactly once, on the first enemy/bullet impact or
   * on lifetime expiry (Missile Command cluster/MIRV homage,
   * AH-0MV1BIVIJ007KYXU). `undefined`/absent means an ordinary bullet that
   * never splits. `0` is a degenerate value (no warheads spawned).
   *
   * A projectile's effective warhead count is this base value grown by the
   * weapon's level-resolved `splitCount` upgrade (from `weaponLevels.ts`),
   * clamped to that variable's finite spec cap; the shared combat-core split
   * seam reads the field and spawns the warheads identically in the game and
   * every gym (see `resolveWeaponDefinition` and
   * `CombatCoreScene.splitProjectile`).
   */
  splits?: number;
  /**
   * Orbit-emitter descriptor — the Gradius Options companion-entity seam
   * (AH-0MV1BIVVK0043TEM). When present the weapon does **not** use its
   * `offsets` pattern: the shared combat core spawns `orbit.pods` satellite
   * pods that orbit the ship and each fires a bullet radially outward along its
   * own orbit direction through the ordinary `PlayerBullet` path. Absent on
   * every conventional weapon.
   *
   * `pods` is the **level-resolved** pod count: {@link resolveWeaponDefinition}
   * grows the base count with the `projectileCount` upgrade, clamped to
   * `OPTIONS_MAX_PODS`, so the game and every gym read one count.
   */
  orbit?: OrbitDescriptor;
  /**
   * Area-of-effect descriptor (absent for conventional weapons). When
   * present the shared combat core dispatches the area effect through the
   * AOE seam rather than treating the shot as an ordinary bullet
   * (parent AH-0MUOOB3OR001V8CD).
   */
  aoe?: AoEDescriptor;
  /**
   * Optional short fading trail drawn behind the bullet in flight
   * (AH-0MV8228YW0050IXS). Value is the tail length as a multiplier of the
   * bullet radius, measured behind the shape's trailing edge. The shared
   * bullet-shape seam draws a tapering fade when present; absent → no trail.
   * Visual metadata only — never affects flight.
   */
  bulletTrail?: number;
  /**
   * Optional animated exhaust-flame length, as a multiplier of the bullet
   * radius (AH-0MV822B1B0048UZT). Drawn as a flickering two-tone flame behind
   * the missile's tail through the shared bullet-shape seam; the flame length
   * shimmers with the bullet's elapsed time so a missile reads as powered in
   * flight. Absent → no flame (the default for every non-missile weapon).
   * Visual metadata only — never affects flight.
   */
  bulletFlame?: number;
  /**
   * Optional clean launch-cue VFX spawned at the muzzle when this weapon
   * fires (AH-0MV8228YW0050IXS). The shared combat core spawns it once per
   * shot through the shared spawn path, so the game and every gym show the
   * same flash. Absent → no muzzle flash.
   */
  muzzleFlash?: MuzzleFlashSpec;
  /**
   * Optional distinct impact feedback for when this weapon's shot connects
   * (AH-0MV8228YW0050IXS): a coloured impact flash plus a baked hit cue,
   * resolved through the shared impact seam. Absent → the generic impact
   * flash with no per-weapon hit sound.
   */
  impactFx?: ImpactFxSpec;
}

/**
 * Muzzle-flash VFX spec (AH-0MV8228YW0050IXS) — the clean launch cue a
 * weapon shows at the ship when it fires. Consumed by the shared muzzle-FX
 * helper (`src/vfx/muzzleFlash.ts`) through the shared combat-core spawn
 * path.
 */
export interface MuzzleFlashSpec {
  /** Flash colour (Phaser integer). */
  color: number;
  /** Flash core radius (px). */
  radius: number;
  /** Flash fade duration (seconds). */
  duration: number;
}

/**
 * Per-weapon impact-feedback spec (AH-0MV8228YW0050IXS) — the distinct
 * flash + hit sound that plays when this weapon's shot connects, resolved
 * through the shared impact seam in `CombatScene`. The cue is a baked
 * ToneForge cue export name from `src/audio/effects.ts`.
 */
export interface ImpactFxSpec {
  /** Impact flash colour (Phaser integer). */
  color: number;
  /** Impact flash radius (px). */
  radius: number;
  /** Impact flash duration (seconds). */
  duration: number;
  /** Baked ToneForge impact cue export name (e.g. `playCannonImpactSound`). */
  cue: string;
}

// ── Weapon catalogue ────────────────────────────────────────────────

/**
 * The complete weapon catalogue — cannon plus the three weapon
 * power-ups (spread, dual, rapid).
 *
 * Spread uses a 3-bullet fan (-30°, 0°, +30°). Dual fires 2 bullets
 * perpendicular to the heading (±90°). Rapid fires single bullets fast.
 */
export const WEAPON_CATALOGUE: Record<WeaponId, WeaponDefinition> = {
  cannon: {
    id: 'cannon',
    name: 'Cannon',
    description: 'Permanent default weapon — one bullet straight ahead.',
    offsets: [0],
    fireRateMs: WEAPON_CANNON_FIRE_RATE,
    bulletColor: BULLET_COLORS.cannon,
    // The Cannon shot is a compact neon disc: a white-hot neon rim around
    // the cyan core makes the plain fill read as a bright compact disc
    // (AH-0MV8228YW0050IXS). Visual metadata only — same disc shape as
    // before, no behaviour change.
    bulletShape: 'circle',
    bulletRim: 0xffffff,
    // Short fading trail behind the disc, drawn through the shared seam
    // (AH-0MV8228YW0050IXS).
    bulletTrail: 3.5,
    // Clean muzzle flash at the ship when the cannon fires (shared spawn
    // path — AH-0MV8228YW0050IXS).
    muzzleFlash: { color: BULLET_COLORS.cannon, radius: 7, duration: 0.12 },
    // Distinct cyan impact flash + baked hit cue when the shot connects
    // (shared impact seam — AH-0MV8228YW0050IXS).
    impactFx: {
      color: BULLET_COLORS.cannon,
      radius: 9,
      duration: 0.16,
      cue: 'playCannonImpactSound',
    },
    bulletSize: 1,
    bulletLifetime: WEAPON_BULLET_LIFETIME.cannon,
  },
  spread: {
    id: 'spread',
    name: 'Spread',
    description: 'Adds a 3-bullet fan (−30°/0°/+30°).',
    offsets: [(-30 * Math.PI) / 180, 0, (30 * Math.PI) / 180],
    fireRateMs: WEAPON_SPREAD_FIRE_RATE,
    bulletColor: BULLET_COLORS.spread,
    // The Spread shot is the catalogue's warm-amber diamond: a small
    // glowing disc-like gem in the spread colour. The shape family stays
    // `diamond` (the roster guard assigns one unique family per weapon — the
    // `disc` family belongs to the cannon), so the "small disc" read comes
    // from the warm neon rim + brief fading trail + soft muzzle/impact
    // (AH-0MV8229B9009DQGA). Visuals-only metadata; flight unchanged.
    bulletShape: 'diamond',
    // Warm amber rim picks the diamond out of the neon field as a compact
    // glowing gem/disc (AH-0MV8229B9009DQGA).
    bulletRim: 0xffdd66,
    // Brief fading trail — three short tapering segments behind the diamond
    // via the shared bullet-shape seam (AH-0MV8229B9009DQGA).
    bulletTrail: 2.2,
    // Soft muzzle flash / launch cue at the ship when the spread fires
    // (shared combat-core spawn path — AH-0MV8229B9009DQGA).
    muzzleFlash: { color: BULLET_COLORS.spread, radius: 7, duration: 0.14 },
    // Distinct amber impact flash + baked hit cue when a spread shot
    // connects (shared impact seam — AH-0MV8229B9009DQGA).
    impactFx: {
      color: BULLET_COLORS.spread,
      radius: 9,
      duration: 0.16,
      cue: 'playSpreadImpactSound',
    },
    bulletSize: 0.8,
    bulletLifetime: WEAPON_BULLET_LIFETIME.spread,
  },
  dual: {
    id: 'dual',
    name: 'Dual',
    description: 'Adds two side-by-side bullets.',
    // Two parallel bullets, side-by-side across the direction of travel:
    // both fly at heading + 0° but are launched offset perpendicular to
    // the heading by ±DUAL_SIDE_OFFSET px.
    offsets: [0, 0],
    sideOffsets: [-DUAL_SIDE_OFFSET, DUAL_SIDE_OFFSET],
    fireRateMs: WEAPON_DUAL_FIRE_RATE,
    bulletColor: BULLET_COLORS.dual,
    // Two parallel short beams — the Dual reads as side-by-side pulse bars.
    // A slightly chunkier stroke and a short fading wake make the twin bars
    // read as solid pulse bars (never dots), distinctly lighter than the
    // Wave Laser's long piercing beam (AH-0MV8229NM009CZOA). Visual metadata
    // only — flight unchanged.
    bulletShape: 'line',
    bulletShapeLength: 2,
    bulletThickness: 1.6,
    // Short fading trail behind each bar — the twin bars leave a brief
    // magenta wake in flight (AH-0MV8229NM009CZOA).
    bulletTrail: 1.6,
    // Quick launch flash at the ship when the dual fires — short so the
    // fast twin volley stays clean (shared combat-core spawn path,
    // AH-0MV8229NM009CZOA).
    muzzleFlash: { color: BULLET_COLORS.dual, radius: 6, duration: 0.1 },
    // Distinct magenta impact flash + baked twin-snap hit cue when either
    // bar connects (shared impact seam — AH-0MV8229NM009CZOA).
    impactFx: {
      color: BULLET_COLORS.dual,
      radius: 8,
      duration: 0.14,
      cue: 'playDualImpactSound',
    },
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.dual,
  },
  rapid: {
    id: 'rapid',
    name: 'Rapid',
    description: 'Adds single bullets at a much higher fire rate.',
    offsets: [0],
    fireRateMs: WEAPON_RAPID_FIRE_RATE,
    bulletColor: BULLET_COLORS.rapid,
    // The Rapid shot reads as a small, fast staccato flare: the catalogue's
    // `spark` primitive (four-point star, the dedicated rapid-fire flare in
    // `bulletVisuals.ts`) at the smallest 0.7× scale, ringed white-hot so it
    // reads as a compact bright dot/star at 6 shots/beat stream pace
    // (AH-0MV822A03006UT2P). The `disc` family deliberately stays with the
    // cannon — the roster guard assigns one shape family per weapon, so the
    // "small fast disc" read comes from the white rim + short trail +
    // staccato flash + yellow impact, exactly the spread child's convention
    // (AH-0MV8229B9009DQGA). Visual metadata only — flight unchanged.
    bulletShape: 'spark',
    // White-hot neon rim — the small spark reads as a bright hot core with a
    // white halo at stream pace (AH-0MV822A03006UT2P).
    bulletRim: 0xffffff,
    // Short fading trail — brief, so the staccato stream stays clean instead
    // of painting long smears (shared trail seam, AH-0MV822A03006UT2P).
    bulletTrail: 1.8,
    // Staccato muzzle flash / launch cue — short and crisp (the shortest in
    // the catalogue) so rapid volleys stay readable (shared combat-core
    // spawn path — AH-0MV822A03006UT2P).
    muzzleFlash: { color: BULLET_COLORS.rapid, radius: 5, duration: 0.07 },
    // Distinct yellow impact flash + baked rapid-hit cue when a shot connects
    // (shared impact seam — AH-0MV822A03006UT2P).
    impactFx: {
      color: BULLET_COLORS.rapid,
      radius: 7,
      duration: 0.1,
      cue: 'playRapidImpactSound',
    },
    bulletSize: 0.7,
    bulletLifetime: WEAPON_BULLET_LIFETIME.rapid,
  },
  wave_laser: {
    id: 'wave_laser',
    name: 'Wave Laser',
    description:
      'Adds a slow, long-range beam that deals a limited amount of damage in a line.',
    // A single aimed beam along the ship's heading.
    offsets: [0],
    fireRateMs: WEAPON_WAVE_LASER_FIRE_RATE,
    bulletColor: BULLET_COLORS.wave_laser,
    // The beam is a long, thick neon bolt — a visible piercing column,
    // never a dot (AH-0MV8228MD009UBF7 AC1). `line` + a long length + a
    // white-hot rim distinguish it from the Dual's short pair of beams.
    bulletShape: 'line',
    bulletShapeLength: 7,
    bulletRim: 0xffffff,
    bulletThickness: 3,
    bulletSize: 1.2,
    bulletLifetime: WEAPON_BULLET_LIFETIME.wave_laser,
    // Base damage budget: the beam deals up to two hit points in total — it
    // destroys two 1-HP ships (or one 2-HP ship) and then stops. The
    // `maxHitPoints` level variable grows it (~7 at very high levels).
    maxHitPoints: 2,
    // Wide neon muzzle flash / launch cue at the ship when the wave laser
    // fires — a substantial burst befitting the long beam it launches
    // (AH-0MV822ACO007CEZF). The flash is wider than the cannon's to match
    // the beam identity.
    muzzleFlash: { color: BULLET_COLORS.wave_laser, radius: 12, duration: 0.15 },
    // Short fading trail behind the beam — a faint neon wake that extends
    // the beam's visual identity in flight (AH-0MV822ACO007CEZF).
    bulletTrail: 4,
    // Distinct neon-blue impact flash + baked hit cue when a wave laser
    // shot connects (shared impact seam — AH-0MV822ACO007CEZF).
    impactFx: {
      color: BULLET_COLORS.wave_laser,
      radius: 12,
      duration: 0.18,
      cue: 'playWaveLaserImpactSound',
    },
  },
  ricochet: {
    id: 'ricochet',
    name: 'Ricochet',
    description:
      'Adds edge-bouncing shots that ricochet off the arena walls.',
    // A single aimed pellet along the ship's heading; it reflects at the edges.
    offsets: [0],
    fireRateMs: WEAPON_RICOCHET_FIRE_RATE,
    bulletColor: BULLET_COLORS.ricochet,
    bulletShape: 'teardrop',
    bulletSize: 0.8,
    bulletLifetime: WEAPON_BULLET_LIFETIME.ricochet,
    // Short fading trail behind the teardrop, drawn through the shared seam
    // (AH-0MV8228YW0050IXS).
    bulletTrail: 2,
    // Neon rim around the teardrop body — makes the green pellet pop.
    bulletRim: 0xffffff,
    // Clean muzzle flash at the ship when the ricochet fires (shared spawn
    // path — AH-0MV8228YW0050IXS).
    muzzleFlash: { color: BULLET_COLORS.ricochet, radius: 7, duration: 0.12 },
    // Distinct green impact flash + baked hit cue on wall bounce and enemy
    // hit (shared impact seam — AH-0MV8228YW0050IXS).
    impactFx: {
      color: BULLET_COLORS.ricochet,
      radius: 9,
      duration: 0.16,
      cue: 'playRicochetImpactSound',
    },
    // Base wall-bounce budget: the pellet reflects off two walls before it
    // expires on the next contact. The `bounce` level variable grows it
    // toward the spec cap (4).
    bounce: 2,
  },
  cluster: {
    id: 'cluster',
    name: 'Cluster Missile',
    description:
      'Adds a missile that splits into a radial cluster of warheads.',
    // A single aimed missile along the ship's heading; it splits once.
    offsets: [0],
    fireRateMs: WEAPON_CLUSTER_FIRE_RATE,
    bulletColor: BULLET_COLORS.cluster,
    bulletShape: 'missile',
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.cluster,
    // In-flight identity (AH-0MV822B1B0048UZT): a small missile with a
    // flickering exhaust flame, a white-hot neon rim and a short fading
    // smoke trail. All visual metadata — flight (speed, lifetime, splits)
    // is unchanged.
    bulletFlame: 1.6,
    bulletTrail: 2.4,
    bulletRim: 0xffffff,
    // Launch puff at the ship when the cluster missile fires (shared spawn
    // path — AH-0MV8228YW0050IXS): the clean muzzle flash the shared helper
    // draws reads as the missile's launch smoke puff.
    muzzleFlash: { color: BULLET_COLORS.cluster, radius: 9, duration: 0.16 },
    // Distinct hot-pink impact flash + baked hit cue when a shell connects
    // (shared impact seam — AH-0MV8228YW0050IXS).
    impactFx: {
      color: BULLET_COLORS.cluster,
      radius: 10,
      duration: 0.18,
      cue: 'playClusterImpactSound',
    },
    // Base split payload: the missile bursts into two radial warheads on the
    // first impact/expiry. The shared split seam fans them perpendicular to
    // the heading (90°/270° at this base count) and the `splitCount` level
    // variable grows the warhead count toward its spec cap (3), dividing the
    // full 360° circle evenly at every level.
    splits: CLUSTER_BASE_WARHEADS,
  },
  options: {
    id: 'options',
    name: 'Options',
    description:
      'Adds orbiting satellite pods that each fire radially outward, in the direction of the orb.',
    // The orbit descriptor drives pod firing; the single `[0]` offset is a
    // harmless fallback (the shared core never reads the pattern for an
    // orbit weapon).
    offsets: [0],
    fireRateMs: WEAPON_OPTIONS_FIRE_RATE,
    bulletColor: BULLET_COLORS.options,
    bulletShape: 'chevron',
    // In-flight identity (AH-0MV822BDN008IYL6): a small angular pod shot —
    // the shared seam's `chevron` family (the catalogue assigns this unique
    // family to the Options, so its shots read as pod darts, never as the
    // main gun's disc) — with its own pale-aqua neon rim (its own tint, light
    // against the main gun's cyan disc), and a short faint fading trail.
    // All visual metadata; the orbit/fire behaviour is unchanged.
    bulletRim: 0xd9fff2,
    // Light trail behind the pod shot — short and faint so the six-pod
    // rotating volley stays readable (shared bullet-trail seam).
    bulletTrail: 2.0,
    // Clean aqua launch flash / launch cue at the ship when the Options
    // volley fires (shared combat-core spawn path — the same VFX every
    // weapon shows at its muzzle).
    muzzleFlash: { color: BULLET_COLORS.options, radius: 6, duration: 0.12 },
    // Distinct aqua impact flash + baked hit cue when a pod shot connects
    // (shared impact seam), so the escort's hits read and sound distinct
    // from the main gun.
    impactFx: {
      color: BULLET_COLORS.options,
      radius: 8,
      duration: 0.15,
      cue: 'playOptionsImpactSound',
    },
    // Smaller than the cannon's bullet: the pods multiply firepower rather
    // than matching the main gun.
    bulletSize: 0.8,
    bulletLifetime: WEAPON_BULLET_LIFETIME.options,
    // Two pods by default; the `projectileCount` level variable adds one pod
    // each, clamped to OPTIONS_MAX_PODS by resolveWeaponDefinition.
    orbit: {
      pods: OPTIONS_BASE_PODS,
      radius: OPTIONS_ORBIT_RADIUS,
    },
  },
  nova: {
    id: 'nova',
    name: 'Nova',
    description:
      'AOE: an expanding ring around the ship damages every enemy and clears bullets within its radius.',
    // The onFire ring resolves at the ship; no travelling bullet is spawned.
    offsets: [0],
    fireRateMs: WEAPON_NOVA_FIRE_RATE,
    bulletColor: BULLET_COLORS.nova,
    bulletShape: 'ring',
    // Fire feel (AH-0MV822BPT002GF17): a bright pale-cyan launch flash at the
    // ship when the ring shockwave expands — the shared combat-core muzzle
    // flash path drives it from this metadata, so the game and every gym
    // show the same launch cue. The ring shockwave itself is the expanding
    // onFire AOE VFX (`spawnNovaRing` via the shared AOE seam), and the
    // baked nova impact cue plays the instant the ring expands (impact
    // through the shared AOE VFX path). All visual/feel metadata only.
    muzzleFlash: { color: BULLET_COLORS.nova, radius: 10, duration: 0.16 },
    bulletSize: 1.2,
    bulletLifetime: WEAPON_BULLET_LIFETIME.nova,
    aoe: {
      trigger: 'onFire',
      radius: AOE_RADII.nova,
      damagesEnemies: true,
      clearsEnemyBullets: true,
    },
  },
  mortar: {
    id: 'mortar',
    name: 'Mortar',
    description:
      'AOE: detonates at a random point within range, damaging enemies and clearing bullets in a blast.',
    offsets: [0],
    fireRateMs: WEAPON_MORTAR_FIRE_RATE,
    bulletColor: BULLET_COLORS.mortar,
    // In-flight identity (AH-0MV822C250051OVN): the catalogue's `shell`
    // primitive — a two-tone round shell with a hot core — is the Mortar's
    // unique shape family (assigned to no other weapon), so each shot reads
    // as an arcing shell rather than the main gun's disc. The arcing shell
    // identity is carried as the weapon's declared visual in the roster and
    // drawn as a wispy arcing trail + bright blast flash through the shared
    // AOE detonation seam (`spawnMortarBurst`). All visual metadata; the
    // instant onRandom resolution, range, damage and fire cadence are
    // unchanged.
    bulletShape: 'shell',
    // Fire feel (AH-0MV822C250051OVN): a hot deep-orange launch flash at the
    // ship when the shell fires — the shared combat-core muzzle-flash path
    // drives it from this metadata, so the game and every gym show the same
    // launch cue.
    muzzleFlash: { color: BULLET_COLORS.mortar, radius: 9, duration: 0.16 },
    bulletSize: 1.1,
    bulletLifetime: WEAPON_BULLET_LIFETIME.mortar,
    aoe: {
      trigger: 'onRandom',
      radius: AOE_RADII.mortar,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      projectileSpeed: AOE_PROJECTILE_SPEEDS.mortar,
    },
  },
  arc: {
    id: 'arc',
    name: 'Arc',
    description:
      'AOE: a chaining bolt strikes the nearest enemy and arcs to nearby targets, clearing bullets along the path.',
    // The onFire chain resolves immediately; no travelling bullet.
    offsets: [0],
    fireRateMs: WEAPON_ARC_FIRE_RATE,
    bulletColor: BULLET_COLORS.arc,
    bulletShape: 'bolt',
    // Fire feel (AH-0MV822CE7004MQ14): a bright electric-purple launch flash
    // at the ship when the bolt fires — the shared combat-core muzzle-flash
    // path drives it from this metadata, so the game and every gym show the
    // same launch cue. The bolt itself (jagged lightning between targets) is
    // drawn by the shared chain VFX (`spawnArcChain`) through the shared AOE
    // seam.
    muzzleFlash: { color: BULLET_COLORS.arc, radius: 10, duration: 0.16 },
    // Connect feedback (AH-0MV822CE7004MQ14): a distinct electric impact
    // flash at each chained target plus the newly baked arc impact cue,
    // routed through the shared impact seam so the game and every gym
    // connect identically. Visual/feel metadata only — the instant onFire
    // chain resolution, damage, bullet clearing and cadence are unchanged.
    impactFx: {
      color: BULLET_COLORS.arc,
      radius: 9,
      duration: 0.16,
      cue: 'playArcImpactSound',
    },
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.arc,
    aoe: {
      trigger: 'onFire',
      radius: AOE_RADII.arc,
      damagesEnemies: true,
      clearsEnemyBullets: true,
      chains: 2,
    },
  },
  // ── Net-new unlock-pool weapons (epic AH-0MVCC8XSS007P01Z) ────────
  //
  // AH-0MVCRC52P001YIPW adds five net-new weapons beyond the original 11.
  // They are the campaign's unlock-pool rewards (mini-boss reward feature)
  // rather than members of the starting drop rotation, so `WEAPON_DROP_ORDER`
  // deliberately still cycles spread → dual → rapid. Every one uses an
  // existing shared firing seam (pattern offsets / damage budget), so the game
  // and every gym fire them through identical core code.
  rear_guard: {
    id: 'rear_guard',
    name: 'Rear Guard',
    description: 'Adds a backward shot that covers the ship\u2019s tail.',
    // A single shot directly behind the heading — the catalogue's only
    // rearward weapon, complementing the forward-facing cannon family.
    offsets: [Math.PI],
    fireRateMs: WEAPON_REAR_GUARD_FIRE_RATE,
    bulletColor: BULLET_COLORS.rear_guard,
    // A compact trailing pellet, distinct from every other weapon's shape.
    bulletShape: 'pellet',
    bulletRim: 0xffd0e0,
    bulletTrail: 1.6,
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.rear_guard,
  },
  broadside: {
    id: 'broadside',
    name: 'Broadside',
    description: 'Adds two shots perpendicular to the heading (left and right).',
    // A perpendicular pair — no forward shot at all, so the weapon is a
    // distinct tactical trade (wide coverage, no nose coverage).
    offsets: [(-90 * Math.PI) / 180, (90 * Math.PI) / 180],
    fireRateMs: WEAPON_BROADSIDE_FIRE_RATE,
    bulletColor: BULLET_COLORS.broadside,
    // Sleek darts read as the sideways lances leaving the hull.
    bulletShape: 'dart',
    bulletShapeLength: 2.4,
    bulletThickness: 1.4,
    bulletTrail: 1.4,
    bulletSize: 0.9,
    bulletLifetime: WEAPON_BULLET_LIFETIME.broadside,
  },
  railgun: {
    id: 'railgun',
    name: 'Railgun',
    description:
      'Adds a slow, long-range tracer that pierces a line of enemies.',
    // A single aimed shot along the heading, like the wave laser, but with a
    // larger damage budget and a much slower, heavier cadence.
    offsets: [0],
    fireRateMs: WEAPON_RAILGUN_FIRE_RATE,
    bulletColor: BULLET_COLORS.railgun,
    // A long bright tracer reads as the rail's streak.
    bulletShape: 'tracer',
    bulletShapeLength: 8,
    bulletRim: 0xe0f0ff,
    bulletThickness: 2.2,
    bulletTrail: 4.5,
    bulletSize: 1.15,
    bulletLifetime: WEAPON_BULLET_LIFETIME.railgun,
    // Base damage budget greater than the wave laser's (2) — the rail's
    // identity is the deeper line-piercing shot.
    maxHitPoints: 5,
    // Connect feedback (AH-0MVMIGVCE004VSNA): a sky-blue impact flash sized to
    // the heavy tracer plus the newly baked railgun hit cue, routed through the
    // shared impact seam so the game and every gym connect identically instead
    // of falling back to the generic warm-white flash. Visual/feel metadata
    // only — cadence, offsets, lifetime, speed and the pass-through budget are
    // unchanged. The launch flash is deliberately not declared here (see Railgun
    // launch muzzle-flash VFX, AH-0MVQ6C1YL003HU9K).
    impactFx: {
      color: BULLET_COLORS.railgun,
      radius: 10,
      duration: 0.16,
      cue: 'playRailgunImpactSound',
    },
  },
  shard_swarm: {
    id: 'shard_swarm',
    name: 'Shard Swarm',
    description: 'Adds a tight five-shard fan (±15°).',
    // A narrow five-way fan: denser than spread but with a much tighter arc,
    // so it reads as a shotgun burst rather than a broad fan.
    offsets: [
      (-15 * Math.PI) / 180,
      (-7.5 * Math.PI) / 180,
      0,
      (7.5 * Math.PI) / 180,
      (15 * Math.PI) / 180,
    ],
    fireRateMs: WEAPON_SHARD_SWARM_FIRE_RATE,
    bulletColor: BULLET_COLORS.shard_swarm,
    // Small angular shards — the swarm's identity in flight.
    bulletShape: 'shard',
    bulletShapeLength: 1.6,
    bulletTrail: 1.2,
    bulletSize: 0.72,
    bulletLifetime: WEAPON_BULLET_LIFETIME.shard_swarm,
  },
  heavy_slug: {
    id: 'heavy_slug',
    name: 'Heavy Slug',
    description: 'Adds one huge, slow, long-range slug per shot.',
    offsets: [0],
    fireRateMs: WEAPON_HEAVY_SLUG_FIRE_RATE,
    bulletColor: BULLET_COLORS.heavy_slug,
    // The catalogue's heaviest round: a thick shell at the largest scale.
    bulletShape: 'heavy-shell',
    bulletThickness: 3,
    bulletRim: 0xffb0b0,
    bulletTrail: 2.4,
    bulletSize: 1.7,
    bulletLifetime: WEAPON_BULLET_LIFETIME.heavy_slug,
  },
};

/**
 * The **Reset** drop — not a weapon itself, but one of the weapon-pool
 * drops: collecting it clears every timed weapon, leaving only the
 * permanent cannon. Given a catalogue-style entry so gym help can show
 * it alongside the weapons with a single source of truth.
 */
export interface ResetDropDefinition {
  /** Drop identifier (`'reset'`). */
  id: 'reset';
  /** Human-readable display name. */
  name: string;
  /** One-line player-facing effect description. */
  description: string;
}

/** The Reset drop entry (GDD §4.4). */
export const RESET_DROP: ResetDropDefinition = {
  id: 'reset',
  name: 'Reset',
  description: 'Clears all timed weapons, leaving only the Cannon.',
};

/**
 * Looks up a weapon definition by ID.
 * @throws Error if the ID is not in the catalogue.
 */
export function getWeaponById(id: WeaponId): WeaponDefinition {
  const def = WEAPON_CATALOGUE[id];
  if (!def) {
    throw new Error(`Unknown weapon: ${id}`);
  }
  return def;
}

// ── Beat-grid invariant ─────────────────────────────────────────────

/**
 * Returns true when `fireRateMs` is an exact subdivision of the beat period
 * for `bpm`: `beatPeriodMs(bpm) % fireRateMs === 0`. This is the
 * catalogue-wide invariant (AH-0MUAYB8EH005RJ8B): every weapon must fire on
 * the shared beat grid, so a future 20 BPM quarter-time weapon (or any other
 * addition) is on-grid by construction and an off-grid rate is rejected.
 *
 * @param fireRateMs - Fire interval in milliseconds.
 * @param bpm - Tempo in beats per minute (default 80).
 * @returns True when the interval divides the beat period exactly.
 */
export function isOnBeatGrid(
  fireRateMs: number,
  bpm: number = DEFAULT_BPM,
): boolean {
  if (typeof fireRateMs !== 'number' || !Number.isFinite(fireRateMs) || fireRateMs <= 0) {
    return false;
  }
  const period = beatPeriodMs(bpm);
  // Compare in *ratio* space rather than via `%`: `period % fireRateMs` loses
  // precision for high subdivisions (e.g. rapid at 11/beat = 68.18 ms), where
  // 750 / 68.18… evaluates to 10.999… and the remainder check fails on a
  // mathematically on-grid rate. A relative tolerance on the subdivision
  // count is stable across the whole catalogue (AH-0MUQOV9JV00389E7).
  const tolerance = 1e-6;
  const subdivisions = period / fireRateMs;
  if (subdivisions >= 1) {
    return Math.abs(subdivisions - Math.round(subdivisions)) <= tolerance;
  }
  // Slower than the beat: the rate is an exact integer multiple of the beat
  // period (the AOE family, e.g. Nova 3000 ms = 4 beats, Mortar 1500 ms = 2).
  // This keeps an arbitrary off-grid rate (e.g. 200 ms, or 1000 ms = 1⅓
  // beats) rejected.
  const beats = fireRateMs / period;
  return Math.abs(beats - Math.round(beats)) <= tolerance;
}

// ── Round-robin drop order ──────────────────────────────────────────

/** The weapon-drop spawn order: spread → dual → rapid (reset handled separately). */
const WEAPON_DROP_ORDER: readonly WeaponId[] = ['spread', 'dual', 'rapid'];

/**
 * Returns a new array with the weapon-drop spawn order (spread → dual → rapid).
 */
export function weaponDropOrder(): WeaponId[] {
  return [...WEAPON_DROP_ORDER];
}

/**
 * Generates a round-robin weapon sequence of the given length.
 * Cycles spread → dual → rapid → spread → …
 *
 * @param count - Total number of spawns to generate.
 * @returns An array of weapon IDs in spawn order.
 */
export function weaponRoundRobin(count: number): WeaponId[] {
  return Array.from({ length: count }, (_, i) => WEAPON_DROP_ORDER[i % WEAPON_DROP_ORDER.length]);
}

// ── Heading math ─────────────────────────────────────────────────────

/**
 * Converts a velocity vector (vx, vy) into a heading in radians
 * (0 = right, positive = clockwise) — the same convention as Phaser's
 * angle system. Uses `atan2(vy, vx)`; zero velocity yields 0.
 *
 * @param vx - Horizontal velocity component.
 * @param vy - Vertical velocity component.
 * @returns Heading angle in radians.
 */
export function headingFromVelocity(vx: number, vy: number): number {
  return Math.atan2(vy, vx);
}

/**
 * Computes the absolute angle for a bullet given the ship's heading and
 * a relative offset: `absoluteAngle = heading + offset`.
 *
 * @param heading - The ship's heading in radians.
 * @param offset - The pattern offset in radians (relative to heading).
 * @returns Absolute angle in radians.
 */
export function absoluteAngle(heading: number, offset: number): number {
  return heading + offset;
}

/**
 * Derives a bullet velocity from an absolute angle and the bullet speed.
 *
 * @param angle - Absolute angle in radians.
 * @param speed - Bullet speed in px/s.
 * @returns Velocity vector { vx, vy }.
 */
export function bulletVelocity(
  angle: number,
  speed: number,
): { vx: number; vy: number } {
  return {
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
  };
}

/**
 * Converts a heading/angle in degrees to a velocity vector.
 *
 * @param angleDeg - Angle in degrees (0 = right, positive = clockwise).
 * @param speed - Bullet speed in px/s.
 * @returns Velocity vector { vx, vy }.
 */
export function angleToVelocity(
  angleDeg: number,
  speed: number,
): { vx: number; vy: number } {
  return bulletVelocity((angleDeg * Math.PI) / 180, speed);
}

/**
 * Gets bullet creation data for one shot from a weapon at a given
 * heading (radians). Returns the absolute angle (radians) and colour
 * for the bullet at `bulletIndex` in the pattern.
 *
 * @param weapon - The weapon definition.
 * @param heading - The ship's heading in radians.
 * @param bulletIndex - Which bullet in the pattern (0-based).
 * @returns Bullet descriptor, or `null` if out of range.
 */
export interface BulletForShot {
  vx: number;
  vy: number;
  color: number;
  shape: BulletShape;
  /** World-position offset (px) from the ship, applied perpendicular to heading. */
  offsetX: number;
  /** World-position offset (px) from the ship, applied perpendicular to heading. */
  offsetY: number;
}

/**
 * Gets bullet creation data for one shot from a weapon at a given
 * heading (radians). Returns velocity, colour/shape, and the bullet's
 * perpendicular positional offset.
 *
 * @param weapon - The weapon definition.
 * @param heading - The ship's heading in radians.
 * @param bulletIndex - Which bullet in the pattern (0-based).
 * @returns Bullet descriptor, or `null` if out of range.
 */
export function bulletForShot(
  weapon: WeaponDefinition,
  heading: number,
  bulletIndex: number,
): BulletForShot | null {
  if (bulletIndex < 0 || bulletIndex >= weapon.offsets.length) {
    return null;
  }
  const offset = weapon.offsets[bulletIndex];
  const angle = absoluteAngle(heading, offset);
  const vel = bulletVelocity(angle, BULLET_SPEED);
  // Perpendicular unit vector to the heading: (-sin h, cos h).
  const side = weapon.sideOffsets?.[bulletIndex] ?? 0;
  return {
    vx: vel.vx,
    vy: vel.vy,
    color: weapon.bulletColor,
    shape: weapon.bulletShape,
    offsetX: -Math.sin(heading) * side,
    offsetY: Math.cos(heading) * side,
  };
}

/**
 * Gets all bullet creation data for one shot from a weapon at a given
 * heading (radians).
 *
 * @param weapon - The weapon definition.
 * @param heading - The ship's heading in radians.
 * @returns Array of bullet descriptors.
 */
export function allBulletsForShot(
  weapon: WeaponDefinition,
  heading: number,
): BulletForShot[] {
  const result: BulletForShot[] = [];
  for (let i = 0; i < weapon.offsets.length; i++) {
    const bullet = bulletForShot(weapon, heading, i);
    if (bullet) result.push(bullet);
  }
  return result;
}

/**
 * Creates bullet descriptors for the given weapon fired at the ship's
 * current position, with heading in **degrees** (scene-facing helper).
 *
 * @param weapon - The weapon definition.
 * @param headingDeg - The ship's heading in degrees (0 = right, clockwise).
 * @param x - Ship world x position.
 * @param y - Ship world y position.
 * @returns Bullet descriptors ({ x, y, angleDeg, color }).
 */
export function createBulletsFromHeading(
  weapon: WeaponDefinition,
  headingDeg: number,
  x: number,
  y: number,
): Array<{ x: number; y: number; angleDeg: number; color: number }> {
  const headingRad = (headingDeg * Math.PI) / 180;
  return weapon.offsets.map((offset, i) => {
    const angleDeg = headingDeg + (offset * 180) / Math.PI;
    const side = weapon.sideOffsets?.[i] ?? 0;
    return {
      // Position offset perpendicular to the heading (side-by-side bullets).
      x: x - Math.sin(headingRad) * side,
      y: y + Math.cos(headingRad) * side,
      angleDeg,
      color: weapon.bulletColor,
    };
  });
}

// ── Heading fallback ─────────────────────────────────────────────────

/**
 * Computes a heading (radians) from the current velocity, falling back
 * to a default heading when the ship is stationary (speed ≈ 0).
 *
 * @param vx - Current horizontal velocity.
 * @param vy - Current vertical velocity.
 * @param lastHeading - The most recent non-zero heading (fallback).
 * @param defaultHeading - Default heading when no movement history exists (0 = right).
 * @returns A valid heading in radians.
 */
export function computeHeading(
  vx: number,
  vy: number,
  lastHeading: number | null,
  defaultHeading: number = 0,
): number {
  const speed = Math.sqrt(vx * vx + vy * vy);
  if (speed > 0.01) {
    return headingFromVelocity(vx, vy);
  }
  // Ship is stationary — fall back to last heading or the default.
  return lastHeading ?? defaultHeading;
}