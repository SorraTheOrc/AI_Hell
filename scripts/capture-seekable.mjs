/**
 * Seek-index remux for captured gameplay WebMs
 * (AH-0MVMIK8EM001JAYR, parent AH-0MVMIC8QN007GX4T).
 *
 * Chromium's `MediaRecorder` writes a WebM whose Segment Info carries **no
 * Duration**, and whose clusters are accompanied by **no SeekHead and no Cues
 * (seek index)**. Most players tolerate that; VLC does not — fast-forward and
 * seek fail and the timeline is unusable, because there is nothing to seek
 * *with*. The capture path used to deliver that file verbatim.
 *
 * A packet-preserving remux fixes the container without touching the encoded
 * data: `ffmpeg -i <clip>.webm -c copy <clip>.seekable.webm` re-writes the
 * Segment with a Duration, a SeekHead (pointing at Info, Tracks and Cues) and
 * a Cues index, while copying the VP9 and Opus packets bit for bit — no
 * re-encode, no quality or content change (AC2). ffmpeg streams the packets
 * itself, so a ~1.8 GB long run costs O(1) node memory and only the ffmpeg
 * child's own buffers (mirroring the streaming discipline of
 * `scripts/capture-chunk-sink.mjs`, AH-0MVNT26AQ005LDNS).
 *
 * **Where it runs.** Every capture path (single clip, `--count` batch,
 * `--all-scenarios` scenario clips and the `capture:scenes` multi-scene WebM)
 * delivers its clip through `recording.finalise({ success: true })`, so that
 * seam is the single place this module is invoked from
 * (`scripts/capture-recording-pipeline.mjs`) — one call site, no path can
 * silently skip it (AC3).
 *
 * **Tool resolution (AC4, producer decision (a)).** The remux candidates are
 * tried in a documented, deterministic order: `FFMPEG_BIN` → the
 * **Playwright-bundled** ffmpeg resolved through the Playwright registry (the
 * binary installed by the documented `npm run capture:install`, so the
 * documented "the capture path never invokes a *system* ffmpeg" constraint
 * stands) → `PATH`. Each candidate is *attempted*, not merely found: a
 * bundled build that cannot remux VP9 (Playwright ffmpeg revisions before
 * `1013` lack the `vp9_superframe` bitstream filter, so `-c copy` fails with
 * "Unknown bitstream filter") is skipped in favour of the next candidate.
 * When no candidate produces a seekable file the capture still **succeeds**
 * and keeps the current unseekable WebM, with a warning that names the fix
 * and how to enable it — never a hard failure.
 *
 * **Failure safety.** The remux writes to `<stem>.seekable.webm` and the
 * result is verified (duration + Cues + SeekHead) *before* it is renamed over
 * the clip, mirroring the `.partial.webm` rename discipline of the chunk
 * sink: a failed or half-written remux can therefore never destroy the raw
 * capture.
 *
 * This module is plain ESM JavaScript with node built-ins only so the capture
 * tool keeps running without a TypeScript loader; `capture-seekable.d.mts`
 * supplies the types.
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';

/**
 * Suffix inserted before the clip extension for the remux write target
 * (`<stem>.webm` → `<stem>.seekable.webm`). The remuxed file is renamed over
 * the clip only after it has been verified, so an interrupted remux leaves
 * the raw capture intact.
 */
export const SEEKABLE_REMUX_SUFFIX = '.seekable.webm';

/** EBML element names this module recognises (top level and inside Segment). */
export const EBML_ELEMENT_NAMES = Object.freeze({
  0x1a45dfa3: 'EBML',
  0x18538067: 'Segment',
  0x114d9b74: 'SeekHead',
  0x1549a966: 'Info',
  0x1654ae6b: 'Tracks',
  0x1c53bb6b: 'Cues',
  0x1f43b675: 'Cluster',
  0x1254c367: 'Tags',
  0x1043a770: 'Chapters',
  0x4dbb: 'Seek',
  0x53ab: 'SeekID',
  0x53ac: 'SeekPosition',
  0x2ad7b1: 'TimecodeScale',
  0x4489: 'Duration',
});

/** SeekHead targets a fully indexed (seekable) WebM must reference (AC1). */
export const REQUIRED_SEEK_HEAD_TARGETS = Object.freeze(['Info', 'Tracks', 'Cues']);

