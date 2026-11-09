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
  finaliseRecording,
  formatLostRecordingLine,
  isTargetClosedError,
  LOST_RECORDING_MESSAGE,
  partialPathForJsonl,
  runRecordingWaitLoop,
} from './record-session.mjs';

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
