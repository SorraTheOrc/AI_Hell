#!/usr/bin/env node
/**
 * Deterministic WAV build pipeline (AH-0MUTYV8FU007X7JD).
 *
 * Renders every game cue in the ToneForge manifest
 * (`audio/toneforge/manifest.json`) to a baked WAV under
 * `public/audio/sfx/` and records the SHA-256 of every asset in
 * `public/audio/sfx/checksums.json`.
 *
 * The manifest is the single source of truth shared by this script and
 * the audio tests (`src/audio/cueManifest.ts` imports the same JSON), so
 * the rendered asset set can never drift from the cue→asset contract.
 *
 * Modes
 * -----
 *   (default)    Render when the ToneForge CLI is available, otherwise
 *                verify the committed assets against `checksums.json`.
 *                This keeps `npm run build` working in a clean checkout
 *                (CI) where the sibling `../ToneForge` is absent, while
 *                still failing closed on any checksum drift.
 *   --render     Force a full render. Fails when no ToneForge CLI is
 *                available.
 *   --verify     Never render; verify the committed assets only.
 *
 * Determinism
 * -----------
 * Every recipe is rendered **twice** and the two SHA-256 digests are
 * compared before the asset is written. A non-deterministic render fails
 * the build, guaranteeing that the same seeds always produce identical
 * checksums.
 *
 * The core functions are exported and dependency-injected so the test
 * suite can exercise the whole pipeline hermetically with a fake CLI.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (the directory that contains `package.json`). */
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Path to the canonical build manifest. */
export const MANIFEST_PATH = join(REPO_ROOT, 'audio', 'toneforge', 'manifest.json');

/** Loads and parses the build manifest. */
export function loadManifest(path = MANIFEST_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed.cues)) {
    throw new Error(`Manifest ${path} has no "cues" array`);
  }
  return parsed;
}

/** Path to the pinned ToneForge revision manifest for `repoRoot`. */
export function pinPathFor(repoRoot = REPO_ROOT) {
  return join(repoRoot, 'audio', 'toneforge', 'pin.json');
}

/**
 * Loads and parses the pinned ToneForge revision manifest
 * (`audio/toneforge/pin.json`). Fails closed on a malformed revision or a
 * missing dependency specifier so a floating checkout can never be consumed
 * silently (AH-0MUTYVA2C000SNPO).
 */
export function loadPin(path = pinPathFor()) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed.revision !== 'string' || !/^[0-9a-f]{40}$/.test(parsed.revision)) {
    throw new Error(`Pin ${path} has no 40-char hex "revision"`);
  }
  if (typeof parsed.dependencySpecifier !== 'string' || parsed.dependencySpecifier === '') {
    throw new Error(`Pin ${path} has no "dependencySpecifier"`);
  }
  return parsed;
}

/**
 * Verifies the game's declared ToneForge dependency matches the pin:
 *   - `package.json` `optionalDependencies.toneforge` equals the pin specifier;
 *   - `package-lock.json` records `node_modules/toneforge` at that specifier.
 * Returns `{ ok, errors, pin }`.
 */
export function verifyPinnedDependency({ repoRoot = REPO_ROOT, pin } = {}) {
  const errors = [];
  let resolvedPin = pin;
  if (resolvedPin === undefined) {
    try {
      resolvedPin = loadPin(pinPathFor(repoRoot));
    } catch (error) {
      return { ok: false, errors: [`cannot load ToneForge pin: ${error.message}`], pin: undefined };
    }
  }

  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    const spec = (pkg.optionalDependencies ?? {}).toneforge;
    if (spec !== resolvedPin.dependencySpecifier) {
      errors.push(
        `package.json optionalDependencies.toneforge is ${JSON.stringify(spec)}, ` +
          `expected ${JSON.stringify(resolvedPin.dependencySpecifier)}`,
      );
    }
  } catch (error) {
    errors.push(`cannot read package.json: ${error.message}`);
  }

  try {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
    const entry = lock.packages?.['node_modules/toneforge'];
    if (!entry) {
      errors.push('package-lock.json does not record node_modules/toneforge');
    } else if (entry.resolved !== resolvedPin.dependencySpecifier) {
      errors.push(
        `package-lock.json toneforge resolved ${JSON.stringify(entry.resolved)}, ` +
          `expected ${JSON.stringify(resolvedPin.dependencySpecifier)}`,
      );
    }
  } catch (error) {
    errors.push(`cannot read package-lock.json: ${error.message}`);
  }

  return { ok: errors.length === 0, errors, pin: resolvedPin };
}

