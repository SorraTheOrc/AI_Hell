/**
 * Acceptance contract — completing a hex battle spends the flown ship
 * (parent AH-0MWL5PAP2001XYYF, test-first child AH-0MWL9E7PH001VPG5).
 *
 * Producer answers pinned here: **Q2 = B** (win *and* loss consume the deployed
 * ship), **Q4 = B** (only the deployed ship is consumed — every un-flown owned
 * item and the free starter kit survive).
 *
 * These tests are written against the public seams — `resolveHexCapture` (win)
 * and `resolveDeploymentDefeat` (loss). They were authored red under Vitest's
 * `it.fails` (the repo's red-before/green-after convention) by the test-first
 * child AH-0MWL9E7PH001VPG5 and are now plain `it` cases: the battle-end
 * consumption item landed the pure reducer behind both resolvers, so a
 * regression that preserves the flown ship fails here.
 *
 * The `DeployedShip` the resolver consumes is the hangar's own resolved ship
 * (`resolveActiveHull` / `resolveActiveLoadout`), which is exactly what a
 * deployment launches with — so a caller that passes no explicit ship still gets
 * the flown ship consumed.
 */

import { describe, expect, it } from 'vitest';

import { buildHangarDeployment } from '../../scenes/hangarWar/hangarDeployment';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import {
  DEFAULT_FRONTIER_TUNING,
} from './hexDefence';
import { createRingState } from './hexRing';
import { campaignResetSeed, resolveDeploymentDefeat, resolveHexCapture } from './captureCycle';
import { createDefaultPayload } from './hangarWarStore';
import { createBankedSalvage, runSalvageFromRun } from './salvageBanking';
import type { HangarWarPayload } from './types';

/** The zero run snapshot — banking it leaves the balance unchanged. */
function zeroSalvage(): ReturnType<typeof runSalvageFromRun> {
  return runSalvageFromRun({
    runId: 'consume-acceptance',
    checkpointId: 'boss-victory',
    minerals: 0,
    cores: 0,
  });
}

/** Assault balance knobs with the jitter zeroed, so the reset is deterministic. */
const NO_JITTER = { ...DEFAULT_FRONTIER_TUNING, jitterPercent: 0 };

/** A fresh ring-1 war carrying a bought, fully-equipped ship. */
function stockedWar(): HangarWarPayload {
  const payload: HangarWarPayload = {
    ...createDefaultPayload(99),
    ring: createRingState(1, HEX_RING_DEFINITIONS),
  };
  payload.hangar.bankedMinerals = 900;
  payload.hangar.bankedCores = 12;
  // The starter kit plus bought parts, and parts the player did **not** fly.
  payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3'];
  payload.hangar.unlockedWeapons = ['spread', 'wave_laser', 'ricochet'];
  payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
  // The ship that flies: a bought hull, a bought weapon plus the starter
  // weapon, and a bought modifier.
  payload.hangar.activeHull = 'hull-2';
  payload.hangar.activeLoadout = {
    startingWeapons: ['wave_laser', 'spread'],
    modifiers: ['hardened_plating'],
  };
  // Permanent levels for flown, un-flown and starter ids alike.
  payload.hangar.weaponLevels = [
    { id: 'wave_laser', level: 3 },
    { id: 'spread', level: 2 },
    { id: 'ricochet', level: 2 },
  ];
  payload.hangar.powerUpLevels = [
    { id: 'shield', level: 2 },
    { id: 'magnet', level: 3 },
  ];
  return payload;
}

/** A deep copy, so an input-invariance assertion is meaningful. */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** The id set of a level-row list. */
function rowIds(rows: ReadonlyArray<{ readonly id: string }> | undefined): string[] {
  return (rows ?? []).map((row) => row.id);
}

