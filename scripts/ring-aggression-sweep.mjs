#!/usr/bin/env node
/**
 * Ring aggression sweep — repeatable evidence for the strength-budgeted frontier
 * (AH-0MWBBUBZ90066H68, part of `HexMap aggression increases too quickly`).
 *
 * The sweep drives the **shipped** `runFrontierTick` over a long between-sortie
 * sequence (default 50 ticks) for ring 1 (6 hexes) and ring 2 (12 hexes), at
 * three player-strength snapshots:
 *
 * 1. the minimal fleet (the starter hull, nothing equipped — strength `2`);
 * 2. a first hull upgrade step (`armour` level 1 — strength `5`; a synthetic
 *    intermediate because the shipped catalogue jumps straight from the starter
 *    hull to `hull-2`, so the tick's documented `playerStrength` seam pins it);
 * 3. the ring-2 fleet (`hull-2` bought and equipped — strength resolved from
 *    the payload's own hangar).
 *
 * For every tick it records the ring's aggression total, the budget, every
 * hex's aggression (the distribution) and how many hexes sit at or below the
 * beatable ceiling. The same seed and inputs always produce the same numbers.
 *
 * Usage:
 *
 * ```bash
 * node scripts/ring-aggression-sweep.mjs            # text summary
 * node scripts/ring-aggression-sweep.mjs --json     # machine-readable rows
 * node scripts/ring-aggression-sweep.mjs --ticks 60 --seed 7
 * ```
 *
 * Exit status is `1` when any snapshot violates the beatable-hex invariant, so
 * the command can gate a balance check.
 *
 * @module scripts/ring-aggression-sweep
 */

import { resolve as resolvePath } from 'node:path';

/** Repository root. */
const REPO_ROOT = resolvePath(import.meta.dirname, '..');

/** The rings the sweep measures. */
const RINGS = [1, 2];

/** Default number of between-sortie ticks per snapshot. */
const DEFAULT_TICKS = 50;

/** Default deterministic seed. */
const DEFAULT_SEED = 0x5eed1234;

