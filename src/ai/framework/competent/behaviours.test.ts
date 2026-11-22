/**
 * Unit tests for the competent behaviours
 * (AH-0MUY08WX3000ZEVO, AC2/AC3/AC4/AC7).
 *
 * Each behaviour is exercised through its public `run` seam, asserting the
 * observable steering intent it returns (aim bearing, thrust decision, dodge
 * direction) rather than implementation detail.
 */

import { describe, expect, it } from 'vitest';

import { createBotMemory } from '../memory';
import type { BotBehaviourContext } from '../registry';
import { buildBotWorld } from '../worldModel';
import { enemyHazardKey } from '../hazardVelocity';
import { boss, bullet, drop, enemy, makeSnapshot, mineral } from '../testFixtures';
import { createAimTargetMotion, createCompetentBehaviours, resolveAimTargetMotion } from './behaviours';
import type { ContentTarget } from './goals';
import type { BotHazardPoint } from '../worldModel';
import { COMPETENT_GOAL_IDS, createCompetentGoals } from './goals';
import { evaluateDirection } from './steering';
import { COMPETENT_BOT_TUNABLES, deriveTurnAlignSeconds, resolveAimAlignSeconds, resolveCompetentTunables, resolveShotSpeed } from './tunables';
import { PLAYER_BULLET_SPEED } from '../../../core/constants';

const T = COMPETENT_BOT_TUNABLES;
const PLAYER = { x: 480, y: 270, vx: 0, vy: 0 };

/** Builds the behaviour context for a committed goal. */
function context(
  snapshot: ReturnType<typeof makeSnapshot>,
  goalId: string,
): BotBehaviourContext {
  const goal = createCompetentGoals(T).require(goalId);
  return {
    snapshot,
    world: buildBotWorld(snapshot),
    memory: createBotMemory(),
    dt: 0.1,
    goal,
  };
}

const behaviours = createCompetentBehaviours(T);
const collect = behaviours.require('collect');
const engage = behaviours.require('engage');
const evade = behaviours.require('evade');
const reposition = behaviours.require('reposition');

describe('collect behaviour (AC2)', () => {
  it('approaches a mineral and thrusts toward it', () => {
    const intent = collect.run(
      context(
        makeSnapshot({ player: PLAYER, minerals: [mineral(700, 270)] }),
        COMPETENT_GOAL_IDS.collectMineral,
      ),
    );
    expect(intent).not.toBeNull();
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
    expect(intent!.thrust).toBe(true);
  });

  it('approaches a power-up for the power-up goal', () => {
    const intent = collect.run(
      context(
        makeSnapshot({ player: PLAYER, drops: [drop(260, 270)] }),
        COMPETENT_GOAL_IDS.collectPowerUp,
      ),
    );
    expect(intent!.dirX).toBeCloseTo(-1, 3);
  });

  it('declines when its target type has vanished', () => {
    const intent = collect.run(
      context(
        makeSnapshot({ player: PLAYER }),
        COMPETENT_GOAL_IDS.collectMineral,
      ),
    );
    expect(intent).toBeNull();
  });
});

describe('collect behaviour — secure-life target (AH-0MV03GXZQ00801T4)', () => {
  it('targets the Extra Life drop, not a nearer non-life drop', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      lives: 3,
      livesCap: 5,
      // shield is nearer (left); extra_life is farther (right).
      drops: [drop(260, 270, 'shield'), drop(700, 270, 'extra_life')],
    });
    const intent = collect.run(
      context(snapshot, COMPETENT_GOAL_IDS.secureLife),
    );
    expect(intent).not.toBeNull();
    // Positive X proves it steered at the Extra Life (right), not the closer
    // shield (left) the power-up band would have chosen.
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
  });

  it('declines the secure-life goal when no Extra Life drop is present', () => {
    const intent = collect.run(
      context(
        makeSnapshot({
          player: PLAYER,
          lives: 3,
          livesCap: 5,
          drops: [drop(260, 270, 'shield')],
        }),
        COMPETENT_GOAL_IDS.secureLife,
      ),
    );
    expect(intent).toBeNull();
  });
});

describe('engage behaviour (AC3 aim/fire reasoning)', () => {
  it('holds the aim axis and coasts once inside the engagement range', () => {
    const intent = engage.run(
      context(
        makeSnapshot({ player: PLAYER, enemies: [enemy(600, 270, 'scout')] }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    // The hull is pointed straight at the target and it holds (coasts) so the
    // forward-firing weapon stays on it — not aimed by accident of travel.
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
    expect(intent!.thrust).toBe(false);
  });

  it('closes while outside the engagement range', () => {
    const intent = engage.run(
      context(
        makeSnapshot({ player: PLAYER, enemies: [enemy(900, 270, 'scout')] }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.thrust).toBe(true);
  });

  it('engages an asteroid when the asteroid goal is committed', () => {
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [enemy(600, 270, 'asteroid')],
        }),
        COMPETENT_GOAL_IDS.engageAsteroid,
      ),
    );
    expect(intent!.dirX).toBeCloseTo(1, 3);
  });

  it('carries the engaged target\'s bot-side id so the adaptive aim error can decay on hits (AH-0MWR057Q8004PBOD · AC4)', () => {
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [{ ...enemy(600, 270, 'scout'), id: 42 }],
        }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent!.aim).toBe(true);
    expect(intent!.targetId).toBe(42);
  });
});

