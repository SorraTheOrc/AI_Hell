/**
 * Dev-only telemetry upload middleware (AH-0MVBMRNAH001B8X4 — parent
 * AH-0MVBHRLY8004BGDN).
 *
 * The server half of the dev-mode auto-upload flow: the game streams each
 * flushed telemetry batch to this endpoint during the run and sends a final
 * part at run end (`src/telemetry/devStream.ts`), or — when no streamer is
 * installed — POSTs the local JSONL sink's whole content at run end
 * (`src/telemetry/devUpload.ts`). This middleware validates it against the
 * existing recording reader (`scripts/recording.mjs`) and stores it under
 * `recordings/session-<timestamp>.jsonl` — mirroring the `configCsvPlugin`
 * pattern and the `record-session.mjs` naming.
 *
 * The plugin is registered only while Vite runs in dev mode
 * (`apply: 'serve'`), so the endpoint never exists for `vite build` /
 * `vite preview` (enforced by `src/telemetry/devModeEnforcement.test.ts`
 * AC3c and the bundle-hygiene gate).
 *
 * ## Handling rules (pinned by `telemetryUploadPlugin.test.ts`)
 *
 * - `POST /api/telemetry/upload` with a JSONL body that contains **at least
 *   one schema-valid telemetry record** (via `parseRecording`) is stored
 *   verbatim and confirmed with a 2xx JSON payload carrying the stored path,
 *   the record count and the run count.
 * - Malformed bodies — unparseable JSONL, unsupported schema versions,
 *   unknown record kinds, or zero schema-valid records — are rejected with a
 *   4xx **before** anything is written, so a rejected upload never touches
 *   `recordings/`.
 * - Bodies larger than {@link DEFAULT_MAX_UPLOAD_BYTES} are rejected with
 *   413 before parsing or writing, whether the size is declared in
 *   `Content-Length` or discovered while streaming the request body.
 * - File names are collision-safe: an upload never overwrites an existing
 *   file; when the timestamped name is occupied a numeric suffix is used.
 * - After a successful store the human evaluation pipeline
 *   (`scripts/evaluate.mjs --human <file> --out <dir>`) is triggered
 *   **asynchronously** as a spawned child process (AH-0MVBMRO27008KRZ0), so
 *   the HTTP response returns immediately and the dev server never blocks on
 *   the evaluation. The existing `npm run record` / `npm run evaluate --
 *   --human` flows are unchanged — the CLI is reused as-is.
 *
 * ## Streaming part protocol (AH-0MW6NI6BW003RJWH, parent AH-0MVJUAADW0033QBD)
 *
 * The same endpoint also accepts **parts**: a request that carries an explicit
 * part marker (see `src/telemetry/devStreamProtocol.ts`) and only the records
 * the client has not had confirmed yet. Rules, all pure functions of the
 * request and the staged file:
 *
 * - Parts are staged **off** the `session-*.jsonl` glob, in
 *   `recordings/parts/<runKey>.jsonl`, so a mid-run session is never mistaken
 *   for a completed recording by `recordings()` helpers or
 *   `scripts/verify-dev-telemetry.mjs`.
 * - Each part appends only the records beyond its claimed cumulative `offset`.
 *   A part whose offset trails the stored count is a retried part whose 2xx was
 *   lost, so its already-stored prefix is dropped (no duplication); a part whose
 *   offset is beyond the stored count is a **gap** and is refused with 409 and
 *   the server's authoritative count, so the client re-syncs.
 * - On `final: true` the staged file is renamed (by storing its content under
 *   the existing collision-safe `session-<stamp>.jsonl` name) and **exactly
 *   one** evaluation is enqueued. A repeated final part for an already
 *   finalised run is answered idempotently with the confirmed count and never
 *   stores or evaluates again.
 * - A request **without** the marker keeps the whole-file behaviour
 *   byte-for-byte: one `session-<stamp>.jsonl` and one evaluation.
 *
 * A run that crashes mid-run leaves only `recordings/parts/<runKey>.jsonl`:
 * valid NDJSON, readable by `scripts/inspect-telemetry.mjs`, but not
 * auto-evaluated (evaluation belongs to complete runs).
 *
 * ## Background evaluation rules (pinned by the same test suite)
 *
 * - Each stored recording enqueues one evaluation whose output lands in a
 *   timestamped directory under `eval-output/uploaded/<session-stamp>/`; the
 *   child's stdout/stderr are appended to `evaluation.log` in that directory.
 * - Evaluations are **serialised** ({@link DEFAULT_MAX_CONCURRENT_EVALUATIONS}),
 *   so a burst of uploads cannot spawn unbounded child processes.
 * - Start, exit code and a completion summary line are logged. A spawn error
 *   or non-zero exit is caught and logged; the dev server is never crashed and
 *   the remaining queued evaluations continue.
 *
 * @module vite/plugins/telemetryUploadPlugin
 */

