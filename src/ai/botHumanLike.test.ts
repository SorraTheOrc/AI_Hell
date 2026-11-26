/**
 * Unit tests for the human-like bot input governor
 * (AH-0MUXXQ1MN002RXGB).
 *
 * The governor limits the raw per-tick `decideBotInput` decision to a human
 * reaction cadence and clamps it to the keys a human uses (W/A/D). All tests
 * are deterministic: the governor advances by an explicit `dt`, never the
 * wall clock.
 */

import { describe, expect, it } from 'vitest';

import type {
  AsteroidsInput,
  FourDirectionalInput,
} from '../utils/movementModel';
import { AsteroidsModel } from '../utils/movementModel';
import {
  BOT_HUMAN_INPUT_TUNABLES,
  BotInputGovernor,
  toAsteroidsInput,
} from './botHumanLike';

/** Builds a four-directional input with only the named directions set. */
function input(
  ...directions: ('up' | 'down' | 'left' | 'right')[]
): FourDirectionalInput {
  return {
    up: directions.includes('up'),
    down: directions.includes('down'),
    left: directions.includes('left'),
    right: directions.includes('right'),
  };
}

describe('BotInputGovernor — human reaction cadence (AC1)', () => {
  it('commits the first decision immediately', () => {
    const governor = new BotInputGovernor();
    expect(governor.update(input('up'), 1 / 60)).toEqual(input('up'));
  });

  it('holds the committed input until the reaction time elapses', () => {
    const governor = new BotInputGovernor({
      reactionTimeMs: 100,
      allowDown: false,
    });
    const dt = 0.02; // 20 ms per tick

    // First call commits immediately.
    expect(governor.update(input('up'), dt)).toEqual(input('up'));

    // The next four ticks (20/40/60/80 ms) are inside the reaction window,
    // so fast flip-flopping decisions are ignored.
    expect(governor.update(input('left'), dt)).toEqual(input('up'));
    expect(governor.update(input('right'), dt)).toEqual(input('up'));
    expect(governor.update(input('left'), dt)).toEqual(input('up'));
    expect(governor.update(input('right'), dt)).toEqual(input('up'));

    // At 100 ms the latest decision is committed.
    expect(governor.update(input('left'), dt)).toEqual(input('left'));
  });

  it('changes the committed input at most once per reaction window', () => {
    const governor = new BotInputGovernor({
      reactionTimeMs: 100,
      allowDown: false,
    });
    const decisions: FourDirectionalInput[] = [
      input('up'),
      input('left'),
      input('right'),
    ];
    let commits = 0;
    let prev = governor.current();
    // 10 ticks of 20 ms = 200 ms — two reaction windows (t=0 and t=100).
    for (let i = 0; i < 10; i++) {
      const committed = governor.update(
        decisions[i % decisions.length],
        0.02,
      );
      if (JSON.stringify(committed) !== JSON.stringify(prev)) commits += 1;
      prev = committed;
    }
    expect(commits).toBe(2);
  });

  it('honours custom tunables', () => {
    const governor = new BotInputGovernor({
      reactionTimeMs: 40,
      allowDown: true,
    });
    governor.update(input('up'), 0.02);
    // Two 20 ms ticks reach 40 ms and commit the new decision.
    expect(governor.update(input('left'), 0.02)).toEqual(input('up'));
    expect(governor.update(input('left'), 0.02)).toEqual(input('left'));
  });

  it('reset clears the committed input and re-arms immediate commit', () => {
    const governor = new BotInputGovernor();
    governor.update(input('up'), 1 / 60);
    governor.reset();
    expect(governor.current()).toEqual(input());

    const decision = governor.update(input('left'), 0.0001);
    expect(decision).toEqual(input('left'));
  });
});

describe('BotInputGovernor — human key set (AC2)', () => {
  it('never emits the down direction by default (W/A/D only)', () => {
    const governor = new BotInputGovernor();
    expect(governor.update(input('down'), 1 / 60)).toEqual(input());
  });

  it('strips down from an otherwise valid decision', () => {
    const governor = new BotInputGovernor();
    expect(governor.update(input('up', 'down', 'right'), 1 / 60)).toEqual(
      input('up', 'right'),
    );
  });

  it('passes down through only when the tunable allows it', () => {
    const governor = new BotInputGovernor({
      ...BOT_HUMAN_INPUT_TUNABLES,
      allowDown: true,
    });
    expect(governor.update(input('down'), 1 / 60)).toEqual(input('down'));
  });

  it('current() returns a defensive copy', () => {
    const governor = new BotInputGovernor();
    governor.update(input('up'), 1 / 60);
    const copy = governor.current() as FourDirectionalInput;
    copy.up = false;
    expect((governor.current() as FourDirectionalInput).up).toBe(true);
  });

  it('defaults to a ~250 ms reaction time and no down key', () => {
    expect(BOT_HUMAN_INPUT_TUNABLES.reactionTimeMs).toBeGreaterThanOrEqual(200);
    expect(BOT_HUMAN_INPUT_TUNABLES.reactionTimeMs).toBeLessThanOrEqual(400);
    expect(BOT_HUMAN_INPUT_TUNABLES.allowDown).toBe(false);
  });
});

describe('toAsteroidsInput — steering-intent → W/A/D execution', () => {
  /** Builds an asteroid input with only the named controls set (reverse always false). */
  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
      reverse: false,
    };
  }

  it('an idle intent produces an all-false asteroid input', () => {
    expect(toAsteroidsInput(input(), 0)).toEqual(asteroid());
  });

  it('turns left to face an upward intent from a rightward facing', () => {
    // Screen coordinates: up is -π/2; from facing 0 (right) that is the
    // counter-clockwise (turnLeft) way round.
    expect(toAsteroidsInput(input('up'), 0)).toEqual(asteroid('turnLeft'));
  });

  it('turns right to face a downward intent from a rightward facing', () => {
    // Down is +π/2; from facing 0 (right) that is clockwise (turnRight).
    expect(toAsteroidsInput(input('down'), 0)).toEqual(asteroid('turnRight'));
  });

  it('thrusts forward once the ship faces the desired direction', () => {
    // Intent up, already facing up (-π/2).
    expect(toAsteroidsInput(input('up'), -Math.PI / 2)).toEqual(
      asteroid('forward'),
    );
    // Intent right, facing right.
    expect(toAsteroidsInput(input('right'), 0)).toEqual(asteroid('forward'));
  });

  it('thrusts forward within the alignment tolerance and turns outside it', () => {
    // 0.3 rad off — inside a 0.5 rad tolerance, outside a 0.1 rad tolerance.
    const offBy = 0.3;
    expect(toAsteroidsInput(input('up'), -Math.PI / 2 + offBy, 0.5)).toEqual(
      asteroid('forward'),
    );
    // 0.3 rad clockwise past up → rotate counter-clockwise (turnLeft).
    expect(toAsteroidsInput(input('up'), -Math.PI / 2 + offBy, 0.1)).toEqual(
      asteroid('turnLeft'),
    );
  });

  it('takes the shortest way round when the raw error exceeds π', () => {
    // facing −3.2 rad ≡ 3.08 rad; desired right (0). The short way is
    // counter-clockwise (turnLeft), not the long clockwise turnRight.
    expect(toAsteroidsInput(input('right'), -3.2)).toEqual(
      asteroid('turnLeft'),
    );
  });

  it('never turns while thrusting and treats reverse as opt-in', () => {
    for (const facing of [-3, -1.5, 0, 1.5, 3]) {
      for (const intent of [
        input('up'),
        input('down'),
        input('left'),
        input('right'),
      ]) {
        const out = toAsteroidsInput(intent, facing);
        // The asteroid input carries exactly W/A/D plus a `reverse` field —
        // opt-in: without a reverse request it is always false (AC4/AC6).
        expect(Object.keys(out).sort()).toEqual([
          'forward',
          'reverse',
          'turnLeft',
          'turnRight',
        ]);
        expect(out.reverse).toBe(false);
        // A turning command is never paired with forward thrust.
        if (out.turnLeft || out.turnRight) expect(out.forward).toBe(false);
      }
    }
  });
});

