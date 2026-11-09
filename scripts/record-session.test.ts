/**
 * Hermetic tests for the recorder interruption seam and crash-path handling
 * (AH-0MVWIDLX200526P1, parent AH-0MVVH57LL00038WQ).
 *
 * A browser closed mid-recording used to escape the poll loop as a raw
 * Playwright target-closed error: nothing written, no path named, only a
 * stack. These tests pin the extracted, fully injected seam so the crash,
 * lost and clean-stop paths are covered without a real browser.
 *
 * Every filesystem write lands in a `mkdtempSync` temp dir (suite-write guard
 * AH-0MVS9TY0N0034LZT); page evaluate, fs and clock are fakes.
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  DEFAULT_CHECKPOINT_MS,
  applyCheckpointRead,
  createRecordingCheckpoint,
  finaliseRecording,
  formatLostRecordingLine,
  isTargetClosedError,
  LOST_RECORDING_MESSAGE,
  partialPathForJsonl,
  resolvePartialRecordingPath,
  runRecordingWaitLoop,
} from './record-session.mjs';
import { parseTelemetryJsonl } from './inspect-telemetry.mjs';

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aihell-record-session-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Fake stop controller whose `requested` flag can be flipped. */
function fakeStop(startRequested = false) {
  let requested = startRequested;
  return {
    stop: {
      get requested() {
        return requested;
      },
    },
    setRequested(value: boolean) {
      requested = value;
    },
  };
}

/** A clock fake that advances only when the injected `wait` ticks it. */
function fakeClock(initial = 0) {
  let value = initial;
  return {
    get now() {
      return value;
    },
    tick(ms: number) {
      value += ms;
    },
  };
}

/** One schema-v1 telemetry record as a newline-terminated JSONL line. */
function recordLine(tick: number): string {
  return `${JSON.stringify({ kind: 'tick', schemaVersion: 1, tick, state: {}, input: {} })}\n`;
}

/* ------------------------------------------------------------------ */
/*  isTargetClosedError — the known Playwright target-closed family     */
/* ------------------------------------------------------------------ */

