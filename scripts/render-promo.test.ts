/**
 * Tests for `capture:promo` as an arc-planned document source
 * (AH-0MWPD4VV300828HE).
 *
 * The command's contract is narrow on purpose: it plans the intensity arc,
 * writes the `.otio`, and hands **that document** to `vidc render`. There is no
 * flag that selects or disables the arc, and nothing forwards `--dir` to
 * `vidc`'s own discovery. These tests pin exactly that seam plus the surviving
 * option surface, the rewritten document and the unchanged missing-binary
 * remediation.
 *
 * Everything runs against in-memory captures built through the canonical
 * serialisers and a mocked spawn: no browser, no footage, no real subprocess.
 *
 * Naming note: the plan's segments are called `cut` in *code* here, never
 * `window` — `vitest.projects.ts` classifies a file as `integration` when its
 * code mentions a DOM global, and this is a pure-Node `unit` suite.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  FIXTURE_RUN_STARTED_AT_EPOCH_MS,
  buildFixtureAnchor,
  serialiseCaptureAnchor,
  serialisePlateauSeries,
} from './intensity-arc-fixtures.mjs';
import {
  DEFAULT_INTENSITY_ARC_CONFIG,
  IntensityArcIngestError,
  IntensityArcShortfallError,
} from './intensity-arc.mjs';
import {
  DEFAULT_CAPTURE_DIR,
  DEFAULT_FADE_DURATION,
  DEFAULT_PROMO_PATTERN,
  UsageError,
  buildVidcArgv,
  discoverCandidates,
  formatArcPlan,
  main,
  parseArgs,
  planPromo,
  resolveOutputPaths,
  runVidc,
} from './render-promo.mjs';

/** One plateau per band, each comfortably above its 7/7/10/10 s target. */
const FULL_ARC_PLATEAUS = [
  { fromT: 0, toT: 8000, intensity: 0.46 },
  { fromT: 8000, toT: 16000, intensity: 0.6 },
  { fromT: 16000, toT: 27000, intensity: 0.7 },
  { fromT: 27000, toT: 38000, intensity: 0.82 },
];

/** A capture directory that exists only in memory. */
function fakeCaptureDir(stems: string[], extraFiles: string[] = []) {
  const files = new Map<string, string>();
  for (const stem of stems) {
    files.set(`${stem}.action.jsonl`, serialisePlateauSeries(FULL_ARC_PLATEAUS));
    files.set(
      `${stem}.capture.json`,
      serialiseCaptureAnchor(
        buildFixtureAnchor({
          runStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
          captureStartedAtEpochMs: FIXTURE_RUN_STARTED_AT_EPOCH_MS,
        }),
      ),
    );
  }
  const names = [
    ...stems.map((stem) => `${stem}.webm`),
    ...stems.flatMap((stem) => [`${stem}.action.jsonl`, `${stem}.capture.json`]),
    ...extraFiles,
  ];
  return {
    files,
    deps: {
      readdirSyncImpl: () =>
        names.map((name) => ({ name, isFile: () => true })),
      readFile: (filePath: string) => {
        const name = filePath.split('/').pop() as string;
        const text = files.get(name);
        if (text === undefined) {
          const error = Object.assign(new Error(`ENOENT: ${filePath}`), {
            code: 'ENOENT',
          });
          throw error;
        }
        return text;
      },
    },
  };
}

function okResult(status = 0) {
  return { status, error: null, signal: null };
}

function capture() {
  let text = '';
  return {
    stream: {
      write: (chunk: string) => {
        text += chunk;
        return true;
      },
    },
    read: () => text,
  };
}

