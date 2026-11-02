/**
 * Hex-map intel view-model tests (AH-0MVUXCAG90086LH2).
 *
 * The map is a **pure view** over the stored hangar-war payload, the authored
 * ring definitions and the resolver's numbers, so this suite pins the
 * known-ahead intel (boss, strengths, weaknesses, grant, aggression, pending
 * attack) per hex, the generated ring-2 render, the focus order and the
 * attract bot's weakest-adjacent pick — all without booting a scene.
 */

import { describe, expect, it } from 'vitest';

import {
  createDefaultPayload,
  DEFAULT_HULL_ID,
} from './hangarWarStore';
import { createRingState, generateRing } from './hexRing';
import {
  HEX_MAP_HANGAR_LABEL,
  HEX_MAP_HANGAR_ROW_KEY,
  HEX_MAP_TITLE,
  buildHexIntel,
  buildHexMapModel,
  pickAttractHex,
} from './hexIntel';
import type { HangarWarPayload, HexState, PendingAttack } from './types';
import {
  HEX_RING_DEFINITIONS,
  findHexRingDefinition,
} from '../../data/hexRingDefinitions';
import { VALID_HANGAR_WAR_PAYLOAD } from './fixtures';
import { createHangarWarRng } from './rng';

/** A payload whose ring is the generated state of `ringIndex`. */
function ringPayload(ringIndex: 1 | 2): HangarWarPayload {
  return {
    ...createDefaultPayload(7),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

/** A detached copy (so a test's mutation cannot leak into a fixture). */
function clone(payload: HangarWarPayload): HangarWarPayload {
  return JSON.parse(JSON.stringify(payload)) as HangarWarPayload;
}

/** Replaces one hex in a payload and returns the detached result. */
function withHex(
  payload: HangarWarPayload,
  hexId: string,
  patch: Partial<HexState>,
): HangarWarPayload {
  const next = clone(payload);
  const hex = next.ring.hexes.find((candidate) => candidate.id === hexId);
  if (!hex) throw new Error(`no hex ${hexId}`);
  Object.assign(hex, patch);
  return next;
}

describe('hex map model (pure)', () => {
  it('publishes the full known-ahead intel for every ring-1 hex', () => {
    const model = buildHexMapModel(ringPayload(1));
    const ring = generateRing(1, HEX_RING_DEFINITIONS);

    expect(model.title).toBe(HEX_MAP_TITLE);
    expect(model.ringIndex).toBe(1);
    expect(model.hexes).toHaveLength(6);
    expect(model.hexes.map((hex) => hex.id)).toEqual(
      ring.hexes.map((hex) => hex.id),
    );

    for (const intel of model.hexes) {
      const definition = findHexRingDefinition(intel.id)!;
      expect(intel.boss).toBe(definition.boss);
      expect(intel.strengths).toEqual([...definition.strengths]);
      expect(intel.weaknesses).toEqual([...definition.weaknesses]);
      expect(intel.grants).toBe(definition.grants);
      expect(intel.aggression).toBe(definition.baseAggression);
      expect(intel.held).toBe(false);
      expect(intel.actionable).toBe(true);

      // The tile text publishes boss, strengths, weaknesses, grant and the
      // aggression *before* the player commits to a deployment.
      expect(intel.label).toContain(intel.id);
      expect(intel.label).toContain('UNHELD');
      expect(intel.label).toContain(`AGG ${definition.baseAggression}`);
      expect(intel.label).toContain(definition.boss);
      expect(intel.label).toContain(`S:${definition.strengths.join(',')}`);
      expect(intel.label).toContain(`W:${definition.weaknesses.join(',')}`);
      expect(intel.label).toContain(`→${definition.grants}`);
    }

    expect(model.ringLine).toBe('RING 1 — 0/6 HEXES HELD');
    expect(model.hangarLine).toContain('HANGAR');
    expect(model.secured).toBe(false);
  });

  it('joins held state, the defending bot and summed pending attacks', () => {
    const payload = withHex(ringPayload(1), 'hex-r1-2', {
      held: true,
      bossDefeated: true,
      grantedWeapon: 'waveLaser',
      defender: { hullId: DEFAULT_HULL_ID, defenceRating: 2, bankedMinerals: 0 },
    });
    payload.pendingAttacks = [
      { hexId: 'hex-r1-2', force: 4 },
      { hexId: 'hex-r1-2', force: 5 },
      { hexId: 'hex-r1-1', force: 9 },
    ] satisfies PendingAttack[];

    const model = buildHexMapModel(payload);
    const held = model.hexes.find((hex) => hex.id === 'hex-r1-2')!;
    const other = model.hexes.find((hex) => hex.id === 'hex-r1-1')!;

    expect(held.held).toBe(true);
    expect(held.actionable).toBe(false);
    expect(held.bossDefeated).toBe(true);
    expect(held.grantedWeapon).toBe('waveLaser');
    expect(held.defender).toEqual({
      hullId: DEFAULT_HULL_ID,
      defenceRating: 2,
      bankedMinerals: 0,
    });
    expect(held.pendingAttack?.force).toBe(9);
    // Aggression 1 → 115 %, force 9 → attack strength 10 vs a rating of 2.
    expect(held.pendingAttack?.resolution).toMatchObject({
      outcome: 'fell',
      attackStrength: 10,
      defenderRating: 2,
      margin: -8,
    });
    expect(held.label).toContain('HELD · AGG 1 · !9');
    expect(held.label).toContain('bot hull-1 (2)');
    expect(held.label).toContain('atk 10 vs 2 · FALLS');

    // A queued attack on an unheld (undefended) hex is shown as a force only:
    // there is nothing to resolve until a bot holds it.
    expect(other.pendingAttack?.force).toBe(9);
    expect(other.pendingAttack?.resolution).toBeNull();
    expect(other.label).toContain('UNHELD · AGG 2 · !9');

    expect(model.heldCount).toBe(1);
    expect(model.ringLine).toContain('1/6');
  });

  it('renders ring 2 from its 12 generated hex definitions, all selectable', () => {
    const model = buildHexMapModel(ringPayload(2));
    const ring = generateRing(2, HEX_RING_DEFINITIONS);
    const weaponHex = model.hexes.filter((hex) => hex.weaponHex);

    expect(model.ringIndex).toBe(2);
    expect(model.hexes).toHaveLength(12);
    expect(model.hexes.map((hex) => hex.id)).toEqual(
      ring.hexes.map((hex) => hex.id),
    );
    expect(model.hexes.every((hex) => hex.actionable)).toBe(true);
    expect(model.focusOrder).toEqual([
      ...ring.hexes.map((hex) => `hex:${hex.id}`),
      HEX_MAP_HANGAR_ROW_KEY,
    ]);
    // Exactly one hex grants the ring's new weapon, and it is the hardest.
    expect(weaponHex).toHaveLength(1);
    expect(weaponHex[0].id).toBe('hex-r2-12');
    expect(weaponHex[0].aggression).toBe(
      Math.max(...model.hexes.map((hex) => hex.aggression)),
    );
    expect(model.ringLine).toBe('RING 2 — 0/12 HEXES HELD');
  });

  it('generates a fresh war\u2019s empty ring for display but never pads a partial ring', () => {
    const fresh = {
      ...createDefaultPayload(3),
      ring: { ringIndex: 2, hexes: [] },
    };
    const generated = buildHexMapModel(fresh);
    expect(generated.hexes).toHaveLength(12);
    expect(generated.hexes.every((hex) => !hex.held)).toBe(true);
    expect(generated.hexes.map((hex) => hex.aggression)).toEqual(
      generateRing(2, HEX_RING_DEFINITIONS).hexes.map(
        (hex) => hex.baseAggression,
      ),
    );

    // A stored partial ring is rendered exactly as stored (never padded).
    const partial = buildHexMapModel(VALID_HANGAR_WAR_PAYLOAD);
    expect(partial.hexes.map((hex) => hex.id)).toEqual(['hex-1', 'hex-2']);
    expect(partial.hexes[0].held).toBe(true);
    expect(partial.hexes[1].held).toBe(false);
  });

  it('renders a stored hex with no authored definition from its persisted state', () => {
    const model = buildHexMapModel(VALID_HANGAR_WAR_PAYLOAD);
    const [held, unheld] = model.hexes;

    expect(held.id).toBe('hex-1');
    expect(held.boss).toBeNull();
    expect(held.strengths).toEqual([]);
    expect(held.grants).toBeNull();
    expect(held.label).toContain('boss unknown');
    expect(held.label).toContain('→waveLaser');
    expect(held.actionable).toBe(false);

    expect(unheld.id).toBe('hex-2');
    expect(unheld.aggression).toBe(3);
    expect(unheld.actionable).toBe(true);
    expect(unheld.pendingAttack).toBeNull();
  });

  it('focuses only deployable hexes, defaulting to the attract pick', () => {
    const payload = withHex(ringPayload(1), 'hex-r1-2', {
      held: true,
      defender: { hullId: DEFAULT_HULL_ID, defenceRating: 9, bankedMinerals: 0 },
    });
    const model = buildHexMapModel(payload);

    expect(model.focusOrder).not.toContain('hex:hex-r1-2');
    expect(model.focusOrder).toContain('hex:hex-r1-1');
    expect(model.focusOrder.at(-1)).toBe(HEX_MAP_HANGAR_ROW_KEY);
    expect(model.attractHexId).not.toBe('hex-r1-2');
    expect(model.defaultFocusKey).toBe(`hex:${model.attractHexId}`);

    const secured = clone(ringPayload(1));
    for (const hex of secured.ring.hexes) {
      hex.held = true;
      hex.defender = {
        hullId: DEFAULT_HULL_ID,
        defenceRating: 9,
        bankedMinerals: 0,
      };
    }
    const securedModel = buildHexMapModel(secured);
    expect(securedModel.secured).toBe(true);
    expect(securedModel.attractHexId).toBeNull();
    expect(securedModel.focusOrder).toEqual([HEX_MAP_HANGAR_ROW_KEY]);
    expect(securedModel.defaultFocusKey).toBe(HEX_MAP_HANGAR_ROW_KEY);
    expect(securedModel.ringLine).toContain('SECURED');
    expect(securedModel.hangarRow).toMatchObject({
      key: HEX_MAP_HANGAR_ROW_KEY,
      label: HEX_MAP_HANGAR_LABEL,
      actionable: true,
    });
  });

  it('builds one hex\u2019s intel in isolation (total over malformed input)', () => {
    const definition = findHexRingDefinition('hex-r1-1')!;
    const intel = buildHexIntel(
      {
        id: 'hex-r1-1',
        q: 1,
        r: 0,
        held: true,
        aggression: Number.NaN,
        defender: { hullId: 'hull-1', defenceRating: -3, bankedMinerals: 0 },
        bossDefeated: true,
        grantedWeapon: null,
      },
      definition,
      Number.NaN,
    );

    expect(intel.aggression).toBe(0);
    expect(intel.pendingAttack).toBeNull();
    expect(intel.label).toContain('HELD · AGG 0');
    expect(intel.label).toContain(definition.boss);
  });
});

describe('attract bot hex pick (pure)', () => {
  it('picks the weakest unheld hex of the opening ring', () => {
    const model = buildHexMapModel(ringPayload(1));
    const weakest = [...model.hexes].sort(
      (a, b) => a.aggression - b.aggression || (a.id < b.id ? -1 : 1),
    )[0];

    expect(pickAttractHex(ringPayload(1))).toBe(weakest.id);
    expect(model.attractHexId).toBe(weakest.id);
    // Ring 1's authored easiest hex, not merely the first clockwise one.
    expect(weakest.id).toBe('hex-r1-2');
  });

  it('stays adjacent to held territory instead of crossing the map', () => {
    // Only hex-r1-2 is held (ring 2 is the current ring); ring 2's hexes
    // adjacent to it are the candidates, and a weaker non-adjacent ring-2 hex
    // must not tempt the bot.
    const ring1 = createRingState(1, HEX_RING_DEFINITIONS);
    const held = ring1.hexes.find((hex) => hex.id === 'hex-r1-2')!;
    const payload: HangarWarPayload = {
      ...ringPayload(2),
      ring: {
        ringIndex: 2,
        hexes: [
          {
            ...held,
            held: true,
            defender: {
              hullId: DEFAULT_HULL_ID,
              defenceRating: 9,
              bankedMinerals: 0,
            },
          },
          ...ringPayload(2).ring.hexes,
        ],
      },
    };
    const pick = pickAttractHex(payload);

    expect(['hex-r2-8', 'hex-r2-10', 'hex-r2-11']).toContain(pick);
    expect(pick).toBe('hex-r2-10');
    // hex-r2-2 (aggression 3) is weaker but not adjacent to held territory.
    expect(
      buildHexMapModel(payload).hexes.find((hex) => hex.id === 'hex-r2-2')!
        .aggression,
    ).toBeLessThan(
      buildHexMapModel(payload).hexes.find((hex) => hex.id === pick)!
        .aggression,
    );
  });

  it('breaks equal-aggression ties by sorted id (replay determinism)', () => {
    const payload = ringPayload(1);
    const withTie = clone(payload);
    for (const hex of withTie.ring.hexes) hex.aggression = 4;

    expect(pickAttractHex(withTie)).toBe('hex-r1-1');
    // Reordering the stored hexes does not change the choice.
    withTie.ring.hexes.reverse();
    expect(pickAttractHex(withTie)).toBe('hex-r1-1');
  });

  it('never stalls: falls back when nothing is adjacent, and returns null when secured', () => {
    // Ring 2 with no held hex: nothing touches held territory, so the weakest
    // hex anywhere is chosen rather than declining to move.
    expect(pickAttractHex(ringPayload(2))).toBe('hex-r2-2');

    const secured = clone(ringPayload(1));
    for (const hex of secured.ring.hexes) hex.held = true;
    expect(pickAttractHex(secured)).toBeNull();
    // A fresh war has no stored ring, so the generated opening ring gives the
    // bot a target instead of stalling on an empty map.
    expect(pickAttractHex(createDefaultPayload(0))).toBe('hex-r1-2');
  });

  it('is deterministic for a seeded payload across repeated builds', () => {
    const seed = createHangarWarRng(11).nextInt(1_000_000);
    const payload = { ...ringPayload(2), seed };
    expect(pickAttractHex(payload)).toBe(pickAttractHex(payload));
  });
});
