/**
 * Attract-mode traversal decision tests (AH-0MVUXCBBK004EJIP).
 *
 * The traversal is the epic's "attract mode never stalls" guarantee (AC10) made
 * testable: every decision is pure, total and always names an action, so no
 * Hangar War screen can leave the demo waiting. These tests pin the three rules
 * the design names — the weakest adjacent hex on the map, the cheapest useful
 * unlock (seeded tie-break) in the hangar, and an immediate continue on the
 * defence report — plus the dispatch that ties the screens together.
 */

import { describe, expect, it } from 'vitest';

import {
  cheapestSeededUnlock,
  decideHangarAction,
  decideMapAction,
  decideMenuAction,
  decideReportAction,
  decideTraversalAction,
  type HangarWarTraversalAction,
} from './hangarWarTraversal';
import { pickAttractHex } from '../core/hangarWar/hexIntel';
import { createRingState } from '../core/hangarWar/hexRing';
import { createDefaultPayload } from '../core/hangarWar/hangarWarStore';
import type { HangarWarPayload, HexState } from '../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../data/hexRingDefinitions';
import { HANGAR_CATALOGUE, type HangarEntry } from '../data/hangarCatalogue';

/** Ring 1's authored hexes as a payload ring, unheld unless overridden. */
function ringOnePayload(
  overrides: Partial<Record<string, Partial<HexState>>> = {},
): HangarWarPayload {
  const ring = createRingState(1, HEX_RING_DEFINITIONS);
  const hexes = ring.hexes.map((hex) => ({ ...hex, ...overrides[hex.id] }));
  return {
    ...createDefaultPayload(123456789),
    ring: { ringIndex: 1, hexes },
  };
}

/** A payload with banked salvage (so the hangar has something to buy). */
function richPayload(overrides: Partial<HangarWarPayload> = {}): HangarWarPayload {
  const base = createDefaultPayload(123456789);
  return {
    ...base,
    hangar: { ...base.hangar, bankedMinerals: 500, bankedCores: 5 },
    ...overrides,
  };
}

/** The two cheapest unlocks in the shipped catalogue tie, for the seed test. */
const TIED_CATALOGUE: readonly HangarEntry[] = [
  {
    id: 'tie-b',
    kind: 'modifier',
    name: 'B',
    description: 'tied price',
    price: { minerals: 10, cores: 0 },
    minRing: 1,
    starter: false,
    effect: { kind: 'defence', rating: 1 },
  },
  {
    id: 'tie-a',
    kind: 'modifier',
    name: 'A',
    description: 'tied price',
    price: { minerals: 10, cores: 0 },
    minRing: 1,
    starter: false,
    effect: { kind: 'defence', rating: 1 },
  },
  {
    id: 'pricey',
    kind: 'modifier',
    name: 'C',
    description: 'more expensive',
    price: { minerals: 900, cores: 0 },
    minRing: 1,
    starter: false,
    effect: { kind: 'defence', rating: 1 },
  },
];

describe('decideMenuAction — the surface hub', () => {
  it('opens the map', () => {
    expect(decideMenuAction()).toEqual({ kind: 'openMap' });
  });
});

describe('decideMapAction — the weakest adjacent hex', () => {
  it('deploys at the hex the map itself would focus', () => {
    const payload = ringOnePayload();
    const action = decideMapAction(payload);
    expect(action.kind).toBe('deploy');
    if (action.kind !== 'deploy') return;
    expect(action.hexId).toBe(pickAttractHex(payload));
    expect(action.hexId).not.toBeNull();
  });

  it('prefers a hex adjacent to territory the player holds', () => {
    const ring = createRingState(1, HEX_RING_DEFINITIONS);
    // Make every hex expensive except one adjacent to the held hex.
    const held = ring.hexes[0].id;
    const overrides: Record<string, Partial<HexState>> = {};
    for (const hex of ring.hexes) overrides[hex.id] = { aggression: 9 };
    const neighbour = ring.hexes[1].id;
    overrides[held] = { held: true, aggression: 9, defender: {
      hullId: 'hull-1',
      defenceRating: 5,
      bankedMinerals: 0,
    } };
    overrides[neighbour] = { aggression: 1 };
    const payload = ringOnePayload(overrides);

    const action = decideMapAction(payload);
    expect(action).toEqual({ kind: 'deploy', hexId: neighbour });
  });

  it('skips to the hangar when the ring is secured', () => {
    const ring = createRingState(1, HEX_RING_DEFINITIONS);
    const overrides: Record<string, Partial<HexState>> = {};
    for (const hex of ring.hexes) {
      overrides[hex.id] = {
        held: true,
        defender: { hullId: 'hull-1', defenceRating: 3, bankedMinerals: 0 },
      };
    }
    expect(decideMapAction(ringOnePayload(overrides))).toEqual({
      kind: 'openHangar',
    });
  });

  it('shops first on alternate between-sortie visits (the hangar cadence)', () => {
    // Tick 0 (the war's first map visit) deploys…
    expect(decideMapAction(ringOnePayload()).kind).toBe('deploy');
    // …an odd tick (the map visit after a defence report) shops first…
    expect(
      decideMapAction({ ...ringOnePayload(), frontierTick: 1 }),
    ).toEqual({ kind: 'openHangar' });
    // …and an even tick deploys again, so the cycle keeps demonstrating both.
    expect(
      decideMapAction({ ...ringOnePayload(), frontierTick: 2 }).kind,
    ).toBe('deploy');
  });

  it('still deploys when the stored ring has not been generated yet', () => {
    const payload = createDefaultPayload(123456789);
    expect(payload.ring.hexes).toEqual([]);
    const action = decideMapAction(payload);
    expect(action.kind).toBe('deploy');
    if (action.kind === 'deploy') expect(action.hexId).not.toBeNull();
  });
});

