/**
 * Hermetic tests for the bounded recording chunk sink
 * (AH-0MVNT26AQ005LDNS, parent AH-0MVN06MS9007LRKE).
 *
 * The long-run capture crash is a CDP pipe overflow, but the second half of
 * the problem is node memory: both capture paths used to accumulate every
 * decoded chunk in an array and `Buffer.concat` once at the end, so a
 * 30-minute clip (≈1.8 GB at 8 Mbps) had to fit in node's heap. The sink
 * appends each decoded chunk to the output file as it arrives and drops it,
 * which is what these tests pin down:
 *
 * - bytes on disk equal the sum of the chunk sizes, in order;
 * - `peakPendingBytes` never exceeds a single chunk (the memory bound);
 * - nothing is retained after a write (`pendingBytes` returns to zero);
 * - a stream whose cumulative total exceeds the 512 MiB CDP pipe budget is
 *   written to a **temp file**, so the bound is proven without a 30-minute
 *   soak;
 * - the same chunk sequence run twice in fresh directories produces identical
 *   bytes and identical stats (idempotent, no cross-run state).
 *
 * Everything runs against a real temp directory with the real `node:fs`
 * defaults, so the test exercises the shipped write path rather than a mock
 * of it. The only injected calls are the two failure-path tests (a throwing
 * write, a close spy) where the fault cannot be produced otherwise.
 *
 * @vitest-environment node
 */

import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CDP_PIPE_STRING_LIMIT_CHARS } from './capture-diagnostics.mjs';
import {
  CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
  MAX_CAPTURE_CHUNK_BYTES,
} from './capture-run-lifecycle.mjs';
import {
  CaptureChunkTooLargeError,
  createChunkSink,
  partialPathFor,
} from './capture-chunk-sink.mjs';

const tempDirs: string[] = [];

/** Fresh temp directory per test (nothing is shared between runs). */
function tempDir(prefix = 'aihell-chunk-sink-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Streaming sha256 of a file, so a >512 MiB file is verified without buffering it. */
function fileDigest(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (part) => hash.update(part))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', rejectPromise);
  });
}

describe('partialPathFor (AH-0MVNT26AQ005LDNS AC5)', () => {
  it('derives the documented <stem>.partial.webm sibling of the clip', () => {
    expect(partialPathFor('capture-output/gameplay-1.webm')).toBe(
      'capture-output/gameplay-1.partial.webm',
    );
    expect(partialPathFor('/tmp/clips/GamePlay.WEBM')).toBe(
      '/tmp/clips/GamePlay.partial.webm',
    );
  });

  it('appends the partial suffix to a path without a .webm extension', () => {
    expect(partialPathFor('out/clip.mp4')).toBe('out/clip.mp4.partial.webm');
    expect(partialPathFor('out/clip')).toBe('out/clip.partial.webm');
  });
});

