/**
 * Behaviour content for the structured competent bot
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4; content-adaptive in AH-0MUY08X98002TRHT).
 *
 * A behaviour executes the committed goal and returns a steering intent, or
 * `null` when it cannot act (the brain then falls back). Every behaviour
 * routes its intent through {@link planSteering}, so the survival safety
 * filter is applied uniformly: no behaviour can steer into a wall, hazard or
 * predicted shot when a safe alternative exists (AC4).
 *
 * - `collect` (mineral / power-up): approach and scoop the best target —
 *   nearest for minerals, highest value-per-distance for power-ups via the
 *   content registry. Collection is **pass-through**
 *   (AH-0MWJ1680Z001QYV2 audit rejection): pickups are collected on contact,
 *   so the bot flies at them and accepts a small overshoot instead of
 *   retro-braking onto them, and it lets go of a pickup it has just flown
 *   past rather than turning back for it.  The retro-brake onto a pickup is
 *   behind the `collectReverseBrake` tunable.
 * - `engage` (enemy / asteroid / boss): pick the best target (nearest,
 *   weighted by each archetype's registered threat), line it up inside its
 *   preferred engagement range, then hold the aim axis and coast so the
 *   forward-firing weapon stays on target (AC3).  With `holdFireEnabled` the
 *   posture is stronger still (AH-0MWW2PFU8001J0PM · RAC2–RAC4): while the
 *   hull is calm and a shot from where it is would connect inside
 *   `holdFireHorizonSeconds`, the bot requests **no** thrust at all and only
 *   rotates to aim; it moves only when it has no firing solution, and it
 *   prefers a target its shot can actually reach (and whose line sweeps other
 *   bodies) over the merely nearest one.  The `engage-boss` goal
 *   restricts the target set to the boss alone, so a committed boss fight
 *   cannot divert to a nearer minion (AH-0MVBMESIE003YQ68).  A target whose
 *   velocity is exposed is **led**: the aim objective is the iterated
 *   intercept, not the current position (AH-0MV1DUSM2005HL98 · AC2).  The
 *   lead velocity comes from the bot-side hazard tracker first — the *same*
 *   estimate the predictive avoidance uses — so a scripted-motion target
 *   that exposes no snapshot velocity is still led, falling back to the
 *   snapshot field and then the current position (AH-0MWR04X10002VNDG ·
 *   AC1).  An archetype whose content profile declares `aim: 'none'` is
 *   closed on without aim reasoning.  Its **kiting gate** asks the one shared
 *   predictive
 *   test (`hazardThreatensPlayer`) whether any non-engagement-target hazard is
 *   on a collision course — the same class-shaped, per-class-horizon
 *   prediction the steering fan applies — and exempts the engagement target by
 *   the shared `isHazardExempt` rule (AH-0MWM0CB2Q003Y6AB).
 * - `evade`: predictive path away from the threats (away from the weighted
 *   centroid of threatening shots), with the steering fan pathing around
 *   anything else in the way (AC2).
 * - `reposition`: drift back toward the playfield centre when idle, coasting
 *   to a stop at the edge of the idle band (`repositionRadius`) rather than
 *   thrusting to the exact centre and overshooting past it
 *   (AH-0MWJ1680Z001QYV2 audit rejection).
 *
 * @module src/ai/framework/competent/behaviours
 */

import type {
  BehaviourRegistry,
  BotBehaviour,
  BotBehaviourContext,
} from '../registry';
import { createBehaviourRegistry } from '../registry';
import type { BotHazardPoint, BotWorld, BotWorldPoint } from '../worldModel';
import type { HazardMotionScratch } from '../hazardMotionModel';
import type { BotContent } from '../content';
import { createBotContent } from '../content';
import {
  COMPETENT_BEHAVIOUR_IDS,
  COMPETENT_GOAL_IDS,
  asteroidTargets,
  bestWeightedTarget,
  bossTargets,
  enemyTargets,
  extraLifeTargets,
  nearestTarget,
  withoutOvershot,
  type ContentTarget,
  type NearestTarget,
} from './goals';
import { hazardThreatensPlayer, idleIntent, interceptPointClassAware, isHazardExempt, mayReverse, mayThrust, planSteering, type SteerPlanOptions } from './steering';
import {
  countShotLineTargets,
  evaluateFireSolution,
  resolveFireSolution,
  type FireTarget,
} from './hitPrediction';
import type { BotSteeringIntent } from '../../botDecision';
import { resolveAimAlignSeconds, resolveShotSpeed, type CompetentBotTunables } from './tunables';
import { botWrapWorld, wrappedAxisDelta, wrappedDelta, wrappedDistance } from '../wrapGeometry';

