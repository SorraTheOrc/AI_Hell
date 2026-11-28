/**
 * Gym↔game parity — the gym's capture spends the flown ship
 * (parent AH-0MWL5PAP2001XYYF, test-first child AH-0MWL9E7PH001VPG5).
 *
 * `GymHexWar.captureHex` delegates to the shipped `resolveHexCapture`, so the
 * consumption rule cannot exist only in the game's scene (AGENTS.md gym↔game
 * parity). This suite drives the gym's control surface over a bought,
 * fully-equipped ship and asserts the hangar the gym publishes afterwards is
 * the consumed one — and that it deep-equals the game's own pure resolver
 * result for the same payload and inputs.
 *
 * The consumption assertions were authored red under Vitest's `it.fails` by the
 * test-first child AH-0MWL9E7PH001VPG5 and are now plain `it`s: the battle-end
 * consumption item landed the reducer behind the shared resolver. The deep-equal
 * parity case is a guard that both sides keep sharing one resolver.
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  advanceGame,
  createReusableBoot,
  type BootedGame,
} from '../../test/gameHarness';
import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import { resolveHexCapture } from '../../core/hangarWar/captureCycle';
import {
  bankedSalvageFromHangar,
  runSalvageFromRun,
} from '../../core/hangarWar/salvageBanking';
import type { HangarWarPayload, HexState } from '../../core/hangarWar/types';
import {
  GymHexWar,
  GYM_HEX_WAR_SCENE_KEY,
} from './GymHexWar';

/** The single unheld hex the gym's control surface captures. */
const TARGET_HEX: HexState = {
  id: 'target',
  q: 1,
  r: 0,
  held: false,
  aggression: 0,
  defender: null,
  bossDefeated: false,
  grantedWeapon: null,
};

/** A zero-salvage run snapshot, so banking never moves the balance. */
function zeroSalvage(): ReturnType<typeof runSalvageFromRun> {
  return runSalvageFromRun({
    runId: 'gym-consume',
    checkpointId: 'boss-victory',
    minerals: 0,
    cores: 0,
  });
}

/** A war carrying a bought, fully-equipped ship (the ship that flies). */
function equippedWar(): HangarWarPayload {
  const payload = createDefaultPayload(4242);
  payload.hangar.bankedMinerals = 900;
  payload.hangar.bankedCores = 12;
  payload.hangar.unlockedHulls = ['hull-1', 'hull-2', 'hull-3'];
  payload.hangar.unlockedWeapons = ['spread', 'wave_laser', 'ricochet'];
  payload.hangar.ownedModifiers = ['hardened_plating', 'anti_maw_plating'];
  payload.hangar.activeHull = 'hull-2';
  payload.hangar.activeLoadout = {
    startingWeapons: ['wave_laser', 'spread'],
    modifiers: ['hardened_plating'],
  };
  payload.hangar.weaponLevels = [
    { id: 'wave_laser', level: 3 },
    { id: 'spread', level: 2 },
    { id: 'ricochet', level: 2 },
  ];
  payload.hangar.powerUpLevels = [{ id: 'shield', level: 2 }];
  // Two hexes: capturing `target` leaves `other` unheld, so the ring is not
  // secured and no ring-end assault/opening can muddy the parity comparison.
  payload.ring = {
    ringIndex: 1,
    hexes: [
      { ...TARGET_HEX },
      {
        id: 'other',
        q: 2,
        r: 0,
        held: false,
        aggression: 0,
        defender: null,
        bossDefeated: false,
        grantedWeapon: null,
      },
    ],
  };
  return payload;
}

const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

describe('GymHexWar — the capture spends the flown ship (AH-0MWL5PAP2001XYYF)', () => {
  let booted: BootedGame | null = null;

  /** Boots the gym with `payload` injected as launch data. */
  async function bootHexWar(payload: HangarWarPayload): Promise<GymHexWar> {
    booted = await reuse.boot([GymHexWar]);
    booted.game.scene.start(GYM_HEX_WAR_SCENE_KEY, { payload });
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene(GYM_HEX_WAR_SCENE_KEY) as GymHexWar;
  }

  it('consumes the flown hull, its weapons and modifiers through the gym seam', async () => {
    const scene = await bootHexWar(equippedWar());

    const result = scene.captureHex('target', 'hull-2', zeroSalvage());

    expect(result.ok).toBe(true);
    // The defender still derives from the flown hull …
    expect(result.defender?.hullId).toBe('hull-2');
    // … even though the fleet no longer owns it.
    const hangar = scene.getPayload().hangar;
    expect(hangar.unlockedHulls).not.toContain('hull-2');
    expect(hangar.unlockedWeapons).not.toContain('wave_laser');
    expect(hangar.ownedModifiers).not.toContain('hardened_plating');
    expect(hangar.activeHull).toBe('hull-1');
    expect(hangar.activeLoadout).toEqual({
      startingWeapons: [],
      modifiers: [],
    });
    // Starter kit and un-flown owned items survive the gym capture too.
    expect(hangar.unlockedHulls).toContain('hull-1');
    expect(hangar.unlockedWeapons).toContain('spread');
    expect(hangar.unlockedHulls).toContain('hull-3');
    expect(hangar.unlockedWeapons).toContain('ricochet');
    expect(hangar.ownedModifiers).toContain('anti_maw_plating');
  });

  it('keeps the flown weapon’s bought level (ownership only is spent)', async () => {
    // TEST-FIRST (AH-0MWWGH13W007U49Q): authored red under `it.fails` and now a
    // plain `it`: the pruning was withdrawn from `consumeDeployedShip`
    // (AH-0MWWGH3FV004AF1O). The gym asserts the same rule as the game through
    // the shared pure reducer — no divergent copy (docs/GYM_PARITY.md).
    const scene = await bootHexWar(equippedWar());

    const result = scene.captureHex('target', 'hull-2', zeroSalvage());

    expect(result.ok).toBe(true);
    // The flown weapon leaves the owned set …
    expect(scene.getPayload().hangar.unlockedWeapons).not.toContain('wave_laser');
    // … but its permanent level row survives, level and order preserved.
    expect(scene.getPayload().hangar.weaponLevels).toEqual([
      { id: 'wave_laser', level: 3 },
      { id: 'spread', level: 2 },
      { id: 'ricochet', level: 2 },
    ]);
    expect(scene.getPayload().hangar.powerUpLevels).toEqual([
      { id: 'shield', level: 2 },
    ]);
  });

  it('deep-equals the game’s pure capture for the same payload and inputs', async () => {
    const scene = await bootHexWar(equippedWar());

    const gym = scene.captureHex('target', 'hull-2', zeroSalvage());

    const gamePayload = equippedWar();
    const game = resolveHexCapture(gamePayload, {
      hexId: 'target',
      defenderHullId: 'hull-2',
      salvage: zeroSalvage(),
      // Exactly the authored definitions the gym drives (ring-1 only), so the
      // comparison cannot differ on an un-authored ring transition.
      definitions: scene.getDefinitions(),
      banked: bankedSalvageFromHangar(gamePayload.hangar),
    });

    expect(gym.ok).toBe(true);
    expect(game.ok).toBe(true);
    // The gym owns no consumption copy: it publishes exactly the game's payload.
    expect(scene.getPayload()).toEqual(game.payload);
    expect(gym.payload).toEqual(game.payload);
  });
});