/**
 * Boss-only engage targeting (AH-0MVBMESIE003YQ68 · AC3).
 *
 * **TEST-FIRST.** Authored red under Vitest's `it.fails` (the repo's
 * red-before/green-after convention — see `src/core/levelScaling.test.ts`),
 * then flipped to `it` by the implementation items (AH-0MVRMYU3G001YPLT,
 * AH-0MVRMYZF5008VFV5). A leftover `it.fails` fails the suite, so the flip is
 * deliberate.
 *
 * A committed boss goal owns a **boss-only** target set, so the engage
 * behaviour cannot select a nearer regular enemy (hard priority, not a
 * weighted bias).
 */
describe('engage behaviour — boss-only targeting (AH-0MVBMESIE003YQ68 · AC3)', () => {
  it('targets the boss alone despite a nearer regular enemy', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      // A nearby minion above the ship; the boss sits farther to the right.
      enemies: [enemy(480, 120, 'scout')],
      boss: boss(900, 270, 2),
    });
    const intent = engage.run(context(snapshot, 'engage-boss'));
    expect(intent).not.toBeNull();
    // Bears on the boss (right), never the closer minion (up): the boss goal
    // owns a boss-only target set (hard priority, not a weighted bias).
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
    expect(intent!.aim).toBe(true);
  });

  it('declines the boss goal when no live boss is present', () => {
    const intent = engage.run(
      context(
        makeSnapshot({ player: PLAYER, enemies: [enemy(600, 270, 'scout')] }),
        'engage-boss',
      ),
    );
    expect(intent).toBeNull();
  });
});

describe('evade behaviour (AC2/AC4)', () => {
  it('moves away from a threatening shot', () => {
    const intent = evade.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemyBullets: [bullet(600, 270, -100, 0)],
        }),
        COMPETENT_GOAL_IDS.survive,
      ),
    );
    expect(intent!.dirX).toBeLessThan(0);
  });
});

describe('reposition behaviour (AC2)', () => {
  it('drifts back toward the playfield centre when off-centre', () => {
    const intent = reposition.run(
      context(
        makeSnapshot({ player: { x: 80, y: 60, vx: 0, vy: 0 } }),
        COMPETENT_GOAL_IDS.reposition,
      ),
    );
    expect(intent!.dirX).toBeGreaterThan(0);
    expect(intent!.dirY).toBeGreaterThan(0);
  });

  it('idles when already central', () => {
    const intent = reposition.run(
      context(
        makeSnapshot({ player: { x: 480, y: 270, vx: 0, vy: 0 } }),
        COMPETENT_GOAL_IDS.reposition,
      ),
    );
    expect(intent).toMatchObject({ dirX: 0, dirY: 0, thrust: false });
  });

  it('coasts to a stop at the edge of the idle band instead of thrusting to the exact centre (AH-0MWJ1680Z001QYV2 audit rejection)', () => {
    // 40 px from the centre, inside the 90 px idle band: no steering at all.
    const intent = reposition.run(
      context(
        makeSnapshot({ player: { x: 440, y: 270, vx: 0, vy: 0 } }),
        COMPETENT_GOAL_IDS.reposition,
      ),
    );
    expect(intent).toMatchObject({ dirX: 0, dirY: 0, thrust: false });

    // 130 px from the centre, i.e. 40 px outside the band, moving at 175 px/s:
    // the friction stopping distance (153 px) far exceeds the gap to the band
    // edge, so the ship coasts. Thrusting here would carry it past the centre
    // and make it drift back — the back-and-forth the producer rejected.
    const coasting = reposition.run(
      context(
        makeSnapshot({ player: { x: 350, y: 270, vx: 175, vy: 0 } }),
        COMPETENT_GOAL_IDS.reposition,
      ),
    );
    expect(coasting).not.toBeNull();
    expect(coasting!.thrust).toBe(false);
    expect(coasting!.dirX).toBeCloseTo(1, 3);
  });
});

describe('survival is a hard steering constraint (AC4)', () => {
  it('never returns an unsafe bearing when a safe alternative exists', () => {
    // A mineral behind a hazard on the direct line: the collect behaviour
    // must path around the hazard, not fly through it.
    const snapshot = makeSnapshot({
      player: PLAYER,
      minerals: [mineral(700, 300)],
      enemies: [enemy(520, 285, 'scout')],
    });
    const world = buildBotWorld(snapshot);
    const intent = collect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(
      evaluateDirection(intent!.dirX, intent!.dirY, world, T).safe,
    ).toBe(true);
  });
});

// ── Reverse thruster (AH-0MV1J0OHP0072XA5) ──────────────────────────

