/**
 * Sequencer per-level archetype variety regression (AH-0MV2SGIX5005PFJT).
 *
 * The shipped campaign is built by the runtime auto-sequencer
 * (`src/core/difficultySequencer.ts`) from a difficulty curve. Before the
 * variety constraint, once a wave's target crossed ~30 the `argmin` over
 * `enemyDifficulty` selected the Phaser (`orbital`) archetype for **every**
 * later wave, collapsing the late game onto one movement style.
 *
 * This is the failing regression for that bug: a curve whose targets all sit
 * above the ~30 switch threshold must not produce all-orbital waves. It is
 * committed as `it.fails` while the fix is pending (child
 * AH-0MV2XDD65009WTJ4) so the suite stays green; that child flips it to a
 * plain `it` once the per-level archetype cap is enforced.
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
import { sequencer, defaultCandidatePool } from './difficultySequencer';

/** A curve whose every target exceeds the ~30 collapse threshold. */
const HIGH_TARGET_CURVE = [30, 40, 50, 60, 70];

describe('sequencer per-level archetype variety (AH-0MV2SGIX5005PFJT)', () => {
  it.fails(
    'does not collapse every above-threshold wave onto the orbital archetype',
    () => {
      const result = sequencer(HIGH_TARGET_CURVE, defaultCandidatePool(), {
        defaultShootEnabled: true,
      });
      expect(result.waves).toHaveLength(HIGH_TARGET_CURVE.length);

      // The regression trigger: the orbital formation must not fill every
      // wave. Pre-fix this is 5 of 5; post-fix the per-level cap leaves it in
      // at most one.
      const orbitalWaves = result.waves.filter((wave) =>
        wave.groups.some((group) => group.formation === 'orbital'),
      );
      expect(orbitalWaves.length).toBeLessThan(result.waves.length);

      // A varied high-target sequence, not one archetype on repeat.
      const archetypes = new Set(
        result.waves.flatMap((wave) =>
          wave.groups.map((group) => group.enemyKey),
        ),
      );
      expect(archetypes.size).toBeGreaterThanOrEqual(3);
    },
  );
});