describe('BotInputGovernor — scheme execution (AC2/AC7)', () => {
  it('emits asteroid input (W/A/D) when the ship uses the asteroids scheme', () => {
    const governor = new BotInputGovernor();
    const committed = governor.update(input('right'), 1 / 60, {
      scheme: 'asteroids',
      facing: 0,
    });
    expect(committed).toEqual({
      forward: true,
      turnLeft: false,
      turnRight: false,
      reverse: false,
    });
    // The asteroid input has no four-directional fields at all.
    expect('up' in committed).toBe(false);
    expect('down' in committed).toBe(false);
  });

  it('strips down in four-directional mode but honours it in asteroids mode', () => {
    const governor = new BotInputGovernor();

    // four-directional: S/down is never emitted.
    expect(
      governor.update(input('down'), 1 / 60, {
        scheme: 'fourDirectional',
        facing: 0,
      }),
    ).toEqual(input());

    // asteroids: a downward *intent* is a legal heading (turns the ship to
    // face down); it is not a reverse key.
    governor.reset();
    expect(
      governor.update(input('down'), 1 / 60, {
        scheme: 'asteroids',
        facing: 0,
      }),
    ).toEqual({
      forward: false,
      turnLeft: false,
      turnRight: true,
      reverse: false,
    });
  });

  it('holds the committed asteroid input until the reaction window elapses', () => {
    const governor = new BotInputGovernor({
      reactionTimeMs: 100,
      allowDown: false,
      alignmentToleranceRad: 0.15,
    });
    const dt = 0.02; // 20 ms per tick

    // First call commits immediately: idle steering → no thrust.
    expect(
      governor.update(input(), dt, { scheme: 'asteroids', facing: 0 }),
    ).toEqual({
      forward: false,
      turnLeft: false,
      turnRight: false,
      reverse: false,
    });

    // Inside the reaction window a new "go right" intent is ignored.
    for (let i = 0; i < 4; i += 1) {
      expect(
        governor.update(input('right'), dt, { scheme: 'asteroids', facing: 0 }),
      ).toEqual({
        forward: false,
        turnLeft: false,
        turnRight: false,
        reverse: false,
      });
    }

    // At 100 ms the latest intent commits as forward thrust.
    expect(
      governor.update(input('right'), dt, { scheme: 'asteroids', facing: 0 }),
    ).toEqual({
      forward: true,
      turnLeft: false,
      turnRight: false,
      reverse: false,
    });
  });
});

// ── Precise bearing + closed-loop aiming (rejection AH-0MUXYOV4C008MV0L) ──
//
// The operator rejected the original demo bot because it "oscillates with
// left and right rotation thrusters": a cardinal-only intent snapped the
// hull between N/E/S/W.  The governor now aims at the intent's precise
// bearing and re-resolves the held intent against the ship's current facing
// every tick, so a held turn is closed-loop and does not overshoot.

describe('toAsteroidsInput — precise bearing (rejection)', () => {
  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
      reverse: false,
    };
  }

  it('aims at the precise bearing, not the nearest cardinal', () => {
    // 30° above the leftward horizontal.
    const bearing = Math.PI - Math.PI / 6;
    const intent = {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
    };
    // Facing that exact bearing → thrust forward (not turn to a cardinal).
    expect(toAsteroidsInput(intent, bearing)).toEqual(asteroid('forward'));
    // A cardinal fallback would have turned to face hard left instead.
    expect(toAsteroidsInput({ ...input('left') }, bearing)).toEqual(
      asteroid('turnRight'),
    );
  });

  it('turns toward the precise bearing from a rightward facing', () => {
    // 45° below-right.
    const intent = {
      ...input(),
      dirX: Math.cos(Math.PI / 4),
      dirY: Math.sin(Math.PI / 4),
    };
    expect(toAsteroidsInput(intent, 0)).toEqual(asteroid('turnRight'));
  });

  it('falls back to the cardinal booleans when no precise bearing is present', () => {
    expect(toAsteroidsInput(input('up'), 0)).toEqual(asteroid('turnLeft'));
  });

  it('ignores a zero or non-finite precise bearing and uses the cardinals', () => {
    expect(
      toAsteroidsInput({ ...input('up'), dirX: 0, dirY: 0 }, 0),
    ).toEqual(asteroid('turnLeft'));
    expect(
      toAsteroidsInput(
        { ...input('right'), dirX: Number.NaN, dirY: Number.NaN },
        0,
      ),
    ).toEqual(asteroid('forward'));
  });
});

describe('BotInputGovernor — closed-loop aiming (rejection)', () => {
  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
      reverse: false,
    };
  }

  it('re-resolves the held intent against the current facing each tick', () => {
    const governor = new BotInputGovernor({ reactionTimeMs: 1000 });
    // An aim intent: holding the weapon axis stays a closed-loop, per-tick
    // release (the turn press hold exempts aim intents;
    // AH-0MWJ1680Z001QYV2 audit rejection).
    const aimUp = { ...input('up'), aim: true };

    // Commit an "aim up" intent while the ship still faces right: turn left.
    expect(
      governor.update(aimUp, 1 / 60, { scheme: 'asteroids', facing: 0 }),
    ).toEqual(asteroid('turnLeft'));

    // Within the same held window the ship has rotated to face up, so the
    // held intent now thrusts forward — closed-loop, not open-loop.
    expect(
      governor.update(aimUp, 1 / 60, {
        scheme: 'asteroids',
        facing: -Math.PI / 2,
      }),
    ).toEqual(asteroid('forward'));
  });

  it('keeps the committed precise bearing while the reaction window is open', () => {
    const governor = new BotInputGovernor({ reactionTimeMs: 1000 });
    const bearing = Math.PI / 4;
    const intent = {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
    };

    // Commits the precise bearing immediately; facing it → forward.
    expect(
      governor.update(intent, 1 / 60, { scheme: 'asteroids', facing: bearing }),
    ).toEqual(asteroid('forward'));

    // A later, different decision inside the window is ignored: the ship
    // re-aims at the held bearing (now off) rather than flipping target.
    expect(
      governor.update(input('up'), 1 / 60, { scheme: 'asteroids', facing: 0 }),
    ).toEqual(asteroid('turnRight'));
  });
});

// ── Forward-model throttle (AC10) ───────────────────────────────────
//
// The bot's `thrust` flag is the fast-reflex braking decision: it is
// re-evaluated every tick even while the chosen heading stays committed for
// the human reaction window.

