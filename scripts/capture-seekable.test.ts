/**
 * Hermetic unit tests for the seek-index remux (AH-0MVMIK8EM001JAYR).
 *
 * Every test here runs without a browser, without real footage and without a
 * real ffmpeg: the EBML parser is driven with synthetic bytes, and the remux
 * orchestration with an injected subprocess seam. The real-binary contract
 * (a real ffmpeg accepts the argv and produces a probe-able seekable WebM)
 * lives in `capture-seekable.e2e.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRemuxArgs,
  describeSeekableOutcome,
  inspectWebmSeekIndex,
  makeCaptureSeekable,
  parseFfprobeDuration,
  parseInfoAndSeekPayloads,
  readElementHeader,
  remuxSeekIndex,
  remuxTempPathFor,
  reportSeekableOutcome,
  resolveRemuxCandidates,
  scanWebmSeekIndex,
  unseekableCaptureWarning,
} from './capture-seekable.mjs';
import { createRecordingPipeline } from './capture-recording-pipeline.mjs';

// ---------------------------------------------------------------------------
// Synthetic EBML builders (the shapes Chromium and ffmpeg actually write)
// ---------------------------------------------------------------------------

const EBML_HEADER_ID = [0x1a, 0x45, 0xdf, 0xa3];
const SEGMENT_ID = [0x18, 0x53, 0x80, 0x67];
const SEEK_HEAD_ID = [0x11, 0x4d, 0x9b, 0x74];
const INFO_ID = [0x15, 0x49, 0xa9, 0x66];
const TRACKS_ID = [0x16, 0x54, 0xae, 0x6b];
const CUES_ID = [0x1c, 0x53, 0xbb, 0x6b];
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];
const SEEK_ID_ID = [0x53, 0xab];
const TIMECODE_SCALE_ID = [0x2a, 0xd7, 0xb1];
const DURATION_ID = [0x44, 0x89];

/** Encodes an EBML data size as a VINT (all-ones reserved for "unknown"). */
function encodeSize(value: number): Buffer {
  for (let length = 1; length <= 8; length += 1) {
    const max = 2 ** (7 * length) - 2;
    if (value <= max) {
      let remaining = BigInt(value) | (1n << BigInt(7 * length));
      const buffer = Buffer.alloc(length);
      for (let index = length - 1; index >= 0; index -= 1) {
        buffer[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
      }
      return buffer;
    }
  }
  throw new Error(`size ${value} does not fit in an EBML VINT`);
}

/** The "unknown size" VINT Chromium writes for the Segment and its clusters. */
const UNKNOWN_SIZE = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function element(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), encodeSize(payload.length), payload]);
}

function unknownSizeElement(id: number[], payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id), UNKNOWN_SIZE, payload]);
}

function seekHeadPayload(targets: Array<number[]>): Buffer {
  return Buffer.concat(
    targets.map((target) => element(SEEK_ID_ID, Buffer.from(target))),
  );
}

function infoPayload(options: { durationSeconds?: number; timecodeScaleNs?: number }): Buffer {
  const parts: Buffer[] = [];
  if (options.timecodeScaleNs !== undefined) {
    const scale = Buffer.alloc(3);
    scale.writeUIntBE(options.timecodeScaleNs, 0, 3);
    parts.push(element(TIMECODE_SCALE_ID, scale));
  }
  if (options.durationSeconds !== undefined) {
    const duration = Buffer.alloc(8);
    // Matroska stores Duration in TimecodeScale ticks, not seconds.
    const ticks = (options.durationSeconds * 1_000_000_000) / (options.timecodeScaleNs ?? 1_000_000);
    duration.writeDoubleBE(ticks, 0);
    parts.push(element(DURATION_ID, duration));
  }
  return Buffer.concat(parts);
}

/** A Chromium `MediaRecorder` clip: no Duration, no SeekHead, no Cues. */
function mediaRecorderShaped(): Buffer {
  const segment = unknownSizeElement(SEGMENT_ID, Buffer.concat([
    element(INFO_ID, infoPayload({ timecodeScaleNs: 1_000_000 })),
    element(TRACKS_ID, Buffer.from('track entries')),
    unknownSizeElement(CLUSTER_ID, Buffer.from('cluster payload')),
  ]));
  return Buffer.concat([element(EBML_HEADER_ID, Buffer.from('ebml header')), segment]);
}

