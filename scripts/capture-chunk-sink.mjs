/**
 * Bounded chunk sink for streamed gameplay capture
 * (AH-0MVNT26AQ005LDNS, parent AH-0MVN06MS9007LRKE).
 *
 * Both capture paths (`captureClip` and `captureScenes`) used to accumulate
 * every decoded chunk in a node array and `Buffer.concat` once at the end:
 * for a 30-minute clip (≈1.8 GB at 8 Mbps) the whole recording had to fit in
 * the heap before a single byte was written. This sink replaces that array
 * with append-as-arrives semantics — each base64 chunk is decoded, appended
 * to the output file immediately and dropped, so peak node memory is O(one
 * chunk) rather than O(run duration).
 *
 * The write path is deliberately **synchronous**: each chunk is fully on disk
 * before the call returns and the decoded buffer can be dropped immediately
 * after, so the sink itself retains nothing (`pendingBytes` is always zero
 * between appends) and chunks arriving from overlapping page callbacks cannot
 * interleave or reorder.
 *
 * The sink writes to a temporary `<stem>.partial.webm` path and only renames
 * it into place when the caller reports success via `finalise({ success: true
 * })`. The rename/failure policy (salvage of streamed bytes) is exercised by
 * AH-0MVNT29MC008BQPY; here the seam is the `finalise` call and the
 * documented `partialPath`.
 *
 * A chunk larger than the configured cap is rejected **before** it is decoded
 * or written, with an actionable error naming the size and the cap. The page
 * side slices oversized payloads into at-or-below-cap binding calls
 * (AH-0MVNT27XR0080I3C), so the sink is the last-resort backstop that
 * guarantees no single retained buffer ever exceeds the cap (AC2).
 *
 * This module is plain ESM JavaScript with node built-ins only (plus the
 * shared run-lifecycle constants) so the capture tool runs without a
 * TypeScript loader; `capture-chunk-sink.d.mts` supplies the types.
 */

import { closeSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { formatByteSize } from './capture-diagnostics.mjs';
import { MAX_CAPTURE_CHUNK_BYTES } from './capture-run-lifecycle.mjs';

/**
 * Suffix inserted before the clip extension for the streaming write target
 * (`<stem>.webm` → `<stem>.partial.webm`). On success the sink renames it
 * into place; on failure it is left in place as the documented salvage path.
 */
export const CHUNK_SINK_PARTIAL_SUFFIX = '.partial.webm';

/**
 * Resolves the documented partial path for a clip path: insert
 * `CHUNK_SINK_PARTIAL_SUFFIX` before the `.webm` extension, or append it when
 * the path has no `.webm` extension at all.
 *
 * @param {string} outputPath — final clip path (e.g. `out/clip.webm`).
 * @returns {string} e.g. `out/clip.partial.webm`.
 */
export function partialPathFor(outputPath) {
  const target = typeof outputPath === 'string' ? outputPath : '';
  const match = /\.webm$/i.exec(target);
  return match
    ? `${target.slice(0, match.index)}${CHUNK_SINK_PARTIAL_SUFFIX}`
    : `${target}${CHUNK_SINK_PARTIAL_SUFFIX}`;
}

/**
 * Error thrown when a single chunk exceeds the configured cap, before the
 * payload is decoded (so the oversized buffer is never even allocated).
 *
 * @extends Error
 */
export class CaptureChunkTooLargeError extends Error {
  /**
   * @param {number} sizeBytes — the offending payload size (base64 length
   *   converted back to estimated raw bytes).
   * @param {number} capBytes — the configured per-chunk cap.
   */
  constructor(sizeBytes, capBytes) {
    super(
      `capture chunk of ${sizeBytes} B (${formatByteSize(sizeBytes)}) exceeds `
        + `the configured cap of ${capBytes} B (${formatByteSize(capBytes)}) — `
        + 'split the payload page-side before sending it (AH-0MVNT27XR0080I3C)',
    );
    this.name = 'CaptureChunkTooLargeError';
    this.code = 'CAPTURE_CHUNK_TOO_LARGE';
    this.sizeBytes = sizeBytes;
    this.capBytes = capBytes;
  }
}

/**
 * Creates a bounded sink that streams decoded chunks to `outputPath`.
 *
 * The sink opens the `.partial` write target lazily on the first append (and
 * creates missing parent directories). All filesystem calls are injectable so
 * hermetic tests can force fault paths, but the defaults are the real
 * `node:fs` calls — production never runs a mocked sink.
 *
 * @param {{
 *   outputPath: string,
 *   maxChunkBytes?: number,
 *   partialPath?: string,
 *   mkdir?: (dir: string, opts?: object) => unknown,
 *   open?: (path: string) => number,
 *   write?: (fd: number, buffer: import('node:buffer').Buffer) => number,
 *   close?: (fd: number) => void,
 *   rename?: (from: string, to: string) => void,
 *   remove?: (path: string) => void,
 * }} [options]
 * @returns {{
 *   outputPath: string,
 *   partialPath: string,
 *   maxChunkBytes: number,
 *   stats: () => object,
 *   appendBase64: (base64: string) => number,
 *   appendBuffer: (buffer: import('node:buffer').Buffer) => number,
 *   finalise: (opts?: { success?: boolean }) => object,
 *   close: () => void,
 * }}
 */
export function createChunkSink(options = {}) {
  const outputPath =
    typeof options.outputPath === 'string' ? options.outputPath : '';
  if (!outputPath) {
    throw new Error('createChunkSink requires an outputPath');
  }

  const capRaw = Number(options.maxChunkBytes);
  const maxChunkBytes =
    Number.isFinite(capRaw) && capRaw > 0
      ? Math.trunc(capRaw)
      : MAX_CAPTURE_CHUNK_BYTES;
  const partialPath =
    typeof options.partialPath === 'string' && options.partialPath
      ? options.partialPath
      : partialPathFor(outputPath);

  const ensureDir =
    typeof options.mkdir === 'function'
      ? options.mkdir
      : (dir) => mkdirSync(dir, { recursive: true });
  const openFile =
    typeof options.open === 'function'
      ? options.open
      : (path) => openSync(path, 'w');
  const writeChunk =
    typeof options.write === 'function'
      ? options.write
      : (fd, buffer) => writeSync(fd, buffer);
  const closeFile =
    typeof options.close === 'function'
      ? options.close
      : (fd) => closeSync(fd);
  const renameFile =
    typeof options.rename === 'function'
      ? options.rename
      : (from, to) => renameSync(from, to);
  const removeFile =
    typeof options.remove === 'function'
      ? options.remove
      : (path) => rmSync(path, { force: true });

  let fd = null;
  let bytesWritten = 0;
  let chunkCount = 0;
  let pendingBytes = 0;
  let peakPendingBytes = 0;
  let finalised = null;

  const stats = () => ({
    outputPath,
    partialPath,
    maxChunkBytes,
    bytesWritten,
    chunkCount,
    pendingBytes,
    peakPendingBytes,
  });

  const openLazily = () => {
    if (fd !== null) return fd;
    ensureDir(dirname(outputPath));
    fd = openFile(partialPath);
    return fd;
  };

  const releaseFile = () => {
    if (fd !== null) {
      const handle = fd;
      fd = null;
      closeFile(handle);
    }
  };

  /**
   * Writes one decoded buffer. Synchronous, so the caller's buffer can be
   * dropped the moment this returns; a partial `write` result is looped until
   * the whole chunk is on disk so `bytesWritten` never undercounts. A failed
   * write closes the handle (no leak) and rethrows.
   */
  const writeBuffer = (buffer) => {
    if (!buffer || typeof buffer.length !== 'number') {
      throw new TypeError('chunk sink requires a Buffer');
    }
    if (buffer.length > maxChunkBytes) {
      throw new CaptureChunkTooLargeError(buffer.length, maxChunkBytes);
    }

    const handle = openLazily();
    pendingBytes = buffer.length;
    if (pendingBytes > peakPendingBytes) peakPendingBytes = pendingBytes;
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeChunk(
          handle,
          offset === 0 ? buffer : buffer.subarray(offset),
        );
        if (!Number.isFinite(Number(written)) || Number(written) <= 0) {
          throw new Error('chunk sink write made no progress');
        }
        offset += Number(written);
      }
    } catch (error) {
      pendingBytes = 0;
      releaseFile();
      throw error;
    }
    bytesWritten += buffer.length;
    chunkCount += 1;
    pendingBytes = 0;
    return buffer.length;
  };

  const appendBase64 = (base64) => {
    if (typeof base64 !== 'string') {
      throw new TypeError('appendBase64 requires a base64 string');
    }
    // Reject an oversized payload *before* decoding: a payload that can only
    // represent more than the cap is refused without ever allocating the
    // decoded buffer. The exact check still runs post-decode in writeBuffer.
    const maxBase64Length = Math.floor(maxChunkBytes / 3) * 4 + 4;
    if (base64.length > maxBase64Length) {
      const estimatedBytes = Math.floor((base64.length * 3) / 4);
      throw new CaptureChunkTooLargeError(estimatedBytes, maxChunkBytes);
    }
    return writeBuffer(Buffer.from(base64, 'base64'));
  };

  /**
   * Closes the sink and, on success, renames the `.partial` file into place.
   *
   * The first call wins (idempotent): a later call with a different `success`
   * flag reports the same outcome rather than re-running the rename policy.
   *
   * @param {{ success?: boolean }} [opts] — `true` (the default) renames the
   *   partial file to `outputPath`; `false` leaves the partial file where it
   *   is, as the documented salvage seam for AH-0MVNT29MC008BQPY.
   * @returns {{
   *   outputPath: string,
   *   partialPath: string,
   *   finalised: boolean,
   *   bytesWritten: number,
   *   chunkCount: number,
   *   peakPendingBytes: number,
   * }}
   */
  const finalise = ({ success = true } = {}) => {
    if (finalised) return finalised;
    // An empty recording still produces an output file (the historical
    // behaviour wrote `Buffer.concat([])` up front); open + close creates the
    // zero-byte partial so the rename below always has a source.
    openLazily();
    releaseFile();

    if (success) {
      removeFile(outputPath);
      renameFile(partialPath, outputPath);
    }
    finalised = {
      outputPath,
      partialPath,
      finalised: success,
      bytesWritten,
      chunkCount,
      peakPendingBytes,
    };
    return finalised;
  };

  /** Releases the underlying file handle without renaming (abort path). */
  const close = () => {
    releaseFile();
  };

  return {
    outputPath,
    partialPath,
    maxChunkBytes,
    stats,
    appendBase64,
    appendBuffer: writeBuffer,
    finalise,
    close,
  };
}
