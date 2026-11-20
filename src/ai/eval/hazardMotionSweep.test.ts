/**
 * Seeded per-class avoidance sweep — the acceptance evidence for the
 * movement-class hazard motion model (AH-0MWM0C5BN003PCDT, Feature 7 of the
 * hazard motion-model epic AH-0MWLUIOH9001XBJ3; reconciled and landed by
 * AH-0MWOKL79Z0051ZXO).
 *
 * ## What is measured
 *
 * For each movement class the sweep fields a deterministic **single-class**
 * hostile field in the headless evaluation arena (`src/ai/eval/arena.ts`, opt-in
 * `movingHostiles` mode) and flies the **live competent brain** over a fixed,
 * documented seed list for a fixed tick budget. The only difference between the
 * two arms of a seed is `hazardMotionModelEnabled`:
 *
 * - **off** — the pre-change control: the fixed-velocity closest-approach
 *   predictor and the single-difference hazard tracker.
 * - **on** — the class-shaped sampler and the second-order tracker.
 *
 * The metric is the arena's **avoidable enemy-body contact**: a rising-edge hull
 * overlap (the game's 14 px hull radius plus the body's config size) that, at
 * some decision tick in the 0.25 s before the overlap, a 16-direction escape fan
 * at the ship's live max speed could have cleared against the body's
 * then-velocity. Contacts no reaction could have prevented (a body faster than
 * any escape bearing, or one already on the hull) are excluded, so the number
 * measures dodging rather than luck — and a bot that does nothing still accrues
 * contacts, so the metric cannot be gamed by freezing.
 *
 * ## The pass bar (from the parent AC — deliberately not retuned here)
 *
 * - the **curving classes** (`chaser`, `diver`, `patroller`) record **strictly
 *   fewer** avoidable contacts with the model on than off on a **strict
 *   majority** of the documented seed list;
 * - the **chaser arm never regresses**: no seed may record more avoidable
 *   contacts with the model on (it is the class the over-dodge fix targets);
 * - the **controls** (`roamer`, `formation`) **never increase** on any seed.
 *
 * A failure names the offending seed and class. If a class cannot meet the bar,
 * record the finding and raise a work item — never relax the bar.
 *
 * ## Why the harness can trust the comparison (AH-0MWOKL79Z0051ZXO)
 *
 * 1. **One trajectory definition.** The arena advances each body through
 *    `advanceHazardMotion` — the *same* function the predictor walks over its
 *    horizon — so a harness profile cannot describe a trajectory the class
 *    model does not (`arena.test.ts` pins the seam, and an unknown class
 *    throws). Before this reconciliation the arena's `patroller` (a sinusoidal
 *    weave) and `formation` (a circular sway) were validating each model against
 *    a path it could not represent.
 * 2. **The control is provably neutral.** A class path that stays on its fitted
 *    velocity for the whole window returns the fixed-velocity solve *exactly*,
 *    so a `roamer` field is bit-identical between the arms. That is why the
 *    control can demand "never increases" rather than "improves on average":
 *    the model must be invisible for a straight-line hazard.
 * 3. **Avoidance, not engagement.** The competent brain's `engage` behaviour
 *    deliberately exempts its target from predictive avoidance (it flies at what
 *    it shoots), so a field of *shootable* enemies measures engagement. The
 *    fielded archetypes are therefore declared `threat: 0`, `aim: 'none'`
 *    hazards in the bot's content registry: the sweep isolates the hazard
 *    predictor instead of the combat policy.
 * 4. **Escapable contacts.** Each class is fielded at a pace near the ship's own
 *    speed in a field sized so it keeps meeting the ship, which keeps the
 *    encounter rate high enough to compare and the contacts genuinely avoidable.
 *
 * ## Reproducing
 *
 * `python3 ~/.pi/agent/skills/test/scripts/run_tests.py --scope changed`
 * (the sweep is a unit-project test: no DOM, no Phaser). Every position, draw
 * and choice is seeded, so the recorded table is deterministic; the table is
 * printed to the test output for the developer workflow and no artefact is
 * committed.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG, DEFAULT_ENEMY_CONFIGS } from '../../core/configDefaults';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import type { EnemyMovementClass } from '../../core/configTypes';
import { createCompetentBotBrain } from '../framework/competent';
import { createBotContent, type BotContent } from '../framework/content';
import { runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import type { ArenaRunResult } from './types';

/**
 * Explicit timing budget: the sweep is 120 real headless arena runs (5 classes
 * × 12 seeds × 2 arms) of 1 800 ticks each, so it is deliberately the slowest
 * unit test in the tree. The budget fails a hang, not a busy host.
 */
