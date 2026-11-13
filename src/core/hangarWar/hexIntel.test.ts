/**
 * Hex-map intel view-model tests — reveal + selection model contract
 * (AH-0MWEWYORN000KTXF, part of **Build Candidate D — Hangar War**).
 *
 * The map is a **pure view** over the stored hangar-war payload, the authored
 * ring definitions and the resolver's numbers. This suite pins the Hangar Map
 * UX model contract (AH-0MWDBI33V003QQ3U): adjacency-only reveal, the
 * selectable/actionable split, coordinate + ownership-discriminator tile
 * labels, full-ring progress, a reveal-constrained attract pick and spatial
 * grid columns — all without booting a scene.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createDefaultPayload,
  DEFAULT_HULL_ID,
} from './hangarWarStore';
import {
  ASSAULT_HANGAR_FALLS_CONSEQUENCE,
  ASSAULT_HANGAR_FALLS_HEADLINE,
  ASSAULT_REPELLED_CONSEQUENCE,
  ASSAULT_REPELLED_HEADLINE,
  buildDefenceReport,
} from './defenceReport';
import { createRingState, generateRing } from './hexRing';
import {
  HELD_TILE_MARKER,
  SPECIAL_MISSION_PANEL_HEADING,
  SPECIAL_MISSION_TILE_TAG,
  HEX_MAP_HANGAR_LABEL,
  HEX_MAP_HANGAR_ROW_KEY,
  HEX_MAP_TITLE,
  UNHELD_TILE_MARKER,
  buildHexIntel,
  buildHexMapModel,
  isHexDisplayed,
  pickAttractHex,
  type BuildHexMapOptions,
  type HexMapModel,
} from './hexIntel';
import type { HangarWarPayload, HexState, PendingAttack } from './types';
import {
  HEX_RING_DEFINITIONS,
  findHexRingDefinition,
} from '../../data/hexRingDefinitions';
import { VALID_HANGAR_WAR_PAYLOAD } from './fixtures';
import { createHangarWarRng } from './rng';
import {
  DEFAULT_FRONTIER_TUNING,
  resolveHangarAssault,
  runFrontierTick,
  type FrontierTickRecord,
  type FrontierTuning,
  type HangarAssaultResolution,
  type HexDefenceRecord,
} from './hexDefence';
import { aggressionScenario } from './__fixtures__/aggressionScenarios';
import { resolvePlayerStrength } from './hangarEconomy';
import { beatableAggressionCeiling } from './hexDifficulty';

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

/**
 * A payload whose stored ring is ring 2 plus one held ring-1 hex — the state
 * a player reaches by holding a ring-1 hex first. Only the ring-2 hexes
 * sharing an edge with the held hex are revealed.
 */