/**
 * Cross-tick standoff-hysteresis state (AH-0MWT4BBYO0085CN8 · RAC2). Kept on
 * the run's {@link BotBehaviourContext.memory} (not in a closure) so a run
 * restart resets it with every other piece of bot memory.
 */
interface StandoffScratch {
  /** Sticky in/out-of-standoff state; `null` until the first decision. */
  inStandoff: boolean | null;
}

/**
 * Resolves the engage behaviour's standoff scratch, creating it on first use.
 * The key is namespaced under the behaviour id so it can never collide with a
 * goal's own scratch.
 */
function standoffScratch(
  view: BotBehaviourContext,
  key: string,
): StandoffScratch {
  const scratchKey = `${key}:standoff`;
  const existing = view.memory.scratch[scratchKey] as
    | StandoffScratch
    | undefined;
  if (existing) return existing;
  const created: StandoffScratch = { inStandoff: null };
  view.memory.scratch[scratchKey] = created;
  return created;
}

/** The collect targets for a goal: minerals or power-ups as content targets. */
function collectTargets(
  world: BotWorld,
  isMineral: boolean,
  t: CompetentBotTunables,
): ContentTarget[] {
  const targets: ContentTarget[] = isMineral
    ? world.minerals.map((mineral) => ({
        x: mineral.x,
        y: mineral.y,
        contentId: mineral.type,
        ...(mineral.value !== undefined ? { value: mineral.value } : {}),
      }))
    : world.drops.map((drop) => ({
        x: drop.x,
        y: drop.y,
        contentId: drop.type,
      }));
  // Let go of a pickup the ship has just flown past instead of U-turning for
  // it (AH-0MWJ1680Z001QYV2 audit rejection). The goal selectors apply the
  // same filter, so the goal scored is the target flown at.
  const player = world.player;
  if (!player) return targets;
  return [
    ...withoutOvershot(targets, player, t.collectOvershootMargin, botWrapWorld(t)),
  ];
}

/** Collects the best mineral (mineral goal) or power-up (power-up goal). */
function collectBehaviour(
  t: CompetentBotTunables,
  content: BotContent,
): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.collect,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const isMineral = view.goal.id === COMPETENT_GOAL_IDS.collectMineral;
      const isSecureLife = view.goal.id === COMPETENT_GOAL_IDS.secureLife;
      // The secure-life goal only ever targets live Extra Life drops; the
      // mineral/power-up goals keep their full target sets
      // (AH-0MV03GXZQ00801T4 · AC2).
      const targets = isSecureLife
        ? extraLifeTargets(view.world)
        : collectTargets(view.world, isMineral, t);
      const weight =
        isSecureLife
          ? () => 1
          : isMineral
            ? // Value-aware mineral choice: a red deposit (value 10) is worth
              // flying past a closer gold dot for (AC4).
              (target: ContentTarget) =>
                target.value !== undefined && Number.isFinite(target.value)
                  ? target.value
                  : 1
            : (target: ContentTarget) =>
                content.resolveDrop(target.contentId).value;
      const best = bestWeightedTarget(
        targets,
        player,
        weight,
        botWrapWorld(t),
      );
      if (!best) return null;

      const distance = best.distance;
      const objective = wrappedDelta(player, best.point, botWrapWorld(t));
      const thrust = mayThrust(
        view.snapshot,
        t,
        distance,
        t.collectArrivalRadius,
      );
      // Brake-assist (AC1): when forward thrust would overshoot, request
      // reverse to decelerate toward the pickup (gated on the ship's
      // reverse enable flag, the brake tunable and `collectReverseBrake`).
      // Collection is pass-through by default (AH-0MWJ1680Z001QYV2 audit
      // rejection): pickups are collected on contact, so the bot does not
      // retro-brake onto one — it accepts the overshoot instead of
      // micro-positioning with the thrusters.
      const reverse =
        t.collectReverseBrake &&
        !thrust &&
        view.world.reverseEnabled &&
        mayReverse(view.snapshot, t, distance, t.collectArrivalRadius);
      return planSteering(objective, view.world, t, {
        thrust,
        longTravel: distance >= t.longTravelDistance,
        reverse,
      });
    },
  };
}

