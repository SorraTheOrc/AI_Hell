/**
 * Unit tests for the class-shaped hazard trajectory sampler
 * (AH-0MWM0C9F9006HNXV · AC1–AC5).
 *
 * One test per movement-class model (`chaser` arc, `diver` dive, `patroller`
 * commit, `formation` edge reversal, `roamer` linear), plus the deterministic
 * repeated-call guard, the disabled/unknown/zero-velocity parity guard, the
 * wide-separation early-out, the `hazardThreatensPlayer` consumer wiring, and
 * the **per-class prediction horizon** (AH-0MWM0CB2Q003Y6AB): the documented
 * scale per class, `roamer` pinned to the configured horizon, and a class that
 * can still turn onto the ship judged over a longer window. Fixtures are
 * constructed snapshots, not live entities.
 */

import { describe, expect, it } from 'vitest';

import type { EnemyMovementClass } from '../../core/configTypes';
import type { BotHazardPoint } from './worldModel';
import {
  HAZARD_CURVATURE_HORIZON_BOOST,
  HAZARD_CURVATURE_SATURATION_RATE,
  closestApproachFromDelta,
  hazardHorizonFor,
  predictMinimumSeparation,
} from './hazardMotionModel';
import { hazardThreatensPlayer } from './competent/steering';
import {
  COMPETENT_BOT_TUNABLES,
  resolveCompetentTunables,
} from './competent/tunables';
import { wrappedAxisDelta, type WrapWorld } from '../../utils/wrapGeometry';

const WORLD: WrapWorld = { width: 960, height: 540 };

/**
 * Sampler-enabled tunables. The **shipped default is dark** (pinned below), so
 * every test that exercises a class model opts in explicitly rather than
 * relying on the default. Enabling it in the product is AH-0MWM0C5BN003PCDT,
 * after the per-class horizon calibration in AH-0MWM0CB2Q003Y6AB.
 */
const T = resolveCompetentTunables({ hazardMotionModelEnabled: true });

/** A constructed hazard point with fitted motion. */
function hazard(
  x: number,
  y: number,
  vx: number,
  vy: number,
  movementClass: EnemyMovementClass,
  curvature = 0,
): BotHazardPoint {
  return { x, y, vx, vy, movementClass, curvature };
}

/** The ship at the playfield centre, at rest unless a test moves it. */
const STILL_PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

/**
 * The fixed-velocity control over the hazard's **own class-scaled** window
 * (AH-0MWM0CB2Q003Y6AB): a straight class path must reproduce this exactly, so
 * a class test never mixes a sampled class window with the shorter configured
 * one.
 */
function fixedControl(h: BotHazardPoint) {
  return resolveCompetentTunables({
    hazardMotionModelEnabled: false,
    hazardPredictionHorizon: hazardHorizonFor(h, T),
  });
}

describe('roamer — linear extrapolation', () => {
  it('returns the fixed-velocity solve bit-for-bit (the straight-line control)', () => {
    // Hazard 100 px left of the ship, closing at 200 px/s: it reaches the ship
    // at 0.5 s, inside the 0.6 s horizon. A straight class path *is* the
    // fixed-velocity closest approach, so the sampler returns that solve
    // exactly (AH-0MWOKL79Z0051ZXO) — no 0.05 s sampling granularity, which
    // keeps the sweep's `roamer` control arm bit-identical to the disabled
    // model instead of reporting noise as a regression.
    const player = { x: 400, y: 100, vx: 0, vy: 0 };
    const roamer = hazard(300, 100, 200, 0, 'roamer');
    const prediction = predictMinimumSeparation(player, roamer, T, WORLD);
    expect(prediction.mode).toBe('fixed-velocity');
    expect(prediction).toEqual(
      predictMinimumSeparation(
        player,
        roamer,
        resolveCompetentTunables({ hazardMotionModelEnabled: false }),
        WORLD,
      ),
    );
    expect(prediction.separation).toBeCloseTo(0, 6);
    expect(prediction.time).toBeCloseTo(0.5, 6);
  });

  it('keeps a formation drift on the same exact solve until it reflects', () => {
    // A formation drifting inboard never meets a bound inside the window, so its
    // class path is straight too and it must be bit-identical to the control.
    const inboard = hazard(200, 100, 40, 0, 'formation');
    const player = { x: 400, y: 100, vx: 0, vy: 0 };
    expect(predictMinimumSeparation(player, inboard, T, WORLD)).toEqual(
      predictMinimumSeparation(
        player,
        inboard,
        resolveCompetentTunables({ hazardMotionModelEnabled: false }),
        WORLD,
      ),
    );
  });
});