/** Matroska default TimecodeScale (1 ms in ns) when Info omits it. */
const DEFAULT_TIMECODE_SCALE_NS = 1_000_000;

/** Guard against a pathological/looping element list during a scan. */
const MAX_SCANNED_ELEMENTS = 200_000;

/** ffmpeg install hints surfaced by the "no usable ffmpeg" warning (AC4). */
export const REMUX_INSTALL_HINTS = Object.freeze([
  'sudo apt-get install ffmpeg (Debian/Ubuntu)',
  'brew install ffmpeg (macOS)',
  'or point FFMPEG_BIN at a full ffmpeg build',
]);

/**
 * Resolves the documented remux write target for a clip path: insert
 * `SEEKABLE_REMUX_SUFFIX` before the `.webm` extension, or append it when the
 * path has no `.webm` extension at all.
 *
 * @param {string} outputPath — final clip path (e.g. `out/clip.webm`).
 * @returns {string} e.g. `out/clip.seekable.webm`.
 */
export function remuxTempPathFor(outputPath) {
  const target = typeof outputPath === 'string' ? outputPath : '';
  const match = /\.webm$/i.exec(target);
  return match
    ? `${target.slice(0, match.index)}${SEEKABLE_REMUX_SUFFIX}`
    : `${target}${SEEKABLE_REMUX_SUFFIX}`;
}

/** Reverses a big-endian byte slice into a (safe) number / BigInt value. */
const toBigInt = (buffer, offset, length) => {
  let value = 0n;
  for (let i = 0; i < length; i += 1) value = (value << 8n) | BigInt(buffer[offset + i]);
  return value;
};

/**
 * Parses one EBML element header (element ID + data size) at `offset`.
 *
 * EBML IDs keep their marker bit; sizes are variable-length integers whose
 * marker bit is stripped. A size whose value bits are all `1` means
 * "unknown size" (how Chromium writes the Segment and its clusters).
 *
 * Pure: reads only through the supplied `buffer`, returns `null` for a
 * truncated/invalid header.
 *
 * @param {Buffer} buffer — bytes containing the header.
 * @param {number} [offset] — header start within `buffer`.
 * @returns {{
 *   id: number,
 *   name: string|null,
 *   idLength: number,
 *   size: number,
 *   sizeLength: number,
 *   unknownSize: boolean,
 *   headerBytes: number,
 * }|null}
 */
export function readElementHeader(buffer, offset = 0) {
  if (!buffer || buffer.length === 0 || offset < 0) return null;
  const first = buffer[offset];
  if (first === undefined || first === 0) return null;

  let idLength = 0;
  let mask = 0x80;
  while (idLength < 4) {
    idLength += 1;
    if (first & mask) break;
    mask >>= 1;
  }
  if (!(first & mask)) return null;
  if (offset + idLength > buffer.length) return null;

  const sizeOffset = offset + idLength;
  const sizeFirst = buffer[sizeOffset];
  if (sizeFirst === undefined || sizeFirst === 0) return null;

  let sizeLength = 0;
  let sizeMask = 0x80;
  while (sizeLength < 8) {
    sizeLength += 1;
    if (sizeFirst & sizeMask) break;
    sizeMask >>= 1;
  }
  if (!(sizeFirst & sizeMask)) return null;
  if (sizeOffset + sizeLength > buffer.length) return null;

  const id = Number(toBigInt(buffer, offset, idLength));
  const rawSize = toBigInt(buffer, sizeOffset, sizeLength) & ((1n << BigInt(7 * sizeLength)) - 1n);
  const unknownSize = rawSize === (1n << BigInt(7 * sizeLength)) - 1n;

  return {
    id,
    name: EBML_ELEMENT_NAMES[id] ?? null,
    idLength,
    size: unknownSize ? 0 : Number(rawSize),
    sizeLength,
    unknownSize,
    headerBytes: idLength + sizeLength,
  };
}

/**
 * Parses a SeekHead payload into the element names it points at, and an Info
 * payload into its TimecodeScale / Duration.
 *
 * Both payloads are small (tens to hundreds of bytes), so they are parsed
 * eagerly; nothing else in the Segment is ever read into memory. A SeekHead
 * holds `Seek` master elements, each wrapping one `SeekID`, so the parse
 * descends one level (harmless for a flat Info payload).
 *
 * @param {Buffer} payload
 * @param {number} [depth] — nesting depth already descended (internal;
 *   recursion is bounded so a malformed file cannot loop).
 * @returns {{ seekTargets: string[], timecodeScaleNs: number|null, durationTicks: number|null }}
 */
