/**
 * Capture-cycle state-machine tests (AH-0MVUXCAW0001VUM6).
 *
 * The capture cycle is the heart of the outer loop, so these tests pin the
 * whole transition — win → bank → grant → defend, the defensive refusals, ring
 * securing/opening, and the loss forfeiture — against the **pure** module.
 * The scene wiring is pinned separately in `PlayScene.captureCycle.test.ts`.
 *
 * The ring content is the real authored table (`HEX_RING_DEFINITIONS`), so a
 * grant id or ring shape drifting in the data fails here rather than in the
 * game.
 */

import { describe, expect, it } from 'vitest';

import {
  defenderRatingFromSnapshot,
  deriveDefenderRating,
  findHangarEntry,
} from './hangarEconomy';
import * as hangarEconomyModule from './hangarEconomy';
import { buyHangarUpgrade, createDefaultPayload } from './hangarWarStore';
import {
  HANGAR_WAR_VERSION,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from './hangarWarStore';
import { createInMemoryHangarWarStorage } from './storage';
import { createRingState } from './hexRing';
import {
  DEFAULT_FRONTIER_TUNING,
  createFrontierClock,
  resolveHangarAssault,
  runFrontierTick,
} from './hexDefence';
import { createBankedSalvage, runSalvageFromRun } from './salvageBanking';
import type { HangarWarPayload, HexDefender, HexState } from './types';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { PowerUpId } from '../../powerups/types';
import type { WeaponId } from '../../utils/weapons';
import { buildHangarDeployment } from '../../scenes/hangarWar/hangarDeployment';
import {
  campaignResetSeed,
  defenderSkillsFor,
  grantDemonstrationColor,
  hangarAssaultSeed,
  isRingSecured,
  leaveDefender,
  materialiseRing,
  openNextRing,
  resolveDeploymentDefeat,
  resolveGrantAlias,
  resolveHexCapture,
  resolveHexGrant,
  withGrantedEntry,
} from './captureCycle';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';

/** A fresh war with ring `ringIndex` materialised from the authored data. */
function ringPayload(ringIndex = 1): HangarWarPayload {
  return {
    ...createDefaultPayload(7),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

/** The hex in `payload` with `hexId`. */
function hex(payload: HangarWarPayload, hexId: string): HexState {
  const found = payload.ring.hexes.find((state) => state.id === hexId);
  if (!found) throw new Error(`no hex ${hexId}`);
  return found;
}

/** A run snapshot at the boss-victory moment. */
function victorySalvage(minerals = 40, cores = 2) {
  return runSalvageFromRun({
    runId: 'run-7',
    checkpointId: 'boss-victory',
    minerals,
    cores,
  });
}

/** Marks every hex held with a defender, so only one capture remains. */
function holdAllBut(payload: HangarWarPayload, lastHexId: string): void {
  for (const state of payload.ring.hexes) {
    if (state.id === lastHexId) continue;
    state.held = true;
    state.bossDefeated = true;
    state.defender = {
      hullId: 'hull-1',
      defenceRating: deriveDefenderRating('hull-1'),
      bankedMinerals: 0,
    };
  }
}

describe('resolveHexGrant', () => {
  it('maps an authored weapon spelling to its hangar catalogue entry', () => {
    const grant = resolveHexGrant('waveLaser');
    expect(grant).toEqual({
      grantId: 'waveLaser',
      entryId: 'wave_laser',
      kind: 'weapon',
      weaponId: 'wave_laser',
    });
  });

  it('maps an authored upgrade spelling to its hangar modifier entry', () => {
    expect(resolveHexGrant('extra-life')).toEqual({
      grantId: 'extra-life',
      entryId: 'hardened_plating',
      kind: 'modifier',
      weaponId: null,
    });
  });

  // Red-first (AH-0MWWI3JYN001SPVA, parent AC7): this replaces the old spec
  // that *protected* the catalogue-unknown fallback. Every authored grant now
  // resolves to a real catalogue entry (AH-0MWWARIW6003F7OV modelled the last
  // three ring-2 modifier grants as hull-training moder entries).
  it('resolves every authored hex grant through the catalogue, never the unknown fallback', () => {
    for (const definition of HEX_RING_DEFINITIONS) {
      const authored = definition.grants;
      if (typeof authored !== 'string' || authored.trim() === '') continue;

      const grant = resolveHexGrant(authored);
      expect(grant, `authored grant ${authored} (${definition.id})`).not.toBeNull();
      // `findHangarEntry` is the same lookup the hangar screen and the loadout
      // use: a null here is exactly the catalogue-unknown fallback that made a
      // granted weapon invisible.
      expect(
        findHangarEntry(grant!.entryId, HANGAR_CATALOGUE),
        `catalogue entry for authored grant ${authored} (${definition.id})`,
      ).not.toBeNull();
    }
  });

  it('keeps the catalogue-unknown fallback as defence-in-depth (non-authored ids)', () => {
    // Authored ring data never reaches the fallback any more, but it stays so
    // an owned-but-unitemised id is recorded rather than silently dropped.
    expect(resolveHexGrant('core-bank')).toMatchObject({
      entryId: 'core-bank',
      kind: 'modifier',
      weaponId: null,
    });
    expect(resolveHexGrant('hull-9')).toMatchObject({
      entryId: 'hull-9',
      kind: 'hull',
      weaponId: null,
    });
    // `cannon` is permanently excluded from the unlock tree, so it exercises
    // the shipped-weapon branch of the fallback for a non-authored grant.
    expect(resolveHexGrant('cannon')).toMatchObject({
      entryId: 'cannon',
      kind: 'weapon',
      weaponId: 'cannon',
    });
  });

  it('is total: a blank grant resolves to nothing', () => {
    expect(resolveHexGrant(null)).toBeNull();
    expect(resolveHexGrant('   ')).toBeNull();
    expect(resolveHexGrant(42)).toBeNull();
  });
});

describe('resolveGrantAlias', () => {
  // The alias table is shared: the display matchup resolver reads this same
  // helper (AH-0MWMT4NJV001PX8Y), so the capture cycle and the screen cannot
  // drift into two tables.
  it('resolves the authored weapon spelling to its catalogue entry', () => {
    expect(resolveGrantAlias('waveLaser')).toEqual({
      entryId: 'wave_laser',
      kind: 'weapon',
      weaponId: 'wave_laser',
    });
  });

  it('agrees with the grant resolver for every aliased spelling', () => {
    for (const id of ['waveLaser', 'extra-life']) {
      const alias = resolveGrantAlias(id);
      const grant = resolveHexGrant(id);
      expect(alias).not.toBeNull();
      expect(grant).not.toBeNull();
      expect(grant!.entryId).toBe(alias!.entryId);
      expect(grant!.kind).toBe(alias!.kind);
      expect(grant!.weaponId).toBe(alias!.weaponId ?? null);
    }
  });

  it('has no alias for a canonical or unknown id', () => {
    expect(resolveGrantAlias('wave_laser')).toBeNull();
    expect(resolveGrantAlias('not-an-entry')).toBeNull();
    expect(resolveGrantAlias(null)).toBeNull();
    expect(resolveGrantAlias('   ')).toBeNull();
    expect(resolveGrantAlias(7)).toBeNull();
  });
});

describe('leaveDefender', () => {
  it('derives the stored rating from the chosen hull’s hangar upgrades', () => {
    const payload = ringPayload();
    payload.hangar.unlockedHulls.push('hull-2');

    const defender = leaveDefender(payload.hangar, 'hull-2', 12);

    expect(defender).not.toBeNull();
    expect(defender!.hullId).toBe('hull-2');
    // One formula, shared with the ring resolver (no second source of truth).
    expect(defender!.defenceRating).toBe(deriveDefenderRating('hull-2'));
    expect(defender!.defenceRating).toBe(14);
    expect(defender!.bankedMinerals).toBe(12);
  });

  it('requires a hull the fleet owns and the catalogue knows', () => {
    const payload = ringPayload();
    // hull-2 exists but is not owned by a fresh fleet, and nothing else is a hull.
    expect(leaveDefender(payload.hangar, 'hull-2')).toBeNull();
    expect(leaveDefender(payload.hangar, 'not-a-hull')).toBeNull();
    expect(leaveDefender(payload.hangar, null)).toBeNull();
    expect(leaveDefender(payload.hangar, 'hull-1')).not.toBeNull();
  });
});

describe('leaveDefender — special skills (AH-0MVWZYJ740037EZ1)', () => {
  it('omits the skill field entirely when the bot has no skills (additive data)', () => {
    const payload = ringPayload();

    const defender = leaveDefender(payload.hangar, 'hull-1');

    expect(defender).not.toBeNull();
    // Field presence stays exact: an old-shaped defender is never widened.
    expect('skills' in defender!).toBe(false);
  });

  it('attaches the hull flown’s authored skill', () => {
    const payload = ringPayload();
    payload.hangar.unlockedHulls.push('hull-2');

    const defender = leaveDefender(payload.hangar, 'hull-2');

    // The other half of the composition: what the hull itself is trained against.
    expect(defender?.skills).toBeDefined();
    expect(defender!.skills).toHaveLength(1);
    expect(defender!.skills![0]).toMatchObject({
      bossType: 'the-dawnbreaker',
      bonus: 4,
    });
    // The stored rating is unchanged — a skill is applied by the resolver, not
    // baked into the number the player sees.
    expect(defender!.defenceRating).toBe(deriveDefenderRating('hull-2'));
  });

  it('adds a purchased modifier’s skill beside the hull’s (both may coexist)', () => {
    const payload = ringPayload();
    payload.hangar.unlockedHulls.push('hull-2');
    payload.hangar.ownedModifiers.push('anti_maw_plating');
    payload.hangar.activeLoadout = {
      startingWeapons: [],
      modifiers: ['anti_maw_plating'],
    };

    const defender = leaveDefender(payload.hangar, 'hull-2');

    expect(defender!.skills!.map((skill) => skill.bossType).sort()).toEqual([
      'maw-of-ashes',
      'the-dawnbreaker',
    ]);
  });

  it('grants no modifier skill unless the modifier is on the active loadout', () => {
    const payload = ringPayload();
    // Owned but not equipped: owning a modifier never silently changes what the
    // fleet deploys with, so it cannot change what a bot is trained against.
    payload.hangar.ownedModifiers.push('anti_maw_plating');

    const defender = leaveDefender(payload.hangar, 'hull-1');

    expect('skills' in defender!).toBe(false);
  });

  it('collapses a skill granted twice to one entry (no double-stacking)', () => {
    const payload = ringPayload();
    payload.hangar.unlockedHulls.push('hull-2');
    payload.hangar.ownedModifiers.push('anti_maw_plating');
    payload.hangar.activeLoadout = {
      startingWeapons: [],
      modifiers: ['anti_maw_plating'],
    };

    const catalogue = [...HANGAR_CATALOGUE];
    const bulwark = catalogue.find((item) => item.id === 'hull-2');
    const plating = catalogue.find((item) => item.id === 'anti_maw_plating');
    if (bulwark?.kind !== 'hull' || plating?.kind !== 'modifier') {
      throw new Error('shipped catalogue shape changed');
    }
    expect(plating.effect.kind).toBe('defence-skill');
    // A hull and a modifier authoring the same training id would otherwise add
    // the bonus twice.
    const shared = { id: 'shared-training', name: 'Shared', bossType: 'x', bonus: 2 };
    catalogue[catalogue.indexOf(bulwark)] = { ...bulwark, skill: shared };
    catalogue[catalogue.indexOf(plating)] = {
      ...plating,
      effect: { kind: 'defence-skill', skill: shared },
    };

    const skills = defenderSkillsFor(payload.hangar, 'hull-2', catalogue);

    expect(skills).toHaveLength(1);
    expect(skills[0].id).toBe('shared-training');
  });
});

describe('resolveHexCapture — the win path', () => {
  it('banks the salvage, holds the hex, grants its entry and leaves a defender', () => {
    const payload = ringPayload();
    const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-1',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(40, 2),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    // The input is never mutated (a pure resolution).
    expect(payload).toEqual(before);

    // 1. Salvage banked into the persistent balance.
    expect(result.payload.hangar.bankedMinerals).toBe(40);
    expect(result.payload.hangar.bankedCores).toBe(2);
    expect(result.bankedDelta).toEqual({ minerals: 40, cores: 2 });

    // 2. The hex is captured with its authored grant recorded (Rule 2).
    const captured = hex(result.payload, 'hex-r1-1');
    expect(captured.held).toBe(true);
    expect(captured.bossDefeated).toBe(true);
    expect(captured.grantedWeapon).toBe('hull-2');
    expect(result.grant).toMatchObject({ entryId: 'hull-2', kind: 'hull' });
    expect(result.payload.hangar.unlockedHulls).toContain('hull-2');

    // 3. A defender who exists, with the rating derived from the hull.
    expect(captured.defender).toEqual({
      hullId: 'hull-1',
      defenceRating: deriveDefenderRating('hull-1'),
      bankedMinerals: 40,
    });
    expect(result.defender).toEqual(captured.defender);
  });

  it('grants the ring’s new weapon only after its boss is beaten (Rule 2)', () => {
    const payload = ringPayload();
    expect(payload.hangar.unlockedWeapons).not.toContain('wave_laser');

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(10, 0),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.payload.hangar.unlockedWeapons).toContain('wave_laser');
    expect(hex(result.payload, 'hex-r1-6').grantedWeapon).toBe('waveLaser');
    // The boss demonstrates the weapon it grants (its colour cue).
    expect(result.grant!.weaponId).toBe('wave_laser');
  });

  it('never double-banks salvage the run already banked', () => {
    const payload = ringPayload();
    const salvage = victorySalvage(40, 2);

    const first = resolveHexCapture(payload, {
      hexId: 'hex-r1-1',
      defenderHullId: 'hull-1',
      salvage,
      definitions: HEX_RING_DEFINITIONS,
    });
    const replay = resolveHexCapture(payload, {
      hexId: 'hex-r1-1',
      defenderHullId: 'hull-1',
      salvage,
      definitions: HEX_RING_DEFINITIONS,
      banked: first.banked,
    });

    expect(replay.ok).toBe(true);
    expect(replay.bankedDelta).toEqual({ minerals: 0, cores: 0 });
    expect(replay.payload.hangar.bankedMinerals).toBe(40);
  });

  it('refuses to hold a hex without a defender, but still banks the salvage', () => {
    const payload = ringPayload();

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-1',
      defenderHullId: null,
      salvage: victorySalvage(40, 2),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('defender-required');
    const state = hex(result.payload, 'hex-r1-1');
    expect(state.held).toBe(false);
    expect(state.bossDefeated).toBe(false);
    expect(state.grantedWeapon).toBeNull();
    expect(state.defender).toBeNull();
    // A victory always extracts the salvage it earned.
    expect(result.payload.hangar.bankedMinerals).toBe(40);
    // Rule 2 is not broken by a refused capture: nothing entered the fleet.
    expect(result.grant).toBeNull();
    expect(result.payload.hangar.unlockedHulls).not.toContain('hull-2');
  });

  it('refuses a defender the fleet does not own', () => {
    const result = resolveHexCapture(ringPayload(), {
      hexId: 'hex-r1-1',
      defenderHullId: 'hull-2',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('defender-required');
    expect(hex(result.payload, 'hex-r1-1').held).toBe(false);
  });

  it('reports an unknown hex instead of inventing one', () => {
    const result = resolveHexCapture(ringPayload(), {
      hexId: 'hex-not-here',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown-hex');
    expect(result.payload.ring.hexes).toHaveLength(6);
  });
});

describe('ring securing', () => {
  it('secures the ring on its last hex, repels the assault and opens ring 2', () => {
    const payload = ringPayload();
    // Strong stored defenders so the ring's massed assault is repelled — the
    // win path now runs through the gate (AH-0MWEZZ9TE001577J).
    holdAllBut(payload, 'hex-r1-6');
    for (const state of payload.ring.hexes) {
      if (state.id === 'hex-r1-6' || !state.defender) continue;
      state.defender = { ...state.defender, defenceRating: 20 };
    }

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(5, 1),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.assault?.outcome).toBe('repelled');
    expect(result.ringSecured).toBe(true);
    expect(result.campaignReset).toBe(false);
    expect(result.ringAdvanced).toBe(true);
    expect(result.ringIndex).toBe(2);

    // Ring 2 is playable at once: twelve generated, unheld hexes, carried
    // alongside the six held hexes of ring 1 (nothing is discarded).
    expect(result.payload.ring.ringIndex).toBe(2);
    expect(result.payload.ring.hexes).toHaveLength(18);
    const ringTwo = result.payload.ring.hexes.filter((state) =>
      state.id.startsWith('hex-r2-'),
    );
    expect(ringTwo).toHaveLength(12);
    expect(ringTwo.every((state) => !state.held)).toBe(true);
    const ringOne = result.payload.ring.hexes.filter((state) =>
      state.id.startsWith('hex-r1-'),
    );
    expect(ringOne).toHaveLength(6);
    expect(ringOne.every((state) => state.held)).toBe(true);
    // The repelled assault resolves, it does not queue an attack.
    expect(result.payload.pendingAttacks).toEqual([]);
  });

  // ── The rush line (AH-0MVXSHAS100010S0 — AC8 gap) ──────────────

  it('opens the next ring when only the capstone (weapon) hex is held', () => {
    const payload = ringPayload();
    // hex-r1-6 is ring 1's authored weaponHex (its hardest hex).
    const capstone = 'hex-r1-6';

    const result = resolveHexCapture(payload, {
      hexId: capstone,
      defenderHullId: 'hull-1',
      salvage: victorySalvage(5, 1),
      definitions: HEX_RING_DEFINITIONS,
    });

    // The rush is playable: the weapon hex alone opens ring 2 ...
    expect(result.ok).toBe(true);
    expect(result.ringAdvanced).toBe(true);
    expect(result.ringIndex).toBe(2);
    // ... while the ring is emphatically NOT secured (five hexes unheld) ...
    expect(result.ringSecured).toBe(false);
    // ... and the hexes the rush skipped are carried, not discarded.
    const skipped = result.payload.ring.hexes.filter(
      (state) => state.id.startsWith('hex-r1-') && state.id !== capstone,
    );
    expect(skipped).toHaveLength(5);
    expect(skipped.every((state) => state.held === false)).toBe(true);
    // The captured capstone keeps its held state and its defending bot.
    const held = result.payload.ring.hexes.find((state) => state.id === capstone)!;
    expect(held.held).toBe(true);
    expect(held.defender?.hullId).toBe('hull-1');
  });

  it('does not open the next ring from a non-capstone hex', () => {
    const payload = ringPayload();

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-2',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(5, 1),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.ringSecured).toBe(false);
    expect(result.ringAdvanced).toBe(false);
    expect(result.payload.ring.ringIndex).toBe(1);
  });

  it('keeps isRingSecured ring-scoped after a rush (ring 2 secured, ring 1 not)', () => {
    const rushed = resolveHexCapture(ringPayload(), {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(5, 1),
      definitions: HEX_RING_DEFINITIONS,
    }).payload;

    // Ring 1 still has five unheld hexes, but the current ring is ring 2.
    expect(isRingSecured(rushed.ring)).toBe(false);

    const securedRingTwo = {
      ...rushed.ring,
      hexes: rushed.ring.hexes.map((state) =>
        state.id.startsWith('hex-r2-') ? { ...state, held: true } : state,
      ),
    };
    expect(isRingSecured(securedRingTwo)).toBe(true);
  });

  it('falls back to the all-held rule when the ring authors no capstone', () => {
    const payload = ringPayload();
    const withoutCapstone = HEX_RING_DEFINITIONS.map((definition) =>
      definition.ringIndex === 1 ? { ...definition, weaponHex: false } : definition,
    );
    holdAllBut(payload, 'hex-r1-6');

    // Five of six held with no authored capstone: not openable yet.
    expect(
      openNextRing(payload, withoutCapstone).opened,
    ).toBe(false);

    const allHeld = {
      ...payload,
      ring: { ...payload.ring, hexes: payload.ring.hexes.map((state) => ({ ...state, held: true })) },
    };
    expect(openNextRing(allHeld, withoutCapstone).opened).toBe(true);
  });

  it('does not advance to a ring that has no authored definitions', () => {
    const payload = ringPayload();
    holdAllBut(payload, 'hex-r1-6');
    // Strong stored defenders so the ring-end assault is repelled and the
    // test still isolates the unauthored-successor rule.
    for (const state of payload.ring.hexes) {
      if (state.defender) state.defender = { ...state.defender, defenceRating: 20 };
    }

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      // Only ring 1 is authored here, so ring 2 cannot be generated.
      definitions: HEX_RING_DEFINITIONS.filter((entry) => entry.ringIndex === 1),
    });

    expect(result.assault?.outcome).toBe('repelled');
    expect(result.ringSecured).toBe(true);
    expect(result.ringAdvanced).toBe(false);
    expect(result.payload.ring.ringIndex).toBe(1);
  });

  it('does not secure a ring with an unheld hex, and an empty ring is not secured', () => {
    const payload = ringPayload();
    const secured = { ...payload.ring, hexes: payload.ring.hexes.map((state) => ({ ...state, held: true })) };
    expect(isRingSecured(secured)).toBe(true);
    expect(isRingSecured(payload.ring)).toBe(false);
    expect(isRingSecured({ ringIndex: 1, hexes: [] })).toBe(false);

    expect(openNextRing(payload, HEX_RING_DEFINITIONS)).toMatchObject({
      opened: false,
      ringIndex: 1,
    });
  });
});

describe('resolveDeploymentDefeat — the loss path', () => {
  it('forfeits only the unbanked salvage for a starter-kit fleet', () => {
    const payload = ringPayload();
    hex(payload, 'hex-r1-1').held = true;
    const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;

    const result = resolveDeploymentDefeat(payload, {
      salvage: runSalvageFromRun({
        runId: 'run-7',
        checkpointId: 'run-end',
        minerals: 60,
        cores: 1,
      }),
    });

    // The run earns 60/1 and has banked nothing yet, so all of it is forfeit.
    expect(result.forfeited).toEqual({ minerals: 60, cores: 1 });
    // A starter-kit fleet has no bought ship to spend, so the payload is
    // unchanged (the ring and banked balances always survive a loss).
    expect(result.payload).toEqual(before);
    expect(result.banked.minerals).toBe(0);
  });

  it('spends a bought ship on a loss (ownership only, level rows survive)', () => {
    const payload = boughtShipPayload();

    const result = resolveDeploymentDefeat(payload, {
      salvage: runSalvageFromRun({
        runId: 'run-7',
        checkpointId: 'run-end',
        minerals: 60,
        cores: 1,
      }),
    });

    expect(result.payload.hangar.unlockedHulls).not.toContain('hull-2');
    expect(result.payload.hangar.unlockedWeapons).not.toContain('wave_laser');
    expect(result.payload.hangar.ownedModifiers).not.toContain(
      'hardened_plating',
    );
    expect(result.payload.hangar.activeHull).toBe('hull-1');
    // The flown weapon's bought level row survives — consumption spends
    // ownership only — while the un-flown spare rows are untouched.
    expect(result.payload.hangar.weaponLevels).toEqual([
      { id: 'wave_laser', level: 3 },
      { id: 'ricochet', level: 2 },
    ]);
    // The un-flown spare parts and both balances survive.
    expect(result.payload.hangar.unlockedHulls).toContain('hull-3');
    expect(result.payload.hangar.unlockedWeapons).toContain('ricochet');
    expect(result.payload.hangar.ownedModifiers).toContain('anti_maw_plating');
    expect(result.payload.hangar.bankedMinerals).toBe(500);
    expect(result.payload.hangar.bankedCores).toBe(5);
  });
});

/**
 * A ring-1 war with a bought, fully-equipped ship (the ship a deployment
 * flies) plus un-flown spare parts and bought permanent levels.
 */
function boughtShipPayload(): HangarWarPayload {
  const payload = ringPayload();
  payload.hangar.bankedMinerals = 500;
  payload.hangar.bankedCores = 5;
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
    { id: 'ricochet', level: 2 },
  ];
  payload.hangar.powerUpLevels = [{ id: 'shield', level: 2 }];
  return payload;
}

describe('the capture spends exactly the flown ship (AH-0MWL5PAP2001XYYF)', () => {
  it('uses an explicit ship input rather than the hangar’s active ship', () => {
    const payload = boughtShipPayload();
    payload.hangar.activeHull = 'hull-3';
    payload.hangar.activeLoadout = {
      startingWeapons: ['ricochet'],
      modifiers: ['anti_maw_plating'],
    };

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-3',
      defenderHullId: 'hull-2',
      ship: {
        hullId: 'hull-2',
        startingWeapons: ['wave_laser'],
        modifiers: ['hardened_plating'],
      },
      salvage: victorySalvage(0, 0),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    // The ship the battle actually flew is spent …
    expect(result.payload.hangar.unlockedHulls).not.toContain('hull-2');
    expect(result.payload.hangar.unlockedWeapons).not.toContain('wave_laser');
    expect(result.payload.hangar.ownedModifiers).not.toContain(
      'hardened_plating',
    );
    // … not the (different) ship the hangar had active.
    expect(result.payload.hangar.unlockedHulls).toContain('hull-3');
    expect(result.payload.hangar.unlockedWeapons).toContain('ricochet');
    expect(result.payload.hangar.ownedModifiers).toContain('anti_maw_plating');
  });

  it('spends nothing on a refused capture (no defender is not a completed battle)', () => {
    const payload = boughtShipPayload();

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-3',
      defenderHullId: null,
      salvage: victorySalvage(0, 0),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('defender-required');
    expect(result.payload.hangar.unlockedHulls).toContain('hull-2');
    expect(result.payload.hangar.unlockedWeapons).toContain('wave_laser');
    expect(result.payload.hangar.ownedModifiers).toContain('hardened_plating');
    expect(result.payload.hangar.activeHull).toBe('hull-2');
  });
});

describe('materialiseRing', () => {
  it('generates a fresh war’s empty ring from the authored data', () => {
    const fresh = createDefaultPayload(7);
    expect(fresh.ring.hexes).toHaveLength(0);

    const materialised = materialiseRing(fresh, HEX_RING_DEFINITIONS);

    expect(materialised.ring.hexes).toHaveLength(6);
    expect(materialised.ring.ringIndex).toBe(1);
    // The caller's payload is untouched.
    expect(fresh.ring.hexes).toHaveLength(0);
  });

  it('never pads or discards a partial ring', () => {
    const payload = ringPayload();
    payload.ring.hexes = payload.ring.hexes.slice(0, 2);

    const materialised = materialiseRing(payload, HEX_RING_DEFINITIONS);

    expect(materialised.ring.hexes).toHaveLength(2);
  });
});

describe('withGrantedEntry and the demonstration colour', () => {
  it('records an entry once (idempotent) without mutating the hangar', () => {
    const payload = ringPayload();
    const grant = resolveHexGrant('waveLaser')!;

    const once = withGrantedEntry(payload.hangar, grant);
    const twice = withGrantedEntry(once, grant);

    expect(once.unlockedWeapons.filter((id) => id === 'wave_laser')).toHaveLength(1);
    expect(twice.unlockedWeapons).toEqual(once.unlockedWeapons);
    expect(payload.hangar.unlockedWeapons).not.toContain('wave_laser');
  });

  it('paints the boss in the demonstrated weapon’s colour, and nothing otherwise', () => {
    expect(grantDemonstrationColor(resolveHexGrant('rapid'))).toBe(
      grantDemonstrationColor(resolveHexGrant('rapid')),
    );
    expect(grantDemonstrationColor(resolveHexGrant('rapid'))).not.toBeNull();
    expect(grantDemonstrationColor(resolveHexGrant('hull-2'))).toBeNull();
    expect(grantDemonstrationColor(null)).toBeNull();
  });
});

// ── The ring-end hangar assault gate (AH-0MWEZZ9TE001577J) ──────────
//
// Test-first slice for `AH-0MVUVL2O2006W4QK` AC2: the capture cycle now
// resolves the AI's massed hangar assault from the ring's stored numbers when
// its final hex is captured. A repel wins the ring and opens the next one; a
// fall is the hangar-falls lose state and resets the whole campaign. The rush
// line and a hex falling in a normal frontier tick stay reset-free.

describe('the capture-cycle assault gate', () => {
  // The shipped ±10 % jitter is real (and separately pinned in
  // `hexDefence.test.ts`), so these tests zero it to pin the gate's arithmetic
  // exactly; determinism with the shipped jitter is asserted separately.
  const NO_JITTER = { ...DEFAULT_FRONTIER_TUNING, jitterPercent: 0 };

  /** Holds every hex but the last, each defended at `rating`. */
  function holdAllButWithRating(
    payload: HangarWarPayload,
    lastHexId: string,
    rating: number,
  ): void {
    for (const state of payload.ring.hexes) {
      if (state.id === lastHexId) continue;
      state.held = true;
      state.bossDefeated = true;
      state.defender = { hullId: 'hull-1', defenceRating: rating, bankedMinerals: 0 };
    }
  }

  /** Captures ring 1's final hex (`hex-r1-6`) — the assault-gate seam. */
  function finalCapture(payload: HangarWarPayload, tuning = NO_JITTER) {
    return resolveHexCapture(payload, {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(5, 1),
      definitions: HEX_RING_DEFINITIONS,
      tuning,
    });
  }

  /** A stocked campaign, so a reset's breadth is observable. */
  function stockedPayload(): HangarWarPayload {
    const payload = ringPayload();
    payload.hangar.bankedMinerals = 900;
    payload.hangar.bankedCores = 12;
    payload.hangar.unlockedHulls.push('hull-2');
    payload.hangar.unlockedWeapons.push('wave_laser');
    payload.hangar.ownedModifiers.push('hardened_plating');
    payload.pendingAttacks = [{ hexId: 'hex-r1-1', force: 3 }];
    payload.bestScore = 18200;
    payload.frontierTick = 4;
    return payload;
  }

  // Ring 1's authored stored aggression: 1 + 1 + 3 + 2 + 4 + 6 = 17 (mean
  // 2.83, which the assault resolver rounds to 3). Lowered from 18 by
  // AH-0MWW28ET2002PNI8 (`hex-r1-1` 2 → 1).
  const RING_ONE_AGGRESSION_SUM = 17;

  describe('AC1 — the final-hex capture triggers the assault', () => {
    it('resolves the massed assault from the ring’s stored numbers', () => {
      const payload = ringPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 10);

      const result = finalCapture(payload);
      const assault = result.assault;

      expect(assault).not.toBeNull();
      // Defender side: five stored 10-rated bots plus the fresh hull-1 (2)
      // defending the hex just captured.
      expect(assault!.defenderSum).toBe(5 * 10 + deriveDefenderRating('hull-1'));
      // Attacker side: the ring's stored aggression sum, its average as the
      // multiplier's driver, exactly the hex resolver's 15 %/point rule.
      expect(assault!.attackerBase).toBe(RING_ONE_AGGRESSION_SUM);
      expect(assault!.aggression).toBe(3);
      expect(assault!.aggressionMultiplierPercent).toBe(145);
      // round(17 × 145 × 100 / 10000) = round(24.65) = 25.
      expect(assault!.attackStrength).toBe(25);
      expect(assault!.margin).toBe(52 - 25);
      expect(assault!.outcome).toBe('repelled');
    });

    it('is the shared resolver’s deterministic decision on the same seeded stream', () => {
      const payload = ringPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 10);
      const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;

      const first = finalCapture(payload);
      const replay = finalCapture(JSON.parse(JSON.stringify(before)));

      // A replay of the same stored numbers reproduces the assault exactly.
      expect(first.assault).toEqual(replay.assault);
      expect(first.assault).toEqual(
        resolveHangarAssault(
          {
            defenderSum: 52,
            attackerBase: RING_ONE_AGGRESSION_SUM,
            aggression: 3,
            seed: hangarAssaultSeed(payload),
          },
          NO_JITTER,
        ),
      );
      // ... and the caller's payload is never mutated.
      expect(payload).toEqual(before);
    });

    it('returns the assault record even with the shipped jitter, reproducibly', () => {
      const payload = ringPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 10);

      const shipped = finalCapture(payload, DEFAULT_FRONTIER_TUNING);
      const replay = finalCapture(payload, DEFAULT_FRONTIER_TUNING);

      expect(shipped.assault).toEqual(replay.assault);
      expect(shipped.assault!.jitterPercent).toBeGreaterThanOrEqual(-10);
      expect(shipped.assault!.jitterPercent).toBeLessThanOrEqual(10);
    });

    it('does not trigger an assault while hexes of the ring remain unheld', () => {
      const payload = ringPayload();

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-2',
        defenderHullId: 'hull-1',
        salvage: victorySalvage(5, 1),
        definitions: HEX_RING_DEFINITIONS,
        tuning: NO_JITTER,
      });

      expect(result.ok).toBe(true);
      expect(result.ringSecured).toBe(false);
      expect(result.assault).toBeNull();
      expect(result.campaignReset).toBe(false);
    });

    it('never fires on a refused capture (no defender ⇒ no held hex)', () => {
      const payload = ringPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 10);

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-6',
        defenderHullId: 'hull-9',
        salvage: victorySalvage(),
        definitions: HEX_RING_DEFINITIONS,
        tuning: NO_JITTER,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe('defender-required');
      expect(result.assault).toBeNull();
      expect(result.campaignReset).toBe(false);
    });
  });

  describe('AC2 — a repelled assault wins the ring and opens the next one', () => {
    it('marks the ring won and opens the next ring exactly as openNextRing does', () => {
      const payload = ringPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 10);

      const result = finalCapture(payload);

      expect(result.ok).toBe(true);
      expect(result.assault?.outcome).toBe('repelled');
      expect(result.ringSecured).toBe(true);
      expect(result.campaignReset).toBe(false);
      expect(result.ringAdvanced).toBe(true);
      expect(result.ringIndex).toBe(2);
      // The opened ring is ring 2's twelve generated, unheld hexes, carried
      // alongside ring 1's six held hexes (nothing is discarded).
      expect(result.payload.ring.ringIndex).toBe(2);
      const ringTwo = result.payload.ring.hexes.filter((state) =>
        state.id.startsWith('hex-r2-'),
      );
      expect(ringTwo).toHaveLength(12);
      expect(ringTwo.every((state) => !state.held)).toBe(true);
      const ringOne = result.payload.ring.hexes.filter((state) =>
        state.id.startsWith('hex-r1-'),
      );
      expect(ringOne.every((state) => state.held)).toBe(true);
      // A win is not a reset: the campaign's seed, hangar and score survive.
      expect(result.payload.seed).toBe(payload.seed);
      expect(result.payload.bestScore).toBe(payload.bestScore);
      expect(result.payload.hangar.bankedMinerals).toBe(5);
      expect(result.payload.hangar.bankedCores).toBe(1);
      expect(result.payload.pendingAttacks).toEqual([]);
    });

    it('holds the line on an exact tie: margin 0 repels, the hangar survives', () => {
      const payload = ringPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 0);
      // One hex carries the frontier's pressure: base 2, average 0 (rounded),
      // so the strength is 2 — exactly the fresh defender's rating.
      for (const state of payload.ring.hexes) state.aggression = 0;
      hex(payload, 'hex-r1-2').aggression = 2;

      const result = finalCapture(payload);

      expect(result.assault).toMatchObject({
        defenderSum: deriveDefenderRating('hull-1'),
        attackerBase: 2,
        aggression: 0,
        attackStrength: deriveDefenderRating('hull-1'),
        margin: 0,
        outcome: 'repelled',
      });
      expect(result.campaignReset).toBe(false);
      expect(result.ringAdvanced).toBe(true);
    });
  });

  describe('AC3 — a failed assault resets the whole campaign', () => {
    it('wipes the hangar and the ring together, issues a fresh seed and keeps bestScore', () => {
      const payload = stockedPayload();
      // Zero-rated defenders cannot match the ring's 17-point massed base.
      holdAllButWithRating(payload, 'hex-r1-6', 0);

      const result = finalCapture(payload);

      expect(result.ok).toBe(true);
      expect(result.assault?.outcome).toBe('fell');
      expect(result.assault!.margin).toBeLessThan(0);
      expect(result.campaignReset).toBe(true);
      // The ring was lost, not advanced.
      expect(result.ringSecured).toBe(false);
      expect(result.ringAdvanced).toBe(false);
      expect(result.ringIndex).toBe(1);

      // The hangar is wiped: banked salvage/cores, unlocks and modifiers ...
      expect(result.payload.hangar.bankedMinerals).toBe(0);
      expect(result.payload.hangar.bankedCores).toBe(0);
      expect(result.payload.hangar.unlockedHulls).toEqual(['hull-1']);
      expect(result.payload.hangar.unlockedWeapons).toEqual(['spread']);
      expect(result.payload.hangar.ownedModifiers).toEqual([]);
      // ... the ring, its defenders/aggression and the queued attacks with it ...
      expect(result.payload.ring.hexes).toEqual([]);
      expect(result.payload.ring.ringIndex).toBe(1);
      expect(result.payload.pendingAttacks).toEqual([]);
      expect(result.payload.frontierTick ?? 0).toBe(0);
      // ... a fresh campaign seed is issued (deterministically, so a replay
      // reproduces the reset) ...
      expect(result.payload.seed).toBe(campaignResetSeed(payload));
      expect(result.payload.seed).not.toBe(payload.seed);
      // ... and the restart convention's bestScore survives the reset.
      expect(result.payload.bestScore).toBe(18200);
      // The fresh bank watermark matches the wiped hangar.
      expect(result.banked).toEqual(createBankedSalvage());

      // The whole payload is the fresh starting position plus bestScore,
      // matching the shipped `restartHangarWar` convention field for field.
      expect(result.payload).toEqual({
        ...createDefaultPayload(campaignResetSeed(payload)),
        bestScore: 18200,
      });
    });

    it('reproduces the reset bit-for-bit on a replay of the same fall', () => {
      const payload = stockedPayload();
      holdAllButWithRating(payload, 'hex-r1-6', 0);
      const before = JSON.parse(JSON.stringify(payload)) as HangarWarPayload;

      const first = finalCapture(payload);
      const replay = finalCapture(JSON.parse(JSON.stringify(before)));

      expect(first.campaignReset).toBe(true);
      expect(replay.payload).toEqual(first.payload);
      expect(payload).toEqual(before);
    });
  });

  describe('AC4 — the rush line is unchanged', () => {
    it('opens the next ring from the capstone with no assault and no reset', () => {
      const payload = ringPayload();

      const result = resolveHexCapture(payload, {
        hexId: 'hex-r1-6',
        defenderHullId: 'hull-1',
        salvage: victorySalvage(5, 1),
        definitions: HEX_RING_DEFINITIONS,
        tuning: NO_JITTER,
      });

      expect(result.ok).toBe(true);
      // Not secured — five hexes are still unheld — so no assault fires.
      expect(result.ringSecured).toBe(false);
      expect(result.assault).toBeNull();
      expect(result.campaignReset).toBe(false);
      // The rush still opens ring 2 exactly as before.
      expect(result.ringAdvanced).toBe(true);
      expect(result.ringIndex).toBe(2);
      expect(result.payload.seed).toBe(payload.seed);
    });
  });

  describe('AC5 — a hex falling in a normal frontier tick never resets the hangar', () => {
    it('keeps the hangar, ring, seed and bestScore when a held hex is retaken', () => {
      const payload = stockedPayload();
      const held = hex(payload, 'hex-r1-1');
      held.held = true;
      held.defender = {
        hullId: 'hull-1',
        defenceRating: deriveDefenderRating('hull-1'),
        bankedMinerals: 0,
      };
      payload.seed = 4242;
      payload.pendingAttacks = [{ hexId: 'hex-r1-1', force: 500 }];
      const hangarBefore = JSON.parse(JSON.stringify(payload.hangar));

      const tick = runFrontierTick(payload, {
        clock: createFrontierClock(payload.seed, 0),
        tuning: NO_JITTER,
      });

      // The queued attack really did take the hex ...
      expect(
        tick.record.attacks.find((record) => record.hexId === 'hex-r1-1')?.outcome,
      ).toBe('fell');
      expect(hex(tick.payload, 'hex-r1-1').held).toBe(false);
      expect(hex(tick.payload, 'hex-r1-1').defender).toBeNull();
      // ... and losing a hex battle is emphatically not a campaign reset.
      expect(tick.payload.hangar).toEqual(hangarBefore);
      expect(tick.payload.ring.hexes).toHaveLength(6);
      expect(tick.payload.seed).toBe(4242);
      expect(tick.payload.bestScore).toBe(18200);
    });
  });
});

