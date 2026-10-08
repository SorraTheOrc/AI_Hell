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
  /** Builds an asteroid input with only the named controls set. */
  function asteroid(
    ...controls: ('forward' | 'turnLeft' | 'turnRight')[]
  ): AsteroidsInput {
    return {
      forward: controls.includes('forward'),
      turnLeft: controls.includes('turnLeft'),
      turnRight: controls.includes('turnRight'),
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

  it('never turns while thrusting and never emits a reverse control', () => {
    for (const facing of [-3, -1.5, 0, 1.5, 3]) {
      for (const intent of [
        input('up'),
        input('down'),
        input('left'),
        input('right'),
      ]) {
        const out = toAsteroidsInput(intent, facing);
        // The asteroid input shape has exactly W/A/D — no reverse field.
        expect(Object.keys(out).sort()).toEqual([
          'forward',
          'turnLeft',
          'turnRight',
        ]);
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
    ).toEqual({ forward: false, turnLeft: false, turnRight: true });
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
    ).toEqual({ forward: false, turnLeft: false, turnRight: false });

    // Inside the reaction window a new "go right" intent is ignored.
    for (let i = 0; i < 4; i += 1) {
      expect(
        governor.update(input('right'), dt, { scheme: 'asteroids', facing: 0 }),
      ).toEqual({ forward: false, turnLeft: false, turnRight: false });
    }

    // At 100 ms the latest intent commits as forward thrust.
    expect(
      governor.update(input('right'), dt, { scheme: 'asteroids', facing: 0 }),
    ).toEqual({ forward: true, turnLeft: false, turnRight: false });
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
    };
  }

  it('re-resolves the held intent against the current facing each tick', () => {
    const governor = new BotInputGovernor({ reactionTimeMs: 1000 });

    // Commit an "aim up" intent while the ship still faces right: turn left.
    expect(
      governor.update(input('up'), 1 / 60, { scheme: 'asteroids', facing: 0 }),
    ).toEqual(asteroid('turnLeft'));

    // Within the same held window the ship has rotated to face up, so the
    // held intent now thrusts forward — closed-loop, not open-loop.
    expect(
      governor.update(input('up'), 1 / 60, {
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
