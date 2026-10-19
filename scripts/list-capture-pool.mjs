#!/usr/bin/env node
/**
 * Capture-pool inventory lister (AH-0MVDV4SYG008X8TY; parent AC2/AC3/AC4).
 *
 * The promo compiler (`scripts/compile-promo.mjs`) needs a source pool in
 * which every retained WebM has a sibling action-intensity series
 * (`<run>.action.jsonl`, §7.3) and join anchor (`<run>.capture.json`, §7.5).
 * This lister is the pool's **inventory**: it scans `capture-output/`,
 * retains only complete WebM + series + anchor triples, reports excluded
 * runs with the missing artifacts, and summarises which editorial features
 * (`weapons`, `pickups`, `enemies`, `boss`) each run actually evidences from
 * the §7.2 `breakdown` — so the editorial config can be validated against
 * reality before compiling (parent AC4).
 *
 * The feature→breakdown mapping is read from the compiler's own
 * `EDITORIAL_CONFIG` (single source of truth), so the inventory cannot drift
 * from what the coverage manifest will claim.
 *
 * Everything here is pure except the thin CLI at the bottom: the inventory
 * builder takes in-memory artifact text and the collector takes an injected
 * `node:fs`, so the hermetic test suite runs with no footage, ffmpeg or
 * browser.
 *
 * Usage:
 *
 *   npm run list:pool                       # human-readable inventory
 *   npm run list:pool -- --json             # machine-readable manifest
 *   npm run list:pool -- --dir clips        # scan a different directory
 *   npm run list:pool -- --runs run-a,run-b # limit to explicit run ids
 *
 * @module scripts/list-capture-pool
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ACTION_SERIES_EXTENSION,
  BREAKDOWN_TO_EDITORIAL_CATEGORY,
  CAPTURE_ANCHOR_EXTENSION,
  CAPTURE_OUTPUT_DIR,
  EDITORIAL_CATEGORIES,
  parseActionIntensitySeries,
  parseCaptureAnchor,
} from './compile-promo.mjs';

/** Inventory schema version (bump on a breaking shape change). */
export const POOL_INVENTORY_SCHEMA_VERSION = 1;

/** Inventory `kind` discriminator, so consumers can sniff the manifest. */
export const POOL_INVENTORY_KIND = 'capture-pool-inventory';

/** Source-footage extension (a pool run is anchored on its WebM). */
const WEBM_EXTENSION = '.webm';

/** `--help` text documenting inputs, options and the inventory shape. */
export const USAGE_TEXT = `Usage: node scripts/list-capture-pool.mjs [--dir <dir>] [--runs <id1,id2,...>] [--json] [--help]

Capture-pool inventory (AH-0MVDV4SYG008X8TY). Scans the capture output
directory and reports which runs are retained and which features they show.

A run is RETAINED only when all three artifacts are present:
  <run-id>.webm          the captured footage (960x540 WebM)
  <run-id>.action.jsonl  the recorded action-intensity series (§7.3)
  <run-id>.capture.json  the join anchor (§7.5)
Runs missing any artifact are EXCLUDED and reported with the missing kinds;
a header-only series is a valid (partial) run but evidences no features.

Features are recognised from the series §7.2 breakdown via the compiler's
own editorial mapping (EDITORIAL_CONFIG):
  playerBullets -> weapons, drops -> pickups, enemies -> enemies,
  bosses -> boss
The manifest also lists the per-feature first/last series time, so the
editorial config can be validated against the footage that actually exists.

Options:
  --dir <dir>           directory to scan (default ${CAPTURE_OUTPUT_DIR})
  --runs <id1,id2,...>  limit the inventory to these run ids
  --json                emit the machine-readable inventory manifest
                        (redirect it to ${CAPTURE_OUTPUT_DIR}/pool-inventory.json
                        to keep a copy next to the footage)
  --help, -h            show this help and exit

Prerequisites:
  Capture footage first with \`npm run capture\` (or \`--all-scenarios\`),
  which writes the series and anchor sidecars next to each WebM.
`;

