/**
 * Repo-level guard for the deterministic-boot harness contract
 * (parent AH-0MVF3BESP005ZDAV, child AH-0MVF6XQIC005RY3P).
 *
 * The harness must boot every scene deterministically: a single fixed-delta
 * `game.step` sequence with no wall-clock `setTimeout` boot delay, and no
 * `deterministicBoot` opt-in flag (deterministic boot is the *only* path).
 *
 * The legacy real-time boot (`bootDelay()` — `setTimeout(150)` while the
 * live rAF loop drained an unpredictable number of frames) was deleted
 * because it cost ~89 s of pure sleeping per full run and made post-boot
 * assertions load-sensitive. This static guard mirrors the repo's
 * duplicate-body guard (`src/test/duplicateBodyGuard.ts`): it scans the
 * harness and every test file under `src/` so the legacy path cannot return
 * without a loud failure.
 *
 * @module test/deterministicBootGuard
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';
import { describe, expect, it } from 'vitest';

import { bootScene } from './gameHarness';

const HARNESS = path.resolve(process.cwd(), 'src/test/gameHarness.ts');
/** This guard's own source; excluded from the call-site scan below. */
const SELF = path.resolve(process.cwd(), 'src/test/deterministicBootGuard.test.ts');

/**
 * Recursively lists `*.test.ts` files under `dir` (the same walk the
 * duplicate-body guard uses for production files, inverted to tests).
 */
function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, out);
    } else if (entry.isFile() && full.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strips block/line comments and string literals so the static checks below
 * assert on the harness/**, test-file **code** only. Prose documents the
 * deleted `setTimeout`-based boot by name, and a filename such as
 * `deterministicBootGuard.test.ts` appears as a string literal in other
 * tests — neither is a boot delay or an option pass.
 */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('deterministic-boot harness guard (AH-0MVF6XQIC005RY3P)', () => {
  it('the harness contains no wall-clock boot delay or setTimeout', () => {
    const code = stripNonCode(fs.readFileSync(HARNESS, 'utf8'));
    expect(code).not.toMatch(/setTimeout/);
    expect(code).not.toMatch(/\bbootDelay\b/);
  });

  it('the harness exposes only the deterministic boot path', () => {
    const code = stripNonCode(fs.readFileSync(HARNESS, 'utf8'));
    // Both boot entry points exist and share the fixed-delta boot flow.
    expect(code).toMatch(/async function bootScene\(/);
    expect(code).toMatch(/async function bootDeterministic\(/);
    expect(code).toMatch(/game\.step\(/);
    // The opt-in *flag* is gone: deterministic boot is the default, so no
    // caller can (or needs to) request it.
    expect(code).not.toMatch(/\bdeterministicBoot\b/);
  });

  it('no test file passes the legacy deterministicBoot option', () => {
    const offenders = collectTestFiles(path.resolve(process.cwd(), 'src'))
      .filter((file) => file !== SELF)
      .filter((file) => /\bdeterministicBoot\b/.test(stripNonCode(fs.readFileSync(file, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});

/** Minimal scene whose step count exposes the boot flow's fixed-delta steps. */
class StubBootScene extends Phaser.Scene {
  updateCount = 0;

  constructor() {
    super('StubBootScene');
  }

  update(): void {
    this.updateCount += 1;
  }
}

describe('deterministic boot behaviour (AH-0MVF6XQIC005RY3P)', () => {
  it('boots with no option flag and advances a fixed, repeatable step count', async () => {
    const counts: number[] = [];
    for (let run = 0; run < 2; run += 1) {
      const { game, scene } = await bootScene([StubBootScene]);
      const stub = scene as StubBootScene;
      expect(game.isBooted).toBe(true);
      expect(game.loop.running).toBe(true);
      expect(stub.updateCount).toBeGreaterThan(0);
      counts.push(stub.updateCount);
      game.destroy(true);
    }
    // Wall-clock-free boot: the same scene always advances the same number of
    // fixed-delta steps, independent of host load.
    expect(counts[1]).toBe(counts[0]);
  });

  it('anchors scene.time.now to the real clock (legacy absolute-time semantics)', async () => {
    const before = performance.now();
    const { game, scene } = await bootScene([StubBootScene]);
    // Suites that gate on absolute time (e.g. GymBoss's 1200 ms attack
    // interval) depend on `scene.time.now` being a real timestamp, exactly as
    // the deleted real-time boot provided. A 0-based simulated clock silently
    // broke them (AH-0MVF6XQIC005RY3P).
    expect(scene.time.now).toBeGreaterThanOrEqual(before);
    game.destroy(true);
  });
});
