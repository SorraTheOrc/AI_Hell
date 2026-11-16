/**
 * **Hex variety — epic-level end-to-end verification** (AH-0MWEW73WS003QFV7,
 * the verification slice of the post-MVP **hex variety** epic
 * AH-0MVWZYQN8007SXIG).
 *
 * The three variety axes each landed with their own acceptance tests
 * (`hexIntel.variety`, `hexContracts.variety`, `hexLandmarks.variety`,
 * `hangarWarStore.variety`, `hexBoss.variety`). Those tests pin each axis's
 * **rules**; they deliberately do not walk the axes *together*. This file is
 * the epic's own gate: it drives one ring through the **shipped** pure modules
 * in the order a player's sortie does — authored data → generated ring →
 * known-ahead intel → deployment/boss profile → capture → persistence —
 * and asserts the epic's cross-cutting acceptance criteria (AC1 data-authored,
 * AC2 known ahead, AC4 real + persisted effect, AC5 shared code) on the way.
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D (post-MVP list)
 * and GDD §8.2 *Hex variety*. Producer answers Q1 = b, Q2 = a, Q3 = a
 * (2026-11-13) — personalities are config-tunes **plus** the two bounded shared
 * mechanics, contracts pay currency banked through the existing banking rule,
 * and landmarks are fortress/cache set-pieces on ordinary hexes.
 *
 * Everything here is a pure module (no Phaser, no storage, no scene), so the
 * game and every gym resolve through exactly the code these assertions
 * exercise (AGENTS.md gym↔game parity).
 */

import { describe, expect, it } from 'vitest';

import {
  HEX_RING_DEFINITIONS,
} from '@/data/hexRingDefinitions';
import {
  VARIETY_RING_DEFINITIONS,
} from './__fixtures__/ringFixtures';
import {
  CACHE_SALVAGE_BONUS,
  FORTRESS_CAPTURE_PASSES,
  resolveHexCapture,
  type HexCaptureInput,
  type HexCaptureResult,
} from './captureCycle';
import { buildHexBossProfile } from './hexBoss';
import {
  buildHexMapModel,
  CACHE_TILE_TAG,
  CONTRACT_PANEL_HEADING,
  CONTRACT_TILE_TAG,
  FORTRESS_TILE_TAG,
  NEBULA_TILE_TAG,
  PERSONALITY_PANEL_HEADING,
  SUMMONER_TILE_TAG,
  type HexIntel,
} from './hexIntel';
import {
  createRingState,
  generateRing,
  HEX_LANDMARK_IDS,
  HEX_PERSONALITY_IDS,
  HEX_PERSONALITY_MECHANICS,
  ringSize,
  validateRingDefinitions,
  type HexRingDefinition,
} from './hexRing';
import { HANGAR_WAR_FIXTURE_VERSION } from './fixtures';
import {
  HANGAR_WAR_STORAGE_KEY,
  HANGAR_WAR_VERSION,
  parseHangarWarPayload,
} from './hangarWarStore';
import type { HangarWarPayload } from './types';
import { buildHangarDeployment } from '@/scenes/hangarWar/hangarDeployment';
import {
  HEX_PERSONALITY_MECHANIC_SET,
  NEBULA_PROJECTILE_DRAG,
  nebulaVolleySpeedScale,
  SUMMONER_REINFORCEMENTS,
  summonerReinforcementCount,
} from '@/scenes/core/hexPersonalityMechanics';
import { hexMiniBossConfigForLevel } from '@/waves/miniBossDesigns';