describe('chaser — pure pursuit', () => {
  // The ship is directly below a hazard whose velocity is perpendicular to the
  // bearing. A fixed-velocity solve keeps the 100 px gap forever; a pursuing
  // chaser re-aims at the ship every sample and closes it.
  const chaser = hazard(480, 170, 100, 0, 'chaser');

  it('predicts a closer approach than the fixed-velocity solve', () => {
    const pursuit = predictMinimumSeparation(STILL_PLAYER, chaser, T, WORLD);
    const straight = predictMinimumSeparation(
      STILL_PLAYER,
      chaser,
      resolveCompetentTunables({ hazardMotionModelEnabled: false }),
      WORLD,
    );
    expect(pursuit.mode).toBe('sampled');
    expect(straight.mode).toBe('fixed-velocity');
    expect(pursuit.separation).toBeLessThan(straight.separation);
    expect(straight.separation).toBeCloseTo(100, 6); // perpendicular pass
    expect(pursuit.time).toBeGreaterThan(0);
  });

  it('ignores the fitted curvature: the next step is a re-aim, not a continued arc', () => {
    // AH-0MWOKL79Z0051ZXO: a pursuing hazard re-aims at its target every tick
    // (the shipped `steerToward`), so the last arc it flew does not predict the
    // next one. An aiming class also gets no curvature horizon boost, so a
    // large fitted curvature changes **nothing** about its prediction — it is
    // the same pursuit, never a constant-rate spiral.
    const homing = predictMinimumSeparation(STILL_PLAYER, chaser, T, WORLD);
    const orbit = predictMinimumSeparation(
      STILL_PLAYER,
      hazard(480, 170, 100, 0, 'chaser', 3),
      T,
      WORLD,
    );
    expect(orbit).toEqual(homing);
    expect(homing.mode).toBe('sampled');
  });

  it('is sensitive to the escape bearing: fleeing predicts a growing gap', () => {
    // The property the steering fan needs (and the reason the constant-rate arc
    // over-dodged): a chaser 120 px away closing at 100 px/s is predicted to
    // reach a stationary ship, but a ship fleeing at 175 px/s opens the gap on
    // the very same hazard. Before the fix both bearings read as an identical
    // threat, so the fan had no direction to prefer.
    const chasing = hazard(600, 270, -100, 0, 'chaser');
    const still = predictMinimumSeparation(STILL_PLAYER, chasing, T, WORLD);
    // Fleeing is *away* from the hazard, which closes from the right: the ship
    // moves left. Driving right closes on it instead.
    const flee = predictMinimumSeparation(
      { x: 480, y: 270, vx: -175, vy: 0 },
      chasing,
      T,
      WORLD,
    );
    const approach = predictMinimumSeparation(
      { x: 480, y: 270, vx: 175, vy: 0 },
      chasing,
      T,
      WORLD,
    );
    // Closing at 100 px/s from 120 px away over the configured 0.6 s chaser
    // window, the pursuit is left 60 px out against a still ship (pure pursuit
    // of a stationary target *is* the straight solve), while fleeing opens the
    // gap instead — the bearing sensitivity the steering fan needs.
    expect(still.separation).toBeCloseTo(60, 6);
    expect(flee.separation).toBeGreaterThan(100);
    expect(approach.separation).toBeLessThan(still.separation);
    expect(flee.separation).toBeGreaterThan(approach.separation);
  });
});