describe('collect behaviour — reverse brake-assist (AC1)', () => {
  /** Collect behaviour with `collectReverseBrake` opted back in. */
  const brakingBehaviours = createCompetentBehaviours(
    resolveCompetentTunables({ collectReverseBrake: true }),
  );
  const brakingCollect = brakingBehaviours.require('collect');

  it('requests reverse instead of only coasting when the gap is within the imminent-overshoot threshold', () => {
    // Closing on a mineral at 50 px with v=100 px/s: gap=32, threshold=36
    // (2× collectArrivalRadius).  Friction-only stopping distance
    // (100²/200 = 50 px) exceeds gap, so forward coasts; the reverse-assisted
    // stop (100²/(2·200) = 25 px) fits and v is within the retro envelope,
    // so the bot brakes with reverse (AH-0MV85WGOO0066I9X · AC1).
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 100, vy: 0 },
      minerals: [mineral(530, 270)],
      reverseEnabled: true,
    });
    const intent = brakingCollect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(intent!.thrust).toBe(false);
    expect(intent!.reverse).toBe(true);
    expect(intent!.dirX).toBeCloseTo(1, 3);
  });

  it('is pass-through by default: no reverse press on a pickup even inside the overshoot threshold (AH-0MWJ1680Z001QYV2 audit rejection)', () => {
    // The same geometry as above, with the shipped `collectReverseBrake: false`.
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 100, vy: 0 },
      minerals: [mineral(530, 270)],
      reverseEnabled: true,
    });
    const intent = collect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(intent!.reverse).toBe(false);
  });

  it('does not brake with reverse during normal deceleration when gap is above the threshold', () => {
    // Closing on a mineral at 100 px: gap=82 > 36 threshold. Ship coasts.
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
      minerals: [mineral(580, 270)],
      reverseEnabled: true,
    });
    const intent = brakingCollect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(intent!.reverse).toBe(false);
  });

  it('does not brake with reverse when the thruster is disabled (AC4)', () => {
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 175, vy: 0 },
      minerals: [mineral(560, 270)],
      reverseEnabled: false,
    });
    const intent = brakingCollect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent!.reverse).toBe(false);
  });
});

describe('collect behaviour — overshoot is accepted (AH-0MWJ1680Z001QYV2 audit rejection)', () => {
  /** Collect behaviour with the overshoot allowance opted in. */
  const overshootBehaviours = createCompetentBehaviours(
    resolveCompetentTunables({ collectOvershootMargin: 60 }),
  );
  const overshootCollect = overshootBehaviours.require('collect');

  it('lets go of a pickup the ship has just flown past instead of turning back', () => {
    // The ship is moving right at 150 px/s; the mineral sits 30 px to its
    // left — behind the velocity vector and inside the 60 px overshoot margin.
    // The only remaining target is that passed mineral, so the behaviour
    // declines rather than U-turning for it.
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 150, vy: 0 },
      minerals: [mineral(450, 270)],
    });
    const intent = overshootCollect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).toBeNull();
  });

  it('still targets a pickup ahead of the ship', () => {
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 150, vy: 0 },
      minerals: [mineral(520, 270)],
    });
    const intent = overshootCollect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(intent!.dirX).toBeCloseTo(1, 3);
  });

  it('picks the next target when a nearer pickup has been passed', () => {
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 150, vy: 0 },
      minerals: [mineral(450, 270), mineral(700, 270)],
    });
    const intent = overshootCollect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(intent!.dirX).toBeCloseTo(1, 3);
  });

  it('is opt-in: the shipped default still chases a passed pickup', () => {
    expect(T.collectOvershootMargin).toBe(0);
    const snapshot = makeSnapshot({
      player: { x: 480, y: 270, vx: 150, vy: 0 },
      minerals: [mineral(450, 270)],
    });
    const intent = collect.run(
      context(snapshot, COMPETENT_GOAL_IDS.collectMineral),
    );
    expect(intent).not.toBeNull();
    expect(intent!.dirX).toBeCloseTo(-1, 3);
  });
});

describe('engage behaviour — aim-preserving retreat / kiting (AC3)', () => {
  it('retreats with reverse while keeping the nose on a too-close target (threat present)', () => {
    // 80 px away: inside the 90 px retreat band. An incoming threatening shot
    // triggers the threat gate, so kiting fires.  Bullet comes from above,
    // not on the direct bearing to the enemy, so the safety filter still
    // accepts the direct (positive-X) bearing.
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [enemy(560, 270, 'scout')],
          enemyBullets: [bullet(480, 150, 0, 100)],
          reverseEnabled: true,
        }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent).not.toBeNull();
    // Nose still points at the enemy (positive X) — the retreat is reversed
    // thrust, not a turn-away.
    expect(intent!.dirX).toBeCloseTo(1, 3);
    expect(intent!.dirY).toBeCloseTo(0, 3);
    expect(intent!.reverse).toBe(true);
    expect(intent!.thrust).toBe(false);
  });

  it('does not kite with reverse during calm close combat (no threat)', () => {
    // 50 px away: inside both the 90 px retreat band and the 70 px danger
    // margin. The target's own proximity must not trigger kiting — no
    // incoming shots, no other hazards.
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [enemy(530, 270, 'scout')],
          reverseEnabled: true,
        }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent).not.toBeNull();
    expect(intent!.reverse).toBe(false);
  });

  it('kites with reverse when a genuine imminent collision is present', () => {
    // 80 px from the enemy (inside the retreat band) and an unrelated hazard
    // well inside the danger margin: the collision threat triggers kiting.
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [
            enemy(560, 270, 'scout'),
            // An asteroid off the direct bearing, 60 px away (< 70 margin).
            enemy(480, 210, 'asteroid'),
          ],
          reverseEnabled: true,
        }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent).not.toBeNull();
    expect(intent!.reverse).toBe(true);
  });

  it('does not kite with reverse when the thruster is disabled (AC4)', () => {
    const intent = engage.run(
      context(
        makeSnapshot({
          player: PLAYER,
          enemies: [enemy(560, 270, 'scout')],
          reverseEnabled: false,
        }),
        COMPETENT_GOAL_IDS.engageEnemy,
      ),
    );
    expect(intent!.reverse).toBe(false);
  });
});

