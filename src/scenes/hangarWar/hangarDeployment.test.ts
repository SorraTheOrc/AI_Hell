/**
 * Hangar-war deployment launch-data tests (AH-0MVUXC2DD003HN0I).
 *
 * A deployment is pure data: the hangar-resolved loadout, the target hex's
 * aggression-selected campaign level and a deterministic seed. These tests
 * pin the resolution rules (weakest unheld hex, aggression → level, hull +
 * modifier lives) and the defensive launch-data guard that keeps a malformed
 * payload from turning the arcade run into something else.
 */

import { describe, expect, it, vi } from 'vitest';

import { MAX_LIVES, MAX_LEVEL } from '../../core/GameState';
import { VALID_HANGAR_WAR_PAYLOAD } from '../../core/hangarWar/fixtures';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import {
  HANGAR_WAR_DEPLOYMENT_KIND,
  applyHangarWarDeployment,
  applyHullSpeedToShipConfig,
  buildHangarDeployment,
  deploymentLevelForAggression,
  readHangarWarDeployment,
  selectDeploymentHex,
} from './hangarDeployment';
import { loadShipConfig } from '../../core/config';

/** Deep, detached copy of a fixture payload. */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/**
 * A war with a fielded fleet (hull-2 + plating, two starting weapons) and two
 * unheld hexes of different aggression, so every resolution rule is exercised.
 */
