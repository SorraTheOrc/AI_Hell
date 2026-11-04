/**
 * Unit tests for the hold-full description wrapper
 * (AH-0MVBLBSG3002WHBI · AC1/AC3/AC7).
 *
 * Pure and deterministic: no Phaser, no canvas metrics. Each case asserts
 * observable output of the public `wrapChoiceDescription` API.
 */

import { describe, expect, it } from 'vitest';

import {
  CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
  CHOICE_DESCRIPTION_MAX_LINES,
  wrapChoiceDescription,
} from './choiceDescriptionWrap';

describe('wrapChoiceDescription', () => {
  it('keeps a short description on a single line', () => {
    const result = wrapChoiceDescription(
      'Adds a 3-bullet fan (−30°/0°/+30°).',
    );

    expect(result.lines).toEqual(['Adds a 3-bullet fan (−30°/0°/+30°).']);
    expect(result.truncated).toBe(false);
  });

  it('wraps a long catalogue description onto two lines without losing content', () => {
    // The longest description in the shared catalogue (Mystery UFO, 190
    // characters after the single-use Teleport copy was shortened by parent
    // AH-0MVY096RT006QMF4); it must fit the two-line area without truncation
    // (AC1).
    const copy =
      'A rare collector drone hoovers up minerals and carries them home. One charge spawns one drone; charges regenerate on a level-derived timer, and a hold-full reward adds a charge, not a level.';
    expect(copy.length).toBeGreaterThan(
      CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
    );

    const result = wrapChoiceDescription(copy);

    expect(result.lines).toHaveLength(2);
    expect(result.truncated).toBe(false);
    for (const line of result.lines) {
      expect(line.length).toBeLessThanOrEqual(
        CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
      );
    }
    // Every word of the copy survives the wrap, in order.
    expect(result.lines.join(' ')).toBe(copy);
  });

  it('truncates copy longer than two lines with an ellipsis', () => {
    const copy = Array.from(
      { length: 80 },
      (_, index) => `word${index}`,
    ).join(' ');

    const result = wrapChoiceDescription(copy);

    expect(result.lines).toHaveLength(CHOICE_DESCRIPTION_MAX_LINES);
    expect(result.truncated).toBe(true);
    expect(result.lines[CHOICE_DESCRIPTION_MAX_LINES - 1].endsWith('…')).toBe(
      true,
    );
    for (const line of result.lines) {
      expect(line.length).toBeLessThanOrEqual(
        CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
      );
    }
  });

  it('breaks an unbreakable word that is wider than a whole line', () => {
    const result = wrapChoiceDescription('x'.repeat(250));

    expect(result.lines).toHaveLength(CHOICE_DESCRIPTION_MAX_LINES);
    expect(result.truncated).toBe(true);
    for (const line of result.lines) {
      expect(line.length).toBeLessThanOrEqual(
        CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE,
      );
    }
  });

  it('collapses whitespace and returns no lines for empty copy', () => {
    expect(wrapChoiceDescription('   ').lines).toEqual([]);
    expect(wrapChoiceDescription('  Spread \n  Shot  ').lines).toEqual([
      'Spread Shot',
    ]);
  });

  it('honours an explicit line budget (used by the layout contract)', () => {
    const result = wrapChoiceDescription('one two three four', 6, 2);
    expect(result.lines).toEqual(['one', 'two…']);
    expect(result.truncated).toBe(true);
  });
});