// ── Lead prediction (AH-0MV1DUSM2005HL98 · AC2) ─────────────────────

describe('engage behaviour — lead prediction (AH-0MV1DUSM2005HL98 AC2)', () => {
  it('aims at the intercept of a crossing enemy, not its current position', () => {
    // Enemy due right but climbing (negative y velocity): the intercept is
    // above the current position, so the aim must gain a negative Y.
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [
        { x: 620, y: 270, alive: true, archetype: 'scout', vx: 0, vy: -90 },
      ],
    });
    const intent = engage.run(
      context(snapshot, COMPETENT_GOAL_IDS.engageEnemy),
    );
    expect(intent).not.toBeNull();
    // Not the current-position bearing (straight right)...
    expect(intent!.dirY).toBeLessThan(-0.1);
    // ...and the intent is flagged as an aim intent for the skill governor.
    expect(intent!.aim).toBe(true);
  });

  it('reduces to the current position for a stationary enemy (zero velocity)', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [enemy(620, 270, 'scout')],
    });
    const intent = engage.run(
      context(snapshot, COMPETENT_GOAL_IDS.engageEnemy),
    );
    expect(intent!.dirX).toBeCloseTo(1, 6);
    expect(intent!.dirY).toBeCloseTo(0, 6);
  });

  it('does not lead when aimLeadEnabled is false (designer toggle)', () => {
    const snapshot = makeSnapshot({
      player: PLAYER,
      enemies: [
        { x: 620, y: 270, alive: true, archetype: 'scout', vx: 0, vy: -90 },
      ],
    });
    const disabled = createCompetentBehaviours({
      ...T,
      aimLeadEnabled: false,
    }).require('engage');
    const intent = disabled.run(
      context(snapshot, COMPETENT_GOAL_IDS.engageEnemy),
    );
    expect(intent!.dirY).toBeCloseTo(0, 6);
  });
});

// ── Live physics inputs in the aim solve (AH-0MWR04ZDU0005O8J · AC2) ──

