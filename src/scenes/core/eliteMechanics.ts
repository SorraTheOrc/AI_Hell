/**
 * The **bounded** elite (anomaly) mechanics — implemented once, in the shared
 * combat core, so the game and every gym run identical code
 * (AH-0MWU665XK000ZT4S, parent AH-0MWL7P1AO003LKXT).
 *
 * ## What an elite is
 *
 * An elite is **not** a new entity class: it is one ordinary, counted spawn of
 * an existing archetype, elevated to carry one extra bounded behaviour and a
 * bonus hit-point pool. The authored vocabulary lives in
 * `src/core/eliteVocabulary.ts` (`ELITE_BEHAVIOURS`, validated loudly at
 * load) and the per-wave choice lives in `src/waves/eliteSpawn.ts`; this module
 * owns the **numbers and the per-death decisions**, mirroring the shipped
 * `hexPersonalityMechanics.ts` precedent so the mechanic set cannot creep:
 *
 * | behaviour | seam it reuses | effect |
 * |---|---|---|
 * | `splitter` | shared spawn path (`createEnemyFromConfig` + wave registration) | on the lethal blow releases two ordinary children of its archetype that burst out of the still-visible wreck |
 * | `reinforced` | `enemyForceFieldHits` + the shared bubble visuals | one extra force-field hit |
 * | `volatile` | the shared enemy-bullet seam | on death leaves a short-lived radial burst |
 *
 * ## Where the decisions live
 *
 * Consumers apply the decisions at their shipped seams; no scene or gym
 * re-implements one:
 *
 * - {@link eliteForceFieldHits} — the spawn seam resolves the reinforced
 *   extra field hit through the identical `enemyForceFieldHits` curve the
 *   ordinary force field uses, so `BaseEnemy`'s shared bubble visuals render
 *   it unchanged.
 * - {@link eliteBonusHealth} — the spawn seam applies the authored
 *   `eliteBonusHp` on top of the archetype's ordinary `health`.
 * - {@link applyEliteDeathBehaviour} — the shared pre-destruction seam
 *   (`CombatCoreScene.onEnemyBeforeDestroyed`, called from the entity's own
 *   `destroySelf()` *before* the hull is hidden) invokes it with the scene's
 *   spawn/registration host, so a splitter's children and a volatile burst
 *   are created by the same dispatcher in the game and in every gym.
 * - {@link startEliteSplitBurst} / {@link stepEliteSplitBurst} — the
 *   deterministic outward impulse a splitter child leaves the wreck with.
 *   Both scenes' existing position passes apply it, so the escape is identical
 *   in the game and in every gym (AH-0MWZERK75006FD3B).
 *
 * ## Neutral by default
 *
 * A blank/absent `eliteBehaviour` yields an empty descriptor list, the plain
 * force-field curve, the archetype's own health, zero children and zero burst
 * bullets — today's behaviour byte-for-byte.
 *
 * Pure and total: no Phaser, no storage, no scene and no entity imports.
 *
 * @module src/scenes/core/eliteMechanics
 */

import {
  ELITE_BONUS_HP_MAX,
  ELITE_BONUS_HP_MIN,
  ELITE_BEHAVIOURS,
  type EliteBehaviour,
} from '../../core/eliteVocabulary';
import {
  enemyForceFieldHits,
  type ForceFieldConfig,
} from '../../core/enemyForceField';

/**
 * The **bounded** behaviour set carrying a shared mechanic.
 *
 * Re-exported from the authored vocabulary (`ELITE_BEHAVIOURS`) so the shared
 * core and the validated data are the same short list: a fourth behaviour
 * cannot be added here without adding it to the validated vocabulary first.
 */
export const ELITE_MECHANIC_SET: readonly EliteBehaviour[] = Object.freeze([
  ...ELITE_BEHAVIOURS,
]);

/**
 * Ordinary children a `splitter` elite releases on death. Two, so the
 * priority decision ("kill the splitter first or lose the gap") is real while
 * the behaviour stays bounded.
 */
export const ELITE_SPLITTER_CHILD_COUNT = 2;

