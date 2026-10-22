/**
 * Gated end-to-end smoke test for the promo compiler: the **real** ffmpeg
 * binary over synthetic footage (AH-0MVDV4PNZ004ZWOZ AC6).
 *
 * Moved out of `compile-promo.test.ts` by AH-0MVFSNO0G00035AP (producer
 * decision, 2026-10-19) because it is the full suite's single most expensive
 * test: it runs the production compile end to end (960x540@60 VP9 re-encode of
 * the promo/showreel/highlight deliverables plus brightness validation via
 * ffprobe) and cost ~140 s — the whole `scripts/` group's floor.
 *
 * It is **not** part of the audit-accepted full suite (`npm --silent test` /
 * `/skill:test --type full`, which select the `unit` and `integration`
 * projects). Run it on demand (and in release verification) with:
 *
 * ```bash
 * npx vitest run --project e2e
 * # or the sanctioned typed run (independent cache key):
 * python3 ~/.pi/agent/skills/test/scripts/run_tests.py --type e2e
 * ```
 *
 * Everything it asserts is *also* covered without a real encoder by the
 * injected-subprocess suites still in `compile-promo.test.ts` (command
 * building, probe/brightness parsing, validation verdict, compile
 * orchestration) — only the "a real ffmpeg accepts this command line and
 * produces a probe-able vp9/opus WebM" contract lives here.
 *
 * Skipped when ffmpeg/ffprobe are unavailable.
 *
 * @vitest-environment node
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  BLACK_FRAME_YAVG_FLOOR,
  CAPTURE_OUTPUT_DIR,
  DELIVERABLE_HEIGHT,
  DELIVERABLE_WIDTH,
  compilePromoMain,
  deliverableOutputPath,
  probeMediaSync,
  probeVideoDurationSec,
  sampleBrightnessSync,
  sourceAnchorPath,
  sourceSeriesPath,
  sourceWebmPath,
} from './compile-promo.mjs';

const HAS_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const anchorJson = JSON.stringify({
  kind: 'capture-join-anchor',
  schemaVersion: 1,
  captureStartedAtEpochMs: 0,
  runStartedAtEpochMs: 0,
});

/** A one-peak synthetic action-intensity series (video time ≈ series time). */
function seriesFor(runId: string) {
  const isA = runId.endsWith('-a');
  const t = isA ? 2_000 : 1_200;
  return [
    JSON.stringify({
      schemaVersion: 1,
      runSeed: 7,
      sampleRateHz: 10,
      categories: ['playerBullets', 'drops', 'enemies', 'bosses'],
    }),
    JSON.stringify({
      t,
      intensity: isA ? 0.9 : 0.8,
      burstiness: 0.4,
      breakdown: isA ? { playerBullets: 2 } : { enemies: 2 },
    }),
    '',
  ].join('\n');
}

describe.skipIf(!HAS_FFMPEG)(
  'integration — real ffmpeg compile of synthetic footage (AH-0MVDV4PNZ004ZWOZ AC6)',
  () => {
    const tag = `itest-${process.pid}-${Date.now()}`;
    const runA = `${tag}-a`;
    const runB = `${tag}-b`;
    const outDir = `${CAPTURE_OUTPUT_DIR}/compile-${tag}`;
    const planPath = `${CAPTURE_OUTPUT_DIR}/compile-promo-plan-${tag}.json`;
    const created: string[] = [outDir, planPath];

    beforeAll(() => {
      mkdirSync(outDir, { recursive: true });
      // Short synthetic sources (just long enough for the mapped windows:
      // runA [0.5s, 3.0s], runB [0s, 2.2s]) keep the gated smoke encode cheap.
      //
      // Bounded (AH-0MVF6VQ7G005ALXZ): the fixtures are a *synthetic* colour
      // test pattern, not gameplay footage, so they are encoded at 320x180@30
      // with `-cpu-used 8` — ~18x fewer pixel-frames to encode in setup. The
      // production compile path (960x540@60 VP9 deliverables) is unchanged
      // and still exercised end to end below.
      //
      // Measured A/B on a contended 16-core host (load ~30, back-to-back):
      // original fixtures 140.9 s vs bounded fixtures 140.4 s for this file —
      // i.e. the setup encode is *not* the bottleneck; the dominant cost is
      // the production VP9 deliverable re-encode + brightness validation,
      // which cannot be reduced without changing production settings or
      // losing the real-ffmpeg coverage. See AH-0MVF6VQ7G005ALXZ.
      for (const [runId, freq, seconds] of [
        [runA, '440', '3.2'],
        [runB, '660', '2.6'],
      ] as const) {
        const webm = sourceWebmPath(runId);
        execFileSync(
          'ffmpeg',
          [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `testsrc2=size=320x180:rate=30:duration=${seconds}`,
            '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
            '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '35',
            '-deadline', 'realtime', '-cpu-used', '8',
            '-c:a', 'libopus', '-b:a', '96k',
            webm,
          ],
          { stdio: 'ignore' },
        );
        created.push(webm);
        const seriesPath = sourceSeriesPath(runId);
        writeFileSync(seriesPath, seriesFor(runId));
        created.push(seriesPath);
        writeFileSync(sourceAnchorPath(runId), anchorJson);
        created.push(sourceAnchorPath(runId));
      }
    }, 300_000);

    afterAll(() => {
      for (const path of created) rmSync(path, { recursive: true, force: true });
    });

    it('compiles real WebM deliverables and validates them via the CLI', () => {
      const result = compilePromoMain([
        '--compile',
        '--runs', `${runA},${runB}`,
        '--out', planPath,
        '--out-dir', outDir,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('all validated OK');
      expect(existsSync(planPath)).toBe(true);
      expect(existsSync(`${outDir}/compile-promo-report.json`)).toBe(true);

      const promoPath = deliverableOutputPath('promo', 1, outDir);
      expect(existsSync(promoPath)).toBe(true);
      expect(existsSync(deliverableOutputPath('showreel', 1, outDir))).toBe(true);
      expect(existsSync(deliverableOutputPath('highlight', 1, outDir))).toBe(true);

      // The real output must pass the AC3 checks: vp9 960×540 + opus audio,
      // non-trivial brightness, and the expected 2-segment promo duration.
      const probe = probeMediaSync(promoPath, {});
      expect(probe.ok).toBe(true);
      const video = probe.streams.find((s) => s.codecType === 'video');
      const audio = probe.streams.find((s) => s.codecType === 'audio');
      expect(video?.codecName).toBe('vp9');
      expect(video?.width).toBe(DELIVERABLE_WIDTH);
      expect(video?.height).toBe(DELIVERABLE_HEIGHT);
      expect(audio?.codecName).toBe('opus');
      // WebM durations live at the container level — probeMediaSync mirrors
      // the production path, so the format-duration fallback is exercised.
      const durationSec = probeVideoDurationSec(probe);
      expect(durationSec).not.toBeNull();
      // runA window [0.5s, 3.0s] + runB window [0s, 2.2s].
      expect(durationSec!).toBeGreaterThan(4.0);
      expect(durationSec!).toBeLessThan(5.6);

      const brightness = sampleBrightnessSync(promoPath, {});
      expect(brightness.sampledFrames).toBeGreaterThan(0);
      expect(brightness.maxYavg).not.toBeNull();
      expect(brightness.maxYavg!).toBeGreaterThan(BLACK_FRAME_YAVG_FLOOR);
      // The gated `e2e` run shares the host with other agents' suites, so the
      // smoke encode can be slow; allow a generous bound (600 s).
    }, 600_000);
  },
);
