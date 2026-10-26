/**
 * Opt-in diagnostics for automated gameplay capture
 * (AH-0MVNT25JI004OVKQ).
 *
 * The long-run capture crash reported by the maintainer is an
 * `ERR_STRING_TOO_LONG` raised inside Playwright's CDP pipe transport
 * (`playwright-core/lib/server/pipeTransport.js` `_dispatch`, which does
 * `Buffer.concat(this._pendingBuffers).toString()`). Node/V8 refuse to create
 * a string longer than `0x1fffffe8` characters, so the transport must have
 * accumulated more than ~512 MiB of undelimited JSON before dispatching a
 * message. Pinning down *which* message class does that is the whole point of
 * this module: a speculative "increase the buffers" fix is not acceptable.
 *
 * Everything here is **off by default** (`--diagnostics` opts in). Nothing in
 * this module changes the capture when it is disabled: the tracker's methods
 * are no-ops and `buildSummary()` returns `null`, so a normal `npm run
 * capture` prints the same output, writes the same artefacts and emits the
 * same `--json` shape (AC4).
 *
 * Three pieces of evidence are collected:
 *
 * 1. **Per-chunk CDP payload sizes.** Every base64 chunk handed to the
 *    `__aiHellCaptureChunk` page binding is recorded with its arrival offset
 *    (ms since recording started). The summary reports count, max, p50 and
 *    p95 and keeps the full size-only timeline, so a single oversized
 *    `dataavailable` flush is distinguishable from a steady one-chunk-per-
 *    second cadence (AC1).
 * 2. **Memory.** Node's `process.memoryUsage().rss` is sampled at the
 *    existing progress-heartbeat cadence (peak retained), and the page heap
 *    is read at clip end via CDP `Runtime.getHeapUsage` (falling back to
 *    `performance.memory`). Bytes on disk and the chunk count come from the
 *    written clip (AC2).
 * 3. **The transport itself.** A diagnostics-only tap wraps
 *    `PipeTransport.prototype._dispatch`, recording the pending (undelimited)
 *    byte count per data event and, on the throw path, describing the
 *    accumulated buffers — count, bytes, a sanitised prefix and the JSON
 *    `method`/binding `name` — before rethrowing. That identifies the
 *    overflowing message class instead of guessing it (AC3).
 *
 * Findings are written next to the clip as `<stem>.diagnostics.json`. The
 * write is additive: a read-only output directory degrades to a reported
 * warning and never fails the clip (AC6). On an actual transport overflow the
 * process is about to die, so the same summary is written synchronously from
 * the tap's overflow hook before the error propagates.
 *
 * This module is plain ESM JavaScript with no runtime dependencies (node
 * built-ins only) so the capture tool runs without a TypeScript loader;
 * `capture-diagnostics.d.mts` supplies the types used by the test suite.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';

/**
 * Node/V8's maximum string length in characters (`0x1fffffe8`). This is the
 * exact ceiling `Buffer#toString` hits in `PipeTransport._dispatch`, so the
 * cumulative base64 bytes recorded per clip are reported as a fraction of it.
 */
export const CDP_PIPE_STRING_LIMIT_CHARS = 0x1fffffe8;

/** Schema version of the `<stem>.diagnostics.json` artefact. */
export const DIAGNOSTICS_SCHEMA_VERSION = 1;

/** File suffix appended to the clip path for the diagnostics artefact. */
export const DIAGNOSTICS_ARTIFACT_SUFFIX = '.diagnostics.json';

/**
 * Cap on retained timeline entries, so a pathological run cannot make the
 * diagnostics artefact larger than the clip it describes. A 30-minute clip at
 * one chunk per second produces ~1800 entries, well under the cap.
 */
const MAX_TIMELINE_ENTRIES = 20_000;

/** How many bytes of an overflowing pending buffer are sampled for evidence. */
const PREFIX_SAMPLE_BYTES = 512;

/**
 * Pending-byte threshold that starts a reported accumulation episode. A single
 * in-flight CDP message is normally well under 1 MiB, so crossing this means
 * the transport is accumulating more than one message (framing lost) — the
 * state that precedes the >512 MiB `.toString()` overflow.
 */
const PENDING_EPISODE_THRESHOLD_BYTES = 1024 * 1024;

/** Cap on recorded accumulation episodes (bounded artefact size). */
const MAX_PENDING_EPISODES = 20;