import { spawn as spawnChildProcess } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

import {
  SUPPORTED_TELEMETRY_SCHEMA_VERSIONS,
  parseRecording,
} from '../../scripts/recording.mjs';
import {
  applyPartRecords,
  parsePartRequest,
  splitNdjsonLines,
  type TelemetryPartRequest,
} from '../../src/telemetry/devStreamProtocol';

/** Endpoint the game-side uploader posts to (`src/telemetry/devUpload.ts`). */
export const TELEMETRY_UPLOAD_PATH = '/api/telemetry/upload';

/** Directory (under the plugin root) recordings are stored in. */
export const RECORDINGS_DIR = 'recordings';

/**
 * Subdirectory of {@link RECORDINGS_DIR} that streaming parts are staged in
 * (deliberately outside the `session-*.jsonl` glob that marks completed
 * recordings).
 */
export const PARTS_DIR = 'parts';

/**
 * How many finalised run keys the middleware remembers.
 *
 * A repeated final part for a remembered run is answered idempotently (same
 * confirmed count, no second store, no second evaluation). Bounded so a long
 * dev session cannot grow the map without limit.
 */
export const MAX_REMEMBERED_RUNS = 256;

/** Upper bound for an accepted upload body. 16 MiB covers the multi-megabyte
 * local sink content a long dev session accumulates; larger payloads are
 * almost certainly not the real sink and are rejected before parsing. */
export const DEFAULT_MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Collision-safety attempts before giving up on a unique file name. */
const MAX_NAME_ATTEMPTS = 100;

/** Timestamped per-recording output roots live under this directory. */
export const EVALUATION_OUTPUT_DIR = 'eval-output/uploaded';

/** File name of the per-evaluation log inside its output directory. */
export const EVALUATION_LOG_FILE = 'evaluation.log';

/** Evaluations run one at a time by default (bounded child processes). */
export const DEFAULT_MAX_CONCURRENT_EVALUATIONS = 1;

/** Longest completion-summary line echoed from the evaluation log. */
const MAX_SUMMARY_LENGTH = 160;

/** One queued human evaluation run. */
export interface EvaluationJob {
  /** Absolute path to the stored recording passed to `--human`. */
  readonly recordingPath: string;
  /** Absolute output directory passed to `--out`. */
  readonly outputDir: string;
  /** File the child's stdout/stderr is appended to. */
  readonly logPath: string;
}