describe('aim solve live physics inputs (AH-0MWR04ZDU0005O8J AC2)', () => {
  /** A crossing target due right of the ship, climbing at 90 px/s. */
  const crossing = { x: 620, y: 270, alive: true, archetype: 'scout', vx: 0, vy: -90 };

  /** Runs engage with one live-physics snapshot player against the tunables. */
  function aimDirection(
    player: Record<string, unknown>,
    tunables: typeof T = T,
  ): number {
    const intent = createCompetentBehaviours(tunables)
      .require('engage')
      .run(
        context(
          makeSnapshot({ player: { ...PLAYER, ...player }, enemies: [crossing] }),
          COMPETENT_GOAL_IDS.engageEnemy,
        ),
      );
    expect(intent).not.toBeNull();
    return intent!.dirY;
  }

  it('resolveShotSpeed prefers an explicit override, then the live ship, then the compiled shot speed', () => {
    // Shipped defaults: the compiled default is the ship's own travelling-shot
    // speed (PLAYER_BULLET_SPEED), never the enemy-bullet tell constant.
    expect(resolveShotSpeed(T)).toBe(PLAYER_BULLET_SPEED);
    expect(resolveShotSpeed(T)).not.toBe(T.assumedBulletSpeed);
    // The live ship wins while the tunable stays at its default.
    expect(resolveShotSpeed(T, 420)).toBe(420);
    // An explicit override wins over the live value.
    expect(resolveShotSpeed({ ...T, shotSpeed: 260 }, 420)).toBe(260);
    // A missing or non-physical live value falls back to the compiled default.
    expect(resolveShotSpeed(T, Number.NaN)).toBe(PLAYER_BULLET_SPEED);
    expect(resolveShotSpeed(T, 0)).toBe(PLAYER_BULLET_SPEED);
  });

  it('fed 350 px/s, not the enemy tell constant: the lead is the shorter one', () => {
    // With the alignment term pinned to zero so the shot speed is the only
    // difference, the ship's own 350 px/s shot arrives sooner than the 200 px/s
    // enemy-tell assumption, so the solve leads the target less.
    const withLive = aimDirection({ shotSpeed: PLAYER_BULLET_SPEED }, { ...T, aimLeadAlignSeconds: 0 });
    const withOld = aimDirection({ shotSpeed: T.assumedBulletSpeed }, { ...T, aimLeadAlignSeconds: 0 });
    // Both lead the climbing target (negative Y)...
    expect(withLive).toBeLessThan(0);
    expect(withOld).toBeLessThan(0);
    // ...and the live shot speed leads by strictly less (200 → 350).
    expect(withLive).toBeGreaterThan(withOld);
    expect(withLive).toBeCloseTo(-0.257108, 5);
    expect(withOld).toBeCloseTo(-0.448505, 5);
  });

  it('derives the alignment term from the live rotation model', () => {
    const shipped = { rotationSpeed: 3, rotationAcceleration: 12, rotationDeceleration: 60 };
    // Spin up to the live top rate, then coast it back to rest.
    expect(deriveTurnAlignSeconds(shipped)).toBeCloseTo(0.3, 12);
    // A higher top rate takes longer to spin up and stop; a slower spin-up too.
    expect(deriveTurnAlignSeconds({ ...shipped, rotationSpeed: 6 })).toBeCloseTo(0.6, 12);
    expect(deriveTurnAlignSeconds({ ...shipped, rotationAcceleration: 6 })).toBeCloseTo(0.55, 12);
    // Precedence: explicit override > live rotation model > compiled constant.
    expect(resolveAimAlignSeconds(T, shipped)).toBeCloseTo(0.3, 12);
    expect(resolveAimAlignSeconds({ ...T, aimLeadAlignSeconds: 0.35 }, shipped)).toBe(0.35);
    // No rotation config (or a non-physical one) reproduces the constant.
    expect(resolveAimAlignSeconds(T)).toBe(T.aimLeadAlignSeconds);
    expect(
      resolveAimAlignSeconds(T, { rotationSpeed: 0, rotationAcceleration: 12, rotationDeceleration: 60 }),
    ).toBe(T.aimLeadAlignSeconds);
  });

  it('feeds the derived turn time into the solve', () => {
    // The same 350 px/s shot: a slower-turning ship spends longer aligning, so
    // the solve leads the crossing target further above its current position.
    const noConfig = aimDirection({ shotSpeed: PLAYER_BULLET_SPEED });
    const shipped = aimDirection({
      shotSpeed: PLAYER_BULLET_SPEED,
      rotation: { rotationSpeed: 3, rotationAcceleration: 12, rotationDeceleration: 60 },
    });
    const sluggish = aimDirection({
      shotSpeed: PLAYER_BULLET_SPEED,
      rotation: { rotationSpeed: 6, rotationAcceleration: 12, rotationDeceleration: 60 },
    });
    // No config reproduces the compiled constant (0.25 s), exactly as before.
    expect(noConfig).toBeCloseTo(-0.40398, 5);
    // The live derivation is used (0.30 s) rather than the constant.
    expect(shipped).toBeCloseTo(-0.43095, 5);
    expect(shipped).toBeLessThan(noConfig);
    // A slower re-orientation leads further still.
    expect(sluggish).toBeCloseTo(-0.572755, 5);
    expect(sluggish).toBeLessThan(shipped);
  });
});

// ── Class-sampled intercept (AH-0MWR051U6003BDB9 · AC3) ─────────────

