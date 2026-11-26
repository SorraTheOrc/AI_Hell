/**
 * Gated end-to-end verification of the arc-planned promo
 * (AH-0MWM295HP001X1ZU AC1–AC6; parent AH-0MWLYWYGK004JR2A).
 *
 * The hermetic suite in `render-promo.test.ts` proves the argv and the
 * orchestration with injected seams. This file proves the thing a seam cannot:
 * that a **real** `vidc` accepts the `.otio` document the planner writes and
 * delivers a file whose measured duration matches the plan and whose picture
 * and sound end together.
 *
 * Two layers, deliberately:
 *
 * 1. **Always runs (no `vidc` needed).** The fixture corpus is planned through
 *    the production path (`planPromo`) and the emitted document is checked:
 *    four windows in arc order, the 34 s rendered total net of the fades, bare
 *    basenames in every `media_reference`, and a source range inside the clip.
 *    The argv contract is pinned here too — the explicit `--fade-duration`
 *    default present exactly once, and no `--resolution`/`--fps`/`--format`
 *    invented.
 * 2. **Gated on real binaries *and* renderer capability.** With `vidc` (or
 *    `VIDC_BIN`) plus ffmpeg / ffprobe available, the same corpus is rendered
 *    for real and probed back: the delivered duration is within the plan's
 *    tolerance and the audio and video ends differ by at most one frame. The
 *    leg activates only for a `vidc` whose compile plan carries per-clip
 *    bounds — a renderer that drops the document's `source_range` cannot
 *    deliver a trimmed arc-plan — and until `VC-0MWNOFIBI007J8UK` lands it
 *    skips with that work item named, so the missing capability is never
 *    mistaken for a passing test nor for a failure of this project.
 *
 * Skipped when `vidc` is not installed (the documented zero-vidc environment)
 * or when ffmpeg/ffprobe are absent, exactly like `capture-seekable.e2e.test.ts`
 * skips without a remux-capable ffmpeg. Run on demand:
 *
 * ```bash
 * npx vitest run --project e2e scripts/render-promo.e2e.test.ts
 * python3 ~/.pi/agent/skills/test/scripts/run_tests.py --type e2e
 * ```
 *
 * The fixture is **one** source clip plus its recorded sidecars — one fixture,
 * one render, no extra encode passes of the deliverable.
 *
 * @vitest-environment node
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFfprobe } from './capture-seekable.mjs';
import {
  buildFixtureAnchor,
  serialiseCaptureAnchor,
  serialisePlateauSeries,
} from './intensity-arc-fixtures.mjs';
import {
  DEFAULT_FADE_DURATION,
  buildVidcArgv,
  main,
  parseArgs,
  planPromo,
  resolveOutputPaths,
} from './render-promo.mjs';

/** The clip the fixture plans from — a bare basename, resolved by the `.otio`. */
const CLIP_FILE = 'clip1.webm';

/**
 * Series/video length. Every band needs its target plus the inter-window fade
 * compensation (34 s + 3 × 300 ms), so 56 s of footage — with every plateau
 * comfortably longer than its band target — leaves slack for the planner's
 * fade compensation (and for the larger explicit-fade determinism case)
 * without padding the render with dead frames.
 */
const FIXTURE_SECONDS = 56;
const FIXTURE_RATE = 30;
const FIXTURE_WIDTH = 320;
const FIXTURE_HEIGHT = 180;

/** Render resolution/fps: the same as the fixture, so the render stays quick. */
const RENDER_GEOMETRY = { resolution: `${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}`, fps: String(FIXTURE_RATE) };

/**
 * The recorded intensity plateaus, one per arc band, in **video** time.
 *
 * The join anchor has `offsetMs: 0` (capture start == run start), so series
 * time maps onto video time 1:1 and the four plateaus cover the whole clip.
 * The intensities sit inside their bands with room to spare: `high` 0.70
 * (0.65 ≤ I < 0.75), `medium` 0.45, `medium+` 0.60, `very high` 0.90.
 */
const PLATEAUS = [
  { fromT: 0, toT: 16_000, intensity: 0.9 },
  { fromT: 16_000, toT: 30_000, intensity: 0.7 },
  { fromT: 30_000, toT: 42_000, intensity: 0.6 },
  { fromT: 42_000, toT: 56_000, intensity: 0.45 },
];

/** The arc's rendered total: the sum of every band target (10 + 7 + 7 + 10). */
const ARC_RENDERED_SECONDS = 34;

/** The system ffmpeg/ffprobe used to build the fixture and probe the result. */
const FIXTURE_FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
    return 'ffmpeg';
  } catch {
    return null;
  }
})();

const FFPROBE = resolveFfprobe();