/**
 * Radius (px) around the wreck within which a splitter child appears.
 *
 * The children materialise at — or within a few pixels of — the elite's own
 * position, so the split reads as ships escaping the doomed hull rather than
 * replacing it (AH-0MWZERK75006FD3B). Deterministic and mirrored left/right,
 * so a split never consumes an RNG draw and the same seeded run reproduces the
 * same fan.
 */
export const ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX = 4;

/**
 * Speed (px/s) a splitter child leaves the wreck at.
 *
 * Materially faster than any archetype's ordinary `driftSpeed` (the fastest
 * authored drift is 140 px/s), so the escape is unmistakable
 * (AH-0MWZERK75006FD3B).
 */
export const ELITE_SPLITTER_CHILD_BURST_SPEED_PX = 360;

/**
 * Outward distance (px) a splitter child travels before it settles back into
 * its ordinary archetype movement — far enough to clear the doomed hull and
 * its explosion, short enough that the child rejoins the fight immediately.
 */
export const ELITE_SPLITTER_CHILD_BURST_DISTANCE_PX = 60;

/**
 * Duration (s) of the outward burst, derived so the eased profile starts at
 * exactly {@link ELITE_SPLITTER_CHILD_BURST_SPEED_PX} and ends at rest (an
 * ease-out cubic's initial rate is three times its average rate).
 */
export const ELITE_SPLITTER_CHILD_BURST_DURATION_S =
  (3 * ELITE_SPLITTER_CHILD_BURST_DISTANCE_PX) /
  ELITE_SPLITTER_CHILD_BURST_SPEED_PX;

/**
 * The extra force-field hits a `reinforced` elite carries, added on top of the
 * ordinary `enemyForceFieldHits` curve (which is itself clamped to
 * `[0, FORCE_FIELD_HIT_CAP]`; a reinforced elite may therefore carry one more
 * than an ordinary archetype's ceiling — that is the behaviour).
 */
export const ELITE_REINFORCED_FIELD_BONUS = 1;

/** Bullets in a `volatile` elite's radial death burst. */
export const ELITE_VOLATILE_BURST_COUNT = 8;

/** Speed (px/s) of each volatile burst bullet. */
export const ELITE_VOLATILE_BURST_SPEED = 110;

/**
 * Lifetime (seconds) of each volatile burst bullet — short-lived, so the burst
 * is a readable punctuation of the kill rather than a lingering wall.
 */
export const ELITE_VOLATILE_BURST_LIFETIME = 0.9;

/** One published elite mechanic descriptor (data, so intel and tests share it). */
export interface EliteMechanic {
  /** The behaviour that carries the mechanic. */
  readonly id: EliteBehaviour;
  /** The kind of effect, stable so callers can switch on it. */
  readonly kind: 'split-on-death' | 'extra-force-field-hit' | 'death-burst';
  /** The magnitude the consumer applies (a body/bullet count or a hit bonus). */
  readonly magnitude: number;
  /** One-line description for the known-ahead intel / telemetry. */
  readonly summary: string;
}

/** The `splitter` mechanic descriptor (frozen: shared read-only value). */
const SPLITTER_MECHANIC: EliteMechanic = Object.freeze({
  id: 'splitter' as const,
  kind: 'split-on-death' as const,
  magnitude: ELITE_SPLITTER_CHILD_COUNT,
  summary: 'it breaks into two ordinary children when destroyed',
});

/** The `reinforced` mechanic descriptor (frozen: shared read-only value). */
const REINFORCED_MECHANIC: EliteMechanic = Object.freeze({
  id: 'reinforced' as const,
  kind: 'extra-force-field-hit' as const,
  magnitude: ELITE_REINFORCED_FIELD_BONUS,
  summary: 'its force field absorbs one hit more than the archetype',
});

/** The `volatile` mechanic descriptor (frozen: shared read-only value). */
const VOLATILE_MECHANIC: EliteMechanic = Object.freeze({
  id: 'volatile' as const,
  kind: 'death-burst' as const,
  magnitude: ELITE_VOLATILE_BURST_COUNT,
  summary: `it leaves a short ${ELITE_VOLATILE_BURST_COUNT}-shot radial burst when destroyed`,
});

/**
 * The mechanics a behaviour carries, as published descriptors.
 *
 * @param behaviour — the authored behaviour (or `null`/`undefined`).
 * @returns the descriptors, in a stable order (`[]` for an ordinary enemy).
 */