describe('forward-model throttle (AC10)', () => {
  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
      reverse: false,
    };
  }

  it('coasts (no forward thrust) when the intent says thrust is false', () => {
    expect(
      toAsteroidsInput(
        { ...input('right'), dirX: 1, dirY: 0, thrust: false },
        0,
      ),
    ).toEqual(asteroid());
  });

  it('still turns toward the target while coasting', () => {
    // Aiming up but coasting: the ship turns toward up without thrusting.
    expect(toAsteroidsInput({ ...input('up'), thrust: false }, 0)).toEqual(
      asteroid('turnLeft'),
    );
  });

  it('holds the thrust press even when the live request turns off (AC15)', () => {
    const governor = new BotInputGovernor(
      {
        reactionTimeMs: 1000,
        thrustPressMinMs: 200,
        thrustPressMaxMs: 225,
        thrustPressMaxMsLong: 400,
      },
      1,
    );
    const intent = { ...input('right'), dirX: 1, dirY: 0, thrust: true };

    expect(
      governor.update(intent, 1 / 60, { scheme: 'asteroids', facing: 0 }),
    ).toEqual(asteroid('forward'));

    // The live request is off next tick, but the press holds the key down.
    const braking = { ...input('right'), dirX: 1, dirY: 0, thrust: false };
    expect(
      governor.update(braking, 1 / 60, { scheme: 'asteroids', facing: 0 }),
    ).toEqual(asteroid('forward'));

    // Once the press window elapses, it coasts.
    for (let i = 0; i < 30; i += 1) {
      governor.update(braking, 1 / 60, { scheme: 'asteroids', facing: 0 });
    }
    expect(
      governor.update(braking, 1 / 60, { scheme: 'asteroids', facing: 0 }),
    ).toEqual(asteroid());
  });

  it('coasts in four-directional mode too (releases the movement keys)', () => {
    const governor = new BotInputGovernor();
    expect(
      governor.update({ ...input('right'), thrust: false }, 1 / 60, {
        scheme: 'fourDirectional',
        facing: 0,
      }),
    ).toEqual(input());
  });
});

// ── Human-like thrust presses (AC15/AC16) ───────────────────────────
//
// The operator reported the bot toggling the thruster "on/off/on/off" to
// avoid overshooting and asked for human-length presses (200–225 ms, extended
// to 400 ms on a long-travel leg).

describe('human-like thrust presses (AC15/AC16)', () => {
  const DT = 1 / 60;
  const DT_MS = DT * 1000;
  const T = {
    thrustPressMinMs: 200,
    thrustPressMaxMs: 225,
    thrustPressMaxMsLong: 400,
    reactionTimeMs: 1000,
    // Disable the gentle reduction so the existing AC15/AC16 duration bands
    // (200–225 / 400 ms) remain unchanged for these tests.
    thrustPressGentleMinPct: 0,
    thrustPressGentleMaxPct: 0,
  };
  const thrustIntent = { ...input('right'), dirX: 1, dirY: 0, thrust: true };
  const longThrustIntent = { ...thrustIntent, longTravel: true };
  const coastIntent = { ...input('right'), dirX: 1, dirY: 0, thrust: false };

  /** Measures the on-run (ms) of the press started by a rising thrust edge. */
  function measurePressMs(
    governor: BotInputGovernor,
    intent: FourDirectionalInput & { dirX: number; dirY: number; thrust: boolean; longTravel?: boolean } = thrustIntent,
  ): number {
    governor.update(intent, DT, { scheme: 'asteroids', facing: 0 });
    let ticks = 1;
    for (let i = 0; i < 60; i += 1) {
      const out = governor.update(coastIntent, DT, {
        scheme: 'asteroids',
        facing: 0,
      }) as AsteroidsInput;
      if (!out.forward) break;
      ticks += 1;
    }
    return ticks * DT_MS;
  }

  it('extends a one-tick thrust request into a full press', () => {
    const ms = measurePressMs(new BotInputGovernor(T, 1));
    // 200–225 ms (allow two ticks of measurement slack: the press spans from
    // the rising edge to the tick it expires).
    expect(ms).toBeGreaterThanOrEqual(200 - DT_MS);
    expect(ms).toBeLessThanOrEqual(225 + 2 * DT_MS);
    // A full press is many ticks, not the raw one-tick blip.
    expect(ms / DT_MS).toBeGreaterThan(8);
  });

  it('randomises each press within the 200–225 ms band', () => {
    const governor = new BotInputGovernor(T, 7);
    const durations = [0, 1, 2, 3, 4].map(() => measurePressMs(governor));
    for (const ms of durations) {
      expect(ms).toBeGreaterThanOrEqual(200 - DT_MS);
      expect(ms).toBeLessThanOrEqual(225 + 2 * DT_MS);
    }
    // Random per press: not all presses are the same length.
    expect(new Set(durations.map((d) => Math.round(d))).size).toBeGreaterThan(1);
  });

  it('AC16 — extends the press cap to 400 ms on a long-travel leg', () => {
    const governor = new BotInputGovernor(T, 11);
    const durations = [0, 1, 2, 3, 4, 5, 6, 7].map(() =>
      measurePressMs(governor, longThrustIntent),
    );
    for (const ms of durations) {
      expect(ms).toBeGreaterThanOrEqual(200 - DT_MS);
      expect(ms).toBeLessThanOrEqual(400 + 2 * DT_MS);
    }
    // The long cap is genuinely larger than the normal one.
    expect(Math.max(...durations)).toBeGreaterThan(225 + DT_MS);
  });

  it('is deterministic for a given seed', () => {
    const first = new BotInputGovernor(T, 42);
    const second = new BotInputGovernor(T, 42);
    const seqFirst = [0, 1, 2, 3, 4].map(() =>
      Math.round(measurePressMs(first)),
    );
    const seqSecond = [0, 1, 2, 3, 4].map(() =>
      Math.round(measurePressMs(second)),
    );
    expect(seqFirst).toEqual(seqSecond);
  });

  it('keeps thrust on continuously while the live request stays on', () => {
    const governor = new BotInputGovernor(T, 3);
    for (let i = 0; i < 90; i += 1) {
      const out = governor.update(thrustIntent, DT, {
        scheme: 'asteroids',
        facing: 0,
      }) as AsteroidsInput;
      expect(out.forward).toBe(true);
    }
  });
});

// ── Gentler thrust presses (AH-0MUYRJQE50021T4A) ────────────────────
//
// Each forward-thrust press is reduced by a random 1–5 % of its drawn
// duration, making the demo bot slightly less aggressive on the thrusters.

