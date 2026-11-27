/**
 * Arena mineral absorption (AH-0MWT5CSF8003CFQF).
 *
 * Real-supply mode must mirror the shipped game's **absorption** half of the
 * economy as well as its kill-drop half: a live non-asteroid hostile that
 * overlaps a mineral swallows it, tallying the mineral's **worth** on its own
 * `mineralCollected` counter (exactly `collectMinerals` /
 * `BaseEnemy.collectMineral` in the game), so the wreck's later kill payout
 * re-drops the absorbed count through the shared rule. Asteroids and
 * lane-traffic hazards are inert (never absorb).
 *
 * These tests pin both halves:
 *
 * - the pure arena seam {@link absorbOverlappingMinerals} — overlap geometry,
 *   value-aware credit (a red deposit is worth ten), inert bodies excluded,
 *   first-overlapping-hostile order and the survivor contract;
 * - the chain into {@link resolveArenaWreckMinerals} — the absorbed count is
 *   what the wreck re-drops;
 * - the integrated run — absorption happens in real-supply mode, adds a
 *   `mineral_absorbed` telemetry event, is deterministic and *increases* the
 *   sortie's mineral supply (the economy loop, not mineral deletion).
 */

import { describe, expect, it } from 'vitest';

import {
  absorbOverlappingMinerals,
  resolveArenaWreckMinerals,
  runArena,
  type ArenaMineral,
  type ArenaMineralAbsorber,
} from './arena';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import { MINERAL_DEPOSIT_VALUE, MINERAL_SIZE } from '../../core/constants';
import type { LevelDefinition } from '../../waves/Formations';
import type { TelemetryRecord } from './types';

const BUILD = { appVersion: 'arena-mineral-absorption', commit: 'test' };

/** A mineral worth `value` at the given position. */
function mineral(x: number, y: number, value = 1): ArenaMineral {
  return { x, y, value };
}

/** A minimal absorbable hostile for the pure seam. */
function hostile(
  overrides: Partial<ArenaMineralAbsorber> & { radius?: number } = {},
): ArenaMineralAbsorber {
  const radius = overrides.radius ?? 10;
  return {
    alive: true,
    isAsteroid: false,
    archetype: 'scout',
    x: 200,
    y: 200,
    ...overrides,
    getHitRadius: () => radius,
    mineralCollected: overrides.mineralCollected ?? 0,
  };
}

/**
 * A two-wave level: the first wave places one non-firing scout per `positions`
 * entry, the second adds one distant scout `tail` so the run outlives the first
 * wave's clear.
 */
function oneWaveLevel(
  positions: ReadonlyArray<{ x: number; y: number }>,
  tail: { x: number; y: number },
): LevelDefinition {
  const group = (position: { x: number; y: number }) => ({
    enemyKey: 'scout',
    formation: 'single' as const,
    count: 1,
    spacingX: 0,
    spacingY: 0,
    startX: position.x,
    startY: position.y,
  });
  return {
    level: 1,
    name: 'mineral-absorption',
    waves: [
      { groups: positions.map(group), shootEnabled: false },
      { groups: [group(tail)], shootEnabled: false },
    ],
  };
}

// Two scouts sharing an exact spawn point: the survivor sits on the first
// wreck's drops and swallows any that land under its hull. The **full-campaign**
// seam is used because it positions groups at their authored `startX/startY`
// through the shared `WaveManager`; the per-level harness plan instead seeds
// every member at a random point (a documented path difference).
//
// A distant second wave keeps the run alive after the absorbing wreck dies, so
// the re-dropped minerals are sampled and counted (the final clear ends the run
// on the same tick it fires).
const SAME_POINT_LEVEL = oneWaveLevel(
  [
    { x: 200, y: 200 },
    { x: 200, y: 200 },
  ],
  { x: 850, y: 470 },
);
// The same two scouts far apart: no hostile can ever overlap a drop, so this
// is the absorption-free control for the same seed.
const APART_LEVEL = oneWaveLevel(
  [
    { x: 200, y: 200 },
    { x: 760, y: 90 },
  ],
  { x: 850, y: 470 },
);

function runSortie(
  level: LevelDefinition,
  seed: number,
  ticks = 3600,
): readonly TelemetryRecord[] {
  return runArena(createLegacyBotPolicy(), {
    seed,
    ticks,
    dt: 1 / 60,
    campaign: true,
    campaignLevels: [level],
    // No elites and no asteroid shadow-hazard: the only bodies on the field are
    // the two scouts, so absorption is attributable to them alone.
    eliteWaveChance: 0,
    spawns: { minerals: 6, powerUps: 0, enemies: 0, asteroids: 0 },
    sampleEveryTicks: 1,
    build: BUILD,
  }).records;
}

