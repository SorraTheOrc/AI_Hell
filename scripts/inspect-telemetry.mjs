/**
 * Telemetry inspector (AH-0MUY08Y9P005ER7A, AC5).
 *
 * A small, dependency-free way to inspect a downloaded telemetry JSONL file
 * (the production sink's payload or the local dev sink's `localStorage`
 * contents). It parses the framed records, skips anything that is not a
 * schema-v1 telemetry record, and prints a human-readable summary
 * (`--json` for machine consumption).
 *
 * Plain ESM JavaScript so it runs under the project's Node runtime without a
 * TypeScript loader; `inspect-telemetry.d.mts` supplies the types used by the
 * test suite. The pure `parseTelemetryJsonl` / `summariseTelemetry` /
 * `formatSummary` functions are the testable core — the CLI is a thin shell.
 *
 * @example
 *   node scripts/inspect-telemetry.mjs recording.jsonl
 *   cat recording.jsonl | node scripts/inspect-telemetry.mjs --json
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The schema version this inspector understands (mirrors `TELEMETRY_SCHEMA_VERSION`). */
export const INSPECT_SCHEMA_VERSION = 1;

/** Record kinds the inspector recognises. */
export const INSPECT_RECORD_KINDS = Object.freeze(['run_header', 'tick', 'event']);

/**
 * True when a decoded value is a schema-v1 telemetry record this inspector
 * can summarise. Payloads stay opaque (mirrors `isTelemetryRecord`).
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isInspectableRecord(value) {
  if (typeof value !== 'object' || value === null) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.schemaVersion !== INSPECT_SCHEMA_VERSION) return false;
  return typeof record.kind === 'string' && INSPECT_RECORD_KINDS.includes(record.kind);
}

/**
 * Parses newline-delimited telemetry JSON.
 *
 * @param {string} text
 * @returns {{ records: object[], skipped: number }}
 */
export function parseTelemetryJsonl(text) {
  const records = [];
  let skipped = 0;
  const lines = typeof text === 'string' ? text.split('\n') : [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let decoded;
    try {
      decoded = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isInspectableRecord(decoded)) {
      skipped += 1;
      continue;
    }
    records.push(decoded);
  }
  return { records, skipped };
}

/**
 * Builds a structured summary of a batch of telemetry records.
 *
 * @param {object[]} records
 * @returns {{
 *   recordCount: number,
 *   byKind: { run_header: number, tick: number, event: number },
 *   schemaVersions: number[],
 *   runs: { count: number, seeds: number[] },
 *   startedAt: number | null,
 *   builds: string[],
 *   ticks: { count: number, first: number | null, last: number | null },
 *   events: Record<string, number>,
 * }}
 */
export function summariseTelemetry(records) {
  const list = Array.isArray(records) ? records : [];
  const byKind = { run_header: 0, tick: 0, event: 0 };
  const schemaVersions = new Set();
  const seeds = new Set();
  const builds = new Set();
  const events = {};
  let startedAt = null;
  let firstTick = null;
  let lastTick = null;

  for (const record of list) {
    if (typeof record.schemaVersion === 'number') schemaVersions.add(record.schemaVersion);
    switch (record.kind) {
      case 'run_header':
        byKind.run_header += 1;
        if (typeof record.runSeed === 'number') seeds.add(record.runSeed);
        if (record.build && typeof record.build === 'object') {
          builds.add(`${record.build.appVersion ?? '?'}@${record.build.commit ?? '?'}`);
        }
        if (typeof record.startedAt === 'number') {
          startedAt = startedAt === null ? record.startedAt : Math.min(startedAt, record.startedAt);
        }
        break;
      case 'tick':
        byKind.tick += 1;
        if (typeof record.tick === 'number') {
          firstTick = firstTick === null ? record.tick : Math.min(firstTick, record.tick);
          lastTick = lastTick === null ? record.tick : Math.max(lastTick, record.tick);
        }
        break;
      case 'event':
        byKind.event += 1;
        if (typeof record.tick === 'number') {
          firstTick = firstTick === null ? record.tick : Math.min(firstTick, record.tick);
          lastTick = lastTick === null ? record.tick : Math.max(lastTick, record.tick);
        }
        if (typeof record.event === 'string') {
          events[record.event] = (events[record.event] ?? 0) + 1;
        }
        break;
      default:
        break;
    }
  }

  return {
    recordCount: list.length,
    byKind,
    schemaVersions: Array.from(schemaVersions).sort((a, b) => a - b),
    runs: { count: byKind.run_header, seeds: Array.from(seeds) },
    startedAt,
    builds: Array.from(builds),
    ticks: { count: byKind.tick, first: firstTick, last: lastTick },
    events,
  };
}

/**
 * Renders a summary as human-readable text.
 *
 * @param {ReturnType<typeof summariseTelemetry>} summary
 * @returns {string}
 */
export function formatSummary(summary) {
  const lines = [];
  lines.push('Telemetry summary');
  lines.push('=================');
  lines.push(`Records: ${summary.recordCount}`);
  lines.push(
    `  run_header: ${summary.byKind.run_header}  tick: ${summary.byKind.tick}  event: ${summary.byKind.event}`,
  );
  lines.push(`Schema versions: ${summary.schemaVersions.join(', ') || 'none'}`);
  lines.push(`Runs: ${summary.runs.count}`);
  if (summary.runs.seeds.length > 0) lines.push(`  seeds: ${summary.runs.seeds.join(', ')}`);
  if (summary.builds.length > 0) lines.push(`Builds: ${summary.builds.join(', ')}`);
  if (summary.startedAt !== null) {
    lines.push(`First run started: ${new Date(summary.startedAt).toISOString()}`);
  }
  if (summary.ticks.count > 0) {
    lines.push(`Ticks: ${summary.ticks.count} (range ${summary.ticks.first}–${summary.ticks.last})`);
  }
  const eventNames = Object.keys(summary.events).sort();
  if (eventNames.length > 0) {
    lines.push('Events:');
    for (const name of eventNames) lines.push(`  ${name}: ${summary.events[name]}`);
  } else {
    lines.push('Events: none');
  }
  return lines.join('\n');
}

/** Reads the whole of stdin synchronously. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** CLI entry point. */
function main(argv) {
  const args = argv.slice(2);
  const json = args.includes('--json');
  const file = args.find((arg) => !arg.startsWith('--'));
  const text = file ? readFileSync(file, 'utf8') : readStdin();

  const { records, skipped } = parseTelemetryJsonl(text);
  const summary = { ...summariseTelemetry(records), skippedLines: skipped };

  if (json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${formatSummary(summary)}\n`);
  if (skipped > 0) process.stdout.write(`Skipped ${skipped} unrecognised line(s).\n`);
  return 0;
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