describe('gentler thrust presses (AH-0MUYRJQE50021T4A)', () => {
  // 1 ms ticks so a 1–5 % reduction (2–11 ms on a normal press) is
  // measurable; a 60 fps tick (16.7 ms) is coarser than the effect.
  const DT_MS = 1;
  const DT = DT_MS / 1000;
  const T_GENTLE = {
    thrustPressMinMs: 200,
    thrustPressMaxMs: 225,
    thrustPressMaxMsLong: 400,
    reactionTimeMs: 100000,
    thrustPressGentleMinPct: 0.01,
    thrustPressGentleMaxPct: 0.05,
  };
  const T_ZERO = {
    ...T_GENTLE,
    thrustPressGentleMinPct: 0,
    thrustPressGentleMaxPct: 0,
  };
  const thrustIntent = { ...input('right'), dirX: 1, dirY: 0, thrust: true };
  const longThrustIntent = { ...thrustIntent, longTravel: true };
  const coastIntent = { ...input('right'), dirX: 1, dirY: 0, thrust: false };

  /** Measures the on-run (ms) of the press started by a rising thrust edge. */
  function measurePressMs(
    governor: BotInputGovernor,
    intent: FourDirectionalInput & {
      dirX: number;
      dirY: number;
      thrust: boolean;
      longTravel?: boolean;
    },
  ): number {
    governor.update(intent, DT, { scheme: 'asteroids', facing: 0 });
    let ticks = 1;
    for (let i = 0; i < 5000; i += 1) {
      const out = governor.update(coastIntent, DT, {
        scheme: 'asteroids',
        facing: 0,
      }) as AsteroidsInput;
      if (!out.forward) break;
      ticks += 1;
    }
    return ticks * DT_MS;
  }

  it('AC1 — reduces a normal press by a random 1–5 %', () => {
    // Same seed → identical base draw, so the ratio isolates the reduction.
    const zero = measurePressMs(new BotInputGovernor(T_ZERO, 7), thrustIntent);
    const gentle = measurePressMs(
      new BotInputGovernor(T_GENTLE, 7),
      thrustIntent,
    );
    expect(zero).toBeGreaterThanOrEqual(200);
    expect(zero).toBeLessThanOrEqual(225);
    expect(gentle).toBeLessThan(zero);
    // ±0.008 absorbs the ≤1 ms integer-tick rounding on each measurement.
    const reduction = (zero - gentle) / zero;
    expect(reduction).toBeGreaterThanOrEqual(0.01 - 0.008);
    expect(reduction).toBeLessThanOrEqual(0.05 + 0.008);
  });

  it('AC1 — reduces a long-travel press by the same 1–5 % band', () => {
    const zero = measurePressMs(
      new BotInputGovernor(T_ZERO, 11),
      longThrustIntent,
    );
    const gentle = measurePressMs(
      new BotInputGovernor(T_GENTLE, 11),
      longThrustIntent,
    );
    expect(zero).toBeGreaterThanOrEqual(200);
    expect(zero).toBeLessThanOrEqual(400);
    expect(gentle).toBeLessThan(zero);
    const reduction = (zero - gentle) / zero;
    expect(reduction).toBeGreaterThanOrEqual(0.01 - 0.008);
    expect(reduction).toBeLessThanOrEqual(0.05 + 0.008);
  });

  it('AC2 — the reduction sequence is identical for two same-seed governors', () => {
    const first = new BotInputGovernor(T_GENTLE, 42);
    const second = new BotInputGovernor(T_GENTLE, 42);
    const seqFirst = [0, 1, 2, 3, 4].map(() =>
      measurePressMs(first, thrustIntent),
    );
    const seqSecond = [0, 1, 2, 3, 4].map(() =>
      measurePressMs(second, thrustIntent),
    );
    expect(seqFirst).toEqual(seqSecond);
  });

  it('AC2 — the reduction is drawn per press, not a fixed value', () => {
    // A fixed base (min = max = long cap) makes the drawn reduction visible.
    const fixedBase = {
      ...T_GENTLE,
      thrustPressMinMs: 200,
      thrustPressMaxMs: 200,
      thrustPressMaxMsLong: 200,
    };
    const governor = new BotInputGovernor(fixedBase, 7);
    const durations = [0, 1, 2, 3, 4, 5, 6, 7].map(() =>
      measurePressMs(governor, thrustIntent),
    );
    // Every press sits inside the 1–5 % band of the fixed 200 ms base...
    for (const ms of durations) {
      expect(ms).toBeGreaterThanOrEqual(200 * 0.95 - DT_MS);
      expect(ms).toBeLessThanOrEqual(200 * 0.99 + DT_MS);
    }
    // ...and the reduction is redrawn each press, so they are not all equal.
    expect(new Set(durations).size).toBeGreaterThan(1);
  });

  it('AC3 — continuous thrust has no off-gaps', () => {
    const governor = new BotInputGovernor(T_GENTLE, 3);
    for (let i = 0; i < 500; i += 1) {
      const out = governor.update(thrustIntent, DT, {
        scheme: 'asteroids',
        facing: 0,
      }) as AsteroidsInput;
      expect(out.forward).toBe(true);
    }
  });

  it('AC4 — the gentle bounds are documented tunables with 1 %/5 % defaults', () => {
    expect(BOT_HUMAN_INPUT_TUNABLES.thrustPressGentleMinPct).toBe(0.01);
    expect(BOT_HUMAN_INPUT_TUNABLES.thrustPressGentleMaxPct).toBe(0.05);
  });
});

// ── Reverse thrust (AH-0MV2WJSY70070HK2) ───────────────────────────
//
// Reverse is reserved for trouble/correction: the committed intent may
// request it for an imminent overshoot or a threat escape (kiting), the
// actuator emits it only when the ship's reverse thruster is enabled, and the
// governor holds reverse in human-like presses. Heading-aware reverse was
// removed — the ship always turns to face its travel bearing.

describe('reverse thrust (AH-0MV2WJSY70070HK2)', () => {
  const DT = 1 / 60;
  const DT_MS = DT * 1000;

  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight' | 'reverse')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
      reverse: controls.includes('reverse'),
    };
  }

  /** A precise intent aimed at `bearing` that requests reverse. */
  function reverseIntent(bearing: number, thrust = false) {
    return {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
      thrust,
      reverse: true,
    };
  }

  describe('toAsteroidsInput — enable-flag gating (AC4/AC6)', () => {
    it('emits reverse when the intent requests it and reverse is enabled', () => {
      // Nose already on the travel bearing (facing 0 = right) → brake.
      expect(toAsteroidsInput(reverseIntent(0), 0)).toEqual(asteroid('reverse'));
    });

    it('emits reverse:false on every input when reverse is disabled', () => {
      for (const facing of [-3, -1.5, 0, 1.5, 3, Math.PI]) {
        const out = toAsteroidsInput(reverseIntent(0), facing, 0.15, false);
        expect(out.reverse).toBe(false);
      }
    });

    it('brakes when the nose is aligned and backs toward a bearing behind (AC1/AC2)', () => {
      // Aligned: brake straight up, no turn.
      expect(toAsteroidsInput(reverseIntent(0), 0)).toEqual(asteroid('reverse'));
      // Directly behind: no 180° turn — reverse instead.
      expect(toAsteroidsInput(reverseIntent(Math.PI), 0)).toEqual(
        asteroid('reverse'),
      );
    });

    it('turns to align the nose before reversing when only partly behind', () => {
      // Travel bearing 2.0 rad: the nose must turn to face π away (error−π).
      const out = toAsteroidsInput(reverseIntent(2.0), 0) as AsteroidsInput;
      expect(out.reverse).toBe(false);
      expect(out.turnLeft).toBe(true);
      expect(out.turnRight).toBe(false);
    });
  });

  describe('BotInputGovernor — no heading-aware reverse (AC1)', () => {
    const H = { reactionTimeMs: 0, reversePressMinMs: 0, reversePressMaxMs: 0 };
    /** A precise intent with NO reverse request. */
    const forwardIntentAt = (dx: number, dy: number) => ({
      ...input(),
      dirX: dx,
      dirY: dy,
      thrust: true,
      reverse: false,
    });

    it('turns to face a travel bearing directly behind the nose instead of reversing', () => {
      const governor = new BotInputGovernor(H);
      // Facing right, intent directly left (π behind), no reverse request.
      for (let i = 0; i < 10; i += 1) {
        const out = governor.update(
          forwardIntentAt(-1, 0),
          DT,
          { scheme: 'asteroids', facing: 0, reverseEnabled: true },
        ) as AsteroidsInput;
        expect(out.reverse).toBe(false);
      }
    });

    it('never emits reverse for any heading when the intent does not request it', () => {
      const governor = new BotInputGovernor(H);
      for (let step = 0; step <= 24; step += 1) {
        const facing = -Math.PI + (2 * Math.PI * step) / 24;
        const out = governor.update(
          forwardIntentAt(1, 0),
          DT,
          { scheme: 'asteroids', facing, reverseEnabled: true },
        ) as AsteroidsInput;
        expect(out.reverse).toBe(false);
      }
    });
  });

  describe('BotInputGovernor — human-like reverse presses (AC5)', () => {
    const T = {
      reactionTimeMs: 0,
      reversePressMinMs: 200,
      reversePressMaxMs: 260,
      reversePressGentleMinPct: 0,
      reversePressGentleMaxPct: 0,
    };
    const forwardIntent = { ...input('right'), dirX: 1, dirY: 0, thrust: true, reverse: false };

    /** Measures the on-run (ms) of a reverse press started by a rising edge. */
    function measureReverseMs(governor: BotInputGovernor): number {
      governor.update(reverseIntent(0), DT, {
        scheme: 'asteroids',
        facing: 0,
        reverseEnabled: true,
      });
      let ticks = 1;
      for (let i = 0; i < 60; i += 1) {
        const out = governor.update(forwardIntent, DT, {
          scheme: 'asteroids',
          facing: 0,
          reverseEnabled: true,
        }) as AsteroidsInput;
        if (!out.reverse) break;
        ticks += 1;
      }
      return ticks * DT_MS;
    }

    it('extends a one-tick reverse request into a full press', () => {
      const ms = measureReverseMs(new BotInputGovernor(T, 1));
      expect(ms).toBeGreaterThanOrEqual(200 - DT_MS);
      expect(ms).toBeLessThanOrEqual(260 + 2 * DT_MS);
      // Many ticks, not a per-frame toggle.
      expect(ms / DT_MS).toBeGreaterThan(8);
    });

    it('randomises each press within the band and is deterministic per seed', () => {
      const governor = new BotInputGovernor(T, 7);
      const durations = [0, 1, 2, 3, 4].map(() => measureReverseMs(governor));
      for (const ms of durations) {
        expect(ms).toBeGreaterThanOrEqual(200 - DT_MS);
        expect(ms).toBeLessThanOrEqual(260 + 2 * DT_MS);
      }
      expect(new Set(durations.map((d) => Math.round(d))).size).toBeGreaterThan(1);

      const first = new BotInputGovernor(T, 42);
      const second = new BotInputGovernor(T, 42);
      expect([0, 1, 2].map(() => Math.round(measureReverseMs(first)))).toEqual(
        [0, 1, 2].map(() => Math.round(measureReverseMs(second))),
      );
    });

    it('reset clears the reverse press', () => {
      const governor = new BotInputGovernor(T, 3);
      governor.update(reverseIntent(0), DT, {
        scheme: 'asteroids',
        facing: 0,
        reverseEnabled: true,
      });
      governor.reset();
      // After reset, a forward intent emits no reverse.
      const out = governor.update(forwardIntent, DT, {
        scheme: 'asteroids',
        facing: 0,
        reverseEnabled: true,
      }) as AsteroidsInput;
      expect(out.reverse).toBe(false);
    });
  });
});