/** An unheld ring-3 payload built from the authored variety sample. */
function varietyPayload(): HangarWarPayload {
  return {
    version: HANGAR_WAR_FIXTURE_VERSION,
    seed: 4242,
    hangar: {
      bankedMinerals: 100,
      bankedCores: 2,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: createRingState(3, VARIETY_RING_DEFINITIONS),
    pendingAttacks: [],
    bestScore: 0,
  };
}

/** The ring-3 sample's authored hexes, by what they author. */
const NEBULA_HEX = 'hex-r3-1';
const SUMMONER_HEX = 'hex-r3-5';
const FORTRESS_HEX = 'hex-r3-3';
const CACHE_HEX = 'hex-r3-4';
const CONTRACT_HEX = 'hex-r3-6';
const CORE_CONTRACT_HEX = 'hex-r3-11';

/** A boss victory at `hexId` with no run salvage to bank. */
function captureAt(hexId: string): HexCaptureInput {
  return {
    hexId,
    defenderHullId: 'hull-1',
    salvage: {
      runId: 'run-epic',
      checkpointId: 'boss',
      minerals: 0,
      cores: 0,
    },
    definitions: VARIETY_RING_DEFINITIONS,
  };
}

/** The hex the map publishes for `hexId`. */
function intelFor(payload: HangarWarPayload, hexId: string): HexIntel {
  const model = buildHexMapModel(payload, {
    definitions: VARIETY_RING_DEFINITIONS,
  });
  const hex = model.hexes.find((candidate) => candidate.id === hexId);
  expect(hex, `${hexId} is published by the map`).toBeDefined();
  return hex as HexIntel;
}

/** The persisted hex state for `hexId`. */
function storedHex(payload: HangarWarPayload, hexId: string) {
  const hex = payload.ring.hexes.find((candidate) => candidate.id === hexId);
  expect(hex, `${hexId} is in the ring`).toBeDefined();
  return hex!;
}

/** Persists and reloads a payload through the shipped store parser. */
function roundTrip(payload: HangarWarPayload): HangarWarPayload {
  const raw = JSON.parse(JSON.stringify(payload)) as unknown;
  const parsed = parseHangarWarPayload(raw);
  expect(parsed, 'the payload survives a save/load round trip').not.toBeNull();
  return parsed as HangarWarPayload;
}

describe('hex variety epic — AC1: every axis is authored data on the shipped seams', () => {
  it('validates the shipped rings and the variety sample through one validator', () => {
    for (const ringIndex of [1, 2]) {
      const result = validateRingDefinitions(ringIndex, HEX_RING_DEFINITIONS);
      expect(result.ok, `ring ${ringIndex} validates`).toBe(true);
    }
    // The variety sample is ordinary authored data: the *same* validator
    // accepts it, so variety cannot need a second authoring path.
    expect(validateRingDefinitions(3, VARIETY_RING_DEFINITIONS).ok).toBe(true);
  });

  it('authors every axis in the vocabulary the validator publishes', () => {
    const authored = VARIETY_RING_DEFINITIONS;
    const personalities = authored
      .map((definition) => definition.personality)
      .filter((id): id is NonNullable<typeof id> => id !== undefined);
    const landmarks = authored
      .map((definition) => definition.landmark)
      .filter((id): id is NonNullable<typeof id> => id !== undefined);
    const contracts = authored.filter(
      (definition) => definition.contract !== undefined,
    );

    expect(personalities.length).toBeGreaterThan(0);
    expect(contracts.length).toBeGreaterThan(0);
    expect([...landmarks].sort()).toEqual([...HEX_LANDMARK_IDS].sort());
    for (const id of personalities) expect(HEX_PERSONALITY_IDS).toContain(id);

    // The bounded mechanic set is exactly the authored vocabulary's list: a
    // third mechanic would have to be authored *and* validated first.
    expect([...HEX_PERSONALITY_MECHANIC_SET]).toEqual([
      ...HEX_PERSONALITY_MECHANICS,
    ]);
  });

  it('leaves the 6 × n ring geometry untouched', () => {
    expect(ringSize(1)).toBe(6);
    expect(ringSize(2)).toBe(12);
    expect(ringSize(3)).toBe(18);
    expect(generateRing(3, VARIETY_RING_DEFINITIONS).hexes).toHaveLength(18);
  });

  it('rejects malformed variety loudly (AC3, exercised end to end)', () => {
    const malformed: readonly unknown[][] = [
      // An unknown personality id is rejected, never repaired.
      VARIETY_RING_DEFINITIONS.map((definition, index) =>
        index === 0
          ? { ...definition, personality: 'not-a-personality' }
          : definition,
      ),
      // A contract that pays nothing is malformed.
      VARIETY_RING_DEFINITIONS.map((definition) =>
        definition.contract === undefined
          ? definition
          : { ...definition, contract: { ...definition.contract, bonusSalvage: 0, bonusCores: 0 } },
      ),
      // A cache on the ring's weapon hex breaks the one-weapon-hex rule.
      VARIETY_RING_DEFINITIONS.map((definition) =>
        definition.weaponHex
          ? { ...definition, landmark: 'cache' as const }
          : definition,
      ),
    ];

    for (const definitions of malformed) {
      // A deliberately malformed authored table: the validator, never the type
      // system, is the gate being exercised here.
      const result = validateRingDefinitions(
        3,
        definitions as unknown as readonly HexRingDefinition[],
      );
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });
});

describe('hex variety epic — AC2: the map publishes every axis before commitment', () => {
  it('publishes the personality, its mechanic and its tile tag on an unheld hex', () => {
    const payload = varietyPayload();
    const nebula = intelFor(payload, NEBULA_HEX);
    expect(nebula.held).toBe(false);
    expect(nebula.personality).toBe('nebula');
    expect(nebula.personalityMechanics.map((mechanic) => mechanic.kind)).toEqual([
      'projectile-drag',
    ]);
    expect(nebula.personalityMechanics[0].magnitude).toBe(NEBULA_PROJECTILE_DRAG);
    expect(nebula.tileLabel).toContain(NEBULA_TILE_TAG);
    expect(nebula.label).toContain(PERSONALITY_PANEL_HEADING);

    const summoner = intelFor(payload, SUMMONER_HEX);
    expect(summoner.personality).toBe('summoner');
    expect(summoner.personalityMechanics.map((mechanic) => mechanic.kind)).toEqual(
      ['reinforcements'],
    );
    expect(summoner.tileLabel).toContain(SUMMONER_TILE_TAG);
  });

  it('publishes the optional contract, its bonus and its open status', () => {
    const contract = intelFor(varietyPayload(), CONTRACT_HEX).contract;
    expect(contract).not.toBeNull();
    expect(contract?.objective.length).toBeGreaterThan(0);
    expect(contract?.bonusSalvage).toBe(150);
    expect(contract?.bonusCores).toBe(1);
    expect(contract?.status).toBe('open');

    const intel = intelFor(varietyPayload(), CONTRACT_HEX);
    expect(intel.tileLabel).toContain(CONTRACT_TILE_TAG);
    expect(intel.label).toContain(CONTRACT_PANEL_HEADING);
  });

  it('publishes each landmark with its meaning and fortress progress', () => {
    const payload = varietyPayload();
    const fortress = intelFor(payload, FORTRESS_HEX);
    expect(fortress.landmark).toBe('fortress');
    expect(fortress.landmarkProgress).toEqual({
      passes: 0,
      required: FORTRESS_CAPTURE_PASSES,
    });
    expect(fortress.tileLabel).toContain(FORTRESS_TILE_TAG);

    const cache = intelFor(payload, CACHE_HEX);
    expect(cache.landmark).toBe('cache');
    expect(cache.tileLabel).toContain(CACHE_TILE_TAG);
    expect(cache.label).toContain('CACHE');
  });

  it('publishes nothing on an ordinary hex', () => {
    const ordinary = intelFor(varietyPayload(), 'hex-r3-2');
    expect(ordinary.personality).toBeNull();
    expect(ordinary.contract).toBeNull();
    expect(ordinary.landmark).toBeNull();
  });
});

describe('hex variety epic — AC1/AC5: one shared path from ring to deployment', () => {
  it('builds the deployment from the ring the map renders', () => {
    const payload = varietyPayload();
    const deployment = buildHangarDeployment(payload, { hexId: NEBULA_HEX });
    expect(deployment.hexId).toBe(NEBULA_HEX);
    expect(deployment.aggression).toBe(
      intelFor(payload, NEBULA_HEX).aggression,
    );
    // The deployment carries the war the map showed, never a re-derived copy.
    expect(deployment.payload?.seed).toBe(payload.seed);
  });

  it('maps each personality onto the shipped boss profile and mini-boss config', () => {
    const spawn = {
      x: 0,
      y: 0,
      formationOffset: { row: 0, col: 0 },
    } as const;

    const nebulaDefinition = VARIETY_RING_DEFINITIONS.find(
      (definition) => definition.id === NEBULA_HEX,
    );
    const nebulaProfile = buildHexBossProfile(
      { id: NEBULA_HEX, aggression: 7 },
      nebulaDefinition,
    );
    expect(nebulaProfile.personality).toBe('nebula');
    expect(nebulaProfile.mechanics).toHaveLength(1);
    // The nebula's drag is the shared combat core's own scale.
    expect(nebulaVolleySpeedScale('nebula')).toBe(1 / NEBULA_PROJECTILE_DRAG);
    const nebulaConfig = hexMiniBossConfigForLevel(nebulaProfile.startLevel, {
      ...spawn,
      profile: nebulaProfile,
    });
    expect(
      nebulaConfig.minions?.reduce(
        (total, wave) =>
          total + wave.groups.filter((group) => group.enemyKey === 'scout').length,
        0,
      ) ?? 0,
    ).toBe(0);

    const summonerDefinition = VARIETY_RING_DEFINITIONS.find(
      (definition) => definition.id === SUMMONER_HEX,
    );
    const summonerProfile = buildHexBossProfile(
      { id: SUMMONER_HEX, aggression: 7 },
      summonerDefinition,
    );
    expect(summonerProfile.personality).toBe('summoner');
    expect(summonerReinforcementCount('summoner')).toBe(SUMMONER_REINFORCEMENTS);
    const summonerConfig = hexMiniBossConfigForLevel(summonerProfile.startLevel, {
      ...spawn,
      profile: summonerProfile,
    });
    const reinforcementWaves = (summonerConfig.minions ?? []).filter((wave) =>
      wave.groups.some((group) => group.enemyKey === 'scout'),
    );
    expect(reinforcementWaves).toHaveLength(summonerConfig.phases?.length ?? 1);
  });

  it('tunes an ordinary hex to no personality and no mechanic', () => {
    const ordinaryDefinition = VARIETY_RING_DEFINITIONS.find(
      (definition) => definition.id === 'hex-r3-2',
    );
    const profile = buildHexBossProfile(
      { id: 'hex-r3-2', aggression: 7 },
      ordinaryDefinition,
    );
    expect(profile.personality).toBeNull();
    expect(profile.mechanics).toEqual([]);
    expect(nebulaVolleySpeedScale(null)).toBe(1);
    expect(summonerReinforcementCount(null)).toBe(0);
  });
});

describe('hex variety epic — AC4: every axis resolves and persists once', () => {
  it('banks a contract bonus exactly once through the banking rule', () => {
    const payload = varietyPayload();
    const first = resolveHexCapture(payload, captureAt(CONTRACT_HEX));
    expect(first.ok).toBe(true);
    expect(first.contractBonus).toEqual({ minerals: 150, cores: 1 });
    expect(first.payload.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals + 150,
    );
    expect(first.payload.hangar.bankedCores).toBe(payload.hangar.bankedCores + 1);
    expect(storedHex(first.payload, CONTRACT_HEX).contractFulfilled).toBe(true);

    // A replay of the same capture pays nothing (the stored marker is the guard).
    const replay = resolveHexCapture(first.payload, captureAt(CONTRACT_HEX));
    expect(replay.contractBonus).toBeNull();
    expect(replay.payload.hangar.bankedMinerals).toBe(
      first.payload.hangar.bankedMinerals,
    );
    // And the map publishes the fulfilled status.
    expect(intelFor(first.payload, CONTRACT_HEX).contract?.status).toBe(
      'fulfilled',
    );
  });

  it('holds a fortress only on the second pass and publishes its progress', () => {
    const payload = varietyPayload();
    const first: HexCaptureResult = resolveHexCapture(
      payload,
      captureAt(FORTRESS_HEX),
    );
    expect(first.reason).toBe('fortress-incomplete');
    expect(storedHex(first.payload, FORTRESS_HEX).held).toBe(false);
    expect(storedHex(first.payload, FORTRESS_HEX).capturePasses).toBe(1);
    expect(intelFor(first.payload, FORTRESS_HEX).landmarkProgress).toEqual({
      passes: 1,
      required: FORTRESS_CAPTURE_PASSES,
    });

    const second = resolveHexCapture(first.payload, captureAt(FORTRESS_HEX));
    expect(second.ok).toBe(true);
    expect(storedHex(second.payload, FORTRESS_HEX).held).toBe(true);
    expect(storedHex(second.payload, FORTRESS_HEX).capturePasses).toBe(
      FORTRESS_CAPTURE_PASSES,
    );
    expect(intelFor(second.payload, FORTRESS_HEX).landmarkProgress).toEqual({
      passes: FORTRESS_CAPTURE_PASSES,
      required: FORTRESS_CAPTURE_PASSES,
    });
  });

  it('pays a cache instead of granting, leaving the fleet untouched', () => {
    const payload = varietyPayload();
    // The authored cache hex would grant `ring-3-grant-4` on any ordinary hex;
    // the landmark turns that into a payout.
    const result = resolveHexCapture(payload, captureAt(CACHE_HEX));
    expect(result.ok).toBe(true);
    expect(result.grant).toBeNull();
    expect(result.cachePayout).toEqual({
      minerals: CACHE_SALVAGE_BONUS,
      cores: 0,
    });
    expect(result.payload.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals + CACHE_SALVAGE_BONUS,
    );
    expect(storedHex(result.payload, CACHE_HEX).grantedWeapon).toBeNull();
    expect(result.payload.hangar.unlockedWeapons).toEqual(
      payload.hangar.unlockedWeapons,
    );

    // A re-capture of the now-held cache pays nothing again.
    const again = resolveHexCapture(result.payload, captureAt(CACHE_HEX));
    expect(again.cachePayout).toBeNull();
    expect(again.payload.hangar.bankedMinerals).toBe(
      result.payload.hangar.bankedMinerals,
    );
  });

  it('still grants on an ordinary hex (the axes change rules only where authored)', () => {
    const result = resolveHexCapture(varietyPayload(), captureAt('hex-r3-2'));
    expect(result.ok).toBe(true);
    expect(result.grant).not.toBeNull();
    expect(result.contractBonus).toBeNull();
    expect(result.cachePayout).toBeNull();
  });

  it('persists variety state under the one payload key, migrating by field presence', () => {
    // A contract capture + a fortress pass: both variety fields land in state.
    let payload = varietyPayload();
    payload = resolveHexCapture(payload, captureAt(CONTRACT_HEX)).payload;
    payload = resolveHexCapture(payload, captureAt(FORTRESS_HEX)).payload;

    const reloaded = roundTrip(payload);
    expect(reloaded.version).toBe(HANGAR_WAR_VERSION);
    expect(storedHex(reloaded, CONTRACT_HEX).contractFulfilled).toBe(true);
    expect(storedHex(reloaded, FORTRESS_HEX).capturePasses).toBe(1);
    // The ring, the variety markers and the banking all survive the round trip.
    expect(reloaded.ring.ringIndex).toBe(3);
    expect(reloaded.hangar.bankedMinerals).toBe(payload.hangar.bankedMinerals);

    // A save written before the variety fields existed loads safely: absence
    // reads as "no contract fulfilled, no fortress passes" (field presence).
    const legacy = JSON.parse(JSON.stringify(payload)) as {
      ring: { hexes: Record<string, unknown>[] };
    };
    for (const hex of legacy.ring.hexes) {
      delete hex.contractFulfilled;
      delete hex.capturePasses;
    }
    const migrated = parseHangarWarPayload(legacy);
    expect(migrated).not.toBeNull();
    const legacyHex = storedHex(migrated as HangarWarPayload, FORTRESS_HEX);
    expect(legacyHex).not.toHaveProperty('contractFulfilled');
    expect(legacyHex).not.toHaveProperty('capturePasses');

    // One storage key only: variety state never introduced a second one.
    expect(HANGAR_WAR_STORAGE_KEY).toBe('ai_hell_hangar_war');
  });

  it('replays identically from the same payload and seed (determinism)', () => {
    const captureAll = (): HangarWarPayload => {
      let payload = varietyPayload();
      for (const hexId of [
        CONTRACT_HEX,
        FORTRESS_HEX,
        FORTRESS_HEX,
        CACHE_HEX,
        CORE_CONTRACT_HEX,
        'hex-r3-2',
      ]) {
        payload = resolveHexCapture(payload, captureAt(hexId)).payload;
      }
      return payload;
    };

    const first = captureAll();
    const second = captureAll();
    expect(second).toEqual(first);
    // And the published map is deterministic too (the intel is a pure read).
    expect(
      buildHexMapModel(first, { definitions: VARIETY_RING_DEFINITIONS }).hexes,
    ).toEqual(
      buildHexMapModel(second, { definitions: VARIETY_RING_DEFINITIONS }).hexes,
    );
  });
});
