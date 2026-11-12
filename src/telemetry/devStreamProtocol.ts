/**
 * Dev telemetry part-protocol contract (AH-0MW6NFRQR0062D90, parent
 * AH-0MVJUAADW0033QBD).
 *
 * The exactly-once rules shared by the dev streamer (client) and the dev
 * upload middleware (server), written as **pure functions** so the ordering,
 * dedupe and loss-bound invariants are pinned by hermetic tests *before* the
 * streaming wiring lands (children 2–3). Nothing here performs I/O: no
 * `fetch`, no filesystem, no middleware, no clock. The only inputs are the
 * values a caller already holds.
 *
 * ## The protocol in one paragraph
 *
 * Every run has a deterministic, run-scoped **run key**
 * ({@link deriveRunKey}). Every flushed batch becomes one **part**: a request
 * that claims a **cumulative offset** — the number of records the client
 * believed the server had already confirmed when it built the part — and
 * carries only the records beyond that offset ({@link nextPartRange}). The
 * server is authoritative: it appends only records beyond its own stored
 * count ({@link applyPartRecords}), so a retried part whose 2xx was lost is
 * deduped instead of duplicated, and it rejects a part whose offset is beyond
 * its stored count as a **gap** so the client can re-sync from the returned
 * count.
 *
 * ## Wire shape
 *
 * Parts reuse the existing dev upload endpoint (so the dev
 * tooling keeps observing uploads and the production bundle marker stays
 * valid) and are discriminated by an **explicit marker** — the
 * {@link PART_MARKER_HEADER} header or the `?part=1` query flag — with the
 * framing fields carried alongside ({@link parsePartRequest}). A request
 * without the marker keeps the whole-file behaviour byte-for-byte, so the
 * existing run-end upload is unchanged.
 *
 * ## Module boundaries
 *
 * Deliberately **not** re-exported from `src/telemetry/index.ts`: importing
 * the barrel must not drag the dev protocol's strings into the production
 * bundle (the bundle-hygiene gate forbids dev-only markers in `dist/`, see
 * `scripts/check-bundle-hygiene.mjs`). The dev-only wiring modules import this
 * file directly.
 *
 * Complementary helpers live with their owners, not here: the JSONL sink
 * formats a batch (`linesToNdjson` in `./sinks`) and {@link splitNdjsonLines}
 * is its inverse, so the pair round-trips.
 *
 * @module src/telemetry/devStreamProtocol
 */

/** Header carrying the explicit part marker (value `1`). */
export const PART_MARKER_HEADER = 'x-telemetry-part';

/** Query flag equivalent of {@link PART_MARKER_HEADER} (`?part=1`). */
export const PART_MARKER_QUERY = 'part';

/** Header carrying the run key. */
export const PART_RUN_KEY_HEADER = 'x-telemetry-run-key';

/** Query parameter equivalent of {@link PART_RUN_KEY_HEADER}. */
export const PART_RUN_KEY_QUERY = 'runKey';

/** Header carrying the cumulative offset (records already confirmed). */
export const PART_OFFSET_HEADER = 'x-telemetry-offset';

/** Query parameter equivalent of {@link PART_OFFSET_HEADER}. */
export const PART_OFFSET_QUERY = 'offset';

/** Header marking the run's last part. */
export const PART_FINAL_HEADER = 'x-telemetry-final';

/** Query parameter equivalent of {@link PART_FINAL_HEADER}. */
export const PART_FINAL_QUERY = 'final';

/** Value that switches a flag on (`1`, `true`, `yes`, `on`). */
export const PART_FLAG_ON = ['1', 'true', 'yes', 'on'] as const;

/** Value that switches a flag off (`0`, `false`, `no`, `off`). */
export const PART_FLAG_OFF = ['0', 'false', 'no', 'off'] as const;

/**
 * Longest accepted run key, in characters.
 *
 * A run key becomes one path segment (`recordings/parts/<runKey>.jsonl`), so
 * it is bounded and character-restricted rather than free text.
 */
export const MAX_RUN_KEY_LENGTH = 128;

