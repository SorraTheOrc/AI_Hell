/**
 * Tests for the harness launch configuration (`scripts/perf-launch.mjs`,
 * AH-0MW2DB9VN006XB63).
 *
 * The launch paths themselves boot a browser or an Electron app, so only the
 * pure argument/environment construction is unit-tested here: the renderer
 * switches must be mutually exclusive (a hardware run must not carry the
 * software-permitting switch), the headless switch must be present unless the
 * caller asked for a window, and the runtime label must never claim Electron
 * for a browser run.
 */

import { describe, expect, it } from 'vitest';

import {
  ELECTRON_ENTRY,
  buildBrowserLaunchArgs,
  buildElectronEnv,
  buildElectronLaunchArgs,
  describeRuntime,
  rendererSwitches,
} from './perf-launch.mjs';

describe('rendererSwitches', () => {
  it('asks for the software backend by default', () => {
    expect(rendererSwitches()).toContain('--enable-unsafe-swiftshader');
    expect(rendererSwitches(false)).not.toContain('--ignore-gpu-blocklist');
  });

  it('asks for the hardware GPU when --gpu is set, and drops the software switch', () => {
    const switches = rendererSwitches(true);

    expect(switches).toContain('--ignore-gpu-blocklist');
    expect(switches).toContain('--enable-gpu-rasterization');
    // A hardware run must not carry the flag that permits a silent software
    // fallback: that is exactly the ambiguity this item exists to remove.
    expect(switches).not.toContain('--enable-unsafe-swiftshader');
  });
});

describe('buildBrowserLaunchArgs', () => {
  it('keeps the loop unthrottled and the sandbox disabled in every mode', () => {
    for (const args of [buildBrowserLaunchArgs(), buildBrowserLaunchArgs({ gpu: true })]) {
      expect(args).toContain('--no-sandbox');
      expect(args).toContain('--disable-background-timer-throttling');
      expect(args).toContain('--disable-backgrounding-occluded-windows');
      expect(args).toContain('--disable-renderer-backgrounding');
    }
  });
});

describe('buildElectronLaunchArgs', () => {
  it('puts the entry point first, then the shared Chromium switches', () => {
    const args = buildElectronLaunchArgs({ repoRoot: '/repo' });

    expect(args[0]).toBe(`/repo/${ELECTRON_ENTRY}`);
    expect(args).toContain('--no-sandbox');
    expect(args).toContain('--enable-unsafe-swiftshader');
  });

  it('runs without a display server by default and only shows a window when headed', () => {
    expect(buildElectronLaunchArgs({ repoRoot: '/repo' })).toContain('--ozone-platform=headless');
    expect(buildElectronLaunchArgs({ repoRoot: '/repo', headless: false })).not.toContain(
      '--ozone-platform=headless',
    );
  });

  it('passes the GPU switches instead of the software ones in GPU mode', () => {
    const args = buildElectronLaunchArgs({ repoRoot: '/repo', gpu: true });

    expect(args).toContain('--ignore-gpu-blocklist');
    expect(args).not.toContain('--enable-unsafe-swiftshader');
  });
});

describe('buildElectronEnv', () => {
  it('passes the page URL and the headless/GPU choices to the entry point', () => {
    const env = buildElectronEnv({
      url: 'http://127.0.0.1:5199/',
      headless: true,
      gpu: true,
      base: { PATH: '/bin' },
    });

    expect(env.AI_HELL_ELECTRON_URL).toBe('http://127.0.0.1:5199/');
    expect(env.AI_HELL_ELECTRON_HEADLESS).toBe('1');
    expect(env.AI_HELL_ELECTRON_GPU).toBe('1');
    expect(env.PATH).toBe('/bin');
  });

  it('omits the URL when none is given and marks headed/software runs', () => {
    const env = buildElectronEnv({ headless: false, gpu: false, base: {} });

    expect(env.AI_HELL_ELECTRON_URL).toBeUndefined();
    expect(env.AI_HELL_ELECTRON_HEADLESS).toBe('0');
    expect(env.AI_HELL_ELECTRON_GPU).toBe('0');
  });
});

describe('describeRuntime', () => {
  it('labels an Electron run with both versions', () => {
    expect(
      describeRuntime({ kind: 'electron', electronVersion: '45.2.2', chromeVersion: '156.0.8078.80' }),
    ).toEqual({ kind: 'electron', electronVersion: '45.2.2', chromeVersion: '156.0.8078.80' });
  });

  it('defaults to a browser run and normalises missing versions to null', () => {
    expect(describeRuntime()).toEqual({ kind: 'browser', electronVersion: null, chromeVersion: null });
    expect(describeRuntime({ kind: 'electron', electronVersion: '' }).electronVersion).toBeNull();
  });
});