/** The mineral accounting a run's telemetry reports. */
function readAccounting(records: readonly TelemetryRecord[]): {
  collected: number;
  absorbed: number;
  kills: number;
  absorbedEvents: ReadonlyArray<Readonly<Record<string, unknown>>>;
  finalField: number;
  introduced: number;
  collectedPoints: Array<{ x: number; y: number }>;
  absorbedPoints: Array<{ x: number; y: number }>;
} {
  let collected = 0;
  let absorbed = 0;
  let kills = 0;
  let finalField = 0;
  const absorbedEvents: Array<Readonly<Record<string, unknown>>> = [];
  const collectedPoints: Array<{ x: number; y: number }> = [];
  const absorbedPoints: Array<{ x: number; y: number }> = [];
  for (const record of records) {
    if (record.kind === 'event') {
      if (record.event === 'mineral_collected') {
        const value = Number(record.payload?.value ?? 1);
        collected += Number.isFinite(value) ? value : 1;
        collectedPoints.push({
          x: Number(record.payload?.x),
          y: Number(record.payload?.y),
        });
      }
      if (record.event === 'mineral_absorbed') {
        const value = Number(record.payload?.value ?? 1);
        absorbed += Number.isFinite(value) ? value : 1;
        absorbedPoints.push({
          x: Number(record.payload?.x),
          y: Number(record.payload?.y),
        });
        absorbedEvents.push(record.payload);
      }
      if (record.event === 'enemy_killed') kills += 1;
      continue;
    }
    if (record.kind !== 'tick') continue;
    finalField = record.state.minerals.length;
  }
  return {
    collected,
    absorbed,
    kills,
    absorbedEvents,
    finalField,
    introduced: collected + absorbed + finalField,
    collectedPoints,
    absorbedPoints,
  };
}

describe('absorbOverlappingMinerals — the game absorption rule', () => {
  it('absorbs an overlapping mineral into the hostile and removes it from the field', () => {
    const body = hostile();
    const field = [mineral(205, 200)];
    const pass = absorbOverlappingMinerals(field, [body]);
    expect(pass.kept).toEqual([]);
    expect(pass.absorbed).toHaveLength(1);
    expect(pass.absorbed[0].hostile).toBe(body);
    expect(body.mineralCollected).toBe(1);
  });

  it('credits the mineral’s worth: a red deposit is ten minerals in one overlap', () => {
    const body = hostile();
    absorbOverlappingMinerals([mineral(200, 200, MINERAL_DEPOSIT_VALUE)], [body]);
    expect(body.mineralCollected).toBe(MINERAL_DEPOSIT_VALUE);
  });

  it('absorbs on the exact hull edge and leaves a mineral one pixel beyond it', () => {
    const radius = 10;
    const reach = MINERAL_SIZE + radius;
    const body = hostile({ radius });
    expect(
      absorbOverlappingMinerals([mineral(200 + reach, 200)], [body]).absorbed,
    ).toHaveLength(1);
    const missed = hostile({ radius });
    const pass = absorbOverlappingMinerals(
      [mineral(200 + reach + 1, 200)],
      [missed],
    );
    expect(pass.absorbed).toEqual([]);
    expect(pass.kept).toHaveLength(1);
    expect(missed.mineralCollected).toBe(0);
  });

  it('never absorbs into an asteroid (inert to minerals in the game)', () => {
    const rock = hostile({ isAsteroid: true, archetype: 'asteroid' });
    const pass = absorbOverlappingMinerals([mineral(200, 200)], [rock]);
    expect(pass.absorbed).toEqual([]);
    expect(pass.kept).toHaveLength(1);
    expect(rock.mineralCollected).toBe(0);
  });

  it('never absorbs into a lane-traffic hazard (not a mineral carrier)', () => {
    const traffic = hostile({ archetype: 'lane-traffic' });
    const pass = absorbOverlappingMinerals([mineral(200, 200)], [traffic]);
    expect(pass.absorbed).toEqual([]);
    expect(pass.kept).toHaveLength(1);
    expect(traffic.mineralCollected).toBe(0);
  });

  it('skips a destroyed hostile and lets the next live one absorb', () => {
    const dead = hostile({ alive: false });
    const live = hostile();
    const pass = absorbOverlappingMinerals([mineral(200, 200)], [dead, live]);
    expect(dead.mineralCollected).toBe(0);
    expect(live.mineralCollected).toBe(1);
    expect(pass.absorbed).toHaveLength(1);
    expect(pass.absorbed[0].hostile).toBe(live);
  });

  it('credits only the first overlapping hostile, mirroring collectMinerals', () => {
    const first = hostile();
    const second = hostile();
    const pass = absorbOverlappingMinerals([mineral(200, 200)], [first, second]);
    expect(first.mineralCollected).toBe(1);
    expect(second.mineralCollected).toBe(0);
    expect(pass.absorbed[0].hostile).toBe(first);
  });

  it('returns the survivors in order without mutating the input array', () => {
    const field = [mineral(200, 200), mineral(600, 400), mineral(200, 200)];
    const body = hostile();
    const pass = absorbOverlappingMinerals(field, [body]);
    expect(pass.kept).toEqual([{ x: 600, y: 400, value: 1 }]);
    expect(field).toHaveLength(3);
  });

  it('consumes no randomness: identical input ⇒ identical output', () => {
    const makeField = () => [mineral(205, 205), mineral(700, 100, 10)];
    const first = hostile();
    const second = hostile();
    const a = absorbOverlappingMinerals(makeField(), [first]);
    const b = absorbOverlappingMinerals(makeField(), [second]);
    expect(a.kept).toEqual(b.kept);
    expect(a.absorbed.map((entry) => entry.mineral)).toEqual(
      b.absorbed.map((entry) => entry.mineral),
    );
    expect(a.absorbed.map((entry) => entry.total)).toEqual(
      b.absorbed.map((entry) => entry.total),
    );
    expect(first.mineralCollected).toBe(second.mineralCollected);
  });
});