describe('decideHangarAction — cheapest useful unlock, seeded', () => {
  it('buys the cheapest useful unlock in the shipped catalogue', () => {
    expect(decideHangarAction(richPayload())).toEqual({
      kind: 'buy',
      entryId: 'hardened_plating',
    });
  });

  it('accepts the active loadout and deploys when nothing is buyable', () => {
    const broke = createDefaultPayload(123456789);
    const action = decideHangarAction(broke);
    expect(action.kind).toBe('deployFromHangar');
    if (action.kind !== 'deployFromHangar') return;
    expect(action.hullId).toBe(broke.hangar.activeHull);
    expect(action.loadout).toEqual(broke.hangar.activeLoadout);
  });

  it('picks inside the cheapest price tier from the stored seed', () => {
    const payload = richPayload();
    const first = cheapestSeededUnlock(payload, { catalogue: TIED_CATALOGUE });
    expect(['tie-a', 'tie-b']).toContain(first?.id);
    // The expensive entry is never the bot's choice.
    expect(first?.id).not.toBe('pricey');
    // Deterministic: the same payload and seed always make the same choice.
    expect(cheapestSeededUnlock(payload, { catalogue: TIED_CATALOGUE })?.id).toBe(
      first?.id,
    );
  });

  it('lets the seed choose between tied entries (not just catalogue order)', () => {
    const payload = richPayload();
    const choices = new Set(
      Array.from({ length: 64 }, (_, index) =>
        cheapestSeededUnlock(payload, {
          catalogue: TIED_CATALOGUE,
          seed: index,
        })?.id,
      ),
    );
    // Both tied entries are reachable across seeds: the pick is seeded, not
    // the first entry in catalogue order.
    expect(choices).toEqual(new Set(['tie-a', 'tie-b']));
  });

  it('buys nothing when every entry is owned', () => {
    const payload = richPayload();
    const owned: HangarWarPayload = {
      ...payload,
      hangar: {
        ...payload.hangar,
        unlockedHulls: ['hull-1', 'hull-2'],
        unlockedWeapons: ['spread', 'wave_laser', 'ricochet', 'cluster'],
        ownedModifiers: ['hardened_plating'],
      },
    };
    expect(cheapestSeededUnlock(owned)).toBeNull();
    expect(decideHangarAction(owned).kind).toBe('deployFromHangar');
  });

  it('never picks an entry gated behind a later ring', () => {
    const payload = richPayload();
    const gated: readonly HangarEntry[] = [
      {
        id: 'ring-two-only',
        kind: 'modifier',
        name: 'Locked',
        description: 'ring 2 only',
        price: { minerals: 1, cores: 0 },
        minRing: 2,
        starter: false,
        effect: { kind: 'defence', rating: 1 },
      },
    ];
    expect(cheapestSeededUnlock(payload, { catalogue: gated })).toBeNull();
  });
});

describe('decideReportAction — auto-advance, never a battle', () => {
  it('continues to the map', () => {
    expect(decideReportAction()).toEqual({ kind: 'continueToMap' });
  });
});

describe('decideTraversalAction — one dispatch, no stalling', () => {
  const payload = ringOnePayload();
  const actionable: ReadonlyArray<HangarWarTraversalAction['kind']> = [
    'openMap',
    'deploy',
    'openHangar',
    'continueToMap',
    'buy',
    'deployFromHangar',
  ];

  it.each(['menu', 'map', 'deployment', 'defenceReport', 'hangar'] as const)(
    'always names an actionable step on the %s screen',
    (screen) => {
      const action = decideTraversalAction(screen, payload);
      expect(actionable).toContain(action.kind);
    },
  );

  it('never returns a wait/idle outcome (the never-stalls contract)', () => {
    const screens = ['menu', 'map', 'deployment', 'defenceReport', 'hangar'] as const;
    for (const screen of screens) {
      const action = decideTraversalAction(screen, payload);
      expect(Object.keys(action)).not.toContain('wait');
      expect(JSON.stringify(action)).not.toMatch(/wait|idle|noop|stall/i);
    }
  });

  it('treats an unknown screen like the menu (a mis-wired screen still advances)', () => {
    expect(
      decideTraversalAction(
        'not-a-screen' as unknown as 'menu',
        payload,
      ),
    ).toEqual({ kind: 'openMap' });
  });

  it('leaves the payload untouched', () => {
    const before = JSON.parse(JSON.stringify(payload));
    decideTraversalAction('map', payload);
    decideTraversalAction('hangar', payload);
    expect(payload).toEqual(before);
  });

  it('is deterministic for the same payload', () => {
    expect(decideTraversalAction('hangar', payload)).toEqual(
      decideTraversalAction('hangar', payload),
    );
  });

  it('the shipped catalogue has a cheapest unlock the bot can actually buy', () => {
    // Guards the demo against a catalogue change that leaves nothing to buy
    // (which would still terminate, but silently stop demonstrating the shop).
    expect(cheapestSeededUnlock(richPayload())).not.toBeNull();
    expect(HANGAR_CATALOGUE.length).toBeGreaterThan(0);
  });
});
