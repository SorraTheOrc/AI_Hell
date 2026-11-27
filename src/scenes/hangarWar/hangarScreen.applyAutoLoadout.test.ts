/**
 * The shared apply-suggested-buildout updater (AH-0MWOWEF3Q008BO5J, parent
 * AH-0MWOROJYT004WPSD).
 *
 * The model publishes the selector's suggestion ({@link
 * buildHangarScreenModel}); this suite pins the one pure updater a scene uses
 * to equip it — exactly what the model published, through the economy's
 * `equipLoadout` path, with no scene-local selection logic and no mutation of
 * the caller's payload.
 */

import { describe, expect, it } from 'vitest';

import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { createRingState } from '../../core/hangarWar/hexRing';
import { VALID_HANGAR_WAR_PAYLOAD } from '../../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import { selectAutoLoadout } from '../../core/hangarWar/hangarAutoLoadout';
import {
  applyAutoLoadout,
  isDefaultHangarLoadout,
  buildHangarScreenModel,
} from './hangarScreen';

/** A deep, detached copy, so purity assertions are meaningful. */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/**
 * The authored ring 1 with every catalogue kind owned and the requested
 * starting-weapon selection. Ring 1's default target is `hex-r1-1` since
 * AH-0MWW28ET2002PNI8 (the sorted-id tie-break between two aggression-1
 * hexes), whose boss does not resist `spread`; a test that needs that matchup
 * passes `targetHexId: 'hex-r1-2'` explicitly — `shroud-merchant` resists
 * `spread` and `wave_laser` counters it.
 */
function ownedPayload(startingWeapons: readonly string[]): HangarWarPayload {
  const payload = clone(VALID_HANGAR_WAR_PAYLOAD);
  payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
  payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3', 'hull-4'];
  payload.hangar.unlockedWeapons = [
    'spread',
    'wave_laser',
    'ricochet',
    'cluster',
  ];
  payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
  payload.hangar.activeHull = 'hull-1';
  payload.hangar.activeLoadout = {
    startingWeapons: [...startingWeapons],
    modifiers: [],
  };
  payload.hangar.bankedMinerals = 0;
  payload.hangar.bankedCores = 0;
  return payload;
}

describe('applyAutoLoadout — the scene equips the published suggestion', () => {
  it("equips exactly the model's suggestion without recomputing a second rule", () => {
    const payload = ownedPayload(['spread']);
    const model = buildHangarScreenModel(payload);
    const result = applyAutoLoadout(payload, HANGAR_CATALOGUE, model.bossIntel);

    // The updater's suggestion is the model's own published suggestion: one
    // selector rule, no second copy in the updater or the scene.
    expect(result.suggestion).toEqual(model.suggestedLoadout);
    expect(result.suggestion).toEqual(
      selectAutoLoadout(payload, model.bossIntel, HANGAR_CATALOGUE),
    );
    expect(result.payload.hangar.activeLoadout.startingWeapons).toEqual(
      model.suggestedLoadout.startingWeapons,
    );
    expect(result.changed).toBe(true);
  });

  it('leaves the chosen modifiers untouched', () => {
    const payload = ownedPayload([]);
    payload.hangar.activeLoadout.modifiers = ['hardened_plating'];
    const result = applyAutoLoadout(payload, HANGAR_CATALOGUE, null);

    expect(result.payload.hangar.activeLoadout.modifiers).toEqual([
      'hardened_plating',
    ]);
  });

  it('never equips a weapon the boss resists', () => {
    const payload = ownedPayload(['spread']);
    // Explicit target: `hex-r1-2` (shroud-merchant) resists `spread`, which the
    // ring-1 default (`hex-r1-1` since AH-0MWW28ET2002PNI8) does not.
    const model = buildHangarScreenModel(payload, HANGAR_CATALOGUE, {
      targetHexId: 'hex-r1-2',
    });
    const result = applyAutoLoadout(payload, HANGAR_CATALOGUE, model.bossIntel);

    expect(model.suggestedLoadout.startingWeapons).not.toContain('spread');
    expect(result.payload.hangar.activeLoadout.startingWeapons).not.toContain(
      'spread',
    );
  });

  it('is pure: the caller payload is never mutated', () => {
    const payload = ownedPayload(['spread']);
    const before = clone(payload);
    const model = buildHangarScreenModel(payload);
    const result = applyAutoLoadout(payload, HANGAR_CATALOGUE, model.bossIntel);

    expect(payload).toEqual(before);
    expect(result.payload).not.toBe(payload);
  });

  it('is idempotent: a second apply reports no change', () => {
    const payload = ownedPayload([]);
    const model = buildHangarScreenModel(payload);
    const first = applyAutoLoadout(payload, HANGAR_CATALOGUE, model.bossIntel);
    const second = applyAutoLoadout(
      first.payload,
      HANGAR_CATALOGUE,
      model.bossIntel,
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.payload.hangar.activeLoadout).toEqual(
      first.payload.hangar.activeLoadout,
    );
  });

  it('reports no change for an already-suggested loadout', () => {
    const payload = ownedPayload([]);
    const model = buildHangarScreenModel(payload);
    const already = applyAutoLoadout(payload, HANGAR_CATALOGUE, model.bossIntel);
    expect(isDefaultHangarLoadout(already.payload)).toBe(false);

    const result = applyAutoLoadout(
      already.payload,
      HANGAR_CATALOGUE,
      model.bossIntel,
    );
    expect(result.changed).toBe(false);
  });
});
