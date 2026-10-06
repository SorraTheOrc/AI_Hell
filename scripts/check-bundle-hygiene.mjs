#!/usr/bin/env node
/**
 * Browser bundle hygiene check (AH-0MUTYVA2C000SNPO).
 *
 * ToneForge is a **build-time** toolchain: the game consumes its CLI to render
 * baked WAV assets, but the browser bundle must never import ToneForge or its
 * Node-only dependencies (`node-web-audio-api`, filesystem/CLI code). This
 * script inspects the production bundle for those markers and fails the build
 * if any leak into the browser entry graph.
 *
 * It is wired into `npm run build` (after `vite build`) and the Pages deploy
 * workflow, and is covered by hermetic tests
 * (`scripts/check-bundle-hygiene.test.ts`).
 *
 * Exports are dependency-injected (a filesystem root) so the tests never need
 * a real Vite build.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (the directory that contains `package.json`). */
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Default bundle output directory (Vite's `build.outDir`). */
export const DEFAULT_DIST_DIR = join(REPO_ROOT, 'dist');

/**
 * Node-only markers that must never appear in a browser bundle.
 *
 * Each entry is `{ marker, label }`; a bundle containing the marker fails the
 * check. The list targets the Node-only surfaces of the ToneForge toolchain and
 * Node built-ins, not generic library names.
 */
export const FORBIDDEN_MARKERS = [
  { marker: 'node-web-audio-api', label: 'Node-only audio backend' },
  { marker: 'toneforge/bin/dev-cli', label: 'ToneForge CLI' },
  { marker: 'node:fs', label: 'Node fs module' },
  { marker: 'node:child_process', label: 'Node child_process module' },
  { marker: 'node:worker_threads', label: 'Node worker_threads module' },
  { marker: 'node:module', label: 'Node module API' },
  { marker: 'node:os', label: 'Node os module' },
  { marker: 'node:crypto', label: 'Node crypto module' },
  { marker: 'node:url', label: 'Node url module' },
  { marker: 'node:path', label: 'Node path module' },
];

/** Recursively collects every file under `dir` (returns absolute paths). */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * Scans `distDir` for forbidden Node-only markers.
 *
 * @param {{ distDir?: string }} [options]
 * @returns {{ ok: boolean, distDir: string, scanned: number, violations: Array<{ file: string, marker: string, label: string }> }}
 */
export function checkBundleHygiene({ distDir = DEFAULT_DIST_DIR } = {}) {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) {
    return { ok: false, distDir, scanned: 0, violations: [], reason: `no bundle at ${distDir}` };
  }

  const files = collectFiles(distDir).filter((file) => /\.(js|mjs|cjs|html|css)$/.test(file));
  const violations = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const { marker, label } of FORBIDDEN_MARKERS) {
      if (text.includes(marker)) {
        violations.push({ file: relative(distDir, file), marker, label });
      }
    }
  }
  return { ok: violations.length === 0, distDir, scanned: files.length, violations };
}

const USAGE = 'Usage: node scripts/check-bundle-hygiene.mjs [--dist <dir>]';

/** Parses CLI arguments (exported for tests). */
export function parseArgs(argv) {
  const args = { distDir: DEFAULT_DIST_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dist') args.distDir = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/** CLI entry point. Returns a process exit code. */
export function main(argv = process.argv.slice(2), { logger = console } = {}) {
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

  const result = checkBundleHygiene({ distDir: args.distDir });
  if (result.violations.length > 0) {
    logger.error('Bundle hygiene check failed — Node-only module(s) leaked into the browser bundle:');
    for (const v of result.violations) {
      logger.error(`  - ${v.file}: ${v.label} (${v.marker})`);
    }
    return 1;
  }
  if (!result.ok) {
    logger.error(`Bundle hygiene check failed: ${result.reason ?? 'unknown error'}`);
    return 1;
  }
  logger.log(`Bundle hygiene OK — scanned ${result.scanned} file(s), no Node-only markers.`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