export function parseInfoAndSeekPayloads(payload, depth = 0) {
  const result = { seekTargets: [], timecodeScaleNs: null, durationTicks: null };
  if (!payload || payload.length === 0) return result;
  let offset = 0;
  for (let guard = 0; guard < MAX_SCANNED_ELEMENTS && offset < payload.length; guard += 1) {
    const header = readElementHeader(payload, offset);
    if (!header) break;
    const dataStart = offset + header.headerBytes;
    const dataEnd = dataStart + header.size;
    if (dataEnd > payload.length) break;
    if (header.name === 'Seek' && depth < 2) {
      const nested = parseInfoAndSeekPayloads(payload.subarray(dataStart, dataEnd), depth + 1);
      for (const target of nested.seekTargets) {
        if (!result.seekTargets.includes(target)) result.seekTargets.push(target);
      }
    } else if (header.name === 'SeekID' && header.size > 0) {
      const target = Number(toBigInt(payload, dataStart, Math.min(header.size, 4)));
      const name = EBML_ELEMENT_NAMES[target];
      if (name && !result.seekTargets.includes(name)) result.seekTargets.push(name);
    } else if (header.name === 'TimecodeScale' && header.size > 0) {
      result.timecodeScaleNs = Number(toBigInt(payload, dataStart, header.size));
    } else if (header.name === 'Duration' && (header.size === 4 || header.size === 8)) {
      result.durationTicks =
        header.size === 4
          ? payload.readFloatBE(dataStart)
          : payload.readDoubleBE(dataStart);
    }
    offset = dataEnd;
  }
  return result;
}

/**
 * Scans a WebM's EBML structure and reports whether it carries a seek index.
 *
 * Only element **headers** are read, plus the (small) SeekHead and Info
 * payloads: cluster contents are skipped by their declared size, so the scan
 * is O(number of top-level elements) seeks and O(1) memory even for a 1.8 GB
 * clip.
 *
 * @param {{
 *   read: (offset: number, length: number) => Buffer,
 *   size: number,
 * }} source — random-access byte source (`createFileScanSource` for real
 *   files; a buffer-backed source in tests).
 * @returns {{
 *   hasSegment: boolean,
 *   hasSeekHead: boolean,
 *   hasInfo: boolean,
 *   hasTracks: boolean,
 *   hasCues: boolean,
 *   seekHeadTargets: string[],
 *   seekHeadComplete: boolean,
 *   durationSeconds: number|null,
 *   segmentSizeKnown: boolean,
 *   truncated: boolean,
 * }}
 */