// ── Inertia-aware turn hold (AH-0MV1DUSM2005HL98 · AC1) ─────────────

describe('toAsteroidsInput — inertia-aware turn hold (AH-0MV1DUSM2005HL98 AC1)', () => {
  /** A precise intent aimed at `bearing` (no thrust — aim only). */
  function aimIntent(bearing: number) {
    return {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
      thrust: false,
      aim: true,
    };
  }

  it('reduces to the legacy instantaneous release when the ship is not spinning', () => {
    // Error 0.2 > tolerance: keep turning. Error 0.1 < tolerance: release
    // (no turn command; the coast/intent's own thrust flag is irrelevant here).
    const turning = toAsteroidsInput(
      aimIntent(0.2),
      0,
      0.15,
      false,
      0,
      60,
    ) as AsteroidsInput;
    expect(turning.turnRight).toBe(true);
    expect(turning.turnLeft).toBe(false);
    const released = toAsteroidsInput(
      aimIntent(0.1),
      0,
      0.15,
      false,
      0,
      60,
    ) as AsteroidsInput;
    expect(released.turnRight).toBe(false);
    expect(released.turnLeft).toBe(false);
  });

  it('brakes a coast that would overshoot instead of releasing on the instantaneous error', () => {
    // Instantaneous error -0.10 (inside the 0.15 tolerance) but the ship is
    // spinning clockwise at +3 rad/s, so releasing would coast ~0.075 rad
    // further clockwise — a predicted stop error of ~-0.175, outside
    // tolerance. The inertia-aware release must brake the spin instead.
    const out = toAsteroidsInput(
      aimIntent(-0.1),
      0,
      0.15,
      false,
      3,
      60,
    ) as AsteroidsInput;
    expect(out.turnLeft).toBe(true);
    expect(out.turnRight).toBe(false);
    expect(out.forward).toBe(false);
    // The same instantaneous error without the spin releases (no turn).
    const legacy = toAsteroidsInput(
      aimIntent(-0.1),
      0,
      0.15,
      false,
      0,
      60,
    ) as AsteroidsInput;
    expect(legacy.turnLeft).toBe(false);
    expect(legacy.turnRight).toBe(false);
  });

  it('reads the live deceleration it is handed (no hard-coded rotation constant)', () => {
    // Error -0.05, spin +3. With the shipped 60 rad/s² the coast is 0.075 and
    // the predicted stop is within tolerance (release). With a gentle
    // 5 rad/s² the coast is 0.9 and the release must brake.
    const shipped = toAsteroidsInput(
      aimIntent(-0.05),
      0,
      0.15,
      false,
      3,
      60,
    ) as AsteroidsInput;
    expect(shipped.turnLeft).toBe(false);
    expect(shipped.turnRight).toBe(false);
    const gentle = toAsteroidsInput(
      aimIntent(-0.05),
      0,
      0.15,
      false,
      3,
      5,
    ) as AsteroidsInput;
    expect(gentle.turnLeft).toBe(true);
    expect(gentle.turnRight).toBe(false);
  });

  it('settles on a static bearing within the tolerance (shipped physics)', () => {
    const DT = 1 / 60;
    const config = {
      thrust: 300,
      maxSpeed: 175,
      friction: 100,
      rotationSpeed: 3,
      rotationAcceleration: 12,
      rotationDeceleration: 60,
    } as unknown as Parameters<AsteroidsModel['tick']>[5];
    const model = new AsteroidsModel();
    const governor = new BotInputGovernor({
      reactionTimeMs: 0,
      alignmentToleranceRad: 0.15,
    });
    const bearing = 1.1;
    const intent = aimIntent(bearing);
    let state = {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      facing: 0,
      angularVelocity: 0,
    };

    for (let i = 0; i < 300; i += 1) {
      const committed = governor.update(intent, DT, {
        scheme: 'asteroids',
        facing: state.facing,
        angularVelocity: state.angularVelocity,
        rotationDeceleration: 60,
        reverseEnabled: false,
      }) as AsteroidsInput;
      state = model.tick(
        state,
        committed,
        DT,
        960,
        540,
        config,
      ) as typeof state;
    }

    const settledError = Math.abs(
      Math.atan2(
        Math.sin(bearing - state.facing),
        Math.cos(bearing - state.facing),
      ),
    );
    expect(settledError).toBeLessThanOrEqual(0.15 + 1e-6);
    // It actually came to rest (no residual spin).
    expect(Math.abs(state.angularVelocity)).toBeLessThan(1e-3);
  });
});

// ── Skill aim error (AH-0MV1DUSM2005HL98 · AC3) ─────────────────────

