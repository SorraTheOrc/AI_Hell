/**
 * Unit tests for the pure Euclidean rhythm module (AH-0MVYA1VHT004L2O0).
 *
 * Covers:
 * - Canonical patterns `E(3,8)`, `E(5,8)`, `E(2,5)` (up to the documented
 *   rotation convention)
 * - Maximal evenness (every cyclic gap is `floor(n/k)` or `ceil(n/k)`) and
 *   complement symmetry (`E(n-k,n)` is `E(k,n)`'s non-onset set up to rotation)
 * - Rotation equivalence: rotating shifts the onsets, rotation 0 roots at 0,
 *   and every rotation is the same rhythm class
 * - Edge cases: `k = 0`, `k = n`, `k > n`, `n = 1` and invalid input
 * - Determinism: identical output for identical input, no `Date`/`Math.random`
 * - Grid helpers emit exact ticks of the shared `src/utils/beat.ts` lattice
 *   (16th notes, 187.5 ms at the default 80 BPM)
 */

import { describe, expect, test } from 'vitest';

import {
  DEFAULT_BPM,
  SIXTEENTH_NOTE_SUBDIVISIONS,
  beatSubdivisionMs,
  isOnGrid,
  nextTick,
  shotTimeFor,
} from './beat';
import {
  EUCLID_STEP_SUBDIVISIONS,
  euclidPattern,
  euclidStepMs,
  isOnset,
  nextOnsetDelayMs,
  nextOnsetTick,
  stepIndexAt,
} from './euclid';

/** One step of the shared 16th-note lattice at 80 BPM: 187.5 ms. */
const STEP_MS = euclidStepMs();

/** Renders an onset set as the conventional `x..x..x.` rhythm string. */
function patternString(onsets: readonly number[], steps: number): string {
  const cells = new Array<string>(steps).fill('.');
  for (const onset of onsets) cells[onset] = 'x';
  return cells.join('');
}

/** Shifts every onset by `rotation` steps, wrapped into `[0, steps)`. */
function rotateOnsets(
  onsets: readonly number[],
  rotation: number,
  steps: number,
): number[] {
  return onsets
    .map((onset) => (((onset + rotation) % steps) + steps) % steps)
    .sort((a, b) => a - b);
}

/** Gap lengths between successive onsets, wrapping over the tile boundary. */
function cyclicGaps(onsets: readonly number[], steps: number): number[] {
  return onsets.map((onset, index) => {
    const next = index === onsets.length - 1 ? onsets[0] + steps : onsets[index + 1];
    return next - onset;
  });
}

/**
 * Rotation-independent identity of a rhythm: its lexicographically smallest
 * rotation. Two onset sets describe the same rhythm class exactly when this
 * string matches, which is how canonical examples are compared.
 */
function rhythmClass(onsets: readonly number[], steps: number): string {
  if (onsets.length === 0) return '';
  let smallest = patternString(onsets, steps);
  for (let rotation = 1; rotation < steps; rotation += 1) {
    const candidate = patternString(rotateOnsets(onsets, rotation, steps), steps);
    if (candidate < smallest) smallest = candidate;
  }
  return smallest;
}

describe('euclidPattern — canonical Euclidean rhythms (AC1)', () => {
  test('E(3,8) is the canonical x..x..x.', () => {
    const pattern = euclidPattern(3, 8);

    expect(pattern.onsets).toEqual([0, 3, 6]);
    expect(patternString(pattern.onsets, 8)).toBe('x..x..x.');
    expect(pattern.k).toBe(3);
    expect(pattern.n).toBe(8);
    expect(pattern.rotation).toBe(0);
  });

  test('E(2,5) is the canonical x.x..', () => {
    const pattern = euclidPattern(2, 5);

    expect(pattern.onsets).toEqual([0, 2]);
    expect(patternString(pattern.onsets, 5)).toBe('x.x..');
  });

  test('E(5,8) is the canonical x.xx.x.x up to rotation', () => {
    const pattern = euclidPattern(5, 8);

    // Same rhythm class as the published cinquillo spelling x.xx.x.x.
    expect(rhythmClass(pattern.onsets, 8)).toBe(rhythmClass([0, 2, 3, 5, 7], 8));
    // Documented rotation convention: the shipped root starts on step 0, which
    // is the published spelling rotated by five steps.
    expect(patternString(pattern.onsets, 8)).toBe('x.xx.xx.');
    expect(rotateOnsets(pattern.onsets, 5, 8)).toEqual([0, 2, 3, 5, 7]);
  });

  test('straight rhythms (k divides n) are evenly spaced onsets', () => {
    expect(patternString(euclidPattern(4, 8).onsets, 8)).toBe('x.x.x.x.');
    expect(patternString(euclidPattern(2, 8).onsets, 8)).toBe('x...x...');
    expect(patternString(euclidPattern(16, 16).onsets, 16)).toBe('xxxxxxxxxxxxxxxx');
  });
});