/**
 * The motion the `engage` aim solve leads its target by.
 *
 * A mutable record so the per-tick resolve allocates nothing
 * (AH-0MWR04X10002VNDG · AC1). Create one per aim solve with
 * {@link createAimTargetMotion} and consume the returned record **before**
 * the next resolve: every field is overwritten in place.
 */
export interface AimTargetMotion {
  /** Lead velocity (px/s) the intercept solve advances the target by. */
  vx: number;
  vy: number;
  /** The tracked hazard the estimate came from; absent on a fallback. */
  hazard?: BotHazardPoint;
  /**
   * Reused class-trajectory sampler state for the class-aware intercept solve
   * (AH-0MWR051U6003BDB9 · AC3). Owned by the behaviour closure, so the
   * per-tick aim solve allocates no sampler state.
   */
  readonly scratch: HazardMotionScratch;
}

/** Creates a reusable {@link AimTargetMotion} record (zero velocity). */
export function createAimTargetMotion(): AimTargetMotion {
  return { vx: 0, vy: 0, scratch: { x: 0, y: 0, vx: 0, vy: 0 } };
}

/**
 * Resolves the velocity the aim solve leads `target` by, preferring the
 * bot-side hazard tracker's estimate over the snapshot's raw `vx`/`vy`
 * (AH-0MWR04X10002VNDG · AC1).
 *
 * Precedence is explicit and total:
 *
 * 1. **Tracked estimate** — the hazard on `view.world.hazards[]` with the
 *    target's stable `id` (the `trackHazardVelocities` estimate the hazard
 *    predictor consumes). This is the only motion a scripted formation/
 *    `chaser`/`diver`/`patroller` target exposes, so it is what makes those
 *    targets leadable.
 * 2. **Snapshot velocity** — the target's own `vx`/`vy`, when the source has
 *    a physics body (asteroid, lane traffic). Used when the tracker holds no
 *    estimate yet.
 * 3. **Current position** — both absent or zero, so the caller aims at the
 *    target's current position exactly as before the lead existed.
 *
 * One estimate serves both prediction and aim: the same tracker figure that
 * the hazard predictor advances a target with also leads the shot, so the two
 * consumers cannot drift apart (parent AC1/AC6). The lookup is a plain scan
 * of the hazard list into a reused record — no allocation on the per-tick
 * path, and no state carried between ticks (the record is fully overwritten).
 *
 * @param target — the engagement target chosen by `bestWeightedTarget`.
 * @param hazards — the world's tracked hazards (`BotWorld.hazards`).
 * @param out — the reusable record to write the result into.
 * @param useTracker — whether the tracked estimate is consulted at all
 *   (`aimLeadFromTracker`); `false` skips straight to the snapshot velocity,
 *   reproducing the pre-change lead bit-for-bit (the harness control arm).
 * @returns `out`, with `hazard` set only when the tracked estimate won.
 */
export function resolveAimTargetMotion(
  target: ContentTarget,
  hazards: readonly BotHazardPoint[],
  out: AimTargetMotion,
  useTracker = true,
): AimTargetMotion {
  out.hazard = undefined;
  const id = target.id;
  if (useTracker && id !== undefined) {
    for (const hazard of hazards) {
      if (hazard.id !== id) continue;
      const vx = hazard.vx ?? 0;
      const vy = hazard.vy ?? 0;
      // A cold-start/stale estimate carries no velocity (the world model omits
      // a zero vector), so it is not an estimate yet: fall through to the
      // snapshot field, which reduces to the current position for a scripted
      // enemy. That keeps the first engagement tick byte-for-byte the old shot.
      if (vx !== 0 || vy !== 0) {
        out.vx = vx;
        out.vy = vy;
        out.hazard = hazard;
        return out;
      }
      break;
    }
  }
  out.vx = target.vx ?? 0;
  out.vy = target.vy ?? 0;
  return out;
}

/**
 * Plans a steering intent and stamps the engaged target's bot-side id onto an
 * aim plan (AH-0MWR057Q8004PBOD · AC4), so the governor can decay the adaptive
 * aim error on confirmed hits and re-arm it on a target change. Non-aim plans
 * carry no identity.
 */