export function scanWebmSeekIndex({ read, size } = {}) {
  const outcome = {
    hasSegment: false,
    hasSeekHead: false,
    hasInfo: false,
    hasTracks: false,
    hasCues: false,
    seekHeadTargets: [],
    seekHeadComplete: false,
    durationSeconds: null,
    segmentSizeKnown: false,
    truncated: false,
  };
  if (typeof read !== 'function' || !(size > 0)) {
    outcome.truncated = true;
    return outcome;
  }

  // Top level: the EBML header followed by exactly one Segment.
  let position = 0;
  let segmentStart = null;
  let segmentEnd = size;
  for (let guard = 0; guard < 8 && position < size; guard += 1) {
    const header = readElementHeader(read(position, 12), 0);
    if (!header) {
      outcome.truncated = true;
      return outcome;
    }
    const dataStart = position + header.headerBytes;
    if (header.name === 'Segment') {
      outcome.hasSegment = true;
      outcome.segmentSizeKnown = !header.unknownSize;
      segmentStart = dataStart;
      segmentEnd = header.unknownSize ? size : Math.min(dataStart + header.size, size);
      break;
    }
    if (header.unknownSize) {
      outcome.truncated = true;
      return outcome;
    }
    position = dataStart + header.size;
  }
  if (segmentStart === null) return outcome;

  // Segment children: record the ones that make a clip seekable, skip the rest.
  let offset = segmentStart;
  let timecodeScaleNs = DEFAULT_TIMECODE_SCALE_NS;
  let durationTicks = null;
  for (let guard = 0; guard < MAX_SCANNED_ELEMENTS && offset < segmentEnd; guard += 1) {
    const header = readElementHeader(read(offset, 12), 0);
    if (!header) {
      outcome.truncated = true;
      break;
    }
    const dataStart = offset + header.headerBytes;
    if (header.unknownSize) {
      // An unknown-size child (Chromium's clusters) cannot be skipped, so the
      // scan stops here rather than guessing — the caller reports honestly.
      outcome.truncated = true;
      break;
    }
    if (header.name === 'SeekHead') outcome.hasSeekHead = true;
    else if (header.name === 'Info') outcome.hasInfo = true;
    else if (header.name === 'Tracks') outcome.hasTracks = true;
    else if (header.name === 'Cues') outcome.hasCues = true;

    if (header.name === 'SeekHead' || header.name === 'Info') {
      const payload = read(dataStart, header.size);
      const parsed = parseInfoAndSeekPayloads(payload);
      if (header.name === 'SeekHead' && parsed.seekTargets.length > 0) {
        outcome.seekHeadTargets = parsed.seekTargets;
      }
      if (header.name === 'Info') {
        if (parsed.timecodeScaleNs) timecodeScaleNs = parsed.timecodeScaleNs;
        if (parsed.durationTicks !== null) durationTicks = parsed.durationTicks;
      }
    }
    offset = dataStart + header.size;
  }

  outcome.seekHeadComplete = REQUIRED_SEEK_HEAD_TARGETS.every((name) =>
    outcome.seekHeadTargets.includes(name),
  );
  if (durationTicks !== null && Number.isFinite(durationTicks) && durationTicks > 0) {
    outcome.durationSeconds = (durationTicks * timecodeScaleNs) / 1_000_000_000;
  }
  return outcome;
}

/**
 * Builds a random-access byte source over a real file (an fd + `readSync` at
 * offsets, so nothing is buffered).
 *
 * @param {string} path
 * @returns {{
 *   size: number,
 *   read: (offset: number, length: number) => Buffer,
 *   close: () => void,
 * }}
 */
export function createFileScanSource(path) {
  const fd = openSync(path, 'r');
  const { size } = fstatSync(fd);
  return {
    size,
    read(offset, length) {
      const wanted = Math.max(0, Math.min(length, size - offset));
      const buffer = Buffer.alloc(wanted);
      if (wanted === 0) return buffer;
      const readBytes = readSync(fd, buffer, 0, wanted, offset);
      return readBytes === wanted ? buffer : buffer.subarray(0, readBytes);
    },
    close() {
      closeSync(fd);
    },
  };
}

/**
 * Convenience wrapper: scans a WebM file on disk and always closes the fd.
 *
 * @param {string} path
 * @returns {ReturnType<typeof scanWebmSeekIndex>}
 */
export function inspectWebmSeekIndex(path) {
  let source = null;
  try {
    source = createFileScanSource(path);
    return scanWebmSeekIndex(source);
  } catch {
    return scanWebmSeekIndex({ read: null, size: 0 });
  } finally {
    if (source) source.close();
  }
}

/** Default `spawnSync` seam (injected in hermetic tests). */
const defaultRun = (command, args, options) => spawnSync(command, args, options);

/** Resolves the Playwright-bundled ffmpeg through the Playwright registry. */
function bundledFfmpegFromRegistry(loadRegistry) {
  try {
    const registry = loadRegistry();
    const executable = registry?.findExecutable?.('ffmpeg');
    if (!executable) return null;
    const resolved = executable.executablePath?.();
    return typeof resolved === 'string' && resolved ? resolved : null;
  } catch {
    // No Playwright, no `ffmpeg` entry, or the browser/ffmpeg download is
    // absent — the caller simply moves on to the next candidate (AC4).
    return null;
  }
}

/**
 * Resolves the ordered list of ffmpeg binaries that may perform the remux.
 *
 * Documented, deterministic order (AC4): `FFMPEG_BIN` → the
 * Playwright-bundled binary → `PATH`. Duplicates are removed, so an
 * `FFMPEG_BIN` that *is* the bundled binary is attempted once.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   exists?: (path: string) => boolean,
 *   loadRegistry?: () => unknown,
 * }} [options]
 * @returns {Array<{ path: string, source: string }>}
 */
