/**
 * Dev recording dataset: parsing, deterministic replay stepping and the
 * human-vs-bot ghost overlay
 * (AH-0MUY08W7Y004GATZ, child 4 of epic AH-0MUY089KR003F8S4).
 *
 * A **recording** is the JSONL written by the telemetry framework's local dev
 * sink (`src/telemetry`): a sequence of `run_header` / `tick` / `event`
 * records, each tagged with `schemaVersion`. This module owns the dev-tooling
 * view of that stream:
 *
 * - {@link parseRecording} — tolerant parse of a JSONL file into one or more
 *   {@link RecordingRun}s, skipping corrupt/unsupported lines rather than
 *   throwing, and capturing the set of schema versions seen.
 * - {@link createRecordingStepper} — a deterministic, clock-free stepper over
 *   one run's ticks (the replay primitive).
 * - {@link buildGhostOverlay} — aligns a human run and a bot run recorded on
 *   the **same seed** and pairs their input + position per tick.
 * - {@link renderGhostSvg} — a dependency-free SVG trajectory overlay of the
 *   two runs, so the comparison is viewable without a browser.
 *
 * It is plain ESM JavaScript (like `inspect-telemetry.mjs`) so the Node CLI
 * tools run without a TypeScript loader; `recording.d.mts` supplies the types
 * used by the test suite.
 *
 * ## Dataset versioning (AC4)
 *
 * The telemetry envelope is versioned per record by `schemaVersion`
 * (`SUPPORTED_TELEMETRY_SCHEMA_VERSIONS`). The tooling additionally exposes
 * {@link RECORDING_DATASET_VERSION}: the version of the *interpretation*
 * (which record kinds this tool understands and how it groups them into
 * runs). Bump it when a tooling change would reinterpret an existing file;
 * the raw schema version is surfaced separately so consumers can migrate.
 *
 * @module scripts/recording
 */

/** Version of this tool's interpretation of a recording (AC4). */
export const RECORDING_DATASET_VERSION = 1;

/** Telemetry envelope schema versions this tool can interpret. */
export const SUPPORTED_TELEMETRY_SCHEMA_VERSIONS = Object.freeze([1]);

/** Telemetry record kinds this tool understands. */
export const RECORDING_RECORD_KINDS = Object.freeze([
  'run_header',
  'tick',
  'event',
]);

/** Tick cadence assumed when a recording does not state one (60 fps). */
export const DEFAULT_TICK_SECONDS = 1 / 60;

/**
 * True when `value` is a record this tool can interpret: a supported
 * `schemaVersion` and a known `kind`. Payloads stay opaque.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSupportedRecordingRecord(value) {
  if (typeof value !== 'object' || value === null) return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (!SUPPORTED_TELEMETRY_SCHEMA_VERSIONS.includes(Number(record.schemaVersion))) {
    return false;
  }
  return RECORDING_RECORD_KINDS.includes(String(record.kind));
}

/**
 * Parses newline-delimited telemetry JSON into per-run recordings.
 *
 * A new `run_header` starts a new {@link RecordingRun}; ticks and events are
 * attributed to the run opened by the most recent header. Lines before the
 * first header are counted in `unattributedLines`. Blank lines are ignored;
 * corrupt or unsupported lines are counted (`skippedLines` /
 * `unsupportedLines`) instead of aborting the parse.
 *
 * @param {unknown} text — the JSONL file contents.
 * @returns {{
 *   datasetVersion: number,
 *   runs: import('./recording.mjs').RecordingRun[],
 *   schemaVersions: number[],
 *   recordCount: number,
 *   skippedLines: number,
 *   unsupportedLines: number,
 *   unattributedLines: number,
 * }}
 */
