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
import { BULLET_COLORS, BULLET_SPEED, getWeaponById } from '../../utils/weapons';
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

  it('has no demonstration volley for an upgrade-only hex (Rule 2, non-weapon grant)', () => {
    const upgradeOnly = HEX_RING_DEFINITIONS.find(
      (entry) => entry.ringIndex === 1 && entry.grants === 'hull-2',
    )!;
    const profile = buildHexBossProfile(
      { id: upgradeOnly.id, aggression: upgradeOnly.baseAggression },
      upgradeOnly,
    );

    // The colour cue is still published, but nothing is fired.
    expect(profile.demonstratedColor === null || typeof profile.demonstratedColor === 'number').toBe(true);
    expect(profile.demonstration).toBeNull();
  });

  it('resolves the demonstration volley from the shared weapon catalogue', () => {
    const definition = findHexRingDefinition('hex-r1-3')!;
    const profile = buildHexBossProfile(
      { id: 'hex-r1-3', aggression: definition.baseAggression },
      definition,
    );
    const weapon = getWeaponById('rapid');

    expect(profile.demonstration).not.toBeNull();
    expect(profile.demonstration?.weaponId).toBe('rapid');
    // Pattern, colour and bullet identity come from the one shared catalogue.
    expect(profile.demonstration?.offsets).toEqual([...weapon.offsets]);
    expect(profile.demonstration?.color).toBe(weapon.bulletColor);
    expect(profile.demonstration?.shape).toBe(weapon.bulletShape);
    expect(profile.demonstration?.length).toBe(weapon.bulletShapeLength);
    expect(profile.demonstration?.size).toBe(weapon.bulletSize);
    // A heavier (larger) shot flies slower: the speed is the catalogue share
    // of the shared bullet speed, so a small rapid shot flies faster than a
    // heavy beam.
    expect(profile.demonstration?.speed).toBe(
      Math.round(BULLET_SPEED / weapon.bulletSize),
    );
    expect(profile.demonstration?.speed).toBeGreaterThan(0);
  });

  it('derives a slower demonstration volley for a heavier weapon', () => {
    const heavy = buildHexBossProfile(
      { id: 'hex-r1-6', aggression: 6 },
      findHexRingDefinition('hex-r1-6'),
    );
    const light = buildHexBossProfile(
      { id: 'hex-r1-3', aggression: 3 },
      findHexRingDefinition('hex-r1-3'),
    );

    // wave_laser is the heavy beam, rapid the light spark: the beam is slower.
    expect(heavy.demonstration?.weaponId).toBe('wave_laser');
    expect(light.demonstration?.weaponId).toBe('rapid');
    expect(heavy.demonstration!.speed).toBeLessThan(light.demonstration!.speed);
  });

  it('demonstrates exactly the weapon each authored hex grants', () => {
    for (const definition of HEX_RING_DEFINITIONS) {
      const profile = buildHexBossProfile(
        { id: definition.id, aggression: definition.baseAggression },
        definition,
      );
      if (profile.grant?.weaponId != null) {
        // A weapon grant (the ring's new weapon or a shipped weapon upgrade)
        // is demonstrated with that weapon's own volley.
        expect(profile.demonstration?.weaponId).toBe(profile.grant.weaponId);
        expect(profile.demonstration!.offsets.length).toBeGreaterThan(0);
        expect(profile.demonstration!.offsets).toEqual(
          [...getWeaponById(profile.grant.weaponId).offsets],
        );
      } else {
        // Hull, Extra Life and core-bank hexes grant no weapon: nothing to wield.
        expect(profile.grant?.weaponId ?? null).toBeNull();
        expect(profile.demonstration).toBeNull();
      }
    }
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