/** A run key must be a safe, single path segment. */
const RUN_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One part request's framing fields, as the server reads them. */
export interface TelemetryPartRequest {
  /** Run-scoped key the records belong to ({@link deriveRunKey}). */
  readonly runKey: string;
  /** Records the client believed were already confirmed by the server. */
  readonly offset: number;
  /** `true` on the run's last part: the server finalises the run. */
  readonly final: boolean;
}

/**
 * How a request to the upload endpoint is discriminated.
 *
 * `whole-file` is the pre-existing contract (one body = one whole recording),
 * `part` is the streaming contract, and `invalid` is a request that *claimed*
 * to be a part but cannot be read — the middleware answers 4xx rather than
 * silently degrading to the whole-file path (a degraded part would be stored
 * as a complete recording and enqueue a stray evaluation).
 */
export type PartRequestDiscrimination =
  | { readonly kind: 'whole-file' }
  | { readonly kind: 'part'; readonly part: TelemetryPartRequest }
  | { readonly kind: 'invalid'; readonly errors: readonly string[] };

/** The request surface the marker parser reads (headers + query string). */
export interface PartRequestInput {
  /** Request headers; names are matched case-insensitively. */
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Request URL, including its query string (`?part=1&offset=64`). */
  readonly url?: string;
}

/** The records one part carries, and the offset it claims. */
export interface PartRange {
  /** Cumulative offset the part claims (records already confirmed). */
  readonly offset: number;
  /** The unconfirmed delta: never a confirmed record, never a skipped one. */
  readonly lines: readonly string[];
  /** Cumulative record count once this part is stored (`offset + lines`). */
  readonly confirmedCount: number;
  /** `true` when there is nothing to send (the offset is already current). */
  readonly empty: boolean;
}

/**
 * Window limits for {@link nextPartRange}: the largest prefix of the pending
 * records whose `linesToNdjson` body stays within a byte budget and a record
 * ceiling (AH-0MWDGQ0PB000YZ9N).
 *
 * The byte budget is measured on the same unit as the CDP upload cap (UTF-8
 * bytes) so a window is always well under the message cap the part must fit.
 */
export interface PartWindowLimits {
  /** Ceiling on the window's NDJSON body, in UTF-8 bytes. */
  readonly maxBytes: number;
  /** Ceiling on the window's record count. */
  readonly maxRecords: number;
}

/** Result of the server-side append rule. */
export type ApplyPartResult =
  | {
      /** The append succeeded (possibly appending nothing). */
      readonly ok: true;
      /** The stored records after the append; the input is never mutated. */
      readonly lines: readonly string[];
      /** Cumulative stored count after the append. */
      readonly confirmedCount: number;
      /** Records this part actually contributed (deduped prefix excluded). */
      readonly appendedCount: number;
    }
  | {
      /** The part's offset is beyond the stored count: a gap. */
      readonly ok: false;
      /** Why the part was refused (only gaps are refusable). */
      readonly reason: 'gap';
      /** The server's authoritative count, for the client to re-sync to. */
      readonly confirmedCount: number;
    };

/**
 * The deterministic, run-scoped run key: `<startedAt>-<runSeed>`
 * (Assumption A2).
 *
 * Both inputs are already known at `startRun`, so two runs of the same build
 * never share a key while a repeated call with the same inputs is stable —
 * which is what the client's retry path and the server's staged-file name rely
 * on. Non-finite inputs are refused rather than turned into a `NaN` key that
 * could not name a file.
 *
 * @param startedAt - The run's start timestamp (epoch ms).
 * @param runSeed - The run's RNG seed.
 * @throws RangeError when either input is not a finite number.
 */
export function deriveRunKey(startedAt: number, runSeed: number): string {
  if (!Number.isFinite(startedAt) || !Number.isFinite(runSeed)) {
    throw new RangeError(
      `deriveRunKey needs finite numbers, received startedAt=${startedAt} runSeed=${runSeed}`,
    );
  }
  return `${Math.trunc(startedAt)}-${Math.trunc(runSeed)}`;
}

