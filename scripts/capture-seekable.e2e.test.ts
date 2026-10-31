/**
 * Gated end-to-end verification of the seek-index remux
 * (AH-0MVMIK8EM001JAYR AC1/AC2/AC5).
 *
 * The hermetic suite in `capture-seekable.test.ts` proves the argv, the EBML
 * parsing and the orchestration with injected seams. This file proves the one
 * thing an injected seam cannot: that a **real** ffmpeg accepts the remux
 * command line, and that a real live-written (Chromium-shaped) WebM becomes
 * seekable — finite duration, Cues index, SeekHead referencing Info/Tracks/Cues
 * — with its VP9/Opus packets untouched.
 *
 * The fixture is a real clip written through a **pipe**, which is how the
 * MediaRecorder shape arises: ffmpeg cannot seek back in a non-seekable
 * output, so the file is written with `-live 1` semantics (unknown-size
 * Segment, no Cues, no Duration) exactly like a raw capture. It is then
 * remuxed by the production code path.
 *
 * Skipped when no remux-capable ffmpeg is available (the documented
 * zero-ffmpeg environment). Run on demand:
 *
 * ```bash
 * npx vitest run --project e2e
 * python3 ~/.pi/agent/skills/test/scripts/run_tests.py --type e2e
 * ```
 *
 * @vitest-environment node
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  inspectWebmSeekIndex,
  makeCaptureSeekable,
  resolveFfprobe,
  resolveRemuxCandidates,
  verifySeekableIndex,
} from './capture-seekable.mjs';

const CANDIDATES = resolveRemuxCandidates();

/** True when a candidate can actually remux VP9 (`-c copy` needs the bsf). */
function supportsVp9Remux(ffmpegPath: string): boolean {
  try {
    const out = execFileSync(ffmpegPath, ['-hide_banner', '-bsfs'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.includes('vp9_superframe');
  } catch {
    return false;
  }
}

const REMUX_FFMPEG = (() => {
  for (const candidate of CANDIDATES) {
    if (supportsVp9Remux(candidate.path)) return candidate.path;
  }
  return null;
})();

/** The system ffmpeg used only to *build* the fixture (full build needed). */
const FIXTURE_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return null;
  }
})();

describe.skipIf(!REMUX_FFMPEG || !FIXTURE_FFMPEG)(
  'e2e — a real remux makes a live-written WebM seekable (AH-0MVMIK8EM001JAYR)',
  () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'seekable-e2e-'));
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** A 1.5 s VP9+Opus clip written to a pipe: the MediaRecorder shape. */
    function writeLiveShapedClip(path: string): { sourcePath: string; sourceDuration: number } {
      const sourcePath = join(dir, `source-${Date.now()}.webm`);
      execFileSync(
        FIXTURE_FFMPEG!,
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc2=size=96x54:rate=10:duration=1.5',
          '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
          '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '40',
          '-deadline', 'realtime', '-cpu-used', '8',
          '-c:a', 'libopus', '-b:a', '64k',
          sourcePath,
        ],
        { stdio: 'ignore' },
      );
      // Remuxing to a pipe reproduces a live capture: no seek-back, so no
      // Duration, no Cues and an unknown-size Segment.
      const piped = execFileSync(
        FIXTURE_FFMPEG!,
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-i', sourcePath,
          '-c', 'copy', '-live', '1', '-f', 'webm', 'pipe:1',
        ],
        { maxBuffer: 32 * 1024 * 1024 },
      );
      writeFileSync(path, piped);
      return { sourcePath, sourceDuration: 1.5 };
    }

    it('adds Duration + Cues + SeekHead without changing the packets (AC1/AC2)', () => {
      const clipPath = join(dir, 'capture.webm');
      const { sourcePath } = writeLiveShapedClip(clipPath);

      // Precondition: the fixture really is the defect shape.
      const rawSize = readFileSync(clipPath).length;
      const before = inspectWebmSeekIndex(clipPath);
      expect(before.hasCues).toBe(false);
      expect(before.durationSeconds).toBeNull();
      expect(verifySeekableIndex({ filePath: clipPath, ffprobePath: null }).seekable).toBe(false);

      const outcome = makeCaptureSeekable({
        outputPath: clipPath,
        // Pin the resolved tool so the test exercises a remux-capable binary
        // even when the first candidate (e.g. an older Playwright ffmpeg) is not.
        env: { FFMPEG_BIN: REMUX_FFMPEG!, PATH: process.env.PATH ?? '' },
      });

      expect(outcome.ok).toBe(true);
      expect(outcome.attempted).toBe(true);
      // The pinned capable binary delivered the seek index.
      expect(outcome.source).toBe('FFMPEG_BIN');

      // AC1: finite, non-zero `format.duration` when ffprobe is present…
      const ffprobePath = resolveFfprobe({ env: process.env });
      const verification = verifySeekableIndex({ filePath: clipPath, ffprobePath });
      expect(verification.seekable).toBe(true);
      expect(verification.durationSeconds).not.toBeNull();
      expect(verification.durationSeconds!).toBeGreaterThan(1.0);
      expect(verification.durationSeconds!).toBeLessThan(2.2);
      if (ffprobePath) expect(verification.durationSource).toBe('ffprobe');

      // …and the EBML structure carries the seek index the AC names.
      const after = inspectWebmSeekIndex(clipPath);
      expect(after.segmentSizeKnown).toBe(true);
      expect(after.hasCues).toBe(true);
      expect(after.hasSeekHead).toBe(true);
      expect(after.seekHeadTargets).toEqual(expect.arrayContaining(['Info', 'Tracks', 'Cues']));
      expect(after.seekHeadComplete).toBe(true);

      // AC2: packet-preserving — same codecs, same timeline content, no
      // re-encode (the remuxed payload is larger only by the index metadata).
      const probe = (path: string) =>
        execFileSync(
          'ffprobe',
          ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type', '-of', 'json', path],
          { encoding: 'utf8' },
        );
      const beforeStreams = JSON.parse(probe(sourcePath)).streams;
      const afterStreams = JSON.parse(probe(clipPath)).streams;
      expect(afterStreams).toEqual(beforeStreams);
      expect(afterStreams.map((stream: { codec_name: string }) => stream.codec_name)).toEqual([
        'vp9',
        'opus',
      ]);

      // The delivered file is the remuxed one, and its reported size is the
      // on-disk size the capture will report.
      const delivered = readFileSync(clipPath);
      expect(delivered.length).toBeGreaterThan(0);
      expect(outcome.bytes).toBe(delivered.length);
      // The index metadata (Duration + SeekHead + Cues) is additive on top of
      // the untouched packets, so the delivered clip is strictly larger.
      expect(delivered.length).toBeGreaterThan(rawSize);
    });

    it('leaves an unseekable capture intact when no usable ffmpeg is found (AC4)', () => {
      const clipPath = join(dir, 'no-tool.webm');
      writeLiveShapedClip(clipPath);
      const raw = readFileSync(clipPath);

      const outcome = makeCaptureSeekable({
        outputPath: clipPath,
        env: { PATH: '/nonexistent' },
        exists: (path: string) => path === clipPath,
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.warning).toContain('NOT seekable');
      expect(outcome.warning).toContain('FFMPEG_BIN');
      // The capture still produced a clip — untouched, byte for byte.
      expect(readFileSync(clipPath)).toEqual(raw);
    });
  },
);
