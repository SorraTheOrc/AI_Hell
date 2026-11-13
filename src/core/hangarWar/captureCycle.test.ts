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

import { deriveDefenderRating } from './hangarEconomy';
import { createDefaultPayload } from './hangarWarStore';
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
import type { HangarWarPayload, HexState } from './types';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
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

  it('keeps a shipped weapon/upgrade hull that the catalogue does not itemise', () => {
    expect(resolveHexGrant('rapid')).toMatchObject({
      entryId: 'rapid',
      kind: 'weapon',
      weaponId: 'rapid',
    });
    expect(resolveHexGrant('core-bank')).toMatchObject({
      entryId: 'core-bank',
      kind: 'modifier',
      weaponId: null,
    });
    expect(resolveHexGrant('hull-3')).toMatchObject({
      entryId: 'hull-3',
      kind: 'hull',
    });
  });

  it('is total: a blank grant resolves to nothing', () => {
    expect(resolveHexGrant(null)).toBeNull();
    expect(resolveHexGrant('   ')).toBeNull();
    expect(resolveHexGrant(42)).toBeNull();
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
  it('forfeits only the unbanked salvage and leaves the payload untouched', () => {
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
    // The hangar and the ring survive a lost run.
    expect(result.payload).toEqual(before);
    expect(result.banked.minerals).toBe(0);
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

  // Ring 1's authored stored aggression: 2 + 1 + 3 + 2 + 4 + 6 = 18 (mean 3).
  const RING_ONE_AGGRESSION_SUM = 18;

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
      // round(18 × 145 × 100 / 10000) = round(26.1) = 26.
      expect(assault!.attackStrength).toBe(26);
      expect(assault!.margin).toBe(52 - 26);
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
      // Zero-rated defenders cannot match the ring's 18-point massed base.
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
});