describe('chunk sink write path (AH-0MVNT26AQ005LDNS AC1/AC2/AC5)', () => {
  it('appends each decoded chunk as it arrives and finalises by rename', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'clip.webm');
    const sink = createChunkSink({ outputPath });

    const pieces = ['AAAA', 'BBBBBB', 'CCCC'];
    const decoded = pieces.map((piece) => Buffer.from(piece, 'base64'));
    for (const [index, piece] of pieces.entries()) {
      sink.appendBase64(piece);
      // Nothing is retained between writes: the decoded buffer is written and
      // dropped in the same call (AC1).
      expect(sink.stats().pendingBytes).toBe(0);
      expect(sink.stats().chunkCount).toBe(index + 1);
    }

    const expectedBytes = decoded.reduce((sum, part) => sum + part.length, 0);
    const before = sink.stats();
    expect(before.bytesWritten).toBe(expectedBytes);
    expect(before.chunkCount).toBe(pieces.length);
    // Every byte landed in the `.partial` file; the clip path does not exist
    // yet, because finalising is the caller's success signal (AC5).
    expect(existsSync(outputPath)).toBe(false);
    expect(readFileSync(sink.partialPath)).toEqual(Buffer.concat(decoded));
    expect(statSync(sink.partialPath).size).toBe(expectedBytes);

    const result = sink.finalise({ success: true });
    expect(result).toMatchObject({
      outputPath,
      finalised: true,
      bytesWritten: expectedBytes,
      chunkCount: pieces.length,
    });
    expect(existsSync(sink.partialPath)).toBe(false);
    expect(readFileSync(outputPath)).toEqual(Buffer.concat(decoded));
  });

  it('creates the output directory when it does not exist yet', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'nested', 'deeper', 'clip.webm');
    const sink = createChunkSink({ outputPath });

    sink.appendBase64(Buffer.from('streamed', 'utf8').toString('base64'));
    sink.finalise({ success: true });

    expect(readFileSync(outputPath, 'utf8')).toBe('streamed');
  });

  it('keeps the partial file when the caller reports failure', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'clip.webm');
    const sink = createChunkSink({ outputPath });

    sink.appendBase64(Buffer.from('salvage me', 'utf8').toString('base64'));
    const result = sink.finalise({ success: false });

    expect(result.finalised).toBe(false);
    expect(result.bytesWritten).toBe('salvage me'.length);
    // The bytes survive at the documented salvage path; the clip path stays
    // absent so a half-run can never be mistaken for a finished clip (AC5).
    expect(existsSync(outputPath)).toBe(false);
    expect(readFileSync(result.partialPath, 'utf8')).toBe('salvage me');
    expect(result.partialPath).toBe(join(dir, 'clip.partial.webm'));
  });

  it('treats a second finalise as a no-op reporting the same outcome', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'clip.webm');
    const sink = createChunkSink({ outputPath });

    sink.appendBase64(Buffer.from('once', 'utf8').toString('base64'));
    const first = sink.finalise({ success: true });
    const second = sink.finalise({ success: false });

    expect(second).toEqual(first);
    expect(readFileSync(outputPath, 'utf8')).toBe('once');
  });

  it('finalises an empty recording to an empty clip file', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'empty.webm');
    const sink = createChunkSink({ outputPath });

    const result = sink.finalise({ success: true });

    expect(result.bytesWritten).toBe(0);
    expect(result.chunkCount).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    expect(statSync(outputPath).size).toBe(0);
  });

  it('rejects a chunk above the cap before it is decoded or written (AC2)', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'clip.webm');
    const sink = createChunkSink({ outputPath });

    const oversized = Buffer.alloc(MAX_CAPTURE_CHUNK_BYTES + 1, 7).toString(
      'base64',
    );
    let thrown: unknown = null;
    try {
      sink.appendBase64(oversized);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CaptureChunkTooLargeError);
    const error = thrown as CaptureChunkTooLargeError;
    expect(error.code).toBe('CAPTURE_CHUNK_TOO_LARGE');
    expect(error.capBytes).toBe(MAX_CAPTURE_CHUNK_BYTES);
    expect(error.sizeBytes).toBeGreaterThan(MAX_CAPTURE_CHUNK_BYTES);
    expect(error.message).toContain('split');
    // Rejected before any allocation/write, so the sink is still empty and no
    // `.partial` file was created.
    expect(sink.stats()).toMatchObject({ bytesWritten: 0, chunkCount: 0 });
    expect(existsSync(sink.partialPath)).toBe(false);
  });

  it('propagates a write failure and releases the file handle', () => {
    const dir = tempDir();
    const outputPath = join(dir, 'clip.webm');
    const closed: number[] = [];
    const sink = createChunkSink({
      outputPath,
      // Simulate a full disk: the handle must not leak and no byte may be
      // counted as written.
      write: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      },
      close: (handle: number) => {
        closed.push(handle);
      },
    });

    expect(() =>
      sink.appendBase64(Buffer.from('lost', 'utf8').toString('base64')),
    ).toThrow(/ENOSPC/);
    expect(closed.length).toBe(1);
    expect(sink.stats()).toMatchObject({
      bytesWritten: 0,
      chunkCount: 0,
      pendingBytes: 0,
    });
  });

  it('uses the shared chunk cap by default and honours an explicit cap', () => {
    const dir = tempDir();
    const defaults = createChunkSink({ outputPath: join(dir, 'a.webm') });
    expect(defaults.stats().maxChunkBytes).toBe(MAX_CAPTURE_CHUNK_BYTES);

    const tiny = createChunkSink({
      outputPath: join(dir, 'b.webm'),
      maxChunkBytes: 8,
    });
    expect(tiny.stats().maxChunkBytes).toBe(8);
    expect(() =>
      tiny.appendBase64(Buffer.from('more than eight bytes').toString('base64')),
    ).toThrow(CaptureChunkTooLargeError);
    // Exactly the cap is still accepted.
    tiny.appendBase64(Buffer.from('12345678').toString('base64'));
    expect(tiny.stats().chunkCount).toBe(1);
  });
});