describe('engage behaviour — class-sampled intercept (AH-0MWR051U6003BDB9 AC3)', () => {
  /** Builds an engage context whose world carries bot-side hazard estimates. */
  function contextWithTracker(
    snapshot: ReturnType<typeof makeSnapshot>,
    velocities: Map<string, { x: number; y: number }>,
    tunables = T,
  ): BotBehaviourContext {
    const goal = createCompetentGoals(tunables).require(
      COMPETENT_GOAL_IDS.engageEnemy,
    );
    return {
      snapshot,
      world: buildBotWorld(snapshot, undefined, undefined, velocities),
      memory: createBotMemory(),
      dt: 0.1,
      goal,
    };
  }

  /** Runs engage for one target under `tunables` and returns its intent. */
  function engageIntent(
    target: ReturnType<typeof enemy> & { id: number; vx?: number; vy?: number },
    velocities: Map<string, { x: number; y: number }>,
    tunables = T,
  ) {
    const intent = createCompetentBehaviours(tunables)
      .require('engage')
      .run(
        contextWithTracker(
          makeSnapshot({ player: PLAYER, enemies: [target] }),
          velocities,
          tunables,
        ),
      );
    expect(intent).not.toBeNull();
    return intent!;
  }

  // The motion-model OFF tunables are the straight-line control arm: the aim
  // is exactly `interceptPoint`, so any difference is the sampled class solve.
  const STRAIGHT = { ...T, hazardMotionModelEnabled: false };

  it('aims a tracked chaser along its homing arc, not the straight-line lead', () => {
    // The chaser is due right but climbing (0, -90): the straight lead aims
    // well above it, while a chaser pursues the ship and turns down-left, so
    // the sampled aim loses the upward lead.
    const tracked = { ...enemy(620, 270, 'ghost-chase'), id: 7 };
    const estimates = new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]);
    const sampled = engageIntent(tracked, estimates);
    const straight = engageIntent(tracked, estimates, STRAIGHT);
    // The control arm really is the straight-line lead (0.25 s compiled
    // alignment term: the fixture carries no rotation config)…
    expect(straight.dirY).toBeCloseTo(-0.40398, 5);
    // …and the class solve points essentially along the ship's bearing to the
    // chaser (its arc homes onto the ship).
    expect(sampled.dirY).toBeGreaterThan(straight.dirY + 0.2);
    expect(sampled.dirY).toBeCloseTo(0, 3);
    expect(sampled.dirX).toBeGreaterThan(straight.dirX);
    expect(sampled.aim).toBe(true);
  });

  it('falls back to the straight-line lead for a roamer estimate', () => {
    // `harvester` resolves to the `roamer` class: its model is the fitted
    // velocity, so the class solve is the legacy solve bit-for-bit.
    const tracked = { ...enemy(620, 270, 'harvester'), id: 7 };
    const estimates = new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]);
    const sampled = engageIntent(tracked, estimates);
    const straight = engageIntent(tracked, estimates, STRAIGHT);
    expect(sampled.dirX).toBe(straight.dirX);
    expect(sampled.dirY).toBe(straight.dirY);
  });

  it('falls back to the straight-line lead for an untracked target', () => {
    // A snapshot-velocity target (no stable id, so no hazard class) keeps the
    // legacy solve exactly, even though the motion model is on.
    const physicsBody = {
      ...enemy(620, 270, 'scout'),
      id: 7,
      vx: 0,
      vy: -90,
    };
    const sampled = engageIntent(physicsBody, new Map());
    const straight = engageIntent(physicsBody, new Map(), STRAIGHT);
    expect(sampled.dirX).toBe(straight.dirX);
    expect(sampled.dirY).toBe(straight.dirY);
  });

  it('falls back to the straight-line lead when the motion model is disabled', () => {
    // The designer's motion-model off-switch leaves the aim solve alone.
    const tracked = { ...enemy(620, 270, 'ghost-chase'), id: 7 };
    const estimates = new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]);
    const disabled = engageIntent(tracked, estimates, STRAIGHT);
    expect(disabled.dirY).toBeCloseTo(-0.40398, 5);
    expect(disabled.dirX).toBeCloseTo(0.914768, 5);
  });
});

describe('engage behaviour — tracker-derived aim velocity (AH-0MWR04X10002VNDG AC1)', () => {
  /** Builds an engage context whose world carries bot-side hazard estimates. */
  function contextWithTracker(
    snapshot: ReturnType<typeof makeSnapshot>,
    velocities: Map<string, { x: number; y: number }>,
    tunables = T,
  ): BotBehaviourContext {
    const goal = createCompetentGoals(tunables).require(
      COMPETENT_GOAL_IDS.engageEnemy,
    );
    return {
      snapshot,
      world: buildBotWorld(snapshot, undefined, undefined, velocities),
      memory: createBotMemory(),
      dt: 0.1,
      goal,
    };
  }

  it('leads a scripted formation enemy that exposes no snapshot velocity', () => {
    // The snapshot seam carries no velocity for a formation enemy, so before
    // this change the aim was the current position. The tracker estimate is
    // the only motion available and must lead the shot.
    const tracked = { ...enemy(620, 270, 'scout'), id: 7 };
    const intent = engage.run(
      contextWithTracker(
        makeSnapshot({ player: PLAYER, enemies: [tracked] }),
        new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]),
      ),
    );
    expect(intent).not.toBeNull();
    // Led upward, not straight at the current position.
    expect(intent!.dirY).toBeLessThan(-0.1);
    expect(intent!.aim).toBe(true);
  });

  it('prefers the tracked estimate over a conflicting snapshot velocity', () => {
    // Snapshot says the target descends; the tracker says it climbs. The
    // tracked estimate is the one estimate prediction and aim share, so the
    // aim must follow it.
    const target = {
      ...enemy(620, 270, 'scout'),
      id: 7,
      vx: 0,
      vy: 90,
    };
    const intent = engage.run(
      contextWithTracker(
        makeSnapshot({ player: PLAYER, enemies: [target] }),
        new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]),
      ),
    );
    expect(intent!.dirY).toBeLessThan(-0.1);
  });

  it('falls back to the snapshot velocity when the id has no estimate', () => {
    const target = {
      ...enemy(620, 270, 'scout'),
      id: 7,
      vx: 0,
      vy: -90,
    };
    const intent = engage.run(
      contextWithTracker(
        makeSnapshot({ player: PLAYER, enemies: [target] }),
        new Map([[enemyHazardKey(9), { x: 0, y: 90 }]]),
      ),
    );
    expect(intent!.dirY).toBeLessThan(-0.1);
  });

  it('aims at the current position on a cold-start zero-vector estimate', () => {
    // A tracker entry that has not seen two samples yet carries no velocity.
    // The first engagement tick must be exactly today's shot.
    const cold = { ...enemy(620, 270, 'scout'), id: 7 };
    const intent = engage.run(
      contextWithTracker(
        makeSnapshot({ player: PLAYER, enemies: [cold] }),
        new Map([[enemyHazardKey(7), { x: 0, y: 0 }]]),
      ),
    );
    expect(intent!.dirX).toBeCloseTo(1, 6);
    expect(intent!.dirY).toBeCloseTo(0, 6);
  });

  it('aims at the current position for an id-less target (the boss)', () => {
    // The boss carries no bot-side id, so it can never match a tracked
    // hazard; the aim is unchanged even with unrelated estimates present.
    const snapshot = makeSnapshot({ player: PLAYER, boss: boss(620, 270) });
    const goal = createCompetentGoals(T).require(COMPETENT_GOAL_IDS.engageBoss);
    const intent = engage.run({
      snapshot,
      world: buildBotWorld(
        snapshot,
        undefined,
        undefined,
        new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]),
      ),
      memory: createBotMemory(),
      dt: 0.1,
      goal,
    });
    expect(intent!.dirX).toBeCloseTo(1, 6);
    expect(intent!.dirY).toBeCloseTo(0, 6);
  });

  it('ignores the tracked estimate when the tracker control is off', () => {
    // The control (`aimLeadFromTracker: false`) flies the pre-change lead:
    // tracker estimates are ignored, so a target with no snapshot velocity is
    // aimed at its current position even though an estimate exists.
    const tracked = { ...enemy(620, 270, 'scout'), id: 7 };
    const engage = createCompetentBehaviours({
      ...T,
      aimLeadFromTracker: false,
    }).require('engage');
    const intent = engage.run(
      contextWithTracker(
        makeSnapshot({ player: PLAYER, enemies: [tracked] }),
        new Map([[enemyHazardKey(7), { x: 0, y: -90 }]]),
      ),
    );
    expect(intent!.dirX).toBeCloseTo(1, 6);
    expect(intent!.dirY).toBeCloseTo(0, 6);
  });

  it('leads a tracked target across the seam on the torus', () => {
    // The target sits across the left seam with a tracker estimate climbing:
    // the led point must be aimed at through the seam and upward.
    const tracked = { ...enemy(900, 270, 'scout'), id: 7 };
    const intent = engage.run(
      contextWithTracker(
        makeSnapshot({
          player: { x: 100, y: 270, vx: 0, vy: 0 },
          enemies: [tracked],
        }),
        new Map([[enemyHazardKey(7), { x: 0, y: -100 }]]),
      ),
    );
    expect(intent!.dirX).toBeLessThan(-0.1);
    expect(intent!.dirY).toBeLessThan(0);
  });
});