/** Parses the sweep's command-line flags. */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = { ticks: DEFAULT_TICKS, seed: DEFAULT_SEED, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--ticks') options.ticks = Number.parseInt(argv[++i], 10);
    else if (arg === '--seed') options.seed = Number.parseInt(argv[++i], 10);
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/** Loads the pure TS core through Vite's SSR loader (the repo's eval pattern). */
async function loadCore() {
  const { createServer } = await import('vite');
  const server = await createServer({
    root: REPO_ROOT,
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const hexDefence = await server.ssrLoadModule(
      '/src/core/hangarWar/hexDefence.ts',
    );
    const economy = await server.ssrLoadModule(
      '/src/core/hangarWar/hangarEconomy.ts',
    );
    const fixtures = await server.ssrLoadModule(
      '/src/core/hangarWar/__fixtures__/aggressionScenarios.ts',
    );
    return { hexDefence, economy, fixtures, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** The three strength snapshots the sweep measures. */
function buildSnapshots(economy, fixtures) {
  const base = fixtures.aggressionScenario(1);
  const starterHangar = base.hangar;
  const upgradedHangar = {
    ...starterHangar,
    unlockedHulls: [...starterHangar.unlockedHulls, 'hull-2'],
    activeHull: 'hull-2',
  };
  const firstUpgrade = economy.defenderRatingFromUpgrades(2, {
    armour: 1,
    firepower: 0,
    systems: 0,
  });
  return [
    {
      key: 'minimal',
      label: 'minimal fleet (starter hull)',
      hangar: starterHangar,
      playerStrength: economy.resolvePlayerStrength(starterHangar),
    },
    {
      key: 'first-upgrade',
      label: 'first hull upgrade step (armour 1)',
      hangar: starterHangar,
      // The shipped catalogue has no intermediate hull, so the documented
      // `playerStrength` seam pins the first upgrade step's resolved value.
      playerStrength: firstUpgrade,
    },
    {
      key: 'ring-2',
      label: 'ring-2 fleet (hull-2 equipped)',
      hangar: upgradedHangar,
      playerStrength: economy.resolvePlayerStrength(upgradedHangar),
    },
  ];
}

/** Runs the shipped tick for one snapshot on one ring. */
function sweep({ hexDefence, fixtures }, snapshot, ringIndex, ticks, seed) {
  let payload = {
    ...fixtures.aggressionScenario(ringIndex),
    hangar: snapshot.hangar,
    seed,
  };
  let clock = hexDefence.createFrontierClock(seed, 0);
  const rows = [];
  for (let index = 0; index < ticks; index += 1) {
    const result = hexDefence.runFrontierTick(payload, {
      clock,
      playerStrength: snapshot.playerStrength,
    });
    payload = result.payload;
    clock = result.clock;
    const hexes = payload.ring.hexes.map((hex) => ({
      id: hex.id,
      aggression: hex.aggression,
    }));
    const total = hexes.reduce((sum, hex) => sum + hex.aggression, 0);
    const beatable = hexes.filter(
      (hex) => hex.aggression <= result.record.beatableCeiling,
    ).length;
    rows.push({
      tick: result.record.tick,
      total,
      budget: result.record.aggressionBudget,
      beatableCeiling: result.record.beatableCeiling,
      beatableCount: beatable,
      distribution: hexes,
    });
  }

  const totals = rows.map((row) => row.total);
  const beatableCounts = rows.map((row) => row.beatableCount);
  return {
    ringIndex,
    hexCount: rows[0]?.distribution.length ?? 0,
    snapshot: snapshot.key,
    label: snapshot.label,
    playerStrength: snapshot.playerStrength,
    budget: rows[0]?.budget ?? 0,
    ticks: rows.length,
    finalTotal: totals.at(-1) ?? 0,
    totalStable: totals.every((value) => value === totals[0]),
    minBeatableCount: Math.min(...beatableCounts),
    ok: beatableCounts.every((count) => count > 0),
    rows,
  };
}

/** Prints the human-readable summary. */
function printText(results) {
  for (const result of results) {
    console.log(
      `ring ${result.ringIndex} · ${result.label} · strength ${result.playerStrength}`,
    );
    console.log(
      `  ticks ${result.ticks} · budget ${result.budget} · final total ${result.finalTotal} · total stable ${result.totalStable ? 'yes' : 'NO'} · min beatable hexes ${result.minBeatableCount} · ${result.ok ? 'OK' : 'UNBEATABLE'}`,
    );
    const first = result.rows[0];
    if (first) {
      console.log(
        `  distribution (tick ${first.tick}): ${first.distribution.map((hex) => `${hex.id}=${hex.aggression}`).join(' ')}`,
      );
    }
    console.log('');
  }
}

/** The sweep's entry point. */
async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(
      'Usage: node scripts/ring-aggression-sweep.mjs [--json] [--ticks N] [--seed N]',
    );
    return { ok: true, results: [] };
  }

  const core = await loadCore();
  try {
    const snapshots = buildSnapshots(core.economy, core.fixtures);
    const results = [];
    for (const snapshot of snapshots) {
      for (const ringIndex of RINGS) {
        results.push(
          sweep(
            core,
            snapshot,
            ringIndex,
            Math.max(1, options.ticks),
            options.seed,
          ),
        );
      }
    }

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            seed: options.seed,
            ticks: options.ticks,
            results,
            ok: results.every((result) => result.ok),
          },
          null,
          2,
        ),
      );
    } else {
      printText(results);
    }

    const ok = results.every((result) => result.ok);
    return { ok, results };
  } finally {
    await core.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${resolvePath(process.argv[1])}`) {
  main()
    .then(({ ok }) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

export { main, sweep, buildSnapshots };