/** An ffmpeg `-c copy` remux: known Segment size, Duration, SeekHead, Cues. */
function remuxedShaped(durationSeconds = 1.895): Buffer {
  const children = Buffer.concat([
    element(SEEK_HEAD_ID, seekHeadPayload([INFO_ID, TRACKS_ID, CUES_ID])),
    element(INFO_ID, infoPayload({ durationSeconds, timecodeScaleNs: 1_000_000 })),
    element(TRACKS_ID, Buffer.from('track entries')),
    element(CLUSTER_ID, Buffer.from('cluster payload')),
    element(CUES_ID, Buffer.from('cue entries')),
  ]);
  const segment = element(SEGMENT_ID, children);
  return Buffer.concat([element(EBML_HEADER_ID, Buffer.from('ebml header')), segment]);
}

function bufferSource(buffer: Buffer) {
  return {
    size: buffer.length,
    read(offset: number, length: number) {
      return buffer.subarray(offset, Math.min(offset + length, buffer.length));
    },
  };
}

// ---------------------------------------------------------------------------

describe('EBML element headers', () => {
  it('parses an element ID and a multi-byte size', () => {
    const header = readElementHeader(element(CUES_ID, Buffer.alloc(300)), 0)!;
    expect(header.name).toBe('Cues');
    expect(header.idLength).toBe(4);
    expect(header.size).toBe(300);
    expect(header.sizeLength).toBe(2);
    expect(header.unknownSize).toBe(false);
    expect(header.headerBytes).toBe(6);
  });

  it('recognises the unknown-size VINT Chromium writes', () => {
    const header = readElementHeader(
      Buffer.concat([Buffer.from(SEGMENT_ID), UNKNOWN_SIZE]),
      0,
    )!;
    expect(header.name).toBe('Segment');
    expect(header.unknownSize).toBe(true);
  });

  it('returns null for truncated or invalid input', () => {
    expect(readElementHeader(Buffer.alloc(0))).toBeNull();
    expect(readElementHeader(Buffer.from([0x00]))).toBeNull();
    expect(readElementHeader(Buffer.from(CUES_ID))).toBeNull();
  });

  it('parses SeekHead targets and the Info duration/timecode scale', () => {
    const seek = parseInfoAndSeekPayloads(seekHeadPayload([INFO_ID, TRACKS_ID, CUES_ID]));
    expect(seek.seekTargets).toEqual(['Info', 'Tracks', 'Cues']);

    const info = parseInfoAndSeekPayloads(
      infoPayload({ durationSeconds: 2.5, timecodeScaleNs: 1_000_000 }),
    );
    expect(info.timecodeScaleNs).toBe(1_000_000);
    // 2.5 s expressed in 1 ms ticks.
    expect(info.durationTicks).toBeCloseTo(2500, 6);
  });
});