/**
 * True when `runKey` is safe to use as one path segment for the staged part
 * file (`recordings/parts/<runKey>.jsonl`).
 *
 * Rejects path separators, traversal, control characters, an empty key and
 * anything over {@link MAX_RUN_KEY_LENGTH}, so a hostile or buggy client
 * cannot escape the parts directory.
 *
 * @param runKey - The candidate run key.
 */
export function isValidRunKey(runKey: string): boolean {
  return (
    runKey.length > 0 &&
    runKey.length <= MAX_RUN_KEY_LENGTH &&
    RUN_KEY_PATTERN.test(runKey)
  );
}

/**
 * Splits NDJSON text into its record lines, dropping blank lines (which are
 * separators, never records). The inverse of the sink's `linesToNdjson`, so
 * `splitNdjsonLines(linesToNdjson(lines))` returns `lines`.
 *
 * @param ndjson - Newline-delimited JSON text, with or without a trailing
 *   newline (`''` when empty).
 */
export function splitNdjsonLines(ndjson: string): string[] {
  return normaliseLines(ndjson.split('\n'));
}

/** Trims record lines and drops blanks, so every consumer indexes records. */
function normaliseLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * True when `line` is blank (empty or whitespace-only).
 *
 * Deliberately cheap: it bails on the first non-whitespace character, which
 * is the first character of every real record line (JSON object lines start
 * with `{`), so the windowed path skips separators without paying a full
 * `trim()` on every buffered line.
 */
