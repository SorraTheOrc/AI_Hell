/**
 * Authored hex-ring definition tests (AH-0MVUXC9KG008G80Y).
 *
 * Pins the **data** half of the ring: rings 1 and 2 are authored definitions
 * (not hand-placed coordinates), the committed CSV seeds mirror the typed
 * table byte-for-value, the design rules hold (one hardest weapon hex per
 * ring, distinct grants, ring membership), and the generator turns the data
 * into 6/12 hexes — with a ring-3 case proving a new ring needs only data.
 *
 * The ring **validator**'s special-mission rules (post-MVP Hangar War,
 * AH-0MWEYVRUX008SLJ8) are pinned here too: a special-mission hex must grant a
 * hull catalogue entry, and the `isSpecialMission` marker must keep travelling
 * through the CSV seed parity harness (a marker absent from the seeds would let
 * authored data drift from the table that the game reads).
 *
 * The shipped **hex variety** content is pinned here as well
 * (AH-0MVWZYQN8007SXIG, AH-0MWJ4ZDXO007VDJS): ring 2's personality/contract/
 * fortress sample, ring 1's authored contract (`hex-r1-4`) and fortress
 * (`hex-r1-5`), their publication in the known-ahead intel, and their
 * resolution through the shipped capture cycle (fortress two-pass, contract
 * banked once) with the state surviving the field-presence save migration.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCsvRows } from '../core/csv';
import {
  HexRingDefinitionError,
  FORTRESS_CAPTURE_PASSES,
  createRingState,
  generateRing,
  ringCoordinates,
  ringDepth,
  ringSize,
  validateRingDefinitions,
  type HexContractDefinition,
  type HexLandmarkId,
  type HexPersonalityId,
  type HexRingDefinition,
} from '../core/hangarWar/hexRing';
import {
  CONTRACT_PANEL_HEADING,
  CONTRACT_TILE_TAG,
  FORTRESS_TILE_TAG,
  buildHexMapModel,
} from '../core/hangarWar/hexIntel';
import {
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../core/hangarWar/hangarWarStore';
import { createInMemoryHangarWarStorage } from '../core/hangarWar/storage';
import { resolveHexCapture } from '../core/hangarWar/captureCycle';
import { runSalvageFromRun } from '../core/hangarWar/salvageBanking';
import { NEBULA_PROJECTILE_DRAG } from '../scenes/core/hexPersonalityMechanics';
import { hexAggressionLevel } from '../core/hangarWar/hexDifficulty';
import { findHangarEntry } from '../core/hangarWar/hangarEconomy';
import {
  HEX_RING_DEFINITIONS,
  findHexRingDefinition,
  hexRingDefinitionsFor,
} from './hexRingDefinitions';

/** Reads a committed CSV seed next to this test file. */
function readCsv(name: string): string {
  return readFileSync(resolve(__dirname, name), 'utf8');
}

/** Parses a hex-ring CSV seed into typed definitions. */
function definitionsFromCsv(name: string): HexRingDefinition[] {
  return definitionsFromCsvText(readCsv(name));
}

/** Parses hex-ring CSV text into typed definitions (the seed's column order). */
function definitionsFromCsvText(csv: string): HexRingDefinition[] {
  return parseCsvRows(csv).map((row) => {
    const personality = (row.personality ?? '').trim();
    const landmark = (row.landmark ?? '').trim();
    const objective = (row.contractObjective ?? '').trim();
    // A contract is one authored unit: the objective cell decides whether the
    // row carries one at all, and the two bonus cells are its payout.
    const contract: HexContractDefinition | undefined =
      objective === ''
        ? undefined
        : {
            objective,
            bonusSalvage: Number(row.contractBonusSalvage ?? 0),
            bonusCores: Number(row.contractBonusCores ?? 0),
          };
    return {
      id: row.id,
      q: Number(row.q),
      r: Number(row.r),
      ringIndex: Number(row.ringIndex),
      boss: row.boss,
      strengths: (row.strengths ?? '').split('|').filter((id) => id !== ''),
      weaknesses: (row.weaknesses ?? '').split('|').filter((id) => id !== ''),
      grants: row.grants,
      weaponHex: row.weaponHex === 'true',
      isSpecialMission: row.isSpecialMission === 'true',
      baseAggression: Number(row.baseAggression),
      ...(personality === ''
        ? {}
        : { personality: personality as HexPersonalityId }),
      ...(contract === undefined ? {} : { contract }),
      ...(landmark === '' ? {} : { landmark: landmark as HexLandmarkId }),
    };
  });
}

/**
 * Serialises definitions into the seed's on-disk shape, column order included.
 *
 * Used to prove the parity harness carries the `isSpecialMission` column and the
 * optional hex-variety columns: the same parse the committed seeds go through
 * must round-trip a flagged/special/variety row.
 */
