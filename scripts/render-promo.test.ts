/**
 * Unit tests for the thin `vidc` promo renderer (AH-0MWOUY9IK004QWCU).
 *
 * The migration deliberately leaves all video processing to `vidc`; this suite
 * therefore pins only the seam AI_Hell still owns — argument defaults,
 * forwarding, exit-code propagation and the actionable missing-binary message.
 * No FFmpeg, no capture footage and no real subprocess are required.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CAPTURE_DIR,
  DEFAULT_FADE_DURATION,
  DEFAULT_PROMO_PATTERN,
  UsageError,
  buildVidcArgv,
  main,
  parseArgs,
  runVidc,
} from './render-promo.mjs';

function okResult(status = 0) {
  return { status, error: null, signal: null };
}

function capture() {
  let text = '';
  return {
    stream: { write: (chunk: string) => { text += chunk; return true; } },
    read: () => text,
  };
}

describe('render-promo argument parsing (AH-0MWOUY9IK004QWCU)', () => {
  it('defaults to the capture directory, vidc on PATH and no overrides', () => {
    const options = parseArgs([]);
    expect(options.dir).toBe(DEFAULT_CAPTURE_DIR);
    expect(options.output).toBeNull();
    expect(options.pattern).toBeNull();
    expect(options.formats).toEqual([]);
    expect(options.fadeDuration).toBe(DEFAULT_FADE_DURATION);
    expect(options.vidc).toBe(process.env.VIDC_BIN || 'vidc');
    expect(options.help).toBe(false);
  });

  it('parses every supported override', () => {
    const options = parseArgs([
      '--dir', 'clips',
      '--output', 'out/promo.mp4',
      '--pattern', '^clip.*\\.webm$',
      '--format', '16:9',
      '--format', 'tiktok',
      '--resolution', '1280x720',
      '--fps', '60',
      '--fade-duration', '400',
      '--recursive',
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
      fadeDuration: '400',
      recursive: true,
      overwrite: true,
      dryRun: true,
      json: true,
      vidc: '/opt/vidc',
    });
  });

  it('rejects an unknown argument with a usage error', () => {
    expect(() => parseArgs(['--nope'])).toThrow(UsageError);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument: --nope/);
  });

  it('rejects a flag with no value', () => {
    expect(() => parseArgs(['--dir'])).toThrow(/Missing value for --dir/);
    expect(() => parseArgs(['--output', '--json'])).toThrow(/Missing value for --output/);
  });
});

describe('render-promo argv construction (AH-0MWOUY9IK004QWCU)', () => {
  it('defaults the output beside the capture directory and excludes derived WebMs', () => {
    const argv = buildVidcArgv(parseArgs([]));
    expect(argv).toEqual([
      'vidc', 'render',
      '--dir', 'capture-output',
      '--output', 'capture-output/promo.mp4',
      '--pattern', DEFAULT_PROMO_PATTERN,
      '--fade-duration', '400',
    ]);
    // The default pattern must not pick up the seek-index remux or salvage file.
    const pattern = new RegExp(DEFAULT_PROMO_PATTERN);
    expect(pattern.test('gameplay-1.webm')).toBe(true);
    expect(pattern.test('gameplay-1.seekable.webm')).toBe(false);
    expect(pattern.test('gameplay-1.partial.webm')).toBe(false);
    expect(pattern.test('gameplay-1.action.jsonl')).toBe(false);
  });

  it('honours an explicit dir/output and forwards every selected flag', () => {
    const argv = buildVidcArgv(parseArgs([
      '--dir', 'clips',
      '--output', 'out/promo.mp4',
      '--pattern', '^clip.*\\.webm$',
      '--format', '16:9',
      '--format', 'tiktok',
      '--resolution', '1280x720',
      '--fps', '60',
      '--fade-duration', '400',
      '--recursive',
      '--overwrite',
      '--dry-run',
      '--json',
    ]));
    expect(argv).toEqual([
      'vidc', 'render',
      '--dir', 'clips',
      '--output', 'out/promo.mp4',
      '--pattern', '^clip.*\\.webm$',
      '--format', '16:9',
      '--format', 'tiktok',
      '--resolution', '1280x720',
      '--fps', '60',
      '--fade-duration', '400',
      '--recursive',
      '--overwrite',
      '--dry-run',
      '--json',
    ]);
  });

  it('forwards the explicit 400 ms fade by default but leaves the other vidc defaults alone', () => {
    const argv = buildVidcArgv(parseArgs([]));
    // The cross fade is AI_Hell's explicit editorial default, not vidc's.
    expect(argv).toContain('--fade-duration');
    expect(argv[argv.indexOf('--fade-duration') + 1]).toBe(DEFAULT_FADE_DURATION);
    // The remaining vidc defaults (resolution, fps, preset) stay vidc's own.
    for (const flag of ['--format', '--resolution', '--fps']) {
      expect(argv).not.toContain(flag);
    }
  });

  it('lets an explicit --fade-duration override the 400 ms default', () => {
    const argv = buildVidcArgv(parseArgs(['--fade-duration', '500']));
    expect(argv[argv.indexOf('--fade-duration') + 1]).toBe('500');
    expect(argv).not.toContain('400');
  });
});

describe('render-promo subprocess seam (AH-0MWOUY9IK004QWCU)', () => {
  it('forwards the vidc exit code and inherits stdio', () => {
    const spawnSyncImpl = vi.fn(() => okResult(7));
    const result = runVidc(['vidc', 'render', '--output', 'x.mp4'], { spawnSyncImpl });
    expect(result).toEqual({ code: 7, error: null });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'vidc',
      ['render', '--output', 'x.mp4'],
      { stdio: 'inherit' }
    );
  });

  it('reports a missing vidc binary with an actionable install hint (exit 127)', () => {
    const error = Object.assign(new Error('spawn vidc ENOENT'), { code: 'ENOENT' });
    const spawnSyncImpl = vi.fn(() => ({ status: null, error, signal: null }));
    const result = runVidc(['vidc', 'render'], { spawnSyncImpl });
    expect(result.code).toBe(127);
    expect(result.error).toContain('vidc executable not found: vidc');
    expect(result.error).toContain('npm link');
    expect(result.error).toContain('VIDC_BIN');
  });

  it('reports a signal termination as a failure', () => {
    const spawnSyncImpl = vi.fn(() => ({ status: null, error: null, signal: 'SIGKILL' }));
    const result = runVidc(['vidc', 'render'], { spawnSyncImpl });
    expect(result.code).toBe(1);
    expect(result.error).toContain('SIGKILL');
  });
});

describe('render-promo CLI (AH-0MWOUY9IK004QWCU)', () => {
  it('prints usage and exits 0 for --help without spawning vidc', () => {
    const spawnSyncImpl = vi.fn();
    const out = capture();
    const code = main(['--help'], { spawnSyncImpl, stdout: out.stream });
    expect(code).toBe(0);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(out.read()).toContain('node scripts/render-promo.mjs');
    expect(out.read()).toContain('--vidc <path>');
  });

  it('prints the usage text and exits 2 on a usage error', () => {
    const spawnSyncImpl = vi.fn();
    const err = capture();
    const code = main(['--bogus'], { spawnSyncImpl, stderr: err.stream });
    expect(code).toBe(2);
    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(err.read()).toContain('Unknown argument: --bogus');
    expect(err.read()).toContain('Usage:');
  });

  it('runs vidc with the built argv and propagates its exit code', () => {
    const spawnSyncImpl = vi.fn(() => okResult(0));
    const code = main(
      ['--dir', 'clips', '--output', 'out/promo.mp4', '--dry-run', '--json'],
      { spawnSyncImpl }
    );
    expect(code).toBe(0);
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'vidc',
      ['render', '--dir', 'clips', '--output', 'out/promo.mp4', '--pattern', DEFAULT_PROMO_PATTERN, '--fade-duration', '400', '--dry-run', '--json'],
      { stdio: 'inherit' }
    );
  });

  it('prints the missing-binary remediation to stderr and exits 127', () => {
    const error = Object.assign(new Error('spawn vidc ENOENT'), { code: 'ENOENT' });
    const spawnSyncImpl = vi.fn(() => ({ status: null, error, signal: null }));
    const err = capture();
    const code = main([], { spawnSyncImpl, stderr: err.stream });
    expect(code).toBe(127);
    expect(err.read()).toContain('video_compiler repository');
  });
});