export function parseRecording(text) {
  /** @type {import('./recording.mjs').RecordingRun[]} */
  const runs = [];
  const schemaVersions = new Set();
  let recordCount = 0;
  let skippedLines = 0;
  let unsupportedLines = 0;
  let unattributedLines = 0;
  /** @type {import('./recording.mjs').RecordingRun | null} */
  let current = null;

  const lines = typeof text === 'string' ? text.split('\n') : [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;

    let decoded;
    try {
      decoded = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }

    if (typeof decoded !== 'object' || decoded === null) {
      skippedLines += 1;
      continue;
    }
    if (typeof decoded.schemaVersion === 'number') {
      schemaVersions.add(decoded.schemaVersion);
    }
    if (!isSupportedRecordingRecord(decoded)) {
      unsupportedLines += 1;
      continue;
    }

    recordCount += 1;
    if (decoded.kind === 'run_header') {
      current = {
        index: runs.length,
        runSeed: Number(decoded.runSeed) >>> 0,
        build: normaliseBuild(decoded.build),
        startedAt: Number.isFinite(Number(decoded.startedAt))
          ? Number(decoded.startedAt)
          : null,
        ticks: [],
        events: [],
      };
      runs.push(current);
      continue;
    }

    if (current === null) {
      unattributedLines += 1;
      continue;
    }

    const tick = Number.isFinite(Number(decoded.tick)) ? Number(decoded.tick) : 0;
    if (decoded.kind === 'tick') {
      current.ticks.push({
        tick,
        state: decoded.state ?? null,
        input: decoded.input ?? null,
      });
    } else {
      current.events.push({
        tick,
        event: typeof decoded.event === 'string' ? decoded.event : 'unknown',
        payload: decoded.payload ?? null,
      });
    }
  }

  for (const run of runs) {
    run.ticks.sort((a, b) => a.tick - b.tick);
    run.events.sort((a, b) => a.tick - b.tick);
  }

  return {
    datasetVersion: RECORDING_DATASET_VERSION,
    runs,
    schemaVersions: Array.from(schemaVersions).sort((a, b) => a - b),
    recordCount,
    skippedLines,
    unsupportedLines,
    unattributedLines,
  };
}

/** Normalises a run-header `build` object. */
function normaliseBuild(build) {
  const source = typeof build === 'object' && build !== null ? build : {};
  return {
    appVersion:
      typeof source.appVersion === 'string' ? source.appVersion : 'unknown',
    commit: typeof source.commit === 'string' ? source.commit : 'unknown',
  };
}

// ── Input model ──────────────────────────────────────────────────────

/**
 * Splits a recorded input into a normalised set of held channels.
 *
 * Handles both control schemes the game records — `'asteroids'`
 * (`forward`/`turnLeft`/`turnRight`) and `'fourDirectional'`
 * (`up`/`down`/`left`/`right`) — and treats `null`/malformed input as no
 * channels.
 *
 * @param {unknown} input
 * @returns {{ scheme: 'asteroids'|'fourDirectional'|null, channels: Record<string, boolean> }}
 */