export function eliteMechanicsFor(
  behaviour: EliteBehaviour | null | undefined,
): readonly EliteMechanic[] {
  if (behaviour === 'splitter') return [SPLITTER_MECHANIC];
  if (behaviour === 'reinforced') return [REINFORCED_MECHANIC];
  if (behaviour === 'volatile') return [VOLATILE_MECHANIC];
  return [];
}

/**
 * Ordinary children a behaviour releases on death.
 *
 * @param behaviour — the authored behaviour (or `null`/`undefined`).
 * @returns {@link ELITE_SPLITTER_CHILD_COUNT} for `splitter`, `0` otherwise —
 *   so a caller can size the spawn without a second condition.
 */
export function eliteSplitChildCount(
  behaviour: EliteBehaviour | null | undefined,
): number {
  return behaviour === 'splitter' ? ELITE_SPLITTER_CHILD_COUNT : 0;
}

/** One splitter child's offset from the wreck (px). */
export interface EliteSplitOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * The mirrored left/right direction of splitter child `index` (−1 = left,
 * +1 = right). Deterministic, so the fan is identical on every run and never
 * needs an RNG draw; non-finite values resolve to the first slot.
 */
function eliteSplitChildDirection(index: number): number {
  const slot = Number.isFinite(index)
    ? Math.abs(Math.trunc(index)) % ELITE_SPLITTER_CHILD_COUNT
    : 0;
  return slot % 2 === 0 ? -1 : 1;
}

/**
 * The deterministic offset of splitter child `index` from the wreck: the
 * children appear within {@link ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX} of the
 * elite's own position, alternating left/right, so the fan is identical on
 * every run and never needs an RNG draw.
 *
 * @param index — zero-based child index; non-finite values resolve to `0`.
 */
export function eliteSplitChildOffset(index: number): EliteSplitOffset {
  return {
    x: eliteSplitChildDirection(index) * ELITE_SPLITTER_CHILD_SPAWN_JITTER_PX,
    y: 0,
  };
}

/**
 * A splitter child's transient outward burst (AH-0MWZERK75006FD3B).
 *
 * Both scenes *derive* enemy positions each frame (the game from
 * `startX/startY + driftX`, a gym from its formation base + fractional
 * offset), so the escape cannot be a per-entity velocity. It is a short-lived
 * displacement instead: each scene's existing position pass asks
 * {@link stepEliteSplitBurst} for this frame's offset and adds it to the base
 * it already computes. Once the burst has played out the child sits clear of
 * the wreck and moves exactly like any other ordinary spawn — no movement
 * class, no immunity window.
 */
export interface EliteSplitBurstState {
  /** Unit-length outward direction x (deterministic, mirrored left/right). */
  readonly dirX: number;
  /** Unit-length outward direction y (always `0`: the fan is horizontal). */
  readonly dirY: number;
  /** Seconds the burst has played (accumulated `dt`, clamped to the duration). */
  elapsed: number;
}

/** A splitter child's burst displacement from its formation slot (px). */
export interface EliteSplitBurstOffset {
  readonly x: number;
  readonly y: number;
}

/** Returned while an entity has no burst (or the burst is over): no offset. */
const NO_BURST_OFFSET: EliteSplitBurstOffset = Object.freeze({ x: 0, y: 0 });

/**
 * Starts splitter child `index`'s outward burst at the wreck: no displacement
 * yet, pointing away from the death site on the child's deterministic side.
 *
 * @param index — zero-based child index; non-finite values resolve to `0`.
 */
export function startEliteSplitBurst(index: number): EliteSplitBurstState {
  return { dirX: eliteSplitChildDirection(index), dirY: 0, elapsed: 0 };
}

/**
 * The burst displacement `state` has reached so far (px).
 *
 * The profile is an ease-out cubic: the child leaves at
 * {@link ELITE_SPLITTER_CHILD_BURST_SPEED_PX}, decelerates smoothly and comes
 * to rest exactly {@link ELITE_SPLITTER_CHILD_BURST_DISTANCE_PX} out, so it
 * settles into its ordinary archetype movement instead of snapping to a stop.
 *
 * @param state — the child's burst state.
 */