/**
 * Formats a byte count with binary units (`B`, `KiB`, `MiB`, `GiB`, `TiB`).
 *
 * @param {number} bytes
 * @returns {string} e.g. `1.35 MiB`; `0 B` for non-finite/non-positive input.
 */
export function formatByteSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${Math.round(scaled)} B` : `${scaled.toFixed(2)} ${units[unit]}`;
}

/**
 * Linear-interpolated percentile (the "type 7" definition NumPy and most
 * dashboards use), so the reported p50/p95 are stable and reproducible.
 *
 * @param {Iterable<number>} values
 * @param {number} p — percentile in `[0, 100]`.
 * @returns {number} `0` for an empty sample.
 */
export function percentile(values, p) {
  const sorted = [...values].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const clamped = Math.min(100, Math.max(0, Number.isFinite(p) ? p : 0));
  if (sorted.length === 1) return sorted[0];
  const position = ((sorted.length - 1) * clamped) / 100;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/**
 * Summarises a list of `base64` payload sizes (characters, which equal bytes
 * for base64's ASCII alphabet).
 *
 * @param {Iterable<number>} sizes
 * @returns {{ count: number, totalBytes: number, maxBytes: number, meanBytes: number, p50Bytes: number, p95Bytes: number }}
 */
export function summariseChunkSizes(sizes) {
  const values = [...sizes].filter((n) => Number.isFinite(n) && n >= 0);
  const totalBytes = values.reduce((sum, n) => sum + n, 0);
  return {
    count: values.length,
    totalBytes,
    maxBytes: values.length === 0 ? 0 : Math.max(...values),
    meanBytes: values.length === 0 ? 0 : totalBytes / values.length,
    p50Bytes: percentile(values, 50),
    p95Bytes: percentile(values, 95),
  };
}

/**
 * Resolves the diagnostics artefact path for a clip: `<stem>.diagnostics.json`
 * next to the WebM (AC6). Directory dots are preserved; only the final
 * extension is replaced.
 *
 * @param {string} outputPath
 * @returns {string}
 */
export function diagnosticsPathFor(outputPath) {
  const text = String(outputPath ?? '');
  return `${text.replace(/\.[^./\\]+$/, '')}${DIAGNOSTICS_ARTIFACT_SUFFIX}`;
}

/**
 * Sanitises raw bytes for a single-line log/JSON prefix: printable ASCII is
 * kept, everything else becomes `·` so control bytes (including the `\0`
 * delimiter) can never corrupt a log line.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function sanitisePrefix(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const code = bytes[i];
    text += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : '·';
  }
  return text;
}

/**
 * Reads the transport's pending (accumulated but undelivered) bytes.
 *
 * Two Playwright pipe implementations exist: the Chromium CDP pipe uses a
 * `\0`-delimited protocol with a `_pendingBuffers` array, while the
 * length-prefixed variant keeps a single `_data` buffer. Both shapes are
 * supported so the tap degrades gracefully if the internals change.
 *
 * @param {unknown} transport
 * @returns {{ buffers: Uint8Array[], data: Uint8Array | null }}
 */
export function readPendingBuffers(transport) {
  if (!transport || typeof transport !== 'object') return { buffers: [], data: null };
  const pending = /** @type {{ _pendingBuffers?: unknown, _data?: unknown }} */ (transport)
    ._pendingBuffers;
  if (Array.isArray(pending)) {
    return {
      buffers: pending.filter((buffer) => buffer && typeof buffer.length === 'number'),
      data: null,
    };
  }
  const data = /** @type {{ _data?: unknown }} */ (transport)._data;
  if (data && typeof /** @type {{ length?: unknown }} */ (data).length === 'number') {
    return { buffers: [], data: /** @type {Uint8Array} */ (data) };
  }
  return { buffers: [], data: null };
}

/**
 * Describes pending transport bytes without keeping the payload: count,
 * total bytes, a sanitised prefix and the CDP message class parsed from the
 * prefix (`"method":"…"` plus, for bindings, `"name":"…"`).
 *
 * Pure, so the classification logic is hermetically testable without a
 * browser or Playwright internals.
 *
 * @param {{ buffers?: Uint8Array[], data?: Uint8Array | null } | Uint8Array[]} pending
 * @returns {{ count: number, bytes: number, prefix: string, method: string | null, bindingName: string | null, innerBindingName: string | null, messageClass: string }}
 */
export function describePendingBuffers(pending) {
  const buffers = Array.isArray(pending)
    ? pending
    : [...(pending?.buffers ?? [])];
  const single = Array.isArray(pending) ? null : pending?.data ?? null;
  const all = single ? [...buffers, single] : buffers;
  const bytes = all.reduce((sum, buffer) => sum + (buffer?.length ?? 0), 0);

  const head = [];
  let remaining = PREFIX_SAMPLE_BYTES;
  for (const buffer of all) {
    if (remaining <= 0) break;
    const slice = buffer.subarray(0, Math.min(buffer.length, remaining));
    head.push(...slice);
    remaining -= slice.length;
  }
  const prefix = sanitisePrefix(Uint8Array.from(head));

  const methodMatch = prefix.match(/"method"\s*:\s*"([^"]+)"/);
  const nameMatch = prefix.match(/"name"\s*:\s*"([^"]+)"/);
  // Playwright's own binding envelope nests the exposed function name inside
  // the escaped payload (`...\"name\":\"__aiHellCaptureChunk\"...`), so
  // report both: the CDP binding and the page function it carries.
  const innerNameMatch = prefix.match(/\\"name\\":\\"([^"\\]+)\\"/);
  const method = methodMatch ? methodMatch[1] : null;
  const bindingName = nameMatch ? nameMatch[1] : null;
  const innerBindingName = innerNameMatch ? innerNameMatch[1] : null;
  const messageClass =
    method && bindingName
      ? `${method} (${bindingName}${innerBindingName ? ` → ${innerBindingName}` : ''})`
      : method ?? (bytes > 0 ? 'unrecognised (no JSON method in prefix)' : 'empty');

  return {
    count: all.length,
    bytes,
    prefix,
    method,
    bindingName,
    innerBindingName,
    messageClass,
  };
}