describe('isTargetClosedError (AH-0MVWIDLX200526P1 AC3)', () => {
  it('detects the target-closed message family', () => {
    for (const message of [
      'Target page, context or browser has been closed',
      'Target closed',
      'Target crashed',
      'Page closed',
      'Browser has been closed',
      'Browser disconnected',
      'Context closed',
      'Protocol error (Runtime.callFunctionOn): Target closed.',
      'Execution context was destroyed',
    ]) {
      expect(isTargetClosedError(new Error(message)), message).toBe(true);
    }
  });

  it('does not claim unrelated errors', () => {
    expect(isTargetClosedError(new Error('Timeout exceeded'))).toBe(false);
    expect(isTargetClosedError(new Error('Net::ERR_CONNECTION_REFUSED'))).toBe(false);
    expect(isTargetClosedError(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Lost-session message (AC4)                                        */
/* ------------------------------------------------------------------ */

describe('formatLostRecordingLine (AH-0MVWIDLX200526P1 AC4)', () => {
  it('includes the required sentence verbatim', () => {
    expect(formatLostRecordingLine('/tmp/out.jsonl')).toContain(LOST_RECORDING_MESSAGE);
  });

  it('names the resolved output path that was not written', () => {
    expect(formatLostRecordingLine('/tmp/out.jsonl')).toContain('/tmp/out.jsonl');
  });

  it('is exactly one line', () => {
    expect(formatLostRecordingLine('/tmp/out.jsonl').split('\n')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/*  Partial path naming (mirrors capture-chunk-sink `<stem>.partial.*`) */
/* ------------------------------------------------------------------ */

describe('partialPathForJsonl (AH-0MVWIDLX200526P1)', () => {
  it('inserts .partial before the .jsonl extension', () => {
    expect(partialPathForJsonl('/recordings/session-2026-01-01T10.jsonl')).toBe(
      '/recordings/session-2026-01-01T10.partial.jsonl',
    );
  });

  it('appends .partial.jsonl when there is no .jsonl extension', () => {
    expect(partialPathForJsonl('/recordings/session-2026')).toBe(
      '/recordings/session-2026.partial.jsonl',
    );
  });
});

/* ------------------------------------------------------------------ */
/*  runRecordingWaitLoop — stop-reason classification (AC1a, 2, 3)     */
/* ------------------------------------------------------------------ */

describe('runRecordingWaitLoop (AH-0MVWIDLX200526P1 AC1a/2/3)', () => {
  it('returns target_closed when evaluate throws a target-closed error', async () => {
    const evaluate = vi.fn().mockRejectedValue(
      new Error('Target page, context or browser has been closed'),
    );
    const { stop } = fakeStop();

    const reason = await runRecordingWaitLoop({
      evaluate,
      stop,
      now: Date.now,
      wait: vi.fn(),
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
    });

    expect(reason).toBe('target_closed');
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('defaults an unknown poll failure to the interruption path, never a raw exit', async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error('some unexpected failure'));
    const { stop } = fakeStop();

    const reason = await runRecordingWaitLoop({
      evaluate,
      stop,
      now: Date.now,
      wait: vi.fn(),
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
    });

    expect(reason).toBe('target_closed');
  });

  it('returns target_closed when isPageClosed reports true', async () => {
    const { stop } = fakeStop();
    const clock = fakeClock();

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: false }),
      stop,
      now: () => clock.now,
      wait: () => {
        clock.tick(250);
        return Promise.resolve();
      },
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
      isPageClosed: () => true,
    });

    expect(reason).toBe('target_closed');
  });

  it('returns target_closed when isBrowserConnected reports false', async () => {
    const { stop } = fakeStop();
    const clock = fakeClock();

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: false }),
      stop,
      now: () => clock.now,
      wait: () => {
        clock.tick(250);
        return Promise.resolve();
      },
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
      isBrowserConnected: () => false,
    });

    expect(reason).toBe('target_closed');
  });

  it('returns run_end when --auto and the run-end signal arrives', async () => {
    const { stop } = fakeStop();

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: true, won: false, score: 42 }),
      stop,
      now: Date.now,
      wait: vi.fn(),
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: true,
    });

    expect(reason).toBe('run_end');
  });

  it('does not stop on a run-end signal without --auto', async () => {
    const { stop } = fakeStop();
    const clock = fakeClock();

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: true, won: false, score: 42 }),
      stop,
      now: () => clock.now,
      wait: () => {
        clock.tick(250);
        return Promise.resolve();
      },
      maxDurationMs: 600,
      pollMs: 250,
      auto: false,
    });

    expect(reason).toBe('max_duration');
  });

  it('returns max_duration when elapsed reaches the cap', async () => {
    const { stop } = fakeStop();
    const clock = fakeClock();

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: false }),
      stop,
      now: () => clock.now,
      wait: () => {
        clock.tick(250);
        return Promise.resolve();
      },
      maxDurationMs: 600,
      pollMs: 250,
      auto: false,
    });

    expect(reason).toBe('max_duration');
  });

  it('returns sigint when the stop controller is requested', async () => {
    const { stop, setRequested } = fakeStop();
    let waits = 0;

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: false }),
      stop,
      now: Date.now,
      wait: () => {
        waits += 1;
        if (waits >= 2) setRequested(true);
        return Promise.resolve();
      },
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
    });

    expect(reason).toBe('sigint');
  });

  it('never lets a thrown failure escape the loop', async () => {
    const { stop } = fakeStop();

    await expect(
      runRecordingWaitLoop({
        evaluate: () => {
          throw new Error('Target closed');
        },
        stop,
        now: Date.now,
        wait: vi.fn(),
        maxDurationMs: 30_000,
        pollMs: 250,
        auto: false,
      }),
    ).resolves.toBe('target_closed');
  });
});

/* ------------------------------------------------------------------ */
/*  finaliseRecording — lost / salvaged / clean stop (AC1b, 4, 5)      */
/* ------------------------------------------------------------------ */