describe('completing a hex battle consumes the flown ship (AH-0MWL5PAP2001XYYF)', () => {
  describe('a winning deployment (resolveHexCapture)', () => {
    it('spends the flown hull, its starting weapons and its modifiers', () => {
      const payload = stockedWar();

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });

      expect(result.ok).toBe(true);
      const hangar = result.payload.hangar;
      // The flown hull is spent (and was left behind as the hex's defender).
      expect(hangar.unlockedHulls).not.toContain('hull-2');
      expect(result.defender?.hullId).toBe('hull-2');
      // The flown bought weapon is spent; the flown starter weapon survives.
      expect(hangar.unlockedWeapons).not.toContain('wave_laser');
      expect(hangar.unlockedWeapons).toContain('spread');
      // The flown modifier is spent.
      expect(hangar.ownedModifiers).not.toContain('hardened_plating');
    });

    it('keeps every un-flown owned item and the free starter kit', () => {
      const payload = stockedWar();

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });

      const hangar = result.payload.hangar;
      // Starter kit survives even though it was on the flown loadout.
      expect(hangar.unlockedHulls).toContain('hull-1');
      expect(hangar.unlockedWeapons).toContain('spread');
      // Owned hull/weapon/modifier the player did not fly survive.
      expect(hangar.unlockedHulls).toContain('hull-3');
      expect(hangar.unlockedWeapons).toContain('ricochet');
      expect(hangar.ownedModifiers).toContain('anti_maw_plating');
      // The capture's own grant also survives the consumption.
      expect(hangar.unlockedWeapons).toContain('rapid');
    });

    it('deletes only the consumed ids’ permanent level rows', () => {
      const payload = stockedWar();

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });

      const hangar = result.payload.hangar;
      // The flown weapon's row is gone …
      expect(rowIds(hangar.weaponLevels)).not.toContain('wave_laser');
      // … while the starter weapon's and every un-flown weapon's row survive …
      expect(rowIds(hangar.weaponLevels)).toContain('spread');
      expect(rowIds(hangar.weaponLevels)).toContain('ricochet');
      // … and no un-flown power-up row is collateral damage.
      expect(rowIds(hangar.powerUpLevels)).toEqual(
        expect.arrayContaining(['shield', 'magnet']),
      );
    });

    it('resets the active ship to the starter hull with an empty loadout', () => {
      const payload = stockedWar();

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });

      expect(result.payload.hangar.activeHull).toBe('hull-1');
      expect(result.payload.hangar.activeLoadout).toEqual({
        startingWeapons: [],
        modifiers: [],
      });
    });

    it('leaves the banked balances to the salvage rules, not to consumption', () => {
      const payload = stockedWar();
      const bankedBefore = {
        minerals: payload.hangar.bankedMinerals,
        cores: payload.hangar.bankedCores,
      };

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });

      expect(bankedBefore).toEqual({ minerals: 900, cores: 12 });
      expect(result.payload.hangar.bankedMinerals).toBe(900);
      expect(result.payload.hangar.bankedCores).toBe(12);
      expect(result.bankedDelta).toEqual({ minerals: 0, cores: 0 });
    });

    it('is deterministic: the same battle yields a deep-equal payload', () => {
      const payload = stockedWar();

      const first = resolveHexCapture(clone(payload), {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });
      const replay = resolveHexCapture(clone(payload), {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      });

      expect(first.payload).toEqual(replay.payload);
      // The caller's payload is never mutated.
      expect(payload).toEqual(stockedWar());
    });
  });

  describe('a losing deployment (resolveDeploymentDefeat)', () => {
    it('spends the same flown ship and resets to the starter kit', () => {
      const payload = stockedWar();

      const outcome = resolveDeploymentDefeat(payload, {
        salvage: zeroSalvage(),
        banked: createBankedSalvage(900, 12),
      });

      const hangar = outcome.payload.hangar;
      expect(hangar.unlockedHulls).not.toContain('hull-2');
      expect(hangar.unlockedWeapons).not.toContain('wave_laser');
      expect(hangar.ownedModifiers).not.toContain('hardened_plating');
      expect(hangar.activeHull).toBe('hull-1');
      expect(hangar.activeLoadout).toEqual({
        startingWeapons: [],
        modifiers: [],
      });
      // The starter kit and un-flown owned items survive a loss too.
      expect(hangar.unlockedHulls).toContain('hull-1');
      expect(hangar.unlockedWeapons).toContain('spread');
      expect(hangar.unlockedHulls).toContain('hull-3');
      expect(hangar.unlockedWeapons).toContain('ricochet');
      expect(hangar.ownedModifiers).toContain('anti_maw_plating');
      // Only the flown weapon's level row is removed.
      expect(rowIds(hangar.weaponLevels)).not.toContain('wave_laser');
      expect(rowIds(hangar.weaponLevels)).toContain('spread');
      expect(rowIds(hangar.weaponLevels)).toContain('ricochet');
      expect(rowIds(hangar.powerUpLevels)).toEqual(
        expect.arrayContaining(['shield', 'magnet']),
      );
    });

    it('never changes the banked balances through consumption', () => {
      const payload = stockedWar();

      const outcome = resolveDeploymentDefeat(payload, {
        salvage: zeroSalvage(),
        banked: createBankedSalvage(900, 12),
      });

      expect(outcome.payload.hangar.bankedMinerals).toBe(900);
      expect(outcome.payload.hangar.bankedCores).toBe(12);
      expect(outcome.forfeited).toEqual({ minerals: 0, cores: 0 });
    });

    it('is deterministic and leaves its caller’s payload untouched', () => {
      const payload = stockedWar();

      const first = resolveDeploymentDefeat(clone(payload), {
        salvage: zeroSalvage(),
      });
      const replay = resolveDeploymentDefeat(clone(payload), {
        salvage: zeroSalvage(),
      });

      expect(first.payload).toEqual(replay.payload);
      expect(payload).toEqual(stockedWar());
    });
  });

  describe('no soft-lock: a fresh deployment still builds', () => {
    it('deploys the starter hull with only its permanent cannon after a win', () => {
      const payload = stockedWar();
      const consumed = resolveHexCapture(payload, {
        hexId: 'hex-r1-3',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
      }).payload;

      const deployment = buildHangarDeployment(consumed);

      expect(deployment.hullId).toBe('hull-1');
      expect(deployment.startingWeapons).toEqual([]);
      expect(deployment.modifiers).toEqual([]);
      expect(deployment.startingLives).toBeGreaterThan(0);
    });

    it('deploys the starter hull with only its permanent cannon after a loss', () => {
      const payload = stockedWar();
      const consumed = resolveDeploymentDefeat(payload, {
        salvage: zeroSalvage(),
      }).payload;

      const deployment = buildHangarDeployment(consumed);

      expect(deployment.hullId).toBe('hull-1');
      expect(deployment.startingWeapons).toEqual([]);
      expect(deployment.modifiers).toEqual([]);
      expect(deployment.startingLives).toBeGreaterThan(0);
    });
  });

  describe('the ring-end reset still wins over consumption', () => {
    it('returns the byte-identical fresh campaign after a hangar-falls assault', () => {
      const payload = stockedWar();
      // Zero-rated defenders cannot match the ring's massed attacker base, so
      // the ring-end assault falls and the whole campaign resets.
      for (const state of payload.ring.hexes) {
        if (state.id === 'hex-r1-6') continue;
        state.held = true;
        state.bossDefeated = true;
        state.defender = {
          hullId: 'hull-1',
          defenceRating: 0,
          bankedMinerals: 0,
        };
      }

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-6',
        defenderHullId: 'hull-2',
        salvage: zeroSalvage(),
        definitions: HEX_RING_DEFINITIONS,
        tuning: NO_JITTER,
      });

      expect(result.campaignReset).toBe(true);
      // The reset is the shipped fresh campaign (plus bestScore), never a
      // consumption-modified one.
      expect(result.payload).toEqual({
        ...createDefaultPayload(campaignResetSeed(payload)),
        bestScore: payload.bestScore,
      });
    });
  });
});