function definitionsToCsv(rows: readonly HexRingDefinition[]): string {
  const header =
    'id,q,r,ringIndex,boss,strengths,weaknesses,grants,weaponHex,isSpecialMission,baseAggression,personality,contractObjective,contractBonusSalvage,contractBonusCores,landmark';
  const lines = rows.map((row) =>
    [
      row.id,
      String(row.q),
      String(row.r),
      String(row.ringIndex),
      row.boss,
      row.strengths.join('|'),
      row.weaknesses.join('|'),
      row.grants,
      String(row.weaponHex),
      String(row.isSpecialMission === true),
      String(row.baseAggression),
      row.personality ?? '',
      row.contract === undefined ? '' : quoteCsv(row.contract.objective),
      row.contract === undefined ? '' : String(row.contract.bonusSalvage),
      row.contract === undefined ? '' : String(row.contract.bonusCores),
      row.landmark ?? '',
    ].join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

/** RFC 4180 quoting, so an authored objective may contain commas or quotes. */
function quoteCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Ring 1's authored definitions, as plain (non-frozen) copies. */
function authoredRingOne(): HexRingDefinition[] {
  return hexRingDefinitionsFor(1).map((hex) => ({ ...hex }));
}

/** `hex-r1-1` grants `hull-2`, a hull catalogue entry, so it can be special. */
const SPECIAL_MISSION_HEX_ID = 'hex-r1-1';

/**
 * Ring 1's authored definitions with `SPECIAL_MISSION_HEX_ID` promoted to a
 * special-mission hex (and `patch` applied to it), so each case changes exactly
 * one thing about an otherwise valid ring.
 */
function ringOneWithSpecialMission(
  patch: Partial<HexRingDefinition> = {},
): HexRingDefinition[] {
  return authoredRingOne().map((hex) =>
    hex.id === SPECIAL_MISSION_HEX_ID
      ? { ...hex, isSpecialMission: true, ...patch }
      : hex,
  );
}

describe('hex-ring CSV seeds', () => {
  it.each([1, 2])('ring %i seed documents its columns and ends with a newline', (ring) => {
    const csv = readCsv(`hex-ring-${ring}.csv`);
    expect(csv).toMatch(/^# /);
    expect(csv).toContain('id,q,r,ringIndex,boss');
    // The optional hex-variety columns are documented in both seeds and mirror
    // the typed vocabulary (AH-0MWEW4ANW009GGX7).
    expect(csv).toContain(
      'personality,contractObjective,contractBonusSalvage,contractBonusCores,landmark',
    );
    expect(csv).toMatch(/\n$/);
  });

  it.each([1, 2])('ring %i CSV mirrors the typed definitions exactly', (ring) => {
    expect(definitionsFromCsv(`hex-ring-${ring}.csv`)).toEqual(
      hexRingDefinitionsFor(ring),
    );
  });
});

describe('authored ring definitions', () => {
  it('authors ring 1 (6 hexes) and ring 2 (12 hexes)', () => {
    expect(hexRingDefinitionsFor(1)).toHaveLength(6);
    expect(hexRingDefinitionsFor(2)).toHaveLength(12);
    expect(HEX_RING_DEFINITIONS).toHaveLength(18);
  });

  it('authors no ring 3 yet (later rings are appended, never fabricated)', () => {
    expect(hexRingDefinitionsFor(3)).toEqual([]);
  });

  it('validates as complete rings (membership, coverage, one hardest weapon hex)', () => {
    expect(validateRingDefinitions(1, HEX_RING_DEFINITIONS)).toEqual({
      ok: true,
      issues: [],
    });
    expect(validateRingDefinitions(2, HEX_RING_DEFINITIONS)).toEqual({
      ok: true,
      issues: [],
    });
  });

  it('declares every hex on the ring its coordinates belong to', () => {
    for (const hex of HEX_RING_DEFINITIONS) {
      expect(
        ringDepth(hex.q, hex.r),
        `${hex.id} ring membership`,
      ).toBe(hex.ringIndex);
    }
  });

  it('uses unique ids and unique axial coordinates', () => {
    const ids = HEX_RING_DEFINITIONS.map((hex) => hex.id);
    expect(new Set(ids).size).toBe(ids.length);
    const coordinates = HEX_RING_DEFINITIONS.map((hex) => `${hex.q},${hex.r}`);
    expect(new Set(coordinates).size).toBe(coordinates.length);
  });

  it('publishes the boss, its strengths/weaknesses, a grant and aggression', () => {
    for (const hex of HEX_RING_DEFINITIONS) {
      expect(hex.boss, `${hex.id} boss`).toMatch(/^[a-z0-9-]+$/);
      expect(hex.strengths.length, `${hex.id} strengths`).toBeGreaterThan(0);
      expect(hex.weaknesses.length, `${hex.id} weaknesses`).toBeGreaterThan(0);
      expect(hex.grants, `${hex.id} grant`).not.toBe('');
      expect(Number.isInteger(hex.baseAggression), `${hex.id} aggression`).toBe(
        true,
      );
      expect(hex.baseAggression).toBeGreaterThanOrEqual(0);
    }
  });

  it('grants every hex of a ring a distinct reward', () => {
    for (const ringIndex of [1, 2]) {
      const grants = hexRingDefinitionsFor(ringIndex).map((hex) => hex.grants);
      expect(new Set(grants).size, `ring ${ringIndex} distinct grants`).toBe(
        grants.length,
      );
    }
  });

  it('makes ring 2 the harder frontier than ring 1', () => {
    const ringOne = hexRingDefinitionsFor(1).map((hex) => hex.baseAggression);
    const ringTwo = hexRingDefinitionsFor(2).map((hex) => hex.baseAggression);
    expect(Math.min(...ringTwo)).toBeGreaterThan(Math.min(...ringOne));
    expect(Math.max(...ringTwo)).toBeGreaterThan(Math.max(...ringOne));
  });

  it('pins ring 2\'s survivable aggression band: floor at 2, gradient retained', () => {
    const ringTwo = hexRingDefinitionsFor(2);
    const aggressions = ringTwo.map((hex) => hex.baseAggression);

    // Floor is aggression 2 — the survivable band that the competent bot
    // survived at full 300 s on ring 1; campaign level ≤ 3.
    expect(Math.min(...aggressions)).toBe(2);

    // The six retuned hexes sit at the floor; each resolves to a no-fire
    // campaign level (≤ 3) — the survivable band.
    const survivable = ringTwo.filter((hex) => hex.baseAggression <= 2);
    expect(survivable.map((hex) => hex.id).sort()).toEqual([
      'hex-r2-1',
      'hex-r2-10',
      'hex-r2-2',
      'hex-r2-4',
      'hex-r2-6',
      'hex-r2-7',
    ]);
    for (const hex of survivable) {
      expect(
        hexAggressionLevel(hex.baseAggression),
        `${hex.id} aggression ${hex.baseAggression} → campaign level`,
      ).toBeLessThanOrEqual(3);
    }

    // The hard tail keeps a real threat gradient above the survivable band:
    // a hex at 5, one at 6 and the weapon hex at 8, each a losing level.
    expect(aggressions).toContain(5);
    expect(aggressions).toContain(6);
    for (const hex of ringTwo.filter((hex) => hex.baseAggression > 2)) {
      expect(
        hexAggressionLevel(hex.baseAggression),
        `${hex.id} aggression ${hex.baseAggression} stays above the survivable band`,
      ).toBeGreaterThan(3);
    }

    // Weapon hex is the strict maximum.
    const weaponHex = ringTwo.find((hex) => hex.weaponHex)!;
    expect(weaponHex.id).toBe('hex-r2-12');
    expect(weaponHex.baseAggression).toBe(8);
    expect(weaponHex.baseAggression).toBe(Math.max(...aggressions));
    for (const hex of ringTwo.filter((h) => h.id !== 'hex-r2-12')) {
      expect(
        hex.baseAggression,
        `${hex.id} is easier than the weapon hex`,
      ).toBeLessThan(weaponHex.baseAggression);
    }
  });

  it('looks a definition up by id, and reports an unknown id as undefined', () => {
    expect(findHexRingDefinition('hex-r1-6')?.boss).toBe('maw-of-ashes');
    expect(findHexRingDefinition('hex-r2-12')?.grants).toBe('nova');
    expect(findHexRingDefinition('hex-does-not-exist')).toBeUndefined();
  });
});

describe('authored hex variety content (shipped rings)', () => {
  it('authors the shipped variety hexes: two on ring 1 and three on ring 2', () => {
    const authored = (HEX_RING_DEFINITIONS as readonly HexRingDefinition[]).filter(
      (hex) =>
        hex.personality !== undefined ||
        hex.contract !== undefined ||
        hex.landmark !== undefined,
    );
    expect(authored.map((hex) => hex.id)).toEqual([
      'hex-r1-4',
      'hex-r1-5',
      'hex-r2-1',
      'hex-r2-6',
      'hex-r2-7',
    ]);
    // Ring 1 authors exactly one landmark and one contract (AH-0MWJ4ZDXO007VDJS)
    // and no personality; every other ring-1 hex stays ordinary.
    const varietyRingOne = authored.filter((hex) => hex.ringIndex === 1);
    expect(
      varietyRingOne.filter((hex) => hex.landmark !== undefined),
    ).toHaveLength(1);
    expect(
      varietyRingOne.filter((hex) => hex.contract !== undefined),
    ).toHaveLength(1);
    for (const hex of hexRingDefinitionsFor(1)) {
      if (hex.id === 'hex-r1-4' || hex.id === 'hex-r1-5') continue;
      expect(hex.personality, `${hex.id} personality`).toBeUndefined();
      expect(hex.contract, `${hex.id} contract`).toBeUndefined();
      expect(hex.landmark, `${hex.id} landmark`).toBeUndefined();
    }
    expect(
      hexRingDefinitionsFor(1).every((hex) => hex.personality === undefined),
      'ring 1 authors no personality',
    ).toBe(true);
  });

  it('authors ring 1\'s landmark and contract on the chosen hexes', () => {
    // The fortress sits on the ring's last ordinary hex before the weapon hex;
    // it keeps that hex's `core-bank` grant (a cache would have removed the
    // ring's only core-bank). The contract sits on an aggression-2 hex so the
    // bonus cannot reorder the ring's aggression-ordered recommended path.
    expect(findHexRingDefinition('hex-r1-5')?.landmark).toBe('fortress');
    expect(findHexRingDefinition('hex-r1-5')?.grants).toBe('core-bank');
    expect(findHexRingDefinition('hex-r1-4')?.contract).toEqual({
      objective: 'Crack the ember nest and hold the hex',
      bonusSalvage: 60,
      bonusCores: 1,
    });
  });

  it('leaves ring 1\'s aggression band and recommended order untouched', () => {
    // No authored aggression changes: the weapon hex stays the ring's hardest
    // and the authored variety hexes sit inside the existing band.
    expect(hexRingDefinitionsFor(1).map((hex) => hex.baseAggression)).toEqual([
      2, 1, 3, 2, 4, 6,
    ]);
    const ringOne = hexRingDefinitionsFor(1);
    const weaponHex = ringOne.find((hex) => hex.weaponHex)!;
    expect(weaponHex.id).toBe('hex-r1-6');
    expect(weaponHex.baseAggression).toBe(
      Math.max(...ringOne.map((h) => h.baseAggression)),
    );
    for (const hex of ringOne.filter((h) => h.id !== weaponHex.id)) {
      expect(
        hex.baseAggression,
        `${hex.id} stays easier than the weapon hex`,
      ).toBeLessThan(weaponHex.baseAggression);
    }
    // The ring-1 contract pays less than ring 2's (the tutorial ring is not
    // the place to out-earn the harder frontier), and both bonuses stay well
    // under the shipped cache payout (140 salvage).
    const contract = findHexRingDefinition('hex-r1-4')!.contract!;
    const ringTwoContract = findHexRingDefinition('hex-r2-6')!.contract!;
    expect(contract.bonusSalvage).toBeLessThan(ringTwoContract.bonusSalvage);
    expect(contract.bonusSalvage).toBeLessThan(140);
  });

  it('publishes ring 1\'s contract and fortress in known-ahead intel before commitment', () => {
    const payload = {
      ...createDefaultPayload(4242),
      ring: createRingState(1, HEX_RING_DEFINITIONS),
    };
    const model = buildHexMapModel(payload);
    const byId = new Map(model.hexes.map((hex) => [hex.id, hex] as const));

    // Contract: objective, bonus and the open status before committing a life.
    const contractHex = byId.get('hex-r1-4')!;
    expect(contractHex.held).toBe(false);
    expect(contractHex.contract).toEqual({
      objective: 'Crack the ember nest and hold the hex',
      bonusSalvage: 60,
      bonusCores: 1,
      status: 'open',
    });
    expect(contractHex.tileLabel).toContain(CONTRACT_TILE_TAG);
    expect(contractHex.label).toContain(
      `${CONTRACT_PANEL_HEADING}: Crack the ember nest and hold the hex`,
    );
    expect(contractHex.label).toContain('BONUS: +60 MIN \u00b7 +1 CORE');

    // Landmark: the fortress type and its zero-of-two progress.
    const fortressHex = byId.get('hex-r1-5')!;
    expect(fortressHex.held).toBe(false);
    expect(fortressHex.landmark).toBe('fortress');
    expect(fortressHex.landmarkProgress).toEqual({
      passes: 0,
      required: FORTRESS_CAPTURE_PASSES,
    });
    expect(fortressHex.tileLabel).toContain(FORTRESS_TILE_TAG);
    expect(fortressHex.label).toContain('LANDMARK: FORTRESS');

    // An ordinary ring-1 hex publishes none of it.
    const ordinary = byId.get('hex-r1-2')!;
    expect(ordinary.contract).toBeNull();
    expect(ordinary.landmark).toBeNull();
    expect(ordinary.tileLabel).not.toContain(CONTRACT_TILE_TAG);
    expect(ordinary.tileLabel).not.toContain(FORTRESS_TILE_TAG);
  });

  it('authors each axis on the producer-confirmed hex', () => {
    expect(findHexRingDefinition('hex-r2-1')?.personality).toBe('nebula');
    expect(findHexRingDefinition('hex-r2-6')?.contract).toEqual({
      objective: 'Break the siege line then hold the hex',
      bonusSalvage: 100,
      bonusCores: 1,
    });
    expect(findHexRingDefinition('hex-r2-7')?.landmark).toBe('fortress');
  });

  it('mirrors the authored variety byte-for-value in the ring-2 CSV seed', () => {
    expect(definitionsFromCsv('hex-ring-2.csv')).toEqual(
      hexRingDefinitionsFor(2),
    );
  });

  it('leaves the authored aggression band unchanged, variety hexes at the floor', () => {
    expect(hexRingDefinitionsFor(2).map((hex) => hex.baseAggression)).toEqual([
      2, 2, 5, 2, 5, 2, 2, 5, 6, 2, 5, 8,
    ]);
    for (const id of ['hex-r2-1', 'hex-r2-6', 'hex-r2-7']) {
      const hex = findHexRingDefinition(id)!;
      expect(hex.baseAggression, `${id} stays at the survivable floor`).toBe(2);
      // `berserker` adds an aggression step, so it must never sit on a survivor.
      expect(hex.personality, `${id} is no berserker`).not.toBe('berserker');
    }
    // The strict weapon/aggression maximum is untouched by variety authoring.
    const weaponHex = hexRingDefinitionsFor(2).find((hex) => hex.weaponHex)!;
    expect(weaponHex.id).toBe('hex-r2-12');
    expect(weaponHex.baseAggression).toBe(8);
  });

  it('publishes the personality, contract and landmark in known-ahead intel before commitment', () => {
    const payload = {
      ...createDefaultPayload(4242),
      ring: createRingState(2, HEX_RING_DEFINITIONS),
    };
    const model = buildHexMapModel(payload);
    const byId = new Map(model.hexes.map((hex) => [hex.id, hex] as const));

    // Personality: id + the shared projectile-drag mechanic.
    const nebula = byId.get('hex-r2-1')!;
    expect(nebula.held).toBe(false);
    expect(nebula.personality).toBe('nebula');
    expect(nebula.personalityMechanics).toHaveLength(1);
    expect(nebula.personalityMechanics[0].kind).toBe('projectile-drag');
    expect(nebula.personalityMechanics[0].magnitude).toBe(
      NEBULA_PROJECTILE_DRAG,
    );

    // Contract: objective, bonus and the open status before capture.
    const contract = byId.get('hex-r2-6')!.contract;
    expect(contract).not.toBeNull();
    expect(contract?.objective).toBe('Break the siege line then hold the hex');
    expect(contract?.bonusSalvage).toBe(100);
    expect(contract?.bonusCores).toBe(1);
    expect(contract?.status).toBe('open');

    // Landmark: the fortress type and its zero-of-two progress.
    const fortress = byId.get('hex-r2-7')!;
    expect(fortress.landmark).toBe('fortress');
    expect(fortress.landmarkProgress).toEqual({
      passes: 0,
      required: FORTRESS_CAPTURE_PASSES,
    });
  });

  it('places the nebula on a weapon-granting hex so the drag is genuinely felt', () => {
    // `nebula` only tunes the boss's demonstrated volley, so it must sit on a
    // hex that grants a weapon. `hex-r2-1` grants `arc`.
    const nebulaHex = findHexRingDefinition('hex-r2-1')!;
    expect(nebulaHex.personality).toBe('nebula');
    expect(nebulaHex.grants).toBe('arc');
  });
});

describe('authored ring-1 variety resolves through the shipped modules', () => {
  /** A fresh war with ring 1 materialised from the authored data. */
  function ringOnePayload() {
    return {
      ...createDefaultPayload(7),
      ring: createRingState(1, HEX_RING_DEFINITIONS),
    };
  }

  /** The run's salvage at the boss-victory moment. */
  function victorySalvage(minerals = 30, cores = 0) {
    return runSalvageFromRun({
      runId: 'run-r1-variety',
      checkpointId: 'boss-victory',
      minerals,
      cores,
    });
  }

  it('holds the ring-1 fortress only on the second capture pass', () => {
    const first = resolveHexCapture(ringOnePayload(), {
      hexId: 'hex-r1-5',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });
    expect(first.ok).toBe(false);
    expect(first.reason).toBe('fortress-incomplete');
    expect(
      first.payload.ring.hexes.find((hex) => hex.id === 'hex-r1-5')!.held,
    ).toBe(false);

    const second = resolveHexCapture(first.payload, {
      hexId: 'hex-r1-5',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(0, 0),
      definitions: HEX_RING_DEFINITIONS,
    });
    expect(second.ok).toBe(true);
    const held = second.payload.ring.hexes.find(
      (hex) => hex.id === 'hex-r1-5',
    )!;
    expect(held.held).toBe(true);
    // The fortress keeps its grant: the set-piece adds a pass, not a tax.
    expect(held.grantedWeapon).toBe('core-bank');
  });

  it('banks the ring-1 contract bonus once and never on a replay', () => {
    const first = resolveHexCapture(ringOnePayload(), {
      hexId: 'hex-r1-4',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });
    expect(first.ok).toBe(true);
    expect(first.contractBonus).toEqual({ minerals: 60, cores: 1 });
    const captured = first.payload.ring.hexes.find(
      (hex) => hex.id === 'hex-r1-4',
    )!;
    expect(captured.contractFulfilled).toBe(true);
    expect(captured.grantedWeapon).toBe('ricochet');

    // A replayed capture adds nothing: the stored fulfilment marker is the
    // replay guard, so the bonus is banked exactly once.
    const replay = resolveHexCapture(first.payload, {
      hexId: 'hex-r1-4',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(0, 0),
      definitions: HEX_RING_DEFINITIONS,
    });
    expect(replay.contractBonus).toBeNull();
    expect(replay.payload.hangar.bankedMinerals).toBe(
      first.payload.hangar.bankedMinerals,
    );
    expect(replay.payload.hangar.bankedCores).toBe(
      first.payload.hangar.bankedCores,
    );
  });

  it('keeps ring-1 variety state through the field-presence save migration', () => {
    const storage = createInMemoryHangarWarStorage();
    const first = resolveHexCapture(ringOnePayload(), {
      hexId: 'hex-r1-4',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });
    const pass = resolveHexCapture(first.payload, {
      hexId: 'hex-r1-5',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(0, 0),
      definitions: HEX_RING_DEFINITIONS,
    });

    saveHangarWarPayload(pass.payload, storage);
    const loaded = loadHangarWarPayload(storage)!;
    expect(loaded).toEqual(pass.payload);
    const contract = loaded.ring.hexes.find((hex) => hex.id === 'hex-r1-4')!;
    expect(contract.contractFulfilled).toBe(true);
    const fortress = loaded.ring.hexes.find((hex) => hex.id === 'hex-r1-5')!;
    expect(fortress.capturePasses).toBe(1);
    expect(fortress.held).toBe(false);
  });
});

describe('generating the authored rings', () => {
  it('generates ring 1 and ring 2 at the design sizes', () => {
    const ringOne = generateRing(1, HEX_RING_DEFINITIONS);
    const ringTwo = generateRing(2, HEX_RING_DEFINITIONS);

    expect(ringOne.hexes).toHaveLength(ringSize(1));
    expect(ringTwo.hexes).toHaveLength(ringSize(2));
    expect(ringOne.hexes.map((hex) => hex.id).sort()).toEqual(
      hexRingDefinitionsFor(1).map((hex) => hex.id).sort(),
    );
    expect(ringTwo.hexes.map((hex) => hex.id).sort()).toEqual(
      hexRingDefinitionsFor(2).map((hex) => hex.id).sort(),
    );
  });

  it('publishes exactly one weapon hex per ring, and it is the hardest', () => {
    for (const ringIndex of [1, 2]) {
      const { hexes } = generateRing(ringIndex, HEX_RING_DEFINITIONS);
      const weaponHexes = hexes.filter((hex) => hex.weaponHex);
      expect(weaponHexes, `ring ${ringIndex} weapon hex`).toHaveLength(1);
      const hardest = Math.max(...hexes.map((hex) => hex.baseAggression));
      expect(weaponHexes[0].baseAggression).toBe(hardest);
      for (const hex of hexes.filter((other) => other.id !== weaponHexes[0].id)) {
        expect(
          hex.baseAggression,
          `${hex.id} is easier than the weapon hex`,
        ).toBeLessThan(weaponHexes[0].baseAggression);
      }
    }
  });

  it('generates ring 2 from data — every ring-2 coordinate is covered', () => {
    const ringTwo = generateRing(2, HEX_RING_DEFINITIONS);
    const generated = new Set(ringTwo.hexes.map((hex) => `${hex.q},${hex.r}`));
    for (const coordinate of ringCoordinates(2)) {
      expect(generated.has(`${coordinate.q},${coordinate.r}`)).toBe(true);
    }
  });

  it('generates rings 1–3 (6/12/18) when a ring-3 data row set is appended', () => {
    // No code mentions ring 3: the definitions below are *data*, built from
    // the generator's own geometry, exactly as authored CSV rows would be.
    const ringThree: HexRingDefinition[] = ringCoordinates(3).map(
      (coordinate, index) => {
        const weaponHex = index === ringCoordinates(3).length - 1;
        return {
          id: `hex-r3-${index + 1}`,
          q: coordinate.q,
          r: coordinate.r,
          ringIndex: 3,
          boss: `ring-3-boss-${index + 1}`,
          strengths: ['cannon'],
          weaknesses: ['nova'],
          grants: `ring-3-grant-${index + 1}`,
          weaponHex,
          baseAggression: weaponHex ? 12 : 7 + (index % 4),
        };
      },
    );

    const all = [...HEX_RING_DEFINITIONS, ...ringThree];
    expect(generateRing(1, all).size).toBe(6);
    expect(generateRing(2, all).size).toBe(12);
    expect(generateRing(3, all).size).toBe(18);
  });

  it('refuses to invent a ring the data does not describe', () => {
    expect(() => generateRing(3, HEX_RING_DEFINITIONS)).toThrow(
      HexRingDefinitionError,
    );
  });
});

/** Every authored hex flagged as a special mission, across both rings. */
function authoredSpecialMissionHexes(): HexRingDefinition[] {
  return HEX_RING_DEFINITIONS.filter(
    (hex) => hex.isSpecialMission === true,
  );
}

describe('authored special-mission content', () => {
  it('authors exactly one special-mission hex, and it is ring 2\'s hull-3 hex', () => {
    // One authored special mission is the contract (AH-0MWF0CTQB001XFE1 AC3);
    // pinning it by id keeps the authored content visible in the diff and
    // stops a later row quietly claiming the marker too.
    expect(authoredSpecialMissionHexes().map((hex) => hex.id)).toEqual([
      'hex-r2-3',
    ]);
    const special = authoredSpecialMissionHexes()[0];
    expect(special.ringIndex).toBe(2);
    expect(special.grants).toBe('hull-3');
  });

  it('pays the extra-hit-points hull, a real catalogue reward', () => {
    const special = authoredSpecialMissionHexes()[0];
    const reward = findHangarEntry(special.grants);
    const bulwark = findHangarEntry('hull-2');

    expect(reward?.kind).toBe('hull');
    expect(bulwark?.kind).toBe('hull');
    if (reward?.kind !== 'hull' || bulwark?.kind !== 'hull') return;
    // "Extra hit points" (Q2 = a): more lives than the buyable Bulwark Hull.
    expect(reward.runStats.startingLives).toBeGreaterThan(
      bulwark.runStats.startingLives,
    );
  });

  it('validates loudly and survives generation with the marker intact', () => {
    for (const ringIndex of [1, 2]) {
      expect(validateRingDefinitions(ringIndex, HEX_RING_DEFINITIONS)).toEqual({
        ok: true,
        issues: [],
      });
    }
    const generated = generateRing(2, HEX_RING_DEFINITIONS).hexes;
    expect(
      generated.find((hex) => hex.id === 'hex-r2-3')?.isSpecialMission,
    ).toBe(true);
    expect(
      generated.filter((hex) => hex.isSpecialMission === true),
    ).toHaveLength(1);
  });

  it('mirrors the marker in the ring-2 CSV seed', () => {
    const fromSeed = definitionsFromCsv('hex-ring-2.csv').filter(
      (hex) => hex.isSpecialMission === true,
    );
    expect(fromSeed.map((hex) => hex.id)).toEqual(['hex-r2-3']);
    expect(fromSeed[0].grants).toBe('hull-3');
    expect(
      definitionsFromCsv('hex-ring-1.csv').some(
        (hex) => hex.isSpecialMission === true,
      ),
    ).toBe(false);
  });
});

describe('CSV seeds carry the isSpecialMission column', () => {
  it.each([1, 2])('ring %i seed documents and uses the column', (ring) => {
    expect(readCsv(`hex-ring-${ring}.csv`)).toContain('isSpecialMission');
  });

  it('round-trips a seed whose rows carry the marker', () => {
    const flagged = ringOneWithSpecialMission();
    expect(definitionsFromCsvText(definitionsToCsv(flagged))).toEqual(flagged);
  });

  it('detects drift in the marker, so the parity test is not decorative', () => {
    const flagged = ringOneWithSpecialMission();
    // Same rows, opposite marker: the parity harness must see the difference.
    expect(definitionsFromCsvText(definitionsToCsv(authoredRingOne()))).not.toEqual(
      flagged,
    );
  });
});

describe('CSV seeds carry the optional hex-variety columns', () => {
  it('round-trips personality, contract and landmark through the seed parse', () => {
    const withVariety = authoredRingOne().map((hex, index) => {
      if (index === 0) return { ...hex, personality: 'nebula' as const };
      if (index === 1) {
        return {
          ...hex,
          contract: {
            objective: 'Break the siege line, then hold the hex',
            bonusSalvage: 120,
            bonusCores: 1,
          },
        };
      }
      if (index === 2) return { ...hex, landmark: 'fortress' as const };
      if (index === 3) return { ...hex, landmark: 'cache' as const };
      return hex;
    });
    expect(definitionsFromCsvText(definitionsToCsv(withVariety))).toEqual(
      withVariety,
    );
  });

  it('detects drift in the variety columns', () => {
    const withPersonality = authoredRingOne().map((hex, index) =>
      index === 0 ? { ...hex, personality: 'summoner' as const } : hex,
    );
    expect(
      definitionsFromCsvText(definitionsToCsv(authoredRingOne())),
    ).not.toEqual(withPersonality);
  });
});

describe('special-mission hex validation', () => {
  it('accepts a well-formed special-mission hex that grants a hull', () => {
    const definitions = ringOneWithSpecialMission();

    expect(validateRingDefinitions(1, definitions)).toEqual({
      ok: true,
      issues: [],
    });
    expect(() => generateRing(1, definitions)).not.toThrow();
    // The marker survives generation: the map/intel can read it back.
    expect(
      generateRing(1, definitions).hexes.find(
        (hex) => hex.id === SPECIAL_MISSION_HEX_ID,
      )?.isSpecialMission,
    ).toBe(true);
  });

  it('rejects a special-mission hex with an empty grant', () => {
    const definitions = ringOneWithSpecialMission({ grants: '' });
    const result = validateRingDefinitions(1, definitions);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain(
      'invalid-definition',
    );
    expect(result.issues.some((issue) => issue.message.includes('grant'))).toBe(
      true,
    );
    expect(() => generateRing(1, definitions)).toThrow(HexRingDefinitionError);
  });

  it('rejects a special-mission hex with no grant field at all', () => {
    const definitions = ringOneWithSpecialMission().map((hex) => {
      if (hex.id !== SPECIAL_MISSION_HEX_ID) return hex;
      const withoutGrant: Record<string, unknown> = { ...hex };
      delete withoutGrant.grants;
      return withoutGrant as unknown as HexRingDefinition;
    });
    const result = validateRingDefinitions(1, definitions);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain(
      'invalid-definition',
    );
    expect(() => generateRing(1, definitions)).toThrow(HexRingDefinitionError);
  });

  it('rejects a special-mission grant that is not a hull catalogue entry', () => {
    // `spread` is a catalogue weapon, `hardened_plating` a modifier, and the
    // last id is not in the catalogue at all — none can be a special reward.
    for (const grants of ['spread', 'hardened_plating', 'hull-does-not-exist']) {
      const definitions = ringOneWithSpecialMission({ grants });
      const result = validateRingDefinitions(1, definitions);

      expect(result.ok, grants).toBe(false);
      expect(result.issues.map((issue) => issue.kind), grants).toContain(
        'special-mission-grant-not-hull',
      );
      const issue = result.issues.find(
        (candidate) => candidate.kind === 'special-mission-grant-not-hull',
      );
      expect(issue?.hexId, grants).toBe(SPECIAL_MISSION_HEX_ID);
      expect(issue?.message, grants).toContain(grants);
      expect(() => generateRing(1, definitions), grants).toThrow(
        HexRingDefinitionError,
      );
    }
  });

  it('accepts any catalogue hull as the special reward, not just the newest', () => {
    // The rule is "a hull catalogue entry", so the starter hull qualifies too.
    expect(
      validateRingDefinitions(1, ringOneWithSpecialMission({ grants: 'hull-1' })),
    ).toEqual({ ok: true, issues: [] });
  });

  it('rejects a non-boolean isSpecialMission marker', () => {
    const definitions = authoredRingOne().map((hex) =>
      hex.id === SPECIAL_MISSION_HEX_ID
        ? { ...hex, isSpecialMission: 'yes' as unknown as boolean }
        : hex,
    );
    const result = validateRingDefinitions(1, definitions);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain(
      'invalid-definition',
    );
  });

  it('leaves ordinary hexes validating exactly as before', () => {
    // Absent and explicit `false` are the same thing: no marker, no hull rule —
    // `extra-life`/`waveLaser`-style non-hull grants stay legal on ordinary
    // hexes, so the shipped rings keep validating.
    expect(validateRingDefinitions(1, authoredRingOne())).toEqual({
      ok: true,
      issues: [],
    });
    const explicitFalse = authoredRingOne().map((hex) => ({
      ...hex,
      isSpecialMission: false,
    }));
    expect(validateRingDefinitions(1, explicitFalse)).toEqual({
      ok: true,
      issues: [],
    });
    expect(validateRingDefinitions(2, HEX_RING_DEFINITIONS)).toEqual({
      ok: true,
      issues: [],
    });
  });
});