function isBlankLine(line: string): boolean {
  for (let index = 0; index < line.length; index += 1) {
    const code = line.charCodeAt(index);
    if (
      code !== 0x09 && // \t
      code !== 0x0a && // \n
      code !== 0x0b && // \v
      code !== 0x0c && // \f
      code !== 0x0d && // \r
      code !== 0x20 && // space
      code !== 0x85 && // NEL
      code !== 0xa0 // NBSP
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The part a client should send next: the records beyond its confirmed count,
 * optionally bounded to one window (AH-0MWDGQ0PB000YZ9N).
 *
 * Never includes a record the server already confirmed and never skips a
 * buffered record, so consecutive parts tile the buffer exactly. The caller
 * owns the `final` flag; an empty range at the end of a run is exactly what a
 * finalisation-only part needs.
 *
 * With `limits` the returned range is the **largest prefix** of the pending
 * records whose `linesToNdjson` body is `≤ limits.maxBytes` **and** whose
 * length is `≤ limits.maxRecords`; the `offset`/`confirmedCount`/`empty`
 * fields keep today's semantics. Without `limits` the whole pending range is
 * returned unchanged. A window is therefore bounded by construction: a
 * multi-hundred-MiB backlog can never be handed to `linesToNdjson`'s
 * `Array.join` in one piece (and a single oversized line is still returned,
 * so a window is never empty while records remain pending).
 *
 * @param confirmedRecordCount - Records already confirmed by the server.
 * @param bufferedLines - The run's buffered record lines (the sink buffer,
 *   split with {@link splitNdjsonLines} or read line by line).
 * @param limits - Optional byte budget + record ceiling for one window.
 */
export function nextPartRange(
  confirmedRecordCount: number,
  bufferedLines: readonly string[],
  limits?: PartWindowLimits,
): PartRange {
  // An unusable watermark restarts from the beginning: re-sending is safe
  // because the server dedupes the already-stored prefix.
  const offset = Number.isFinite(confirmedRecordCount)
    ? Math.max(0, Math.trunc(confirmedRecordCount))
    : 0;
  if (!limits) {
    const records = normaliseLines(bufferedLines);
    const lines = offset >= records.length ? [] : records.slice(offset);
    return {
      offset,
      lines,
      confirmedCount: offset + lines.length,
      empty: lines.length === 0,
    };
  }
  // Windowed path: walk the raw lines once, skipping blank separators with a
  // cheap check and trimming only the (few) lines that land in the window.
  // Re-trimming the whole buffer per call would make a multi-hundred-MiB
  // backlog un-windowable in practice (AH-0MWDGQ0PB000YZ9N).
  const lines: string[] = [];
  let bodyBytes = 0;
  let recordIndex = 0;
  for (const raw of bufferedLines) {
    if (isBlankLine(raw)) continue;
    if (recordIndex < offset) {
      recordIndex += 1;
      continue;
    }
    if (lines.length >= limits.maxRecords) break;
    const line = raw.trim();
    // One line contributes its own bytes plus the separator/trailing newline
    // `linesToNdjson` emits — the exact body length of the joined window.
    const added = utf8ByteLength(line) + 1;
    // Whole records only, but at least one record is always returned: a
    // window is cut before a record that would push it over the byte budget.
    if (lines.length > 0 && bodyBytes + added > limits.maxBytes) break;
    lines.push(line);
    bodyBytes += added;
    recordIndex += 1;
  }
  return {
    offset,
    lines,
    confirmedCount: offset + lines.length,
    empty: lines.length === 0,
  };
}

/**
 * The server-side append rule: append only records beyond `offset`, dedupe an
 * already-stored prefix, reject a gap.
 *
 * - A part whose `offset` equals the stored count appends every record it
 *   carries (the ordinary case).
 * - A part whose `offset` **trails** the stored count is a retry whose earlier
 *   2xx was lost: the already-stored prefix is dropped and only the new suffix
 *   is appended, so nothing is duplicated.
 * - A part whose `offset` is **beyond** the stored count is a gap: it is
 *   refused with the server's authoritative count (never partially applied),
 *   so the client can re-sync and re-send.
 *
 * Pure: the stored array is never mutated, and a rejected part yields no
 * records at all.
 *
 * @param storedLines - The run's records already stored, oldest first.
 * @param partLines - The records the part carries.
 * @param offset - The part's claimed cumulative offset.
 */
export function applyPartRecords(
  storedLines: readonly string[],
  partLines: readonly string[],
  offset: number,
): ApplyPartResult {
  const stored = normaliseLines(storedLines);
  if (!Number.isInteger(offset) || offset < 0 || offset > stored.length) {
    return { ok: false, reason: 'gap', confirmedCount: stored.length };
  }
  const records = normaliseLines(partLines);
  const alreadyStored = Math.min(records.length, stored.length - offset);
  const appended = records.slice(alreadyStored);
  const lines = [...stored, ...appended];
  return {
    ok: true,
    lines,
    confirmedCount: lines.length,
    appendedCount: appended.length,
  };
}

/**
 * Discriminates a part request from a whole-file request, parsing the framing
 * fields, as a pure function of the request's headers and query string.
 *
 * The marker must be **explicit**:
 *
 * - **No marker** (neither {@link PART_MARKER_HEADER} nor
 *   {@link PART_MARKER_QUERY}) — `whole-file`. Unrelated headers and query
 *   parameters never change that, which keeps the existing run-end upload
 *   byte-compatible.
 * - Marker switched off (`0`/`false`/`no`/`off`) — `whole-file`, explicitly.
 * - Marker switched on (`1`/`true`/`yes`/`on`) — `part`, provided the run key
 *   is valid, the offset is a non-negative integer and the final flag (when
 *   present) is a recognised value; otherwise `invalid` with every problem
 *   listed. An empty or unrecognised marker value is `invalid` rather than a
 *   silent downgrade to the whole-file path.
 *
 * Each field is read from its header first, then from its query parameter, so
 * a client can use either channel. Header names are case-insensitive.
 *
 * @param input - The request's headers and URL.
 */
export function parsePartRequest(input: PartRequestInput = {}): PartRequestDiscrimination {
  const channels = requestChannels(input);
  const marker = readField(channels, PART_MARKER_HEADER, PART_MARKER_QUERY);
  if (marker === undefined) return { kind: 'whole-file' };

  const isPart = parseFlag(marker);
  if (isPart === false) return { kind: 'whole-file' };

  const errors: string[] = [];
  if (isPart === undefined) {
    errors.push(
      marker === ''
        ? `Empty part marker (expected one of ${PART_FLAG_ON.join(', ')})`
        : `Unrecognised part marker "${marker}" (expected one of ${PART_FLAG_ON.join(', ')})`,
    );
  }

  const runKey = readField(channels, PART_RUN_KEY_HEADER, PART_RUN_KEY_QUERY);
  if (runKey === undefined) {
    errors.push(
      `Missing part run key (${PART_RUN_KEY_HEADER} header or ${PART_RUN_KEY_QUERY} query parameter)`,
    );
  } else if (!isValidRunKey(runKey)) {
    errors.push(`Invalid part run key "${runKey}"`);
  }

  const rawOffset = readField(channels, PART_OFFSET_HEADER, PART_OFFSET_QUERY);
  const offset = parseRecordCount(rawOffset);
  if (rawOffset === undefined) {
    errors.push(
      `Missing part offset (${PART_OFFSET_HEADER} header or ${PART_OFFSET_QUERY} query parameter)`,
    );
  } else if (offset === undefined) {
    errors.push(
      `Invalid part offset "${rawOffset}" (expected a non-negative integer)`,
    );
  }

  const rawFinal = readField(channels, PART_FINAL_HEADER, PART_FINAL_QUERY);
  const final = rawFinal === undefined ? false : parseFlag(rawFinal);
  if (final === undefined) {
    errors.push(
      `Unrecognised final flag "${rawFinal}" (expected one of ${PART_FLAG_ON.join(', ')} or ${PART_FLAG_OFF.join(', ')})`,
    );
  }

  if (
    errors.length > 0 ||
    runKey === undefined ||
    offset === undefined ||
    final === undefined
  ) {
    return { kind: 'invalid', errors };
  }
  return { kind: 'part', part: { runKey, offset, final } };
}

/** A request's lower-cased header values and its query parameters. */
interface RequestChannels {
  readonly headers: ReadonlyMap<string, string>;
  readonly query: ReadonlyMap<string, string>;
}

/** Extracts the header and query channels from a request surface. */
function requestChannels(input: PartRequestInput): RequestChannels {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const first = firstHeaderValue(value);
    if (first !== undefined) headers.set(name.toLowerCase(), first);
  }
  const query = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(urlQuery(input.url ?? ''))) {
    // Presence is preserved even for an empty value: an explicit `?part`
    // without a value is a malformed part marker, not an absent one.
    query.set(name, value.trim());
  }
  return { headers, query };
}

