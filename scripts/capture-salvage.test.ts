/**
 * Hermetic tests for graceful capture failure with salvage of streamed bytes
 * (AH-0MVNT29MC008BQPY, parent AH-0MVN06MS9007LRKE).
 *
 * A pipe/browser/recorder failure used to kill the process with a raw
 * Playwright stack and nothing on disk. The bounded sink already keeps every
 * streamed byte at `<stem>.partial.webm`, but nothing reported it: the failure
 * escaped as an opaque error. These tests pin down the salvage contract:
 *
 * - the streamed bytes survive at the documented `.partial.webm` path;
 * - one actionable message names what failed, how many bytes were salvaged,
 *   where they are and what to do next;
 * - a failure that precedes any chunk reports nothing salvaged (and creates
 *   no stray empty partial);
 * - the message is a single line, so it can be printed first — before any raw
 *   stack or secondary diagnostics.
 *
 * Everything runs against a real temp directory and the real `node:fs` sink
 * defaults, so the on-disk assertions exercise the shipped write path.
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createChunkSink } from './capture-chunk-sink.mjs';
import {
  CaptureSalvageError,
  failureSalvageLine,
  formatSalvageMessage,
  salvageFailedCapture,
} from './capture-salvage.mjs';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aihell-capture-salvage-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('salvageFailedCapture (AH-0MVNT29MC008BQPY AC1/AC2)', () => {
  it('keeps the bytes already streamed at the documented .partial.webm path', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'gameplay-5.webm');
    const sink = createChunkSink({ outputPath });
    const streamed = Buffer.from('recorded before the browser died', 'utf8');
    sink.appendBase64(streamed.toString('base64'));

    const error = salvageFailedCapture({
      sink,
      outputPath,
      error: new Error('CDP pipe transport overflow (ERR_STRING_TOO_LONG)'),
    });

    // The throwable is a structured, actionable error (not a raw stack).
    expect(error).toBeInstanceOf(CaptureSalvageError);
    expect(error.code).toBe('CAPTURE_SALVAGED');
    expect(error.reason).toBe(
      'CDP pipe transport overflow (ERR_STRING_TOO_LONG)',
    );
    expect(error.salvage).toMatchObject({
      outputPath,
      partialPath: join(dir, 'gameplay-5.partial.webm'),
      bytesSalvaged: streamed.length,
    });

    // AC1: the streamed bytes are on disk at the documented salvage path and
    // the finished-clip path is left absent so a half-run is never mistaken
    // for a complete clip.
    expect(existsSync(join(dir, 'gameplay-5.partial.webm'))).toBe(true);
    expect(readFileSync(join(dir, 'gameplay-5.partial.webm'))).toEqual(streamed);
    expect(existsSync(outputPath)).toBe(false);
  });

  it('emits one actionable message naming the failure, bytes, path and next action', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'clip.webm');
    const sink = createChunkSink({ outputPath });
    sink.appendBase64(Buffer.from('salvage me', 'utf8').toString('base64'));

    const error = salvageFailedCapture({
      sink,
      outputPath,
      error: new Error('recorder stopped unexpectedly'),
    });

    // One line only, so it can be printed first (AC2).
    expect(error.message).not.toContain('\n');
    expect(error.message).toContain('recorder stopped unexpectedly');
    expect(error.message).toContain(`${'salvage me'.length} B`);
    expect(error.message).toContain('clip.partial.webm');
    expect(error.message).toContain('re-run the capture');
    // FailureSalvageLine is the same single line consumers print (it expects
    // a failure record, so wrap the salvage report in one).
    expect(
      failureSalvageLine({ ok: false, salvageMessage: error.salvage.message }),
    ).toBe(error.message);
  });

  it('reports nothing salvaged when the failure precedes any chunk', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'never-recorded.webm');
    const sink = createChunkSink({ outputPath });

    const error = salvageFailedCapture({
      sink,
      outputPath,
      error: new Error('no supported WebM MediaRecorder codec'),
    });

    expect(error.salvage).toMatchObject({
      outputPath,
      bytesSalvaged: 0,
      partialPath: null,
    });
    expect(error.message).toContain('nothing to salvage');
    expect(error.message).toContain('re-run the capture');
    // No stray zero-byte partial for a run that never streamed a byte.
    expect(existsSync(join(dir, 'never-recorded.partial.webm'))).toBe(false);
  });

  it('preserves a clip that was already finalised successfully (post-rename failure)', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'complete.webm');
    const sink = createChunkSink({ outputPath });
    sink.appendBase64(Buffer.from('complete clip', 'utf8').toString('base64'));
    sink.finalise({ success: true });

    const error = salvageFailedCapture({
      sink,
      outputPath,
      // A failure after the rename (e.g. a diagnostics sidecar write) must not
      // report the finished clip as a partial.
      error: new Error('diagnostics write failed'),
    });

    expect(error.salvage.bytesSalvaged).toBe('complete clip'.length);
    expect(error.salvage.partialPath).toBe(outputPath);
    expect(readFileSync(outputPath, 'utf8')).toBe('complete clip');
  });
});

describe('formatSalvageMessage (AC2)', () => {
  it('describes a salvaged run with bytes, path and the next action', () => {
    const message = formatSalvageMessage({
      reason: 'transport overflow',
      bytesSalvaged: 268_435_456,
      partialPath: 'out/clip.partial.webm',
    });

    expect(message).toContain('transport overflow');
    expect(message).toContain('268435456 B');
    expect(message).toContain('256.00 MiB');
    expect(message).toContain('out/clip.partial.webm');
    expect(message).toContain('re-run the capture');
    expect(message).not.toContain('\n');
  });

  it('collapses a multi-line underlying error to a single line', () => {
    const message = formatSalvageMessage({
      reason: 'first line of the failure\nsecond line\n  at stack',
      bytesSalvaged: 0,
      partialPath: null,
    });

    expect(message).toContain('first line of the failure');
    expect(message).not.toContain('second line');
    expect(message).not.toContain('\n');
  });

  it('degrades to a useful message when the reason is empty', () => {
    const message = formatSalvageMessage({
      reason: '',
      bytesSalvaged: 0,
      partialPath: null,
    });

    expect(message).toContain('Capture failed');
    expect(message).toContain('re-run the capture');
  });
});

describe('failureSalvageLine (AC2/AC3)', () => {
  it('returns the single actionable line for a failed record', () => {
    expect(
      failureSalvageLine({
        ok: false,
        salvageMessage: 'Capture failed (boom): salvaged 3 B … Next: re-run.',
      }),
    ).toBe('Capture failed (boom): salvaged 3 B … Next: re-run.');
  });

  it('returns null for a successful or salvage-less record', () => {
    expect(failureSalvageLine({ ok: true, salvageMessage: 'x' })).toBeNull();
    expect(failureSalvageLine({ ok: false })).toBeNull();
    expect(failureSalvageLine(null)).toBeNull();
  });
});