function fieldedPayload(): HangarWarPayload {
  const payload = clone(VALID_HANGAR_WAR_PAYLOAD);
  return {
    ...payload,
    hangar: {
      ...payload.hangar,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread', 'wave_laser'],
      ownedModifiers: ['hardened_plating'],
      activeHull: 'hull-2',
      activeLoadout: {
        startingWeapons: ['spread', 'wave_laser'],
        modifiers: ['hardened_plating'],
      },
    },
    ring: {
      ringIndex: 1,
      hexes: [
        {
          id: 'hex-held',
          q: 1,
          r: 0,
          held: true,
          aggression: 0,
          defender: null,
          bossDefeated: true,
          grantedWeapon: 'waveLaser',
        },
        {
          id: 'hex-easy',
          q: 0,
          r: 1,
          held: false,
          aggression: 2,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
        {
          id: 'hex-hard',
          q: -1,
          r: 0,
          held: false,
          aggression: 8,
          defender: null,
          bossDefeated: false,
          grantedWeapon: 'ricochet',
        },
      ],
    },
  };
}

describe('deploymentLevelForAggression (AH-0MVUXC2DD003HN0I)', () => {
  it('maps aggression 0 to the shipped opening level', () => {
    expect(deploymentLevelForAggression(0)).toBe(1);
  });

  it('advances one campaign level per point of aggression', () => {
    expect(deploymentLevelForAggression(1)).toBe(2);
    expect(deploymentLevelForAggression(3)).toBe(4);
    expect(deploymentLevelForAggression(5)).toBe(6);
  });

  it('clamps at the campaign maximum', () => {
    expect(deploymentLevelForAggression(MAX_LEVEL)).toBe(MAX_LEVEL);
    expect(deploymentLevelForAggression(MAX_LEVEL + 99)).toBe(MAX_LEVEL);
  });

  it('is total for negative, fractional and non-finite aggression', () => {
    expect(deploymentLevelForAggression(-5)).toBe(1);
    expect(deploymentLevelForAggression(3.9)).toBe(4);
    expect(deploymentLevelForAggression(Number.NaN)).toBe(1);
    expect(deploymentLevelForAggression(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('selectDeploymentHex (AH-0MVUXC2DD003HN0I)', () => {
  it('picks the weakest unheld hex by default', () => {
    expect(selectDeploymentHex(fieldedPayload())?.id).toBe('hex-easy');
  });

  it('never picks a held hex while an unheld one remains, even if it is calmer', () => {
    const payload = fieldedPayload();
    // hex-held has aggression 0 and is the calmest hex overall.
    expect(selectDeploymentHex(payload)?.id).not.toBe('hex-held');
  });

  it('honours an explicitly requested hex', () => {
    expect(selectDeploymentHex(fieldedPayload(), 'hex-hard')?.id).toBe('hex-hard');
  });

  it('falls back to the weakest hex of the ring when every hex is held', () => {
    const payload = fieldedPayload();
    payload.ring.hexes = payload.ring.hexes.map((hex) => ({ ...hex, held: true }));
    expect(selectDeploymentHex(payload)?.id).toBe('hex-held');
  });

  it('returns null for a ring with no hexes', () => {
    expect(selectDeploymentHex(createDefaultPayload(1))).toBeNull();
  });

  it('ignores an unknown requested hex id', () => {
    expect(selectDeploymentHex(fieldedPayload(), 'no-such-hex')?.id).toBe('hex-easy');
  });
});

describe('buildHangarDeployment (AH-0MVUXC2DD003HN0I)', () => {
  it('builds the minimal starting kit for a fresh war', () => {
    const deployment = buildHangarDeployment(createDefaultPayload(7));
    expect(deployment.kind).toBe(HANGAR_WAR_DEPLOYMENT_KIND);
    expect(deployment.hexId).toBeNull();
    expect(deployment.aggression).toBe(0);
    expect(deployment.startLevel).toBe(1);
    expect(deployment.hullId).toBe('hull-1');
    expect(deployment.startingLives).toBe(3);
    expect(deployment.speedMultiplier).toBe(1);
    expect(deployment.startingWeapons).toEqual(['spread']);
    expect(deployment.modifiers).toEqual([]);
  });

  it('resolves the hangar loadout: active hull stats, starting weapons and modifiers', () => {
    const deployment = buildHangarDeployment(fieldedPayload());
    expect(deployment.hexId).toBe('hex-easy');
    expect(deployment.aggression).toBe(2);
    expect(deployment.startLevel).toBe(3);
    expect(deployment.hullId).toBe('hull-2');
    // Bulwark Hull: 4 lives, 0.85× speed; Hardened Plating adds one life.
    expect(deployment.startingLives).toBe(5);
    expect(deployment.speedMultiplier).toBe(0.85);
    expect(deployment.startingWeapons).toEqual(['spread', 'wave_laser']);
    expect(deployment.modifiers).toEqual(['hardened_plating']);
  });

  it('caps the hull + modifier lives at the run maximum', () => {
    const payload = fieldedPayload();
    payload.hangar.activeHull = 'hull-2';
    // Two copies of the modifier cannot be owned, but a corrupt save can list
    // the id twice; the cap keeps the deployment inside the shipped maximum.
    payload.hangar.activeLoadout.modifiers = [
      'hardened_plating',
      'hardened_plating',
    ];
    expect(buildHangarDeployment(payload).startingLives).toBe(MAX_LIVES);
  });

  it('selects the difficulty from an explicitly requested hex', () => {
    const deployment = buildHangarDeployment(fieldedPayload(), {
      hexId: 'hex-hard',
    });
    expect(deployment.hexId).toBe('hex-hard');
    expect(deployment.aggression).toBe(8);
    // Aggression 8 selects the ninth campaign level (1 + aggression).
    expect(deployment.startLevel).toBe(9);
  });

  it('derives the same seed for the same war and target', () => {
    const first = buildHangarDeployment(fieldedPayload());
    const second = buildHangarDeployment(fieldedPayload());
    expect(second.seed).toBe(first.seed);
    expect(Number.isInteger(first.seed)).toBe(true);
    expect(first.seed).toBeGreaterThanOrEqual(0);
  });

  it('derives a different seed per target aggression', () => {
    const easy = buildHangarDeployment(fieldedPayload(), { hexId: 'hex-easy' });
    const hard = buildHangarDeployment(fieldedPayload(), { hexId: 'hex-hard' });
    expect(hard.seed).not.toBe(easy.seed);
  });

  it('honours an explicit seed override (tests and replay)', () => {
    const deployment = buildHangarDeployment(fieldedPayload(), { seed: 4242 });
    expect(deployment.seed).toBe(4242);
  });

  it('never mutates the payload it resolves from', () => {
    const payload = fieldedPayload();
    const before = JSON.stringify(payload);
    buildHangarDeployment(payload);
    expect(JSON.stringify(payload)).toBe(before);
  });
});

describe('readHangarWarDeployment (AH-0MVUXC2DD003HN0I)', () => {
  it('returns null for the arcade run (absent or non-deployment launch data)', () => {
    expect(readHangarWarDeployment(undefined)).toBeNull();
    expect(readHangarWarDeployment(null)).toBeNull();
    expect(readHangarWarDeployment('hangar-war')).toBeNull();
    expect(readHangarWarDeployment({ demo: false })).toBeNull();
    expect(readHangarWarDeployment({ kind: 'other', startLevel: 1 })).toBeNull();
  });

  it('returns null when the deployment does not state its difficulty', () => {
    expect(
      readHangarWarDeployment({ kind: HANGAR_WAR_DEPLOYMENT_KIND }),
    ).toBeNull();
    expect(
      readHangarWarDeployment({
        kind: HANGAR_WAR_DEPLOYMENT_KIND,
        startLevel: 'hard',
      }),
    ).toBeNull();
  });

  it('round-trips a built deployment', () => {
    const deployment = buildHangarDeployment(fieldedPayload(), {
      hexId: 'hex-hard',
    });
    expect(readHangarWarDeployment(deployment)).toEqual(deployment);
  });

  it('normalises out-of-range and wrong-typed fields', () => {
    const read = readHangarWarDeployment({
      kind: HANGAR_WAR_DEPLOYMENT_KIND,
      hexId: 7,
      aggression: -3,
      startLevel: 99,
      seed: 'nope',
      hullId: '',
      startingLives: 99,
      speedMultiplier: -1,
      startingWeapons: ['spread', 3, ''],
      modifiers: ['hardened_plating', null],
    });
    expect(read).not.toBeNull();
    expect(read!.hexId).toBeNull();
    expect(read!.aggression).toBe(0);
    expect(read!.startLevel).toBe(MAX_LEVEL);
    expect(read!.seed).toBe(0);
    expect(read!.hullId).toBe('hull-1');
    expect(read!.startingLives).toBe(MAX_LIVES);
    expect(read!.speedMultiplier).toBe(1);
    expect(read!.startingWeapons).toEqual(['spread']);
    expect(read!.modifiers).toEqual(['hardened_plating']);
  });
});

describe('applyHangarWarDeployment (AH-0MVUXC2DD003HN0I)', () => {
  it('applies the starting lives and weapons through the shared seams', () => {
    const deployment = buildHangarDeployment(fieldedPayload());
    const setStartingLives = vi.fn();
    const equipWeapon = vi.fn();
    applyHangarWarDeployment(
      { getPlayer: () => ({ equipWeapon }), setStartingLives },
      deployment,
    );
    expect(setStartingLives).toHaveBeenCalledWith(5);
    expect(equipWeapon.mock.calls).toEqual([
      ['spread', true],
      ['wave_laser', true],
    ]);
  });

  it('still applies the lives when the player has not spawned yet', () => {
    const deployment = buildHangarDeployment(fieldedPayload());
    const setStartingLives = vi.fn();
    applyHangarWarDeployment(
      { getPlayer: () => null, setStartingLives },
      deployment,
    );
    expect(setStartingLives).toHaveBeenCalledWith(5);
  });

  it('scales the ship config by the hull speed multiplier', () => {
    const base = loadShipConfig();
    const deployment = buildHangarDeployment(fieldedPayload());
    const scaled = applyHullSpeedToShipConfig(base, deployment);
    expect(scaled.maxSpeed).toBeCloseTo(base.maxSpeed * 0.85, 5);
    expect(scaled.thrustAcceleration).toBeCloseTo(
      base.thrustAcceleration * 0.85,
      5,
    );
    expect(scaled.asteroidsReverseMaxSpeed).toBeCloseTo(
      base.asteroidsReverseMaxSpeed * 0.85,
      5,
    );
    // The untouched tuning and rendering values are carried through.
    expect(scaled.frictionDeceleration).toBe(base.frictionDeceleration);
    expect(scaled.shipSize).toBe(base.shipSize);
    // The input config is never mutated.
    expect(base.maxSpeed).not.toBeCloseTo(scaled.maxSpeed, 5);
  });

  it('leaves a 1x hull ship config unchanged', () => {
    const base = loadShipConfig();
    const deployment = buildHangarDeployment(createDefaultPayload(1));
    const scaled = applyHullSpeedToShipConfig(base, deployment);
    expect(scaled).toEqual(base);
    expect(scaled).not.toBe(base);
  });
});