export function eliteSplitBurstOffset(
  state: EliteSplitBurstState,
): EliteSplitBurstOffset {
  const progress = Math.min(
    1,
    Math.max(0, state.elapsed / ELITE_SPLITTER_CHILD_BURST_DURATION_S),
  );
  const eased = 1 - (1 - progress) ** 3;
  const travelled = ELITE_SPLITTER_CHILD_BURST_DISTANCE_PX * eased;
  // Normalise `-0` to `0`, so a burst still at the wreck reads as a plain
  // zero offset on either side (`-1 * 0` is `-0` in IEEE 754).
  const x = state.dirX * travelled;
  const y = state.dirY * travelled;
  return { x: x === 0 ? 0 : x, y: y === 0 ? 0 : y };
}

/**
 * Advances a burst by `dt` and returns the displacement the scene's position
 * pass should add to the child's slot this frame (the offset the burst has
 * reached *after* the step).
 *
 * The total travel is therefore reached after
 * {@link ELITE_SPLITTER_CHILD_BURST_DURATION_S} of accumulated time, however
 * the frames are split, and a settled burst keeps returning its full distance
 * so the child stays clear of the wreck. An entity without a burst
 * (`undefined`) is a total no-op, so an ordinary spawn's position pass is
 * byte-for-byte today's behaviour.
 *
 * @param state — the child's burst state, if it has one.
 * @param dt — this frame's time step (seconds); non-finite/negative means
 *   no advance.
 */
export function stepEliteSplitBurst(
  state: EliteSplitBurstState | undefined,
  dt: number,
): EliteSplitBurstOffset {
  if (state === undefined) return NO_BURST_OFFSET;
  const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
  state.elapsed = Math.min(
    ELITE_SPLITTER_CHILD_BURST_DURATION_S,
    state.elapsed + step,
  );
  return eliteSplitBurstOffset(state);
}

/**
 * Extra force-field hits a behaviour adds on top of an archetype's ordinary
 * field strength.
 *
 * This is the bounded part of the `reinforced` rule, kept separate so a spawn
 * site that resolves the *base* through a documented divergence (the formation
 * gym's direct slider hits, AH-0MVM8GXEF009883O) still applies the identical
 * elite bonus — never a second copy of the number.
 *
 * @param behaviour — the authored behaviour (or `null`/`undefined`).
 * @returns {@link ELITE_REINFORCED_FIELD_BONUS} for `reinforced`, `0`
 *   otherwise.
 */
export function eliteForceFieldBonus(
  behaviour: EliteBehaviour | null | undefined,
): number {
  return behaviour === 'reinforced' ? ELITE_REINFORCED_FIELD_BONUS : 0;
}

/**
 * Force-field hits an elite of `behaviour` carries at `level`.
 *
 * The ordinary curve is always evaluated once through the shipped
 * {@link enemyForceFieldHits} resolver (never re-derived here); a `reinforced`
 * elite adds exactly one hit on top of it through
 * {@link eliteForceFieldBonus}.
 *
 * @param behaviour — the authored behaviour (or `null`/`undefined`).
 * @param level — the live campaign level, resolved by the shared curve.
 * @param config — the archetype's force-field curve.
 */
export function eliteForceFieldHits(
  behaviour: EliteBehaviour | null | undefined,
  level: number,
  config: ForceFieldConfig,
): number {
  return enemyForceFieldHits(level, config) + eliteForceFieldBonus(behaviour);
}

/**
 * The hit pool an elite spawns with: the archetype's ordinary `health` plus
 * the authored `eliteBonusHp`.
 *
 * The authoritative range check lives at config load
 * (`src/core/eliteVocabulary.ts`); this is the bounded application, so a value
 * that reaches a spawn by another route can never fabricate an unbounded
 * pool. A blank/absent bonus (or one outside the authored range) adds nothing.
 *
 * @param baseHealth — the archetype's ordinary hit pool.
 * @param bonusHp — the authored `eliteBonusHp` cell (1–3), if any.
 */
export function eliteBonusHealth(
  baseHealth: number,
  bonusHp: number | null | undefined,
): number {
  const base = Number.isFinite(baseHealth) ? Math.max(0, baseHealth) : 0;
  if (typeof bonusHp !== 'number' || !Number.isFinite(bonusHp)) return base;
  const bonus = Math.min(
    ELITE_BONUS_HP_MAX,
    Math.max(ELITE_BONUS_HP_MIN, Math.floor(bonusHp)),
  );
  return base + bonus;
}

