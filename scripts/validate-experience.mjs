#!/usr/bin/env node
/**
 * Periodic human-experience validation CLI (AH-0MV7WVHU0000U775).
 *
 * A thin Node shell over the pure TS core in
 * `src/ai/eval/experienceTargets.ts`. It reads a measured
 * `BalanceReport` (a bot batch or a recorded human session) plus the committed
 * intended-experience targets, compares them and writes a versioned JSON
 * report and a Markdown summary under `--out`. It **exits non-zero** when any
 * tracked metric drifts beyond its band, so the command can gate a scheduled
 * check.
 *
 * ```bash
 * # validate a recorded human session's balance report against the targets
 * npm run validate-experience -- recordings/balance-stats.json
 *
 * # validate a fresh bot batch (catches a baseline regression)
 * npm run validate-experience -- eval-output/balance-report.json --json
 *
 * # re-baseline the targets from a recorded bot batch
 * npm run validate-experience -- --baseline eval-output/balance-report.json
 * ```
 *
 * @example
 *   node scripts/validate-experience.mjs --help
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname as pathDirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root, used to resolve the default artifact paths. */
const REPO_ROOT = resolvePath(import.meta.dirname, '..');

/** Repository-relative default path of the committed targets artifact. */
export const DEFAULT_TARGETS_FILE = 'src/data/experience-targets.json';

/** Default artifact output directory (git-ignored, like `eval-output/`). */
export const DEFAULT_OUTPUT_DIR = 'experience-out';

/** The JSON report artifact name. */
export const VALIDATION_JSON_ARTIFACT = 'experience-validation.json';

/** The Markdown summary artifact name. */
export const VALIDATION_MARKDOWN_ARTIFACT = 'experience-validation.md';

/** Parses `process.argv`-style flags into a plain options object. */
export function parseValidateExperienceArgs(argv = process.argv.slice(2)) {
  const options = {
    reportFile: null,
    targetsFile: DEFAULT_TARGETS_FILE,
    outputDir: DEFAULT_OUTPUT_DIR,
    json: false,
    baselineFile: null,
    targetsOut: DEFAULT_TARGETS_FILE,
    targetsVersion: null,
    help: false,
  };
  const positionals = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--targets':
        options.targetsFile = next();
        break;
      case '--out':
        options.outputDir = next();
        break;
      case '--json':
        options.json = true;
        break;
      case '--baseline':
        options.baselineFile = next();
        break;
      case '--targets-out':
        options.targetsOut = next();
        break;
      case '--targets-version':
        options.targetsVersion = Number(next());
        break;
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
        positionals.push(arg);
    }
  }
  if (positionals.length > 1) {
    throw new Error(`Expected at most one balance report path (got ${positionals.length})`);
  }
  if (positionals.length === 1) options.reportFile = positionals[0];
  return options;
}

/** The usage text printed by `--help`. */
export const VALIDATE_EXPERIENCE_USAGE = `Usage: node scripts/validate-experience.mjs <balance-report.json> [options]

Compare a measured balance report (a bot batch or a recorded human session)
against the committed intended-experience targets. Writes a versioned JSON
report plus a Markdown summary and exits non-zero when any metric drifts
beyond its band.

Options:
  <balance-report.json>  The measured report to validate (kind: 'balance'), e.g.
                        eval-output/balance-report.json or a recording's
                        balance-stats.json
  --targets <file>       Targets artifact (default ${DEFAULT_TARGETS_FILE})
  --out <dir>            Artifact output directory (default ${DEFAULT_OUTPUT_DIR})
  --json                 Print the machine-readable report instead of Markdown
  --baseline <file>      Re-baseline instead of validating: derive a targets
                        artifact from this bot batch balance report
  --targets-out <file>   Where --baseline writes the derived artifact
                        (default ${DEFAULT_TARGETS_FILE})
  --targets-version <n>  targetsVersion for the derived artifact (default:
                        next after the current file, or 1)
  --help                 Show this help

Exit codes: 0 = in band (or derived), 1 = drift, 2 = usage/input error.
`;

/** Loads the pure experience-targets core through Vite's SSR module loader. */
export async function loadCore() {
  const { createServer } = await import('vite');
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'silent',
  });
  return {
    server,
    core: await server.ssrLoadModule('/src/ai/eval/experienceTargets.ts'),
  };
}

/** Resolves a repository-relative default path against the repo root. */
function resolveRepoPath(path, root) {
  return resolvePath(root, path);
}