describe('capture:promo argument surface (AH-0MWPD4VV300828HE)', () => {
  it('defaults to the capture directory, vidc on PATH and the planner fade', () => {
    const options = parseArgs([]);
    expect(options.dir).toBe(DEFAULT_CAPTURE_DIR);
    expect(options.output).toBeNull();
    expect(options.pattern).toBeNull();
    expect(options.formats).toEqual([]);
    expect(options.fadeDuration).toBe(DEFAULT_FADE_DURATION);
    // The default fade is the planner's own (300 ms), so the compensation the
    // plan applies is exactly the overlap vidc renders.
    expect(DEFAULT_FADE_DURATION).toBe(
      String(Math.round(DEFAULT_INTENSITY_ARC_CONFIG.fadeSeconds * 1000)),
    );
    expect(options.vidc).toBe(process.env.VIDC_BIN || 'vidc');
    expect(options.help).toBe(false);
  });

  it('parses every surviving override', () => {
    const options = parseArgs([
      '--dir', 'clips',
      '--output', 'out/promo.mp4',
      '--pattern', '^clip.*\\.webm$',
      '--format', '16:9',
      '--format', 'tiktok',
      '--resolution', '1280x720',
      '--fps', '60',
      '--fade-duration', '450',
      '--overwrite',
      '--dry-run',
      '--json',
      '--vidc', '/opt/vidc',
    ]);
    expect(options).toMatchObject({
      dir: 'clips',
      output: 'out/promo.mp4',
      pattern: '^clip.*\\.webm$',
      formats: ['16:9', 'tiktok'],
      resolution: '1280x720',
      fps: '60',
      fadeDuration: '450',
      overwrite: true,
      dryRun: true,
      json: true,
      vidc: '/opt/vidc',
    });
  });

  it('rejects any flag that would select or disable the arc', () => {
    for (const flag of ['--intensity-arc', '--arc', '--no-arc']) {
      expect(() => parseArgs([flag])).toThrow(UsageError);
      expect(() => parseArgs([flag])).toThrow(/Unknown argument/);
    }
    // `--recursive` was a vidc-discovery flag; discovery is this script's job.
    expect(() => parseArgs(['--recursive'])).toThrow(UsageError);
  });

  it('rejects an unknown argument, a missing value and an invalid pattern or fade', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument: --nope/);
    expect(() => parseArgs(['--dir'])).toThrow(/Missing value for --dir/);
    expect(() => parseArgs(['--output', '--json'])).toThrow(/Missing value for --output/);
    expect(() => parseArgs(['--pattern', '['])).toThrow(/Invalid --pattern/);
    expect(() => parseArgs(['--fade-duration', 'fast'])).toThrow(/Invalid --fade-duration/);
    expect(() => parseArgs(['--fade-duration', '-5'])).toThrow(/Invalid --fade-duration/);
  });
});