describe('BotInputGovernor — skill aim error (AH-0MV1DUSM2005HL98 AC3)', () => {
  /** A precise aim intent at `bearing`. */
  function aimIntent(bearing: number) {
    return {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
      thrust: false,
      aim: true,
    };
  }

  /** The bearing of the governor's committed aim intent. */
  function committedBearing(governor: BotInputGovernor): number {
    const intent = governor.currentIntent();
    return Math.atan2(intent.dirY ?? 0, intent.dirX ?? 0);
  }

  it('is exactly zero at skill = 1 (no draw, no change)', () => {
    const bearing = 0.5;
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, skill: 1, maxAimErrorRad: 0.5 },
      7,
    );
    for (let i = 0; i < 6; i += 1) {
      governor.update(aimIntent(bearing), 1 / 60, {
        scheme: 'asteroids',
        facing: 0,
      });
      expect(committedBearing(governor)).toBeCloseTo(bearing, 12);
    }
  });

  it('adds a non-zero error bounded by maxAimErrorRad·(1 - skill)', () => {
    const skill = 0.5;
    const maxAimErrorRad = 0.4;
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, skill, maxAimErrorRad },
      3,
    );
    let maxAbs = 0;
    let sawNonZero = false;
    for (let i = 0; i < 25; i += 1) {
      governor.update(aimIntent(0), 1 / 60, {
        scheme: 'asteroids',
        facing: 0,
      });
      const error = committedBearing(governor);
      maxAbs = Math.max(maxAbs, Math.abs(error));
      if (Math.abs(error) > 1e-9) sawNonZero = true;
    }
    expect(sawNonZero).toBe(true);
    expect(maxAbs).toBeLessThanOrEqual(maxAimErrorRad * (1 - skill) + 1e-9);
  });

  it('is reproducible for a run seed and differs across seeds', () => {
    const run = (seed: number): number[] => {
      const governor = new BotInputGovernor(
        { reactionTimeMs: 0, skill: 0, maxAimErrorRad: 0.4 },
        seed,
      );
      const errors: number[] = [];
      for (let i = 0; i < 8; i += 1) {
        governor.update(aimIntent(0), 1 / 60, {
          scheme: 'asteroids',
          facing: 0,
        });
        errors.push(committedBearing(governor));
      }
      return errors;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });

  it('grows the error monotonically as skill falls', () => {
    const sample = (skill: number): number => {
      const governor = new BotInputGovernor(
        { reactionTimeMs: 0, skill, maxAimErrorRad: 1 },
        9,
      );
      let max = 0;
      for (let i = 0; i < 40; i += 1) {
        governor.update(aimIntent(0), 1 / 60, {
          scheme: 'asteroids',
          facing: 0,
        });
        max = Math.max(max, Math.abs(committedBearing(governor)));
      }
      return max;
    };
    const high = sample(0.8);
    const mid = sample(0.4);
    const low = sample(0);
    expect(mid).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(mid);
  });

  it('never perturbs a non-aim (survival/evade) intent', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, skill: 0, maxAimErrorRad: 0.4 },
      5,
    );
    const evade = {
      ...input('left'),
      dirX: -1,
      dirY: 0,
      thrust: true,
      aim: false,
    };
    for (let i = 0; i < 6; i += 1) {
      governor.update(evade, 1 / 60, { scheme: 'asteroids', facing: 0 });
      expect(governor.currentIntent().dirX).toBe(-1);
      expect(governor.currentIntent().dirY).toBe(0);
    }
  });
});

// ── Adaptive aim error (AH-0MWR057Q8004PBOD · AC4) ───────────────────