/** Reads and JSON-parses a file, raising an actionable error on failure. */
function readJson(path) {
  const text = readFileSync(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not valid JSON: ${path}`);
  }
}

/**
 * Validates one measured balance report against the targets and writes the
 * deterministic artifacts (AC3). Returns the process exit code:
 * `0` in band, `1` drift, `2` invalid input.
 *
 * @param {ReturnType<typeof parseValidateExperienceArgs>} options
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @param {object | null} core The pure core (injected by tests; SSR-loaded when omitted).
 * @param {string} root Repository root used to resolve default paths.
 */
export async function validateExperience(
  options,
  io,
  core = null,
  root = REPO_ROOT,
) {
  const engine = core ?? (await loadCore()).core;
  const reportPath = resolvePath(options.reportFile);
  const targetsPath = resolveRepoPath(options.targetsFile, root);
  let report;
  let targets;
  try {
    report = engine.readBalanceReportInput(readJson(reportPath));
    targets = engine.validateExperienceTargets(readJson(targetsPath));
  } catch (error) {
    io.err.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  const validation = engine.buildExperienceValidationReport({ report, targets });
  const json = engine.serialiseExperienceValidationReport(validation);
  const markdown = engine.formatExperienceValidationReport(validation);
  mkdirSync(options.outputDir, { recursive: true });
  writeFileSync(resolvePath(options.outputDir, VALIDATION_JSON_ARTIFACT), json);
  writeFileSync(resolvePath(options.outputDir, VALIDATION_MARKDOWN_ARTIFACT), markdown);

  io.out.write(options.json ? `${json}\n` : `${markdown}\n`);
  for (const warning of validation.warnings) io.err.write(`warning: ${warning}\n`);
  io.out.write(`Wrote 2 artifact(s) to ${options.outputDir}\n`);
  if (validation.driftedMetrics.length > 0) {
    io.out.write(`Drift detected: ${validation.driftedMetrics.join(', ')}\n`);
  }
  return validation.passed ? 0 : 1;
}

/**
 * Derives a targets artifact from a recorded bot batch (the documented
 * re-baseline workflow). Writes the artifact and prints a short summary; the
 * artifact is byte-stable for the same baseline + rule.
 *
 * @param {ReturnType<typeof parseValidateExperienceArgs>} options
 * @param {{out: {write(s: string): void}, err: {write(s: string): void}}} io
 * @param {object | null} core The pure core (injected by tests; SSR-loaded when omitted).
 * @param {string} root Repository root used to resolve default paths.
 */
export async function deriveTargets(
  options,
  io,
  core = null,
  root = REPO_ROOT,
) {
  const engine = core ?? (await loadCore()).core;
  const baselinePath = resolvePath(options.baselineFile);
  const targetsOut = resolveRepoPath(options.targetsOut, root);
  try {
    const report = engine.readBalanceReportInput(readJson(baselinePath));
    // Intent comes from a bot batch; a human report is measured experience, so
    // deriving the standard from it would invert the workflow.
    const isHuman =
      report.config.policies.length === 1 && report.config.policies[0] === 'human';
    if (isHuman) {
      io.err.write(
        're-baseline requires a bot batch report: a human report measures the ' +
          'experience, it does not define the intended one\n',
      );
      return 2;
    }
    const source = {
      kind: 'bot-baseline',
      policy: report.config.policies.join(',') || 'unknown',
      games: report.aggregate.runs,
      ticks: report.config.ticks,
      campaign: report.config.campaign ?? false,
      level: report.config.level ?? null,
      sampleEveryTicks: report.config.sampleEveryTicks ?? 1,
      seeds: {
        count: report.config.seeds.length,
        first: report.config.seeds[0] ?? 0,
        last: report.config.seeds[report.config.seeds.length - 1] ?? 0,
      },
    };
    const targets = engine.deriveExperienceTargets(report.aggregate, source, {
      targetsVersion:
        Number.isFinite(options.targetsVersion) && options.targetsVersion !== null
          ? options.targetsVersion
          : nextTargetsVersion(engine, targetsOut),
    });
    mkdirSync(pathDirname(targetsOut), { recursive: true });
    writeFileSync(targetsOut, `${engine.serialiseExperienceTargets(targets)}\n`);
    io.out.write(
      `Derived targets v${targets.targetsVersion} from ${baselinePath} ` +
        `→ ${options.targetsOut}\n`,
    );
    for (const metric of engine.EXPERIENCE_TRACKED_METRICS) {
      const band = targets.bands[metric];
      io.out.write(
        `  ${metric}: centre ${band.centre.toFixed(3)} ± ${band.tolerance.toFixed(3)}\n`,
      );
    }
    return 0;
  } catch (error) {
    io.err.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

/** Reads the current artifact's version and returns the next one (default 1). */
function nextTargetsVersion(engine, targetsOut) {
  try {
    const current = engine.validateExperienceTargets(readJson(targetsOut));
    return current.targetsVersion + 1;
  } catch {
    return 1;
  }
}

/** CLI entry point; returns the process exit code. */
export async function main(
  argv,
  io = { out: process.stdout, err: process.stderr },
  core = null,
) {
  let options;
  try {
    options = parseValidateExperienceArgs(argv);
  } catch (error) {
    io.err.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (options.help) {
    io.out.write(VALIDATE_EXPERIENCE_USAGE);
    return 0;
  }
  if (options.baselineFile !== null) {
    return await deriveTargets(options, io, core);
  }
  if (options.reportFile === null) {
    io.err.write('Missing balance report path.\n\n');
    io.err.write(VALIDATE_EXPERIENCE_USAGE);
    return 2;
  }
  return await validateExperience(options, io, core);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}
