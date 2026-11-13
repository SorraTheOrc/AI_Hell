#!/usr/bin/env node
/**
 * Ring-timing harness CLI (AH-0MVUXCBQY001ESWT).
 *
 * A thin Node shell over the pure TS core in `src/ai/eval/ringTiming.ts`. It
 * loads the core through Vite's SSR module loader (the same mechanism the
 * other evaluation tools use), measures the authored rings with the real
 * headless arena, prints the text report (or the JSON report with `--json`),
 * optionally writes the JSON artifact, and **exits non-zero** when an
 * applicable budget is missed — so the command can gate a balance check.
 *
 * ```bash
 * # measure both rings for both playstyle lines, seeds 1–3
 * npm run ring-timing
 *
 * # machine-readable evidence for the docs item (B8)
 * npm run ring-timing -- --json --out docs/dev/ring-timing-baseline.json
 *
 * # measure the shipped five-wave sortie's per-deployment income + unlock pace
 * # (AH-0MWCOWTOR00994NA) and write the reproducible income artifact
 * npm run ring-timing -- --one-level --income-out docs/dev/one-level-income-baseline.json
 *
 * # one ring, one line
 * npm run ring-timing -- --ring 2 --strategy grind --seed 7
 * ```
 *
 * @example
 *   node scripts/ring-timing.mjs --help
 */

import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Repository root, used to resolve a relative `--out` path. */
const REPO_ROOT = resolvePath(import.meta.dirname, '..');

/** The rings the CLI measures by default. */
export const DEFAULT_RINGS = [1, 2];

/** The playstyle lines the CLI measures by default. */
export const DEFAULT_STRATEGIES = ['grind', 'rush'];

/** The seeds the CLI measures by default (the evidence set). */
export const DEFAULT_SEEDS = [1, 2, 3];

/** Parses `process.argv`-style flags into a plain options object. */
export function parseRingTimingArgs(argv = process.argv.slice(2)) {
  const options = {
    rings: [...DEFAULT_RINGS],
    strategies: [...DEFAULT_STRATEGIES],
    seeds: [...DEFAULT_SEEDS],
    json: false,
    out: null,
    oneLevel: false,
    incomeOut: null,
    help: false,
  };
  const rings = [];
  const strategies = [];
  const seeds = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--ring':
        rings.push(Number(next()));
        break;
      case '--strategy': {
        const value = next();
        if (!['grind', 'rush', 'both'].includes(value)) {
          throw new Error(`--strategy must be grind, rush or both (got ${value})`);
        }
        if (value === 'both') strategies.push('grind', 'rush');
        else strategies.push(value);
        break;
      }
      case '--seed':
        seeds.push(Number(next()));
        break;
      case '--seeds': {
        const value = next();
        const count = Number(value);
        if (!Number.isInteger(count) || count < 1) {
          throw new Error(`--seeds must be a positive whole number (got ${value})`);
        }
        seeds.push(...Array.from({ length: count }, (_, index) => index + 1));
        break;
      }
      case '--one-level':
        options.oneLevel = true;
        break;
      case '--income-out':
        options.incomeOut = next();
        break;
      case '--json':
        options.json = true;
        break;
      case '--out':
        options.out = next();
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (rings.length > 0) options.rings = rings;
  if (strategies.length > 0) options.strategies = [...new Set(strategies)];
  if (seeds.length > 0) options.seeds = [...new Set(seeds)];
  return options;
}

/** Prints the CLI usage text. */
function printHelp() {
  console.log(
    [
      'Ring timing harness — measures the Hangar War rings with the headless arena.',
      '',
      'Usage: node scripts/ring-timing.mjs [options]',
      '',
      'Options:',
      '  --ring <n>            Ring to measure (repeatable; default 1 and 2).',
      '  --strategy <line>     grind, rush or both (repeatable; default both).',
      '  --seed <n>            Run seed (repeatable; default 1, 2 and 3).',
      '  --seeds <count>       Use seeds 1..count.',
      '  --json                Print the JSON report instead of text.',
      '  --out <file>          Write the JSON report to <file>.',
      '  --one-level           Measure the shipped five-wave sortie (income view) instead of the campaign slice.',
      '  --income-out <file>   Write the per-deployment income + unlock-pace JSON (requires --one-level).',
      '  -h, --help            Show this help.',
      '',
      'Exit codes: 0 measured, 2 usage error, 1 an applicable budget was missed (never in --one-level mode).',
    ].join('\n'),
  );
}

/** Loads the pure TS ring-timing core through Vite's SSR module loader. */
async function loadCore() {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  return {
    server,
    core: await server.ssrLoadModule('/src/ai/eval/ringTiming.ts'),
  };
}

/** Runs the CLI; returns the process exit code. */
async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseRingTimingArgs(argv);
  } catch (error) {
    console.error(`ring-timing: ${error.message}`);
    return 2;
  }
  if (options.help) {
    printHelp();
    return 0;
  }

  const { server, core } = await loadCore();
  try {
    if (options.incomeOut !== null && !options.oneLevel) {
      console.error('ring-timing: --income-out requires --one-level (it writes the one-level income view)');
      return 2;
    }
    const reports = [];
    for (const ringIndex of options.rings) {
      for (const strategy of options.strategies) {
        reports.push(
          core.simulateRingTiming({
            ringIndex,
            strategy,
            seeds: options.seeds,
            ...(options.oneLevel
              ? { runDeployment: core.createOneLevelArenaDeploymentRunner() }
              : {}),
          }),
        );
      }
    }

    if (options.json) {
      console.log(JSON.stringify(reports, null, 2));
    } else if (options.oneLevel) {
      console.log(
        reports.map((report) => core.formatIncomeReport(report)).join('\n\n'),
      );
    } else {
      console.log(
        reports.map((report) => core.formatRingTimingReport(report)).join('\n\n'),
      );
    }
    if (options.out) {
      writeFileSync(resolvePath(REPO_ROOT, options.out), `${JSON.stringify(reports, null, 2)}\n`);
      if (!options.json) console.log(`\nWrote ${options.out}`);
    }
    if (options.incomeOut) {
      const income = reports.map((report) => ({
        ringIndex: report.ringIndex,
        strategy: report.strategy,
        seeds: report.seeds,
        income: core.derivePerDeploymentIncome(report),
        unlockPace: core.deriveUnlockPace(core.derivePerDeploymentIncome(report)),
      }));
      writeFileSync(
        resolvePath(REPO_ROOT, options.incomeOut),
        `${JSON.stringify(income, null, 2)}\n`,
      );
      if (!options.json) console.log(`\nWrote ${options.incomeOut}`);
    }

    // The budget gate is the ring-timing chain's duration verdict; the
    // one-level income measurement does not judge it (AH-0MWCOWTOR00994NA
    // defers duration verdicts to AH-0MWCOWSVN003X81A).
    const missed = options.oneLevel
      ? []
      : reports.filter((report) => report.budget.verdict === 'missed');
    if (missed.length > 0) {
      console.error(
        `ring-timing: budget missed for ${missed
          .map((report) => `ring ${report.ringIndex} ${report.strategy}`)
          .join(', ')}`,
      );
      return 1;
    }
    return 0;
  } finally {
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${resolvePath(process.argv[1])}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}

export { main, loadCore };