vi.setConfig({ testTimeout: 900_000 });

/**
 * The documented seed list. Twelve seeds, fixed once and never adjusted to make
 * the bar pass; each gives a different spawn geometry (positions), a different
 * per-body heading (the motion stream) and a different competent-bot governor
 * sequence, so the sweep is not one lucky scenario repeated.
 */
const SWEEP_SEEDS: readonly number[] = [
  1, 7, 13, 42, 101, 251, 512, 777, 1024, 2048, 4096, 8191,
];

/** Ticks per run: 30 simulated seconds at 60 Hz, the arena's eval window. */
const SWEEP_TICKS = 1_800;

/** One class's field: the arena geometry, the body count and the class pace. */
interface ClassField {
  /** Playfield width (px). */
  readonly width: number;
  /** Playfield height (px). */
  readonly height: number;
  /** Bodies fielded — all immortal, so the class stays present all run. */
  readonly bodies: number;
  /** Cruise speed (px/s) for the class, as the sweep fields it. */
  readonly speed: number;
  /** Why this geometry/pace is the class's measuring field. */
  readonly rationale: string;
}

/**
 * The per-class fields. Each class is measured where it is a **genuine,
 * escapable threat**: close to the ship's own pace (so prediction has something
 * to predict) in a field small enough that encounters keep happening (so the
 * per-seed comparison is not dominated by ties). The drift controls are fielded
 * at their shipped drift pace — the model must be invisible for them.
 */
const CLASS_FIELDS: Readonly<Record<EnemyMovementClass, ClassField>> = Object.freeze({
  chaser: {
    width: 480,
    height: 270,
    bodies: 8,
    speed: 160,
    rationale:
      'A pursuit at 160 px/s is a real threat to a 175 px/s hull, so the pursuit '
      + 'model has to matter; a slow chaser is harmless either way.',
  },
  diver: {
    width: 480,
    height: 270,
    bodies: 8,
    speed: 115,
    rationale:
      'A dive that commits at 115 px/s keeps re-approaching inside the field '
      + 'without making every contact unavoidable.',
  },
  patroller: {
    width: 560,
    height: 315,
    bodies: 6,
    speed: 160,
    rationale:
      'At 160 px/s the patrol→attack commit is a real intercept, which is the '
      + 'turn the linear control cannot see; fewer bodies keep the field legible.',
  },
  roamer: {
    width: 480,
    height: 270,
    bodies: 8,
    speed: 110,
    rationale:
      'The straight-line control, at a drift pace that keeps it crossing the '
      + "ship's route.",
  },
  formation: {
    width: 960,
    height: 540,
    bodies: 8,
    speed: 45,
    rationale:
      'The drift-plus-edge-reversal control at its shipped drift pace, in the full '
      + 'field so the drift keeps room between bounds.',
  },
});

/** The class → archetype mapping the arena resolves through the bot-side map. */
const CLASS_ARCHETYPES: Readonly<Record<EnemyMovementClass, string>> = Object.freeze({
  chaser: 'ghost-chase',
  diver: 'diver',
  patroller: 'raider',
  formation: 'scout',
  roamer: 'lane-traffic',
});

/** The classes whose predictor must **strictly** beat the control. */
const CURVING_CLASSES: readonly EnemyMovementClass[] = [
  'chaser',
  'diver',
  'patroller',
];

/** The classes whose arm may never record **more** contacts with the model on. */
const NEVER_REGRESS_CLASSES: readonly EnemyMovementClass[] = ['chaser'];

/** The control classes: the model may never make them worse. */
const CONTROL_CLASSES: readonly EnemyMovementClass[] = ['roamer', 'formation'];

/** Every class, in the documented report order. */
const ALL_CLASSES: readonly EnemyMovementClass[] = [
  'chaser',
  'diver',
  'patroller',
  'roamer',
  'formation',
];

/**
 * The bot's content registry for the sweep: the fielded archetypes are
 * **hazards**, not combat targets (`threat: 0`, `aim: 'none'`), so the competent
 * brain flies its collection route and steers around them instead of engaging
 * them. Engagement exempts its target from predictive avoidance by design
 * (you cannot shoot what you flee), so without this the sweep would measure the
 * combat policy, not the hazard predictor.
 */
