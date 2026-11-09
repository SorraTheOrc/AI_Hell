/**
 * Hermetic tests for the dev telemetry part-protocol contract
 * (AH-0MW6NFRQR0062D90, parent AH-0MVJUAADW0033QBD).
 *
 * Every helper is pure, so the whole protocol is pinned without a network, a
 * server, a clock or a temporary directory: the run key's determinism, the
 * part framing (only the unconfirmed delta), the server-side dedupe/gap
 * append rule, and the marker discrimination that keeps the unmarked
 * whole-file upload byte-compatible.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_RUN_KEY_LENGTH,
  PART_FINAL_HEADER,
  PART_FINAL_QUERY,
  PART_MARKER_HEADER,
  PART_MARKER_QUERY,
  PART_OFFSET_HEADER,
  PART_OFFSET_QUERY,
  PART_RUN_KEY_HEADER,
  PART_RUN_KEY_QUERY,
  applyPartRecords,
  deriveRunKey,
  isValidRunKey,
  nextPartRange,
  parsePartRequest,
  splitNdjsonLines,
} from './devStreamProtocol';
import { linesToNdjson } from './sinks';

/** A minimal, schema-independent record line (the protocol never parses JSON). */
function record(tick: number): string {
  return JSON.stringify({ kind: 'event', tick, event: 'test' });
}

describe('deriveRunKey — run-scoped and deterministic (AC1)', () => {
  it('yields the same key for the same startedAt and runSeed', () => {
    expect(deriveRunKey(1_700_000_000_000, 7)).toBe(deriveRunKey(1_700_000_000_000, 7));
    expect(deriveRunKey(1_700_000_000_000, 7)).toBe('1700000000000-7');
  });

  it('yields different keys for different runs', () => {
    const key = deriveRunKey(1_700_000_000_000, 7);

    expect(deriveRunKey(1_700_000_000_001, 7)).not.toBe(key);
    expect(deriveRunKey(1_700_000_000_000, 8)).not.toBe(key);
  });

  it('truncates fractional inputs so an unchanged run keeps its key', () => {
    expect(deriveRunKey(1_700_000_000_000.9, 7.8)).toBe('1700000000000-7');
  });

  it('refuses a non-finite input rather than producing an unusable key', () => {
    expect(() => deriveRunKey(Number.NaN, 7)).toThrow(RangeError);
    expect(() => deriveRunKey(1_700_000_000_000, Number.POSITIVE_INFINITY)).toThrow(
      RangeError,
    );
  });

  it('always produces a key that can name the staged part file', () => {
    expect(isValidRunKey(deriveRunKey(1_700_000_000_000, 7))).toBe(true);
  });
});

describe('isValidRunKey — one safe path segment (AC1)', () => {
  it('accepts the shape deriveRunKey produces', () => {
    expect(isValidRunKey('1700000000000-7')).toBe(true);
    expect(isValidRunKey('run.2026_11-07_a')).toBe(true);
  });

  it('rejects anything that could escape the parts directory', () => {
    for (const runKey of ['', '.', '..', '../evil', 'a/b', 'a\\b', 'a b', '-leading', 'a\nb', 'a?b']) {
      expect(isValidRunKey(runKey)).toBe(false);
    }
  });

  it('rejects an over-long key', () => {
    expect(isValidRunKey('a'.repeat(MAX_RUN_KEY_LENGTH))).toBe(true);
    expect(isValidRunKey('a'.repeat(MAX_RUN_KEY_LENGTH + 1))).toBe(false);
  });
});

describe('splitNdjsonLines — the inverse of the sink formatting (AC2)', () => {
  it('splits record lines and drops blank separator lines', () => {
    expect(splitNdjsonLines(`${record(0)}\n${record(1)}\n`)).toEqual([record(0), record(1)]);
    expect(splitNdjsonLines(`\n${record(0)}\n\n${record(1)}\n\n`)).toEqual([
      record(0),
      record(1),
    ]);
    expect(splitNdjsonLines('')).toEqual([]);
  });

  it('round-trips the sink buffer format', () => {
    const lines = [record(0), record(1), record(2)];

    expect(splitNdjsonLines(linesToNdjson(lines))).toEqual(lines);
  });
});