/** The query string of a request URL, without its fragment. */
function urlQuery(url: string): string {
  const withoutFragment = url.split('#')[0];
  const queryStart = withoutFragment.indexOf('?');
  return queryStart === -1 ? '' : withoutFragment.slice(queryStart + 1);
}

/**
 * The first value of a (possibly repeated) header, trimmed.
 *
 * Presence wins over emptiness: an empty value is returned as `''` so the
 * parser can refuse it, instead of letting it look like an absent header (a
 * request that *declares* the part marker must never silently be stored as a
 * whole-file recording).
 */
function firstHeaderValue(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string') return value.trim();
  const first = value?.[0];
  return first === undefined ? undefined : first.trim();
}

/** Reads a framing field: header first, then its query-parameter equivalent. */
function readField(
  channels: RequestChannels,
  header: string,
  queryParameter: string,
): string | undefined {
  return channels.headers.get(header) ?? channels.query.get(queryParameter);
}

/** Parses a protocol flag; `undefined` when the value is not recognised. */
function parseFlag(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if ((PART_FLAG_ON as readonly string[]).includes(value)) return true;
  if ((PART_FLAG_OFF as readonly string[]).includes(value)) return false;
  return undefined;
}

/** Parses a cumulative record count; `undefined` when it is not usable. */
function parseRecordCount(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : undefined;
}

/** Shared `TextEncoder` for the window byte budget (avoids one per line). */
const textEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** Size of a string in UTF-8 bytes (the unit the window byte budget uses). */
function utf8ByteLength(text: string): number {
  return textEncoder ? textEncoder.encode(text).length : text.length;
}