export function resolveRemuxCandidates(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const loadRegistry =
    options.loadRegistry ??
    (() => createRequire(import.meta.url)('playwright-core/lib/server/registry/index').registry);

  const candidates = [];
  const push = (path, source) => {
    if (typeof path !== 'string' || !path) return false;
    if (candidates.some((candidate) => candidate.path === path)) return false;
    if (!safeExists(exists, path)) return false;
    candidates.push({ path, source });
    return true;
  };

  push(env?.FFMPEG_BIN, 'FFMPEG_BIN');
  push(bundledFfmpegFromRegistry(loadRegistry), 'playwright-bundled');

  const dirs = String(env?.PATH ?? '')
    .split(':')
    .filter(Boolean);
  for (const dir of dirs) {
    if (push(`${dir}/ffmpeg`, 'PATH')) break;
  }
  return candidates;
}

/** `exists` seam that treats a throwing implementation as "absent". */
function safeExists(exists, path) {
  try {
    return Boolean(exists(path));
  } catch {
    return false;
  }
}

/**
 * Resolves ffprobe — used only to *verify* the remuxed duration exactly as the
 * brief specifies (`-show_entries format=duration`). There is no
 * Playwright-bundled ffprobe, so the order is `FFPROBE_BIN` → `PATH`; when
 * neither resolves, verification falls back to the container's own
 * Info/Duration element (see {@link verifySeekableIndex}).
 *
 * @param {{ env?: NodeJS.ProcessEnv, exists?: (path: string) => boolean }} [options]
 * @returns {string|null}
 */
export function resolveFfprobe(options = {}) {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  if (env?.FFPROBE_BIN && safeExists(exists, env.FFPROBE_BIN)) return env.FFPROBE_BIN;
  for (const dir of String(env?.PATH ?? '')
    .split(':')
    .filter(Boolean)) {
    const candidate = `${dir}/ffprobe`;
    if (safeExists(exists, candidate)) return candidate;
  }
  return null;
}

/**
 * The exact argv used for the seek-index remux (AC2 — `-c copy`, never an
 * encoder). Exported so the hermetic tests can pin it.
 *
 * @param {{ inputPath: string, tempPath: string }} params
 * @returns {string[]}
 */
export function buildRemuxArgs({ inputPath, tempPath }) {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    // Packet-preserving: copy every stream bit for bit (VP9 + Opus), no
    // re-encode and therefore no quality/content change.
    '-c',
    'copy',
    '-f',
    'webm',
    tempPath,
  ];
}

/** The exact argv used to verify `format.duration` (AC1). */
export function buildFfprobeDurationArgs(filePath) {
  return [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    filePath,
  ];
}

/** Parses `ffprobe -of json` output and returns `format.duration` (or null). */
export function parseFfprobeDuration(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? ''));
    const value = parsed?.format?.duration;
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  } catch {
    return null;
  }
}

/** First non-empty stderr line, used for actionable attempt reports. */
function firstLine(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
}

/**
 * Runs one remux attempt into the temp path.
 *
 * @param {{
 *   inputPath: string,
 *   tempPath: string,
 *   ffmpegPath: string,
 *   run?: typeof defaultRun,
 * }} params
 * @returns {{ ok: boolean, args: string[], status: number|null, error: string }}
 */
