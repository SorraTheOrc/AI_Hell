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
  type ChoiceContext,
} from '../choice';
import { SLOTS_FULL_EXEMPT_IDS } from '../slots';
import { summariseWeaponLevelChange } from '../../utils/weaponLevels';
import { summarisePowerUpLevelChange } from '../powerUpLevels';
import { buildUpgradeOptions } from '../unlocks';
import { getHelpDescription } from '../../utils/gymHelp';
import { WEAPON_CATALOGUE } from '../../utils/weapons';
import {
  POWER_UP_CATALOGUE,
  WEAPON_DROP_IDS,
  type DropId,
} from '../types';

describe('power-up choice strategy', () => {
  it('offers every drop in the catalogue except the Reset utility (AH-0MVI4KTD8000FBJ7 AC1)', () => {
    // Derived from the catalogues, not a hand-maintained list: a newly shipped
    // power-up or weapon drop can never silently go missing from the
    // hold-full choice again (the stale 21-entry list did exactly that).
    const catalogue = new Set<DropId>([
      ...(Object.keys(POWER_UP_CATALOGUE) as DropId[]),
      ...WEAPON_DROP_IDS,
    ]);
    catalogue.delete('reset');

    expect([...CHOICE_POOL].sort()).toEqual([...catalogue].sort());
    // No duplicate ids: a repeat would double that item's draw weight.
    expect(new Set(CHOICE_POOL).size).toBe(CHOICE_POOL.length);
    // 16 power-ups + 15 weapon drops (every weapon except Reset).
    expect(CHOICE_POOL).toHaveLength(31);
    // The reset utility drop removes weapons rather than granting one.
    expect(CHOICE_POOL).not.toContain('reset');
  });

  describe('newly pooled drops (AH-0MVI4KTD8000FBJ7)', () => {
    /** Power-ups shipped after the original pool was written. */
    const NEW_POWER_UP_IDS = [
      'frenzy',
      'chrono',
      'thorns',
      'salvage',
      'strike',
    ] as const;
    /** Mini-boss-pool weapons shipped after the original pool was written. */
    const NEW_WEAPON_IDS = [
      'rear_guard',
      'broadside',
      'railgun',
      'shard_swarm',
      'heavy_slug',
    ] as const;

    it('AC2 — each newly pooled power-up is offered as a New base option with catalogue copy', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
        powerUpLevels: [],
      });
      for (const id of NEW_POWER_UP_IDS) {
        const option = candidates.find((o) => o.id === id);
        expect(option, id).toBeDefined();
        expect(option!.kind, id).toBe('powerup');
        expect(option!.name, id).toBe(POWER_UP_CATALOGUE[id].name);
        expect(option!.description, id).toBe(getHelpDescription(id));
        // Unowned (empty permanent context) → ★ New badge.
        expect(option!.isNew, id).toBe(true);
      }
    });

    it('AC2 — each newly pooled weapon is offered as a New base option with catalogue copy', () => {
      const expectedNames: Record<(typeof NEW_WEAPON_IDS)[number], string> = {
        rear_guard: 'Rear Guard',
        broadside: 'Broadside',
        railgun: 'Railgun',
        shard_swarm: 'Shard Swarm',
        heavy_slug: 'Heavy Slug',
      };
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
        powerUpLevels: [],
      });
      for (const id of NEW_WEAPON_IDS) {
        const option = candidates.find((o) => o.id === id);
        expect(option, id).toBeDefined();
        expect(option!.kind, id).toBe('weapon');
        expect(option!.name, id).toBe(expectedNames[id]);
        expect(option!.description, id).toBe(getHelpDescription(id));
        expect(option!.isNew, id).toBe(true);
      }
    });

    it('AC3 — an owned new weapon is offered once, as its level-up with a change summary', () => {
      for (const id of NEW_WEAPON_IDS) {
        const candidates = buildChoiceCandidates(CHOICE_POOL, {
          weaponLevels: [{ id, level: 1 }],
        });
        const offers = candidates.filter((o) => o.id === id);
        expect(offers, id).toHaveLength(1);
        expect(offers[0].kind, id).toBe('weapon-level');
        expect(offers[0].level, id).toBe(2);
        expect(offers[0].changeSummary, id).toBe(
          summariseWeaponLevelChange(id, 1, 2),
        );
        expect(offers[0].changeSummary!.length, id).toBeGreaterThan(0);
      }
    });

    it('AC3 — an owned new power-up is offered once, as its level-up with a change summary', () => {
      for (const id of NEW_POWER_UP_IDS) {
        const candidates = buildChoiceCandidates(CHOICE_POOL, {
          powerUpLevels: [{ id, level: 1 }],
        });
        const offers = candidates.filter((o) => o.id === id);
        expect(offers, id).toHaveLength(1);
        expect(offers[0].kind, id).toBe('power-up-level');
        expect(offers[0].level, id).toBe(2);
        expect(offers[0].changeSummary, id).toBe(
          summarisePowerUpLevelChange(id, 1, 2),
        );
        expect(offers[0].changeSummary!.length, id).toBeGreaterThan(0);
      }
    });

    it('AC1 — the default strategy can draw every newly pooled id', () => {
      // Draw one option at a time with a deterministic sweep over the whole
      // candidate list, proving eligibility rather than rarity.
      const strategy = createRandomChoiceStrategy();
      const seen = new Set<string>();
      const candidates = buildChoiceCandidates(CHOICE_POOL, {
        weaponLevels: [],
        powerUpLevels: [],
      });
      for (let i = 0; i < candidates.length; i++) {
        // rng returning i/(n) with count 1 lands on the i-th candidate.
        const pick = strategy.choose(1, () => i / candidates.length)[0];
        seen.add(pick.id);
      }
      for (const id of [...NEW_POWER_UP_IDS, ...NEW_WEAPON_IDS]) {
        expect(seen, id).toContain(id);
      }
    });
  });

  it('includes P10 Mineral Scoop in the hold-full choice pool (AH-0MUPMR9TX00756BQ AC1)', () => {
    expect(CHOICE_POOL).toContain('mineral_scoop');
  });

  it('includes the Smart Bomb in the hold-full choice pool (AH-0MV1BIWP9003EHRQ)', () => {
    expect(CHOICE_POOL).toContain('smart_bomb');
  });

  it('includes the Force Field in the hold-full choice pool (AH-0MV1BIX1W006XF95)', () => {
    expect(CHOICE_POOL).toContain('force_field');
  });

  it('includes the Mystery UFO in the hold-full choice pool (AH-0MV1BIXFO006Z1I7)', () => {
    expect(CHOICE_POOL).toContain('mystery_ufo');
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
      expect(OWNED_UPGRADE_BONUS_WEIGHT).toBe(1.35);
    });

    it('AC1 — owned level-up candidates weigh 1.35×, base-pool candidates 1.0×', () => {
      expect(
        choiceCandidateWeight({
          id: 'spread',
          name: 'Spread Shot Lv.3',
          kind: 'weapon-level',
          level: 3,
        }),
      ).toBe(1.35);
      expect(
        choiceCandidateWeight({
          id: 'shield',
          name: 'Shield Lv.2',
          kind: 'power-up-level',
          level: 2,
        }),
      ).toBe(1.35);
      // Unowned base-pool entries retain 1.0×.
      expect(
        choiceCandidateWeight({ id: 'spread', name: 'Spread Shot', kind: 'weapon' }),
      ).toBe(1);
      expect(
        choiceCandidateWeight({ id: 'shield', name: 'Shield', kind: 'powerup' }),
      ).toBe(1);
    });

    // Candidate set with an owned `spread` level-up and an unowned `dual`
    // base entry, in `buildChoiceCandidates` order: [dual (1.0), spread (1.35)].
    const weightingPool = ['spread', 'dual'] as const;
    const weightingContext = {
      weaponLevels: [{ id: 'spread' as const, level: 1 }],
    };
    const weightingStrategy = createRandomChoiceStrategy(weightingPool);

    it('AC1 — a weighted draw favours the owned upgrade where a uniform draw would not', () => {
      // Total weight 2.35; r = 0.48 → threshold 1.128, which crosses the
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

    it('AC5(b) — 10,000 weighted draws match the 1.35× distribution (±3%)', () => {
      const rng = mulberry32(42);
      let owned = 0;
      let unowned = 0;
      for (let i = 0; i < 10_000; i++) {
        const options = weightingStrategy.choose(1, rng, weightingContext);
        if (options[0].kind === 'weapon-level') owned++;
        else unowned++;
      }
      // Owned upgrade appears 1.35× as often as the single unowned entry.
      const observedRatio = owned / unowned;
      expect(Math.abs(observedRatio / OWNED_UPGRADE_BONUS_WEIGHT - 1)).toBeLessThan(
        0.03,
      );
      // Absolute proportion is also within 3 percentage points of the
      // theoretical 1.35 / 2.35 weighted probability.
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

  describe('option descriptions (AH-0MV2N2591007UGPD)', () => {
    // A context that yields all four option kinds in one candidate list:
    // an owned weapon → `weapon-level`, an owned power-up → `power-up-level`,
    // and every unowned entry → `weapon` / `powerup`.
    const context = {
      weaponLevels: [{ id: 'spread' as const, level: 2 }],
      powerUpLevels: [{ id: 'shield' as const, level: 1 }],
    };

    it('AC1 — populates a non-empty description for all four option kinds', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const kinds = new Set(candidates.map((o) => o.kind));
      expect(kinds).toEqual(
        new Set(['weapon', 'powerup', 'weapon-level', 'power-up-level']),
      );
      for (const option of candidates) {
        expect(option.description, `${option.kind}:${option.id}`).toBeTruthy();
        expect(
          option.description!.trim().length,
          `${option.kind}:${option.id}`,
        ).toBeGreaterThan(0);
      }
    });

    it('AC4 — every description resolves from the shared catalogue (no duplication)', () => {
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      for (const option of candidates) {
        // The shared resolver used by the gym help overlay is the single
        // source of truth for the copy.
        expect(option.description, `${option.kind}:${option.id}`).toBe(
          getHelpDescription(option.id),
        );
      }

      const weaponLevel = candidates.find(
        (o) => o.kind === 'weapon-level' && o.id === 'spread',
      )!;
      expect(weaponLevel.description).toBe(WEAPON_CATALOGUE.spread.description);

      const powerUpLevel = candidates.find(
        (o) => o.kind === 'power-up-level' && o.id === 'shield',
      )!;
      expect(powerUpLevel.description).toBe(
        POWER_UP_CATALOGUE.shield.description,
      );

      const newWeapon = candidates.find(
        (o) => o.kind === 'weapon' && o.id === 'dual',
      )!;
      expect(newWeapon.description).toBe(WEAPON_CATALOGUE.dual.description);
    });

    it('AC3 — catalogue descriptions are level-neutral (no temporary pickup window)', () => {
      // A field pickup's timed window (e.g. "for 10 s") must not leak into
      // the item description, which is also shown for a permanent hold-full
      // reward. Per-level deltas live in `changeSummary` instead.
      const temporaryDuration = /\bfor \d+(?:\.\d+)?\s*s(?:ec(?:onds?)?)?\b/i;
      const entries = [
        ...Object.values(POWER_UP_CATALOGUE),
        ...Object.values(WEAPON_CATALOGUE),
      ];
      for (const entry of entries) {
        expect(entry.description, entry.id).not.toMatch(temporaryDuration);
      }
    });
  });

  describe('shared level-up option model (AH-0MVL9P2SF009QFON AC3)', () => {
    it('the mini-boss reward reuses the hold-full level-up options verbatim', () => {
      // Both surfaces must build their level-up offers through one code path,
      // so the text (level, summary, description) cannot drift.
      const context = {
        weaponLevels: [
          { id: 'rapid' as const, level: 2 },
          { id: 'nova' as const, level: 1 },
        ],
        powerUpLevels: [{ id: 'shield' as const, level: 1 }],
      };
      const holdFull = buildChoiceCandidates(CHOICE_POOL, context).filter(
        (o) => o.kind === 'weapon-level' || o.kind === 'power-up-level',
      );
      expect(buildUpgradeOptions(context)).toEqual(holdFull);
    });
  });

  describe('six-slot choice gating (AH-0MVNT2Z89005OPKJ, parent AC4)', () => {
    // Test-first status (read before editing). The gate on
    // `buildChoiceCandidates` lands in AH-0MVNT2ZXK009Z5VU; this slice pins
    // parent AC4 **before** the gate exists, so every gating assertion below
    // is registered with Vitest's `it.fails(...)` — the repo's
    // red-before/green-after convention (see
    // `src/scenes/core/dropLayer.test.ts`) — which keeps the developer test
    // gate and the dev-push full-suite gate green while the assertions are
    // genuinely red against the ungated builder.
    //
    // When AH-0MVNT2ZXK009Z5VU lands, flip each `.fails` to a plain
    // `it(...)`. Activation is the only permitted edit: the assertions
    // themselves must not change (that is what makes this a contract rather
    // than a wish list).
    //
    // The contexts are hand-built `ChoiceContext`s (no store, no scene, no
    // `Math.random()`): six distinct permanently-owned kinds fill the shared
    // pool exactly, as the AC demands.

    /**
     * Six distinct permanently-owned kinds — three power-ups and three
     * weapons — filling the shared six-slot pool exactly. The mixed build
     * covers **both** demand sides of AC4.
     */
    const FULL_SLOT_CONTEXT: ChoiceContext = {
      weaponLevels: [
        { id: 'spread', level: 1 },
        { id: 'dual', level: 1 },
        { id: 'rapid', level: 1 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 1 },
        { id: 'bomb', level: 1 },
        { id: 'speed_boost', level: 1 },
      ],
    };

    /**
     * Six permanently-owned weapon kinds only: the weapon-heavy extreme of
     * the shared pool (weapons consume power-up slots too — producer Q1
     * answer (c)). Only the two available-when-full power-ups may still be
     * offered as new picks.
     */
    const FULL_WEAPON_CONTEXT: ChoiceContext = {
      weaponLevels: [
        { id: 'spread', level: 1 },
        { id: 'dual', level: 1 },
        { id: 'rapid', level: 1 },
        { id: 'wave_laser', level: 1 },
        { id: 'ricochet', level: 1 },
        { id: 'cluster', level: 1 },
      ],
      powerUpLevels: [],
    };

    /** The distinct permanently-owned kinds a hand-built context carries. */
    function ownedIdsOf(context: ChoiceContext): Set<DropId> {
      const owned = new Set<DropId>();
      for (const { id } of context.weaponLevels ?? []) owned.add(id as DropId);
      for (const { id } of context.powerUpLevels ?? []) owned.add(id as DropId);
      return owned;
    }

    /**
     * The ids the gated pool may still offer once full: the owned kinds plus
     * the catalogue entries flagged `availableWhenSlotsFull`.
     */
    function allowedAtFull(context: ChoiceContext): Set<DropId> {
      return new Set<DropId>([
        ...ownedIdsOf(context),
        ...SLOTS_FULL_EXEMPT_IDS,
      ]);
    }

    /** Deterministic LCG (Numerical Recipes constants) — no Math.random. */
    function makeSeededRng(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
      };
    }

    it.fails('at six filled slots never offers a base pick outside the owned kinds and the exempt entries', () => {
      // AC4 core: once the pool is full, a brand-new non-exempt kind must
      // never be offered — this is what would create a seventh permanent kind.
      for (const context of [FULL_SLOT_CONTEXT, FULL_WEAPON_CONTEXT]) {
        const allowed = allowedAtFull(context);
        const candidates = buildChoiceCandidates(CHOICE_POOL, context);
        for (const option of candidates) {
          if (option.kind === 'powerup' || option.kind === 'weapon') {
            expect(allowed.has(option.id), `${option.id} is neither owned nor available-when-full`).toBe(true);
          }
        }
      }
    });

    it.fails('at six filled slots the only base offers are the available-when-full entries', () => {
      // Owned kinds are suppressed as base entries and offered as level-ups
      // (pre-existing ownership semantics), so everything that survives as a
      // base pick must be one of the flagged entries. Exact set, both a mixed
      // and a weapon-only full build.
      for (const context of [FULL_SLOT_CONTEXT, FULL_WEAPON_CONTEXT]) {
        const baseIds = buildChoiceCandidates(CHOICE_POOL, context)
          .filter((o) => o.kind === 'powerup' || o.kind === 'weapon')
          .map((o) => o.id)
          .sort();
        expect(baseIds).toEqual([...SLOTS_FULL_EXEMPT_IDS].sort());
      }
    });

    it.fails('a strategy draw at six filled slots never returns a non-exempt, non-owned id', () => {
      // End to end through the shipped strategy seam: 500 seeded weighted
      // draws of three options must stay inside the gated pool.
      const context = FULL_SLOT_CONTEXT;
      const allowed = allowedAtFull(context);
      const rng = makeSeededRng(20261025);
      for (let i = 0; i < 500; i++) {
        const options = randomChoiceStrategy.choose(3, rng, context);
        expect(options).toHaveLength(3);
        for (const option of options) {
          expect(allowed.has(option.id)).toBe(true);
        }
      }
    });

    it('keeps a level-up offer for every owned kind once the six slots are full', () => {
      // AC4's graceful degradation: the pool never degrades to nothing — the
      // level-up offers of the six owned kinds survive the gate intact (both
      // weapon-level and power-up-level offers).
      const context = FULL_SLOT_CONTEXT;
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const levelUpIds = candidates
        .filter((o) => o.kind === 'weapon-level' || o.kind === 'power-up-level')
        .map((o) => o.id)
        .sort();
      expect(levelUpIds).toEqual([...ownedIdsOf(context)].sort());
      // Six owned offers plus the exempt entries: never an empty result.
      expect(candidates.length).toBeGreaterThanOrEqual(6);
    });

    it('leaves the candidate pool unchanged below the cap (five filled slots)', () => {
      // AC3-style no-behaviour-change guard for the choice side: with fewer
      // than six slots the gate is inert, so the full catalogue stays on
      // offer (minus the owned base entries, which are suppressed as level-up
      // offers — pre-existing semantics).
      const context: ChoiceContext = {
        weaponLevels: [
          { id: 'spread', level: 1 },
          { id: 'dual', level: 1 },
        ],
        powerUpLevels: [
          { id: 'shield', level: 1 },
          { id: 'bomb', level: 1 },
          { id: 'speed_boost', level: 1 },
        ],
      };
      const candidates = buildChoiceCandidates(CHOICE_POOL, context);
      const baseIds = candidates
        .filter((o) => o.kind === 'powerup' || o.kind === 'weapon')
        .map((o) => o.id);
      expect(baseIds).toHaveLength(CHOICE_POOL.length - 5);
      const offeredIds = candidates.map((o) => o.id);
      for (const id of CHOICE_POOL) {
        expect(offeredIds).toContain(id);
      }
    });
  });
});
