/**
 * Sequencer per-level archetype variety regression (AH-0MV2SGIX5005PFJT).
 *
 * The shipped campaign is built by the runtime auto-sequencer
 * (`src/core/difficultySequencer.ts`) from a difficulty curve. Before the
 * variety constraint, once a wave's target crossed ~30 the `argmin` over
 * `enemyDifficulty` selected the Phaser (`orbital`) archetype for **every**
 * later wave, collapsing the late game onto one movement style.
 *
 * This is the regression for that bug: a curve whose targets all sit above
 * the ~30 switch threshold must not produce all-orbital waves. It was
 * committed as an expected-fail (`it.fails`) while the fix was pending (child
 * AH-0MV2XDD65009WTJ4); that child added the per-level archetype cap and
 * flipped this to a plain `it`.
 *
 * Pre-fix composition for this curve (dev @ 554a4ffd):
 *
 * | target | composition          |
 * |--------|----------------------|
 * | 30     | phaserx12            |
 * | 40     | phaserx12+lane-trafficx4 |
 * | 50     | phaserx12+diverx6    |
 * | 60     | phaserx12+phaserx12  |
 * | 70     | phaserx12+phaserx12+marchx1 |
 *
 * — the `orbital` formation appears in all five waves. Post-fix each
 * archetype is capped per level, so the same curve yields a varied sequence.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_ARCHETYPE_PER_LEVEL,
  sequencer,
  defaultCandidatePool,
  type CandidateGroup,
} from './difficultySequencer';
import {
  auditWaves,
  classifyWaveGroups,
  groupsComposition,
} from './waveBalance';

/** A curve whose every target exceeds the ~30 collapse threshold. */
const HIGH_TARGET_CURVE = [30, 40, 50, 60, 70];

/** True when a wave contains an `orbital`-formation group. */
function hasOrbital(wave: { groups: Array<{ formation: string }> }): boolean {
  return wave.groups.some((group) => group.formation === 'orbital');
}

/** Distinct archetype keys used across a sequencer result. */
function archetypesOf(result: {
  waves: Array<{ groups: Array<{ enemyKey: string }> }>;
}): Set<string> {
  return new Set(
    result.waves.flatMap((wave) => wave.groups.map((group) => group.enemyKey)),
  );
}

describe('sequencer per-level archetype variety (AH-0MV2SGIX5005PFJT)', () => {
  it(
    'does not collapse every above-threshold wave onto the orbital archetype',
    () => {
      const result = sequencer(HIGH_TARGET_CURVE, defaultCandidatePool(), {
        defaultShootEnabled: true,
      });
      expect(result.waves).toHaveLength(HIGH_TARGET_CURVE.length);

      // The regression trigger: the orbital formation must not fill every
      // wave. Pre-fix this is 5 of 5; post-fix the per-level cap leaves it in
      // at most one.
      const orbitalWaves = result.waves.filter(hasOrbital);
      expect(orbitalWaves.length).toBeLessThan(result.waves.length);

      // A varied high-target sequence, not one archetype on repeat.
      expect(archetypesOf(result).size).toBeGreaterThanOrEqual(3);
    },
  );

  it('caps each archetype to at most MAX_ARCHETYPE_PER_LEVEL waves per curve', () => {
    const result = sequencer(HIGH_TARGET_CURVE, defaultCandidatePool(), {
      defaultShootEnabled: true,
    });

    const wavesPerArchetype = new Map<string, number>();
    for (const wave of result.waves) {
      for (const enemyKey of new Set(
        wave.groups.map((group) => group.enemyKey),
      )) {
        wavesPerArchetype.set(
          enemyKey,
          (wavesPerArchetype.get(enemyKey) ?? 0) + 1,
        );
      }
    }
    for (const [enemyKey, count] of wavesPerArchetype) {
      expect(count, enemyKey).toBeLessThanOrEqual(MAX_ARCHETYPE_PER_LEVEL);
    }
  });

  it('exposes the cap as a single tunable constant defaulting to 1', () => {
    expect(MAX_ARCHETYPE_PER_LEVEL).toBe(1);
  });

  it('disables the cap with `maxArchetypePerLevel: Infinity` (pins the pre-fix collapse)', () => {
    // Proves the cap — not some other change — is what varies the sequence:
    // disabling it restores the all-orbital composition.
    const result = sequencer(HIGH_TARGET_CURVE, defaultCandidatePool(), {
      defaultShootEnabled: true,
      maxArchetypePerLevel: Infinity,
    });
    expect(result.waves.every(hasOrbital)).toBe(true);
  });

  it('shares the cap across per-wave calls via `archetypeUsage`', () => {
    // The campaign builder sequences one wave at a time with a shared map;
    // this is the unit-level proof that the cap spans those calls.
    const usage = new Map<string, number>();
    const first = sequencer([30], defaultCandidatePool(), {
      defaultShootEnabled: true,
      archetypeUsage: usage,
    });
    const second = sequencer([40], defaultCandidatePool(), {
      defaultShootEnabled: true,
      archetypeUsage: usage,
    });

    const firstKeys = archetypesOf(first);
    const secondKeys = archetypesOf(second);
    expect(firstKeys.size).toBeGreaterThan(0);
    for (const key of secondKeys) {
      expect(firstKeys.has(key), key).toBe(false);
    }
  });
});