describe('nextPartRange — only the unconfirmed delta (AC2)', () => {
  const buffer = [record(0), record(1), record(2)];

  it('claims the confirmed count as its offset and carries every unconfirmed line', () => {
    expect(nextPartRange(0, buffer)).toEqual({
      offset: 0,
      lines: buffer,
      confirmedCount: 3,
      empty: false,
    });
  });

  it('never re-sends a confirmed record', () => {
    const range = nextPartRange(2, buffer);

    expect(range.offset).toBe(2);
    expect(range.lines).toEqual([record(2)]);
    expect(range.confirmedCount).toBe(3);
  });

  it('tiles a growing buffer across parts without gaps or repeats', () => {
    const firstFlush = [record(0), record(1)];
    const secondFlush = [record(2), record(3)];
    const growing = [...firstFlush];
    const sent: string[] = [];

    let range = nextPartRange(0, growing);
    sent.push(...range.lines);
    let confirmed = range.confirmedCount;

    growing.push(...secondFlush);
    range = nextPartRange(confirmed, growing);
    sent.push(...range.lines);
    confirmed = range.confirmedCount;

    expect(sent).toEqual([...firstFlush, ...secondFlush]);
    expect(confirmed).toBe(4);
    // Nothing is left once the whole buffer is confirmed: run end sends a
    // finalisation-only part with no records.
    expect(nextPartRange(confirmed, growing)).toEqual({
      offset: 4,
      lines: [],
      confirmedCount: 4,
      empty: true,
    });
  });

  it('is empty when the whole buffer is already confirmed', () => {
    expect(nextPartRange(3, buffer)).toMatchObject({ lines: [], empty: true });
    expect(nextPartRange(9, buffer)).toMatchObject({ offset: 9, lines: [], empty: true });
  });

  it('ignores blank lines, which are separators and never records', () => {
    expect(nextPartRange(1, [record(0), '', '  ', record(1)])).toEqual({
      offset: 1,
      lines: [record(1)],
      confirmedCount: 2,
      empty: false,
    });
  });

  it('treats an unusable watermark as zero so nothing is skipped', () => {
    expect(nextPartRange(Number.NaN, buffer)).toMatchObject({ offset: 0, lines: buffer });
    expect(nextPartRange(-2, buffer)).toMatchObject({ offset: 0, lines: buffer });
  });
});