describe('resolveAimTargetMotion (AH-0MWR04X10002VNDG AC1)', () => {
  /** Builds a tracked hazard point fixture. */
  function hazard(
    id: number | undefined,
    vx?: number,
    vy?: number,
  ): BotHazardPoint {
    return {
      x: 620,
      y: 270,
      movementClass: 'formation',
      curvature: 0,
      ...(id !== undefined ? { id } : {}),
      ...(vx !== undefined && vy !== undefined ? { vx, vy } : {}),
    };
  }

  const target = (overrides: Partial<ContentTarget> = {}): ContentTarget => ({
    x: 620,
    y: 270,
    contentId: 'scout',
    ...overrides,
  });

  it('prefers the tracked estimate and names its hazard', () => {
    const out = createAimTargetMotion();
    const tracked = hazard(7, 12, -34);
    const motion = resolveAimTargetMotion(
      target({ id: 7, vx: -99, vy: 99 }),
      [hazard(3, 1, 1), tracked],
      out,
    );
    expect(motion).toBe(out);
    expect(motion.vx).toBe(12);
    expect(motion.vy).toBe(-34);
    expect(motion.hazard).toBe(tracked);
  });

  it('falls back to the snapshot velocity for an unmatched id', () => {
    const motion = resolveAimTargetMotion(
      target({ id: 7, vx: 5, vy: -6 }),
      [hazard(8, 1, 1)],
      createAimTargetMotion(),
    );
    expect({ vx: motion.vx, vy: motion.vy }).toEqual({ vx: 5, vy: -6 });
    expect(motion.hazard).toBeUndefined();
  });

  it('falls through a zero-vector estimate to the snapshot velocity', () => {
    const motion = resolveAimTargetMotion(
      target({ id: 7, vx: 5, vy: -6 }),
      [hazard(7, 0, 0)],
      createAimTargetMotion(),
    );
    expect({ vx: motion.vx, vy: motion.vy }).toEqual({ vx: 5, vy: -6 });
    expect(motion.hazard).toBeUndefined();
  });

  it('resolves to a stationary result when nothing reports motion', () => {
    const motion = resolveAimTargetMotion(
      target({ id: 7 }),
      [],
      createAimTargetMotion(),
    );
    expect({ vx: motion.vx, vy: motion.vy }).toEqual({ vx: 0, vy: 0 });
    expect(motion.hazard).toBeUndefined();
  });

  it('reuses one record with no per-tick allocation (AC1)', () => {
    // The aim solve runs on every engage tick: the lookup must write into the
    // caller's reused record instead of allocating a result object, and it
    // must not leak the previous tick's hazard into a fallback result.
    const out = createAimTargetMotion();
    const tracked = hazard(7, 12, -34);
    const first = resolveAimTargetMotion(target({ id: 7 }), [tracked], out);
    const second = resolveAimTargetMotion(target({ id: 7 }), [], out);
    expect(first).toBe(out);
    expect(second).toBe(out);
    expect(second.hazard).toBeUndefined();
  });
});