describe('the absorbed count feeds the wreck re-drop through the shared rule', () => {
  it('re-drops 2 × round(absorbed + bonus) for a hostile that swallowed a dot', () => {
    const body = hostile();
    absorbOverlappingMinerals([mineral(200, 200)], [body]);
    expect(body.mineralCollected).toBe(1);
    // rng 0.999 → bonus ≈ 1.249 → round(1 + 1.249) = 2 → the doubled count.
    const drops = resolveArenaWreckMinerals(
      { x: 200, y: 200, isAsteroid: false, archetype: 'scout', mineralCollected: body.mineralCollected },
      () => 0.999,
    );
    expect(drops).toHaveLength(4);
    expect(drops.every((drop) => drop.value === 1)).toBe(true);
  });

  it('collapses an absorbed deposit’s re-drop to one 10-value deposit', () => {
    const body = hostile();
    absorbOverlappingMinerals(
      [mineral(200, 200, MINERAL_DEPOSIT_VALUE)],
      [body],
    );
    expect(body.mineralCollected).toBe(MINERAL_DEPOSIT_VALUE);
    // 2 × round(10.25) = 20 ≥ the deposit threshold → one red deposit.
    expect(
      resolveArenaWreckMinerals(
        { x: 200, y: 200, isAsteroid: false, archetype: 'scout', mineralCollected: body.mineralCollected },
        () => 0,
      ),
    ).toEqual([{ x: 200, y: 200, value: MINERAL_DEPOSIT_VALUE }]);
  });
});

describe('real-supply runs absorb minerals (AH-0MWT5CSF8003CFQF)', () => {
  it('emits a mineral_absorbed event with the hike’s running total', () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((seed) =>
      readAccounting(runSortie(SAME_POINT_LEVEL, seed)),
    );
    const absorbing = runs.filter((run) => run.absorbed > 0);
    expect(absorbing.length).toBeGreaterThan(0);
    for (const run of absorbing) {
      for (const payload of run.absorbedEvents) {
        expect(Number.isFinite(Number(payload.x))).toBe(true);
        expect(Number.isFinite(Number(payload.y))).toBe(true);
        // The running per-hostile count is always positive after absorbing.
        expect(Number(payload.total)).toBeGreaterThanOrEqual(1);
        // Ordinary dots omit `value` (the `mineral_collected` shape), so an
        // existing payload consumer never sees a new field on the common path.
        if ('value' in payload) {
          expect(Number(payload.value)).toBe(MINERAL_DEPOSIT_VALUE);
        }
      }
    }
  });

  it('re-drops the absorbed minerals at the wreck instead of deleting them', () => {
    // Same seed, same first wreck, same bonus stream: the only difference is
    // whether a second hostile sits on the wreck and swallows the drops. The
    // absorbing sortie must supply strictly more minerals — proof the economy
    // loop is re-dropping the absorbed count rather than removing it.
    const witnesses = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].filter((seed) => {
      const absorbing = readAccounting(runSortie(SAME_POINT_LEVEL, seed));
      const control = readAccounting(runSortie(APART_LEVEL, seed));
      return absorbing.absorbed > 0 && absorbing.introduced > control.introduced;
    });
    expect(witnesses.length).toBeGreaterThan(0);

    // Seed 3 pinned: the survivor swallows the first wreck's whole two-dot
    // payout, then its own wreck re-drops `2 × round(2 + bonus)` = 4 at the
    // same point (the bonus rolled below 0.5). The sortie therefore supplies
    // **6** minerals — the 2 absorbed (counted once) plus the 4 re-dropped —
    // where the absorption-free control supplies only 2. A model that merely
    // deleted the absorbed minerals could never report 6 here.
    const absorbing = readAccounting(runSortie(SAME_POINT_LEVEL, 3));
    const control = readAccounting(runSortie(APART_LEVEL, 3));
    expect(absorbing.absorbed).toBe(2);
    expect(absorbing.introduced).toBe(6);
    expect(control.absorbed).toBe(0);
    expect(control.introduced).toBe(2);
  });

  it('never credits one mineral twice: collected and absorbed are disjoint', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
      const run = readAccounting(runSortie(SAME_POINT_LEVEL, seed));
      const absorbed = new Set(
        run.absorbedPoints.map((point) => `${point.x},${point.y}`),
      );
      for (const point of run.collectedPoints) {
        expect(absorbed.has(`${point.x},${point.y}`)).toBe(false);
      }
    }
  });

  it('is deterministic: same policy + config + seed ⇒ byte-identical records', () => {
    expect(runSortie(SAME_POINT_LEVEL, 3)).toEqual(
      runSortie(SAME_POINT_LEVEL, 3),
    );
  });
});