/** One shot of a volatile elite's radial death burst. */
export interface EliteBurstShot {
  /** Zero-based shot index, in the fan's stable firing order. */
  readonly index: number;
  /** Travel heading in radians. */
  readonly angle: number;
  /** Horizontal speed (px/s). */
  readonly vx: number;
  /** Vertical speed (px/s). */
  readonly vy: number;
}

/**
 * The volatile death burst, precomputed once: one shot per even slice of the
 * circle at {@link ELITE_VOLATILE_BURST_SPEED}. Deterministic, so the burst is
 * identical in the game and in every gym.
 */
const VOLATILE_BURST_SHOTS: readonly EliteBurstShot[] = Object.freeze(
  Array.from({ length: ELITE_VOLATILE_BURST_COUNT }, (_, index) => {
    const angle = (index * 2 * Math.PI) / ELITE_VOLATILE_BURST_COUNT;
    return Object.freeze({
      index,
      angle,
      vx: Math.cos(angle) * ELITE_VOLATILE_BURST_SPEED,
      vy: Math.sin(angle) * ELITE_VOLATILE_BURST_SPEED,
    });
  }),
);

/**
 * The shots a behaviour fires on death.
 *
 * @param behaviour — the authored behaviour (or `null`/`undefined`).
 * @returns the frozen radial fan for `volatile`, an empty list otherwise.
 */
export function eliteVolatileBurstShots(
  behaviour: EliteBehaviour | null | undefined,
): readonly EliteBurstShot[] {
  return behaviour === 'volatile' ? VOLATILE_BURST_SHOTS : [];
}

/**
 * One splitter child's spawn order: where it appears relative to the wreck
 * and the outward burst it leaves with.
 */
export interface EliteSplitSpawn {
  /** Where the child appears — within a few px of the wreck. */
  readonly offset: EliteSplitOffset;
  /** The outward burst the child starts with (deterministic per index). */
  readonly burst: EliteSplitBurstState;
}

/**
 * The scene seams a per-death behaviour needs. The shared dispatcher owns
 * *how many*, *where* and *at what speed*; the host owns *how* to create the
 * child or bullet through its shipped spawn seam, so no scene re-implements a
 * rule.
 */
export interface EliteDeathHost {
  /** Spawns one ordinary splitter child through the scene's shipped seam. */
  spawnSplitChild(spawn: EliteSplitSpawn): void;
  /** Spawns one volatile burst bullet through the shared enemy-bullet seam. */
  spawnVolatileBullet(shot: EliteBurstShot): void;
}

/** What {@link applyEliteDeathBehaviour} spawned. */
export interface EliteDeathOutcome {
  /** Ordinary children spawned. */
  readonly children: number;
  /** Death-burst bullets spawned. */
  readonly bullets: number;
}

/**
 * Applies a dead elite's one bounded behaviour through the supplied host.
 *
 * This is the single per-death decision point: a `splitter` asks the host for
 * two ordinary children, a `volatile` asks for its radial burst, and
 * `reinforced` does nothing on death (its effect is applied at spawn through
 * {@link eliteForceFieldHits}). A blank/absent behaviour is a total no-op, so
 * an ordinary kill is byte-for-byte today's behaviour.
 *
 * @param behaviour — the dead elite's authored behaviour.
 * @param host — the scene's spawn seams.
 * @returns what was spawned, so a caller/test can read the decision without
 *   observing the scene.
 */
export function applyEliteDeathBehaviour(
  behaviour: EliteBehaviour | null | undefined,
  host: EliteDeathHost,
): EliteDeathOutcome {
  const childCount = eliteSplitChildCount(behaviour);
  if (childCount > 0) {
    for (let index = 0; index < childCount; index += 1) {
      host.spawnSplitChild({
        offset: eliteSplitChildOffset(index),
        burst: startEliteSplitBurst(index),
      });
    }
    return { children: childCount, bullets: 0 };
  }

  const shots = eliteVolatileBurstShots(behaviour);
  for (const shot of shots) host.spawnVolatileBullet(shot);
  return { children: 0, bullets: shots.length };
}
