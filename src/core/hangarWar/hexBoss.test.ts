/**
 * Hex-boss profile tests (AH-0MVUXCAW0001VUM6).
 *
 * The hex boss must be a **variant** on the shipped boss path, not a second
 * boss: these tests pin the profile it hands the scene (identity, the
 * aggression-perturbed hit pool, the demonstration colour) against the real
 * authored ring data, and pin the total fallbacks for an unknown hex.
 */

import { describe, expect, it } from 'vitest';

import {
  findHexRingDefinition,
  HEX_RING_DEFINITIONS,
} from '../../data/hexRingDefinitions';
import { BULLET_COLORS } from '../../utils/weapons';
import { hexBossHpMultiplier } from './hexDifficulty';
import { buildHexBossProfile, HEX_BOSS_PHASE_COUNT } from './hexBoss';

describe('buildHexBossProfile', () => {
  it('reads the hex identity and its aggression-selected difficulty', () => {
    const definition = findHexRingDefinition('hex-r1-3')!;
    const profile = buildHexBossProfile(
      { id: 'hex-r1-3', aggression: 3 },
      definition,
    );

    expect(profile.hexId).toBe('hex-r1-3');
    expect(profile.bossName).toBe('iron-crusher');
    expect(profile.aggression).toBe(3);
    // Aggression 3 selects campaign level 4 through the shipped mapping.
    expect(profile.startLevel).toBe(4);
    // The hit pool uses the campaign's bounded encounter scaling.
    expect(profile.hpMultiplier).toBe(hexBossHpMultiplier(3));
    expect(profile.difficulty.level).toBe(profile.startLevel);
  });

  it('demonstrates the hex’s granted weapon with that weapon’s colour (Rule 2)', () => {
    const definition = findHexRingDefinition('hex-r1-3')!;
    const profile = buildHexBossProfile(
      { id: 'hex-r1-3', aggression: 3 },
      definition,
    );

    expect(profile.grant).toMatchObject({
      grantId: 'rapid',
      entryId: 'rapid',
      kind: 'weapon',
      weaponId: 'rapid',
    });
    expect(profile.demonstratedColor).toBe(BULLET_COLORS.rapid);
    expect(profile.bodyColor).toBe(BULLET_COLORS.rapid);
    // The final phase reads brighter than the body.
    expect(profile.desperationColor).not.toBe(profile.bodyColor);
  });

  it('retains the shipped boss phase architecture', () => {
    const profile = buildHexBossProfile(
      { id: 'hex-r1-6', aggression: 6 },
      findHexRingDefinition('hex-r1-6'),
    );

    expect(profile.phaseCount).toBe(4);
    expect(profile.phaseCount).toBe(HEX_BOSS_PHASE_COUNT);
  });

  it('leaves the authored pool untouched at aggression 0', () => {
    const profile = buildHexBossProfile(
      { id: 'hex-r1-1', aggression: 0 },
      findHexRingDefinition('hex-r1-1'),
    );

    expect(profile.hpMultiplier).toBe(1);
    expect(profile.startLevel).toBe(1);
  });

  it('is total for an unknown hex: no grant, a deterministic palette colour', () => {
    const first = buildHexBossProfile({ id: 'hex-r9-1', aggression: 2 }, null);
    const second = buildHexBossProfile({ id: 'hex-r9-1', aggression: 2 }, undefined);

    expect(first.bossName).toBeNull();
    expect(first.grant).toBeNull();
    expect(first.demonstratedColor).toBeNull();
    expect(first.bodyColor).toBe(second.bodyColor);
    expect(first.bodyColor).toBeGreaterThan(0);
    expect(first.startLevel).toBe(3);
  });

  it('is total for a malformed hex source', () => {
    const profile = buildHexBossProfile(
      { id: '', aggression: Number.NaN } as unknown as {
        id: string;
        aggression: number;
      },
      findHexRingDefinition('hex-r1-1'),
    );

    expect(profile.hexId).toBe('hex-unknown');
    expect(profile.aggression).toBe(0);
    expect(profile.startLevel).toBe(1);
  });

  it('resolves every authored ring 1 hex without throwing or inventing a grant', () => {
    for (const definition of HEX_RING_DEFINITIONS.filter(
      (entry) => entry.ringIndex === 1,
    )) {
      const profile = buildHexBossProfile(
        { id: definition.id, aggression: definition.baseAggression },
        definition,
      );
      expect(profile.bossName).toBe(definition.boss);
      expect(profile.grant?.grantId).toBe(definition.grants);
      expect(profile.phaseCount).toBe(HEX_BOSS_PHASE_COUNT);
    }
  });
});