/**
 * Creates the per-clip diagnostics tracker.
 *
 * A **disabled** tracker (the default) records nothing and returns `null` from
 * `buildSummary()`, so callers can keep a single code path while the normal
 * capture stays byte-for-byte identical (AC4).
 *
 * @param {{ enabled?: boolean, now?: () => number, readRss?: () => number, maxTimelineEntries?: number }} [options]
 */
export function createDiagnosticsTracker({
  enabled = false,
  now = () => Date.now(),
  readRss = () => process.memoryUsage().rss,
  maxTimelineEntries = MAX_TIMELINE_ENTRIES,
} = {}) {
  const startedAtMs = enabled ? now() : 0;
  /** @type {Array<{ atMs: number, base64Bytes: number }>} */
  const chunkEntries = [];
  /** @type {Array<{ atMs: number, rssBytes: number }>} */
  const rssSamples = [];
  /** @type {{ source: string, heapUsedBytes?: number, totalHeapBytes?: number, [key: string]: unknown } | null} */
  let pageMetrics = null;
  /** @type {object | null} */
  let transport = null;
  /** @type {string[]} */
  const notes = [];
  let timelineTruncated = false;
  const elapsed = () => (enabled ? Math.max(0, now() - startedAtMs) : 0);

  return {
    enabled,

    /** Number of chunks observed so far (0 when disabled). */
    get chunkCount() {
      return enabled ? chunkEntries.length : 0;
    },

    /**
     * Records one base64 payload handed to the CDP binding (AC1).
     *
     * @param {unknown} base64
     * @returns {number} recorded payload size, or 0 when disabled/not a string.
     */
    recordChunk(base64) {
      if (!enabled || typeof base64 !== 'string') return 0;
      const size = base64.length;
      if (chunkEntries.length < maxTimelineEntries) {
        chunkEntries.push({ atMs: elapsed(), base64Bytes: size });
      } else {
        timelineTruncated = true;
      }
      return size;
    },

    /**
     * Samples node RSS at the caller's heartbeat cadence (AC2).
     *
     * @returns {number} the sampled RSS, or 0 when disabled.
     */
    sampleRss() {
      if (!enabled) return 0;
      const rssBytes = Number(readRss());
      rssSamples.push({ atMs: elapsed(), rssBytes });
      return rssBytes;
    },

    /** Records the page-side heap read at clip end (AC2). */
    recordPageMetrics(metrics) {
      if (!enabled || !metrics || typeof metrics !== 'object') return;
      pageMetrics = { ...metrics };
    },

    /** Records a transport-tap snapshot (AC3). */
    recordTransport(snapshot) {
      if (!enabled || !snapshot || typeof snapshot !== 'object') return;
      transport = { ...snapshot };
    },

    /** Adds a freeform note to the artefact (e.g. a degraded tap). */
    note(message) {
      if (!enabled || !message) return;
      notes.push(String(message));
    },

    /** Milliseconds since the tracker was created. */
    elapsedMs() {
      return elapsed();
    },

    /**
     * Lightweight view for the heartbeat line, so progress output can show the
     * running chunk/RSS/pending numbers without allocating the full summary.
     */
    snapshot() {
      if (!enabled) return null;
      const sizes = chunkEntries.map((entry) => entry.base64Bytes);
      const summary = summariseChunkSizes(sizes);
      return {
        elapsedMs: elapsed(),
        chunkCount: summary.count,
        totalBase64Bytes: summary.totalBytes,
        maxBase64Bytes: summary.maxBytes,
        peakRssBytes: rssSamples.reduce((peak, sample) => Math.max(peak, sample.rssBytes), 0),
        // The live transport tap is process-wide, so read it directly (not the
        // recordTransport copy) — the heartbeat should show pending growth.
        transport: readTransportTapSnapshot(),
      };
    },

    /**
     * Builds the `<stem>.diagnostics.json` payload.
     *
     * @param {{ clip?: object, transport?: object | null }} [extra]
     * @returns {object | null} `null` when diagnostics are disabled.
     */
    buildSummary({ clip = {}, transport: transportOverride = undefined } = {}) {
      if (!enabled) return null;
      const entries = [...chunkEntries];
      const sizes = entries.map((entry) => entry.base64Bytes);
      const measured = summariseChunkSizes(sizes);
      const peakRssBytes = rssSamples.reduce(
        (peak, sample) => Math.max(peak, sample.rssBytes),
        0,
      );
      const maxEntry =
        entries.length === 0
          ? null
          : entries.reduce((largest, entry) =>
              entry.base64Bytes > largest.base64Bytes ? entry : largest,
            );

      return {
        enabled: true,
        schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
        generatedAt: new Date(now()).toISOString(),
        elapsedMs: elapsed(),
        chunks: {
          ...measured,
          firstAtMs: entries.length === 0 ? null : entries[0].atMs,
          lastAtMs: entries.length === 0 ? null : entries[entries.length - 1].atMs,
          maxChunk: maxEntry,
          timeline: entries,
          timelineTruncated,
          cdpPipeStringLimitChars: CDP_PIPE_STRING_LIMIT_CHARS,
          // The crash reproduces once the cumulative base64 handed to the pipe
          // crosses V8's string limit; this ratio makes that comparison explicit.
          cumulativeFractionOfCdpStringLimit:
            CDP_PIPE_STRING_LIMIT_CHARS > 0
              ? measured.totalBytes / CDP_PIPE_STRING_LIMIT_CHARS
              : 0,
        },
        node: {
          peakRssBytes,
          lastRssBytes:
            rssSamples.length === 0 ? 0 : rssSamples[rssSamples.length - 1].rssBytes,
          sampleCount: rssSamples.length,
          samples: rssSamples,
        },
        page: pageMetrics ?? { source: 'unavailable' },
        transport: transportOverride ?? transport ?? { installed: false },
        clip: { ...clip, chunkCount: entries.length },
        notes: [...notes],
      };
    },
  };
}