export function remuxSeekIndex({ inputPath, tempPath, ffmpegPath, run = defaultRun }) {
  const args = buildRemuxArgs({ inputPath, tempPath });
  let result;
  try {
    result = run(ffmpegPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (error) {
    return { ok: false, args, status: null, error: firstLine(error?.message ?? error) };
  }
  const status = typeof result?.status === 'number' ? result.status : null;
  return {
    ok: status === 0,
    args,
    status,
    error: status === 0 ? '' : firstLine(result?.stderr) || `ffmpeg exited with ${status}`,
  };
}

/**
 * Verifies that `filePath` is a seekable WebM (AC1): a finite non-zero
 * duration plus a Cues seek index and a SeekHead referencing Info, Tracks and
 * Cues.
 *
 * Duration comes from `ffprobe -show_entries format=duration` when ffprobe
 * resolves (exactly what the acceptance criterion names); otherwise from the
 * container's own Info/Duration element, which is the same number the
 * player-facing seek bar uses — so verification still runs in the documented
 * zero-ffprobe environment.
 *
 * @param {{
 *   filePath: string,
 *   ffprobePath?: string|null,
 *   run?: typeof defaultRun,
 * }} params
 * @returns {{
 *   seekable: boolean,
 *   durationSeconds: number|null,
 *   durationSource: string,
 *   hasCues: boolean,
 *   hasSeekHead: boolean,
 *   seekHeadTargets: string[],
 *   seekHeadComplete: boolean,
 *   bytes: number,
 *   reason: string,
 * }}
 */
export function verifySeekableIndex({ filePath, ffprobePath = null, run = defaultRun }) {
  const structure = inspectWebmSeekIndex(filePath);
  let durationSeconds = null;
  let durationSource = 'none';

  if (ffprobePath) {
    let probed = null;
    try {
      probed = run(ffprobePath, buildFfprobeDurationArgs(filePath), {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
      });
    } catch {
      // A missing/broken ffprobe is not a verification failure: the container's
      // own Duration element below is authoritative for WebM.
      probed = null;
    }
    if (probed?.status === 0) {
      const parsed = parseFfprobeDuration(probed.stdout);
      if (parsed !== null) {
        durationSeconds = parsed;
        durationSource = 'ffprobe';
      }
    }
  }
  if (durationSeconds === null && structure.durationSeconds !== null) {
    durationSeconds = structure.durationSeconds;
    durationSource = 'ebml';
  }

  let bytes = 0;
  try {
    bytes = statSync(filePath).size;
  } catch {
    bytes = 0;
  }

  const reasons = [];
  if (durationSeconds === null) reasons.push('no finite duration');
  if (!structure.hasCues) reasons.push('no Cues seek index');
  if (!structure.hasSeekHead) reasons.push('no SeekHead');
  else if (!structure.seekHeadComplete) {
    reasons.push(
      `SeekHead does not reference ${REQUIRED_SEEK_HEAD_TARGETS.filter(
        (name) => !structure.seekHeadTargets.includes(name),
      ).join(' + ')}`,
    );
  }

  return {
    seekable: reasons.length === 0,
    durationSeconds,
    durationSource,
    hasCues: structure.hasCues,
    hasSeekHead: structure.hasSeekHead,
    seekHeadTargets: structure.seekHeadTargets,
    seekHeadComplete: structure.seekHeadComplete,
    bytes,
    reason: reasons.join('; '),
  };
}

/**
 * The warning emitted when no ffmpeg could make the clip seekable (AC4): it
 * names the consequence, the fix and how to enable it — and never fails the
 * capture.
 *
 * @param {{ attempts: Array<{ source: string, path: string, error: string }> }} outcome
 * @returns {string}
 */
export function unseekableCaptureWarning({ attempts = [] } = {}) {
  const tried = attempts.length
    ? attempts.map((attempt) => `${attempt.source} (${attempt.path}): ${attempt.error}`).join(' | ')
    : 'no ffmpeg binary was found (FFMPEG_BIN, the Playwright-bundled ffmpeg and PATH were checked)';
  return [
    'clip is NOT seekable — Chromium writes no Duration/Cues/SeekHead, so VLC cannot',
    'fast-forward it. Fix: install a full ffmpeg with VP9 support',
    `(${REMUX_INSTALL_HINTS.join('; ')}) and re-run the capture.`,
    `Attempts: ${tried}`,
  ].join(' ');
}

/**
 * Makes a captured clip seekable in place: remux → verify → rename.
 *
 * The raw capture at `outputPath` is only ever replaced by a **verified**
 * remuxed file, so every failure path (no binary, ffmpeg error, unusable
 * output) leaves the original clip exactly as the capture wrote it (AC4).
 *
 * @param {{
 *   outputPath: string,
 *   env?: NodeJS.ProcessEnv,
 *   exists?: (path: string) => boolean,
 *   loadRegistry?: () => unknown,
 *   run?: typeof defaultRun,
 *   tempPath?: string,
 * }} params
 * @returns {{
 *   attempted: boolean,
 *   ok: boolean,
 *   source: string|null,
 *   ffmpegPath: string|null,
 *   tempPath: string,
 *   bytes: number,
 *   durationSeconds: number|null,
 *   durationSource: string,
 *   hasCues: boolean,
 *   hasSeekHead: boolean,
 *   seekHeadTargets: string[],
 *   attempts: Array<{ source: string, path: string, error: string }>,
 *   warning: string|null,
 * }}
 */
export function makeCaptureSeekable({
  outputPath,
  env = process.env,
  exists = existsSync,
  loadRegistry,
  run = defaultRun,
  tempPath,
} = {}) {
  const temp = typeof tempPath === 'string' && tempPath ? tempPath : remuxTempPathFor(outputPath);
  const base = {
    attempted: false,
    ok: false,
    source: null,
    ffmpegPath: null,
    tempPath: temp,
    bytes: 0,
    durationSeconds: null,
    durationSource: 'none',
    hasCues: false,
    hasSeekHead: false,
    seekHeadTargets: [],
    attempts: [],
    warning: null,
  };

  // Nothing to remux (no clip on disk): never warn, never fail.
  if (typeof outputPath !== 'string' || !outputPath || !safeExists(exists, outputPath)) {
    return base;
  }

  const candidates = resolveRemuxCandidates({ env, exists, loadRegistry });
  if (candidates.length === 0) {
    return {
      ...base,
      attempted: true,
      warning: unseekableCaptureWarning({ attempts: [] }),
    };
  }

  const ffprobePath = resolveFfprobe({ env, exists });
  const attempts = [];
  for (const candidate of candidates) {
    const remux = remuxSeekIndex({
      inputPath: outputPath,
      tempPath: temp,
      ffmpegPath: candidate.path,
      run,
    });
    if (!remux.ok) {
      removeQuietly(temp);
      attempts.push({ source: candidate.source, path: candidate.path, error: remux.error });
      continue;
    }

    const verification = verifySeekableIndex({ filePath: temp, ffprobePath, run });
    if (!verification.seekable) {
      removeQuietly(temp);
      attempts.push({
        source: candidate.source,
        path: candidate.path,
        error: `remux output still unseekable: ${verification.reason}`,
      });
      continue;
    }

    try {
      renameSync(temp, outputPath);
    } catch (error) {
      removeQuietly(temp);
      attempts.push({
        source: candidate.source,
        path: candidate.path,
        error: `rename failed: ${firstLine(error?.message ?? error)}`,
      });
      continue;
    }

    return {
      ...base,
      attempted: true,
      ok: true,
      source: candidate.source,
      ffmpegPath: candidate.path,
      bytes: verification.bytes,
      durationSeconds: verification.durationSeconds,
      durationSource: verification.durationSource,
      hasCues: verification.hasCues,
      hasSeekHead: verification.hasSeekHead,
      seekHeadTargets: verification.seekHeadTargets,
      attempts,
    };
  }

  return {
    ...base,
    attempted: true,
    attempts,
    warning: unseekableCaptureWarning({ attempts }),
  };
}

/** Removes a temp remux artefact without ever throwing. */
function removeQuietly(path) {
  try {
    rmSync(path, { force: true });
  } catch {
    // A leftover temp file is reported by the attempt list; it must never turn
    // a successful capture into a failure.
  }
}

/**
 * The one-line operator report for a completed remux attempt.
 *
 * @param {ReturnType<typeof makeCaptureSeekable>} outcome
 * @returns {{ level: 'info'|'warning', message: string }}
 */
export function describeSeekableOutcome(outcome) {
  if (!outcome || !outcome.attempted) {
    return { level: 'info', message: '' };
  }
  if (outcome.ok) {
    const duration = outcome.durationSeconds === null ? 'n/a' : `${outcome.durationSeconds.toFixed(3)}s`;
    return {
      level: 'info',
      message:
        `Seek index: Duration ${duration} + Cues added `
        + `(${outcome.source} ffmpeg, duration from ${outcome.durationSource}) — `
        + 'the clip can be fast-forwarded.',
    };
  }
  return { level: 'warning', message: `WARNING: ${outcome.warning}` };
}

/**
 * Emits the remux outcome through the capture reporter (both capture paths use
 * this so the message text cannot drift).
 *
 * @param {{ step?: (message: string) => void }|null} reporter
 * @param {ReturnType<typeof makeCaptureSeekable>} outcome
 * @returns {{ level: 'info'|'warning', message: string }}
 */
export function reportSeekableOutcome(reporter, outcome) {
  const described = describeSeekableOutcome(outcome);
  if (described.message && reporter && typeof reporter.step === 'function') {
    reporter.step(described.message);
  }
  return described;
}