/**
 * The special-mission capture path (AH-0MWF0CX0H004OJ2Y, post-MVP Hangar War
 * AH-0MVWZYIWX0008C55 Q1 = a / Q2 = a).
 *
 * A special mission is **not** a second run implementation: it is an ordinary
 * one-level capture whose authored grant is a hull with extra hit points. These
 * tests pin that the shipped capture path pays it, that nothing about the
 * ordinary hex path changes, and that the reward is real (it changes the next
 * deployment) and persistent (it survives the store round trip).
 */
describe('resolveHexCapture — the special-mission path', () => {
  /** A held-free ring-2 war, where the authored special mission lives. */
  function ring2Payload(): HangarWarPayload {
    return ringPayload(2);
  }

  it('grants the extra-hit-points hull when the special mission is captured', () => {
    const payload = ring2Payload();
    expect(payload.hangar.unlockedHulls).not.toContain('hull-3');

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r2-3',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(30, 1),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    // The reward lands in the same owned set an ordinary hull grant uses.
    expect(result.payload.hangar.unlockedHulls).toContain('hull-3');
    expect(hex(result.payload, 'hex-r2-3').held).toBe(true);
    expect(hex(result.payload, 'hex-r2-3').grantedWeapon).toBe('hull-3');
    // ... and the capture reports the reward a caller can announce.
    expect(result.specialReward).not.toBeNull();
    expect(result.specialReward?.hexId).toBe('hex-r2-3');
    expect(result.specialReward?.hullId).toBe('hull-3');
    expect(result.specialReward?.bonusStartingLives).toBeGreaterThan(0);
  });

  it('pays an ordinary hex its own grant and reports no special reward', () => {
    const result = resolveHexCapture(ringPayload(), {
      hexId: 'hex-r1-1',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.grant?.entryId).toBe('hull-2');
    expect(result.specialReward).toBeNull();
    expect(result.payload.hangar.unlockedHulls).not.toContain('hull-3');
  });

  it('grants nothing when the capture is refused for a missing defender', () => {
    const result = resolveHexCapture(ring2Payload(), {
      hexId: 'hex-r2-3',
      defenderHullId: null,
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('defender-required');
    expect(result.grant).toBeNull();
    expect(result.specialReward).toBeNull();
    expect(result.payload.hangar.unlockedHulls).not.toContain('hull-3');
  });

  it('persists the granted hull through the versioned store without loss', () => {
    const result = resolveHexCapture(ring2Payload(), {
      hexId: 'hex-r2-3',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });
    const storage = createInMemoryHangarWarStorage();
    saveHangarWarPayload(result.payload, storage);

    const loaded = loadHangarWarPayload(storage);

    expect(loaded).not.toBeNull();
    // No new storage key and no version bump: the reward is ordinary owned-set
    // content (field-presence migration covers any additive state).
    expect(loaded?.version).toBe(HANGAR_WAR_VERSION);
    expect(loaded?.hangar.unlockedHulls).toContain('hull-3');
    const restored = hex(loaded!, 'hex-r2-3');
    expect([restored.id, restored.q, restored.r]).toEqual(['hex-r2-3', -2, 2]);
    expect(restored.held).toBe(true);
    expect(restored.grantedWeapon).toBe('hull-3');
  });

  it('has a real effect when the granted hull is deployed', () => {
    const result = resolveHexCapture(ring2Payload(), {
      hexId: 'hex-r2-3',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      definitions: HEX_RING_DEFINITIONS,
    });

    const withReward = buildHangarDeployment({
      ...result.payload,
      hangar: { ...result.payload.hangar, activeHull: 'hull-3' },
    });
    const withStarter = buildHangarDeployment({
      ...result.payload,
      hangar: { ...result.payload.hangar, activeHull: 'hull-1' },
    });

    expect(withReward.hullId).toBe('hull-3');
    expect(withReward.startingLives).toBeGreaterThan(withStarter.startingLives);
    expect(withReward.startingLives - withStarter.startingLives).toBe(
      result.specialReward?.bonusStartingLives,
    );
    // The reward trades manoeuvrability for hit points; it is not a free win.
    expect(withReward.speedMultiplier).toBeLessThan(withStarter.speedMultiplier);
  });

  it('pays the ring-1 special mission\'s grant-only hull (AH-0MWJ51KUS005WQK6)', () => {
    // Ring 1's special is a fortress, so the shipped set-piece needs its two
    // capture passes; the hull is paid on the securing pass through the same
    // `resolveHexGrant` path as ring 2's.
    const firstPass = resolveHexCapture(ringPayload(1), {
      hexId: 'hex-r1-5',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(30, 1),
      definitions: HEX_RING_DEFINITIONS,
    });
    expect(firstPass.ok).toBe(false);
    expect(firstPass.reason).toBe('fortress-incomplete');
    expect(firstPass.specialReward).toBeNull();
    expect(firstPass.payload.hangar.unlockedHulls).not.toContain('hull-4');

    const result = resolveHexCapture(firstPass.payload, {
      hexId: 'hex-r1-5',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(0, 0),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    // The reward lands in the same owned set an ordinary hull grant uses.
    expect(result.payload.hangar.unlockedHulls).toContain('hull-4');
    expect(hex(result.payload, 'hex-r1-5').held).toBe(true);
    expect(hex(result.payload, 'hex-r1-5').grantedWeapon).toBe('hull-4');
    expect(result.specialReward?.hexId).toBe('hex-r1-5');
    expect(result.specialReward?.hullId).toBe('hull-4');
    expect(result.specialReward?.startingLives).toBe(4);
    expect(result.specialReward?.baseDefence).toBe(3);
    expect(result.specialReward?.bonusStartingLives).toBe(1);

    // It is a real ship: deploying it adds exactly the advertised extra life.
    const withReward = buildHangarDeployment({
      ...result.payload,
      hangar: { ...result.payload.hangar, activeHull: 'hull-4' },
    });
    const withStarter = buildHangarDeployment({
      ...result.payload,
      hangar: { ...result.payload.hangar, activeHull: 'hull-1' },
    });
    expect(withReward.startingLives - withStarter.startingLives).toBe(
      result.specialReward?.bonusStartingLives,
    );

    // No new storage key: the ring-1 reward persists under the same payload.
    const storage = createInMemoryHangarWarStorage();
    saveHangarWarPayload(result.payload, storage);
    const loaded = loadHangarWarPayload(storage);
    expect(loaded?.version).toBe(HANGAR_WAR_VERSION);
    expect(loaded?.hangar.unlockedHulls).toContain('hull-4');
    expect(hex(loaded!, 'hex-r1-5').grantedWeapon).toBe('hull-4');
  });
});

// ── Run upgrade snapshot — red-first guard tests (AH-0MWHF6X9N0082BRO) ─────
//
// The parent (AH-0MWH42DWQ004SAOJ) changes the capture cycle so the bot left
// behind keeps the run's permanent upgrades: `resolveHexCapture` accepts the
// run's permanent-upgrade snapshot and `leaveDefender` persists it on the
// `HexDefender` as an **additive optional field** (the same back-compat pattern
// as `skills`), with the rating extended through the one exported derivation.
//
// These specs are part of the test-first slice: they are red until C2–C4 land
// (the exports are read through the module namespace so the rest of this file
// stays compilable), and green once the capture path threads the snapshot.
// The pinned contract, for C3 (AH-0MWHF6ZHW0058SMX) and C4
// (AH-0MWHF70OD0070F04):
//
// - `HexDefender.upgradeSnapshot?: DefenderUpgradeSnapshot` — additive optional,
//   omitted when empty (a no-upgrade capture produces exactly today's payload);
// - `HexCaptureInput.snapshot?: DefenderUpgradeSnapshot` — the whole snapshot
//   read once at victory (the permanent accessors);
// - `leaveDefender(hangar, hullId, bankedMinerals?, catalogue?, snapshot?)` —
//   records the field and derives the rating through the one
//   `defenderRatingFromSnapshot` helper, never a second formula.

/**
 * The run's permanent-upgrade snapshot (C1 red-first contract) — rows match
 * `Player.getWeaponLevels()`, `Player.getPowerUpLevels()` and
 * `PowerUpLevelStore.snapshotConsumablePools()`.
 */
interface DefenderUpgradeSnapshot {
  weaponLevels: ReadonlyArray<{ id: WeaponId; level: number }>;
  powerUpLevels: ReadonlyArray<{ id: PowerUpId; level: number }>;
  consumablePools: ReadonlyArray<{ id: PowerUpId; charges: number }>;
}

/** A defender carrying the pending additive snapshot field. */
type CapturedDefender = HexDefender & { upgradeSnapshot?: DefenderUpgradeSnapshot };

/** The C2 derivation, read structure-first so these specs run red, not crash. */
const pendingDerivation = hangarEconomyModule as unknown as {
  defenderRatingFromSnapshot?: (
    hullRating: number,
    snapshot: DefenderUpgradeSnapshot,
  ) => number;
};

/** The signed capture input (C4 threads the snapshot through this field). */
type SignedCaptureInput = Parameters<typeof resolveHexCapture>[1] & {
  snapshot?: DefenderUpgradeSnapshot;
};

/** The pinned extended `leaveDefender` signature (C4 adds the 5th argument). */
const leaveDefenderWithSnapshot = leaveDefender as (
  hangar: HangarWarPayload['hangar'],
  hullId: unknown,
  bankedMinerals?: number,
  catalogue?: readonly import('../../data/hangarCatalogue').HangarEntry[],
  snapshot?: DefenderUpgradeSnapshot,
) => HexDefender | null;

describe('leaveDefender / resolveHexCapture — run upgrade snapshot (AH-0MWHF6X9N0082BRO, red-first guard)', () => {
  /** A defensive snapshot whose buckets are exactly 4 armour / 3 firepower / 2 systems. */
  function upgradedSnapshot(): DefenderUpgradeSnapshot {
    return {
      weaponLevels: [
        { id: 'cannon', level: 2 },
        { id: 'spread', level: 1 },
      ],
      powerUpLevels: [
        { id: 'shield', level: 2 },
        { id: 'bomb', level: 1 },
        { id: 'force_field', level: 1 }, // defensive kinds → armour (4 total)
        { id: 'extra_life', level: 1 }, // the unlisted kind → systems
      ],
      consumablePools: [{ id: 'mystery_ufo', charges: 1 }], // other charge → systems
    };
  }

  it('records the snapshot on the defender and rates it through the one derivation', () => {
    const payload = ringPayload();
    const snapshot = upgradedSnapshot();
    // Red until C2/C4 land the snapshot-aware derivation; the rating must then
    // come from exactly that one helper, never a second formula.
    const expected = pendingDerivation.defenderRatingFromSnapshot?.(
      deriveDefenderRating('hull-1'),
      snapshot,
    );
    expect(expected).toBeDefined();

    const defender = leaveDefenderWithSnapshot(
      payload.hangar,
      'hull-1',
      12,
      undefined,
      snapshot,
    ) as unknown as CapturedDefender;

    expect(defender.upgradeSnapshot).toEqual(snapshot);
    // The rating is the bare hull rating plus the snapshot's contribution,
    // resolved through the economy's single derivation (4 armour / 3 firepower
    // / 2 systems → +22 with the shipped weights).
    expect(defender.defenceRating).toBe(expected);
    expect(defender.defenceRating).toBeGreaterThan(
      deriveDefenderRating('hull-1'),
    );
    // The existing additive fields are untouched by the new one.
    expect(defender.hullId).toBe('hull-1');
    expect(defender.bankedMinerals).toBe(12);
  });

  it('omits the field and keeps today′s defender when no snapshot is supplied (no-upgrades equality)', () => {
    const payload = ringPayload();
    const defender = leaveDefenderWithSnapshot(
      payload.hangar,
      'hull-1',
      12,
    ) as unknown as CapturedDefender;

    // Byte-for-byte today's defender: no upgradeSnapshot key at all.
    expect('upgradeSnapshot' in defender).toBe(false);
    expect(defender.defenceRating).toBe(deriveDefenderRating('hull-1'));
    expect(defender).toEqual({
      hullId: 'hull-1',
      defenceRating: deriveDefenderRating('hull-1'),
      bankedMinerals: 12,
    });
  });

  it('persists the snapshot on the stored defender through resolveHexCapture', () => {
    const payload = ringPayload();
    const snapshot = upgradedSnapshot();
    const expected = pendingDerivation.defenderRatingFromSnapshot?.(
      deriveDefenderRating('hull-1'),
      snapshot,
    );
    expect(expected).toBeDefined();

    const input: SignedCaptureInput = {
      hexId: 'hex-r1-4',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(30, 0),
      definitions: HEX_RING_DEFINITIONS,
      snapshot,
    };
    const result = resolveHexCapture(payload, input);

    expect(result.ok).toBe(true);
    const stored = hex(result.payload, 'hex-r1-4').defender as unknown as CapturedDefender;
    expect(stored.upgradeSnapshot).toEqual(snapshot);
    expect(stored.defenceRating).toBe(expected);
  });

  it('collapses a corrupt snapshot without throwing and never lowers the rating', () => {
    const payload = ringPayload();
    const corrupt: DefenderUpgradeSnapshot = {
      weaponLevels: [
        { id: 'cannon', level: Number.NEGATIVE_INFINITY },
        { id: 'spread', level: -2 },
        { id: 'rapid', level: 'high' as unknown as number },
      ],
      powerUpLevels: [{ id: 'shield', level: Number.NaN }],
      consumablePools: [{ id: 'mystery_ufo', charges: -1 }],
    };
    const input: SignedCaptureInput = {
      hexId: 'hex-r1-2',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(15, 0),
      definitions: HEX_RING_DEFINITIONS,
      snapshot: corrupt,
    };

    expect(() => resolveHexCapture(payload, input)).not.toThrow();
    const result = resolveHexCapture(payload, input);
    expect(result.ok).toBe(true);
    const stored = hex(result.payload, 'hex-r1-2').defender as unknown as CapturedDefender;
    // 0-safe buckets can never make the stored bot weaker than the bare hull.
    expect(stored.defenceRating).toBeGreaterThanOrEqual(
      deriveDefenderRating('hull-1'),
    );
  });
});

// ── Capture integration: upgraded levels on the defender ──────────────────
// (AH-0MWI5AN6Y000NTR5, parent AH-0MWHW4ALS0039JFU AC4)
//
// The parent epic's other slices *sell* a permanent level (the pure economy
// rule + the versioned store, `buyHangarUpgrade`) and *carry* it out on the
// deployment (`buildHangarDeployment` → `applyHangarWarDeployment`, which
// grants the levels the run's `getWeaponLevels()`/`getPowerUpLevels()` read).
// This suite pins the join between them and the capture cycle: a hex taken
// **after** the fleet bought upgrades leaves a defender whose
// `upgradeSnapshot`/`defenceRating` reflect the higher permanent levels,
// resolved through the one shared capture path the game and the gyms both run
// (`resolveHexCapture` → `leaveDefender`).

describe('capture integration — upgraded permanent levels on the defender (AH-0MWI5AN6Y000NTR5)', () => {
  /** A ring-1 war whose fleet fields (and can afford to upgrade) its starting weapon. */
  function fieldedWar(): HangarWarPayload {
    const payload = ringPayload();
    return {
      ...payload,
      hangar: {
        ...payload.hangar,
        bankedMinerals: 5_000,
        bankedCores: 20,
        activeLoadout: {
          ...payload.hangar.activeLoadout,
          // `spread` is the fresh save's unlocked starting weapon.
          startingWeapons: ['spread'],
        },
      },
    };
  }

  /**
   * The victory snapshot a deployment's run reports: the rows
   * `applyHangarWarDeployment` grants as permanent levels, so the accessors
   * the capture reads return exactly these (no pickups in this sortie).
   */
  function victorySnapshot(
    deployment: ReturnType<typeof buildHangarDeployment>,
  ) {
    return {
      weaponLevels: deployment.weaponLevels,
      powerUpLevels: deployment.powerUpLevels,
      consumablePools: [],
    };
  }

  it('leaves a defender carrying the levels a hangar purchase raised, through the shared capture path', () => {
    const war = fieldedWar();

    // The unupgraded fleet deploys its weapon at base level 1 (no bought rows).
    const baseDeployment = buildHangarDeployment(war);
    expect(baseDeployment.weaponLevels).toEqual([{ id: 'spread', level: 1 }]);
    const baseCapture = resolveHexCapture(war, {
      hexId: 'hex-r1-2',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(10, 0),
      definitions: HEX_RING_DEFINITIONS,
      snapshot: victorySnapshot(baseDeployment),
    });
    expect(baseCapture.ok).toBe(true);
    const baseDefender = hex(baseCapture.payload, 'hex-r1-2').defender!;

    // Two purchases through the one economy rule the hangar screen uses: from
    // the unupgraded base the fleet's persisted level becomes 3 (the first
    // purchase raises base level 1 → 2, the second 2 → 3 — no inert step,
    // AH-0MWKV6F26008X1T3).
    const first = buyHangarUpgrade(war, 'spread', {
      ringIndex: war.ring.ringIndex,
    });
    const second = buyHangarUpgrade(first.payload, 'spread', {
      ringIndex: war.ring.ringIndex,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const upgraded = second.payload;
    expect(upgraded.hangar.weaponLevels).toEqual([{ id: 'spread', level: 3 }]);

    // The launch data the hangar hands the run carries that higher level…
    const upgradedDeployment = buildHangarDeployment(upgraded);
    expect(upgradedDeployment.weaponLevels).toEqual([
      { id: 'spread', level: 3 },
    ]);
    const snapshot = victorySnapshot(upgradedDeployment);

    // …and the capture after the purchase resolves against it.
    const captured = resolveHexCapture(upgraded, {
      hexId: 'hex-r1-4',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(10, 0),
      definitions: HEX_RING_DEFINITIONS,
      snapshot,
    });
    expect(captured.ok).toBe(true);

    const defender = hex(captured.payload, 'hex-r1-4').defender!;
    // The stored snapshot is the deployment's rows: the bought level survives.
    expect(defender.upgradeSnapshot).toEqual(snapshot);
    expect(defender.upgradeSnapshot!.weaponLevels).toEqual([
      { id: 'spread', level: 3 },
    ]);
    // The rating is the hull rating plus the bought level's contribution,
    // through the one snapshot-aware derivation (no second formula).
    expect(defender.defenceRating).toBe(
      defenderRatingFromSnapshot(deriveDefenderRating('hull-1'), snapshot),
    );
    // The higher permanent level is strictly stronger than the same fleet's
    // base-level deployment, and than the bare hull.
    expect(defender.defenceRating).toBeGreaterThan(baseDefender.defenceRating);
    expect(defender.defenceRating).toBeGreaterThan(
      deriveDefenderRating('hull-1'),
    );
  });

  it('keeps the no-upgrades baseline byte-for-byte today’s defender and rating', () => {
    // A fresh fleet buys nothing and deploys no extra weapons, so its
    // deployment carries no permanent-level rows at all.
    const war = ringPayload();
    const deployment = buildHangarDeployment(war);
    expect(deployment.weaponLevels).toEqual([]);
    expect(deployment.powerUpLevels).toEqual([]);

    const captured = resolveHexCapture(war, {
      hexId: 'hex-r1-2',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(10, 0),
      definitions: HEX_RING_DEFINITIONS,
      // An empty snapshot normalises to nothing, exactly like the game's
      // upgrade-free run (field-presence migration keeps today's payload).
      snapshot: victorySnapshot(deployment),
    });
    expect(captured.ok).toBe(true);

    const defender = hex(captured.payload, 'hex-r1-2').defender!;
    expect('upgradeSnapshot' in defender).toBe(false);
    expect(defender).toEqual({
      hullId: 'hull-1',
      defenceRating: deriveDefenderRating('hull-1'),
      bankedMinerals: 10,
    });
  });
});