/** The child-process surface the queue needs (a subset of `ChildProcess`). */
export interface EvaluationChildProcess {
  on(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** Arguments the queue hands to the injected spawn implementation. */
export interface EvaluationSpawnRequest {
  /** The Node binary used to run the evaluation CLI. */
  readonly command: string;
  /** CLI arguments (`<script> --human <file> --out <dir>`). */
  readonly args: readonly string[];
  /** Working directory the child runs in. */
  readonly cwd: string;
  /** File the child's stdout/stderr is appended to (created if absent). */
  readonly logPath: string;
}

/** Injectable spawn dependency (tests inject a spy; default is real spawn). */
export type SpawnEvaluation = (
  request: EvaluationSpawnRequest,
) => EvaluationChildProcess;

/** Default spawn: detached child whose output is appended to `logPath`. */
export const defaultSpawnEvaluation: SpawnEvaluation = (request) => {
  mkdirSync(dirname(request.logPath), { recursive: true });
  const logFd = openSync(request.logPath, 'a');
  try {
    const stdio: Array<'ignore' | number> = ['ignore', logFd, logFd];
    const child = spawnChildProcess(request.command, [...request.args], {
      cwd: request.cwd,
      detached: true,
      stdio,
    });
    // Let the dev server exit without waiting on the evaluation.
    child.unref();
    return child as unknown as EvaluationChildProcess;
  } finally {
    closeSync(logFd);
  }
};

/** Default lifecycle logger (dev-server console). */
const defaultEvaluationLog = (message: string): void => {
  console.info(`[telemetry-evaluation] ${message}`);
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the last non-empty line of an evaluation log as its summary.
 * Best-effort: a missing/unreadable log yields `null` (never throws).
 */
export function readEvaluationSummary(logPath: string): string | null {
  try {
    const lines = readFileSync(logPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const last = lines[lines.length - 1];
    if (!last) return null;
    return last.length > MAX_SUMMARY_LENGTH
      ? `${last.slice(0, MAX_SUMMARY_LENGTH)}…`
      : last;
  } catch {
    return null;
  }
}

export interface EvaluationQueueOptions {
  /** Project root the evaluation runs against (child cwd). */
  readonly root: string;
  /** Absolute path to the evaluation CLI script. */
  readonly scriptPath: string;
  /** Spawn implementation (injected for tests). */
  readonly spawnEvaluation: SpawnEvaluation;
  /** Maximum concurrent child processes (clamped to at least 1). */
  readonly maxConcurrent?: number;
  /** Lifecycle logger. */
  readonly log?: (message: string) => void;
}

/**
 * Serialises background evaluations and logs their lifecycle.
 *
 * Enqueuing a job never blocks: it starts immediately when a slot is free,
 * otherwise it waits in FIFO order. A spawn error or non-zero exit is logged
 * and the queue moves on to the next job — a failed evaluation can never take
 * down the dev server or strand the queue.
 */
export class EvaluationQueue {
  private readonly root: string;
  private readonly scriptPath: string;
  private readonly spawnEvaluation: SpawnEvaluation;
  private readonly maxConcurrent: number;
  private readonly log: (message: string) => void;
  private readonly pending: EvaluationJob[] = [];
  private readonly idleWaiters: Array<() => void> = [];
  private active = 0;
  private lastFailure: string | null = null;

  constructor(options: EvaluationQueueOptions) {
    this.root = options.root;
    this.scriptPath = options.scriptPath;
    this.spawnEvaluation = options.spawnEvaluation;
    this.maxConcurrent = Math.max(1, Math.trunc(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_EVALUATIONS));
    this.log = options.log ?? defaultEvaluationLog;
  }

  /** Number of child processes currently running. */
  get activeCount(): number {
    return this.active;
  }

  /** Number of jobs waiting for a slot. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** The most recent failure message, if any. */
  get lastError(): string | null {
    return this.lastFailure;
  }

  /** Adds a job and starts it when a concurrency slot is free. */
  enqueue(job: EvaluationJob): void {
    this.pending.push(job);
    this.startNext();
  }

  /** Resolves once every queued and active evaluation has settled. */
  whenIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolveIdle) => {
      this.idleWaiters.push(resolveIdle);
    });
  }

  private startNext(): void {
    while (this.active < this.maxConcurrent && this.pending.length > 0) {
      const job = this.pending.shift();
      if (job) this.run(job);
    }
  }

  private run(job: EvaluationJob): void {
    this.active += 1;
    let settled = false;
    const settle = (message: string, failed: boolean): void => {
      if (settled) return;
      settled = true;
      if (failed) this.lastFailure = message;
      this.log(message);
      this.active -= 1;
      this.startNext();
      this.resolveIdleIfIdle();
    };

    this.log(
      `evaluation started: ${job.recordingPath} → ${job.outputDir} (log: ${job.logPath})`,
    );

    let child: EvaluationChildProcess;
    try {
      child = this.spawnEvaluation({
        command: process.execPath,
        args: [
          this.scriptPath,
          '--human',
          job.recordingPath,
          '--out',
          job.outputDir,
        ],
        cwd: this.root,
        logPath: job.logPath,
      });
    } catch (error) {
      settle(
        `evaluation failed to spawn for ${job.recordingPath}: ${describeError(error)}`,
        true,
      );
      return;
    }

    child.on('error', (error) => {
      settle(
        `evaluation failed for ${job.recordingPath}: ${describeError(error)}`,
        true,
      );
    });

    child.on('exit', (code, signal) => {
      const succeeded = code === 0;
      let message = succeeded
        ? `evaluation finished for ${job.recordingPath}: exit code 0`
        : `evaluation failed for ${job.recordingPath}: exit code ${code === null ? 'null' : code}`;
      if (!succeeded && signal) message += ` (signal ${signal})`;
      if (succeeded) {
        const summary = readEvaluationSummary(job.logPath);
        if (summary) message += ` — ${summary}`;
      }
      settle(message, !succeeded);
    });
  }

  private resolveIdleIfIdle(): void {
    if (this.active !== 0 || this.pending.length !== 0) return;
    for (const waiter of this.idleWaiters.splice(0)) waiter();
  }
}

export interface TelemetryUploadPluginOptions {
  /** Project root the `recordings/` directory resolves against.
   * Defaults to `process.cwd()`. */
  root?: string;
  /** Maximum accepted request body size in bytes
   * (defaults to {@link DEFAULT_MAX_UPLOAD_BYTES}). */
  maxBytes?: number;
  /** Injected evaluation spawn (tests); defaults to
   * {@link defaultSpawnEvaluation}. */
  spawnEvaluation?: SpawnEvaluation;
  /** Maximum concurrent evaluations (default
   * {@link DEFAULT_MAX_CONCURRENT_EVALUATIONS} — serialised). */
  maxConcurrentEvaluations?: number;
  /** Lifecycle logger for background evaluations. */
  log?: (message: string) => void;
}

export type TelemetryUploadValidation =
  | {
      readonly ok: true;
      readonly recordCount: number;
      readonly runCount: number;
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validates an upload body against the recording reader's semantics.
 *
 * The body must contain at least one schema-valid telemetry record
 * (a supported `schemaVersion` and a known record kind per
 * `scripts/recording.mjs`). Any unparseable line, unsupported schema
 * version, or unrecognised record kind also rejects the whole body: a
 * malformed upload is never stored. The validator is a pure function of the
 * text, so it is directly unit-testable.
 *
 * @param text - The uploaded JSONL body.
 * @returns record count (per-line valid records) and run count when valid,
 *   or the human-readable errors when rejected.
 */
export function validateTelemetryUpload(text: string): TelemetryUploadValidation {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, errors: ['Upload body is empty'] };
  }
  const parsed = parseRecording(text);
  const errors: string[] = [];
  const unsupportedVersions = parsed.schemaVersions.filter(
    (version) => !SUPPORTED_TELEMETRY_SCHEMA_VERSIONS.includes(version),
  );
  if (unsupportedVersions.length > 0) {
    errors.push(
      `Unsupported telemetry schema version(s): ${unsupportedVersions.join(
        ', ',
      )}`,
    );
  }
  if (parsed.skippedLines > 0) {
    errors.push(`${parsed.skippedLines} line(s) were not valid JSON`);
  }
  if (parsed.unsupportedLines > 0) {
    errors.push(
      `${parsed.unsupportedLines} line(s) were not supported telemetry records`,
    );
  }
  if (parsed.recordCount === 0) {
    errors.push('No schema-valid telemetry records found');
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, recordCount: parsed.recordCount, runCount: parsed.runs.length };
}