/**
 * The `vidc` executable, if the host has one: `VIDC_BIN` first (as the CLI
 * resolves it), then `vidc` on `PATH`. `null` ⇒ the render layer is skipped.
 */
const VIDC = (() => {
  const candidates = [process.env.VIDC_BIN, 'vidc'].filter(
    (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
  );
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--help'], { encoding: 'utf8' });
    if (probe.error === undefined && typeof probe.stdout === 'string' && probe.stdout.includes('render')) {
      return candidate;
    }
  }
  return null;
})();

/** Ends (start + duration) of a file's first video and first audio stream. */
function probeStreamEnds(path: string): { video: number | null; audio: number | null } {
  const json = execFileSync(
    FFPROBE!,
    [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,start_time,duration',
      '-of',
      'json',
      path,
    ],
    { encoding: 'utf8' },
  );
  const streams: Array<{ codec_type?: string; start_time?: string; duration?: string }> =
    JSON.parse(json).streams ?? [];
  const streamEnd = (type: string): number | null => {
    const stream = streams.find((entry) => entry.codec_type === type);
    const start = Number(stream?.start_time);
    const duration = Number(stream?.duration);
    if (!Number.isFinite(duration)) return null;
    return (Number.isFinite(start) ? start : 0) + duration;
  };
  return { video: streamEnd('video'), audio: streamEnd('audio') };
}

/**
 * Whether the installed `vidc` carries per-clip bounds from the document into
 * the plan it renders.
 *
 * `vidc compile --json` is read-only and probes no media, so it is a cheap
 * capability probe: while the compile plan lists clips with only a path and a
 * timeline index, the renderer ignores every `source_range` and a trimmed
 * arc-plan cannot be delivered. Carrying bounds there is exactly what
 * `VC-0MWNOFIBI007J8UK` ("Render integration honours clip bounds") delivers, so
 * this suite's render leg activates with that change and skips before it —
 * naming the blocker rather than failing, because the missing capability lives
 * in another project.
 */
function vidcCarriesClipBounds(
  vidcPath: string,
  documentPath: string,
): { ok: boolean; version: string } {
  const version = String(spawnSync(vidcPath, ['--version'], { encoding: 'utf8' }).stdout ?? '').trim();
  const probe = spawnSync(vidcPath, ['compile', '--json', documentPath], { encoding: 'utf8' });
  if (probe.status !== 0) return { ok: false, version };
  let plan: { clips?: Array<Record<string, unknown>> };
  try {
    plan = JSON.parse(String(probe.stdout));
  } catch {
    return { ok: false, version };
  }
  const boundKeys = [
    'in_seconds',
    'out_seconds',
    'inSeconds',
    'outSeconds',
    'source_range',
    'sourceRange',
    'trim',
    'bounds',
  ];
  const carries = (plan.clips ?? []).some((clip) =>
    boundKeys.some((key) => Object.prototype.hasOwnProperty.call(clip, key)),
  );
  return { ok: carries, version };
}