describe('BotInputGovernor — adaptive aim error (AH-0MWR057Q8004PBOD AC4)', () => {
  const WORLD = { width: 960, height: 540 };

  /** A precise aim intent at `bearing`, optionally engaging `targetId`. */
  function aimIntent(bearing: number, targetId?: number) {
    const intent = {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
      thrust: false,
      aim: true,
    };
    return targetId === undefined ? intent : { ...intent, targetId };
  }

  /** The bearing of the governor's committed intent. */
  function committedBearing(governor: BotInputGovernor): number {
    const intent = governor.currentIntent();
    return Math.atan2(intent.dirY ?? 0, intent.dirX ?? 0);
  }

  /** Shortest signed angular difference, normalised to (-π, π]. */
  function angleDiff(a: number, b: number): number {
    return Math.atan2(Math.sin(a - b), Math.cos(a - b));
  }

  function contextAt(x: number, y: number) {
    return {
      scheme: 'asteroids' as const,
      facing: 0,
      position: { x, y },
      world: WORLD,
    };
  }

  it('ships documented defaults: aimErrorRad 0.02, aimErrorDecay 0.5, aimErrorResetDistance 60', () => {
    expect(BOT_HUMAN_INPUT_TUNABLES.aimErrorRad).toBeCloseTo(0.02, 12);
    expect(BOT_HUMAN_INPUT_TUNABLES.aimErrorDecay).toBe(0.5);
    expect(BOT_HUMAN_INPUT_TUNABLES.aimErrorResetDistance).toBe(60);
  });

  it('perturbs aim intents that carry a target id, and only those', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4 },
      3,
    );
    let sawNonZero = false;
    for (let i = 0; i < 12; i += 1) {
      governor.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
      const error = committedBearing(governor);
      expect(Math.abs(error)).toBeLessThanOrEqual(0.4 + 1e-9);
      if (Math.abs(error) > 1e-9) sawNonZero = true;
    }
    expect(sawNonZero).toBe(true);

    // An aim intent with no engaged-target identity keeps no adaptive error:
    // there is nothing to compare a confirmed hit against.
    const untargeted = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4 },
      3,
    );
    for (let i = 0; i < 12; i += 1) {
      untargeted.update(aimIntent(0), 1 / 60, contextAt(100, 100));
      expect(committedBearing(untargeted)).toBeCloseTo(0, 12);
    }

    // A non-aim (evade/survival) intent is never perturbed even when it carries
    // an id.
    const evade = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4 },
      3,
    );
    const evadeIntent = {
      ...input('left'),
      dirX: -1,
      dirY: 0,
      thrust: true,
      aim: false,
      targetId: 7,
    };
    for (let i = 0; i < 6; i += 1) {
      evade.update(evadeIntent, 1 / 60, contextAt(100, 100));
      expect(evade.currentIntent().dirX).toBe(-1);
      expect(evade.currentIntent().dirY).toBe(0);
    }
  });

  it('decays by aimErrorDecay on every confirmed hit on the engaged target, floored at 0', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4, aimErrorDecay: 0.5 },
      11,
    );
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.4, 12);

    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);
    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.1, 12);

    // Enough consecutive hits drive the error to (effectively) zero.
    for (let i = 0; i < 40; i += 1) governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeLessThan(1e-6);

    // A decay of 0 floors the error at exactly 0 on the first hit, after
    // which no draw is consumed and the bearing is exact.
    const floored = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4, aimErrorDecay: 0 },
      11,
    );
    floored.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
    floored.noteAimHit(7);
    expect(floored.currentAimErrorRad()).toBe(0);
    floored.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
    expect(committedBearing(floored)).toBeCloseTo(0, 12);
  });

  it('ignores a hit on any enemy other than the engaged target', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4, aimErrorDecay: 0.5 },
      5,
    );
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
    governor.noteAimHit(8);
    governor.noteAimHit(0);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.4, 12);
    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);
  });

  it('restores aimErrorRad after moving aimErrorResetDistance px, torus-aware', () => {
    const governor = new BotInputGovernor(
      {
        reactionTimeMs: 0,
        aimErrorRad: 0.4,
        aimErrorDecay: 0.5,
        aimErrorResetDistance: 60,
      },
      13,
    );
    // Origin at x = 10; a hit decays the error to 0.2.
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(10, 270));
    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);

    // Raw move of 945 px, but only 15 px on the torus: not a reposition.
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(955, 270));
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);

    // A 60 px move across the seam (raw 900 px) is a reposition: restored.
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(910, 270));
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.4, 12);
  });

  it('restores aimErrorRad when the engagement target changes', () => {
    const governor = new BotInputGovernor(
      {
        reactionTimeMs: 0,
        aimErrorRad: 0.4,
        aimErrorDecay: 0.5,
        aimErrorResetDistance: 1000,
      },
      17,
    );
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);

    // The same target keeps the decayed error.
    governor.update(aimIntent(0, 7), 1 / 60, contextAt(100, 100));
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);

    // A new target is a fresh aiming problem: the full error comes back.
    governor.update(aimIntent(0, 8), 1 / 60, contextAt(100, 100));
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.4, 12);

    // A late hit for the old target no longer matches.
    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.4, 12);
  });

  it('at aimErrorRad = 0 consumes no draw and leaves the full input stream byte-for-byte unchanged', () => {
    const stream = (targetId: number | undefined): FourDirectionalInput[] => {
      const governor = new BotInputGovernor(
        { reactionTimeMs: 0, skill: 0, maxAimErrorRad: 0.3, aimErrorRad: 0 },
        21,
      );
      const out: FourDirectionalInput[] = [];
      for (let i = 0; i < 20; i += 1) {
        const bearing = 0.2 + (i % 5) * 0.1;
        const decided = governor.update(
          aimIntent(bearing, targetId),
          1 / 60,
          contextAt(100 + i, 270),
        );
        out.push(decided as FourDirectionalInput);
      }
      return out;
    };
    // The engaged-target identity must not change a disabled adaptive error:
    // the adaptive path is off, so the whole stream is identical.
    expect(stream(7)).toEqual(stream(undefined));

    // With both aim errors off the bearing is exactly the requested one.
    const exact = new BotInputGovernor(
      { reactionTimeMs: 0, skill: 1, maxAimErrorRad: 0.3, aimErrorRad: 0 },
      21,
    );
    for (let i = 0; i < 6; i += 1) {
      exact.update(aimIntent(0.4, 7), 1 / 60, contextAt(100, 100));
      expect(committedBearing(exact)).toBeCloseTo(0.4, 12);
    }
  });

  it('is independent of the skill error and composes additively', () => {
    const base = 0.3;
    const run = (config: {
      skill: number;
      maxAimErrorRad: number;
      aimErrorRad: number;
    }): number[] => {
      const governor = new BotInputGovernor(
        { reactionTimeMs: 0, ...config },
        31,
      );
      const bearings: number[] = [];
      for (let i = 0; i < 10; i += 1) {
        governor.update(aimIntent(base, 7), 1 / 60, contextAt(100, 100));
        bearings.push(committedBearing(governor));
      }
      return bearings;
    };

    const skillOnly = run({ skill: 0.5, maxAimErrorRad: 0.4, aimErrorRad: 0 });
    const adaptiveOnly = run({ skill: 1, maxAimErrorRad: 0.4, aimErrorRad: 0.1 });
    const both = run({ skill: 0.5, maxAimErrorRad: 0.4, aimErrorRad: 0.1 });

    for (let i = 0; i < both.length; i += 1) {
      // The combined bearing is the skill-only bearing rotated by exactly the
      // adaptive-only offset: the two errors are drawn independently and
      // compose additively on the bearing.
      const adaptiveOffset = angleDiff(adaptiveOnly[i], base);
      expect(angleDiff(both[i], skillOnly[i])).toBeCloseTo(adaptiveOffset, 12);
      // Each contribution stays within its own bound; the sum within theirs.
      expect(Math.abs(angleDiff(skillOnly[i], base))).toBeLessThanOrEqual(
        0.4 * 0.5 + 1e-9,
      );
      expect(Math.abs(adaptiveOffset)).toBeLessThanOrEqual(0.1 + 1e-9);
      expect(Math.abs(angleDiff(both[i], base))).toBeLessThanOrEqual(
        0.4 * 0.5 + 0.1 + 1e-9,
      );
    }
  });

  it('is deterministic per run seed and differs across seeds', () => {
    const run = (seed: number): Array<number | undefined> => {
      const governor = new BotInputGovernor(
        { reactionTimeMs: 0, aimErrorRad: 0.3, aimErrorDecay: 0.5 },
        seed,
      );
      const timeline: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        governor.update(aimIntent(0.1 * i, 7), 1 / 60, contextAt(100, 100));
        if (i % 3 === 0) governor.noteAimHit(7);
        timeline.push(governor.currentAimErrorRad(), committedBearing(governor));
      }
      return timeline;
    };
    expect(run(42)).toEqual(run(42));
    expect(run(42)).not.toEqual(run(43));
  });
});

// ── Smooth turning (AH-0MWJ1680Z001QYV2 audit rejection) ────────────

