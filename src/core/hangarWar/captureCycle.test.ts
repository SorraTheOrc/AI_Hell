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
import { createRingState } from './hexRing';
import { runSalvageFromRun } from './salvageBanking';
import type { HangarWarPayload, HexState } from './types';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import {
  grantDemonstrationColor,
  isRingSecured,
  leaveDefender,
  materialiseRing,
  openNextRing,
  resolveDeploymentDefeat,
  resolveHexCapture,
  resolveHexGrant,
  withGrantedEntry,
} from './captureCycle';

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
  it('secures the ring on its last hex and opens ring 2 without an assault pass', () => {
    const payload = ringPayload();
    holdAllBut(payload, 'hex-r1-6');

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(5, 1),
      definitions: HEX_RING_DEFINITIONS,
    });

    expect(result.ok).toBe(true);
    expect(result.ringSecured).toBe(true);
    expect(result.ringAdvanced).toBe(true);
    expect(result.ringIndex).toBe(2);

    // Ring 2 is playable at once: twelve generated, unheld hexes.
    expect(result.payload.ring.ringIndex).toBe(2);
    expect(result.payload.ring.hexes).toHaveLength(12);
    expect(result.payload.ring.hexes.every((state) => !state.held)).toBe(true);
    // No hangar assault pass is queued (Q2 = a).
    expect(result.payload.pendingAttacks).toEqual([]);
  });

  it('does not advance to a ring that has no authored definitions', () => {
    const payload = ringPayload();
    holdAllBut(payload, 'hex-r1-6');

    const result = resolveHexCapture(payload, {
      hexId: 'hex-r1-6',
      defenderHullId: 'hull-1',
      salvage: victorySalvage(),
      // Only ring 1 is authored here, so ring 2 cannot be generated.
      definitions: HEX_RING_DEFINITIONS.filter((entry) => entry.ringIndex === 1),
    });

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