describe('capture:promo — the arc plan and the document it hands to vidc', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'render-promo-e2e-'));
    // The sidecars the planner reads; the media file itself is only needed by
    // the render layer, so a placeholder keeps this layer independent of ffmpeg.
    writeFileSync(join(dir, `${CLIP_FILE.replace(/\.webm$/, '')}.action.jsonl`), serialisePlateauSeries(PLATEAUS));
    writeFileSync(
      join(dir, 'clip1.capture.json'),
      serialiseCaptureAnchor(
        buildFixtureAnchor({
          runStartedAtEpochMs: 1_736_899_200_000,
          captureStartedAtEpochMs: 1_736_899_200_000,
        }),
      ),
    );
    writeFileSync(join(dir, CLIP_FILE), '');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('plans 4 windows in arc order totalling 34 s net of the fades', { timeout: 60_000 }, () => {
    const planned = planPromo(parseArgs(['--dir', dir]));

    expect(planned.plan.map((window) => window.band)).toEqual([
      'high',
      'medium',
      'medium+',
      'very high',
    ]);
    expect(planned.totals.windows).toBe(4);
    // The rendered total is the arc length, not the footage length: the 3
    // inter-window fades are compensated by planned footage.
    expect(Math.abs(planned.totals.renderedSeconds - ARC_RENDERED_SECONDS)).toBeLessThan(0.01);
    expect(planned.totals.footageSeconds).toBeGreaterThan(ARC_RENDERED_SECONDS);
    expect(planned.totals.fadeSeconds).toBeCloseTo(3 * (Number(DEFAULT_FADE_DURATION) / 1000), 6);
    // Every window comes from the one fixture clip and stays inside it.
    for (const window of planned.plan) {
      expect(window.sourceStem).toBe('clip1');
      expect(window.inSeconds).toBeGreaterThanOrEqual(0);
      expect(window.inSeconds + window.durationSeconds).toBeLessThanOrEqual(FIXTURE_SECONDS + 0.01);
    }
  });

  it('writes a document whose clips are bare basenames with in-clip source ranges', { timeout: 60_000 }, () => {
    const planned = planPromo(parseArgs(['--dir', dir]));
    const track = (planned.document as any).tracks.children[0];
    const clips = track.children.filter((child: any) => child.OTIO_SCHEMA === 'Clip.1');

    expect(clips).toHaveLength(4);
    for (const clip of clips) {
      // A bare basename is what keeps the target_url resolvable against the
      // document's own directory.
      expect(clip.media_reference.target_url).toBe(CLIP_FILE);
      expect(clip.name).toBe(CLIP_FILE);
      expect(clip.metadata.vidc.has_audio).toBe(true);
      expect(clip.source_range.start_time.value).toBeGreaterThanOrEqual(0);
      expect(clip.source_range.duration.value).toBeGreaterThan(0);
      const startSeconds = clip.source_range.start_time.value / clip.source_range.start_time.rate;
      const durationSeconds = clip.source_range.duration.value / clip.source_range.duration.rate;
      expect(startSeconds + durationSeconds).toBeLessThanOrEqual(FIXTURE_SECONDS + 0.01);
    }
    expect((planned.document as any).metadata.vidc.clip_count).toBe(4);
  });

  it('forwards the explicit fade default once and invents no other vidc default', { timeout: 30_000 }, () => {
    const argv = buildVidcArgv(parseArgs(['--dir', dir]));

    expect(argv.slice(0, 2)).toEqual([process.env.VIDC_BIN || 'vidc', 'render']);
    const { otioPath, mp4Path } = resolveOutputPaths(parseArgs(['--dir', dir]));
    expect(argv).toContain('--timeline');
    expect(argv[argv.indexOf('--timeline') + 1]).toBe(otioPath);
    expect(argv[argv.indexOf('--output') + 1]).toBe(mp4Path);

    // AC: the explicit default is always on the command line, exactly once, so
    // a silent return to an inherited vidc default fails this suite.
    expect(argv.filter((entry) => entry === '--fade-duration')).toHaveLength(1);
    expect(argv[argv.indexOf('--fade-duration') + 1]).toBe(DEFAULT_FADE_DURATION);
    expect(DEFAULT_FADE_DURATION).toBe('300');

    // AC: no invented vidc defaults — only the fade duration is forwarded.
    for (const absent of ['--resolution', '--fps', '--format', '--dir', '--pattern']) {
      expect(argv).not.toContain(absent);
    }
  });

  it('forwards an explicit --fade-duration in place of the default', { timeout: 30_000 }, () => {
    const argv = buildVidcArgv(parseArgs(['--dir', dir, '--fade-duration', '400']));

    expect(argv.filter((entry) => entry === '--fade-duration')).toHaveLength(1);
    expect(argv[argv.indexOf('--fade-duration') + 1]).toBe('400');
    expect(argv).not.toContain(DEFAULT_FADE_DURATION);
  });

  it('is byte-deterministic: the same options build the same argv and document', { timeout: 30_000 }, () => {
    // The explicit value is on the planner's 0.1 s sample grid: the overlaps a
    // 4-window plan must compensate are (windows − 1) × fade, and the planner
    // grows windows in whole samples (AH-0MWXJKONT0059CT6 covers the off-grid
    // case, which fails loudly instead of over-running the arc).
    const first = parseArgs(['--dir', dir, '--fade-duration', '400']);
    const second = parseArgs(['--dir', dir, '--fade-duration', '400']);

    expect(buildVidcArgv(second)).toEqual(buildVidcArgv(first));
    expect(planPromo(second).text).toBe(planPromo(first).text);
    // An explicit fade also changes what is planned: the same footage now
    // compensates a larger overlap, so the windows grow and the rendered total
    // stays at the arc length.
    expect(planPromo(second).totals.fadeSeconds).toBeCloseTo(3 * 0.4, 6);
    expect(Math.abs(planPromo(second).totals.renderedSeconds - ARC_RENDERED_SECONDS)).toBeLessThan(0.01);
  });
});

