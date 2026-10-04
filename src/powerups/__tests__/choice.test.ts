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
  buildChoiceCandidates,
  chooseOptions,
  createRandomChoiceStrategy,
  isWeaponOption,
  randomChoiceStrategy,
} from '../choice';

describe('power-up choice strategy', () => {
  it('offers the full drop pool: P3–P9 plus the collectable weapon drops', () => {
    expect([...CHOICE_POOL].sort()).toEqual(
      [
        'P3',
        'P4',
        'P5',
        'P6',
        'P7',
        'P8',
        'P9',
        'dual',
        'rapid',
        'spread',
        'nova',
        'mortar',
        'arc',
      ].sort(),
    );
    // The reset utility drop is not a power-up choice.
    expect(CHOICE_POOL).not.toContain('reset');
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
    const strategy = createRandomChoiceStrategy(['P3', 'P4']);
    const options = strategy.choose(3);
    expect(options).toHaveLength(2);
    expect(options.map((o) => o.id).sort()).toEqual(['P3', 'P4']);
  });

  it('degrades to zero options for an empty pool', () => {
    expect(createRandomChoiceStrategy([]).choose(3)).toEqual([]);
  });

  it('selects deterministically with an injected rng', () => {
    const strategy = createRandomChoiceStrategy(['P3', 'P4', 'P5']);
    const options = strategy.choose(1, () => 0);
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('P3');
  });

  it('swapping the strategy needs no change to the caller', () => {
    const fixed: ChoiceStrategy = {
      choose: () => [
        { id: 'spread', name: 'Spread Shot', kind: 'weapon' },
        { id: 'P5', name: 'Speed Boost', kind: 'powerup' },
        { id: 'P9', name: 'Magnet', kind: 'powerup' },
      ],
    };
    const options = chooseOptions(3, fixed);
    expect(options.map((o) => o.id)).toEqual(['spread', 'P5', 'P9']);
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
});