/**
 * Parses CLI argv into options (pure — unit-tested without touching disk).
 *
 * @param {readonly string[]} [argv]
 * @returns {{ help: boolean, json: boolean, dir: string,
 *             runs: string[], error: string|null }}
 */
export function parseListPoolArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const out = {
    help: false,
    json: false,
    dir: CAPTURE_OUTPUT_DIR,
    runs: [],
    error: null,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      return out;
    }
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--dir') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        out.error = '--dir requires a directory path';
        return out;
      }
      out.dir = value;
      i += 1;
      continue;
    }
    if (arg === '--runs') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) {
        out.error = '--runs requires a comma-separated list of run ids';
        return out;
      }
      out.runs.push(...value.split(',').map((part) => part.trim()).filter(Boolean));
      i += 1;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      out.error = `unknown option: ${arg}`;
      return out;
    }
    // Bare positional arguments are run ids, mirroring compile-promo.
    out.runs.push(arg);
  }
  return out;
}

/** Strips one known artifact extension from a filename, leaving the run id. */
function runIdFromName(name) {
  for (const extension of [
    WEBM_EXTENSION,
    ACTION_SERIES_EXTENSION,
    CAPTURE_ANCHOR_EXTENSION,
  ]) {
    if (name.endsWith(extension)) return name.slice(0, -extension.length);
  }
  return null;
}

/** Rounds a finite number to `dp` decimal places (deterministic output). */
function round(value, dp) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Extracts per-feature evidence from parsed series samples (pure).
 *
 * A sample evidences a feature when its §7.2 breakdown carries a positive
 * count for a mapped category. `firstTMs`/`lastTMs` are series time, so the
 * caller can see *where* in the run the feature appears.
 *
 * @param {readonly {t: number, breakdown?: Record<string, number>}[]} points
 * @returns {{ feature: string, samples: number, firstTMs: number, lastTMs: number }[]}
 */
function featureEvidence(points) {
  /** @type {Map<string, {samples: number, firstTMs: number, lastTMs: number}>} */
  const seen = new Map();
  for (const point of points) {
    if (!point.breakdown || typeof point.breakdown !== 'object') continue;
    for (const [categoryKey, count] of Object.entries(point.breakdown)) {
      if (!(Number(count) > 0)) continue;
      const feature = BREAKDOWN_TO_EDITORIAL_CATEGORY[categoryKey];
      if (!feature) continue;
      const current = seen.get(feature);
      if (current === undefined) {
        seen.set(feature, { samples: 1, firstTMs: point.t, lastTMs: point.t });
      } else {
        current.samples += 1;
        if (point.t < current.firstTMs) current.firstTMs = point.t;
        if (point.t > current.lastTMs) current.lastTMs = point.t;
      }
    }
  }
  return EDITORIAL_CATEGORIES.filter((feature) => seen.has(feature)).map(
    (feature) => ({ feature, ...seen.get(feature) }),
  );
}

/**
 * Builds the deterministic inventory from in-memory artifact entries (pure).
 *
 * Each entry says whether the three artifacts exist and, when readable,
 * carries their text. Missing artifacts exclude the run with a precise
 * reason; an excluded run never contributes feature evidence.
 *
 * @param {{ dir?: string, entries?: readonly object[], errors?: readonly string[] }} [params]
 * @returns {object} The `CapturePoolInventory` manifest.
 */
