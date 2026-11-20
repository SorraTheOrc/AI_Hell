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
 * ## Scope: what this fixture can — and cannot — prove (AH-0MVWN4I95005HBJG)
 *
 * The synthetic fixture is deliberately ~5 s long (two 3.2 s / 2.6 s sources,
 * one action peak each): lengthening it is ruled out by the measured ~140 s
 * cost (AH-0MVF6VQ7G005ALXZ) and by the producer decision that gated this
 * suite as the expensive `e2e` type (AH-0MVFSNO0G00035AP). It therefore
 * **cannot** satisfy the editorial package-size targets — promo 45–60 s,
 * showreel > 2 min, 5 highlight clips (`EDITORIAL_CONFIG.targets`, product
 * requirements from AH-0MVDV50Z20071RF4, never lowered for a test).
 *
 * So this test asserts exactly the contract the fixture can prove, strictly:
 * every deliverable validates (vp9 960×540 + Opus, non-black, its expected
 * `Σ cuts − Σ fades` duration), the promo's pace band passes, and the size
 * gate returns the **expected rejection** for a deliberately short package —
 * `targets.ok === false` with target-specific issues, and a non-zero exit
 * whose *only* error is that size verdict. Sizing on real footage is covered
 * by the `assessTargets`
 * unit tests in `compile-promo.test.ts` and by `npm run capture:promo` against
 * a real capture pool (see `docs/dev/action-intensity.md` §7.6).
 *
 * The cross-fade work (parent AH-0MWLYWYGK004JR2A) is proved here too: the
 * promo's cut junction is a real `xfade`/`acrossfade` pair, so this file
 * asserts the report's `transitions` settings, the expected (net-of-dissolve)
 * duration, and that the demuxed audio and video streams end within one frame
 * of each other after a real encode. No extra encode pass is added — the
 * alignment check demuxes packet timestamps from the same single compile.
 *
 * Skipped when ffmpeg/ffprobe are unavailable.
 *
 * @vitest-environment node
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { CompileResult } from './compile-promo.mjs';
import {
  BLACK_FRAME_YAVG_FLOOR,
  CAPTURE_OUTPUT_DIR,
  DELIVERABLE_FPS,
  DELIVERABLE_HEIGHT,
  DELIVERABLE_TARGETS,
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

/**
 * The end timestamp (s) of one stream, read from its **packets**.
 *
 * A WebM/Matroska container carries no per-stream `duration`, so the audio and
 * video timelines cannot be compared from `ffprobe -show_streams`. Demuxing
 * the packet timestamps is the cheap, encoder-free way to measure where each
 * stream actually ends — which is exactly the audio-vs-picture alignment
 * AH-0MWM28ZOT0067JQW has to guarantee.
 */
function streamEndSec(file: string, stream: 'v:0' | 'a:0') {
  const out = execFileSync(
    'ffprobe',
    [
      '-v', 'error',
      '-select_streams', stream,
      '-show_entries', 'packet=pts_time,duration_time',
      '-of', 'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  );
  let end = 0;
  for (const line of out.split('\n')) {
    const [pts, length] = line.split(',');
    const start = Number(pts);
    if (!Number.isFinite(start)) continue;
    const duration = Number(length);
    end = Math.max(end, start + (Number.isFinite(duration) ? duration : 0));
  }
  return end;
}

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

    it('compiles real WebM deliverables, validates them and reports the expected size verdict', () => {
      const result = compilePromoMain([
        '--compile',
        '--runs', `${runA},${runB}`,
        '--out', planPath,
        '--out-dir', outDir,
      ]);

      // The compile's own stdout + report are the diagnostic for every
      // assertion below: a real regression names the deliverable or target
      // that drifted instead of only "expected 1 to be 0".
      const reportPath = `${outDir}/compile-promo-report.json`;
      expect(
        existsSync(reportPath),
        `compile wrote no report at ${reportPath}\n--- stdout ---\n${result.stdout}`,
      ).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf8')) as CompileResult['report'];
      const diagnostics =
        `exit ${result.code}\n--- stdout ---\n${result.stdout}\n--- report errors ---\n` +
        report.errors.join('\n');
      const why = (label: string) => `${label}\n${diagnostics}`;

      expect(existsSync(planPath), why('edit plan was not written')).toBe(true);

      // ── Per-deliverable validation (the real-encoder contract) ──
      // Every synthetic deliverable must encode and validate: vp9 960×540,
      // Opus audio, non-trivial brightness. A failure here is real drift.
      expect(
        report.deliverables
          .filter((deliverable) => !deliverable.ok)
          .map((deliverable) => `${deliverable.name}: ${deliverable.issues.join('; ')}`),
        why('per-deliverable validation failed'),
      ).toEqual([]);
      expect(report.deliverables.map((deliverable) => deliverable.name), diagnostics).toEqual([
        'promo',
        'showreel',
        'highlight-01',
        'highlight-02',
      ]);
      for (const deliverable of report.deliverables) {
        const label = `${deliverable.name} (${deliverable.output})`;
        expect(deliverable.probe.codec, why(`${label}: not VP9`)).toBe('vp9');
        expect(deliverable.probe.width, why(`${label}: wrong width`)).toBe(DELIVERABLE_WIDTH);
        expect(deliverable.probe.height, why(`${label}: wrong height`)).toBe(DELIVERABLE_HEIGHT);
        expect(deliverable.probe.audioCodec, why(`${label}: no Opus audio track`)).toBe('opus');
        // Every synthetic deliverable is a non-empty clip bounded by the
        // mapped fixture windows (the promo/showreel dissolve both runs,
        // ~4.7 s of cuts) — an empty or absurdly long encode is drift, not a
        // size verdict.
        expect(deliverable.probe.durationSec, why(`${label}: no duration measured`)).not.toBeNull();
        expect(
          deliverable.probe.durationSec!,
          why(`${label}: unexpected duration`),
        ).toBeGreaterThan(1.0);
        // The plan's expected length — `Σ cuts − Σ dissolves` — is recorded
        // beside the measured one, and the real encoder must land on it. The
        // tolerance covers container/frame granularity only (≈0.2 s per
        // re-encoded cut, measured at label time, and a frame of transition
        // rounding); a wrong fade total or a reverted hard cut moves far more
        // than this.
        expect(
          deliverable.expectedDurationMs,
          why(`${label}: no expectedDurationMs in the report`),
        ).toEqual(expect.any(Number));
        expect(
          Math.abs(deliverable.probe.durationSec! - deliverable.expectedDurationMs! / 1000),
          why(
            `${label}: measured duration is not the expected Σ cuts − Σ fades ` +
              `(${deliverable.expectedDurationMs}ms)`,
          ),
        ).toBeLessThanOrEqual(0.5);
        expect(
          deliverable.brightness.sampledFrames,
          why(`${label}: no frames sampled for brightness`),
        ).toBeGreaterThan(0);
        expect(
          deliverable.brightness.maxYavg,
          why(`${label}: no brightness measurement`),
        ).not.toBeNull();
        expect(
          deliverable.brightness.maxYavg!,
          why(`${label}: output is black (below the calibrated floor)`),
        ).toBeGreaterThan(BLACK_FRAME_YAVG_FLOOR);
      }

      // ── Pace band, measured on the delivered promo ──
      expect(report.pace, why('no pace verdict in the report')).not.toBeNull();
      expect(
        report.pace?.ok,
        why(`promo pace below the documented band: ${JSON.stringify(report.pace?.issues)}`),
      ).toBe(true);

      // ── Editorial size gate: the *expected* rejection ──
      // The fixture is deliberately ~5 s, so the product's 45–60 s / > 2 min /
      // 5-clip targets cannot be met. Asserting the rejection (rather than
      // relaxing the exit code) keeps the gate exercised and names the reason.
      expect(
        report.targets.ok,
        why('the editorial size gate unexpectedly passed for a ~5 s fixture'),
      ).toBe(false);
      const targetIssues = report.targets.issues.join('\n');
      expect(targetIssues, why('no promo under-size issue')).toMatch(
        new RegExp(
          `^promo is [\\d.]+s, below the ${(DELIVERABLE_TARGETS.promo.minMs / 1000).toFixed(1)}s target`,
          'm',
        ),
      );
      expect(targetIssues, why('no showreel under-size issue')).toMatch(
        new RegExp(
          `^showreel is [\\d.]+s, below the ${(DELIVERABLE_TARGETS.showreel.minMs / 1000).toFixed(1)}s target`,
          'm',
        ),
      );
      expect(targetIssues, why('no missing-highlight issue')).toContain(
        `only 2 highlight clip(s) produced, target ${DELIVERABLE_TARGETS.highlights.count}`,
      );

      // ── The exit code is the size verdict and nothing else ──
      // Any other error (a deliverable or the pace gate failing) changes this
      // list, so the non-zero exit can never mask real validation drift.
      expect(report.ok, why('report.ok must reflect the failing size gate')).toBe(false);
      expect(
        report.errors,
        why('compile errors are not exactly the expected size verdict'),
      ).toEqual([`deliverable targets: ${report.targets.issues.join('; ')}`]);
      expect(
        result.code,
        why('the compile must exit non-zero for the undersized fixture'),
      ).toBe(1);
      expect(result.stdout, diagnostics).toContain('targets FAIL');
      expect(result.stdout, diagnostics).toContain('pace OK');

      const promoPath = deliverableOutputPath('promo', 1, outDir);
      expect(existsSync(promoPath), diagnostics).toBe(true);
      expect(existsSync(deliverableOutputPath('showreel', 1, outDir)), diagnostics).toBe(true);
      expect(existsSync(deliverableOutputPath('highlight', 1, outDir)), diagnostics).toBe(true);

      // ── The junction settings were actually applied (AH-0MWM295HP001X1ZU) ──
      // A silent opt-out to hard cuts (or a reverted default) would leave the
      // report without these values, or with `videoFadeMs: 0` — fail visibly.
      expect(report.transitions, why('the report carries no transitions block')).toEqual({
        videoFadeMs: 400,
        audioFadeMs: 500,
        maxFadeRatio: 0.25,
      });
      const promoDeliverable = report.deliverables.find((d) => d.name === 'promo')!;
      // Two cuts → exactly one dissolve: Σ cuts (4.7 s) − 0.4 s.
      expect(
        promoDeliverable.expectedDurationMs,
        why('the promo expected duration does not reflect the dissolve'),
      ).toBe(4_300);

      // The real output must pass the AC3 checks through the production probe
      // path: vp9 960×540 + opus audio, non-trivial brightness, and the
      // expected 2-segment promo duration.
      const probe = probeMediaSync(promoPath, {});
      expect(probe.ok, why(`promo probe failed: ${probe.error ?? 'unknown error'}`)).toBe(true);
      const video = probe.streams.find((s) => s.codecType === 'video');
      const audio = probe.streams.find((s) => s.codecType === 'audio');
      expect(video?.codecName, diagnostics).toBe('vp9');
      expect(video?.width, diagnostics).toBe(DELIVERABLE_WIDTH);
      expect(video?.height, diagnostics).toBe(DELIVERABLE_HEIGHT);
      expect(audio?.codecName, diagnostics).toBe('opus');
      // WebM durations live at the container level — probeMediaSync mirrors
      // the production path, so the format-duration fallback is exercised.
      const durationSec = probeVideoDurationSec(probe);
      expect(durationSec, diagnostics).not.toBeNull();
      // runA window [0.5s, 3.0s] + runB window [0s, 2.2s] = 4.7 s of cuts,
      // less the single 400 ms dissolve. The old "4.0 s–5.6 s" sanity bound is
      // now the arithmetic expectation: the delivered promo must match it
      // (within encode granularity), and its picture and sound must end
      // together rather than the audio running 100 ms short.
      expect(
        Math.abs(durationSec! - 4.3),
        why(`promo duration is not Σ cuts − Σ fades (4.3 s): ${durationSec}s`),
      ).toBeLessThanOrEqual(0.5);

      // Audio and picture end within one frame of each other (60 fps → 16.7 ms).
      // The 500 ms audio cross-fade is compensated per junction precisely so a
      // long deliverable cannot drift; on this single junction it must hold
      // after a real encode, not just in the argv arithmetic.
      const audioEndSec = streamEndSec(promoPath, 'a:0');
      const videoEndSec = streamEndSec(promoPath, 'v:0');
      expect(audioEndSec, why('no audio packets were demuxed from the promo')).toBeGreaterThan(0);
      expect(videoEndSec, why('no video packets were demuxed from the promo')).toBeGreaterThan(0);
      expect(
        Math.abs(videoEndSec - audioEndSec),
        why(
          `audio ends ${(videoEndSec - audioEndSec).toFixed(3)}s away from the picture ` +
            `(video ${videoEndSec.toFixed(3)}s, audio ${audioEndSec.toFixed(3)}s) — ` +
            'the per-junction audio compensation did not hold',
        ),
      ).toBeLessThanOrEqual(1 / DELIVERABLE_FPS + 1e-6);

      const brightness = sampleBrightnessSync(promoPath, {});
      expect(brightness.sampledFrames, diagnostics).toBeGreaterThan(0);
      expect(brightness.maxYavg, diagnostics).not.toBeNull();
      expect(brightness.maxYavg!, diagnostics).toBeGreaterThan(BLACK_FRAME_YAVG_FLOOR);
      // The gated `e2e` run shares the host with other agents' suites, so the
      // smoke encode can be slow; allow a generous bound (600 s).
    }, 600_000);
  },
);