/**
 * Renders the one-line diagnostics suffix appended to the recording heartbeat
 * while `--diagnostics` is on (the normal heartbeat is unchanged, AC4).
 *
 * @param {object | null} snapshot — from `tracker.snapshot()`.
 * @returns {string}
 */
export function formatDiagnosticsProgress(snapshot) {
  if (!snapshot) return '';
  const limit = CDP_PIPE_STRING_LIMIT_CHARS;
  const ratio = limit > 0 ? snapshot.totalBase64Bytes / limit : 0;
  const pending = snapshot.transport?.lastPendingBytes;
  return (
    `diag chunks=${snapshot.chunkCount} max=${formatByteSize(snapshot.maxBase64Bytes)} ` +
    `total=${formatByteSize(snapshot.totalBase64Bytes)} (${(ratio * 100).toFixed(1)}% of CDP limit) ` +
    `rss=${formatByteSize(snapshot.peakRssBytes)}` +
    (Number.isFinite(pending) ? ` pending=${formatByteSize(pending)}` : '')
  );
}

/**
 * Renders the human-readable diagnostics block appended to the capture report.
 *
 * @param {object | null} summary — from `tracker.buildSummary()`.
 * @returns {string}
 */
export function formatDiagnosticsSummary(summary) {
  if (!summary) return '';
  const chunks = summary.chunks ?? {};
  const limit = chunks.cdpPipeStringLimitChars ?? CDP_PIPE_STRING_LIMIT_CHARS;
  const ratio = Number(chunks.cumulativeFractionOfCdpStringLimit ?? 0);
  const page = summary.page ?? {};
  const transport = summary.transport ?? {};
  const lines = [
    `Diagnostics:${summary.artifactPath ? ` ${summary.artifactPath}` : ''}`,
    `Chunks:     ${chunks.count ?? 0} ` +
      `(max ${formatByteSize(chunks.maxBytes ?? 0)}, ` +
      `p50 ${formatByteSize(chunks.p50Bytes ?? 0)}, ` +
      `p95 ${formatByteSize(chunks.p95Bytes ?? 0)})`,
    `CDP bytes:  ${formatByteSize(chunks.totalBytes ?? 0)} accumulated ` +
      `(${(ratio * 100).toFixed(1)}% of the ${formatByteSize(limit)} string limit)`,
    `Node RSS:   ${formatByteSize(summary.node?.peakRssBytes ?? 0)} peak ` +
      `(${summary.node?.sampleCount ?? 0} heartbeat samples)`,
    `Page heap:  ${
      page.source && page.source !== 'unavailable'
        ? `${formatByteSize(page.heapUsedBytes ?? 0)} used (${page.source})`
        : 'unavailable'
    }`,
  ];
  if (transport.installed) {
    const overflow = transport.overflow;
    lines.push(
      `Transport:  max message ${formatByteSize(transport.maxMessageBytes ?? 0)}; ` +
        `max pending ${formatByteSize(transport.maxPendingBytes ?? 0)} ` +
        `in ${transport.maxPendingBuffers ?? 0} buffer(s) ` +
        `(${transport.undelimitedEvents ?? 0}/${transport.dataEvents ?? 0} undelimited reads)` +
        (overflow
          ? `; OVERFLOW ${formatByteSize(overflow.bytes ?? 0)} — ${overflow.messageClass}`
          : ''),
    );
    if (transport.maxMessageSample?.messageClass) {
      lines.push(`Message:    ${transport.maxMessageSample.messageClass}`);
    }
  } else if (transport.reason) {
    lines.push(`Transport:  tap unavailable (${transport.reason})`);
  }
  return lines.join('\n');
}