function planSteeringWithTarget(
  objective: BotWorldPoint,
  world: BotWorld,
  t: CompetentBotTunables,
  options: SteerPlanOptions,
  targetId: number | undefined,
): BotSteeringIntent {
  const planned = planSteering(objective, world, t, options);
  if (targetId === undefined || planned.aim !== true) return planned;
  return { ...planned, targetId };
}

/**
 * Picks the target to engage under the hold-station posture
 * (AH-0MWW2PFU8001J0PM · RAC4).
 *
 * The producer's rule is that the bot "should not necessarily aim at the
 * nearest item": a shot that sweeps a line of bodies, or a target that is
 * about to drift into the line of fire, is worth more than a nearer body the
 * ship cannot hit. So the weighted choice is replaced — only when at least one
 * candidate is actually hittable — by the hittable candidate whose shot line
 * covers the most other hazards, then by the usual weighted score.
 *
 * The screen is cheap on purpose: each candidate is judged with the **legacy
 * constant-velocity lead** (`classSampling: false`), so a scan over the whole
 * target set costs one bounded intercept each (no per-class sampling). The
 * committed target's class-aware solve still runs once, in `engage` itself.
 *
 * Returns `null` when no candidate is hittable inside the posture horizon, so
 * the caller keeps the ordinary weighted choice and simply closes the distance
 * (RAC3).
 *
 * @param targets — the goal's candidate set.
 * @param player — the firing ship.
 * @param weight — the goal's content weight (threat).
 * @param view — the behaviour context (hazards carry the tracked estimates).
 * @param t — competent tunables.
 * @param shotSpeed — the ship's live projectile speed.
 * @param alignSeconds — the ship's live turn time.
 * @param motion — reused tracker-estimate record (never retains state).
 * @param probe — reused fire-target record (never retains state).
 */
function preferHittableTarget(
  targets: readonly ContentTarget[],
  player: BotWorldPoint,
  weight: (target: ContentTarget) => number,
  view: BotBehaviourContext,
  t: CompetentBotTunables,
  shotSpeed: number,
  alignSeconds: number,
  motion: AimTargetMotion,
  probe: FireTarget,
): NearestTarget<ContentTarget> | null {
  const wrapWorld = botWrapWorld(t);
  const hazards = view.world.hazards;
  let best: NearestTarget<ContentTarget> | null = null;
  let bestLineHits = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of targets) {
    const tracked = resolveAimTargetMotion(
      candidate,
      hazards,
      motion,
      t.aimLeadFromTracker,
    );
    probe.x = candidate.x;
    probe.y = candidate.y;
    probe.vx = tracked.vx;
    probe.vy = tracked.vy;
    const solution = resolveFireSolution(player, probe, {
      shotSpeed,
      alignSeconds,
      horizon: t.holdFireHorizonSeconds,
      iterations: t.aimLeadIterations,
      tunables: t,
      world: wrapWorld,
      classSampling: false,
    });
    if (!solution.hit) continue;
    const lineHits = countShotLineTargets(
      player,
      solution.point,
      hazards,
      t.holdFireLineRadiusPx,
      wrapWorld,
      candidate.id,
    );
    const distance = wrappedDistance(player, candidate, wrapWorld);
    const score = weight(candidate) / (1 + distance);
    if (lineHits > bestLineHits || (lineHits === bestLineHits && score > bestScore)) {
      best = { point: candidate, distance };
      bestLineHits = lineHits;
      bestScore = score;
    }
  }
  return best;
}

