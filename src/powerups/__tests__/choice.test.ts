/**
 * Power-up choice strategy tests (AH-0MUBVGI62004ED9Q).
 *
 * Test-first task defining the contract for parent AC4/AC5: a pluggable
 * strategy supplies the offered options; the default draws distinct entries
 * from the full drop pool; swapping the strategy needs no caller change;
 * below three entries it degrades gracefully.
 */

import { describe, expect, it } from 'vitest';

import {
  CHOICE_POOL,
  ChoiceStrategy,
  OWNED_UPGRADE_BONUS_WEIGHT,
  buildChoiceCandidates,
  choiceCandidateWeight,
  chooseOptions,
  createRandomChoiceStrategy,
  isWeaponOption,
  randomChoiceStrategy,
} from '../choice';
import { summariseWeaponLevelChange } from '../../utils/weaponLevels';
import { summarisePowerUpLevelChange } from '../powerUpLevels';

describe('power-up choice strategy', () => {
  it('offers the full drop pool: P3–P10 plus the collectable weapon drops', () => {
    expect([...CHOICE_POOL].sort()).toEqual(
      [
        'shield',
        'bomb',
        'speed_boost',
        'phase_shift',
        'teleport',
        'extra_life',
        'magnet',
        'mineral_scoop',
        'dual',
        'rapid',
        'spread',
        'wave_laser',
        'ricochet',
        'cluster',
        'options',
        'nova',
        'mortar',
        'arc',
      ].sort(),
    );
    // The reset utility drop is not a power-up choice.
    expect(CHOICE_POOL).not.toContain('reset');
  });

  it('includes P10 Mineral Scoop in the hold-full choice pool (AH-0MUPMR9TX00756BQ AC1)', () => {
    expect(CHOICE_POOL).toContain('mineral_scoop');
  });

  it('the default strategy offers three distinct options from the pool', () => {
    const options = randomChoiceStrategy.choose(3);
    expect(options).toHaveLength(3);
    const ids = options.map((o) => o.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(CHOICE_POOL).toContain(id);
  });

  it('every draw yields distinct options across many random draws', () => {
    for (let i = 0; i < 200; i++) {
      const ids = randomChoiceStrategy.choose(3).map((o) => o.id);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(CHOICE_POOL).toContain(id);
    }
  });

  it('describes each option with a name and kind', () => {
    const options = randomChoiceStrategy.choose(3);
    for (const option of options) {
      expect(option.name.length).toBeGreaterThan(0);
      expect(['powerup', 'weapon']).toContain(option.kind);
      expect(isWeaponOption(option)).toBe(option.kind === 'weapon');
    }
  });

  it('degrades gracefully when the pool has fewer than the requested count', () => {
    const strategy = createRandomChoiceStrategy(['shield', 'bomb']);
    const options = strategy.choose(3);
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.id).sort()).toEqual(['bomb', 'shield']);
  });

  it('degrades to zero options for an empty pool', () => {
    expect(createRandomChoiceStrategy([]).choose(3)).toEqual([]);
  });

  it('selects deterministically with an injected rng', () => {
    const strategy = createRandomChoiceStrategy(['shield', 'bomb', 'speed_boost']);
    const options = strategy.choose(1, () => 0);
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('shield');
  });

  it('swapping the strategy needs no change to the caller', () => {
    const fixed: ChoiceStrategy = {
      choose: () => [
        { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
        { id: 'speed_boost', name: 'Speed Boost', kind: 'powerup' },
        { id: 'magnet', name: 'Magnet', kind: 'powerup' },
      ],
    };
    const options = chooseOptions(3, fixed);
    expect(options.map((o) => o.id)).toEqual(['spread', 'speed_boost', 'magnet']);
  });

  describe('weapon level-up offers (AH-0MUPOVYZU0073OUV)', () => {
    const context = {
      weaponLevels: [
        { id: 'spread' as const, level: 2 },
        { id: 'rapid' as const, level: 1 },
        { id: 'cannon' as const, level: 0 },
      ],
    };

    it('adds a level-up offer for each owned weapon, reflecting its level (AC1/AC2/AC4)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const levelUps = candidates.filter((o) => o.kind === 'weapon-level');
      expect(levelUps.map((o) => o.id).sort()).toEqual(['rapid', 'spread']);

      const spread = levelUps.find((o) => o.id === 'spread')!;
      expect(spread.level).toBe(3);
      expect(spread.name).toContain('Lv.3');
      const rapid = levelUps.find((o) => o.id === 'rapid')!;
      expect(rapid.level).toBe(2);
    });

    it('ignores unowned/level-0 weapons and the cannon (AC5)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [{ id: 'cannon', level: 0 }],
      });
      expect(candidates.some((o) => o.kind === 'weapon-level')).toBe(false);
    });

    it('keeps the base pool unchanged when the player owns no weapons (AC5)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, { weaponLevels: [] });
      expect(candidates.map((o) => o.id).sort()).toEqual([...CHOICE_POOL].sort());
      expect(candidates.every((o) => o.kind !== 'weapon-level')).toBe(true);
    });

    it('still offers exactly three distinct options with contextual level-ups (AC6)', () => {
      const options = createRandomChoiceStrategy().choose(3, () => 0.5, context);
      expect(options).toHaveLength(3);
      expect(new Set(options.map((o) => `${o.kind}:${o.id}`)).size).toBe(3);
    });
  });

  describe('upgrade change summary & New badge (AH-0MUU1GOAU007RFVR)', () => {
    it('populates changeSummary for weapon-level offers', () => {
      const context = {
        weaponLevels: [{ id: 'spread' as const, level: 2 }],
      };
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const levelUp = candidates.find(
        (o) => o.kind === 'weapon-level' && o.id === 'spread',
      );
      expect(levelUp).toBeDefined();
      expect(levelUp!.changeSummary).toBeDefined();
      expect(levelUp!.changeSummary!.length).toBeGreaterThan(0);
      // The summary is derived from the shared resolver.
      expect(levelUp!.changeSummary).toBe(
        summariseWeaponLevelChange('spread', 2, 3),
      );
    });

    it('marks base-pool weapons as New when the player does not own them', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
      });
      const spread = candidates.find((o) => o.id === 'spread');
      expect(spread).toBeDefined();
      expect(spread!.isNew).toBe(true);
      const rapid = candidates.find((o) => o.id === 'rapid');
      expect(rapid!.isNew).toBe(true);
    });

    it('suppresses the base-pool weapon entry once owned, leaving only the level-up offer (AC1)', () => {
      const context = { weaponLevels: [{ id: 'spread' as const, level: 1 }] };
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      // No base-pool `weapon` entry for the owned id …
      expect(
        candidates.some((o) => o.id === 'spread' && o.kind === 'weapon'),
      ).toBe(false);
      // … only the correctly-labelled level-up offer.
      const spread = candidates.find((o) => o.id === 'spread');
      expect(spread).toBeDefined();
      expect(spread!.kind).toBe('weapon-level');
      expect(spread!.level).toBe(2);
      expect(spread!.isNew).toBeUndefined();
    });

    it('power-up options have no isNew or changeSummary from base candidates', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, { weaponLevels: [] });
      const powerUps = candidates.filter((o) => o.kind === 'powerup');
      for (const pu of powerUps) {
        expect(pu.isNew).toBeUndefined();
        expect(pu.changeSummary).toBeUndefined();
      }
    });
  });

  describe('power-up level-up offers (AH-0MUU2QJE2007JNR6 AC6)', () => {
    const context = {
      powerUpLevels: [
        { id: 'shield' as const, level: 2 },
        { id: 'magnet' as const, level: 1 },
      ],
    };

    it('adds a level-up offer for each owned power-up, reflecting its level', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const levelUps = candidates.filter((o) => o.kind === 'power-up-level');
      expect(levelUps.map((o) => o.id).sort()).toEqual(['magnet', 'shield']);

      const p3 = levelUps.find((o) => o.id === 'shield')!;
      expect(p3.level).toBe(3);
      expect(p3.name).toContain('Lv.3');
      const p9 = levelUps.find((o) => o.id === 'magnet')!;
      expect(p9.level).toBe(2);
    });

    it('derives the change summary from the shared power-up resolver', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const p3 = candidates.find(
        (o) => o.kind === 'power-up-level' && o.id === 'shield',
      )!;
      expect(p3.changeSummary).toBe(summarisePowerUpLevelChange('shield', 2, 3));
      expect(p3.changeSummary!.length).toBeGreaterThan(0);
    });

    it('marks base-pool power-ups as New when ownership is known and unowned', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        powerUpLevels: [],
      });
      const p5 = candidates.find((o) => o.kind === 'powerup' && o.id === 'speed_boost');
      expect(p5).toBeDefined();
      expect(p5!.isNew).toBe(true);
    });

    it('suppresses the base-pool power-up entry once owned, leaving only the level-up offer (AC2)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        powerUpLevels: [{ id: 'speed_boost' as const, level: 1 }],
      });
      expect(
        candidates.some((o) => o.kind === 'powerup' && o.id === 'speed_boost'),
      ).toBe(false);
      const levelUp = candidates.find((o) => o.id === 'speed_boost');
      expect(levelUp).toBeDefined();
      expect(levelUp!.kind).toBe('power-up-level');
      expect(levelUp!.level).toBe(2);
      expect(levelUp!.isNew).toBeUndefined();
    });

    it('keeps the base pool unchanged when no power-up context is supplied', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, { weaponLevels: [] });
      expect(candidates.some((o) => o.kind === 'power-up-level')).toBe(false);
      for (const pu of candidates.filter((o) => o.kind === 'powerup')) {
        expect(pu.isNew).toBeUndefined();
      }
    });

    it('still offers distinct options with contextual power-up level-ups', () => {
      const options = createRandomChoiceStrategy().choose(3, () => 0.5, context);
      expect(options).toHaveLength(3);
      expect(new Set(options.map((o) => `${o.kind}:${o.id}`)).size).toBe(3);
    });
  });

  describe('permanent-level-only choice context (AH-0MUX802450085VZZ, F1 contract)', () => {
    it('treats an item absent from the permanent context as New (field-only not owned)', () => {
      // A field pickup adds only a temporary stack, so it never appears in
      // the permanent context supplied by `getPowerUpLevels()` /
      // `getWeaponLevels()`. The choice must therefore still offer it as a
      // New base entry with no level-up.
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
        powerUpLevels: [],
      });
      const p3 = candidates.find((o) => o.id === 'shield')!;
      expect(p3.kind).toBe('powerup');
      expect(p3.isNew).toBe(true);
      expect(candidates.some((o) => o.kind === 'power-up-level')).toBe(false);
      expect(candidates.some((o) => o.kind === 'weapon-level')).toBe(false);
    });

    it('offers a level-up only for an item present at permanent level ≥ 1', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
        powerUpLevels: [{ id: 'shield', level: 1 }],
      });
      const p3 = candidates.find((o) => o.id === 'shield')!;
      expect(p3.kind).toBe('power-up-level');
      expect(p3.level).toBe(2);
      expect(p3.isNew).toBeUndefined();
    });
  });

  describe('owned-item de-duplication (AH-0MUVRACE9001WVT2)', () => {
    it('never lists a base and a level-up entry for the same weapon id (AC1)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [
          { id: 'spread' as const, level: 2 },
          { id: 'rapid' as const, level: 1 },
        ],
      });
      const ids = candidates.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      // The owned weapons appear exactly once each, as level-up offers.
      expect(candidates.filter((o) => o.id === 'spread')).toHaveLength(1);
      expect(candidates.filter((o) => o.id === 'rapid')).toHaveLength(1);
    });

    it('never lists a base and a level-up entry for the same power-up id (AC2)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        powerUpLevels: [
          { id: 'shield' as const, level: 1 },
          { id: 'magnet' as const, level: 4 },
        ],
      });
      const ids = candidates.map((o) => o.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(candidates.filter((o) => o.id === 'shield')).toHaveLength(1);
      expect(candidates.filter((o) => o.id === 'magnet')).toHaveLength(1);
    });

    it('keeps an unowned weapon offered exactly once as a New base entry (AC1)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [{ id: 'spread' as const, level: 1 }],
      });
      const dual = candidates.filter((o) => o.id === 'dual');
      expect(dual).toHaveLength(1);
      expect(dual[0].kind).toBe('weapon');
      expect(dual[0].isNew).toBe(true);
    });

    it('keeps an unowned power-up offered exactly once as a New base entry (AC2)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        powerUpLevels: [{ id: 'speed_boost' as const, level: 1 }],
      });
      const p6 = candidates.filter((o) => o.id === 'phase_shift');
      expect(p6).toHaveLength(1);
      expect(p6[0].kind).toBe('powerup');
      expect(p6[0].isNew).toBe(true);
    });

    it('leaves the full base pool intact when nothing is owned (AC1/AC2)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
        powerUpLevels: [],
      });
      expect(candidates.map((o) => o.id).sort()).toEqual([...CHOICE_POOL].sort());
      expect(candidates.every((o) => o.isNew === true)).toBe(true);
    });

    it('a default-strategy draw with a real context never offers two options for the same item (AC4)', () => {
      const context = {
        weaponLevels: [
          { id: 'spread' as const, level: 2 },
          { id: 'dual' as const, level: 1 },
        ],
        powerUpLevels: [
          { id: 'speed_boost' as const, level: 3 },
          { id: 'magnet' as const, level: 1 },
        ],
      };
      for (let i = 0; i < 200; i++) {
        const options = randomChoiceStrategy.choose(3, Math.random, context);
        const ids = options.map((o) => o.id);
        // A duplicate id would mean the same underlying item was offered
        // twice (base + level-up), which is exactly the reported bug.
        expect(new Set(ids).size).toBe(ids.length);
      }
    });
  });

  describe('owned-upgrade weighting (AH-0MUY47W62005FF74)', () => {
    /**
     * Deterministic 32-bit PRNG (mulberry32). A seeded generator keeps the
     * 10,000-trial distribution test reproducible — no flaky CI — while still
     * exercising the weighted draw end to end.
     */
    function mulberry32(seed: number): () => number {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it('AC4 — the bonus weight is a single named constant', () => {
      expect(OWNED_UPGRADE_BONUS_WEIGHT).toBe(1.1);
    });

    it('AC1 — owned level-up candidates weigh 1.1×, base-pool candidates 1.0×', () => {
      expect(
        choiceCandidateWeight({
          id: 'spread',
          name: 'Spread Shot Lv.3',
          kind: 'weapon-level',
          level: 3,
        }),
      ).toBe(1.1);
      expect(
        choiceCandidateWeight({
          id: 'shield',
          name: 'Shield Lv.2',
          kind: 'power-up-level',
          level: 2,
        }),
      ).toBe(1.1);
      // Unowned base-pool entries retain 1.0×.
      expect(
        choiceCandidateWeight({ id: 'spread', name: 'Spread Shot', kind: 'weapon' }),
      ).toBe(1);
      expect(
        choiceCandidateWeight({ id: 'shield', name: 'Shield', kind: 'powerup' }),
      ).toBe(1);
    });

    // Candidate set with an owned `spread` level-up and an unowned `dual`
    // base entry, in `buildChoiceCandidates` order: [dual (1.0), spread (1.1)].
    const weightingPool = ['spread', 'dual'] as const;
    const weightingContext = {
      weaponLevels: [{ id: 'spread' as const, level: 1 }],
    };
    const weightingStrategy = createRandomChoiceStrategy(weightingPool);

    it('AC1 — a weighted draw favours the owned upgrade where a uniform draw would not', () => {
      // Total weight 2.1; r = 0.48 → threshold 1.008, which crosses the
      // unowned 1.0 weight and lands on the owned level-up. A uniform draw
      // (total 2.0) at the same r has threshold 0.96 and would pick `dual`.
      const owned = weightingStrategy.choose(1, () => 0.48, weightingContext);
      expect(owned[0].kind).toBe('weapon-level');
      expect(owned[0].id).toBe('spread');

      // Below the unowned weight the base entry is still selected.
      const unowned = weightingStrategy.choose(1, () => 0.4, weightingContext);
      expect(unowned[0].kind).toBe('weapon');
      expect(unowned[0].id).toBe('dual');
    });

    it('AC5(b) — 10,000 weighted draws match the 1.1× distribution (±3%)', () => {
      const rng = mulberry32(42);
      let owned = 0;
      let unowned = 0;
      for (let i = 0; i < 10_000; i++) {
        const options = weightingStrategy.choose(1, rng, weightingContext);
        if (options[0].kind === 'weapon-level') owned++;
        else unowned++;
      }
      // Owned upgrade appears 1.1× as often as the single unowned entry.
      const observedRatio = owned / unowned;
      expect(Math.abs(observedRatio / OWNED_UPGRADE_BONUS_WEIGHT - 1)).toBeLessThan(
        0.03,
      );
      // Absolute proportion is also within 3 percentage points of the
      // theoretical 1.1 / 2.1 weighted probability.
      const observedProbability = owned / 10_000;
      const expectedProbability = OWNED_UPGRADE_BONUS_WEIGHT / (1 + OWNED_UPGRADE_BONUS_WEIGHT);
      expect(Math.abs(observedProbability - expectedProbability)).toBeLessThan(0.03);
    });

    it('AC5(b) — without any owned items the draw stays effectively uniform', () => {
      const rng = mulberry32(7);
      const counts = new Map<string, number>();
      const strategy = createRandomChoiceStrategy(['shield', 'bomb', 'magnet']);
      for (let i = 0; i < 10_000; i++) {
        const id = strategy.choose(1, rng)[0].id;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      for (const count of counts.values()) {
        expect(Math.abs(count / 10_000 - 1 / 3)).toBeLessThan(0.03);
      }
    });
  });
});