describe.skipIf(!VIDC || !FIXTURE_FFMPEG || !FFPROBE)(
  'e2e — a real vidc renders the arc-planned promo (AH-0MWM295HP001X1ZU AC1–AC3)',
  () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'render-promo-render-e2e-'));
      writeFileSync(join(dir, 'clip1.action.jsonl'), serialisePlateauSeries(PLATEAUS));
      // A placeholder keeps the candidate discoverable for the capability
      // probe (which only compiles the document); the real encode replaces it
      // once the render leg is known to be reachable.
      writeFileSync(join(dir, CLIP_FILE), '');
      writeFileSync(
        join(dir, 'clip1.capture.json'),
        serialiseCaptureAnchor(
          buildFixtureAnchor({
            runStartedAtEpochMs: 1_736_899_200_000,
            captureStartedAtEpochMs: 1_736_899_200_000,
          }),
        ),
      );
    }, 300_000);

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    /** One VP9/Opus clip of the fixture length — the encoder is the fixture's. */
    function writeFixtureClip(path: string): void {
      execFileSync(
        FIXTURE_FFMPEG!,
        [
          '-y', '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', `testsrc2=size=${FIXTURE_WIDTH}x${FIXTURE_HEIGHT}:rate=${FIXTURE_RATE}:duration=${FIXTURE_SECONDS}`,
          '-f', 'lavfi', '-i', `sine=frequency=440:duration=${FIXTURE_SECONDS}`,
          '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '44',
          '-deadline', 'realtime', '-cpu-used', '8',
          '-c:a', 'libopus', '-b:a', '64k',
          path,
        ],
        { stdio: 'ignore', timeout: 240_000 },
      );
    }

    it(
      'renders the arc: delivered duration matches the plan and audio/video end together',
      { timeout: 900_000 },
      (ctx) => {
        // The render leg needs a `vidc` that honours the document's clip
        // bounds; skip (naming the owning work item) until it does, rather
        // than fail on a capability this project does not own.
        const capability = vidcCarriesClipBounds(
          VIDC!,
          (() => {
            const probeOptions = parseArgs(['--dir', dir]);
            const documentPath = resolveOutputPaths(probeOptions).otioPath;
            writeFileSync(documentPath, planPromo(probeOptions).text);
            return documentPath;
          })(),
        );
        if (!capability.ok) {
          return ctx.skip(
            `vidc ${capability.version || '(unknown version)'} does not carry per-clip bounds from the document ` +
              'into its render plan, so a trimmed arc-plan cannot be rendered yet — tracked by ' +
              'VC-0MWNOFIBI007J8UK (video_compiler "Render integration honours clip bounds").',
          );
        }

        writeFixtureClip(join(dir, CLIP_FILE));

        const argv = [
          '--dir', dir,
          '--output', join(dir, 'promo.mp4'),
          '--vidc', VIDC!,
          '--resolution', RENDER_GEOMETRY.resolution,
          '--fps', RENDER_GEOMETRY.fps,
          '--fade-duration', DEFAULT_FADE_DURATION,
          '--overwrite',
        ];

        // Run the real subprocess but keep its streams for the failure message.
        let vidcOutput = '';
        const spawnSyncImpl = ((command: string, args: readonly string[]) => {
          const result = spawnSync(command, args, { encoding: 'utf8' });
          vidcOutput = `${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`;
          return result;
        }) as any;

        const stdout = { write: () => true };
        const stderrSink = { write: (chunk: string) => { vidcOutput += chunk; return true; } };
        const code = main(argv, { stdout: stdout as any, stderr: stderrSink as any, spawnSyncImpl });

        expect(vidcOutput).toBeTruthy();
        expect(code, `vidc render failed:\n${vidcOutput}`).toBe(0);

        const planned = planPromo(parseArgs(argv));
        const mp4Path = join(dir, 'promo.mp4');
        const ends = probeStreamEnds(mp4Path);
        expect(ends.video, `no video stream in ${mp4Path}`).not.toBeNull();
        expect(ends.audio, `no audio stream in ${mp4Path}`).not.toBeNull();

        // The plan's own total, not a re-derivation: the deliverable pieces
        // into 34 s of rendered timeline, net of the compensated fades.
        expect(Math.abs(ends.video! - planned.totals.renderedSeconds)).toBeLessThanOrEqual(0.5);

        // ...and the fade compensation holds in the delivered file: the audio
        // must not run short of the picture by the uncompensated 300 ms per
        // junction (900 ms across 4 windows).
        const oneFrame = 1 / FIXTURE_RATE + 1e-6;
        expect(Math.abs(ends.audio! - ends.video!)).toBeLessThanOrEqual(oneFrame);

        // The document the render consumed is the one this run planned.
        const document = JSON.parse(readFileSync(join(dir, 'promo.otio'), 'utf8'));
        expect(document.metadata.vidc.clip_count).toBe(4);
        expect(document.metadata.vidc.intensity_arc.fade_seconds).toBe(
          Number(DEFAULT_FADE_DURATION) / 1000,
        );
      },
    );
  },
);