function hazardOnlyContent(archetype: string): BotContent {
  const hazard = {
    id: archetype,
    threat: 0,
    aim: 'none' as const,
    engagementRange: 0,
    asteroidLike: false,
  };
  return createBotContent({
    enemies: [hazard],
    defaultEnemy: { ...hazard, id: 'hazard' },
  });
}

/** One class's per-seed measurement: avoidable contacts with the model off/on. */
interface ClassSweepRow {
  readonly movementClass: EnemyMovementClass;
  readonly perSeed: ReadonlyArray<{ seed: number; off: number; on: number }>;
  readonly offTotal: number;
  readonly onTotal: number;
  readonly better: number;
  readonly worse: number;
  readonly tied: number;
}

/** Flies one arm of one seed for one class. */
function runArm(
  movementClass: EnemyMovementClass,
  seed: number,
  hazardMotionModelEnabled: boolean,
): ArenaRunResult {
  const field = CLASS_FIELDS[movementClass];
  const archetype = CLASS_ARCHETYPES[movementClass];
  // A single archetype in the seeded config store makes the arena's reservoir
  // field that class only; a huge health keeps every body alive for the whole
  // run (so contacts keep being measurable) and a zero shot probability keeps
  // enemy fire out of the comparison.
  seedConfigStore(
    [
      {
        ...DEFAULT_ENEMY_CONFIGS[archetype],
        health: 1_000_000,
        shotProbability: 0,
      },
    ],
    DEFAULT_CONFIG,
  );
  const result = runArena(
    createCompetentBotBrain({
      tunables: { hazardMotionModelEnabled },
      content: hazardOnlyContent(archetype),
    }),
    {
      seed,
      ticks: SWEEP_TICKS,
      width: field.width,
      height: field.height,
      // No asteroid shadow-hazard: the run measures the one class it fields.
      spawns: { minerals: 2, powerUps: 0, enemies: field.bodies, asteroids: 0 },
      // The fielded class only — the seeded reservoir otherwise draws every
      // config-derived archetype, which would dilute a per-class comparison.
      hostileArchetypes: [archetype],
      forceFields: false,
      balance: loadBalanceConfig(),
      movingHostiles: { speeds: { [movementClass]: field.speed } },
    },
  );
  resetConfigStore();
  return result;
}

/** Flies both arms of one seed for one class. */
function measureSeed(
  movementClass: EnemyMovementClass,
  seed: number,
): { seed: number; off: number; on: number } {
  const off = runArm(movementClass, seed, false);
  const on = runArm(movementClass, seed, true);
  return {
    seed,
    off: off.avoidableEnemyBodyContacts,
    on: on.avoidableEnemyBodyContacts,
  };
}

/** The measured sweep, computed once for every assertion in the file. */
let rows: ClassSweepRow[] = [];

/** A compact, human-readable table — the evidence, not just the failures. */
function renderTable(rows: readonly ClassSweepRow[]): string {
  const header = 'class      off  on   better/worse/tie  per-seed (off→on)';
  const lines = rows.map((row) => {
    const perSeed = row.perSeed
      .map((entry) => `${entry.seed}:${entry.off}→${entry.on}`)
      .join(' ');
    return `${row.movementClass.padEnd(10)} ${String(row.offTotal).padStart(3)}  ${String(
      row.onTotal,
    ).padStart(3)}  ${String(row.better).padStart(2)}/${String(row.worse).padStart(2)}/${String(
      row.tied,
    ).padStart(2)}            ${perSeed}`;
  });
  return [header, ...lines].join('\n');
}

beforeAll(() => {
  resetConfigStore();
  const measured: ClassSweepRow[] = [];
  for (const movementClass of ALL_CLASSES) {
    const perSeed = SWEEP_SEEDS.map((seed) => measureSeed(movementClass, seed));
    let offTotal = 0;
    let onTotal = 0;
    let better = 0;
    let worse = 0;
    let tied = 0;
    for (const entry of perSeed) {
      offTotal += entry.off;
      onTotal += entry.on;
      if (entry.on < entry.off) better += 1;
      else if (entry.on > entry.off) worse += 1;
      else tied += 1;
    }
    measured.push({
      movementClass,
      perSeed,
      offTotal,
      onTotal,
      better,
      worse,
      tied,
    });
  }
  rows = measured;
  resetConfigStore();
  // The table is the developer-facing artefact of the sweep: it records what
  // was measured alongside the pass/fail verdict.
  // eslint-disable-next-line no-console
  console.log(`\nper-class avoidance sweep\n${renderTable(rows)}\n`);
  // 120 arena runs: the budget covers a busy shared host, not a hang.
}, 900_000);