describe('euclidPattern — maximal evenness (AC2)', () => {
  test('every cyclic gap is floor(n/k) or ceil(n/k) across the lattice sweep', () => {
    for (let steps = 1; steps <= 16; steps += 1) {
      for (let pulses = 1; pulses < steps; pulses += 1) {
        const gaps = cyclicGaps(euclidPattern(pulses, steps).onsets, steps);
        const smallest = Math.floor(steps / pulses);
        const largest = Math.ceil(steps / pulses);

        expect(
          gaps.every((gap) => gap === smallest || gap === largest),
          `E(${pulses},${steps}) gaps ${gaps.join(',')}`,
        ).toBe(true);
      }
    }
  });

  test('an irregular rhythm really does mix the two gap lengths', () => {
    const gaps = cyclicGaps(euclidPattern(5, 8).onsets, 8);

    expect(new Set(gaps)).toEqual(new Set([1, 2]));
  });

  test('onsets are strictly ascending whole steps inside the tile', () => {
    for (let steps = 1; steps <= 16; steps += 1) {
      for (let pulses = 0; pulses <= steps; pulses += 1) {
        const { onsets } = euclidPattern(pulses, steps);

        expect(onsets).toHaveLength(pulses);
        expect(new Set(onsets).size).toBe(pulses);
        onsets.forEach((onset, index) => {
          expect(Number.isInteger(onset)).toBe(true);
          expect(onset).toBeGreaterThanOrEqual(0);
          expect(onset).toBeLessThan(steps);
          if (index > 0) expect(onset).toBeGreaterThan(onsets[index - 1]);
        });
      }
    }
  });
});

describe('euclidPattern — complement symmetry (AC3)', () => {
  test('the non-onset set of E(k,n) is E(n-k,n) up to rotation', () => {
    for (let steps = 2; steps <= 16; steps += 1) {
      for (let pulses = 0; pulses <= steps; pulses += 1) {
        const onsets = euclidPattern(pulses, steps).onsets;
        const complement: number[] = [];
        for (let step = 0; step < steps; step += 1) {
          if (!onsets.includes(step)) complement.push(step);
        }

        expect(
          rhythmClass(complement, steps),
          `complement of E(${pulses},${steps})`,
        ).toBe(rhythmClass(euclidPattern(steps - pulses, steps).onsets, steps));
      }
    }
  });

  test('E(5,8) is the complement of E(3,8)', () => {
    const onsets = euclidPattern(3, 8).onsets;
    const complement: number[] = [];
    for (let step = 0; step < 8; step += 1) {
      if (!onsets.includes(step)) complement.push(step);
    }

    expect(complement).toEqual([1, 2, 4, 5, 7]);
    expect(rhythmClass(complement, 8)).toBe(
      rhythmClass(euclidPattern(5, 8).onsets, 8),
    );
  });
});

describe('euclidPattern — rotation (AC4)', () => {
  test('rotation 0 roots the pattern at step 0', () => {
    for (let steps = 1; steps <= 16; steps += 1) {
      for (let pulses = 1; pulses <= steps; pulses += 1) {
        expect(euclidPattern(pulses, steps).onsets[0]).toBe(0);
      }
    }
  });

  test('rotation r shifts every onset by r steps (mod n)', () => {
    for (const [pulses, steps] of [
      [3, 8],
      [5, 8],
      [9, 16],
      [2, 16],
    ]) {
      const root = euclidPattern(pulses, steps).onsets;
      for (let rotation = 0; rotation < steps; rotation += 1) {
        expect(euclidPattern(pulses, steps, rotation).onsets).toEqual(
          rotateOnsets(root, rotation, steps),
        );
      }
    }
  });

  test('rotation is normalised mod n, including negative and out-of-range values', () => {
    const root = euclidPattern(3, 8).onsets;

    expect(euclidPattern(3, 8, 8).onsets).toEqual(root);
    expect(euclidPattern(3, 8, 0).onsets).toEqual(root);
    expect(euclidPattern(3, 8, 9).onsets).toEqual(euclidPattern(3, 8, 1).onsets);
    expect(euclidPattern(3, 8, -1).onsets).toEqual(euclidPattern(3, 8, 7).onsets);
    expect(euclidPattern(3, 8, -9).onsets).toEqual(euclidPattern(3, 8, 7).onsets);
    expect(euclidPattern(3, 8, -1).rotation).toBe(7);
  });

  test('every rotation of a pattern is the same rhythm class', () => {
    for (const [pulses, steps] of [
      [3, 8],
      [5, 8],
      [7, 16],
      [9, 16],
    ]) {
      const root = euclidPattern(pulses, steps).onsets;
      for (let rotation = 1; rotation < steps; rotation += 1) {
        expect(rhythmClass(euclidPattern(pulses, steps, rotation).onsets, steps)).toBe(
          rhythmClass(root, steps),
        );
      }
    }
  });
});