/** Engages the committed target: the boss alone, or the best enemy/asteroid. */
function engageBehaviour(
  t: CompetentBotTunables,
  content: BotContent,
): BotBehaviour {
  // One reused motion record for the aim solve, allocated with the behaviour
  // (not per tick).
  const aimMotion = createAimTargetMotion();
  // Reused records for the line-of-fire target scan (AH-0MWW2PFU8001J0PM ·
  // RAC4): the tracker estimate and the fire-solution probe are refilled per
  // candidate, so the scan allocates nothing.
  const scanMotion = createAimTargetMotion();
  const scanProbe: FireTarget = { x: 0, y: 0, vx: 0, vy: 0 };
  return {
    id: COMPETENT_BEHAVIOUR_IDS.engage,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const isEnemy = view.goal.id === COMPETENT_GOAL_IDS.engageEnemy;
      const isBoss = view.goal.id === COMPETENT_GOAL_IDS.engageBoss;
      // The boss goal owns a boss-only target set, so a nearer regular enemy
      // can never be selected while it is committed (AH-0MVBMESIE003YQ68 ·
      // AC3). It declines when no live boss is present (AC2 validity mirrors
      // this, so the brain would not have committed to it).
      const targets = isBoss
        ? bossTargets(view.world)
        : isEnemy
          ? enemyTargets(view.world)
          : asteroidTargets(view.world);
      const wrapWorld = botWrapWorld(t);
      // Solve inputs from the ship's live physics through the snapshot seam
      // (AH-0MWR04ZDU0005O8J · AC2): the primary travelling shot's speed is
      // the ship's (350 px/s by default), never the enemy-bullet tell
      // constant, and the turn time is derived from the live rotation model.
      // Both keep the explicit-tuning-override > live > compiled-default
      // precedence, so a snapshot carrying neither keeps the fallbacks.
      // Hoisted above the target choice because the line-of-fire preference
      // judges candidates with them (AH-0MWW2PFU8001J0PM · RAC4).
      const shotSpeed = resolveShotSpeed(t, player.shotSpeed);
      const alignSeconds = resolveAimAlignSeconds(t, player.rotation);
      const threatWeight = (target: ContentTarget): number =>
        content.resolveEnemy(target.contentId).threat;
      // Line-of-fire preference (AH-0MWW2PFU8001J0PM · RAC4): when the
      // posture is enabled, prefer a target the ship can actually hit — and,
      // among those, the shot line that also sweeps other bodies — over the
      // merely nearest one. With no hittable candidate the ordinary weighted
      // choice stands and the bot closes the distance (RAC3).
      const hittable =
        t.holdFireEnabled && targets.length > 1
          ? preferHittableTarget(
              targets,
              player,
              threatWeight,
              view,
              t,
              shotSpeed,
              alignSeconds,
              scanMotion,
              scanProbe,
            )
          : null;
      const best =
        hittable ??
        bestWeightedTarget(targets, player, threatWeight, wrapWorld);
      if (!best) return null;

      const profile = content.resolveEnemy(best.point.contentId);
      const engagementRange = profile.engagementRange ?? t.engagementRange;
      const distance = best.distance;
      // Standoff hysteresis (AH-0MWT4BBYO0085CN8 · RAC2): the in/out decision
      // is sticky, so crossing the engagement-range boundary once does not
      // flip the forward/brake decision on the very next tick. Inside the
      // standoff the ship stays inside until the target is the whole band
      // beyond it; outside it keeps closing until it is back inside the range.
      // The forward model still aims at the true `engagementRange`, so the
      // only behaviour the band changes is the toggle itself. A zero band
      // reproduces the pre-change single-boundary rule.
      const band = Math.max(0, t.engagementRangeHysteresis);
      const standoff = standoffScratch(view, COMPETENT_BEHAVIOUR_IDS.engage);
      const inRange =
        standoff.inStandoff === true
          ? distance <= engagementRange + band
          : distance <= engagementRange;
      standoff.inStandoff = inRange;
      const holdAim = profile.aim !== 'none';
      // Lead prediction (AC2): aim at where a moving target will be when the
      // forward-firing shot arrives, accounting for the ship's estimated turn
      // time plus the shot's time of flight, iterated to a stable intercept.
      // The velocity is resolved tracker-estimate first, then the snapshot
      // field, then the current position (AH-0MWR04X10002VNDG · AC1) — the
      // same estimate the hazard predictor consumes, so a scripted-motion
      // target with no snapshot velocity is still led.
      //
      // Seam-aware aim (AH-0MVT2VZR7000GS15): both the lead solve and the
      // route to the aim point run on the torus, so a target whose shortest
      // path crosses an edge is led and aimed at through that edge.
      //
      // Class-sampled solve (AH-0MWR051U6003BDB9 · AC3): when the tracked
      // estimate names a real movement class, the lead advances the target
      // along its sampled class trajectory (`advanceHazardMotion`) instead of a
      // straight line; a roamer, an unknown/absent class, a disabled motion
      // model or a stationary target falls back to `interceptPoint`
      // bit-for-bit inside the helper. The reusable sampler scratch lives on
      // `aimMotion`, so the per-tick solve allocates none.
      const motion = resolveAimTargetMotion(
        best.point,
        view.world.hazards,
        aimMotion,
        t.aimLeadFromTracker,
      );
      const aimPoint =
        t.aimLeadEnabled && (motion.vx !== 0 || motion.vy !== 0)
          ? interceptPointClassAware(
              player,
              best.point,
              { x: motion.vx, y: motion.vy },
              motion.hazard?.movementClass,
              shotSpeed,
              alignSeconds,
              t.aimLeadIterations,
              t,
              wrapWorld,
              motion.scratch,
            )
          : { x: best.point.x, y: best.point.y };
      const objective = wrappedDelta(player, aimPoint, wrapWorld);
      // Kiting (AC3): inside the standoff and needing more separation, hold
      // reverse while keeping the nose on the aim target (the objective still
      // points at the target, so the actuator backs away).  Only fires on a
      // genuine threat — an incoming threatening shot or an imminent hazard
      // collision — not merely because the bot is close to a target.
      const hasThreateningShot = view.world.incomingFire.some(
        (shot) => shot.threatens,
      );
      // A genuine imminent collision is a hazard **other than the engagement
      // target** that threatens the ship: the shared `hazardThreatensPlayer`
      // predicate — the same sampled predictive test the steering fan applies
      // (AH-0MVI4QDN90037DIN · AC2; AH-0MWM0CB2Q003Y6AB) — with the
      // engagement target exempted by the shared identity rule. The target's
      // own proximity is the kiting condition, not a threat, so calm close
      // combat never triggers reverse on its own (AC3).
      const engagementTarget = [best.point];
      const hasImminentHazard = view.world.hazards.some(
        (hazard) =>
          !isHazardExempt(hazard, engagementTarget) &&
          hazardThreatensPlayer(player, hazard, t),
      );
      // Hold-station posture (AH-0MWW2PFU8001J0PM · RAC2/RAC3): while the
      // hull is **calm** — nothing incoming threatens it and nothing is on a
      // collision course — and a shot from where it is would connect inside
      // `holdFireHorizonSeconds`, the bot stops driving. It requests no
      // forward and no reverse thrust whatever the distance, and only rotates
      // onto the solved aim bearing, so the weapon axis is held still instead
      // of the hull chasing a standoff. When no shot is likely inside the
      // horizon the ordinary approach/standoff policy runs and the ship moves
      // to where it can hit. Danger always overrides the posture: a
      // threatening shot or an imminent collision keeps the evade/kite paths.
      const solution =
        t.holdFireEnabled && holdAim
          ? evaluateFireSolution(
              player,
              aimPoint,
              {
                shotSpeed,
                alignSeconds,
                horizon: t.holdFireHorizonSeconds,
              },
              wrapWorld,
            )
          : null;
      const holdStation =
        solution !== null &&
        solution.hit &&
        !hasThreateningShot &&
        !hasImminentHazard;
      const kite =
        !holdStation &&
        holdAim &&
        view.world.reverseEnabled &&
        distance <= t.reverseRetreatRange &&
        (hasThreateningShot || hasImminentHazard);
      const thrust = holdStation
        ? false
        : inRange && holdAim
          ? false
          : mayThrust(view.snapshot, t, distance, engagementRange);
      // Brake-assist (AC1) while closing when forward thrust would overshoot.
      // Only **outside** the standoff band: inside it the ship holds the
      // standoff and coasts, so the retro thruster never fires back-and-forth
      // with the forward press across the boundary
      // (AH-0MWT4BBYO0085CN8 · RAC2).
      const brake =
        !holdStation &&
        !inRange &&
        !thrust &&
        !kite &&
        view.world.reverseEnabled &&
        mayReverse(view.snapshot, t, distance, engagementRange);
      return planSteeringWithTarget(
        objective,
        view.world,
        t,
        {
          // Inside the standoff, keep the hull aimed at the target and coast so
          // the forward-firing weapon stays on it (AC3). Outside, close while
          // the forward model allows. An archetype with `aim: 'none'` never
          // holds the axis.
          thrust,
          longTravel: distance >= t.longTravelDistance,
          reverse: kite || brake,
          // The engagement target is exempt from the *predictive* hazard test:
          // the bot deliberately aims at it, so predicting a collision with it
          // would reject the aim bearing and break engagement. It still keeps
          // the positional danger-margin rule (AH-0MVI4QDN90037DIN · AC2).
          exemptHazards: [best.point],
          // Mark the intent as an aim intent so the governor's `skill` error can
          // perturb it (and only it) when the designer lowers skill (AC3).
          aim: holdAim,
          // Holding station: no throttle press at all, whatever bearing the
          // safety fan chooses (AH-0MWW2PFU8001J0PM · RAC2). The hull only
          // rotates onto the solved aim bearing.
          hold: holdStation,
        },
        // The engaged target's bot-side identity, so the governor can decay the
        // adaptive aim error on confirmed hits and re-arm it on a target
        // change (AH-0MWR057Q8004PBOD · AC4). Non-aim plans carry none.
        holdAim ? best.point.id : undefined,
      );
    },
  };
}

