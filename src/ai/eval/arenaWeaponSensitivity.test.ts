/**
 * Weapon-output sensitivity and determinism contract for the headless arena
 * (AH-0MW5DV8AQ002ZQB6, **TEST-FIRST**).
 *
 * The closed-loop arena used to fire the player's shots on a fixed cadence
 * with one hardcoded bullet, so no weapon-related lever could reach the
 * simulation: a designer's cadence, pattern or AOE-radius edit produced a
 * byte-identical batch (the AH-0MVWAVM03002FLLL sensitivity probe). These
 * tests pin the **inverse** contract — the arena's fire model consumes the
 * shared weapon catalogue, so a same-seed batch pair that differs in exactly
 * one weapon-output lever must produce a different per-run `recordsHash` and
 * different aggregate metrics.
 *
 * ## Red-before/green-after (the repo convention)
 *
 * Every sensitivity test below was authored under Vitest's `it.fails` (the
 * repo's red-before/green-after convention, see `src/core/levelScaling.test.ts`
 * and the per-level block in `arena.test.ts`). On the pre-change HEAD the arena
 * ignored weapon data entirely, so each pair was **byte-identical** and the
 * pinned assertion failed — the suite stayed green because the failure was
 * expected. A leftover `it.fails` fails the suite, so each flip is deliberate;
 * all three arms are now plain `it` (the cadence and pattern arms were flipped
 * by **AH-0MW5DV9I6001D4HN**, the AOE arm by **AH-0MW5DVAME0062GQO**):
 *
 * | Test | Flips to `it` when |
 * |------|--------------------|
 * | cadence (`fireRateMs`) | **AH-0MW5DV9I6001D4HN** resolves the cannon's cadence from `fireRateMs` — **flipped** |
 * | pattern count (`offsets`) | **AH-0MW5DV9I6001D4HN** spawns the cannon's resolved pattern — **flipped** |
 * | AOE radius | **AH-0MW5DVAME0062GQO** fires the owned AOE weapons through the shared AOE seam — **flipped** |
 *
 * The control pair (identical seed + config + policy is byte-identical) is
 * **already green** and must stay green: sensitivity is worthless if the
 * arena stops being seed-deterministic.
 *
 * ## The levers are the shared weapon catalogue, not arena-local knobs
 *
 * Each pair overrides exactly one field of one {@link WEAPON_CATALOGUE} entry
 * for the duration of one batch and restores it in a `finally` — the runtime
 * equivalent of a designer editing one cell of `src/data/weapons.csv`. That
 * keeps the bar honest: the arena must read the **shared** catalogue the game
 * reads (gym↔game parity, AH-0MUGZDTFX004RBD1), so no arena-local injection
 * seam is introduced by this slice (the item's acceptance criterion is that
 * an edit to the shipped weapon data is *visible*, not that a test-only
 * override exists).
 *
 * The AOE arm needs an AOE weapon to be **owned** before it can fire, so the
 * batch forces a known loadout through the existing `choicePool` seam (a
 * pool containing only `nova`) with a hold capacity of 1 — every mineral
 * pickup resolves a choice and grants the AOE weapon permanently. Each arm
 * asserts the loadout was actually applied, so a config regression cannot
 * make the AOE test vacuously pass on two cannon-only runs.
 *
 * @module ai/eval/arenaWeaponSensitivity.test
 */

import { describe, expect, it, vi } from 'vitest';

/**
 * Explicit timing budget (the environmental-saturation flake family
 * AH-0MVSBEIVK003XAFB): every arm below is a real 3-seed × 1800-tick headless
 * batch, and this file runs eight of them. 30 s keeps headroom over the
 * observed worst case while still failing a genuine hang.
 */
vi.setConfig({ testTimeout: 30000 });

import {
  AOE_RADII,
  DEFAULT_WEAPON_SUBDIVISIONS,
  WEAPON_CATALOGUE,
  weaponFireRateMs,
} from '../../utils/weapons';
import type { WeaponDefinition, WeaponId } from '../../utils/weapons';
import { runBatch } from './engine';
import type { BatchConfig } from './engine';
import type { BalanceAggregate } from './types';

/** Seeds for every sensitivity batch (three seeds → three per-run hashes). */
const SENSITIVITY_SEEDS = [11, 23, 37] as const;

/** Tick budget per run: long enough for several kills, short enough to stay fast. */
const SENSITIVITY_TICKS = 1_800;

/** A hostile-rich, deterministic skirmish so a fire-output change has targets. */
const SENSITIVITY_SPAWNS = { minerals: 6, powerUps: 0, enemies: 6, asteroids: 2 };

/**
 * One batch arm: the per-run drift fingerprints, the aggregate balance
 * statistics and the choice ids the runs actually took.
 */