describe('diver — committed dive vector', () => {
  it('predicts a pre-commit diver along the dive vector toward the ship', () => {
    // Heading +x, ship directly below: not yet committed, so the model aims
    // the dive at the ship (straight down at 100 px/s) and closes 100 px/s over
    // the diver's class-scaled window. The fixed solve would keep the 100 px
    // perpendicular gap.
    const diver = hazard(480, 170, 100, 0, 'diver');
    const horizon = hazardHorizonFor(diver, T);
    const prediction = predictMinimumSeparation(STILL_PLAYER, diver, T, WORLD);
    expect(horizon).toBeGreaterThan(T.hazardPredictionHorizon);
    expect(prediction.mode).toBe('sampled');
    expect(prediction.separation).toBeCloseTo(100 - 100 * horizon, 3);
    expect(prediction.time).toBeCloseTo(horizon, 6);
  });

  it('flies a committed diver straight along its observed dive vector', () => {
    // Heading straight at the ship: within the commit cone, so the prediction
    // is exactly the straight fixed-velocity solve (no further steering).
    const committed = hazard(480, 170, 0, 100, 'diver');
    const prediction = predictMinimumSeparation(STILL_PLAYER, committed, T, WORLD);
    const straight = predictMinimumSeparation(
      STILL_PLAYER,
      committed,
      fixedControl(committed),
      WORLD,
    );
    expect(prediction.mode).toBe('sampled');
    expect(prediction.separation).toBeCloseTo(straight.separation, 6);
    expect(prediction.time).toBeCloseTo(straight.time, 6);
  });
});

describe('patroller — patrol then attack run', () => {
  it('keeps a patroller heading away from the ship on its straight patrol', () => {
    // Heading straight away from the bearing, 340 px away and never inside the
    // 320 px commit range nor the commit cone over the class-scaled window:
    // before commit the patrol is straight, so the sampled path equals the
    // fixed-velocity solve over that same window (both miss: the closest
    // approach is now). A large arena keeps the classes' straight segments
    // inside the playfield, so no seam fold changes the geometry.
    const ARENA: WrapWorld = { width: 2000, height: 2000 };
    const player = { x: 480, y: 1000, vx: 0, vy: 0 };
    const patroller = hazard(820, 1000, 600, 0, 'patroller');
    const patrol = predictMinimumSeparation(player, patroller, T, ARENA);
    const straight = predictMinimumSeparation(
      player,
      patroller,
      fixedControl(patroller),
      ARENA,
    );
    expect(patrol.mode).toBe('sampled');
    expect(patrol.separation).toBeCloseTo(straight.separation, 6);
    expect(patrol.time).toBeCloseTo(straight.time, 6);
  });

  it('predicts the attack run once the heading is inside the commit cone', () => {
    // Inside the commit range with the heading ~60° off the bearing: the
    // class model snaps the run onto the ship and predicts an impact, while
    // the straight solve continues 60° off and misses by ~147 px.
    const patroller = hazard(480, 100, 340, 200, 'patroller');
    const attack = predictMinimumSeparation(STILL_PLAYER, patroller, T, WORLD);
    const straight = predictMinimumSeparation(
      STILL_PLAYER,
      patroller,
      resolveCompetentTunables({ hazardMotionModelEnabled: false }),
      WORLD,
    );
    expect(attack.mode).toBe('sampled');
    expect(attack.separation).toBeLessThan(20);
    expect(straight.separation).toBeCloseTo(146.5, 0);
    expect(attack.separation).toBeLessThan(straight.separation);
  });

  it('runs a patroller inside the commit range straight at the ship', () => {
    // 180 px away (< 320 px) but heading down: committed by range, so it turns
    // and runs straight at the ship, reaching it inside the horizon.
    const patroller = hazard(300, 270, 0, 300, 'patroller');
    const prediction = predictMinimumSeparation(STILL_PLAYER, patroller, T, WORLD);
    expect(prediction.mode).toBe('sampled');
    expect(prediction.separation).toBeCloseTo(0, 6);
    expect(prediction.time).toBeCloseTo(0.6, 6);
  });
});