function revealPayload(heldRing1Id: string): HangarWarPayload {
  const ring1 = createRingState(1, HEX_RING_DEFINITIONS);
  const held = ring1.hexes.find((hex) => hex.id === heldRing1Id);
  if (!held) throw new Error(`no ring-1 hex ${heldRing1Id}`);
  return {
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
}

/** A copy of `payload` with every hex held (the secured ring). */
function secured(payload: HangarWarPayload): HangarWarPayload {
  const next = clone(payload);
  for (const hex of next.ring.hexes) {
    hex.held = true;
    hex.defender = {
      hullId: DEFAULT_HULL_ID,
      defenceRating: 9,
      bankedMinerals: 0,
    };
  }
  return next;
}

describe('hex map model — adjacency-only reveal (AC1)', () => {
  it('renders every ring-1 hex with zero held (the hangar anchors the reveal)', () => {
    const model = buildHexMapModel(ringPayload(1));

    expect(model.title).toBe(HEX_MAP_TITLE);
    expect(model.hexes).toHaveLength(6);
    expect(model.hexes.map((hex) => hex.id)).toEqual(
      generateRing(1, HEX_RING_DEFINITIONS).hexes.map((hex) => hex.id),
    );
    // Ring 1 surrounds the hangar, so every hex shares an edge with (0,0) —
    // the reveal is anchored even with nothing held.
    expect(model.hexes.every((hex) => hex.displayed)).toBe(true);
    expect(model.hexes.every((hex) => hex.selectable)).toBe(true);
    expect(model.hexes.every((hex) => hex.actionable)).toBe(true);
    expect(model.secured).toBe(false);
  });

  it('hides every ring-2 hex with zero held (nothing shares an edge with (0,0))', () => {
    const model = buildHexMapModel(ringPayload(2));

    // The full stored ring is still published (reveal is progressive, not
    // removal — epic AC6)…
    expect(model.hexes).toHaveLength(12);
    // …but nothing is displayed, focusable or deployable until a ring-1
    // neighbour is held.
    expect(model.hexes.every((hex) => !hex.displayed)).toBe(true);
    expect(model.hexes.every((hex) => !hex.selectable)).toBe(true);
    expect(model.hexes.every((hex) => !hex.actionable)).toBe(true);
    expect(model.focusOrder).toEqual([HEX_MAP_HANGAR_ROW_KEY]);
    expect(model.defaultFocusKey).toBe(HEX_MAP_HANGAR_ROW_KEY);
    expect(model.attractHexId).toBeNull();
  });

  it('reveals ring-2 hexes progressively as their ring-1 neighbours are held', () => {
    // hex-r1-2 at (1,-1) neighbours ring-2 hexes hex-r2-8 (1,-2),
    // hex-r2-10 (2,-2) and hex-r2-11 (2,-1).
    const model = buildHexMapModel(revealPayload('hex-r1-2'));
    const displayed = model.hexes.filter((hex) => hex.displayed);

    expect(displayed.map((hex) => hex.id).sort()).toEqual(
      ['hex-r1-2', 'hex-r2-8', 'hex-r2-10', 'hex-r2-11'].sort(),
    );
    // The other nine ring-2 hexes stay hidden — and stay in the stored ring
    // (ring-2 content is not removed, only hidden by the reveal).
    const hidden = model.hexes.filter((hex) => !hex.displayed);
    expect(hidden).toHaveLength(9);
    expect(hidden.map((hex) => hex.id)).toContain('hex-r2-1');
    expect(hidden.map((hex) => hex.id)).toContain('hex-r2-12');
    // The hidden ring-2 weapon hex keeps its authored identity — reveal is
    // progressive, not removal of ring-2 content (epic AC6).
    expect(model.hexes.find((hex) => hex.id === 'hex-r2-12')?.weaponHex).toBe(
      true,
    );

    // Revealed ring-2 hexes carry the full authored intel — nothing is
    // fabricated for a revealed tile.
    const r2 = displayed.find((hex) => hex.id === 'hex-r2-10')!;
    const definition = findHexRingDefinition('hex-r2-10')!;
    expect(r2.held).toBe(false);
    expect(r2.boss).toBe(definition.boss);
    expect(r2.grants).toBe(definition.grants);
    expect(r2.ringIndex).toBe(2);
  });

  it('anchor rule: a hex is displayed exactly when it shares an edge with the hangar or with a held hex', () => {
    // Ring 1 is always displayed (hangar-adjacent)…
    expect(isHexDisplayed({ q: 1, r: 0 }, [])).toBe(true);
    expect(isHexDisplayed({ q: 0, r: 1 }, [])).toBe(true);
    // …a hidden ring-2 hex is not…
    expect(isHexDisplayed({ q: -2, r: 0 }, [])).toBe(false);
    expect(isHexDisplayed({ q: 2, r: 0 }, [])).toBe(false);
    // …it becomes displayed when a neighbour is held…
    expect(isHexDisplayed({ q: 2, r: -1 }, [{ q: 1, r: -1 }])).toBe(true);
    expect(isHexDisplayed({ q: -2, r: 0 }, [{ q: 1, r: -1 }])).toBe(false);
    // …and a held hex anchors its neighbours regardless of ring.
    expect(isHexDisplayed({ q: 1, r: 1 }, [{ q: 2, r: 0 }])).toBe(true);
  });
});

describe('hex map model — selection split (AC2)', () => {
  it('selectable is true for every displayed hex; actionable only for unheld displayed hexes', () => {
    const payload = withHex(ringPayload(1), 'hex-r1-2', {
      held: true,
      defender: { hullId: DEFAULT_HULL_ID, defenceRating: 9, bankedMinerals: 0 },
    });
    const model = buildHexMapModel(payload);

    // The held hex is selectable (its intel can be inspected) but never
    // actionable (activating it must not deploy).
    const held = model.hexes.find((hex) => hex.id === 'hex-r1-2')!;
    expect(held.displayed).toBe(true);
    expect(held.selectable).toBe(true);
    expect(held.actionable).toBe(false);

    // Every other displayed hex is selectable and actionable.
    for (const hex of model.hexes.filter((candidate) => candidate.id !== 'hex-r1-2')) {
      expect(hex.displayed).toBe(true);
      expect(hex.selectable).toBe(true);
      expect(hex.actionable).toBe(true);
    }

    // focusOrder covers every selectable displayed hex (held included) plus
    // the hangar row — held hexes are focusable, they just do not deploy.
    expect(model.focusOrder).toEqual([
      ...model.hexes.map((hex) => hex.key),
      HEX_MAP_HANGAR_ROW_KEY,
    ]);
    // The hangar navigation row stays always-actionable and one click away.
    expect(model.hangarRow).toMatchObject({
      key: HEX_MAP_HANGAR_ROW_KEY,
      label: HEX_MAP_HANGAR_LABEL,
      actionable: true,
    });
  });

  it('hidden hexes are neither selectable nor actionable and never enter focus order', () => {
    const model = buildHexMapModel(ringPayload(2));

    expect(model.hexes.every((hex) => !hex.selectable && !hex.actionable)).toBe(
      true,
    );
    expect(
      model.focusOrder.some((key) => key.startsWith('hex:')),
    ).toBe(false);
  });
});

describe('hex map model — tile label (AC3)', () => {
  it('tileLabel shows (q,r), AGG n and a non-colour ownership discriminator', () => {
    const model = buildHexMapModel(ringPayload(1));

    for (const intel of model.hexes) {
      expect(intel.tileLabel).toBe(
        `(${intel.q},${intel.r}) AGG ${intel.aggression} ${UNHELD_TILE_MARKER}`,
      );
      expect(intel.tileLabel).toContain(`(${intel.q},${intel.r})`);
      expect(intel.tileLabel).toContain(`AGG ${intel.aggression}`);
      expect(intel.tileLabel).toContain(UNHELD_TILE_MARKER);
    }

    // A held tile is distinguishable without colour: the filled marker
    // replaces the hollow one.
    const held = buildHexMapModel(
      withHex(ringPayload(1), 'hex-r1-2', { held: true }),
    ).hexes.find((hex) => hex.id === 'hex-r1-2')!;
    expect(held.tileLabel).toBe(`(1,-1) AGG 1 ${HELD_TILE_MARKER}`);
    expect(held.tileLabel).not.toContain(UNHELD_TILE_MARKER);
  });

  it('the full intel label block is unchanged', () => {
    const model = buildHexMapModel(ringPayload(1));

    for (const intel of model.hexes) {
      const definition = findHexRingDefinition(intel.id)!;
      expect(intel.label).toContain(intel.id);
      expect(intel.label).toContain('UNHELD');
      expect(intel.label).toContain(`AGG ${definition.baseAggression}`);
      expect(intel.label).toContain(definition.boss);
      expect(intel.label).toContain(`S:${definition.strengths.join(',')}`);
      expect(intel.label).toContain(`W:${definition.weaknesses.join(',')}`);
      expect(intel.label).toContain(`→${definition.grants}`);
    }
  });

  it('joins held state, the defending bot and summed pending attacks (label unchanged)', () => {
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
    expect(held.displayed).toBe(true);
    expect(held.selectable).toBe(true);
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
    // The tile badge is the coordinates + aggression + ownership marker; the
    // full block is panel text.
    expect(held.tileLabel).toBe(`(1,-1) AGG 1 ${HELD_TILE_MARKER}`);
    expect(other.tileLabel).toBe(`(1,0) AGG 2 ${UNHELD_TILE_MARKER}`);
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
});

describe('hex map model — ring progress over the full ring (AC4)', () => {
  it('counts the full stored ring — progress is not lost when the reveal hides hexes', () => {
    // Ring-2 stored ring (12) plus the held ring-1 anchor (1): ringLine and
    // heldCount cover all 13, even though nine ring-2 hexes are hidden.
    const model = buildHexMapModel(revealPayload('hex-r1-2'));

    expect(model.hexes).toHaveLength(13);
    expect(model.heldCount).toBe(1);
    expect(model.ringLine).toBe('RING 2 — 1/13 HEXES HELD');
  });

  it('reports SECURED only when every stored hex is held', () => {
    const model = buildHexMapModel(secured(ringPayload(1)));

    expect(model.secured).toBe(true);
    expect(model.ringLine).toBe('RING 1 — 6/6 HEXES HELD · SECURED');
    expect(model.attractHexId).toBeNull();
  });

  it('a fresh war\u2019s generated ring is the progress baseline', () => {
    const fresh = buildHexMapModel({
      ...createDefaultPayload(3),
      ring: { ringIndex: 2, hexes: [] },
    });
    expect(fresh.hexes).toHaveLength(12);
    expect(fresh.ringLine).toBe('RING 2 — 0/12 HEXES HELD');
  });
});

describe('hex map model — attract constraint (AC5)', () => {
  it('picks the weakest displayed unheld hex of the opening ring', () => {
    const payload = ringPayload(1);
    const weakest = [...buildHexMapModel(payload).hexes].sort(
      (a, b) => a.aggression - b.aggression || (a.id < b.id ? -1 : 1),
    )[0];

    expect(pickAttractHex(payload)).toBe(weakest.id);
    expect(buildHexMapModel(payload).attractHexId).toBe(weakest.id);
    // Ring 1's authored easiest hex, not merely the first clockwise one.
    expect(weakest.id).toBe('hex-r1-2');
  });

  it('never falls back to a hidden hex (ring 2 unrevealed returns null)', () => {
    // Ring 2 with no held ring-1 hex: every ring-2 hex is hidden, so there is
    // no displayed target — the old "weakest unheld anywhere" fallback is gone.
    expect(pickAttractHex(ringPayload(2))).toBeNull();
    expect(buildHexMapModel(ringPayload(2)).attractHexId).toBeNull();
  });

  it('stays displayed and adjacent to held territory instead of crossing the map', () => {
    // Only ring-1 hex-r1-2 is held, revealing ring-2 hexes hex-r2-8,
    // hex-r2-10 and hex-r2-11. A weaker hidden hex (hex-r2-1) must not tempt
    // the bot, and the pick must always be a displayed hex.
    const payload = withHex(revealPayload('hex-r1-2'), 'hex-r2-1', {
      aggression: 1,
    });
    const model = buildHexMapModel(payload);
    const pick = pickAttractHex(payload);

    expect(['hex-r2-8', 'hex-r2-10', 'hex-r2-11']).toContain(pick);
    expect(pick).toBe('hex-r2-10');
    const picked = model.hexes.find((hex) => hex.id === pick)!;
    expect(picked.displayed).toBe(true);
    expect(picked.held).toBe(false);
    // The hidden hex-r2-1 is strictly weaker yet never chosen.
    expect(
      model.hexes.find((hex) => hex.id === 'hex-r2-1')!.aggression,
    ).toBeLessThan(picked.aggression);
    expect(model.hexes.find((hex) => hex.id === 'hex-r2-1')!.displayed).toBe(
      false,
    );
  });

  it('returns null only when the ring is secured', () => {
    expect(pickAttractHex(secured(ringPayload(1)))).toBeNull();
  });

  it('breaks equal-aggression ties by sorted id (replay determinism)', () => {
    const withTie = clone(ringPayload(1));
    for (const hex of withTie.ring.hexes) hex.aggression = 4;

    expect(pickAttractHex(withTie)).toBe('hex-r1-1');
    // Reordering the stored hexes does not change the choice.
    withTie.ring.hexes.reverse();
    expect(pickAttractHex(withTie)).toBe('hex-r1-1');
  });

  it('is deterministic for a seeded payload across repeated builds', () => {
    const seed = createHangarWarRng(11).nextInt(1_000_000);
    const payload = { ...revealPayload('hex-r1-2'), seed };
    expect(pickAttractHex(payload)).toBe(pickAttractHex(payload));
  });
});

describe('hex map model — grid columns (AC6)', () => {
  it('orders displayed hexes into spatial columns with the hangar folded in', () => {
    const model = buildHexMapModel(ringPayload(1));

    // Ring 1's screen layout (pointy-top axialToPixel: x ∝ q + r/2, y ∝ r):
    //   left→right columns by x: r1-4 | r1-3, r1-5 | r1-2, r1-6 | r1-1
    //   top→bottom rows within a column by r; the hangar is the bottom row.
    expect(model.gridColumns).toEqual([
      ['hex:hex-r1-4', HEX_MAP_HANGAR_ROW_KEY],
      ['hex:hex-r1-3', 'hex:hex-r1-5', HEX_MAP_HANGAR_ROW_KEY],
      ['hex:hex-r1-2', 'hex:hex-r1-6', HEX_MAP_HANGAR_ROW_KEY],
      ['hex:hex-r1-1', HEX_MAP_HANGAR_ROW_KEY],
    ]);

    // Every displayed hex key appears exactly once; the hangar row is the
    // folded-in bottom row of every column (arrows reach it from anywhere).
    const displayedKeys = model.hexes
      .filter((hex) => hex.displayed)
      .map((hex) => hex.key);
    const columnKeys = model.gridColumns.flat();
    for (const key of displayedKeys) {
      expect(columnKeys.filter((entry) => entry === key)).toHaveLength(1);
    }
    for (const column of model.gridColumns) {
      expect(column.at(-1)).toBe(HEX_MAP_HANGAR_ROW_KEY);
    }
  });

  it('only revealed hexes enter the columns; hidden hexes never do', () => {
    const model = buildHexMapModel(revealPayload('hex-r1-2'));
    const columnKeys = model.gridColumns.flat();
    const displayedKeys = model.hexes
      .filter((hex) => hex.displayed)
      .map((hex) => hex.key);

    // The hangar row is folded into every column (the bottom row), so the
    // keys present across the grid are the displayed hex keys plus hangar.
    expect(new Set(columnKeys)).toEqual(
      new Set([...displayedKeys, HEX_MAP_HANGAR_ROW_KEY]),
    );
    expect(columnKeys).not.toContain('hex:hex-r2-1');
    expect(columnKeys).not.toContain('hex:hex-r2-12');
  });

  it('keeps the hangar arrow-reachable on an unrevealed map', () => {
    const model = buildHexMapModel(ringPayload(2));
    expect(model.gridColumns).toEqual([[HEX_MAP_HANGAR_ROW_KEY]]);
  });
});

describe('hex map model — generated ring, partial ring and unknown definitions', () => {
  it('generates a fresh war\u2019s empty ring for display but never pads a partial ring', () => {
    const fresh = {
      ...createDefaultPayload(3),
      ring: { ringIndex: 2, hexes: [] },
    };
    const generated = buildHexMapModel(fresh);
    expect(generated.hexes).toHaveLength(12);
    expect(generated.hexes.every((hex) => !hex.held)).toBe(true);
    // A fresh ring-2 war is like a stored ring-2 ring: nothing is displayed
    // until a ring-1 neighbour is held (the hangar anchors ring 1 only).
    expect(generated.hexes.every((hex) => !hex.displayed)).toBe(true);
    // A fresh ring-1 war, by contrast, is anchored: its generated ring is
    // all hangar-adjacent, so every hex is displayed immediately.
    const freshRing1 = buildHexMapModel({ ...createDefaultPayload(0) });
    expect(freshRing1.hexes).toHaveLength(6);
    expect(freshRing1.hexes.every((hex) => hex.displayed)).toBe(true);
    expect(generated.hexes.map((hex) => hex.aggression)).toEqual(
      generateRing(2, HEX_RING_DEFINITIONS).hexes.map(
        (hex) => hex.baseAggression,
      ),
    );

    // A stored partial ring is rendered exactly as stored (never padded); its
    // ring-1 hexes are all hangar-adjacent, so all are displayed.
    const partial = buildHexMapModel(VALID_HANGAR_WAR_PAYLOAD);
    expect(partial.hexes.map((hex) => hex.id)).toEqual(['hex-1', 'hex-2']);
    expect(partial.hexes.every((hex) => hex.displayed)).toBe(true);
    expect(partial.hexes[0].held).toBe(true);
    expect(partial.hexes[1].held).toBe(false);
  });

  it('renders a stored hex with no authored definition from its persisted state', () => {
    const model = buildHexMapModel(VALID_HANGAR_WAR_PAYLOAD);
    const [held, unheld] = model.hexes;

    expect(held.id).toBe('hex-1');
    expect(held.displayed).toBe(true);
    expect(held.boss).toBeNull();
    expect(held.strengths).toEqual([]);
    expect(held.grants).toBeNull();
    expect(held.label).toContain('boss unknown');
    expect(held.label).toContain('→waveLaser');
    expect(held.selectable).toBe(true);
    expect(held.actionable).toBe(false);

    expect(unheld.id).toBe('hex-2');
    expect(unheld.aggression).toBe(3);
    expect(unheld.selectable).toBe(true);
    expect(unheld.actionable).toBe(true);
    expect(unheld.pendingAttack).toBeNull();
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
    expect(intel.displayed).toBe(true);
    expect(intel.selectable).toBe(true);
    expect(intel.actionable).toBe(false);
    expect(intel.tileLabel).toBe(`(1,0) AGG 0 ${HELD_TILE_MARKER}`);
    expect(intel.label).toContain('HELD · AGG 0');
    expect(intel.label).toContain(definition.boss);
  });
});

describe('buildHexMapModel — the redistributed frontier (AH-0MWBBUAUQ0038GFL)', () => {
  it('renders each hex\'s stored (redistributed) aggression, not a re-derived value', () => {
    const payload = aggressionScenario(1);
    const tick = runFrontierTick(payload);
    const model = buildHexMapModel(tick.payload);

    for (const hex of model.hexes) {
      const stored = tick.payload.ring.hexes.find(
        (candidate) => candidate.id === hex.id,
      );
      expect(stored).toBeDefined();
      expect(hex.aggression).toBe(stored?.aggression);
      expect(hex.tileLabel).toBe(
        `(${hex.q},${hex.r}) AGG ${stored?.aggression} ${
          hex.held ? HELD_TILE_MARKER : UNHELD_TILE_MARKER
        }`,
      );
    }
  });

  it('surfaces the ring\'s player strength and beatable ceiling', () => {
    const payload = aggressionScenario(2);
    const model = buildHexMapModel(payload);

    expect(model.playerStrength).toBe(resolvePlayerStrength(payload.hangar));
    expect(model.beatableCeiling).toBe(
      beatableAggressionCeiling(model.playerStrength),
    );
    expect(model.frontierLine).toContain(`STR ${model.playerStrength}`);
    expect(model.frontierLine).toContain(`BEAT ≤ ${model.beatableCeiling}`);
  });

  it('shows at least one hex in reach after a tick', () => {
    const tick = runFrontierTick(aggressionScenario(2));
    const model = buildHexMapModel(tick.payload);
    expect(
      model.hexes.some((hex) => hex.aggression <= model.beatableCeiling),
    ).toBe(true);
    expect(model.frontierLine).toContain('IN REACH');
  });
});

/**
 * Attack arrows and per-attack details over the transient tick record
 * (AH-0MWEXI5460080WEI, parent AH-0MWDC3L9I008INDP).
 *
 * The report is rolled into the hex map: the map publishes one arrow per
 * `record.attacks[]` entry (the record's attacker-origin axial coordinates →
 * the attacked hex) plus the per-attack details keyed by **both** arrow
 * endpoints, copied verbatim from the record via `buildDefenceReport`. Written
 * as `it.fails` red witnesses by AH-0MWEXI5460080WEI; the model item
 * (AH-0MWEXIAEQ004IT0R) landed the contract and flipped them back to `it`, so
 * a regression fails loudly here.
 *
 * ## Pinned contract (the model item must match exactly)
 *
 * - `BuildHexMapOptions` gains `record?: FrontierTickRecord`.
 * - `HexMapModel` gains
 *   - `arrows: readonly HexMapAttackArrow[]` — one entry per
 *     `record.attacks[]` entry, in the record's order, with
 *     `{ key: 'arrow:<hexId>', hexId, attackerOriginId, attackerOrigin }`
 *     (`attackerOrigin` copied from the record's own axial coordinates);
 *   - `attackDetails: ReadonlyMap<string, DefenceReportRow>` — the report
 *     model's row keyed by the attacked hex id **and** by the
 *     attacker-origin hex id, so either arrow endpoint resolves the same
 *     attack's numbers. When a hex is both endpoints, the attacked entry wins.
 * - Both are empty (`arrows: []`, an empty map) for a missing, empty or
 *   malformed record — a quiet tick, never a throw.
 */

/**
 * The model with the attack fields this test-first item pins. The contract now
 * lives on the shipped `HexMapModel` (AH-0MWEXIAEQ004IT0R), so this is an alias
 * — the pinned fields must stay required, not optional.
 */
type AttackAwareHexMapModel = HexMapModel;

/** The build options with the record this test-first item pins. */
type AttackAwareOptions = BuildHexMapOptions & {
  readonly record?: FrontierTickRecord;
};

/** Builds the map model with a record, through a seam that type-checks here. */
function buildAttackModel(
  payload: HangarWarPayload,
  record?: FrontierTickRecord,
): AttackAwareHexMapModel {
  const options = {
    definitions: HEX_RING_DEFINITIONS,
    ...(record === undefined ? {} : { record }),
  } as AttackAwareOptions;
  return buildHexMapModel(payload, options) as AttackAwareHexMapModel;
}

/**
 * A two-hex payload: `hex-held` is the player's and `hex-frontier` is the
 * unheld neighbour the tick attacked from (the answerability pair).
 */
function attackPayload(): HangarWarPayload {
  const template = createDefaultPayload(424242);
  return {
    ...template,
    hangar: {
      ...template.hangar,
      bankedMinerals: 120,
      bankedCores: 1,
    },
    ring: {
      ringIndex: 1,
      hexes: [
        {
          id: 'hex-held',
          q: 1,
          r: 0,
          held: false,
          aggression: 3,
          defender: null,
          bossDefeated: true,
          grantedWeapon: null,
        },
        {
          id: 'hex-frontier',
          q: 0,
          r: 1,
          held: false,
          aggression: 3,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
      ],
    },
  };
}

/** One resolved attack, as the frontier tick's record carries it. */
function recordAttack(
  overrides: Partial<HexDefenceRecord> = {},
): HexDefenceRecord {
  return {
    outcome: 'fell',
    defenderRating: 2,
    attackingForce: 4,
    aggression: 3,
    aggressionMultiplierPercent: 145,
    jitterPercent: 6,
    attackStrength: 6,
    margin: -4,
    hexId: 'hex-held',
    attackerOriginId: 'hex-frontier',
    attackerOrigin: { q: 0, r: 1 },
    source: 'frontier',
    ...overrides,
  };
}

/** A tick record over the given attacks. */
function recordWith(
  attacks: readonly HexDefenceRecord[],
): FrontierTickRecord {
  return {
    tick: 7,
    playerStrength: 2,
    aggressionBudget: 20,
    beatableCeiling: 2,
    deltas: [],
    rose: 0,
    fell: 0,
    attacks,
  };
}

describe('hex map model — attack arrows from the tick record', () => {
  it(
    'publishes one arrow per resolved attack, from the record\'s origin to its target',
    () => {
      const model = buildAttackModel(
        attackPayload(),
        recordWith([recordAttack()]),
      );

      expect(model.arrows).toHaveLength(1);
      expect(model.arrows![0]).toEqual({
        key: 'arrow:hex-held',
        hexId: 'hex-held',
        attackerOriginId: 'hex-frontier',
        // Copied from the record's own axial coordinates, never re-derived.
        attackerOrigin: { q: 0, r: 1 },
      });
    },
  );

  it(
    'publishes every attack in the record\'s order (one source, no per-scene rule)',
    () => {
      const attacks = [
        recordAttack(),
        recordAttack({
          hexId: 'hex-held-2',
          attackerOriginId: 'hex-frontier-2',
          attackerOrigin: { q: 0, r: -1 },
        }),
      ];
      const model = buildAttackModel(attackPayload(), recordWith(attacks));

      expect(
        model.arrows?.map((arrow) => [
          arrow.hexId,
          arrow.attackerOriginId,
          arrow.attackerOrigin,
        ]),
      ).toEqual([
        ['hex-held', 'hex-frontier', { q: 0, r: 1 }],
        ['hex-held-2', 'hex-frontier-2', { q: 0, r: -1 }],
      ]);
    },
  );

  it('is total: a missing record publishes no arrows and no details', () => {
    const model = buildAttackModel(attackPayload());

    expect(model.arrows).toEqual([]);
    expect(model.attackDetails?.size).toBe(0);
  });

  it('is total: a quiet tick publishes no arrows and no details', () => {
    const model = buildAttackModel(attackPayload(), recordWith([]));

    expect(model.arrows).toEqual([]);
    expect(model.attackDetails?.size).toBe(0);
  });

  it('is total: a malformed record publishes no arrows and no details', () => {
    const malformed = {
      ...recordWith([]),
      attacks: undefined as unknown as readonly HexDefenceRecord[],
    };
    const model = buildAttackModel(attackPayload(), malformed);

    expect(model.arrows).toEqual([]);
    expect(model.attackDetails?.size).toBe(0);
  });
});

describe('hex map model — per-attack details keyed by hex id', () => {
  it(
    'keys the same attack under the attacked hex id and the attacker-origin id',
    () => {
      const payload = attackPayload();
      const record = recordWith([recordAttack()]);
      const model = buildAttackModel(payload, record);
      const reportRow = buildDefenceReport(payload, record).rows[0];
      const details = model.attackDetails;

      expect(details).toBeDefined();
      // The attacked endpoint carries the report model's own row…
      expect(details!.get('hex-held')).toEqual(reportRow);
      // …and the attacker-origin endpoint resolves the same attack's details.
      expect(details!.get('hex-frontier')).toEqual(reportRow);
      // A hex involved in no attack has no details.
      expect(details!.has('hex-not-attacked')).toBe(false);
    },
  );

  it('copies every resolved number verbatim (no re-derivation)', () => {
    const payload = attackPayload();
    const record = recordWith([recordAttack()]);
    const model = buildAttackModel(payload, record);
    const source = record.attacks[0];
    const reportRow = buildDefenceReport(payload, record).rows[0];
    const detail = model.attackDetails!.get('hex-held')!;

    expect(detail).toMatchObject({
      hexId: source.hexId,
      attackerOriginId: source.attackerOriginId,
      outcome: source.outcome,
      attackingForce: source.attackingForce,
      aggression: source.aggression,
      aggressionMultiplierPercent: source.aggressionMultiplierPercent,
      jitterPercent: source.jitterPercent,
      defenderRating: source.defenderRating,
      attackStrength: source.attackStrength,
      margin: source.margin,
      source: source.source,
    });
    // The retake plan and the rendered label are the report model's, so the
    // map can never publish a second, drifting set of numbers.
    expect(detail.retake).toEqual(reportRow.retake);
    expect(detail.label).toBe(reportRow.label);
    expect(detail.label).toContain(
      `atk ${source.attackingForce} × AGG ${source.aggression}`,
    );
    expect(detail.label).toContain(
      `= ${source.attackStrength} vs bot ${source.defenderRating}`,
    );
    expect(detail.label).toContain('margin -4');
    expect(detail.label).toContain('retake: strike hex-frontier');
  });

  it('never re-resolves the attack from the payload\'s stored numbers', () => {
    // A record whose numbers deliberately disagree with the payload (the
    // payload's hex has aggression 3 and no defender): the details must show
    // the record's numbers, not a fresh preview.
    const payload = attackPayload();
    const record = recordWith([
      recordAttack({
        attackingForce: 11,
        aggression: 9,
        aggressionMultiplierPercent: 210,
        defenderRating: 40,
        attackStrength: 31,
        margin: 9,
        outcome: 'held',
      }),
    ]);
    const detail = buildAttackModel(payload, record).attackDetails!.get(
      'hex-held',
    )!;

    expect(detail.attackingForce).toBe(11);
    expect(detail.aggression).toBe(9);
    expect(detail.aggressionMultiplierPercent).toBe(210);
    expect(detail.defenderRating).toBe(40);
    expect(detail.attackStrength).toBe(31);
    expect(detail.margin).toBe(9);
    expect(detail.outcome).toBe('held');
    expect(detail.label).toContain('atk 11 × AGG 9 (210%');
    expect(detail.label).toContain('= 31 vs bot 40');
  });
});

describe('hex map model — the hangar assault surface (AH-0MWEZZA4E0081NJ5)', () => {
  /** Jitter disabled, so the assault arithmetic is exact. */
  const NO_JITTER: FrontierTuning = {
    ...DEFAULT_FRONTIER_TUNING,
    jitterPercent: 0,
  };

  /** A jitter-free assault resolution from stored numbers only. */
  function assault(
    defenderSum: number,
    attackerBase: number,
  ): HangarAssaultResolution {
    return resolveHangarAssault(
      { defenderSum, attackerBase, aggression: 0, seed: 1 },
      NO_JITTER,
    );
  }

  it('carries no assault on an ordinary landing', () => {
    const model = buildHexMapModel(ringPayload(1));

    expect(model.assault).toBeNull();
    expect(model.assaultLine).toBeNull();
    expect(model.ringWon).toBe(false);
    expect(model.campaignReset).toBe(false);
  });

  it('copies every assault figure verbatim from the resolver record', () => {
    const resolution = assault(12, 5);
    const model = buildHexMapModel(ringPayload(1), { assault: resolution });

    expect(model.assault).not.toBeNull();
    expect(model.assault!.outcome).toBe(resolution.outcome);
    expect(model.assault!.defenderSum).toBe(resolution.defenderSum);
    expect(model.assault!.attackerBase).toBe(resolution.attackerBase);
    expect(model.assault!.aggression).toBe(resolution.aggression);
    expect(model.assault!.aggressionMultiplierPercent).toBe(
      resolution.aggressionMultiplierPercent,
    );
    expect(model.assault!.jitterPercent).toBe(resolution.jitterPercent);
    expect(model.assault!.attackStrength).toBe(resolution.attackStrength);
    expect(model.assault!.margin).toBe(resolution.margin);
    // The rendered line is the report model's own section label.
    expect(model.assaultLine).toBe(model.assault!.label);
    expect(model.assaultLine).not.toBe('');
  });

  it('announces the ring won on a repel', () => {
    const model = buildHexMapModel(ringPayload(1), { assault: assault(12, 5) });

    expect(model.ringWon).toBe(true);
    expect(model.campaignReset).toBe(false);
    expect(model.assault!.ringWon).toBe(true);
    expect(model.assaultLine).toContain(ASSAULT_REPELLED_HEADLINE);
    expect(model.assaultLine).toContain(ASSAULT_REPELLED_CONSEQUENCE);
    expect(model.assaultLine).toContain('defender sum 12');
    expect(model.assaultLine).toContain('massed 5');
    expect(model.assaultLine).not.toContain('HANGAR FALLS');
    expect(model.assaultLine).not.toContain('FULL CAMPAIGN RESET');
  });

  it('announces the hangar-falls full campaign reset on a fall', () => {
    const model = buildHexMapModel(ringPayload(1), { assault: assault(3, 5) });

    expect(model.ringWon).toBe(false);
    expect(model.campaignReset).toBe(true);
    expect(model.assault!.campaignReset).toBe(true);
    expect(model.assaultLine).toContain(ASSAULT_HANGAR_FALLS_HEADLINE);
    expect(model.assaultLine).toContain(ASSAULT_HANGAR_FALLS_CONSEQUENCE);
    expect(model.assaultLine).toContain('FULL CAMPAIGN RESET');
    expect(model.assaultLine).not.toContain('RING WON');
  });

  it('renders the assault beside a quiet tick and a noisy tick alike', () => {
    const quiet = buildHexMapModel(ringPayload(1), {
      assault: assault(12, 5),
    });
    expect(quiet.arrows).toEqual([]);
    expect(quiet.attackDetails.size).toBe(0);
    expect(quiet.assaultLine).not.toBeNull();

    const noisy = buildHexMapModel(attackPayload(), {
      record: recordWith([recordAttack()]),
      assault: assault(12, 5),
    });
    expect(noisy.arrows).toHaveLength(1);
    expect(noisy.attackDetails.size).toBeGreaterThan(0);
    expect(noisy.assaultLine).not.toBeNull();
  });

  it('never mutates the resolution and is deterministic', () => {
    const resolution = assault(12, 5);
    const before = { ...resolution };

    const first = buildHexMapModel(ringPayload(1), { assault: resolution });
    const second = buildHexMapModel(ringPayload(1), { assault: resolution });

    expect(resolution).toEqual(before);
    expect(first.assault).toEqual(second.assault);
    expect(first.assaultLine).toBe(second.assaultLine);
  });

  it('never stalls the attract traversal on an assault landing', () => {
    // The announcement adds no action: the map still offers exactly the same
    // next step (the attract hex, or the hangar once the ring is secured).
    const model = buildHexMapModel(ringPayload(1), { assault: assault(3, 5) });

    expect(model.attractHexId).not.toBeNull();
    expect(model.defaultFocusKey).toBe(`hex:${model.attractHexId}`);
    expect(model.focusOrder).toContain(HEX_MAP_HANGAR_ROW_KEY);
  });
});

describe('hex map model — the pure attack model stays Phaser-free', () => {
  it('imports no Phaser in the pure hangar-war model modules', () => {
    for (const file of ['hexIntel.ts', 'defenceReport.ts']) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(source, `${file} must not import Phaser`).not.toMatch(
        /from\s+['"]phaser['"]/,
      );
    }
  });
});

/**
 * The published special-mission intel (`AH-0MWF0CWB7002MG2F`, post-MVP Hangar
 * War AH-0MVWZYIWX0008C55 AC4).
 *
 * A special mission is only a choice if the player sees its reward *before*
 * committing a life, so the map publishes the hull, its extra hit points and
 * the authored framing in the detail panel while the tile stays a legible
 * short label. The ring rotates its offer between sorties, so the model also
 * marks which special hex is offered **now** — through the shared
 * `specialMission` seam, so the map can never advertise a reward the capture
 * would not pay.
 */
describe('hex map model — special-mission intel (AH-0MWF0CWB7002MG2F)', () => {
  /** The authored special mission (ring 2's `the-void-marshall`). */
  const SPECIAL_HEX_ID = 'hex-r2-3';

  it('publishes the reward and framing for the special-mission hex', () => {
    const model = buildHexMapModel(ringPayload(2));
    const intel = model.hexes.find((hex) => hex.id === SPECIAL_HEX_ID);

    expect(intel).toBeDefined();
    expect(intel?.isSpecialMission).toBe(true);
    expect(intel?.specialMission).not.toBeNull();
    expect(intel?.specialMission?.hullId).toBe('hull-3');
    expect(intel?.specialMission?.hullName).toBe('Juggernaut Hull');
    expect(intel?.specialMission?.bonusStartingLives).toBeGreaterThan(0);
    expect(intel?.specialMission?.description.length).toBeGreaterThan(0);
    // The reward the map advertises is the reward the capture pays (one
    // derivation, pinned by the capture-cycle suite).
    expect(intel?.specialMission?.hullId).toBe(intel?.grants);
  });

  it('keeps the tile label short and puts the reward in the detail panel', () => {
    const model = buildHexMapModel(ringPayload(2));
    const intel = model.hexes.find((hex) => hex.id === SPECIAL_HEX_ID)!;

    // Legible short label: coordinates, aggression, ownership, the tag.
    expect(intel.tileLabel).toContain('AGG');
    expect(intel.tileLabel).toContain(SPECIAL_MISSION_TILE_TAG);
    expect(intel.tileLabel.split('\n')).toHaveLength(2);
    // No wall of text on the tile itself.
    expect(intel.tileLabel).not.toContain('Juggernaut');

    // The full offer lives in the detail panel.
    expect(intel.label).toContain(SPECIAL_MISSION_PANEL_HEADING);
    expect(intel.label).toContain('Juggernaut Hull');
    expect(intel.label).toContain('OFFERED THIS SORTIE');
    expect(intel.label).toContain('+2 LIVES');
  });

  it('publishes no special-mission intel for an ordinary hex', () => {
    const model = buildHexMapModel(ringPayload(2));
    const ordinary = model.hexes.find((hex) => hex.id === 'hex-r2-1');

    expect(ordinary?.isSpecialMission).toBe(false);
    expect(ordinary?.specialMission).toBeNull();
    expect(ordinary?.tileLabel).not.toContain(SPECIAL_MISSION_TILE_TAG);
  });

  it('publishes exactly one offered mission, resolved from the rotation', () => {
    const payload = ringPayload(2);
    const model = buildHexMapModel(payload);

    expect(model.specialOffer).not.toBeNull();
    expect(model.specialOffer?.hexId).toBe(SPECIAL_HEX_ID);
    expect(model.specialOffer?.sortie).toBe(0);
    const offered = model.hexes.filter((hex) => hex.specialMission?.offeredNow);
    expect(offered.map((hex) => hex.id)).toEqual([SPECIAL_HEX_ID]);
  });

  it('moves the offered marker with the between-sortie sortie counter', () => {
    // Two authored special missions make the rotation observable; the shipped
    // rings author one, so the harness ring is the only way to see the marker
    // move between sorties.
    const definitions = HEX_RING_DEFINITIONS.filter(
      (definition) => definition.ringIndex === 1,
    ).map((definition, index) => ({
      ...definition,
      isSpecialMission: index < 2,
      grants: index === 0 ? 'hull-2' : index === 1 ? 'hull-3' : definition.grants,
    }));
    const payload: HangarWarPayload = {
      ...createDefaultPayload(21),
      ring: createRingState(1, definitions),
    };

    const seen = new Set<string | null>();
    for (let sortie = 0; sortie < 6; sortie += 1) {
      const model = buildHexMapModel(
        { ...payload, frontierTick: sortie },
        { definitions },
      );
      const offered = model.hexes.filter((hex) => hex.specialMission?.offeredNow);
      expect(offered).toHaveLength(1);
      expect(model.specialOffer?.hexId).toBe(offered[0].id);
      seen.add(model.specialOffer?.hexId ?? null);
    }

    expect(seen.size).toBeGreaterThan(1);
  });

  it('keeps publishing a captured mission’s reward but offers nothing', () => {
    const captured = withHex(ringPayload(2), SPECIAL_HEX_ID, {
      held: true,
      bossDefeated: true,
      grantedWeapon: 'hull-3',
      defender: {
        hullId: DEFAULT_HULL_ID,
        defenceRating: 9,
        bankedMinerals: 0,
      },
    });
    const model = buildHexMapModel(captured);
    const intel = model.hexes.find((hex) => hex.id === SPECIAL_HEX_ID)!;

    // Nothing left to offer on the ring ...
    expect(model.specialOffer).toBeNull();
    expect(model.hexes.some((hex) => hex.specialMission?.offeredNow)).toBe(false);
    // ... but the hex still reads as the special mission it was.
    expect(intel.specialMission?.hullId).toBe('hull-3');
    expect(intel.specialMission?.offeredNow).toBe(false);
    expect(intel.label).toContain('NOT OFFERED NOW');
  });

  it('offers nothing on a ring that authors no special mission', () => {
    const model = buildHexMapModel(ringPayload(1));

    expect(model.specialOffer).toBeNull();
    expect(model.hexes.every((hex) => hex.specialMission === null)).toBe(true);
  });
});