interface BatchArm {
  /** Per-seed `recordsHash`, in sweep order (the same order as the seeds). */
  readonly hashes: readonly string[];
  /** The aggregate balance statistics the batch folded. */
  readonly aggregate: BalanceAggregate;
  /** The batch report serialised byte-stably (the artifact a batch diff reads). */
  readonly json: string;
  /** Every choice id the runs selected (`choice_selected` events). */
  readonly selectedChoiceIds: ReadonlySet<string>;
  /**
   * Number of `choice_selected` events across the batch. With a single-id
   * `weapon` pool the first selection is the grant and every later one is a
   * `weapon-level` upgrade of the now-owned weapon, so `> 1` proves a
   * weapon-level choice was actually taken (AH-0MW5DVAME0062GQO).
   */
  readonly selections: number;
}

/**
 * Runs one small sensitivity batch: the shipped campaign is deliberately not
 * played (the 100-game batch is a release-time artifact, not a unit test),
 * and a hold capacity of 1 makes the forced `nova` loadout land within the
 * first few pickups of every seed.
 */
function batch(overrides: Partial<BatchConfig> = {}): BatchArm {
  const selectedChoiceIds = new Set<string>();
  let selections = 0;
  const output = runBatch({
    seeds: [...SENSITIVITY_SEEDS],
    ticks: SENSITIVITY_TICKS,
    sampleEveryTicks: 1,
    campaign: false,
    spawns: SENSITIVITY_SPAWNS,
    hold: { capacity: 1 },
    // Force a known AOE loadout through the existing (non-arena-local) seam:
    // the shipped `CHOICE_POOL` offers only this weapon, so every hold-full
    // choice grants it permanently.
    choicePool: ['nova'],
    ...overrides,
    onRun: (run) => {
      for (const record of run.records) {
        if (record.kind === 'event' && record.event === 'choice_selected') {
          selections += 1;
          selectedChoiceIds.add(String(record.payload.id));
        }
      }
    },
  });
  return {
    hashes: output.runs.map((run) => run.recordsHash),
    aggregate: output.aggregate,
    json: output.json,
    selectedChoiceIds,
    selections,
  };
}

/**
 * Runs `assertions` with one {@link WEAPON_CATALOGUE} entry patched, restoring
 * the shipped entry even when the assertions throw. The patch is the runtime
 * equivalent of one edited cell of `src/data/weapons.csv`.
 */
function withWeaponOverride<T>(
  weaponId: WeaponId,
  patch: Partial<WeaponDefinition>,
  assertions: () => T,
): T {
  const shipped = WEAPON_CATALOGUE[weaponId];
  WEAPON_CATALOGUE[weaponId] = { ...shipped, ...patch };
  try {
    return assertions();
  } finally {
    WEAPON_CATALOGUE[weaponId] = shipped;
  }
}

/** The seeds whose per-run `recordsHash` did **not** move between two arms. */
function unchangedHashes(a: BatchArm, b: BatchArm): number[] {
  const unchanged: number[] = [];
  SENSITIVITY_SEEDS.forEach((seed, index) => {
    if (a.hashes[index] === b.hashes[index]) unchanged.push(seed);
  });
  return unchanged;
}

/**
 * Every dotted path whose numeric value (or presence) differs between two
 * aggregates — one entry per moved distribution statistic, so a failure names
 * exactly what did (or did not) move rather than just "not equal".
 */
function movedMetrics(a: unknown, b: unknown, path = ''): string[] {
  const moved: string[] = [];
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Object.is(a, b)) moved.push(`${path}: ${a} -> ${b}`);
    return moved;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      moved.push(...movedMetrics(a[index], b[index], `${path}[${index}]`));
    }
    return moved;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([
      ...Object.keys(a as Record<string, unknown>),
      ...Object.keys(b as Record<string, unknown>),
    ]);
    for (const key of [...keys].sort()) {
      const left = (a as Record<string, unknown>)[key];
      const right = (b as Record<string, unknown>)[key];
      if (left === undefined || right === undefined) {
        if (left !== right) {
          const before = left === undefined ? 'absent' : 'present';
          const after = right === undefined ? 'absent' : 'present';
          moved.push(`${path}.${key}: ${before} -> ${after}`);
        }
        continue;
      }
      moved.push(...movedMetrics(left, right, path ? `${path}.${key}` : key));
    }
    return moved;
  }
  if (!Object.is(a, b)) moved.push(`${path}: ${String(a)} -> ${String(b)}`);
  return moved;
}