export type RequestBodyResult =
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly bytes: number };

/**
 * Reads a request body, rejecting it (413) as soon as it exceeds `maxBytes`.
 *
 * A `Content-Length` header larger than the bound fails immediately without
 * buffering; a streaming body that grows past the bound mid-flight fails the
 * moment the limit is crossed. The result is a discriminated union so the
 * caller can distinguish a rejected size from a readable body without
 * exceptions.
 *
 * @param req - The HTTP request whose body is being read.
 * @param maxBytes - The size limit in bytes.
 */
export function readRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<RequestBodyResult> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      // Give the client somewhere to write; the response is sent immediately.
      req.resume();
      resolve({ ok: false, bytes: declared });
      return;
    }

    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (result: RequestBodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        finish({ ok: false, bytes });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err: unknown) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/** Allocates the next free `session-<stamp>.jsonl` name (collision-safe). */
function storeRecording(recordingsDir: string, body: string): string {
  mkdirSync(recordingsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt += 1) {
    const fileName =
      attempt === 1
        ? `session-${stamp}.jsonl`
        : `session-${stamp}-${attempt}.jsonl`;
    try {
      // `wx` fails if the name is taken, so a concurrent upload can never
      // overwrite an existing recording.
      writeFileSync(join(recordingsDir, fileName), body, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return fileName;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(
    `Could not allocate a unique recording file name in ${recordingsDir}`,
  );
}

/**
 * Staged-part bookkeeping for one dev server (AH-0MW6NI6BW003RJWH).
 *
 * Holds the bounded memory of finalised runs: a repeated final part for a run
 * that is already stored is answered with the run's confirmed count and never
 * stores or evaluates a second time, which is what makes "exactly one
 * evaluation per run" hold even when a 2xx was lost and the client retried.
 */
export class PartStaging {
  private readonly finalised = new Map<string, number>();

  /** Absolute path of the run's staged part file. */
  static stagedPath(root: string, runKey: string): string {
    return join(root, RECORDINGS_DIR, PARTS_DIR, `${runKey}.jsonl`);
  }

  /** The confirmed count of an already-finalised run, if remembered. */
  finalisedCount(runKey: string): number | undefined {
    return this.finalised.get(runKey);
  }

  /** Remembers a finalised run, evicting the oldest entry past the bound. */
  rememberFinalised(runKey: string, confirmedCount: number): void {
    this.finalised.delete(runKey);
    this.finalised.set(runKey, confirmedCount);
    while (this.finalised.size > MAX_REMEMBERED_RUNS) {
      const oldest = this.finalised.keys().next().value;
      if (oldest === undefined) break;
      this.finalised.delete(oldest);
    }
  }

  /** The records already staged for the run (empty when nothing is staged). */
  readStaged(root: string, runKey: string): string[] {
    try {
      return splitNdjsonLines(
        readFileSync(PartStaging.stagedPath(root, runKey), 'utf8'),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Replaces the run's staged file with the merged records. */
  writeStaged(root: string, runKey: string, lines: readonly string[]): void {
    const stagedPath = PartStaging.stagedPath(root, runKey);
    mkdirSync(dirname(stagedPath), { recursive: true });
    writeFileSync(stagedPath, `${lines.join('\n')}\n`, 'utf8');
  }

  /** Removes the run's staged file once the run is finalised. */
  removeStaged(root: string, runKey: string): void {
    rmSync(PartStaging.stagedPath(root, runKey), { force: true });
  }
}

/** Enqueues one background evaluation for a just-stored recording. */
function enqueueEvaluation(
  root: string,
  evaluationQueue: EvaluationQueue,
  log: (message: string) => void,
  fileName: string,
): void {
  // Fire-and-forget: enqueue first, respond after — the spawn itself is
  // non-blocking and never awaited, so the game gets its 2xx immediately.
  // A failure here must never fail the upload, so it is caught and logged.
  try {
    const runName = basename(fileName, '.jsonl');
    const outputDir = join(root, EVALUATION_OUTPUT_DIR, runName);
    evaluationQueue.enqueue({
      recordingPath: join(root, RECORDINGS_DIR, fileName),
      outputDir,
      logPath: join(outputDir, EVALUATION_LOG_FILE),
    });
  } catch (err) {
    log(
      `evaluation enqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Everything a part or whole-file request needs to act. */
interface UploadContext {
  readonly root: string;
  readonly maxBytes: number;
  readonly evaluationQueue: EvaluationQueue;
  readonly staging: PartStaging;
  readonly log: (message: string) => void;
}

/**
 * Handles one streamed part: stage the unconfirmed records, and on the final
 * part store the run as one session file and enqueue exactly one evaluation.
 */
function handlePart(
  context: UploadContext,
  part: TelemetryPartRequest,
  body: string,
  res: ServerResponse,
): void {
  const { root, evaluationQueue, staging, log } = context;

  const alreadyFinalised = staging.finalisedCount(part.runKey);
  if (alreadyFinalised !== undefined) {
    // A retried/duplicated part for a finalised run: report the
    // server-authoritative count so the client's watermark converges, and
    // never store or evaluate again.
    sendJson(res, 200, {
      ok: true,
      runKey: part.runKey,
      confirmedCount: alreadyFinalised,
      appendedCount: 0,
      finalised: true,
    });
    return;
  }

  const partLines = splitNdjsonLines(body);
  // A finalisation-only part carries no records; every part that does carry
  // records must be valid NDJSON of schema-valid telemetry, so a malformed
  // part is never staged.
  if (partLines.length > 0) {
    const validation = validateTelemetryUpload(body);
    if (!validation.ok) {
      sendJson(res, 400, { ok: false, errors: validation.errors });
      return;
    }
  }

  const applied = applyPartRecords(
    staging.readStaged(root, part.runKey),
    partLines,
    part.offset,
  );
  if (!applied.ok) {
    sendJson(res, 409, {
      ok: false,
      runKey: part.runKey,
      confirmedCount: applied.confirmedCount,
      errors: [
        `Part offset ${part.offset} is beyond the ${applied.confirmedCount} record(s) already stored for run ${part.runKey}`,
      ],
    });
    return;
  }

  staging.writeStaged(root, part.runKey, applied.lines);

  if (!part.final) {
    sendJson(res, 200, {
      ok: true,
      runKey: part.runKey,
      confirmedCount: applied.confirmedCount,
      appendedCount: applied.appendedCount,
      finalised: false,
    });
    return;
  }

  // Finalise: the run becomes one completed recording, exactly as an unmarked
  // whole-file upload would have produced, and one evaluation is enqueued. A
  // run with no staged records is refused rather than stored as an unusable
  // (and un-evaluable) empty recording.
  if (applied.lines.length === 0) {
    sendJson(res, 400, {
      ok: false,
      runKey: part.runKey,
      confirmedCount: applied.confirmedCount,
      errors: [`No records were staged for run ${part.runKey}`],
    });
    return;
  }
  const fileName = storeRecording(
    join(root, RECORDINGS_DIR),
    `${applied.lines.join('\n')}\n`,
  );
  staging.removeStaged(root, part.runKey);
  staging.rememberFinalised(part.runKey, applied.confirmedCount);
  enqueueEvaluation(root, evaluationQueue, log, fileName);
  sendJson(res, 200, {
    ok: true,
    runKey: part.runKey,
    confirmedCount: applied.confirmedCount,
    appendedCount: applied.appendedCount,
    finalised: true,
    storedPath: `${RECORDINGS_DIR}/${fileName}`,
  });
}

function handleUpload(
  context: UploadContext,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const { root, maxBytes, evaluationQueue, log } = context;
  readRequestBody(req, maxBytes)
    .then((result) => {
      if (!result.ok) {
        sendJson(res, 413, {
          ok: false,
          errors: [`Upload too large: ${result.bytes} bytes (max ${maxBytes} bytes)`],
        });
        return;
      }
      const discrimination = parsePartRequest({
        headers: req.headers,
        url: req.url ?? '',
      });
      if (discrimination.kind === 'invalid') {
        sendJson(res, 400, { ok: false, errors: discrimination.errors });
        return;
      }
      if (discrimination.kind === 'part') {
        handlePart(context, discrimination.part, result.body, res);
        return;
      }

      const validation = validateTelemetryUpload(result.body);
      if (!validation.ok) {
        sendJson(res, 400, { ok: false, errors: validation.errors });
        return;
      }
      const recordingsDir = join(root, RECORDINGS_DIR);
      const fileName = storeRecording(recordingsDir, result.body);
      const storedPath = `${RECORDINGS_DIR}/${fileName}`;
      enqueueEvaluation(root, evaluationQueue, log, fileName);
      sendJson(res, 200, {
        ok: true,
        storedPath,
        recordCount: validation.recordCount,
        runCount: validation.runCount,
      });
    })
    .catch((err: unknown) => {
      sendJson(res, 500, {
        ok: false,
        errors: [
          err instanceof Error ? err.message : 'Upload request failed',
        ],
      });
    });
}

function isDevServer(server: ViteDevServer): boolean {
  const command = server.config?.command;
  if (command && command !== 'serve') return false;
  const mode = server.config?.mode;
  if (mode === 'production') return false;
  return true;
}

/**
 * Create the dev-only telemetry upload plugin.
 *
 * @param options.root — project root (defaults to `process.cwd()`).
 * @param options.maxBytes — upload body size limit
 *   (defaults to {@link DEFAULT_MAX_UPLOAD_BYTES}).
 * @param options.spawnEvaluation — injectable evaluation spawn (tests);
 *   defaults to {@link defaultSpawnEvaluation}.
 * @param options.maxConcurrentEvaluations — concurrent evaluation cap.
 * @param options.log — background-evaluation lifecycle logger.
 */
export function telemetryUploadPlugin(
  options: TelemetryUploadPluginOptions = {},
): Plugin {
  const root = options.root ?? process.cwd();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const log = options.log ?? defaultEvaluationLog;
  const evaluationQueue = new EvaluationQueue({
    root,
    scriptPath: resolve(root, 'scripts', 'evaluate.mjs'),
    spawnEvaluation: options.spawnEvaluation ?? defaultSpawnEvaluation,
    maxConcurrent: options.maxConcurrentEvaluations,
    log,
  });
  const context: UploadContext = {
    root,
    maxBytes,
    evaluationQueue,
    staging: new PartStaging(),
    log,
  };

  return {
    name: 'ai-hell:telemetry-upload',
    // Only applies to the dev server (`vite`), never `vite build` — the
    // endpoint must be unreachable outside dev mode.
    apply: 'serve',
    configureServer(server) {
      if (!isDevServer(server)) return;
      server.middlewares.use((req, res, next) => {
        const [path] = (req.url ?? '').split('?');
        if (path !== TELEMETRY_UPLOAD_PATH) {
          next();
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, {
            ok: false,
            errors: [`Method not allowed: ${req.method}`],
          });
          return;
        }
        handleUpload(context, req, res);
      });
    },
  };
}

export default telemetryUploadPlugin;