export function buildCapturePoolInventory({
  dir = CAPTURE_OUTPUT_DIR,
  entries = [],
  errors = [],
} = {}) {
  const retained = [];
  const excluded = [];
  const fatalErrors = [...errors];

  for (const entry of entries) {
    const runId = String(entry.runId);
    const missing = [];
    const reasons = [];

    if (entry.webmPresent !== true) {
      missing.push('webm');
      reasons.push(`missing source footage ${dir}/${runId}${WEBM_EXTENSION}`);
    }
    if (entry.seriesPresent !== true) {
      missing.push('series');
      reasons.push(
        `missing action-intensity series ${dir}/${runId}${ACTION_SERIES_EXTENSION}`,
      );
    } else if (typeof entry.seriesText !== 'string') {
      missing.push('series');
      reasons.push(
        `unreadable action-intensity series ${dir}/${runId}${ACTION_SERIES_EXTENSION}`,
      );
    }
    if (entry.anchorPresent !== true) {
      missing.push('anchor');
      reasons.push(`missing join anchor ${dir}/${runId}${CAPTURE_ANCHOR_EXTENSION}`);
    } else if (typeof entry.anchorText !== 'string') {
      missing.push('anchor');
      reasons.push(
        `unreadable join anchor ${dir}/${runId}${CAPTURE_ANCHOR_EXTENSION}`,
      );
    }
    for (const error of entry.errors ?? []) reasons.push(String(error));

    if (missing.length > 0) {
      excluded.push({ runId, missing, reasons });
      continue;
    }

    const { points } = parseActionIntensitySeries(entry.seriesText);
    const anchor = parseCaptureAnchor(entry.anchorText);
    const offsetMs =
      anchor.captureStartedMs !== null && anchor.runStartedAtMs !== null
        ? anchor.captureStartedMs - anchor.runStartedAtMs
        : null;
    const lastT = points.reduce(
      (max, point) => (point.t > max ? point.t : max),
      0,
    );
    const meanIntensity =
      points.length === 0
        ? 0
        : round(
            points.reduce((sum, point) => sum + point.intensity, 0) /
              points.length,
            4,
          );

    retained.push({
      runId,
      sampleCount: points.length,
      durationMs: lastT,
      meanIntensity,
      anchor: {
        present: true,
        approximate: offsetMs === null,
        offsetMs,
      },
      features: featureEvidence(points),
    });
  }

  const features = EDITORIAL_CATEGORIES.map((feature) => ({
    feature,
    runs: retained
      .filter((run) => run.features.some((entry) => entry.feature === feature))
      .map((run) => run.runId),
  }));

  return {
    schemaVersion: POOL_INVENTORY_SCHEMA_VERSION,
    kind: POOL_INVENTORY_KIND,
    dir,
    retained,
    excluded,
    features,
    missingFeatures: features
      .filter((entry) => entry.runs.length === 0)
      .map((entry) => entry.feature),
    errors: fatalErrors,
  };
}

/**
 * Scans the pool directory and builds the inventory (thin `node:fs` wrapper).
 *
 * The run ids are discovered from every known artifact extension, so orphan
 * series/anchors are reported as excluded instead of silently ignored. An
 * explicit `runs` list bypasses discovery (used for a focused inventory).
 *
 * @param {{ dir?: string, runs?: readonly string[], fs?: object }} [params]
 * @returns {object} The `CapturePoolInventory` manifest.
 */