/**
 * Evades: heads away from the weighted centroid of the shots that threaten
 * the ship, or away from the nearest hazard when no shot threatens. The
 * steering fan paths around anything else in the way (AC2).
 */
function evadeBehaviour(t: CompetentBotTunables): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.evade,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;

      const threatening = view.world.incomingFire.filter(
        (shot) => shot.threatens,
      );
      const wrapWorld = botWrapWorld(t);
      let ax = 0;
      let ay = 0;
      if (threatening.length > 0) {
        for (const shot of threatening) {
          // Measure the shot on the torus and flee along the wrapped route, so
          // a shot that arrived across a seam is escaped *through* the seam
          // rather than toward it (AH-0MVT2W10L003VV1U).
          const dx = wrappedAxisDelta(
            player.x,
            shot.source.x,
            wrapWorld.width,
          );
          const dy = wrappedAxisDelta(
            player.y,
            shot.source.y,
            wrapWorld.height,
          );
          const distance = Math.hypot(dx, dy);
          const weight = 1 / (1 + distance);
          ax += -dx * weight;
          ay += -dy * weight;
        }
      } else {
        const nearest = nearestTarget(view.world.hazards, player, wrapWorld);
        if (nearest) {
          const away = wrappedDelta(nearest.point, player, wrapWorld);
          ax = away.x;
          ay = away.y;
        }
      }

      if (ax === 0 && ay === 0) return idleIntent();
      return planSteering({ x: ax, y: ay }, view.world, t, {
        thrust: true,
        longTravel: false,
      });
    },
  };
}

