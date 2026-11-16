/**
 * Shared personality combat-mechanics tests (AH-0MWEW50B10089D4W, producer
 * answer Q1 = b — the bounded set of shared mechanics).
 *
 * These pin the **shared combat core's** contract: the capped mechanic set,
 * the two magnitudes, and the per-phase decisions the consumers apply. The
 * gameplay assertions live with the consumers (the hex-boss profile in
 * `src/core/hangarWar/hexBoss.variety.test.ts` and the mini-boss mapping in
 * `src/scenes/gym/GymMiniBoss.test.ts`), because that is where the game and
 * every gym actually run the code.
 */

import { describe, expect, it } from 'vitest';

import {
  HEX_PERSONALITY_MECHANIC_SET,
  NEBULA_PROJECTILE_DRAG,
  SUMMONER_REINFORCEMENTS,
  hexPersonalityMechanicsFor,
  nebulaVolleySpeedScale,
  summonerReinforcementCount,
  summonerReinforcesInPhase,
} from './hexPersonalityMechanics';
import {
  HEX_PERSONALITY_IDS,
  HEX_PERSONALITY_MECHANICS,
} from '../../core/hangarWar/hexRing';

describe('the bounded mechanic set (AC1, Q1 = b)', () => {
  it('is exactly the design’s two reference mechanics', () => {
    expect([...HEX_PERSONALITY_MECHANIC_SET]).toEqual(['nebula', 'summoner']);
    // The core cannot drift from the authored, validated vocabulary.
    expect([...HEX_PERSONALITY_MECHANIC_SET]).toEqual([
      ...HEX_PERSONALITY_MECHANICS,
    ]);
  });

  it('publishes a descriptor only for a mechanic personality', () => {
    expect(hexPersonalityMechanicsFor('nebula')).toHaveLength(1);
    expect(hexPersonalityMechanicsFor('summoner')).toHaveLength(1);
    for (const configTune of ['sentinel', 'berserker', 'tempest'] as const) {
      expect(hexPersonalityMechanicsFor(configTune)).toEqual([]);
    }
    expect(hexPersonalityMechanicsFor(null)).toEqual([]);
    expect(hexPersonalityMechanicsFor(undefined)).toEqual([]);
  });

  it('describes both mechanics with a positive magnitude and a summary', () => {
    for (const personality of HEX_PERSONALITY_MECHANIC_SET) {
      const [mechanic] = hexPersonalityMechanicsFor(personality);
      expect(mechanic.kind === 'projectile-drag' || mechanic.kind === 'reinforcements').toBe(true);
      expect(mechanic.magnitude).toBeGreaterThan(1);
      expect(mechanic.summary).not.toBe('');
    }
  });

  it('stays total for every authored personality id', () => {
    for (const personality of HEX_PERSONALITY_IDS) {
      expect(() => hexPersonalityMechanicsFor(personality)).not.toThrow();
      expect(() => nebulaVolleySpeedScale(personality)).not.toThrow();
      expect(() => summonerReinforcementCount(personality)).not.toThrow();
    }
  });
});

describe('the nebula projectile-drag mechanic', () => {
  it('slows the volley by the published drag factor, and only for nebula', () => {
    const slowed = nebulaVolleySpeedScale('nebula');
    expect(slowed).toBeCloseTo(1 / NEBULA_PROJECTILE_DRAG, 10);
    expect(slowed).toBeLessThan(1);
    expect(nebulaVolleySpeedScale('summoner')).toBe(1);
    expect(nebulaVolleySpeedScale(null)).toBe(1);
  });
});

describe('the summoner reinforcement mechanic', () => {
  it('reinforces every phase for a summoner, and never for anyone else', () => {
    for (const phase of [1, 2, 3, 4]) {
      expect(summonerReinforcesInPhase('summoner', phase)).toBe(true);
      expect(summonerReinforcesInPhase('nebula', phase)).toBe(false);
      expect(summonerReinforcesInPhase(null, phase)).toBe(false);
    }
  });

  it('rejects a phase that is not a positive integer', () => {
    expect(summonerReinforcesInPhase('summoner', 0)).toBe(false);
    expect(summonerReinforcesInPhase('summoner', Number.NaN)).toBe(false);
  });

  it('sizes the reinforcement wave from the published count', () => {
    expect(summonerReinforcementCount('summoner')).toBe(
      SUMMONER_REINFORCEMENTS,
    );
    expect(summonerReinforcementCount('sentinel')).toBe(0);
  });
});