describe('arena weapon-output sensitivity (AH-0MW5DV8AQ002ZQB6, pinned test-first)', () => {
  // FLIPPED by AH-0MW5DV9I6001D4HN: the cannon's cadence resolves from
  // `fireRateMs` through `resolveWeaponDefinition`.
  it(
    'a weapon-cadence edit alone moves every per-run recordsHash and the aggregate metrics',
    () => {
      // The cadence lever is the shared subdivision table — the same table the
      // catalogue loader derives `fireRateMs` from — so the alternate cannon
      // rate is `weaponFireRateMs('cannon', { cannon: 0.5 })` (once every two
      // beats, 1500 ms) instead of the shipped twice-per-beat 375 ms.
      const slowerCannonMs = weaponFireRateMs('cannon', {
        ...DEFAULT_WEAPON_SUBDIVISIONS,
        cannon: 0.5,
      });
      const shipped = batch();
      const slower = withWeaponOverride(
        'cannon',
        { fireRateMs: slowerCannonMs },
        () => batch(),
      );

      expect(unchangedHashes(shipped, slower)).toEqual([]);
      expect(
        movedMetrics(shipped.aggregate, slower.aggregate),
        'a cadence change alone must move at least one aggregate metric',
      ).not.toEqual([]);
    },
  );

  // FLIPPED by AH-0MW5DV9I6001D4HN: the cannon spawns the resolved
  // `offsets` pattern through `createBulletsFromHeading`.
  it(
    'a weapon pattern-count edit alone moves every per-run recordsHash and the aggregate metrics',
    () => {
      // The catalogue's pattern count is its `offsets` fan: the shipped cannon
      // is one straight bullet, so reusing the shipped spread weapon's
      // three-bullet fan changes the pattern count and nothing else.
      const threeBulletFan = [...WEAPON_CATALOGUE.spread.offsets];
      expect(threeBulletFan.length).toBeGreaterThan(WEAPON_CATALOGUE.cannon.offsets.length);
      const single = batch();
      const fanned = withWeaponOverride(
        'cannon',
        { offsets: threeBulletFan },
        () => batch(),
      );

      expect(unchangedHashes(single, fanned)).toEqual([]);
      expect(
        movedMetrics(single.aggregate, fanned.aggregate),
        'a pattern-count change alone must move at least one aggregate metric',
      ).not.toEqual([]);
    },
  );

  // FLIPPED by AH-0MW5DVAME0062GQO: the owned AOE weapons resolve their blast
  // through the shared `selectAoETargets` seam with the level-resolved radius.
  it(
    'an AOE weapon radius edit alone moves every per-run recordsHash and the aggregate metrics',
    () => {
      const nova = WEAPON_CATALOGUE.nova;
      const novaAoe = nova.aoe;
      if (!novaAoe) throw new Error('the nova weapon must declare an AOE descriptor');
      // The shipped radius is `AOE_RADII.nova`; the alternate arm quadruples it
      // through the same shared table, so the lever is the exported AOE radius.
      expect(novaAoe.radius).toBe(AOE_RADII.nova);
      const tagged = batch();
      const wide = withWeaponOverride(
        'nova',
        { aoe: { ...novaAoe, radius: AOE_RADII.nova * 4 } },
        () => batch(),
      );

      // Guard the premise: the AOE arm only proves anything if the AOE weapon
      // is actually owned (fired) in both arms.
      expect([...tagged.selectedChoiceIds]).toContain('nova');
      expect([...wide.selectedChoiceIds]).toContain('nova');

      expect(unchangedHashes(tagged, wide)).toEqual([]);
      expect(
        movedMetrics(tagged.aggregate, wide.aggregate),
        'an AOE-radius change alone must move at least one aggregate metric',
      ).not.toEqual([]);
    },
  );

  // AH-0MW5DVAME0062GQO: the ownership context feeds the fire output, so a
  // `weapon-level` choice taken during a run is observable in the metrics.
  it(
    'a weapon-level choice on an owned weapon moves every per-run recordsHash and the aggregate metrics',
    () => {
      // With a single-id weapon pool the first hold-full choice grants `nova`
      // and every later choice is its `weapon-level` offer (the pool has no
      // other candidate). The control arm offers no options at all, so the
      // same seed/loadout/hold cadence produces cannon-only fire.
      const levelled = batch();
      const cannonOnly = batch({ choicePool: [] });

      // Premise guard: two or more nova selections means at least one
      // `weapon-level` upgrade was taken, not merely the initial grant.
      expect([...levelled.selectedChoiceIds]).toEqual(['nova']);
      expect(levelled.selections).toBeGreaterThan(1);
      expect(cannonOnly.selections).toBe(0);

      // Compare only the metrics the simulation produces: the per-choice-id
      // `upgradesSelected` bookkeeping differs by construction, so asserting on
      // the whole aggregate would pass even if the weapon never fired. A moved
      // combat statistic is the observable claim.
      const combat = (arm: BatchArm) => ({
        survivalSeconds: arm.aggregate.survivalSeconds,
        waveReached: arm.aggregate.waveReached,
        levelReached: arm.aggregate.levelReached,
        asteroidsDestroyed: arm.aggregate.asteroidsDestroyed,
        avoidableHits: arm.aggregate.avoidableHits,
        enemiesKilledByArchetype: arm.aggregate.enemiesKilledByArchetype,
      });
      expect(
        movedMetrics(combat(levelled), combat(cannonOnly)),
        'a weapon-level choice on an owned weapon must move a simulated combat metric',
      ).not.toEqual([]);
    },
  );

  // GREEN before and after (the determinism contract sensitivity depends on).
  it('keeps the same-seed control pair byte-identical', () => {
    const first = batch();
    const second = batch();

    expect(second.hashes).toEqual(first.hashes);
    expect(movedMetrics(first.aggregate, second.aggregate)).toEqual([]);
    expect(second.json).toBe(first.json);
  });
});