/** Drifts back toward the playfield centre when idle. */
function repositionBehaviour(t: CompetentBotTunables): BotBehaviour {
  return {
    id: COMPETENT_BEHAVIOUR_IDS.reposition,
    run: (view: BotBehaviourContext) => {
      const player = view.world.player;
      if (!player) return null;
      const objective = {
        x: t.playfieldWidth / 2 - player.x,
        y: t.playfieldHeight / 2 - player.y,
      };
      const distance = Math.hypot(objective.x, objective.y);
      if (distance <= t.repositionRadius) return idleIntent();
      // Coast to a stop at the **edge** of the idle band rather than thrusting
      // to the exact centre (AH-0MWJ1680Z001QYV2 audit rejection): the forward
      // model treats the band radius as the arrival radius, so the ship stops
      // inside the band instead of overshooting the centre and drifting back.
      return planSteering(objective, view.world, t, {
        thrust: mayThrust(
          view.snapshot,
          t,
          distance,
          t.repositionRadius,
        ),
        longTravel: distance >= t.longTravelDistance,
      });
    },
  };
}

/**
 * Builds the competent behaviour set.
 *
 * @param t — competent tunables.
 * @param content — content registry; defaults to an empty registry whose
 *   neutral profiles preserve the pre-content behaviour.
 */
export function createCompetentBehaviours(
  t: CompetentBotTunables,
  content: BotContent = createBotContent(),
): BehaviourRegistry {
  return createBehaviourRegistry([
    collectBehaviour(t, content),
    engageBehaviour(t, content),
    evadeBehaviour(t),
    repositionBehaviour(t),
  ]);
}

/** Re-exported for callers that want the world type alongside behaviours. */
export type { BotWorld };