describe('capture:promo vidc handoff (AH-0MWPD4VV300828HE)', () => {
  it('always passes the .otio document as the source and never a discovery flag', () => {
    const argv = buildVidcArgv(parseArgs([]));
    expect(argv).toEqual([
      'vidc', 'render',
      '--timeline', 'capture-output/promo.otio',
      '--output', 'capture-output/promo.mp4',
      '--fade-duration', DEFAULT_FADE_DURATION,
    ]);
    for (const flag of ['--dir', '--pattern', '--recursive']) {
      expect(argv).not.toContain(flag);
    }
    // The document source is explicit, never vidc's auto-detected path.
    expect(argv).toContain('--timeline');
  });

  it('invents no vidc default other than the explicit fade duration', () => {
    // AC2: resolution, frame rate and output format are vidc's own defaults
    // until the caller selects them, so a render never silently re-encodes to a
    // geometry this repo picked. The one default this driver *does* set is the
    // cross-fade — explicit, and present exactly once (AC1).
    const argv = buildVidcArgv(parseArgs([]));
    for (const flag of ['--resolution', '--fps', '--format']) {
      expect(argv).not.toContain(flag);
    }
    expect(argv.filter((entry) => entry === '--fade-duration')).toHaveLength(1);
    expect(argv[argv.indexOf('--fade-duration') + 1]).toBe(DEFAULT_FADE_DURATION);

    // ...and a selected value is forwarded rather than dropped.
    const selected = buildVidcArgv(
      parseArgs(['--resolution', '1280x720', '--fps', '60', '--format', '16:9']),
    );
    expect(selected[selected.indexOf('--resolution') + 1]).toBe('1280x720');
    expect(selected[selected.indexOf('--fps') + 1]).toBe('60');
    expect(selected[selected.indexOf('--format') + 1]).toBe('16:9');
    // The fade default is still on the command line alongside the selections.
    expect(selected.filter((entry) => entry === '--fade-duration')).toHaveLength(1);
  });

  it('derives the document name from the output stem and keeps it beside the captures', () => {
    const options = parseArgs(['--dir', 'clips', '--output', 'clips/final-cut.mp4']);
    expect(resolveOutputPaths(options)).toEqual({
      mp4Path: 'clips/final-cut.mp4',
      otioPath: 'clips/final-cut.otio',
    });
    const argv = buildVidcArgv(options);
    expect(argv).toContain('clips/final-cut.otio');
    expect(argv).toContain('clips/final-cut.mp4');
  });

  it('forwards the surviving optional flags and nothing else', () => {
    const argv = buildVidcArgv(
      parseArgs([
        '--dir', 'clips',
        '--format', '16:9',
        '--format', 'tiktok',
        '--resolution', '1280x720',
        '--fps', '60',
        '--fade-duration', '450',
        '--overwrite',
        '--json',
        '--vidc', '/opt/vidc',
      ]),
    );
    expect(argv).toEqual([
      '/opt/vidc', 'render',
      '--timeline', 'clips/promo.otio',
      '--output', 'clips/promo.mp4',
      '--format', '16:9',
      '--format', 'tiktok',
      '--resolution', '1280x720',
      '--fps', '60',
      '--fade-duration', '450',
      '--overwrite',
      '--json',
    ]);
  });

  it('filters the capture inputs by the default pattern', () => {
    const filter = new RegExp(DEFAULT_PROMO_PATTERN);
    expect(filter.test('gameplay-1.webm')).toBe(true);
    expect(filter.test('gameplay-1.seekable.webm')).toBe(false);
    expect(filter.test('gameplay-1.partial.webm')).toBe(false);
    expect(filter.test('gameplay-1.action.jsonl')).toBe(false);

    const dir = fakeCaptureDir(['gameplay-2', 'gameplay-10'], [
      'gameplay-2.seekable.webm',
      'gameplay-2.partial.webm',
    ]);
    expect(discoverCandidates('capture-output', DEFAULT_PROMO_PATTERN, dir.deps)).toEqual([
      'gameplay-2.webm',
      'gameplay-10.webm',
    ]);
    expect(
      discoverCandidates('capture-output', '^gameplay-10\\.webm$', dir.deps),
    ).toEqual(['gameplay-10.webm']);
  });
});

describe('capture:promo planning seam (AH-0MWPD4VV300828HE)', () => {
  it('plans the 34 s arc and builds the document from the recorded series', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const planned = planPromo(parseArgs([]), dir.deps);

    expect(planned.captures).toHaveLength(1);
    expect(planned.plan.map((cut) => cut.band)).toEqual([
      'high',
      'medium',
      'medium+',
      'very high',
    ]);
    expect(planned.totals.renderedSeconds).toBeCloseTo(34, 6);
    expect(planned.document.OTIO_SCHEMA).toBe('Timeline.1');
    expect(planned.document.metadata.vidc.intensity_arc.rendered_seconds).toBeCloseTo(34, 6);
    // The document is what will be written, and it is stable.
    expect(planned.text).toBe(planPromo(parseArgs([]), dir.deps).text);
  });

  it('compensates the CLI fade it forwards to vidc', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const planned = planPromo(parseArgs(['--fade-duration', '500']), dir.deps);

    expect(planned.config.fadeSeconds).toBe(0.5);
    expect(planned.totals.renderedSeconds).toBeCloseTo(34, 6);
    expect(planned.totals.fadeSeconds).toBeCloseTo(
      (planned.plan.length - 1) * 0.5,
      9,
    );
  });

  it('fails with the ingest error when no capture has a usable series', () => {
    const dir = fakeCaptureDir([]);
    const warn = vi.fn();
    let captured: unknown;
    try {
      planPromo(parseArgs([]), { ...dir.deps, warn });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(IntensityArcIngestError);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per capture that cannot join to its video', () => {
    const dir = fakeCaptureDir(
      ['gameplay-1'],
      [],
    );
    // Drop the very-high stretch so the arc cannot be filled, and drop an
    // anchor so a second capture is skipped with exactly one warning.
    dir.files.set(
      'gameplay-2.action.jsonl',
      serialisePlateauSeries([{ fromT: 0, toT: 4000, intensity: 0.82 }]),
    );
    dir.files.set('gameplay-2.webm', '');
    const names = ['gameplay-1.webm', 'gameplay-2.webm'];
    const deps = {
      readdirSyncImpl: () =>
        names.map((name) => ({ name, isFile: () => true })),
      readFile: (filePath: string) => {
        const name = filePath.split('/').pop() as string;
        const text = dir.files.get(name);
        if (text === undefined) {
          throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: 'ENOENT' });
        }
        return text;
      },
      warn: vi.fn(),
    };
    const planned = planPromo(parseArgs([]), deps);
    expect(planned.skipped).toHaveLength(1);
    expect(planned.skipped[0].reason).toBe('missing-anchor');
    expect(deps.warn).toHaveBeenCalledTimes(1);
  });

  it('surfaces a band shortfall as an arc error', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    // Truncate the very-high stretch to 5 s.
    dir.files.set(
      'gameplay-1.action.jsonl',
      serialisePlateauSeries(FULL_ARC_PLATEAUS.map((plateau) =>
        plateau.intensity === 0.82 ? { ...plateau, toT: 32000 } : plateau,
      )),
    );
    let captured: unknown;
    try {
      planPromo(parseArgs([]), dir.deps);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(IntensityArcShortfallError);
    expect((captured as Error).message).toMatch(/very high/);
  });
});