// ── Seam-aware aim (AH-0MVT2VZR7000GS15 · AC2/AC3) ───────────────────

describe('engage behaviour — seam-aware aim (AH-0MVT2VZR7000GS15)', () => {
  it('aims across the seam when the wrapped route is shorter', () => {
    // The enemy sits 780 px to the right on the raw line but only 180 px away
    // across the left seam, so the aim must point left.
    const snapshot = makeSnapshot({
      player: { x: 100, y: 270, vx: 0, vy: 0 },
      enemies: [enemy(880, 270, 'scout')],
    });
    const intent = engage.run(context(snapshot, COMPETENT_GOAL_IDS.engageEnemy));
    expect(intent).not.toBeNull();
    expect(intent!.dirX).toBeCloseTo(-1, 6);
    expect(intent!.dirY).toBeCloseTo(0, 6);
    expect(intent!.aim).toBe(true);
  });

  it('leads a moving target across the seam', () => {
    // The target is across the left seam and climbing: the intercept lies
    // up-left, not right where the raw bearing would point.
    const snapshot = makeSnapshot({
      player: { x: 100, y: 270, vx: 0, vy: 0 },
      enemies: [
        { x: 900, y: 270, alive: true, archetype: 'scout', vx: 0, vy: -100 },
      ],
    });
    const intent = engage.run(context(snapshot, COMPETENT_GOAL_IDS.engageEnemy));
    expect(intent).not.toBeNull();
    // The aim crosses the left seam (negative x) and leads upward, rather
    // than pointing right along the raw 800 px line.
    expect(intent!.dirX).toBeLessThan(-0.1);
    expect(intent!.dirY).toBeLessThan(0);
  });
});

// ── Predictive kiting gate (AH-0MVI4QDN90037DIN AC2) ────────────────

describe('engage kiting uses the predicted-collision test (AH-0MVI4QDN90037DIN AC2)', () => {
  /** Builds an engage context whose world carries bot-side hazard velocities. */
  function worldWithHazardVelocity(
    snapshot: ReturnType<typeof makeSnapshot>,
    velocities: Map<string, { x: number; y: number }>,
    tunables = T,
  ): BotBehaviourContext {
    const goal = createCompetentGoals(tunables).require(
      COMPETENT_GOAL_IDS.engageEnemy,
    );
    return {
      snapshot,
      world: buildBotWorld(snapshot, undefined, undefined, velocities),
      memory: createBotMemory(),
      dt: 0.1,
      goal,
    };
  }

  const snapshot = makeSnapshot({
    player: PLAYER,
    enemies: [
      { ...enemy(560, 270, 'scout'), id: 1 },
      // 125 px above the ship (outside dangerMargin) but crossing its path.
      { ...enemy(480, 145, 'scout'), id: 2 },
    ],
    reverseEnabled: true,
  });

  it('kites when a moving hazard is predicted to collide off the aim line', () => {
    const engage = createCompetentBehaviours(T).require('engage');
    const intent = engage.run(
      worldWithHazardVelocity(snapshot, new Map([[enemyHazardKey(2), { x: 0, y: 200 }]])),
    );
    expect(intent).not.toBeNull();
    expect(intent!.reverse).toBe(true);
  });

  it('does not kite on the same hazard when prediction is disabled', () => {
    const positional = resolveCompetentTunables({ hazardPredictionEnabled: false });
    const engage = createCompetentBehaviours(positional).require('engage');
    const intent = engage.run(
      worldWithHazardVelocity(
        snapshot,
        new Map([[enemyHazardKey(2), { x: 0, y: 200 }]]),
        positional,
      ),
    );
    expect(intent).not.toBeNull();
    expect(intent!.reverse).toBe(false);
  });
});

describe('wrapped distances in behaviours (AH-0MVT2W10L003VV1U)', () => {
  it('collects the wrapped-nearest mineral across the seam', () => {
    // Player near the left edge. A is 800 px away on the raw line but only
    // 160 px away across the left seam; B is 300 px away on the raw line. The
    // collect objective must point at A (leftwards) because its wrapped
    // distance is shorter.
    const intent = collect.run(
      context(
        makeSnapshot({
          player: { x: 100, y: 270, vx: 0, vy: 0 },
          minerals: [mineral(900, 270), mineral(400, 270)],
        }),
        COMPETENT_GOAL_IDS.collectMineral,
      ),
    );
    expect(intent!.dirX).toBeLessThan(0);
  });

  it('evades a shot that arrives across the seam by fleeing through it', () => {
    // Player near the left edge; a bullet just outside the right edge travels
    // right and will wrap across the player. Fleeing right increases the
    // wrapped separation from the shot.
    const intent = evade.run(
      context(
        makeSnapshot({
          player: { x: 100, y: 270, vx: 0, vy: 0 },
          enemyBullets: [bullet(950, 270, 100, 0)],
        }),
        COMPETENT_GOAL_IDS.survive,
      ),
    );
    expect(intent!.dirX).toBeGreaterThan(0);
  });
});