/**
 * Writes the diagnostics artefact next to the clip (AC6).
 *
 * Additive by contract: any failure (read-only directory, full disk, a
 * non-serialisable summary) is returned as `error` and never thrown, so a
 * diagnostics write can never fail the clip it describes.
 *
 * @param {{ outputPath: string, summary: object, writeFile?: (path: string, data: string) => void }} params
 * @returns {{ path: string, error: string | null }}
 */
export function writeDiagnosticsArtifact({
  outputPath,
  summary,
  writeFile = writeFileSync,
}) {
  const path = diagnosticsPathFor(outputPath);
  try {
    writeFile(path, `${JSON.stringify(summary, null, 2)}\n`);
    return { path, error: null };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { path, error: message };
  }
}

/** The most recently installed transport tap (module-level singleton). */
let latestTransportTap = null;

/** Handlers invoked when the tap observes an overflow (process is dying). */
const overflowHandlers = new Set();

/**
 * Registers a handler called when the transport tap detects an overflow.
 *
 * Used to write the crash diagnostics artefact synchronously before the
 * transport error propagates and kills the process.
 *
 * @param {(overflow: object) => void} handler
 * @returns {() => void} disposer
 */
export function addTransportOverflowHandler(handler) {
  if (typeof handler !== 'function') return () => {};
  overflowHandlers.add(handler);
  return () => {
    overflowHandlers.delete(handler);
  };
}

function notifyTransportOverflow(overflow) {
  for (const handler of [...overflowHandlers]) {
    try {
      handler(overflow);
    } catch {
      /* diagnostics must never mask the transport error */
    }
  }
}

/**
 * Returns a snapshot of the most recently installed transport tap.
 *
 * @returns {object} `{ installed: false, reason }` when no tap is available.
 */