describe('formation — drift plus arena-edge reversal', () => {
  it('reflects the drift at the edge instead of extrapolating through it', () => {
    // Ship at x=700, just inboard of the drift start; the formation drifts
    // right at the tracker's maximum sampled speed and crosses x=960 almost
    // immediately. The edge reversal turns it back through the ship (≈10 px
    // miss), while the straight continuation wraps away to x≈520 and never
    // comes closer than ≈180 px: the two models predict very different
    // threats from the same fitted motion.
    const edgePlayer = { x: 700, y: 100, vx: 0, vy: 0 };
    const formation = hazard(940, 100, 900, 0, 'formation');
    const reflected = predictMinimumSeparation(edgePlayer, formation, T, WORLD);
    const linear = predictMinimumSeparation(
      edgePlayer,
      hazard(940, 100, 900, 0, 'roamer'),
      T,
      WORLD,
    );
    expect(reflected.mode).toBe('sampled');
    expect(reflected.separation).toBeLessThan(20);
    expect(linear.separation).toBeGreaterThan(150);
    expect(reflected.separation).toBeLessThan(linear.separation);
  });
});

describe('determinism', () => {
  it('returns identical separations for repeated calls on the same inputs', () => {
    const player = { x: 480, y: 270, vx: 175, vy: 0 };
    const chaser = hazard(580, 120, -50, 200, 'chaser', 0.7);
    const first = predictMinimumSeparation(player, chaser, T, WORLD);
    const second = predictMinimumSeparation(player, chaser, T, WORLD);
    expect(second).toEqual(first);
    expect(first.mode).toBe('sampled');
  });
});

describe('fallback parity', () => {
  it('reproduces the fixed-velocity closest approach when the model is disabled', () => {
    const player = { x: 480, y: 270, vx: 175, vy: 0 };
    const moving = hazard(580, 120, -50, 200, 'chaser');
    const disabled = predictMinimumSeparation(
      player,
      moving,
      resolveCompetentTunables({ hazardMotionModelEnabled: false }),
      WORLD,
    );
    // The pre-change solve, recomputed from the shared primitive.
    const expected = closestApproachFromDelta(
      wrappedAxisDelta(player.x, moving.x, WORLD.width),
      wrappedAxisDelta(player.y, moving.y, WORLD.height),
      (moving.vx ?? 0) - player.vx,
      (moving.vy ?? 0) - player.vy,
      T.hazardPredictionHorizon,
    );
    expect(disabled).toEqual({
      separation: expected.distance,
      time: expected.t,
      mode: 'fixed-velocity',
    });
  });

  it('treats an unknown movement class as the fixed-velocity solve', () => {
    const player = { x: 480, y: 270, vx: 175, vy: 0 };
    const moving = hazard(580, 120, -50, 200, 'chaser');
    const unknown = {
      ...moving,
      movementClass: 'teleporter' as unknown as EnemyMovementClass,
    };
    expect(predictMinimumSeparation(player, unknown, T, WORLD)).toEqual(
      predictMinimumSeparation(
        player,
        moving,
        resolveCompetentTunables({ hazardMotionModelEnabled: false }),
        WORLD,
      ),
    );
  });

  it('reproduces the positional result for a zero-velocity hazard', () => {
    // 40 px from the ship: the positional rule (distance from now) is returned
    // with time 0, whatever the model toggle says.
    const stationary = hazard(520, 270, 0, 0, 'chaser');
    for (const tunables of [
      T,
      resolveCompetentTunables({ hazardMotionModelEnabled: false }),
    ]) {
      expect(predictMinimumSeparation(STILL_PLAYER, stationary, tunables, WORLD)).toEqual({
        separation: 40,
        time: 0,
        mode: 'positional',
      });
    }
  });
});

describe('wide-separation early-out', () => {
  it('dismisses a hazard that cannot reach threatRadius without sampling', () => {
    // 432 px away closing at 10 px/s over 0.6 s: the separation can fall no
    // lower than ~426 px, so the threat question is settled immediately. (A
    // straight-line class returns the exact fixed-velocity solve instead — see
    // the roamer tests — so the early-out is exercised on a curving class.)
    const far = hazard(100, 100, 10, 0, 'chaser');
    const prediction = predictMinimumSeparation(STILL_PLAYER, far, T, WORLD);
    expect(prediction.mode).toBe('early-out');
    expect(prediction.time).toBe(0);
    expect(prediction.separation).toBeGreaterThanOrEqual(T.threatRadius);
    // A hazard inside the reachable band is sampled instead.
    const near = predictMinimumSeparation(
      STILL_PLAYER,
      hazard(520, 120, -50, 200, 'chaser'),
      T,
      WORLD,
    );
    expect(near.mode).toBe('sampled');
  });
});