describe('capture:promo CLI (AH-0MWPD4VV300828HE)', () => {
  it('prints usage and exits 0 for --help without planning or spawning vidc', () => {
    const spawnSyncImpl = vi.fn();
    const out = capture();
    const code = main(['--help'], { spawnSyncImpl, stdout: out.stream });
    expect(code).toBe(0);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(out.read()).toContain('node scripts/render-promo.mjs');
    // The help describes the arc and advertises no arc flag.
    expect(out.read()).toMatch(/intensity arc/i);
    expect(out.read()).not.toContain('--intensity-arc');
    expect(out.read()).not.toContain('--arc ');
    // The fade help documents the sample-step quantisation of the
    // compensation, while the forwarded value is unchanged (AH-0MWXJKONT0059CT6).
    expect(out.read()).toMatch(/rounded up to the planner's 10 Hz\s+sample grid/i);
    expect(out.read()).toContain('one sample step (100 ms)');
    expect(out.read()).toMatch(/value forwarded to vidc is unchanged/i);
  });

  it('prints the usage text and exits 2 for a rejected flag', () => {
    const spawnSyncImpl = vi.fn();
    const err = capture();
    const code = main(['--intensity-arc'], { spawnSyncImpl, stderr: err.stream });
    expect(code).toBe(2);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(err.read()).toContain('Unknown argument: --intensity-arc');
    expect(err.read()).toContain('Usage:');
  });

  it('writes the document and renders it, propagating vidc the exit code', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const spawnSyncImpl = vi.fn(() => okResult(7));
    const written: Array<{ path: string; text: string }> = [];
    const err = capture();
    const code = main(['--json'], {
      ...dir.deps,
      spawnSyncImpl,
      writeFile: (path, text) => written.push({ path, text }),
      makeDir: () => {},
      stderr: err.stream,
    });

    expect(code).toBe(7);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe('capture-output/promo.otio');
    expect(JSON.parse(written[0].text).OTIO_SCHEMA).toBe('Timeline.1');
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
    const [command, args] = spawnSyncImpl.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe('vidc');
    expect(args).toContain('--timeline');
    expect(args[args.indexOf('--timeline') + 1]).toBe('capture-output/promo.otio');
    expect(args[args.indexOf('--output') + 1]).toBe('capture-output/promo.mp4');
    expect(args).not.toContain('--dir');
    expect(args).not.toContain('--pattern');
    expect(err.read()).toBe('');
  });

  it('rewrites a stale document instead of letting it drive the render', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const written: Array<{ path: string; text: string }> = [];
    main([], {
      ...dir.deps,
      spawnSyncImpl: vi.fn(() => okResult(0)),
      writeFile: (path, text) => written.push({ path, text }),
      makeDir: () => {},
      stderr: capture().stream,
    });
    // A pre-existing (stale) document on disk is simply replaced: the plan is
    // written unconditionally before the render.
    expect(written[0].text).not.toContain('stale');
    const fresh = planPromo(parseArgs([]), dir.deps).text;
    expect(written[0].text).toBe(fresh);
  });

  it('prints the arc plan and the vidc argv for --dry-run without writing or spawning', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const spawnSyncImpl = vi.fn();
    const writeFile = vi.fn();
    const out = capture();
    const code = main(['--dry-run'], {
      ...dir.deps,
      spawnSyncImpl,
      writeFile,
      makeDir: () => {},
      stdout: out.stream,
      stderr: capture().stream,
    });

    expect(code).toBe(0);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    const text = out.read();
    expect(text).toContain('Intensity arc plan');
    expect(text).toContain('high');
    expect(text).toContain('very high');
    expect(text).toContain('rendered 34.00s');
    expect(text).toContain('"render"');
    expect(text).toContain('promo.otio');
  });

  it('fails actionably when no capture can join to its video', () => {
    const dir = fakeCaptureDir([]);
    const spawnSyncImpl = vi.fn();
    const writeFile = vi.fn();
    const err = capture();
    const code = main([], {
      ...dir.deps,
      spawnSyncImpl,
      writeFile,
      makeDir: () => {},
      stderr: err.stream,
    });

    expect(code).toBe(1);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(err.read()).toContain('No usable capture remains');
    expect(err.read()).toContain('action.jsonl');
  });

  it('reports a missing capture directory with the remediation', () => {
    const err = capture();
    const code = main([], {
      readdirSyncImpl: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      spawnSyncImpl: vi.fn(),
      stderr: err.stream,
    });
    expect(code).toBe(1);
    expect(err.read()).toContain('Capture directory not found');
    expect(err.read()).toContain('npm run capture');
  });

  it('keeps the missing-vidc remediation (exit 127)', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const error = Object.assign(new Error('spawn vidc ENOENT'), { code: 'ENOENT' });
    const spawnSyncImpl = vi.fn(() => ({ status: null, error, signal: null }));
    const err = capture();
    const code = main([], {
      ...dir.deps,
      spawnSyncImpl,
      writeFile: () => {},
      makeDir: () => {},
      stderr: err.stream,
    });
    expect(code).toBe(127);
    expect(err.read()).toContain('vidc executable not found');
    expect(err.read()).toContain('video_compiler repository');
  });
});