describe('seeded per-class avoidance sweep (AH-0MWM0C5BN003PCDT)', () => {
  it('measures every class over the documented seed list', () => {
    expect(rows.map((row) => row.movementClass)).toEqual([...ALL_CLASSES]);
    for (const row of rows) {
      expect(row.perSeed.map((entry) => entry.seed)).toEqual([...SWEEP_SEEDS]);
      // Counts are shapes of contact telemetry: never negative, never
      // non-finite. A malformed arm would otherwise silently pass the bar.
      for (const entry of row.perSeed) {
        expect(Number.isInteger(entry.off)).toBe(true);
        expect(Number.isInteger(entry.on)).toBe(true);
        expect(entry.off).toBeGreaterThanOrEqual(0);
        expect(entry.on).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('reproduces the same measurements for a repeated seed (determinism)', () => {
    const movementClass: EnemyMovementClass = 'chaser';
    const seed = SWEEP_SEEDS[3];
    const measured = rows
      .find((row) => row.movementClass === movementClass)!
      .perSeed.find((entry) => entry.seed === seed)!;
    expect(measureSeed(movementClass, seed)).toEqual(measured);
  });

  it('meets the pass bar: curving classes improve, controls never regress', () => {
    const majority = Math.floor(SWEEP_SEEDS.length / 2) + 1;
    const violations: string[] = [];
    for (const row of rows) {
      const { movementClass } = row;
      // Named offender: a failure points at the seed, the class and both arms,
      // so a regression is directly reproducible.
      if (CURVING_CLASSES.includes(movementClass) && row.better < majority) {
        const nonImproving = row.perSeed.filter((entry) => entry.on >= entry.off);
        violations.push(
          `${movementClass}: strictly better on ${row.better}/${SWEEP_SEEDS.length} seeds `
            + `(bar: ${majority}); seeds not improved: `
            + nonImproving
              .map((entry) => `${entry.seed} (${entry.off}→${entry.on})`)
              .join(', '),
        );
      }
      if (NEVER_REGRESS_CLASSES.includes(movementClass)) {
        for (const entry of row.perSeed) {
          if (entry.on > entry.off) {
            violations.push(
              `${movementClass}: regressed on seed ${entry.seed} `
                + `(${entry.off}→${entry.on} avoidable contacts)`,
            );
          }
        }
      }
      if (CONTROL_CLASSES.includes(movementClass)) {
        for (const entry of row.perSeed) {
          if (entry.on > entry.off) {
            violations.push(
              `${movementClass}: control regressed on seed ${entry.seed} `
                + `(${entry.off}→${entry.on} avoidable contacts)`,
            );
          }
        }
      }
    }
    expect(violations, `\n${renderTable(rows)}\n`).toEqual([]);
  });

  it('holds the straight-line control bit-identical (the model is invisible)', () => {
    // A `roamer` path stays on its fitted velocity for the whole window, so the
    // class model returns the fixed-velocity solve exactly: the two arms must
    // agree on **every** seed. Anything else means sampling granularity or the
    // early-out bound is leaking behaviour into the control.
    const roamer = rows.find((row) => row.movementClass === 'roamer')!;
    expect(roamer.perSeed.filter((entry) => entry.on !== entry.off)).toEqual([]);
  });

  it('counts only avoidable contacts the ship genuinely could have escaped', () => {
    // The classification is a filter, never an amplifier: no arm can report
    // more avoidable contacts than it reported contacts. Verified on one arm of
    // each class so a regression in `escapeClearsContact` is caught without
    // re-running the whole sweep.
    for (const movementClass of ALL_CLASSES) {
      const arm = runArm(movementClass, SWEEP_SEEDS[0], true);
      expect(arm.avoidableEnemyBodyContacts).toBeLessThanOrEqual(
        arm.enemyBodyContacts,
      );
    }
  });
});