export function readTransportTapSnapshot() {
  if (!latestTransportTap) {
    return {
      installed: false,
      reason: 'no transport tap installed (diagnostics disabled)',
      dataEvents: 0,
      undelimitedEvents: 0,
      lastPendingBytes: 0,
      lastPendingBuffers: 0,
      maxPendingBytes: 0,
      maxPendingBuffers: 0,
      maxPendingAtMs: null,
      maxPendingSample: null,
      maxMessageBytes: 0,
      maxMessageSample: null,
      pendingEpisodes: [],
      overflow: null,
    };
  }
  const {
    installed = true,
    reason,
    dataEvents = 0,
    undelimitedEvents = 0,
    lastPendingBytes = 0,
    lastPendingBuffers = 0,
    maxPendingBytes = 0,
    maxPendingBuffers = 0,
    maxPendingAtMs = null,
    maxPendingSample = null,
    maxMessageBytes = 0,
    maxMessageSample = null,
    pendingEpisodes = [],
    overflow = null,
  } = latestTransportTap;
  return {
    installed,
    ...(reason ? { reason } : {}),
    dataEvents,
    undelimitedEvents,
    lastPendingBytes,
    lastPendingBuffers,
    maxPendingBytes,
    maxPendingBuffers,
    maxPendingAtMs,
    maxPendingSample,
    maxMessageBytes,
    maxMessageSample,
    pendingEpisodes: [...pendingEpisodes],
    overflow,
  };
}

/**
 * Resolves and loads Playwright's Chromium CDP pipe transport module.
 *
 * `playwright-core` blocks the `lib/server/pipeTransport.js` subpath in its
 * `exports` map, so the module is reached through the package's resolved
 * entry point. ESM importing the CJS file shares Node's require cache with
 * Playwright's own `require('./pipeTransport')`, which is what makes patching
 * its prototype visible to the running browser connection.
 *
 * @param {{ resolvePackageEntry?: (specifier: string) => string }} [options]
 * @returns {Promise<{ PipeTransport?: object }>}
 */
export async function loadPlaywrightPipeTransport({
  resolvePackageEntry = (specifier) => createRequire(import.meta.url).resolve(specifier),
} = {}) {
  const entry = resolvePackageEntry('playwright-core');
  const file = join(dirname(entry), 'lib', 'server', 'pipeTransport.js');
  const loaded = await import(pathToFileURL(file).href);
  return /** @type {{ PipeTransport?: object, default?: { PipeTransport?: object } }} */ (
    loaded.default ?? loaded
  );
}

/**
 * Installs the diagnostics-only CDP pipe transport tap (AC3).
 *
 * Idempotent per transport prototype: repeated calls return the same stats.
 * The tap never alters dispatch behaviour — it samples the pending bytes
 * around the original `_dispatch` and, if the original throws (the
 * `ERR_STRING_TOO_LONG` overflow), records the accumulated buffers' count,
 * size, prefix and message class before rethrowing the original error.
 *
 * @param {{ loadPipeTransport?: () => Promise<unknown>, logger?: (message: string) => void }} [options]
 * @returns {Promise<object>} tap stats (or `{ installed: false, reason }`).
 */