// ── Sequential distinctness constraint (R4, AH-0MVSE6XIO007BXYM) ──────

/** A two-archetype single-group pool (both non-chaser formation movement). */
function twoCandidatePool(): CandidateGroup[] {
  const candidate = (enemyKey: string): CandidateGroup => ({
    enemyKey,
    baseCount: 6,
    minCount: 1,
    maxCount: 60,
    adjustableFields: ['count'],
  });
  return [candidate('scout'), candidate('tank')];
}

/** Composition of the sequencer's only wave. */
function compositionOf(result: { waves: Array<{ groups: Array<{ enemyKey: string }> }> }): string {
  return groupsComposition(result.waves[0].groups);
}

describe('sequential distinctness constraint (R4)', () => {
  it('repeats the predecessor composition when no constraint is supplied (control)', () => {
    // Two calls with identical inputs pick the same error-minimising
    // composition — exactly the repetition R4 exists to prevent.
    const pool = defaultCandidatePool();
    const first = sequencer([40], pool, { defaultShootEnabled: true });
    const second = sequencer([40], pool, { defaultShootEnabled: true });
    expect(compositionOf(second)).toBe(compositionOf(first));
  });

  it('avoids the predecessor composition when it is supplied', () => {
    const pool = defaultCandidatePool();
    const baseline = sequencer([40], pool, { defaultShootEnabled: true });
    const avoided = compositionOf(baseline);

    const constrained = sequencer([40], pool, {
      defaultShootEnabled: true,
      avoidCompositions: [avoided],
    });

    expect(compositionOf(constrained)).not.toBe(avoided);
    expect(constrained.waves[0].groups.length).toBeGreaterThan(0);
    // The alternative still tracks the curve inside the acceptance band.
    expect(constrained.errors[0]).toBeLessThanOrEqual(10);
    // Balance rules keep precedence: the distinct alternative is compliant.
    const audit = auditWaves([
      {
        groups: classifyWaveGroups(constrained.waves[0].groups),
        shootEnabled: constrained.waves[0].shootEnabled,
      },
    ]);
    expect(audit.pass).toBe(true);
  });

  it('falls back deterministically to the next-best eligible candidate', () => {
    const pool = twoCandidatePool();
    const target = 20;
    const options = { defaultShootEnabled: false, allowMultipleGroups: false };
    const baseline = sequencer([target], pool, options);
    const avoided = compositionOf(baseline);
    const expected = avoided === 'scout' ? 'tank' : 'scout';

    const constrained = sequencer([target], pool, {
      ...options,
      avoidCompositions: [avoided],
    });
    expect(compositionOf(constrained)).toBe(expected);
    // Same inputs, same result — no order dependence, no randomness.
    expect(
      sequencer([target], pool, {
        ...options,
        avoidCompositions: [avoided],
      }),
    ).toEqual(constrained);
  });

  it('falls back to the best eligible composition when no alternative exists', () => {
    const pool = twoCandidatePool().slice(0, 1);
    const options = { defaultShootEnabled: false, allowMultipleGroups: false };
    const baseline = sequencer([12], pool, options);
    const only = compositionOf(baseline);

    const constrained = sequencer([12], pool, {
      ...options,
      avoidCompositions: [only],
    });

    // Degenerate input: never throws, never emits an empty wave.
    expect(constrained.waves).toHaveLength(1);
    expect(constrained.waves[0].groups.length).toBeGreaterThan(0);
    expect(compositionOf(constrained)).toBe(only);
  });

  it('does not corrupt the shared archetypeUsage map while trying alternatives', () => {
    const pool = defaultCandidatePool();
    const usage = new Map<string, number>();
    const first = sequencer([40], pool, {
      defaultShootEnabled: true,
      archetypeUsage: usage,
    });
    const avoided = compositionOf(first);
    const before = new Map(usage);

    const constrained = sequencer([40], pool, {
      defaultShootEnabled: true,
      archetypeUsage: usage,
      avoidCompositions: [avoided],
    });
    const used = new Set(
      constrained.waves[0].groups.map((group) => group.enemyKey),
    );

    // Exactly one increment per archetype the chosen wave used, and nothing
    // for the abandoned attempts.
    for (const [enemyKey, count] of usage) {
      expect(count, enemyKey).toBe(
        (before.get(enemyKey) ?? 0) + (used.has(enemyKey) ? 1 : 0),
      );
    }
    for (const enemyKey of used) {
      expect(usage.has(enemyKey), enemyKey).toBe(true);
    }
  });

  it('is inert for an empty avoid list', () => {
    const pool = defaultCandidatePool();
    const plain = sequencer([40], pool, { defaultShootEnabled: true });
    const empty = sequencer([40], pool, {
      defaultShootEnabled: true,
      avoidCompositions: [],
    });
    expect(empty).toEqual(plain);
  });
});