describe('capture:promo subprocess seam (AH-0MWPD4VV300828HE)', () => {
  it('forwards the vidc exit code and inherits stdio', () => {
    const spawnSyncImpl = vi.fn(() => okResult(7));
    const result = runVidc(['vidc', 'render', '--output', 'x.mp4'], { spawnSyncImpl });
    expect(result).toEqual({ code: 7, error: null });
    expect(spawnSyncImpl).toHaveBeenCalledWith('vidc', ['render', '--output', 'x.mp4'], {
      stdio: 'inherit',
    });
  });

  it('reports a signal termination as a failure', () => {
    const spawnSyncImpl = vi.fn(() => ({ status: null, error: null, signal: 'SIGKILL' }));
    const result = runVidc(['vidc', 'render'], { spawnSyncImpl });
    expect(result.code).toBe(1);
    expect(result.error).toContain('SIGKILL');
  });

  it('renders the plan text with per-band achieved seconds', () => {
    const dir = fakeCaptureDir(['gameplay-1']);
    const options = parseArgs([]);
    const planned = planPromo(options, dir.deps);
    const text = formatArcPlan(planned, options, buildVidcArgv(options));
    for (const band of DEFAULT_INTENSITY_ARC_CONFIG.bands) {
      expect(text).toContain(band.name);
      expect(text).toContain(`target ${String(band.targetSeconds).padStart(2)}s`);
    }
    expect(text).toContain('4 cuts from 1 capture(s)');
  });
});