describe('finaliseRecording (AH-0MVWIDLX200526P1 AC1b/4/5)', () => {
  it('on target_closed with zero captured bytes logs one lost line and exits 1 (AC1b/4)', async () => {
    const dir = tempDir();
    const outputPath = join(dir, 'session-test.jsonl');
    const lines: string[] = [];

    const result = await finaliseRecording({
      reason: 'target_closed',
      outputPath,
      partialPath: partialPathForJsonl(outputPath),
      capturedBytes: 0,
      readJsonl: () => Promise.resolve(''),
      writeRecording: vi.fn(),
      removeFile: vi.fn(),
      log: (line: string) => lines.push(line),
    });

    expect(result.exitCode).toBe(1);
    expect(result.lost).toBe(true);
    expect(result.salvaged).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(LOST_RECORDING_MESSAGE);
    expect(lines[0]).toContain(outputPath);
  });

  it('on target_closed with captured bytes reports the partial and exits 1', async () => {
    const dir = tempDir();
    const outputPath = join(dir, 'session-test.jsonl');
    const partialPath = partialPathForJsonl(outputPath);
    writeFileSync(
      partialPath,
      '{"kind":"tick","schemaVersion":1,"tick":0,"state":{},"input":{}}\n',
    );
    const lines: string[] = [];

    const result = await finaliseRecording({
      reason: 'target_closed',
      outputPath,
      partialPath,
      capturedBytes: 200,
      readJsonl: () => Promise.resolve(''),
      writeRecording: vi.fn(),
      removeFile: vi.fn(),
      log: (line: string) => lines.push(line),
    });

    expect(result.exitCode).toBe(1);
    expect(result.lost).toBe(false);
    expect(result.salvaged).toBe(true);
    expect(result.partialPath).toBe(partialPath);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(partialPath);
  });

  it('on a clean stop writes the final recording and removes the partial (AC5)', async () => {
    const dir = tempDir();
    const outputPath = join(dir, 'session-clean.jsonl');
    const partialPath = partialPathForJsonl(outputPath);
    writeFileSync(partialPath, 'checkpointed bytes that must be removed\n');

    const finalJsonl = '{"kind":"run_header"}\n{"kind":"tick"}\n';
    const written: string[] = [];
    const removed: string[] = [];

    const result = await finaliseRecording({
      reason: 'sigint',
      outputPath,
      partialPath,
      capturedBytes: 0,
      readJsonl: () => Promise.resolve(finalJsonl),
      writeRecording: (path: string, data: string) => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, data);
        written.push(path);
      },
      removeFile: (path: string) => {
        removed.push(path);
        rmSync(path, { force: true });
      },
      log: () => {},
    });

    expect(result.exitCode).toBe(0);
    expect(written).toEqual([outputPath]);
    expect(readFileSync(outputPath, 'utf8')).toBe(finalJsonl);
    expect(removed).toEqual([partialPath]);
    expect(existsSync(partialPath)).toBe(false);
  });

  it('treats run_end and max_duration as clean stops', async () => {
    for (const reason of ['run_end', 'max_duration'] as const) {
      const dir = tempDir();
      const outputPath = join(dir, `session-${reason}.jsonl`);
      const result = await finaliseRecording({
        reason,
        outputPath,
        partialPath: partialPathForJsonl(outputPath),
        capturedBytes: 0,
        readJsonl: () => Promise.resolve('{}\n'),
        writeRecording: (path: string, data: string) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, data);
        },
        removeFile: vi.fn(),
        log: () => {},
      });
      expect(result.exitCode, reason).toBe(0);
      expect(existsSync(outputPath), reason).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Checkpointed crash-safe partial capture (AH-0MVWIDN5G006IZ58)      */
/* ------------------------------------------------------------------ */

/** In-page telemetry buffer fake: `readChunk` records every offset asked. */
function fakeBuffer(initial: string, chunkChars = 64) {
  let text = initial;
  const offsets: number[] = [];
  return {
    get text() {
      return text;
    },
    set text(value: string) {
      text = value;
    },
    offsets,
    readChunk(offset: number) {
      offsets.push(offset);
      return Promise.resolve({ total: text.length, chunk: text.slice(offset, offset + chunkChars) });
    },
  };
}

/** Checkpoint writer harness with a fake buffer, fake file and fake clock. */
function checkpointHarness(buffer: ReturnType<typeof fakeBuffer>, intervalMs = 1_000) {
  let clock = 0;
  const file: string[] = [];
  const checkpoint = createRecordingCheckpoint({
    partialPath: '/tmp/partial.jsonl',
    readChunk: buffer.readChunk,
    appendText: (_path: string, text: string) => file.push(text),
    truncateFile: () => {
      file.length = 0;
    },
    intervalMs,
    now: () => clock,
    chunkChars: 64,
  });
  return {
    checkpoint,
    get content() {
      return file.join('');
    },
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('resolvePartialRecordingPath (AH-0MVWIDN5G006IZ58 AC3)', () => {
  it('resolves the documented partial path when it is free', () => {
    expect(resolvePartialRecordingPath('/rec/session-x.jsonl', () => false)).toBe(
      '/rec/session-x.partial.jsonl',
    );
  });

  it('uses a collision-safe numeric suffix before the extension', () => {
    const taken = new Set(['/rec/session-x.partial.jsonl', '/rec/session-x.partial-2.jsonl']);
    expect(resolvePartialRecordingPath('/rec/session-x.jsonl', (p) => taken.has(p))).toBe(
      '/rec/session-x.partial-3.jsonl',
    );
  });

  it('never resolves to the final recording path', () => {
    const existing = new Set(['/rec/session-x.jsonl']);
    const resolved = resolvePartialRecordingPath('/rec/session-x.jsonl', (p) => existing.has(p));
    expect(resolved).not.toBe('/rec/session-x.jsonl');
    expect(resolved.endsWith('.partial.jsonl')).toBe(true);
  });
});

describe('applyCheckpointRead (AH-0MVWIDN5G006IZ58 AC2)', () => {
  const emptyState = { offset: 0, total: 0, remainder: '', bytesWritten: 0 };

  it('appends only complete newline-terminated records and carries the tail', () => {
    const complete = recordLine(0);
    const half = recordLine(1).slice(0, 20);
    const result = applyCheckpointRead(emptyState, { total: complete.length + half.length, chunk: complete + half });

    expect(result.reset).toBe(false);
    expect(result.append).toBe(complete);
    expect(result.state.remainder).toBe(half);
    expect(result.state.offset).toBe(complete.length + half.length);
    expect(result.state.bytesWritten).toBe(complete.length);
  });

  it('restarts from offset 0 when the reported total shrinks', () => {
    const state = { offset: 500, total: 500, remainder: '', bytesWritten: 400 };
    const result = applyCheckpointRead(state, { total: 120, chunk: '' });

    expect(result.reset).toBe(true);
    expect(result.append).toBe('');
    expect(result.state).toEqual({ offset: 0, total: 0, remainder: '', bytesWritten: 0 });
  });

  it('does not reset on an unreachable accessor (total 0)', () => {
    const state = { offset: 500, total: 500, remainder: '', bytesWritten: 400 };
    const result = applyCheckpointRead(state, { total: 0, chunk: '' });
    expect(result.reset).toBe(false);
    expect(result.state.offset).toBe(500);
  });
});

describe('createRecordingCheckpoint (AH-0MVWIDN5G006IZ58 AC1/2/5)', () => {
  it('defaults to a 15 s interval and is disabled by 0', () => {
    expect(DEFAULT_CHECKPOINT_MS).toBe(15_000);
    const buffer = fakeBuffer(recordLine(0));
    const enabled = checkpointHarness(buffer);
    expect(enabled.checkpoint.enabled).toBe(true);
    const disabled = checkpointHarness(buffer, 0);
    expect(disabled.checkpoint.enabled).toBe(false);
    expect(disabled.checkpoint.partialPath).toBeNull();
  });

  it('appends only new bytes, resuming at the last offset (never a full re-read)', async () => {
    const buffer = fakeBuffer(recordLine(0) + recordLine(1));
    const harness = checkpointHarness(buffer);

    await harness.checkpoint.tick();
    const firstLength = buffer.text.length;
    const offsetsAfterFirstTick = buffer.offsets.length;
    expect(harness.content).toBe(buffer.text);

    buffer.text += recordLine(2) + recordLine(3);
    harness.advance(1_000);
    await harness.checkpoint.tick();

    // Every read in the second tick starts at or after the first run's end.
    const secondTickOffsets = buffer.offsets.slice(offsetsAfterFirstTick);
    expect(secondTickOffsets[0]).toBe(firstLength);
    expect(secondTickOffsets.every((offset) => offset >= firstLength)).toBe(true);

    expect(harness.content).toBe(buffer.text);
    expect(harness.checkpoint.bytesWritten).toBe(buffer.text.length);
    const parsed = parseTelemetryJsonl(harness.content);
    expect(parsed.skipped).toBe(0);
    expect(parsed.records.map((r: any) => r.tick)).toEqual([0, 1, 2, 3]);
  });

  it('never writes a half-written record, carrying the remainder into the next read', async () => {
    const complete = recordLine(0);
    const tail = recordLine(1).slice(0, 20);
    const buffer = fakeBuffer(complete + tail);
    const harness = checkpointHarness(buffer);

    await harness.checkpoint.tick();
    expect(harness.content).toBe(complete);
    expect(harness.checkpoint.remainder).toBe(tail);
    expect(parseTelemetryJsonl(harness.content).skipped).toBe(0);

    // The page finishes the record.
    buffer.text = complete + recordLine(1);
    harness.advance(1_000);
    await harness.checkpoint.tick();

    expect(harness.content).toBe(complete + recordLine(1));
    expect(harness.checkpoint.remainder).toBe('');
    expect(parseTelemetryJsonl(harness.content).skipped).toBe(0);
  });

  it('restarts at offset 0 and truncates when the buffer total shrinks (no two-run mixing)', async () => {
    const firstRun = recordLine(0) + recordLine(1) + recordLine(2);
    const buffer = fakeBuffer(firstRun);
    const harness = checkpointHarness(buffer);

    await harness.checkpoint.tick();
    expect(harness.content).toBe(firstRun);

    // The game started a new run: the buffer is reset to a shorter content.
    const secondRun = recordLine(10);
    expect(secondRun.length).toBeLessThan(firstRun.length);
    buffer.text = secondRun;
    harness.advance(1_000);
    await harness.checkpoint.tick();

    expect(harness.content).toBe(secondRun);
    expect(harness.content).not.toContain('"tick":0');
    expect(harness.checkpoint.offset).toBe(secondRun.length);
    expect(harness.checkpoint.bytesWritten).toBe(secondRun.length);
    // It re-read from 0 after the reset rather than continuing past the end.
    expect(buffer.offsets.filter((offset) => offset === 0).length).toBeGreaterThan(1);
    const parsed = parseTelemetryJsonl(harness.content);
    expect(parsed.skipped).toBe(0);
    expect(parsed.records.map((r: any) => r.tick)).toEqual([10]);
  });

  it('does not read again before the checkpoint interval elapses', async () => {
    const buffer = fakeBuffer(recordLine(0));
    const harness = checkpointHarness(buffer);

    await harness.checkpoint.tick();
    const readsAfterFirstTick = buffer.offsets.length;

    buffer.text += recordLine(1);
    harness.advance(999);
    const skipped = await harness.checkpoint.tick();
    expect(skipped.skipped).toBe(true);
    expect(buffer.offsets.length).toBe(readsAfterFirstTick);

    harness.advance(1);
    await harness.checkpoint.tick();
    expect(harness.content).toBe(buffer.text);
  });

  it('checkpoints complete records to the partial and salvages them on a crash', async () => {
    const dir = tempDir();
    const outputPath = join(dir, 'session-crash.jsonl');
    const partialPath = resolvePartialRecordingPath(outputPath, existsSync);
    const buffer = fakeBuffer(recordLine(0) + recordLine(1) + recordLine(2).slice(0, 12));
    let clock = 0;

    const checkpoint = createRecordingCheckpoint({
      partialPath,
      readChunk: buffer.readChunk,
      appendText: (path, text) => appendFileSync(path, text),
      truncateFile: (path) => writeFileSync(path, ''),
      intervalMs: 1_000,
      now: () => clock,
      chunkChars: 64,
    });

    await checkpoint.tick();
    const written = readFileSync(partialPath, 'utf8');
    expect(written).toBe(recordLine(0) + recordLine(1));
    expect(parseTelemetryJsonl(written).skipped).toBe(0);

    const result = await finaliseRecording({
      reason: 'target_closed',
      outputPath,
      partialPath,
      capturedBytes: checkpoint.bytesWritten,
      readJsonl: () => Promise.resolve(''),
      writeRecording: (path: string, data: string) => writeFileSync(path, data),
      removeFile: (path: string) => rmSync(path, { force: true }),
      log: () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.salvaged).toBe(true);
    expect(result.partialPath).toBe(partialPath);
    expect(existsSync(outputPath)).toBe(false);
    expect(readFileSync(partialPath, 'utf8')).toBe(written);
  });

  it('salvages to a collision-safe partial, leaving an existing final recording untouched', async () => {
    const dir = tempDir();
    const outputPath = join(dir, 'session-x.jsonl');
    const existingFinal = recordLine(99);
    writeFileSync(outputPath, existingFinal);

    // An earlier salvage already occupies the documented partial path.
    const earlierPartial = partialPathForJsonl(outputPath);
    const earlierSalvage = recordLine(50);
    writeFileSync(earlierPartial, earlierSalvage);

    const partialPath = resolvePartialRecordingPath(outputPath, existsSync);
    expect(partialPath).toBe(join(dir, 'session-x.partial-2.jsonl'));
    const salvagedLines = recordLine(0) + recordLine(1);
    writeFileSync(partialPath, salvagedLines);

    const writeRecording = vi.fn();
    const result = await finaliseRecording({
      reason: 'target_closed',
      outputPath,
      partialPath,
      capturedBytes: salvagedLines.length,
      readJsonl: () => Promise.resolve(''),
      writeRecording,
      removeFile: vi.fn(),
      log: () => {},
    });

    expect(result.exitCode).toBe(1);
    expect(result.salvaged).toBe(true);
    expect(result.partialPath).toBe(partialPath);
    // The salvage never writes the final recording and never overwrites it.
    expect(writeRecording).not.toHaveBeenCalled();
    expect(readFileSync(outputPath, 'utf8')).toBe(existingFinal);
    expect(readFileSync(earlierPartial, 'utf8')).toBe(earlierSalvage);
    expect(readFileSync(partialPath, 'utf8')).toBe(salvagedLines);
  });
});

describe('runRecordingWaitLoop onTick hook (AH-0MVWIDN5G006IZ58)', () => {
  it('awaits the checkpoint hook between polls', async () => {
    const { stop, setRequested } = fakeStop();
    let ticks = 0;
    let waits = 0;

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: false }),
      stop,
      now: Date.now,
      wait: () => {
        waits += 1;
        if (waits >= 2) setRequested(true);
        return Promise.resolve();
      },
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
      onTick: () => {
        ticks += 1;
      },
    });

    expect(reason).toBe('sigint');
    expect(ticks).toBe(waits);
  });

  it('routes an onTick target-closed failure to the interruption path', async () => {
    const { stop } = fakeStop();

    const reason = await runRecordingWaitLoop({
      evaluate: () => Promise.resolve({ ended: false }),
      stop,
      now: Date.now,
      wait: vi.fn(),
      maxDurationMs: 30_000,
      pollMs: 250,
      auto: false,
      onTick: () => Promise.reject(new Error('Target page, context or browser has been closed')),
    });

    expect(reason).toBe('target_closed');
  });
});