export function inputChannels(input) {
  if (typeof input !== 'object' || input === null) {
    return { scheme: null, channels: {} };
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const scheme =
    value.scheme === 'asteroids' || Object.prototype.hasOwnProperty.call(value, 'forward')
      ? 'asteroids'
      : 'fourDirectional';
  if (scheme === 'asteroids') {
    return {
      scheme,
      channels: {
        forward: value.forward === true,
        turnLeft: value.turnLeft === true,
        turnRight: value.turnRight === true,
      },
    };
  }
  return {
    scheme,
    channels: {
      up: value.up === true,
      down: value.down === true,
      left: value.left === true,
      right: value.right === true,
    },
  };
}

/**
 * A stable signature of the held input, suitable for change detection and
 * hold grouping. Distinct held-channel combinations produce distinct strings.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function inputSignature(input) {
  const { scheme, channels } = inputChannels(input);
  if (scheme === null) return 'none';
  const active = Object.keys(channels)
    .filter((channel) => channels[channel])
    .sort();
  return `${scheme}:${active.join(',')}`;
}

/** The player position in a recorded tick's state, or `null`. */
export function tickPosition(state) {
  if (typeof state !== 'object' || state === null) return null;
  const player = /** @type {Record<string, unknown>} */ (state).player;
  if (typeof player !== 'object' || player === null) return null;
  const point = /** @type {Record<string, unknown>} */ (player);
  if (!Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    return null;
  }
  return { x: Number(point.x), y: Number(point.y) };
}

/** Euclidean distance between two `{ x, y }` points. */
export function distance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ── Deterministic replay stepping (AC3, AC5) ─────────────────────────

/**
 * Creates a deterministic stepper over one run's ticks.
 *
 * The stepper is clock-free: it advances through the recorded ticks in order
 * and derives elapsed time from the tick number and the injected tick
 * duration, so the same recording always steps identically. It starts
 * **before** the first frame; call {@link RecordingStepper.step} to advance.
 *
 * @param {import('./recording.mjs').RecordingRun} run
 * @param {{ dtSeconds?: number }} [options]
 * @returns {import('./recording.mjs').RecordingStepper}
 */
export function createRecordingStepper(run, options = {}) {
  const ticks = Array.isArray(run?.ticks) ? run.ticks.slice() : [];
  ticks.sort((a, b) => a.tick - b.tick);
  const dtSeconds = normaliseDt(options.dtSeconds);
  const baseTick = ticks.length > 0 ? ticks[0].tick : 0;
  let index = -1;

  const frameAt = (position) => {
    if (position < 0 || position >= ticks.length) return null;
    const entry = ticks[position];
    return {
      index: position,
      tick: entry.tick,
      elapsedSeconds: (entry.tick - baseTick) * dtSeconds,
      state: entry.state,
      input: entry.input,
      position: tickPosition(entry.state),
    };
  };

  return {
    get total() {
      return ticks.length;
    },
    get index() {
      return index;
    },
    get done() {
      return index >= ticks.length - 1;
    },
    get dtSeconds() {
      return dtSeconds;
    },
    current() {
      return frameAt(index);
    },
    step() {
      if (index >= ticks.length - 1) return null;
      index += 1;
      return frameAt(index);
    },
    seek(targetTick) {
      const wanted = Number(targetTick);
      let next = -1;
      for (let i = 0; i < ticks.length; i += 1) {
        if (ticks[i].tick <= wanted) next = i;
        else break;
      }
      index = next;
      return frameAt(index);
    },
    reset() {
      index = -1;
    },
    /** Returns a fresh array of every frame, without moving the cursor. */
    frames() {
      const out = [];
      for (let i = 0; i < ticks.length; i += 1) out.push(frameAt(i));
      return out;
    },
  };
}

/** Normalises a tick duration to a positive finite number. */
function normaliseDt(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_TICK_SECONDS;
  return numeric;
}

// ── Human vs bot ghost overlay (AC3) ─────────────────────────────────

/**
 * Aligns a human run and a bot run recorded on the same seed and pairs their
 * applied input and player position tick-by-tick (AC3).
 *
 * The two runs must share a `runSeed`; otherwise the comparison is
 * meaningless and an `Error` is thrown. Frames are aligned by their recorded
 * `tick` number over the intersection of the two runs, so a sampled or
 * truncated run still aligns correctly.
 *
 * @param {import('./recording.mjs').RecordingRun} humanRun
 * @param {import('./recording.mjs').RecordingRun} botRun
 * @param {{ dtSeconds?: number }} [options]
 * @returns {import('./recording.mjs').GhostOverlay}
 */
export function buildGhostOverlay(humanRun, botRun, options = {}) {
  const humanSeed = Number(humanRun?.runSeed);
  const botSeed = Number(botRun?.runSeed);
  if (!Number.isFinite(humanSeed) || !Number.isFinite(botSeed) || humanSeed !== botSeed) {
    throw new Error(
      `ghost overlay requires the same seed: human=${humanSeed} bot=${botSeed}`,
    );
  }

  const dtSeconds = normaliseDt(options.dtSeconds);
  const humanTicks = Array.isArray(humanRun?.ticks) ? humanRun.ticks : [];
  const botByTick = new Map();
  for (const tick of Array.isArray(botRun?.ticks) ? botRun.ticks : []) {
    if (!botByTick.has(tick.tick)) botByTick.set(tick.tick, tick);
  }

  /** @type {import('./recording.mjs').GhostFrame[]} */
  const frames = [];
  let inputMatchCount = 0;
  let positionSamples = 0;
  let positionDeltaTotal = 0;
  let maxPositionDelta = 0;

  for (const human of humanTicks) {
    const bot = botByTick.get(human.tick);
    if (!bot) continue;
    const humanPosition = tickPosition(human.state);
    const botPosition = tickPosition(bot.state);
    const inputMatch = inputSignature(human.input) === inputSignature(bot.input);
    if (inputMatch) inputMatchCount += 1;

    let positionDelta = null;
    if (humanPosition && botPosition) {
      positionDelta = distance(humanPosition, botPosition);
      positionSamples += 1;
      positionDeltaTotal += positionDelta;
      if (positionDelta > maxPositionDelta) maxPositionDelta = positionDelta;
    }

    frames.push({
      index: frames.length,
      tick: human.tick,
      elapsedSeconds: human.tick * dtSeconds,
      human: { position: humanPosition, input: human.input },
      bot: { position: botPosition, input: bot.input },
      inputMatch,
      positionDelta,
    });
  }

  return {
    runSeed: humanSeed,
    dtSeconds,
    frames,
    stats: {
      frames: frames.length,
      inputMatchCount,
      inputMatchRate: frames.length === 0 ? 0 : inputMatchCount / frames.length,
      positionSamples,
      meanPositionDelta:
        positionSamples === 0 ? 0 : positionDeltaTotal / positionSamples,
      maxPositionDelta,
    },
  };
}

// ── SVG trajectory overlay (AC3) ─────────────────────────────────────

/** Fixed-decimal formatting keeps the produced SVG byte-stable. */
const SVG_NUMBER_FORMAT = 2;

/** Formats a number for an SVG attribute (deterministic, finite). */
function svgNumber(value) {
  return Number(value).toFixed(SVG_NUMBER_FORMAT);
}

/**
 * Renders a ghost overlay as a standalone SVG trajectory plot: the human path
 * in one colour over the playfield, the bot path in another, with start/end
 * markers. Pure and deterministic — no DOM, no browser.
 *
 * @param {import('./recording.mjs').GhostOverlay} overlay
 * @param {{
 *   width?: number,
 *   height?: number,
 *   padding?: number,
 *   humanColour?: string,
 *   botColour?: string,
 *   background?: string,
 *   title?: string,
 * }} [options]
 * @returns {string}
 */
export function renderGhostSvg(overlay, options = {}) {
  const width = positiveOr(options.width, 960);
  const height = positiveOr(options.height, 540);
  const padding = Math.max(0, Number.isFinite(Number(options.padding)) ? Number(options.padding) : 24);
  const humanColour = options.humanColour ?? '#00ffff';
  const botColour = options.botColour ?? '#ff44ff';
  const background = options.background ?? '#0b0b12';
  const title = options.title ?? 'Human vs bot ghost overlay';

  const innerWidth = Math.max(1, width - padding * 2);
  const innerHeight = Math.max(1, height - padding * 2);
  const project = (point) => ({
    x: padding + (Number(point.x) / width) * innerWidth,
    y: padding + (Number(point.y) / height) * innerHeight,
  });

  const frames = Array.isArray(overlay?.frames) ? overlay.frames : [];
  const humanPoints = [];
  const botPoints = [];
  for (const frame of frames) {
    if (frame.human?.position) humanPoints.push(project(frame.human.position));
    if (frame.bot?.position) botPoints.push(project(frame.bot.position));
  }

  const polyline = (points, colour) =>
    points.length === 0
      ? ''
      : `<polyline fill="none" stroke="${colour}" stroke-width="2" points="${points
          .map((point) => `${svgNumber(point.x)},${svgNumber(point.y)}`)
          .join(' ')}" />`;

  const marker = (point, colour) =>
    point
      ? `<circle cx="${svgNumber(point.x)}" cy="${svgNumber(point.y)}" r="4" fill="${colour}" />`
      : '';

  const humanStart = marker(humanPoints[0], humanColour);
  const botStart = marker(botPoints[0], botColour);
  const humanEnd = marker(humanPoints[humanPoints.length - 1], '#ffffff');
  const botEnd = marker(botPoints[botPoints.length - 1], '#ffffff');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">`,
    `  <rect width="${width}" height="${height}" fill="${background}" />`,
    `  <rect x="${svgNumber(padding)}" y="${svgNumber(padding)}" width="${svgNumber(innerWidth)}" height="${svgNumber(innerHeight)}" fill="none" stroke="#2a2a3a" stroke-width="1" />`,
    `  ${polyline(humanPoints, humanColour)}`,
    `  ${polyline(botPoints, botColour)}`,
    `  ${humanStart}${botStart}${humanEnd}${botEnd}`,
    `</svg>`,
  ]
    .filter((line) => line.trim() !== '')
    .join('\n');
}

/** Coerces a positive finite option, else `fallback`. */
function positiveOr(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

/** Minimal XML text escaping for a title/aria label. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