describe('scanWebmSeekIndex — the reported defect', () => {
  it('reports a MediaRecorder clip as unseekable (no Duration, SeekHead or Cues)', () => {
    const scan = scanWebmSeekIndex(bufferSource(mediaRecorderShaped()));
    expect(scan.hasSegment).toBe(true);
    expect(scan.segmentSizeKnown).toBe(false);
    expect(scan.hasInfo).toBe(true);
    expect(scan.hasTracks).toBe(true);
    expect(scan.hasSeekHead).toBe(false);
    expect(scan.hasCues).toBe(false);
    expect(scan.seekHeadComplete).toBe(false);
    expect(scan.durationSeconds).toBeNull();
    // The unknown-size cluster stops the scan rather than guessing.
    expect(scan.truncated).toBe(true);
  });

  it('reports a remuxed clip as seekable (Duration + SeekHead → Info/Tracks/Cues + Cues)', () => {
    const scan = scanWebmSeekIndex(bufferSource(remuxedShaped(1.895)));
    expect(scan.hasCues).toBe(true);
    expect(scan.hasSeekHead).toBe(true);
    expect(scan.seekHeadTargets).toEqual(['Info', 'Tracks', 'Cues']);
    expect(scan.seekHeadComplete).toBe(true);
    expect(scan.durationSeconds).toBeCloseTo(1.895, 6);
  });

  it('reports a missing seek-index entry as incomplete rather than seekable', () => {
    const children = Buffer.concat([
      element(SEEK_HEAD_ID, seekHeadPayload([INFO_ID, TRACKS_ID])),
      element(INFO_ID, infoPayload({ durationSeconds: 1 })),
      element(TRACKS_ID, Buffer.from('tracks')),
      element(CUES_ID, Buffer.from('cues')),
    ]);
    const scan = scanWebmSeekIndex(
      bufferSource(Buffer.concat([element(EBML_HEADER_ID, Buffer.alloc(0)), element(SEGMENT_ID, children)])),
    );
    expect(scan.hasCues).toBe(true);
    expect(scan.seekHeadTargets).toEqual(['Info', 'Tracks']);
    expect(scan.seekHeadComplete).toBe(false);
    expect(scan.durationSeconds).toBeCloseTo(1, 6);
  });

  it('reads a real file through an fd without buffering it', () => {
    // Guards the file-backed source used in production (the buffer source
    // above cannot prove createFileScanSource works).
    const dir = mkdtempSync(join(tmpdir(), 'seekable-scan-'));
    try {
      const path = join(dir, 'clip.webm');
      writeFileSync(path, remuxedShaped(3.5));
      const scan = inspectWebmSeekIndex(path);
      expect(scan.seekHeadComplete).toBe(true);
      expect(scan.durationSeconds).toBeCloseTo(3.5, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('remux argv and duration parsing', () => {
  it('is packet-preserving: -c copy only, no encoder anywhere in the argv', () => {
    const args = buildRemuxArgs({ inputPath: '/out/clip.webm', tempPath: '/out/clip.seekable.webm' });
    expect(args).toContain('-c');
    expect(args[args.indexOf('-c') + 1]).toBe('copy');
    expect(args.join(' ')).not.toMatch(/libvpx|libopus|-crf|-b:v|libx264/);
    expect(args.slice(-1)).toEqual(['/out/clip.seekable.webm']);
    expect(args[args.indexOf('-i') + 1]).toBe('/out/clip.webm');
  });

  it('resolves the documented remux write target', () => {
    expect(remuxTempPathFor('/out/clip.webm')).toBe('/out/clip.seekable.webm');
    expect(remuxTempPathFor('/out/clip')).toBe('/out/clip.seekable.webm');
  });

  it('parses ffprobe format.duration and rejects a missing/non-finite one', () => {
    expect(parseFfprobeDuration('{"format":{"duration":"1.508000"}}')).toBeCloseTo(1.508, 6);
    expect(parseFfprobeDuration('{"format":{}}')).toBeNull();
    expect(parseFfprobeDuration('{"format":{"duration":"N/A"}}')).toBeNull();
    expect(parseFfprobeDuration('not json')).toBeNull();
  });
});

describe('resolveRemuxCandidates — documented resolution order (AC4)', () => {
  const existsAll = () => true;

  it('tries FFMPEG_BIN, then the Playwright-bundled binary, then PATH', () => {
    const candidates = resolveRemuxCandidates({
      env: { FFMPEG_BIN: '/custom/ffmpeg', PATH: '/usr/bin:/opt/bin' },
      exists: existsAll,
      loadRegistry: () => ({
        findExecutable: () => ({ executablePath: () => '/pw/ffmpeg-linux' }),
      }),
    });
    expect(candidates).toEqual([
      { path: '/custom/ffmpeg', source: 'FFMPEG_BIN' },
      { path: '/pw/ffmpeg-linux', source: 'playwright-bundled' },
      { path: '/usr/bin/ffmpeg', source: 'PATH' },
    ]);
  });

  it('skips absent binaries and de-duplicates the same path', () => {
    const candidates = resolveRemuxCandidates({
      env: { FFMPEG_BIN: '/missing/ffmpeg', PATH: '/pw:/usr/bin' },
      exists: (path) => path !== '/missing/ffmpeg',
      loadRegistry: () => ({
        findExecutable: () => ({ executablePath: () => '/pw/ffmpeg' }),
      }),
    });
    expect(candidates).toEqual([
      { path: '/pw/ffmpeg', source: 'playwright-bundled' },
      { path: '/usr/bin/ffmpeg', source: 'PATH' },
    ]);
  });

  it('degrades to no candidates when nothing is installed (the zero-ffmpeg story)', () => {
    const candidates = resolveRemuxCandidates({
      env: { PATH: '/usr/bin' },
      exists: () => false,
      loadRegistry: () => {
        throw new Error('playwright not installed');
      },
    });
    expect(candidates).toEqual([]);
  });
});

describe('makeCaptureSeekable — remux, verify, swap in only on success', () => {
  let dir: string;
  let clipPath: string;
  let rawClip: Buffer;

  const noPlaywright = () => {
    throw new Error('no playwright in this test');
  };

  /** A `run` seam that writes `payload` to the file ffmpeg was asked for. */
  const fakeRemuxWriting = (payload: Buffer, calls: Array<{ command: string; args: string[] }>) =>
    (command: string, args: string[]) => {
      calls.push({ command, args });
      writeFileSync(args[args.length - 1], payload);
      return { status: 0, stdout: '', stderr: '' };
    };

  const failing = (message: string, calls: Array<{ command: string; args: string[] }> = []) =>
    (command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 1, stdout: '', stderr: `${message}\nsecond line\n` };
    };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seekable-remux-'));
    clipPath = join(dir, 'clip.webm');
    rawClip = mediaRecorderShaped();
    writeFileSync(clipPath, rawClip);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('swaps a verified remux over the raw capture and reports the duration source', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcome = makeCaptureSeekable({
      outputPath: clipPath,
      env: { PATH: '/path' }, // no ffprobe → duration comes from the container
      exists: (path) => path === '/path/ffmpeg' || path === clipPath,
      loadRegistry: noPlaywright,
      run: fakeRemuxWriting(remuxedShaped(1.895), calls),
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe('PATH');
    expect(outcome.durationSeconds).toBeCloseTo(1.895, 6);
    expect(outcome.durationSource).toBe('ebml');
    expect(outcome.hasCues).toBe(true);
    expect(outcome.hasSeekHead).toBe(true);
    expect(outcome.seekHeadTargets).toEqual(['Info', 'Tracks', 'Cues']);
    expect(outcome.warning).toBeNull();
    // The delivered clip is the verified remux, not the raw capture.
    expect(readFileSync(clipPath)).toEqual(remuxedShaped(1.895));
    expect(outcome.bytes).toBe(remuxedShaped(1.895).length);
    expect(calls).toHaveLength(1);
  });

  it('falls through a candidate that cannot remux to the next one', () => {
    // Playwright ffmpeg revisions before 1013 lack the vp9_superframe filter,
    // so `-c copy` fails — the next candidate must be tried (AC4).
    const bundled = '/pw/ffmpeg-1011/ffmpeg-linux';
    const run = (command: string, args: string[]) => {
      if (command === bundled) {
        return { status: 1, stdout: '', stderr: "Unknown bitstream filter 'vp9_superframe'\n" };
      }
      writeFileSync(args[args.length - 1], remuxedShaped(1.895));
      return { status: 0, stdout: '', stderr: '' };
    };

    const outcome = makeCaptureSeekable({
      outputPath: clipPath,
      env: { PATH: '/usr/bin' },
      exists: (path) => path === bundled || path === '/usr/bin/ffmpeg' || path === clipPath,
      loadRegistry: () => ({
        findExecutable: () => ({ executablePath: () => bundled }),
      }),
      run,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.source).toBe('PATH');
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0].source).toBe('playwright-bundled');
    expect(outcome.attempts[0].error).toMatch(/vp9_superframe/);
  });

  it('keeps the raw capture when every candidate fails, and warns with the fix (AC4)', () => {
    const outcome = makeCaptureSeekable({
      outputPath: clipPath,
      env: { PATH: '/usr/bin' },
      exists: (path) => path === '/usr/bin/ffmpeg' || path === clipPath,
      loadRegistry: noPlaywright,
      run: failing('Unknown bitstream filter'),
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.warning).toContain('NOT seekable');
    expect(outcome.warning).toContain('fast-forward');
    expect(outcome.warning).toContain('sudo apt-get install ffmpeg');
    expect(outcome.warning).toContain('FFMPEG_BIN');
    expect(outcome.warning).toContain('Unknown bitstream filter');
    // The raw capture is byte-identical: a failed remux never destroys it.
    expect(readFileSync(clipPath)).toEqual(rawClip);
  });

  it('rejects a remux whose output is still unseekable', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const outcome = makeCaptureSeekable({
      outputPath: clipPath,
      env: { PATH: '/usr/bin' },
      exists: (path) => path === '/usr/bin/ffmpeg' || path === clipPath,
      loadRegistry: noPlaywright,
      // ffmpeg "succeeds" but writes the same cue-less container.
      run: fakeRemuxWriting(mediaRecorderShaped(), calls),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toHaveLength(1);
    expect(outcome.attempts[0].error).toMatch(/still unseekable/);
    expect(readFileSync(clipPath)).toEqual(rawClip);
  });

  it('warns without attempting when no ffmpeg can be resolved at all', () => {
    const outcome = makeCaptureSeekable({
      outputPath: clipPath,
      env: { PATH: '/usr/bin' },
      // The clip exists; every candidate binary is absent.
      exists: (path) => path === clipPath,
      loadRegistry: noPlaywright,
    });

    expect(outcome.attempted).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toEqual([]);
    expect(outcome.warning).toContain('no ffmpeg binary was found');
    expect(outcome.warning).toContain('Playwright-bundled');
    expect(readFileSync(clipPath)).toEqual(rawClip);
  });

  it('does nothing (and does not warn) when there is no clip on disk', () => {
    const outcome = makeCaptureSeekable({
      outputPath: join(dir, 'absent.webm'),
      env: { PATH: '/usr/bin' },
      exists: () => false,
      loadRegistry: noPlaywright,
    });
    expect(outcome.attempted).toBe(false);
    expect(outcome.warning).toBeNull();
  });

  it('verifies with ffprobe when it resolves (the AC1 duration source)', () => {
    const outcome = makeCaptureSeekable({
      outputPath: clipPath,
      env: { PATH: '/usr/bin' },
      exists: () => true,
      loadRegistry: noPlaywright,
      run: (command: string, args: string[]) => {
        if (command === '/usr/bin/ffprobe') {
          return { status: 0, stdout: '{"format":{"duration":"1.900000"}}', stderr: '' };
        }
        writeFileSync(args[args.length - 1], remuxedShaped(1.895));
        return { status: 0, stdout: '', stderr: '' };
      },
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.durationSource).toBe('ffprobe');
    expect(outcome.durationSeconds).toBeCloseTo(1.9, 6);
  });
});

describe('remuxSeekIndex', () => {
  it('reports the first stderr line of a failed remux', () => {
    const result = remuxSeekIndex({
      inputPath: '/out/clip.webm',
      tempPath: '/out/clip.seekable.webm',
      ffmpegPath: '/usr/bin/ffmpeg',
      run: () => ({ status: 1, stdout: '', stderr: "Unknown bitstream filter 'vp9_superframe'\nmore\n" }),
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(1);
    expect(result.error).toBe("Unknown bitstream filter 'vp9_superframe'");
  });

  it('treats a spawn failure as a failed attempt rather than throwing', () => {
    const result = remuxSeekIndex({
      inputPath: '/out/clip.webm',
      tempPath: '/out/clip.seekable.webm',
      ffmpegPath: '/nope/ffmpeg',
      run: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('spawn ENOENT');
  });
});

describe('operator reporting', () => {
  it('describes a successful remux with the duration and the tool source', () => {
    const described = describeSeekableOutcome({
      attempted: true,
      ok: true,
      source: 'playwright-bundled',
      durationSeconds: 1.895,
      durationSource: 'ffprobe',
    } as never);
    expect(described.level).toBe('info');
    expect(described.message).toContain('1.895s');
    expect(described.message).toContain('Cues');
    expect(described.message).toContain('playwright-bundled');
  });

  it('prefixes a failed remux with WARNING and emits it through the reporter', () => {
    const steps: string[] = [];
    const described = reportSeekableOutcome({ step: (message) => steps.push(message) }, {
      attempted: true,
      ok: false,
      warning: unseekableCaptureWarning({ attempts: [{ source: 'PATH', path: '/usr/bin/ffmpeg', error: 'boom' }] }),
    } as never);
    expect(described.level).toBe('warning');
    expect(steps).toHaveLength(1);
    expect(steps[0].startsWith('WARNING: ')).toBe(true);
    expect(steps[0]).toContain('boom');
  });

  it('says nothing when no remux was attempted', () => {
    const steps: string[] = [];
    reportSeekableOutcome({ step: (message) => steps.push(message) }, { attempted: false } as never);
    expect(steps).toEqual([]);
  });
});

describe('recording pipeline finalise seam (AC3)', () => {
  function fakePage() {
    return {
      addInitScript: async () => undefined,
      exposeFunction: async () => undefined,
    };
  }

  const sinkSeams = {
    mkdir: () => undefined,
    open: () => 1,
    write: (_fd: number, buffer: Buffer) => buffer.length,
    close: () => undefined,
    rename: () => undefined,
    remove: () => undefined,
  };

  let dir: string;
  let outputPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seekable-pipeline-'));
    outputPath = join(dir, 'clip.webm');
    // The sink's rename is faked, so the clip the pipeline remuxes must exist.
    writeFileSync(outputPath, mediaRecorderShaped());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes the delivered clip seekable exactly once, on a successful finalise', () => {
    const remuxCalls: string[] = [];
    const recording = createRecordingPipeline({
      page: fakePage() as never,
      outputPath,
      sinkOptions: sinkSeams as never,
      seekableOptions: {
        env: { PATH: '/usr/bin' },
        exists: (path: string) => path === outputPath || path === '/usr/bin/ffmpeg',
        loadRegistry: () => {
          throw new Error('none');
        },
        run: (_command: string, args: string[]) => {
          remuxCalls.push(args.join(' '));
          writeFileSync(args[args.length - 1], remuxedShaped(1.5));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });

    const written = recording.finalise({ success: true });
    expect(written.finalised).toBe(true);
    expect(written.seekable.ok).toBe(true);
    expect(remuxCalls).toHaveLength(1);

    // The memoised outcome makes the sink's "first finalise wins" contract hold
    // for the remux too — a second finalise never re-runs ffmpeg.
    const again = recording.finalise({ success: true });
    expect(remuxCalls).toHaveLength(1);
    expect(again.seekable.ok).toBe(true);
  });

  it('never remuxes a failed capture (the salvage path owns the partial file)', () => {
    const remuxCalls: string[] = [];
    const recording = createRecordingPipeline({
      page: fakePage() as never,
      outputPath,
      sinkOptions: sinkSeams as never,
      seekableOptions: {
        exists: () => true,
        run: (_command: string, args: string[]) => {
          remuxCalls.push(args.join(' '));
          return { status: 0, stdout: '', stderr: '' };
        },
      },
    });

    const written = recording.finalise({ success: false });
    expect(written.finalised).toBe(false);
    expect(written.seekable.attempted).toBe(false);
    expect(remuxCalls).toEqual([]);
  });

  it('honours the documented off switch for hermetic callers', () => {
    const remuxCalls: string[] = [];
    const recording = createRecordingPipeline({
      page: fakePage() as never,
      outputPath,
      sinkOptions: sinkSeams as never,
      seekable: false,
      seekableOptions: {
        run: () => {
          remuxCalls.push('remux');
          return { status: 0 };
        },
      },
    });

    const written = recording.finalise({ success: true });
    expect(written.seekable.attempted).toBe(false);
    expect(remuxCalls).toEqual([]);
  });
});