export function collectCapturePool({
  dir = CAPTURE_OUTPUT_DIR,
  runs = [],
  fs = { readdirSync, existsSync, readFileSync },
} = {}) {
  if (!fs.existsSync(dir)) {
    return buildCapturePoolInventory({
      dir,
      entries: [],
      errors: [`capture pool directory not found: ${dir}`],
    });
  }

  const runIds =
    runs.length > 0
      ? [...runs]
      : [...new Set(fs.readdirSync(dir).map(runIdFromName).filter(Boolean))].sort();

  const entries = runIds.map((runId) => {
    const webmPath = `${dir}/${runId}${WEBM_EXTENSION}`;
    const seriesPath = `${dir}/${runId}${ACTION_SERIES_EXTENSION}`;
    const anchorPath = `${dir}/${runId}${CAPTURE_ANCHOR_EXTENSION}`;
    const read = (path, present) => {
      if (!present) return null;
      try {
        return fs.readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    };
    const seriesPresent = fs.existsSync(seriesPath);
    const anchorPresent = fs.existsSync(anchorPath);
    return {
      runId,
      webmPresent: fs.existsSync(webmPath),
      seriesPresent,
      anchorPresent,
      seriesText: read(seriesPath, seriesPresent),
      anchorText: read(anchorPath, anchorPresent),
    };
  });

  return buildCapturePoolInventory({ dir, entries });
}

/** Formats series time as seconds with one decimal (e.g. `12.4 s`). */
function formatSeconds(ms) {
  return `${(ms / 1_000).toFixed(1)} s`;
}

/**
 * Renders the inventory as a human-readable listing (pure).
 *
 * @param {object} inventory
 * @returns {string}
 */
export function formatPoolInventory(inventory) {
  const lines = [
    `Capture pool inventory — ${inventory.dir} (${inventory.retained.length} retained, ${inventory.excluded.length} excluded)`,
    '',
  ];

  if (inventory.retained.length === 0) {
    lines.push('No retained runs.');
  } else {
    lines.push('Retained runs (WebM + .action.jsonl + .capture.json):');
    for (const run of inventory.retained) {
      lines.push(`  ${run.runId}`);
      lines.push(
        `    series: ${run.sampleCount} sample${run.sampleCount === 1 ? '' : 's'}, ` +
          `${formatSeconds(run.durationMs)}, mean intensity ${run.meanIntensity.toFixed(2)}`,
      );
      lines.push(
        `    anchor: ${
          run.anchor.approximate
            ? 'present (approximate — no join timestamps)'
            : `present (offset ${run.anchor.offsetMs} ms)`
        }`,
      );
      if (run.features.length === 0) {
        lines.push('    features: none');
      } else {
        lines.push(
          `    features: ${run.features
            .map(
              (entry) =>
                `${entry.feature} (${entry.samples} sample${entry.samples === 1 ? '' : 's'}, ${formatSeconds(entry.firstTMs)}–${formatSeconds(entry.lastTMs)})`,
            )
            .join(', ')}`,
        );
      }
    }
  }

  lines.push('', 'Feature coverage:');
  for (const entry of inventory.features) {
    lines.push(
      `  ${entry.feature}: ${entry.runs.length > 0 ? entry.runs.join(', ') : '(none)'}`,
    );
  }
  lines.push(
    '',
    `Missing features: ${
      inventory.missingFeatures.length > 0
        ? inventory.missingFeatures.join(', ')
        : 'none'
    }`,
  );

  if (inventory.excluded.length > 0) {
    lines.push('', 'Excluded runs (missing required artifacts):');
    for (const run of inventory.excluded) {
      lines.push(`  ${run.runId} — ${run.reasons.join('; ')}`);
    }
  }

  for (const error of inventory.errors) lines.push(`error: ${error}`);

  return lines.join('\n');
}

/**
 * CLI entry point. Returns stdout + exit code instead of writing directly,
 * so it is testable without spawning a process.
 *
 * @param {readonly string[]} argv
 * @param {object} [fsImpl] - Injectable `node:fs` surface.
 * @returns {{ code: number, stdout: string, inventory?: object }}
 */
export function listCapturePoolMain(
  argv,
  fsImpl = { readdirSync, existsSync, readFileSync },
) {
  const parsed = parseListPoolArgs(argv);
  if (parsed.help) {
    return { code: 0, stdout: USAGE_TEXT };
  }
  if (parsed.error) {
    return {
      code: 1,
      stdout: `error: ${parsed.error}\n\nRun \`node scripts/list-capture-pool.mjs --help\` for usage.`,
    };
  }

  const inventory = collectCapturePool({
    dir: parsed.dir,
    runs: parsed.runs,
    fs: fsImpl,
  });
  const stdout = parsed.json
    ? `${JSON.stringify(inventory, null, 2)}\n`
    : `${formatPoolInventory(inventory)}\n`;

  const code =
    inventory.errors.length > 0 || inventory.retained.length === 0 ? 1 : 0;
  return { code, stdout, inventory };
}

// Main guard — only runs when executed directly, never on import (so the
// hermetic test suite can import the pure builders without side effects).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, stdout } = listCapturePoolMain(process.argv.slice(2));
  process.stdout.write(stdout);
  process.exitCode = code;
}
