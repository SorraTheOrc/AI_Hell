/**
 * Hex variety personality acceptance tests (AH-0MWEW4RVP002LIP4, part of the
 * post-MVP **hex variety** epic AH-0MVWZYQN8007SXIG).
 *
 * Pins epic **AC1/AC4** for the personality axis (Q1 = b):
 *
 * - an authored personality resolves to a **distinct config-tune** through the
 *   shipped hex-boss profile seams (`./hexBoss`) — no second boss or
 *   deployment implementation;
 * - the shared **combat mechanics** stay a bounded set of exactly the design's
 *   two reference mechanics (a projectile-slowing nebula and a
 *   reinforcement-summoning boss), implemented once in the shared combat core
 *   so the game and every gym run identical code;
 * - a personality is **balance-neutral** to the shipped campaign: an
 *   unauthored hex keeps exactly today's profile.
 *
 * These cases were written as `it.fails` red contracts by
 * AH-0MWEW4RVP002LIP4 and flipped to `it` when the personality axis landed
 * (AH-0MWEW50B10089D4W) — they are the axis's acceptance gate.
 */

import { describe, expect, it } from 'vitest';

import { buildHexBossProfile, type HexBossProfile } from './hexBoss';
import {
  HEX_PERSONALITY_IDS,
  HEX_PERSONALITY_MECHANICS,
  type HexPersonalityId,
  type HexRingDefinition,
} from './hexRing';
import { VARIETY_RING_DEFINITIONS } from './__fixtures__/ringFixtures';

/**
 * The sample hex every personality case is applied to: the sample ring's weapon
 * hex, so the demonstrated volley (and therefore every cadence tune) exists.
 */
const SAMPLE_HEX = { id: 'hex-r3-18', aggression: 9 } as const;

/** The sample hex's authored definition. */
function sampleDefinition(): HexRingDefinition {
  const definition = VARIETY_RING_DEFINITIONS.find(
    (candidate) => candidate.id === SAMPLE_HEX.id,
  );
  expect(definition).toBeDefined();
  return definition!;
}

/** The sample definition with `personality` applied. */
function withPersonality(
  personality: HexPersonalityId | undefined,
): HexRingDefinition {
  return { ...sampleDefinition(), personality };
}

/**
 * The comparable tuning signature of a profile: everything a personality is
 * allowed to tune through the shipped seams (difficulty, hit pool and the
 * demonstrated volley). Two personalities that produce the same signature are
 * not variety.
 */
function tuningSignature(profile: HexBossProfile): string {
  return JSON.stringify({
    startLevel: profile.startLevel,
    hpMultiplier: profile.hpMultiplier,
    aggression: profile.aggression,
    demonstration: profile.demonstration,
  });
}

describe('hex variety personality — config-tunes (AC1/AC4, Q1 = b)', () => {
  it('gives every authored personality a distinct config-tune', () => {
    const signatures = HEX_PERSONALITY_IDS.map((personality) =>
      tuningSignature(buildHexBossProfile(SAMPLE_HEX, withPersonality(personality))),
    );
    expect(new Set(signatures).size).toBe(HEX_PERSONALITY_IDS.length);
  });

  it('tunes the encounter through the shipped seams only', () => {
    const baseline = buildHexBossProfile(SAMPLE_HEX, withPersonality(undefined));
    const tuned = HEX_PERSONALITY_IDS.map((personality) =>
      buildHexBossProfile(SAMPLE_HEX, withPersonality(personality)),
    );
    // Every tuned profile keeps the shipped phase architecture and the shipped
    // difficulty profile: a personality perturbs, it never replaces.
    for (const profile of tuned) {
      expect(profile.phaseCount).toBe(baseline.phaseCount);
      expect(profile.hexId).toBe(baseline.hexId);
      expect(profile.difficulty).toBeDefined();
    }
    expect(tuned.some((profile) => profile.hpMultiplier !== baseline.hpMultiplier)).toBe(true);
  });

  it('keeps an unauthored hex exactly at today’s tuning (balance-neutral)', () => {
    const withoutField = buildHexBossProfile(SAMPLE_HEX, sampleDefinition());
    expect(withoutField).toEqual(
      buildHexBossProfile(SAMPLE_HEX, withPersonality(undefined)),
    );
  });

  it('stays total for an unknown personality id', () => {
    const unknown = withPersonality('sneaky' as HexPersonalityId);
    expect(() => buildHexBossProfile(SAMPLE_HEX, unknown)).not.toThrow();
  });
});

describe('hex variety personality — determinism', () => {
  it('resolves the same profile for the same hex on every call', () => {
    for (const personality of HEX_PERSONALITY_IDS) {
      expect(
        buildHexBossProfile(SAMPLE_HEX, withPersonality(personality)),
        `${personality} profile is deterministic`,
      ).toEqual(buildHexBossProfile(SAMPLE_HEX, withPersonality(personality)));
    }
  });
});

describe('hex variety personality — bounded shared mechanics (AC1, Q1 = b)', () => {
  it('caps the shared mechanics at the design’s two reference mechanics', () => {
    expect([...HEX_PERSONALITY_MECHANICS]).toEqual(['nebula', 'summoner']);
  });

  it('implements the nebula projectile-slowing mechanic once in the shared combat core', async () => {
    // Dynamic specifier so this red contract typechecks before the module
    // lands: it rejects until the shared core exports the mechanic.
    const specifier = '../../scenes/core/hexPersonalityMechanics';
    const sharedCore = (await import(specifier)) as {
      NEBULA_PROJECTILE_DRAG?: number;
    };
    expect(sharedCore.NEBULA_PROJECTILE_DRAG).toBeGreaterThan(1);
  });

  it('implements the reinforcement-summoning mechanic once in the shared combat core', async () => {
    const specifier = '../../scenes/core/hexPersonalityMechanics';
    const sharedCore = (await import(specifier)) as {
      SUMMONER_REINFORCEMENTS?: number;
    };
    expect(sharedCore.SUMMONER_REINFORCEMENTS).toBeGreaterThan(0);
  });

  it('publishes the bounded mechanic set the combat gyms drive', async () => {
    // One module path, one set: the game and every combat gym read the same
    // descriptor list, so a mechanic can never be a divergent copy.
    const specifier = '../../scenes/core/hexPersonalityMechanics';
    const sharedCore = (await import(specifier)) as {
      HEX_PERSONALITY_MECHANIC_SET?: readonly string[];
    };
    expect([...(sharedCore.HEX_PERSONALITY_MECHANIC_SET ?? [])]).toEqual([
      ...HEX_PERSONALITY_MECHANICS,
    ]);
  });
});