export async function createTransportTap({ loadPipeTransport, logger = () => {} } = {}) {
  if (typeof loadPipeTransport !== 'function') {
    return { installed: false, reason: 'no pipe transport loader supplied' };
  }

  let loaded;
  try {
    loaded = await loadPipeTransport();
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { installed: false, reason: `pipe transport not loadable (${message})` };
  }

  const module = /** @type {{ PipeTransport?: object, default?: { PipeTransport?: object } }} */ (
    loaded
  );
  const PipeTransport = module?.PipeTransport ?? module?.default?.PipeTransport;
  const prototype =
    PipeTransport && /** @type {{ prototype?: Record<string, unknown> }} */ (PipeTransport).prototype;
  if (!prototype || typeof prototype._dispatch !== 'function') {
    return { installed: false, reason: 'unrecognised Playwright pipe transport implementation' };
  }

  if (prototype.__aiHellDiagnosticsTap) {
    latestTransportTap = /** @type {object} */ (prototype.__aiHellDiagnosticsTap);
    return latestTransportTap;
  }

  /** @type {Record<string, unknown>} */
  const stats = {
    installed: true,
    implementation: 'pipeTransport._dispatch',
    dataEvents: 0,
    undelimitedEvents: 0,
    lastPendingBytes: 0,
    lastPendingBuffers: 0,
    maxPendingBytes: 0,
    maxPendingBuffers: 0,
    maxPendingAtMs: null,
    maxPendingSample: null,
    maxMessageBytes: 0,
    maxMessageSample: null,
    /** @type {object[]} */
    pendingEpisodes: [],
    overflow: null,
  };
  const original = prototype._dispatch;

  prototype._dispatch = function dispatchWithDiagnostics(buffer) {
    stats.dataEvents = /** @type {number} */ (stats.dataEvents) + 1;
    let pendingBefore = null;
    let delimiterIndex = -1;
    try {
      pendingBefore = describePendingBuffers(readPendingBuffers(this));
      delimiterIndex =
        buffer && typeof buffer.indexOf === 'function' ? buffer.indexOf(0) : -1;
      if (delimiterIndex === -1) {
        stats.undelimitedEvents = /** @type {number} */ (stats.undelimitedEvents) + 1;
      } else {
        // The first message in this data event: the pending tail it completes
        // plus the bytes before the terminator. This is the true size of the
        // largest observed CDP message (the AC3 evidence).
        const messageBytes = pendingBefore.bytes + delimiterIndex;
        if (messageBytes > /** @type {number} */ (stats.maxMessageBytes)) {
          const sample =
            pendingBefore.bytes > 0
              ? pendingBefore
              : describePendingBuffers([buffer.subarray(0, delimiterIndex)]);
          stats.maxMessageBytes = messageBytes;
          stats.maxMessageSample = { ...sample, bytes: messageBytes, atMs: Date.now() };
        }
      }
    } catch {
      /* diagnostics must never alter dispatch */
    }
    try {
      return original.call(this, buffer);
    } catch (error) {
      const detail = describePendingBuffers(readPendingBuffers(this));
      const atMs = Date.now();
      stats.overflow = {
        ...detail,
        atMs,
        errorName: error && error.name ? error.name : 'Error',
        errorMessage: error && error.message ? error.message : String(error),
      };
      if (detail.bytes > /** @type {number} */ (stats.maxPendingBytes)) {
        stats.maxPendingBytes = detail.bytes;
        stats.maxPendingBuffers = detail.count;
        stats.maxPendingAtMs = atMs;
        stats.maxPendingSample = detail;
      }
      logger(
        `Diagnostics: CDP pipe dispatch overflow — ${formatByteSize(detail.bytes)} ` +
          `pending in ${detail.count} buffer(s), message class ${detail.messageClass}; ` +
          `prefix "${detail.prefix.slice(0, 160)}"`,
      );
      notifyTransportOverflow(/** @type {object} */ (stats.overflow));
      throw error;
    } finally {
      try {
        const after = describePendingBuffers(readPendingBuffers(this));
        stats.lastPendingBytes = after.bytes;
        stats.lastPendingBuffers = after.count;
        if (after.bytes > /** @type {number} */ (stats.maxPendingBytes)) {
          stats.maxPendingBytes = after.bytes;
          stats.maxPendingBuffers = after.count;
          stats.maxPendingAtMs = Date.now();
          stats.maxPendingSample = after;
        }
        // Record accumulation episodes: pending crossing 1 MiB means more than
        // one message is waiting (framing lost), the precursor of the overflow.
        /** @type {object[]} */
        const episodes = /** @type {object[]} */ (stats.pendingEpisodes);
        if (after.bytes >= PENDING_EPISODE_THRESHOLD_BYTES) {
          const last = episodes.length === 0 ? null : episodes[episodes.length - 1];
          if (!last || after.bytes < /** @type {number} */ (last.bytes)) {
            if (episodes.length < MAX_PENDING_EPISODES) {
              episodes.push({
                atMs: Date.now(),
                bytes: after.bytes,
                count: after.count,
                messageClass: after.messageClass,
                prefix: after.prefix.slice(0, 240),
              });
            }
          } else {
            last.bytes = after.bytes;
            last.count = after.count;
          }
        }
      } catch {
        /* diagnostics must never alter dispatch */
      }
    }
  };
  // Marker makes the patch idempotent and readable from the snapshot.
  prototype.__aiHellDiagnosticsTap = stats;
  latestTransportTap = stats;
  return stats;
}
