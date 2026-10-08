/**
 * Hermetic tests for the browser bundle hygiene check
 * (`scripts/check-bundle-hygiene.mjs`), work item AH-0MUTYVA2C000SNPO.
 *
 * A temporary `dist/` fixture is used so the tests never invoke Vite: clean
 * bundles pass, and any forbidden Node-only marker fails with a located
 * violation. Runs in the Node environment because it reads the filesystem.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkBundleHygiene,
  main,
  parseArgs,
} from './check-bundle-hygiene.mjs';

let distDir: string;

beforeEach(() => {
  distDir = mkdtempSync(join(tmpdir(), 'aihell-dist-'));
  mkdirSync(join(distDir, 'assets'), { recursive: true });
});

afterEach(() => {
  rmSync(distDir, { recursive: true, force: true });
});

const silentLogger = { log() {}, warn() {}, error() {} } as unknown as Console;

describe('checkBundleHygiene', () => {
  it('passes a clean bundle', () => {
    writeFileSync(join(distDir, 'index.html'), '<script src="./assets/index.js"></script>');
    writeFileSync(join(distDir, 'assets', 'index.js'), 'const x = 1; console.log("game", x);');

    const result = checkBundleHygiene({ distDir });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.scanned).toBe(2);
  });

  it('fails when the Node-only audio backend leaks into the bundle', () => {
    writeFileSync(
      join(distDir, 'assets', 'index.js'),
      'import { AudioContext } from "node-web-audio-api";',
    );

    const result = checkBundleHygiene({ distDir });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].marker).toBe('node-web-audio-api');
    expect(result.violations[0].file).toBe(join('assets', 'index.js'));
  });

  it('fails on a forbidden Node built-in import in a nested chunk', () => {
    mkdirSync(join(distDir, 'assets', 'chunks'), { recursive: true });
    writeFileSync(join(distDir, 'assets', 'chunks', 'vendor.js'), 'const fs = require("node:fs");');

    const result = checkBundleHygiene({ distDir });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.marker)).toContain('node:fs');
  });

  it('reports a missing bundle as a failure', () => {
    rmSync(distDir, { recursive: true, force: true });

    const result = checkBundleHygiene({ distDir });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no bundle/);
  });

  it('ignores non-bundle files (e.g. source maps, binaries)', () => {
    writeFileSync(join(distDir, 'assets', 'index.js.map'), '"node:fs"');
    writeFileSync(join(distDir, 'assets', 'index.js'), 'ok');

    const result = checkBundleHygiene({ distDir });

    expect(result.ok).toBe(true);
  });
});

describe('check-bundle-hygiene CLI', () => {
  it('returns 1 on a violation and 0 on a clean bundle', () => {
    writeFileSync(join(distDir, 'assets', 'index.js'), 'require("node:child_process")');
    expect(main(['--dist', distDir], { logger: silentLogger })).toBe(1);

    writeFileSync(join(distDir, 'assets', 'index.js'), 'clean');
    expect(main(['--dist', distDir], { logger: silentLogger })).toBe(0);
  });

  it('parses --dist and rejects unknown arguments', () => {
    expect(parseArgs(['--dist', '/tmp/x']).distDir).toBe('/tmp/x');
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown argument/);
  });
});