/**
 * Returns the git revision of the sibling `../ToneForge` checkout, or null
 * when it is absent / not a git checkout. Used to detect a drifting sibling.
 */
export function resolvePinnedSiblingRevision({ repoRoot = REPO_ROOT, spawn = spawnSync } = {}) {
  const siblingDir = join(repoRoot, '..', 'ToneForge');
  if (!existsSync(join(siblingDir, '.git'))) return null;
  const result = spawn('git', ['-C', siblingDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Computes the deterministic render jobs from the manifest.
 *
 * Recipes are de-duplicated across cues: a recipe referenced by several
 * cues is rendered once per referenced seed. Recipes with no declared
 * seeds (the reused ToneForge recipes, e.g. `weapon-laser-zap`) are
 * rendered at the manifest's `defaultExistingRecipeSeed` so they are
 * reproducible too. The `runtime-shim` thruster hum is never baked.
 *
 * Each job has:
 *   - `recipe`     — ToneForge recipe slug
 *   - `seed`       — render seed
 *   - `assetPath`  — manifest/checksum key, relative to `public/`
 *   - `outputPath` — filesystem path relative to the repo root
 */
export function planRenderJobs(manifest) {
  /** @type {Map<string, Set<number>>} */
  const seedsByRecipe = new Map();
  for (const entry of manifest.cues) {
    if (entry.delivery === 'runtime-shim') continue;
    const seeds = seedsByRecipe.get(entry.recipe) ?? new Set();
    for (const seed of entry.seeds) seeds.add(seed);
    seedsByRecipe.set(entry.recipe, seeds);
  }

  const fallbackSeed = manifest.defaultExistingRecipeSeed ?? 1;
  const jobs = [];
  for (const [recipe, seedSet] of seedsByRecipe) {
    const seeds = seedSet.size > 0 ? [...seedSet].sort((a, b) => a - b) : [fallbackSeed];
    for (const seed of seeds) {
      const file = `${recipe}.${seed}.wav`;
      jobs.push({
        recipe,
        seed,
        file,
        assetPath: `audio/sfx/${file}`,
        outputPath: `${manifest.outputDirectory}/${file}`,
      });
    }
  }
  jobs.sort((a, b) => a.assetPath.localeCompare(b.assetPath));
  return jobs;
}

/** SHA-256 hex digest of a buffer. */
export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Absolute filesystem path for a manifest `assetPath` (relative to public/). */
export function assetFsPath(repoRoot, assetPath) {
  return join(repoRoot, 'public', assetPath);
}

/**
 * Resolves the ToneForge CLI to invoke.
 *
 * Resolution order:
 *   1. `TONEFORGE_CLI` environment variable (path to a JS file or a
 *      command on PATH) — used by tests and pinned checkouts.
 *   2. Sibling checkout `../ToneForge/bin/dev-cli.js`.
 *   3. `tf` / `toneforge` on PATH.
 *
 * Returns `{ command, prefixArgs, source }` or `null` when unavailable.
 */
export function resolveToneForge({ repoRoot = REPO_ROOT, env = process.env } = {}) {
  const fromEnv = env.TONEFORGE_CLI;
  if (fromEnv) {
    if (/\.(c|m)?js$/.test(fromEnv)) {
      return { command: process.execPath, prefixArgs: [fromEnv], source: 'TONEFORGE_CLI' };
    }
    return { command: fromEnv, prefixArgs: [], source: 'TONEFORGE_CLI' };
  }

  const sibling = join(repoRoot, '..', 'ToneForge', 'bin', 'dev-cli.js');
  if (existsSync(sibling)) {
    return { command: process.execPath, prefixArgs: [sibling], source: sibling };
  }

  const which = spawnSync('sh', ['-c', 'command -v tf || command -v toneforge'], {
    encoding: 'utf8',
    env,
  });
  const found = which.status === 0 ? which.stdout.trim() : '';
  if (found) return { command: found, prefixArgs: [], source: found };
  return null;
}

/**
 * Builds a render function that invokes the ToneForge CLI for one job and
 * returns the rendered WAV bytes. `spawn` is injectable for tests.
 */
export function createToneForgeRenderer({ cli, manifest, repoRoot, env = process.env, spawn = spawnSync }) {
  return function renderJob(job) {
    const tmp = mkdtempSync(join(tmpdir(), 'aihell-audio-'));
    const out = join(tmp, basename(job.outputPath));
    try {
      const recipeDir = join(repoRoot, 'audio', 'toneforge', manifest.recipeDirectory);
      const args = [
        ...cli.prefixArgs,
        'generate',
        '--recipe',
        job.recipe,
        '--seed',
        String(job.seed),
        '--output',
        out,
      ];
      const result = spawn(cli.command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...env, TONEFORGE_RECIPE_DIR: recipeDir },
      });
      if (result.status !== 0) {
        throw new Error(
          `tf generate failed for ${job.recipe} seed ${job.seed}: ` +
            `${result.stderr || result.stdout || `exit ${result.status}`}`,
        );
      }
      return readFileSync(out);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };
}

/** Renders all jobs, checks reproducibility, writes assets + checksums. */
export function buildAssets({
  manifest,
  repoRoot = REPO_ROOT,
  manifestPath = MANIFEST_PATH,
  renderJob,
  logger = console,
}) {
  const jobs = planRenderJobs(manifest);
  const expected = new Set(jobs.map((job) => job.assetPath));
  const assets = {};

  for (const job of jobs) {
    const first = renderJob(job);
    const second = renderJob(job);
    const firstHash = sha256(first);
    const secondHash = sha256(second);
    if (firstHash !== secondHash) {
      throw new Error(
        `Non-deterministic render for ${job.assetPath}: ${firstHash} != ${secondHash}`,
      );
    }

    const out = join(repoRoot, job.outputPath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, first);
    assets[job.assetPath] = firstHash;
    logger.log(`rendered ${job.assetPath}`);
  }

  removeStaleAssets({ manifest, repoRoot, expected, logger });

  const checksums = serializeChecksums(manifest, assets, { repoRoot, manifestPath });
  const checksumsPath = join(repoRoot, manifest.checksumsFile);
  mkdirSync(dirname(checksumsPath), { recursive: true });
  writeFileSync(checksumsPath, checksums);
  return { assets, jobs, checksums };
}

/** Deletes WAVs under the output directory that are not in the manifest. */
function removeStaleAssets({ manifest, repoRoot, expected, logger }) {
  const outputDir = join(repoRoot, manifest.outputDirectory);
  if (!existsSync(outputDir)) return;
  for (const name of readdirSync(outputDir)) {
    if (!name.endsWith('.wav')) continue;
    const assetPath = `audio/sfx/${name}`;
    if (!expected.has(assetPath)) {
      logger.log(`removing stale asset ${assetPath}`);
      rmSync(join(outputDir, name), { force: true });
    }
  }
}

/** Serialises the checksum manifest with sorted keys for determinism. */
export function serializeChecksums(manifest, assets, { repoRoot = REPO_ROOT, manifestPath = MANIFEST_PATH } = {}) {
  const sorted = {};
  for (const key of Object.keys(assets).sort()) {
    sorted[key] = assets[key];
  }
  return `${JSON.stringify(
    {
      version: 1,
      manifest: relative(repoRoot, manifestPath),
      seedBlock: manifest.seedBlock,
      assets: sorted,
    },
    null,
    2,
  )}\n`;
}

/**
 * Verifies the committed assets against `checksums.json`.
 *
 * Fails closed on: a missing checksums file, a missing/unexpected asset,
 * a checksum mismatch, or a malformed entry. Returns `{ ok, errors }`.
 */
export function verifyAssets({ manifest, repoRoot = REPO_ROOT }) {
  const errors = [];
  const checksumsPath = join(repoRoot, manifest.checksumsFile);
  if (!existsSync(checksumsPath)) {
    return { ok: false, errors: [`missing checksums file ${manifest.checksumsFile}`] };
  }

  let checksums;
  try {
    checksums = JSON.parse(readFileSync(checksumsPath, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`invalid checksums file: ${error.message}`] };
  }
  const recorded = checksums.assets ?? {};
  const expected = new Set(planRenderJobs(manifest).map((job) => job.assetPath));

  for (const [assetPath, expectedHash] of Object.entries(recorded)) {
    if (!expected.has(assetPath)) {
      errors.push(`unexpected asset in checksums.json: ${assetPath}`);
      continue;
    }
    const file = assetFsPath(repoRoot, assetPath);
    if (!existsSync(file)) {
      errors.push(`missing rendered asset: ${assetPath}`);
      continue;
    }
    const actual = sha256(readFileSync(file));
    if (actual !== expectedHash) {
      errors.push(`checksum mismatch for ${assetPath}: ${actual} != ${expectedHash}`);
    }
  }

  for (const assetPath of expected) {
    if (!(assetPath in recorded)) {
      errors.push(`asset missing from checksums.json: ${assetPath}`);
    }
  }

  const outputDir = join(repoRoot, manifest.outputDirectory);
  if (existsSync(outputDir)) {
    for (const name of readdirSync(outputDir)) {
      if (!name.endsWith('.wav')) continue;
      if (!expected.has(`audio/sfx/${name}`)) {
        errors.push(`unexpected rendered asset on disk: audio/sfx/${name}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Parses CLI arguments (exported for tests). */
export function parseArgs(argv) {
  const args = { mode: 'auto', manifestPath: MANIFEST_PATH, repoRoot: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--verify') args.mode = 'verify';
    else if (arg === '--render') args.mode = 'render';
    else if (arg === '--auto') args.mode = 'auto';
    else if (arg === '--manifest') args.manifestPath = resolve(argv[++i]);
    else if (arg === '--repo-root') args.repoRoot = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `Usage: scripts/build-audio.sh [--auto|--render|--verify] [--manifest <path>]

  --auto    (default) render when ToneForge is available, else verify
  --render  force a full render (fails without a ToneForge CLI)
  --verify  verify committed assets against checksums.json only
`;

/** CLI entry point. Returns a process exit code. */
export function main(argv = process.argv.slice(2), { logger = console, env = process.env } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    logger.error(error.message);
    logger.error(USAGE);
    return 2;
  }
  if (args.help) {
    logger.log(USAGE);
    return 0;
  }

  const manifest = loadManifest(args.manifestPath);
  const repoRoot = args.repoRoot;

  // Enforce the pinned ToneForge dependency before any render/verify work, so
  // an unpinned or drifted toolchain is never consumed silently.
  const pinCheck = verifyPinnedDependency({ repoRoot });
  if (!pinCheck.ok) {
    logger.error('ToneForge pin check failed:');
    for (const error of pinCheck.errors) logger.error(`  - ${error}`);
    return 1;
  }
  const pin = pinCheck.pin;
  logger.log(`ToneForge pinned revision ${pin.revision} (${pin.repository}, ${pin.licence}).`);
  const siblingRevision = resolvePinnedSiblingRevision({ repoRoot });
  if (siblingRevision !== null && siblingRevision !== pin.revision) {
    logger.warn(
      `ToneForge sibling checkout is at ${siblingRevision}, pinned ${pin.revision} ` +
        '(the declared file: dependency and lockfile pin are authoritative).',
    );
  }

  if (args.mode === 'verify') {
    const result = verifyAssets({ manifest, repoRoot });
    if (!result.ok) {
      logger.error('Audio checksum verification failed:');
      for (const error of result.errors) logger.error(`  - ${error}`);
      return 1;
    }
    logger.log(`Verified ${planRenderJobs(manifest).length} baked assets against ${manifest.checksumsFile}.`);
    return 0;
  }

  const cli = resolveToneForge({ repoRoot, env });
  if (cli === null) {
    if (args.mode === 'render') {
      logger.error('ToneForge CLI not found; cannot render audio assets.');
      logger.error('Set TONEFORGE_CLI, or check out the sibling ../ToneForge repository.');
      return 1;
    }
    logger.warn(
      'ToneForge CLI not found; verifying committed audio assets instead of rendering.',
    );
    const result = verifyAssets({ manifest, repoRoot });
    if (!result.ok) {
      logger.error('Committed audio assets failed verification:');
      for (const error of result.errors) logger.error(`  - ${error}`);
      return 1;
    }
    logger.log('Committed audio assets verified (no ToneForge CLI to render with).');
    return 0;
  }

  logger.log(`Rendering audio with ToneForge CLI: ${cli.source}`);
  const renderJob = createToneForgeRenderer({ cli, manifest, repoRoot, env });
  const { jobs } = buildAssets({ manifest, repoRoot, manifestPath: args.manifestPath, renderJob, logger });
  logger.log(`Rendered ${jobs.length} assets and wrote ${manifest.checksumsFile}.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