describe('applyPartRecords — append, dedupe, gap (AC3)', () => {
  it('appends a part whose offset is the stored count', () => {
    const result = applyPartRecords([record(0)], [record(1), record(2)], 1);

    expect(result).toEqual({
      ok: true,
      lines: [record(0), record(1), record(2)],
      confirmedCount: 3,
      appendedCount: 2,
    });
  });

  it('appends a first part to an empty store', () => {
    expect(applyPartRecords([], [record(0)], 0)).toEqual({
      ok: true,
      lines: [record(0)],
      confirmedCount: 1,
      appendedCount: 1,
    });
  });

  it('drops an already-appended prefix on a retried part (lost 2xx)', () => {
    const stored = [record(0), record(1)];

    const result = applyPartRecords(stored, [record(0), record(1)], 0);

    expect(result).toEqual({
      ok: true,
      lines: stored,
      confirmedCount: 2,
      appendedCount: 0,
    });
  });

  it('appends only the new suffix when a retried part overlaps the store', () => {
    const result = applyPartRecords(
      [record(0), record(1)],
      [record(1), record(2)],
      1,
    );

    expect(result).toEqual({
      ok: true,
      lines: [record(0), record(1), record(2)],
      confirmedCount: 3,
      appendedCount: 1,
    });
  });

  it('rejects an offset beyond the stored count as a gap with the current count', () => {
    const result = applyPartRecords([record(0), record(1)], [record(5)], 3);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a gap');
    expect(result.reason).toBe('gap');
    expect(result.confirmedCount).toBe(2);
  });

  it('rejects a gap even when the part carries no records', () => {
    const result = applyPartRecords([record(0)], [], 4);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a gap');
    expect(result.confirmedCount).toBe(1);
  });

  it('accepts an empty part at the stored count (a finalisation-only part)', () => {
    expect(applyPartRecords([record(0)], [], 1)).toEqual({
      ok: true,
      lines: [record(0)],
      confirmedCount: 1,
      appendedCount: 0,
    });
  });

  it('rejects a non-integer or negative offset as a gap', () => {
    for (const offset of [-1, 1.5, Number.NaN]) {
      const result = applyPartRecords([record(0), record(1)], [record(2)], offset);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.confirmedCount).toBe(2);
    }
  });

  it('never mutates the stored lines', () => {
    const stored = [record(0)];

    applyPartRecords(stored, [record(1)], 1);

    expect(stored).toEqual([record(0)]);
  });

  it('ignores blank lines in the part body', () => {
    const result = applyPartRecords([], ['', record(0), '   ', record(1), ''], 0);

    expect(result).toEqual({
      ok: true,
      lines: [record(0), record(1)],
      confirmedCount: 2,
      appendedCount: 2,
    });
  });

  it('stores each record exactly once across a lost-2xx and a stale-watermark retry', () => {
    const partOne = [record(0), record(1)];
    const partTwo = [record(2), record(3)];

    // Fresh run: the first part lands.
    const afterOne = applyPartRecords([], partOne, 0);
    if (!afterOne.ok) throw new Error('first part was refused');

    // Its 2xx is lost, so the client re-sends part one unchanged.
    const afterRetry = applyPartRecords(afterOne.lines, partOne, 0);
    if (!afterRetry.ok) throw new Error('retried part was refused');

    // A stale watermark makes the next part overshoot slightly; only the new
    // suffix is appended.
    const afterTwo = applyPartRecords(afterRetry.lines, [record(1), ...partTwo], 1);
    if (!afterTwo.ok) throw new Error('second part was refused');

    expect(afterTwo.lines).toEqual([record(0), record(1), record(2), record(3)]);
    expect(afterTwo.confirmedCount).toBe(4);
  });
});

