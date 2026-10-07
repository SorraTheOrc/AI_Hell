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

import type { FourDirectionalInput } from '../utils/movementModel';
import {
  BOT_HUMAN_INPUT_TUNABLES,
  BotInputGovernor,
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
    const copy = governor.current();
    copy.up = false;
    expect(governor.current().up).toBe(true);
  });

  it('defaults to a ~250 ms reaction time and no down key', () => {
    expect(BOT_HUMAN_INPUT_TUNABLES.reactionTimeMs).toBeGreaterThanOrEqual(200);
    expect(BOT_HUMAN_INPUT_TUNABLES.reactionTimeMs).toBeLessThanOrEqual(400);
    expect(BOT_HUMAN_INPUT_TUNABLES.allowDown).toBe(false);
  });
});