describe('euclidPattern — edge cases (AC5)', () => {
  test('k = 0 is the empty rhythm', () => {
    expect(euclidPattern(0, 5).onsets).toEqual([]);
    expect(euclidPattern(0, 1).onsets).toEqual([]);
    expect(euclidPattern(0, 16, 3).onsets).toEqual([]);
  });

  test('k = n is every step in the tile', () => {
    expect(euclidPattern(8, 8).onsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(euclidPattern(1, 1).onsets).toEqual([0]);
  });

  test('k > n clamps to n (all onsets)', () => {
    expect(euclidPattern(12, 8).onsets).toEqual(euclidPattern(8, 8).onsets);
    expect(euclidPattern(12, 8).k).toBe(8);
  });

  test('n = 1 collapses to a single-step rhythm', () => {
    expect(euclidPattern(1, 1).onsets).toEqual([0]);
    expect(euclidPattern(0, 1).onsets).toEqual([]);
  });

  test('fractional inputs truncate to whole steps', () => {
    expect(euclidPattern(3.9, 8.9).onsets).toEqual(euclidPattern(3, 8).onsets);
  });

  test('invalid input degrades to an empty single-step rhythm', () => {
    for (const [pulses, steps] of [
      [Number.NaN, 8],
      [Number.POSITIVE_INFINITY, 8],
      [3, Number.NaN],
      [3, Number.POSITIVE_INFINITY],
      [3, 0],
      [3, -4],
      [-3, 8],
    ]) {
      const pattern = euclidPattern(pulses, steps);

      expect(pattern.onsets).toEqual([]);
      expect(pattern.k).toBe(0);
      expect(pattern.n).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('euclidPattern — determinism (AC6)', () => {
  test('identical input always produces identical output', () => {
    const first = euclidPattern(7, 16, 3);
    const second = euclidPattern(7, 16, 3);

    expect(second).toEqual(first);
    expect(second.onsets).not.toBe(first.onsets);
  });

  test('interleaved calls do not affect each other (no hidden state)', () => {
    const expected = euclidPattern(5, 8, 2).onsets;

    euclidPattern(3, 16, 1);
    euclidPattern(16, 16, 0);
    euclidPattern(0, 4, 0);

    expect(euclidPattern(5, 8, 2).onsets).toEqual(expected);
  });

  test('reads no RNG and no wall clock', () => {
    const originalRandom = Math.random;
    const originalNow = Date.now;
    Math.random = () => {
      throw new Error('euclidPattern must not use Math.random');
    };
    Date.now = () => {
      throw new Error('euclidPattern must not read the wall clock');
    };

    try {
      const first = euclidPattern(9, 16, 4);
      const second = euclidPattern(9, 16, 4);

      expect(first.onsets).toEqual(second.onsets);
      expect(first.onsets).toHaveLength(9);
    } finally {
      Math.random = originalRandom;
      Date.now = originalNow;
    }
  });
});

describe('euclidStepMs — the shared 16th-note lattice (AC8)', () => {
  test('is derived from beat.ts, not a second lattice definition', () => {
    expect(EUCLID_STEP_SUBDIVISIONS).toBe(SIXTEENTH_NOTE_SUBDIVISIONS);
    expect(euclidStepMs()).toBe(
      beatSubdivisionMs(SIXTEENTH_NOTE_SUBDIVISIONS),
    );
    expect(euclidStepMs()).toBe(187.5);
  });

  test('scales with the tempo and falls back to the default BPM', () => {
    expect(euclidStepMs(160)).toBe(93.75);
    expect(euclidStepMs(40)).toBe(375);
    expect(euclidStepMs(0)).toBe(euclidStepMs(DEFAULT_BPM));
    expect(euclidStepMs(Number.NaN)).toBe(euclidStepMs(DEFAULT_BPM));
  });
});

describe('stepIndexAt — lattice step indexing (AC7)', () => {
  test('a tick is its own step index', () => {
    for (let index = 0; index < 16; index += 1) {
      expect(stepIndexAt(index * STEP_MS, STEP_MS)).toBe(index);
    }
  });

  test('a time between ticks belongs to the step it is inside', () => {
    expect(stepIndexAt(2.5 * STEP_MS, STEP_MS)).toBe(2);
    expect(stepIndexAt(2.999 * STEP_MS, STEP_MS)).toBe(2);
    expect(stepIndexAt(3.001 * STEP_MS, STEP_MS)).toBe(3);
  });

  test('respects the anchor and floors before it', () => {
    const anchorMs = 1000;

    expect(stepIndexAt(anchorMs + 3 * STEP_MS, STEP_MS, anchorMs)).toBe(3);
    expect(stepIndexAt(anchorMs + 3.5 * STEP_MS, STEP_MS, anchorMs)).toBe(3);
    expect(stepIndexAt(anchorMs - STEP_MS, STEP_MS, anchorMs)).toBe(-1);
  });

  test('agrees with beat.ts shot-time attribution', () => {
    const anchorMs = 250;
    for (let timeMs = -200; timeMs <= 4000; timeMs += 37.3) {
      const tick = shotTimeFor(timeMs, STEP_MS, anchorMs);
      expect(stepIndexAt(timeMs, STEP_MS, anchorMs)).toBe(
        Math.round((tick - anchorMs) / STEP_MS),
      );
    }
  });

  test('an unusable step disables the lattice', () => {
    expect(stepIndexAt(500, 0)).toBe(0);
    expect(stepIndexAt(500, -STEP_MS)).toBe(0);
    expect(stepIndexAt(500, Number.NaN)).toBe(0);
  });
});

describe('isOnset — pattern membership on the lattice (AC7)', () => {
  test('is true on every onset tick and false on the gaps', () => {
    const pattern = euclidPattern(3, 8);

    for (let step = 0; step < 8; step += 1) {
      expect(isOnset(step * STEP_MS, pattern, STEP_MS)).toBe(
        [0, 3, 6].includes(step),
      );
    }
  });

  test('the tile repeats across later bars', () => {
    const pattern = euclidPattern(3, 8);

    for (const tile of [1, 2, 7, 64]) {
      for (const onset of pattern.onsets) {
        expect(isOnset((tile * 8 + onset) * STEP_MS, pattern, STEP_MS)).toBe(true);
      }
      expect(isOnset((tile * 8 + 1) * STEP_MS, pattern, STEP_MS)).toBe(false);
    }
  });

  test('is false between ticks and absorbs floating-point drift on a tick', () => {
    const pattern = euclidPattern(3, 8);
    const onsetTick = 3 * STEP_MS;

    expect(isOnset(onsetTick + 0.5 * STEP_MS, pattern, STEP_MS)).toBe(false);
    expect(isOnset(onsetTick + 1e-9, pattern, STEP_MS)).toBe(true);
    expect(isOnset(onsetTick - 1e-9, pattern, STEP_MS)).toBe(true);
  });

  test('all-onsets patterns fire on every tick, empty patterns never', () => {
    const all = euclidPattern(16, 16);
    const none = euclidPattern(0, 16);

    for (let step = 0; step < 16; step += 1) {
      expect(isOnset(step * STEP_MS, all, STEP_MS)).toBe(true);
      expect(isOnset(step * STEP_MS, none, STEP_MS)).toBe(false);
    }
  });

  test('honours the anchor and the rotation', () => {
    const anchorMs = 750;
    const root = euclidPattern(3, 8);
    const rotated = euclidPattern(3, 8, 2);

    expect(isOnset(anchorMs + 3 * STEP_MS, root, STEP_MS, anchorMs)).toBe(true);
    expect(isOnset(3 * STEP_MS, root, STEP_MS, anchorMs)).toBe(false);
    expect(isOnset(anchorMs + 2 * STEP_MS, rotated, STEP_MS, anchorMs)).toBe(true);
    expect(isOnset(anchorMs + 3 * STEP_MS, rotated, STEP_MS, anchorMs)).toBe(false);
  });

  test('an unusable step is never an onset', () => {
    const pattern = euclidPattern(3, 8);

    expect(isOnset(0, pattern, 0)).toBe(false);
    expect(isOnset(0, pattern, Number.NaN)).toBe(false);
  });
});

describe('nextOnsetTick / nextOnsetDelayMs — scheduling (AC7)', () => {
  test('an onset tick is returned unchanged with a zero delay', () => {
    const pattern = euclidPattern(3, 8);

    for (const onset of pattern.onsets) {
      const tick = onset * STEP_MS;
      expect(nextOnsetTick(tick, pattern, STEP_MS)).toBe(tick);
      expect(nextOnsetDelayMs(tick, pattern, STEP_MS)).toBe(0);
    }
  });

  test('an off-grid time waits for the next onset tick', () => {
    const pattern = euclidPattern(3, 8);
    const timeMs = 1.5 * STEP_MS;

    expect(nextOnsetTick(timeMs, pattern, STEP_MS)).toBe(3 * STEP_MS);
    expect(nextOnsetDelayMs(timeMs, pattern, STEP_MS)).toBeCloseTo(1.5 * STEP_MS, 9);
  });

  test('a non-onset lattice tick skips to the following onset', () => {
    const pattern = euclidPattern(3, 8);

    expect(nextOnsetTick(1 * STEP_MS, pattern, STEP_MS)).toBe(3 * STEP_MS);
    expect(nextOnsetTick(2 * STEP_MS, pattern, STEP_MS)).toBe(3 * STEP_MS);
    expect(nextOnsetTick(7 * STEP_MS, pattern, STEP_MS)).toBe(8 * STEP_MS);
  });

  test('walks the whole tile and wraps into the next one', () => {
    const pattern = euclidPattern(5, 8);
    const expectedOnsets = [0, 2, 3, 5, 6];

    for (let step = 0; step < 8; step += 1) {
      const expectedStep = expectedOnsets.find((onset) => onset >= step) ?? 8;
      expect(nextOnsetTick(step * STEP_MS, pattern, STEP_MS)).toBe(
        expectedStep * STEP_MS,
      );
    }
    expect(nextOnsetTick(7 * STEP_MS, pattern, STEP_MS)).toBe(8 * STEP_MS);
    expect(nextOnsetTick(8 * STEP_MS, pattern, STEP_MS)).toBe(8 * STEP_MS);
    expect(nextOnsetTick(9 * STEP_MS, pattern, STEP_MS)).toBe(10 * STEP_MS);
  });

  test('every scheduled tick is an exact shared-lattice tick', () => {
    const pattern = euclidPattern(7, 16, 3);
    const anchorMs = 500;

    for (let timeMs = anchorMs - 40; timeMs <= 12 * STEP_MS; timeMs += 13.7) {
      const tick = nextOnsetTick(timeMs, pattern, STEP_MS, anchorMs);

      expect(isOnGrid(tick, STEP_MS, anchorMs)).toBe(true);
      expect((tick - anchorMs) / STEP_MS).toBe(Math.round((tick - anchorMs) / STEP_MS));
      expect(tick).toBeGreaterThanOrEqual(timeMs);
    }
  });

  test('the delay is bounded by one tile and never negative', () => {
    const pattern = euclidPattern(5, 8);

    for (let timeMs = 0; timeMs < 5 * 8 * STEP_MS; timeMs += 7.3) {
      const delay = nextOnsetDelayMs(timeMs, pattern, STEP_MS);

      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(8 * STEP_MS);
    }
  });

  test('agrees with beat.ts nextTick for an all-onsets pattern', () => {
    const all = euclidPattern(16, 16);

    for (let timeMs = 0; timeMs < 4 * 16 * STEP_MS; timeMs += 41.9) {
      expect(nextOnsetTick(timeMs, all, STEP_MS)).toBe(nextTick(timeMs, STEP_MS));
    }
  });

  test('honours the anchor and the rotation', () => {
    const anchorMs = 125;
    const rotated = euclidPattern(3, 8, 2);

    expect(nextOnsetTick(anchorMs + 1 * STEP_MS, rotated, STEP_MS, anchorMs)).toBe(
      anchorMs + 2 * STEP_MS,
    );
    expect(nextOnsetTick(anchorMs + 7 * STEP_MS, rotated, STEP_MS, anchorMs)).toBe(
      anchorMs + 8 * STEP_MS,
    );
  });

  test('an empty pattern never schedules another onset', () => {
    const none = euclidPattern(0, 8);

    expect(nextOnsetTick(0, none, STEP_MS)).toBe(Number.POSITIVE_INFINITY);
    expect(nextOnsetDelayMs(0, none, STEP_MS)).toBe(Number.POSITIVE_INFINITY);
  });

  test('an unusable step disables scheduling without running backwards', () => {
    const pattern = euclidPattern(3, 8);
    const timeMs = 321.5;

    expect(nextOnsetTick(timeMs, pattern, 0)).toBe(timeMs);
    expect(nextOnsetTick(timeMs, pattern, Number.NaN)).toBe(timeMs);
    expect(nextOnsetDelayMs(timeMs, pattern, -STEP_MS)).toBe(0);
  });
});