describe('smooth turning — deadband, hysteresis and flip hold (AH-0MWJ1680Z001QYV2 audit rejection)', () => {
  /** A precise steering intent aimed at `bearing` (thrusting by default). */
  function intentAt(bearing: number, thrust = true) {
    return {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
      thrust,
    };
  }

  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
      reverse: false,
    };
  }

  it('ships a wider turning deadband (~9 degrees) so small heading error does not press a turn key', () => {
    expect(BOT_HUMAN_INPUT_TUNABLES.alignmentToleranceRad).toBeGreaterThan(
      0.15,
    );
    // 0.155 rad (~9 degrees) off the bearing: inside the shipped deadband, and
    // outside the old 0.15 rad one — the bot now just flies on.
    expect(toAsteroidsInput(intentAt(-0.155), 0)).toEqual(asteroid('forward'));
    expect(toAsteroidsInput(intentAt(-0.155), 0, 0.15)).toEqual(
      asteroid('turnLeft'),
    );
  });

  it('releases an established turn inside the hysteresis margin instead of braking with the opposite key', () => {
    // A 0.40 rad error (> the 0.30 rad deadband) with the bot already turning
    // right: without hysteresis that would swing to the left key. With the
    // shipped hysteresis the overshoot is allowed to coast out (released).
    const held = toAsteroidsInput(intentAt(-0.4), 0, 0.3, false, 0, 60, {
      turnDirection: 1,
      hysteresisRad: BOT_HUMAN_INPUT_TUNABLES.turnHysteresisRad,
    });
    expect(held.turnLeft).toBe(false);
    expect(held.turnRight).toBe(false);

    // A reversal outside the margin is still commanded.
    const reversing = toAsteroidsInput(intentAt(-0.8), 0, 0.3, false, 0, 60, {
      turnDirection: 1,
      hysteresisRad: BOT_HUMAN_INPUT_TUNABLES.turnHysteresisRad,
    });
    expect(reversing.turnLeft).toBe(true);
    expect(reversing.turnRight).toBe(false);
  });

  it('reduces to the pre-change reversal rule when the hysteresis is zero', () => {
    const out = toAsteroidsInput(intentAt(-0.4), 0, 0.3, false, 0, 60, {
      turnDirection: 1,
      hysteresisRad: 0,
    });
    expect(out.turnLeft).toBe(true);
  });

  it('holds an established turn press for turnPressMinMs so the key does not dither', () => {
    const ticks = 60; // 1 s
    const pressesOver = (...args: ConstructorParameters<typeof BotInputGovernor>) => {
      const governor = new BotInputGovernor(...args);
      let changes = 0;
      let previous = 0;
      for (let i = 0; i < ticks; i += 1) {
        const decision = i % 2 === 0 ? intentAt(Math.PI / 2) : intentAt(-Math.PI / 2);
        const out = governor.update(decision, 1 / 60, {
          scheme: 'asteroids',
          facing: 0,
        }) as AsteroidsInput;
        const direction = out.turnLeft ? -1 : out.turnRight ? 1 : 0;
        if (direction !== 0 && previous !== 0 && direction !== previous) {
          changes += 1;
        }
        if (direction !== 0) previous = direction;
      }
      return changes;
    };

    const free = pressesOver({
      reactionTimeMs: 0,
      turnPressMinMs: 0,
      alignmentToleranceRad: 0.15,
      turnHysteresisRad: 0,
    });
    const held = pressesOver({
      reactionTimeMs: 0,
      turnPressMinMs: 120,
      alignmentToleranceRad: 0.15,
      turnHysteresisRad: 0,
    });
    // Without the hold the key follows every alternating decision (a flip per
    // tick); with it a flip inside the 120 ms press window is released, so the
    // key changes direction far less often over the same second.
    expect(free).toBeGreaterThan(10);
    expect(held).toBeLessThan(free / 3);
  });

  it('finishes a press rather than releasing it inside the window, and never dithers to the opposite key', () => {
    const governor = new BotInputGovernor({
      reactionTimeMs: 0,
      turnPressMinMs: 120,
      alignmentToleranceRad: 0.15,
      turnHysteresisRad: 0,
    });
    const context = { scheme: 'asteroids' as const, facing: 0 };
    // Establish a right turn.
    const turning = governor.update(intentAt(Math.PI / 2), 1 / 60, context) as AsteroidsInput;
    expect(turning.turnRight).toBe(true);
    // The next tick asks for no turn: the press is finished, not released.
    const finishing = governor.update(intentAt(0), 1 / 60, context) as AsteroidsInput;
    expect(finishing.turnRight).toBe(true);
    expect(finishing.turnLeft).toBe(false);
    // A flip request inside the window is released, never dithered.
    const flipping = governor.update(intentAt(-Math.PI / 2), 1 / 60, context) as AsteroidsInput;
    expect(flipping.turnLeft).toBe(false);
    expect(flipping.turnRight).toBe(false);
    // Once the window has expired the live request is followed again.
    let out = flipping;
    for (let i = 0; i < 10; i += 1) {
      out = governor.update(intentAt(-Math.PI / 2), 1 / 60, context) as AsteroidsInput;
    }
    expect(out.turnLeft).toBe(true);
    expect(out.turnRight).toBe(false);
  });
});

// ── Aim damping (AH-0MWT4BBYO0085CN8 · RAC1) ────────────────────────

describe('aim damping — reversal hold and stable aim bias (AH-0MWT4BBYO0085CN8 RAC1)', () => {
  const CONTEXT = { scheme: 'asteroids' as const, facing: 0 };

  /** A precise aim intent at `bearing`, engaged with target `7`. */
  function aimAt(bearing: number) {
    return {
      ...input(),
      dirX: Math.cos(bearing),
      dirY: Math.sin(bearing),
      thrust: false,
      aim: true,
      targetId: 7,
    };
  }

  function turnOf(governor: BotInputGovernor, bearing: number): -1 | 0 | 1 {
    const out = governor.update(aimAt(bearing), 1 / 60, CONTEXT) as AsteroidsInput;
    return out.turnLeft ? -1 : out.turnRight ? 1 : 0;
  }

  it('ships the damping off in the compiled factory defaults', () => {
    // Off in the factory defaults so every pre-existing harness that flies them
    // stays byte-identical; the shipped `Default` preset turns it on (see
    // src/data/bot-tuning.test.ts).
    expect(BOT_HUMAN_INPUT_TUNABLES.aimDampingEnabled).toBe(false);
    expect(BOT_HUMAN_INPUT_TUNABLES.aimTurnHoldMs).toBeGreaterThan(0);
  });

  it('releases, rather than flips, an established aim turn inside aimTurnHoldMs', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimDampingEnabled: true, aimTurnHoldMs: 120 },
      1,
    );
    // Establish a right turn.
    expect(turnOf(governor, Math.PI / 2)).toBe(1);
    // The very next tick asks for the opposite turn: released, not flipped.
    expect(turnOf(governor, -Math.PI / 2)).toBe(0);
    expect(turnOf(governor, -Math.PI / 2)).toBe(0);
    // Once the hold has elapsed the live request is followed again.
    let direction: -1 | 0 | 1 = 0;
    for (let i = 0; i < 10; i += 1) {
      direction = turnOf(governor, -Math.PI / 2);
    }
    expect(direction).toBe(-1);
  });

  it('flips immediately when the damping is off (pre-change behaviour)', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimDampingEnabled: false, aimTurnHoldMs: 120 },
      1,
    );
    expect(turnOf(governor, Math.PI / 2)).toBe(1);
    expect(turnOf(governor, -Math.PI / 2)).toBe(-1);
  });

  it('honours an immediate release inside the hold, so aim precision is kept', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimDampingEnabled: true, aimTurnHoldMs: 120 },
      1,
    );
    expect(turnOf(governor, Math.PI / 2)).toBe(1);
    // The ship is now aligned: the turn key must be released at once, not held
    // for the rest of the window.
    const aligned = governor.update(aimAt(0), 1 / 60, {
      scheme: 'asteroids',
      facing: Math.PI / 2,
    }) as AsteroidsInput;
    expect(aligned.turnLeft).toBe(false);
    expect(aligned.turnRight).toBe(false);
  });

  it('holds the adaptive aim-error angle between commits and redraws it on a hit', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4, aimDampingEnabled: true },
      3,
    );
    const bearing = (): number => {
      const intent = governor.currentIntent();
      return Math.atan2(intent.dirY ?? 0, intent.dirX ?? 0);
    };
    for (let i = 0; i < 5; i += 1) {
      governor.update(aimAt(0), 1 / 60, CONTEXT);
    }
    const held = bearing();
    // Same magnitude, same angle: the error is a bias, not per-reaction jitter.
    for (let i = 0; i < 5; i += 1) {
      governor.update(aimAt(0), 1 / 60, CONTEXT);
      expect(bearing()).toBeCloseTo(held, 12);
    }
    expect(Math.abs(held)).toBeGreaterThan(0);

    // A confirmed hit halves the magnitude and draws a fresh angle.
    governor.noteAimHit(7);
    expect(governor.currentAimErrorRad()).toBeCloseTo(0.2, 12);
    governor.update(aimAt(0), 1 / 60, CONTEXT);
    expect(Math.abs(bearing())).toBeLessThanOrEqual(0.2 + 1e-9);
    const afterHit = bearing();
    governor.update(aimAt(0), 1 / 60, CONTEXT);
    expect(bearing()).toBeCloseTo(afterHit, 12);
  });

  it('redraws the adaptive error every reaction when the damping is off', () => {
    const governor = new BotInputGovernor(
      { reactionTimeMs: 0, aimErrorRad: 0.4, aimDampingEnabled: false },
      3,
    );
    const bearings: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      governor.update(aimAt(0), 1 / 60, CONTEXT);
      const intent = governor.currentIntent();
      bearings.push(Math.atan2(intent.dirY ?? 0, intent.dirX ?? 0));
    }
    expect(new Set(bearings.map((b) => b.toFixed(9))).size).toBeGreaterThan(1);
  });
});