describe('chunk sink memory bound beyond the CDP pipe budget (AC3)', () => {
  it('writes >512 MiB in one-chunk-sized pieces with a flat pending bound', async () => {
    const dir = tempDir('aihell-chunk-sink-budget-');
    const outputPath = join(dir, 'long.webm');
    const sink = createChunkSink({ outputPath });

    const chunkBytes = MAX_CAPTURE_CHUNK_BYTES;
    const chunkCount = Math.ceil(
      (CDP_PIPE_STRING_LIMIT_CHARS + 1) / chunkBytes,
    );
    const totalBytes = chunkCount * chunkBytes;
    // The premise of the test: the stream is larger than what the CDP pipe's
    // undelimited buffer can ever hold, i.e. the old whole-run array approach
    // could not have kept this in the 512 MiB transport ceiling either.
    expect(totalBytes).toBeGreaterThan(CDP_PIPE_STRING_LIMIT_CHARS);

    const expectedHash = createHash('sha256');
    for (let index = 0; index < chunkCount; index += 1) {
      // Distinct fill per chunk so the digest proves ordering, not just size.
      const raw = Buffer.alloc(chunkBytes, (index % 251) + 1);
      expectedHash.update(raw);
      sink.appendBase64(raw.toString('base64'));

      const stats = sink.stats();
      expect(stats.pendingBytes).toBe(0);
      expect(stats.peakPendingBytes).toBeLessThanOrEqual(chunkBytes);
      expect(stats.bytesWritten).toBe((index + 1) * chunkBytes);
    }

    expect(statSync(sink.partialPath).size).toBe(totalBytes);
    expect(await fileDigest(sink.partialPath)).toBe(
      expectedHash.digest('hex'),
    );

    const result = sink.finalise({ success: true });
    expect(result.chunkCount).toBe(chunkCount);
    expect(result.bytesWritten).toBe(totalBytes);
    expect(result.peakPendingBytes).toBe(chunkBytes);
    expect(statSync(outputPath).size).toBe(totalBytes);
    // The whole stream is on disk and nothing is held in memory.
    expect(sink.stats().pendingBytes).toBe(0);
  }, 240_000);

  it('produces identical bytes and stats across repeated runs (fresh dirs)', async () => {
    const pieces = [
      Buffer.alloc(1024, 1),
      Buffer.alloc(4096, 2),
      Buffer.alloc(7, 3),
    ];
    const run = async () => {
      const dir = tempDir('aihell-chunk-sink-repeat-');
      const outputPath = join(dir, 'repeat.webm');
      const sink = createChunkSink({ outputPath });
      for (const piece of pieces) {
        sink.appendBase64(piece.toString('base64'));
      }
      const result = sink.finalise({ success: true });
      return { result, digest: await fileDigest(outputPath) };
    };

    const first = await run();
    const second = await run();

    expect(second.result).toEqual({
      ...first.result,
      outputPath: second.result.outputPath,
      partialPath: second.result.partialPath,
    });
    expect(second.digest).toBe(first.digest);
    expect(second.result.bytesWritten).toBe(
      pieces.reduce((sum, piece) => sum + piece.length, 0),
    );
  });
});

describe('shared capture limits (AC4)', () => {
  it('keeps one chunk far below the CDP pipe ceiling and the prefix budget above it', () => {
    // A single chunk must never be able to approach the 512 MiB string limit
    // the transport's `Buffer#toString()` hits, and the page-side/probe prefix
    // budget must hold several chunks.
    expect(MAX_CAPTURE_CHUNK_BYTES).toBeLessThan(
      CDP_PIPE_STRING_LIMIT_CHARS / 8,
    );
    expect(CAPTURE_PROBE_PREFIX_BUDGET_BYTES).toBeGreaterThanOrEqual(
      MAX_CAPTURE_CHUNK_BYTES,
    );
    expect(CAPTURE_PROBE_PREFIX_BUDGET_BYTES).toBeLessThan(
      CDP_PIPE_STRING_LIMIT_CHARS,
    );
  });
});