describe('shipped default is on, with the sweep evidence', () => {
  it('ships hazardMotionModelEnabled on (AH-0MWOKL79Z0051ZXO)', () => {
    // Flipped on by AH-0MWOKL79Z0051ZXO on the seeded per-class sweep evidence
    // in `src/ai/eval/hazardMotionSweep.test.ts`: the curving classes record
    // strictly fewer avoidable enemy-body contacts on a strict majority of the
    // documented seed list, the chaser arm never regresses, and the
    // straight-line `roamer`/`formation` controls are provably unaffected (a
    // straight class path returns the fixed-velocity solve bit-for-bit). The
    // earlier dark default (AH-0MWM0C9F9006HNXV) existed only because the chaser
    // model — a constant-turn-rate arc fitted from the last two position deltas
    // — predicted a threat on every escape bearing and made the pilot over-dodge
    // a pursuer; the model is now pure pursuit.
    //
    // Change this pin only with fresh sweep evidence — never to make a test pass.
    expect(COMPETENT_BOT_TUNABLES.hazardMotionModelEnabled).toBe(true);
    expect(resolveCompetentTunables().hazardMotionModelEnabled).toBe(true);
  });

  it('explicitly disabling it reproduces the pre-change solve bit-for-bit', () => {
    // The control arm must stay exactly the old behaviour: same separation, same
    // time, same threat verdict as the pre-change fixed-velocity solve.
    const chaser = hazard(480, 170, 100, 0, 'chaser');
    const disabled = resolveCompetentTunables({
      hazardMotionModelEnabled: false,
    });
    const off = predictMinimumSeparation(STILL_PLAYER, chaser, disabled, WORLD);
    expect(off.mode).toBe('fixed-velocity');
    expect(off.mode).not.toBe(
      predictMinimumSeparation(STILL_PLAYER, chaser, COMPETENT_BOT_TUNABLES, WORLD)
        .mode,
    );
    // ...and the two arms genuinely differ for a curving hazard, otherwise the
    // sweep compares a model with itself.
    expect(
      hazardThreatensPlayer(STILL_PLAYER, chaser, disabled),
    ).not.toBe(hazardThreatensPlayer(STILL_PLAYER, chaser, T));
  });
});

describe('hazardThreatensPlayer consumes the sampler', () => {
  it('turns a non-threat under the fixed solve into a threat on the homing arc', () => {
    // A chaser crossing above the ship: the straight solve stays ~100 px away,
    // the bounded homing arc closes more. Any threat radius between the two
    // separations flips only when the class model is enabled.
    const chaser = hazard(480, 170, 100, 0, 'chaser');
    const arc = predictMinimumSeparation(STILL_PLAYER, chaser, T, WORLD);
    const straight = predictMinimumSeparation(
      STILL_PLAYER,
      chaser,
      resolveCompetentTunables({ hazardMotionModelEnabled: false }),
      WORLD,
    );
    const between = (arc.separation + straight.separation) / 2;
    // Explicitly enabled: the shipped default is dark (pinned above).
    const tuned = resolveCompetentTunables({
      threatRadius: between,
      hazardMotionModelEnabled: true,
    });

    expect(hazardThreatensPlayer(STILL_PLAYER, chaser, tuned)).toBe(true);
    expect(
      hazardThreatensPlayer(
        STILL_PLAYER,
        chaser,
        resolveCompetentTunables({
          threatRadius: between,
          hazardMotionModelEnabled: false,
        }),
      ),
    ).toBe(false);
  });
});

// ── Per-class prediction horizon (AH-0MWM0CB2Q003Y6AB) ──────────────