describe('parsePartRequest — marker discrimination (AC4)', () => {
  it('treats a request without the marker as the whole-file contract', () => {
    expect(parsePartRequest()).toEqual({ kind: 'whole-file' });
    expect(
      parsePartRequest({
        headers: { 'content-type': 'application/x-ndjson' },
        url: '/api/telemetry/upload?runKey=1700000000000-7&offset=64',
      }),
    ).toEqual({ kind: 'whole-file' });
  });

  it('parses a part marked by headers', () => {
    expect(
      parsePartRequest({
        headers: {
          [PART_MARKER_HEADER]: '1',
          [PART_RUN_KEY_HEADER]: '1700000000000-7',
          [PART_OFFSET_HEADER]: '64',
          [PART_FINAL_HEADER]: '1',
        },
        url: '/api/telemetry/upload',
      }),
    ).toEqual({
      kind: 'part',
      part: { runKey: '1700000000000-7', offset: 64, final: true },
    });
  });

  it('parses a part marked by query flags', () => {
    expect(
      parsePartRequest({
        url:
          '/api/telemetry/upload?' +
          `${PART_MARKER_QUERY}=1&${PART_RUN_KEY_QUERY}=1700000000000-7` +
          `&${PART_OFFSET_QUERY}=128&${PART_FINAL_QUERY}=true`,
      }),
    ).toEqual({
      kind: 'part',
      part: { runKey: '1700000000000-7', offset: 128, final: true },
    });
  });

  it('matches header names case-insensitively', () => {
    expect(
      parsePartRequest({
        headers: {
          'X-Telemetry-Part': '1',
          'X-Telemetry-Run-Key': 'run-1',
          'X-Telemetry-Offset': '0',
        },
      }),
    ).toEqual({ kind: 'part', part: { runKey: 'run-1', offset: 0, final: false } });
  });

  it('reads the first value of a repeated header', () => {
    expect(
      parsePartRequest({
        headers: {
          [PART_MARKER_HEADER]: ['1', '0'],
          [PART_RUN_KEY_HEADER]: ['run-1', 'run-2'],
          [PART_OFFSET_HEADER]: ['0', '5'],
        },
      }),
    ).toEqual({ kind: 'part', part: { runKey: 'run-1', offset: 0, final: false } });
  });

  it('prefers the header value over the query-parameter fallback', () => {
    expect(
      parsePartRequest({
        headers: {
          [PART_MARKER_HEADER]: '1',
          [PART_OFFSET_HEADER]: '2',
        },
        url: `/api/telemetry/upload?${PART_RUN_KEY_QUERY}=run-1&${PART_OFFSET_QUERY}=9`,
      }),
    ).toEqual({ kind: 'part', part: { runKey: 'run-1', offset: 2, final: false } });
  });

  it('defaults the final flag to false when it is absent', () => {
    const parsed = parsePartRequest({
      url: `/api/telemetry/upload?${PART_MARKER_QUERY}=1&${PART_RUN_KEY_QUERY}=run-1&${PART_OFFSET_QUERY}=3`,
    });

    expect(parsed).toEqual({ kind: 'part', part: { runKey: 'run-1', offset: 3, final: false } });
  });

  it('treats an explicitly switched-off marker as the whole-file contract', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE']) {
      expect(parsePartRequest({ headers: { [PART_MARKER_HEADER]: value } })).toEqual({
        kind: 'whole-file',
      });
    }
  });

  it('refuses a marker it cannot read instead of silently storing a delta', () => {
    for (const value of ['', 'yes please', '2']) {
      const parsed = parsePartRequest({ headers: { [PART_MARKER_HEADER]: value } });
      expect(parsed.kind).toBe('invalid');
    }
  });

  it('refuses a valueless query marker instead of storing a delta', () => {
    expect(parsePartRequest({ url: '/api/telemetry/upload?part' }).kind).toBe('invalid');
  });

  it('reports every missing framing field of a part request', () => {
    const parsed = parsePartRequest({ headers: { [PART_MARKER_HEADER]: '1' } });

    expect(parsed.kind).toBe('invalid');
    if (parsed.kind !== 'invalid') throw new Error('expected an invalid part request');
    expect(parsed.errors).toHaveLength(2);
    expect(parsed.errors.join('\n')).toContain('run key');
    expect(parsed.errors.join('\n')).toContain('offset');
  });

  it('refuses a run key that could escape the parts directory', () => {
    const parsed = parsePartRequest({
      headers: {
        [PART_MARKER_HEADER]: '1',
        [PART_RUN_KEY_HEADER]: '../../etc/passwd',
        [PART_OFFSET_HEADER]: '0',
      },
    });

    expect(parsed.kind).toBe('invalid');
    if (parsed.kind !== 'invalid') throw new Error('expected an invalid part request');
    expect(parsed.errors.join('\n')).toContain('Invalid part run key');
  });

  it('refuses an offset that is not a non-negative integer', () => {
    for (const offset of ['-1', '1.5', 'abc', '']) {
      const parsed = parsePartRequest({
        headers: {
          [PART_MARKER_HEADER]: '1',
          [PART_RUN_KEY_HEADER]: 'run-1',
          [PART_OFFSET_HEADER]: offset,
        },
      });
      expect(parsed.kind).toBe('invalid');
    }
  });

  it('refuses an unreadable final flag', () => {
    const parsed = parsePartRequest({
      headers: {
        [PART_MARKER_HEADER]: '1',
        [PART_RUN_KEY_HEADER]: 'run-1',
        [PART_OFFSET_HEADER]: '0',
        [PART_FINAL_HEADER]: 'maybe',
      },
    });

    expect(parsed.kind).toBe('invalid');
    if (parsed.kind !== 'invalid') throw new Error('expected an invalid part request');
    expect(parsed.errors.join('\n')).toContain('final flag');
  });
});