describe('per-class prediction horizon (AH-0MWM0CB2Q003Y6AB)', () => {
  it('publishes a documented horizon scale per movement class', () => {
    const scale = COMPETENT_BOT_TUNABLES.hazardClassHorizonScale;
    // The classes whose threat is a *continuous* closing geometry (`chaser`) or
    // a straight line (`roamer`, `formation`) keep exactly the configured
    // horizon (AH-0MWOKL79Z0051ZXO): a longer chaser window only widens the
    // "threatened" set and makes the pilot over-dodge a pursuer
    // (`promo-ghost-hunt`), while a drift cannot turn onto the ship at all.
    expect(scale.roamer).toBe(1);
    expect(scale.formation).toBe(1);
    expect(scale.chaser).toBe(1);
    // The classes whose threat is a **discrete commit later in the window**
    // (`diver`, `patroller`) are judged further ahead, in the documented order:
    // a dive arrives later than a patrol that breaks into an attack run.
    expect(scale.diver).toBeGreaterThan(scale.patroller);
    expect(scale.patroller).toBeGreaterThan(scale.roamer);
  });

  it('leaves roamer at the configured horizon and lengthens the curving classes', () => {
    expect(
      hazardHorizonFor({ movementClass: 'roamer', curvature: 0 }, T),
    ).toBe(T.hazardPredictionHorizon);
    expect(
      hazardHorizonFor({ movementClass: 'chaser', curvature: 0 }, T),
    ).toBeCloseTo(T.hazardPredictionHorizon * T.hazardClassHorizonScale.chaser, 10);
    // A fitted curvature lengthens the window of a **drift** class further
    // (its model is straight, so the observed turn is new information), bounded
    // at saturation.
    expect(
      hazardHorizonFor(
        { movementClass: 'formation', curvature: HAZARD_CURVATURE_SATURATION_RATE },
        T,
      ),
    ).toBeCloseTo(
      T.hazardPredictionHorizon *
        (1 + HAZARD_CURVATURE_HORIZON_BOOST),
      10,
    );
    expect(
      hazardHorizonFor(
        { movementClass: 'formation', curvature: HAZARD_CURVATURE_SATURATION_RATE * 10 },
        T,
      ),
    ).toBeCloseTo(
      T.hazardPredictionHorizon *
        (1 + HAZARD_CURVATURE_HORIZON_BOOST),
      10,
    );
    // An **aiming** class does not: it already turns onto the ship every sample,
    // so boosting its window on a curvature it flies anyway only lengthens the
    // predicted chase and makes the ship over-dodge (AH-0MWOKL79Z0051ZXO).
    expect(
      hazardHorizonFor(
        { movementClass: 'chaser', curvature: HAZARD_CURVATURE_SATURATION_RATE },
        T,
      ),
    ).toBeCloseTo(
      T.hazardPredictionHorizon * T.hazardClassHorizonScale.chaser,
      10,
    );
  });

  it('falls back to the configured horizon for an unknown movement class', () => {
    expect(
      hazardHorizonFor(
        {
          movementClass: 'teleporter' as unknown as EnemyMovementClass,
          curvature: 1,
        },
        T,
      ),
    ).toBe(T.hazardPredictionHorizon);
  });

  it('lengthens the threat window for a committing patroller but not for a roamer', () => {
    // A hazard 140 px above the ship closing at 120 px/s reaches contact after
    // 1.17 s. The configured 0.6 s window leaves it ~68 px away (outside
    // threatRadius 55); the patroller's longer window sees the contact. The same
    // straight-line geometry under `roamer` keeps the configured window.
    const closing = (movementClass: EnemyMovementClass): BotHazardPoint => ({
      x: 480,
      y: 130,
      vx: 0,
      vy: 120,
      movementClass,
      curvature: 0,
    });
    expect(hazardThreatensPlayer(STILL_PLAYER, closing('patroller'), T)).toBe(true);
    expect(hazardThreatensPlayer(STILL_PLAYER, closing('roamer'), T)).toBe(false);
    // The scale is what lengthens the window: pinning it to 1 removes the threat.
    const unscaled = resolveCompetentTunables({
      hazardMotionModelEnabled: true,
      hazardClassHorizonScale: {
        chaser: 1,
        diver: 1,
        patroller: 1,
        formation: 1,
        roamer: 1,
      },
    });
    expect(hazardThreatensPlayer(STILL_PLAYER, closing('patroller'), unscaled)).toBe(
      false,
    );
  });
});
