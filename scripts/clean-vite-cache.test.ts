/**
 * Hermetic tests for the Vite dep-cache hygiene script
 * (`scripts/clean-vite-cache.mjs`), work item AH-0MVFR1LGB001BIZ7.
 *
 * A temporary cache fixture stands in for the real shared
 * `node_modules/.vite` and process detection is injected, so the tests never
 * touch the shared cache and never rely on the live process table. AC2's
 * refusal path and AC1's dry-run classification are covered here; the real
 * `--apply` + unit-suite regeneration check (AC4) requires an idle shared
 * host and is documented in docs/dev/test-suite-timing.md.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyCacheEntries,
  cleanViteCache,
  detectRunningViteProcesses,
  formatBytes,
  looksLikeViteProcess,
  main,
  parseArgs,
} from './clean-vite-cache.mjs';

let cacheDir: string;

const quiet = () => ({ ok: true, processes: [] });

/** Populates `dir` with one orphan per name plus the valid pre-bundles. */
function seedCache(dir: string, orphans: string[] = ['deps_temp_beef', 'deps_temp_cafe']) {
  mkdirSync(join(dir, 'deps'), { recursive: true });
  writeFileSync(join(dir, 'deps', 'a.js'), 'export const a = 1;');
  mkdirSync(join(dir, 'deps_ssr'), { recursive: true });
  mkdirSync(join(dir, 'vitest'), { recursive: true });
  writeFileSync(join(dir, 'vitest', 'entry.json'), '{}');
  for (const orphan of orphans) {
    const payload = orphan === 'deps_temp_beef' ? 'x'.repeat(1024) : 'y'.repeat(512);
    mkdirSync(join(dir, orphan, 'nested'), { recursive: true });
    writeFileSync(join(dir, orphan, 'nested', 'chunk.js'), payload);
  }
}

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'aihell-vite-cache-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('classifyCacheEntries', () => {
  it('classifies deps_temp_* as orphans and preserves deps/deps_ssr', () => {
    seedCache(cacheDir);

    const result = classifyCacheEntries(cacheDir);

    expect(result.exists).toBe(true);
    expect(result.tempCount).toBe(2);
    expect(result.tempBytes).toBe(1024 + 512);
    expect(result.tempDirs.map((entry) => entry.name)).toEqual([
      'deps_temp_beef',
      'deps_temp_cafe',
    ]);
    expect(result.preserved).toEqual(['deps', 'deps_ssr']);
    expect(result.other).toEqual(['vitest']);
  });

  it('reports a missing cache directory without throwing', () => {
    const result = classifyCacheEntries(join(cacheDir, 'does-not-exist'));

    expect(result.exists).toBe(false);
    expect(result.tempCount).toBe(0);
    expect(result.tempBytes).toBe(0);
  });

  it('counts an empty cache as clean', () => {
    const result = classifyCacheEntries(cacheDir);

    expect(result.exists).toBe(true);
    expect(result.tempCount).toBe(0);
    expect(result.tempBytes).toBe(0);
  });
});

describe('looksLikeViteProcess', () => {
  it.each([
    'node /repos/game/node_modules/.bin/vite --host',
    'node /repos/game/node_modules/vitest/vitest.mjs run --project unit',
    'npx vitest run --project unit',
    'vite',
    'node /repos/game/node_modules/vite/dist/node/cli.js',
    '/repos/game/node_modules/.bin/vitest run',
    'node /repos/game/node_modules/vitest@2.1.9/vitest.mjs run',
  ])('detects a vite/vitest process: %s', (commandLine) => {
    expect(looksLikeViteProcess(commandLine)).toBe(true);
  });

  it.each([
    'node scripts/clean-vite-cache.mjs --apply',
    'sh -c npm run build',
    'bash run-pi-agent.sh herdr-123 --model plan Run /skill:implement AH-0MVFR1LGB001BIZ7 -- Vite dep-cache hygiene',
    'node scripts/check-bundle-hygiene.mjs',
    'git push origin dev',
  ])('does not match a non-vite process: %s', (commandLine) => {
    expect(looksLikeViteProcess(commandLine)).toBe(false);
  });
});

describe('detectRunningViteProcesses', () => {
  it('filters the process table to vite/vitest entries', () => {
    const result = detectRunningViteProcesses({
      listProcesses: () => [
        { pid: 1, command: 'node /repos/game/node_modules/.bin/vite --host' },
        { pid: 2, command: 'node scripts/clean-vite-cache.mjs --apply' },
        { pid: 3, command: 'npm run test:unit' },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.processes.map((entry) => entry.pid)).toEqual([1]);
  });

  it('fails closed when the process table is unreadable', () => {
    const result = detectRunningViteProcesses({
      listProcesses: () => {
        throw new Error('ps: command not found');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/command not found/);
  });
});

describe('cleanViteCache', () => {
  it('dry-run (default) reports orphans and removes nothing (AC1)', () => {
    seedCache(cacheDir, ['deps_temp_beef']);

    const result = cleanViteCache({ cacheDir, detectProcesses: quiet });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe(false);
    expect(result.tempCount).toBe(1);
    expect(result.tempBytes).toBe(1024);
    expect(result.removedCount).toBe(0);
    expect(result.reclaimedBytes).toBe(0);
    expect(existsSync(join(cacheDir, 'deps_temp_beef'))).toBe(true);
  });

  it('apply removes only deps_temp_* and reports reclaimed bytes (AC1)', () => {
    seedCache(cacheDir);

    const result = cleanViteCache({ cacheDir, apply: true, detectProcesses: quiet });

    expect(result.applied).toBe(true);
    expect(result.removedCount).toBe(2);
    expect(result.reclaimedBytes).toBe(1024 + 512);
    expect(readdirSync(cacheDir).sort()).toEqual(['deps', 'deps_ssr', 'vitest']);
    expect(existsSync(join(cacheDir, 'deps', 'a.js'))).toBe(true);
  });

  it('refuses to delete while a vite process runs unless --force (AC2)', () => {
    seedCache(cacheDir, ['deps_temp_beef']);
    const running = () => ({
      ok: true,
      processes: [{ pid: 42, command: 'node /repos/game/node_modules/.bin/vite --host' }],
    });

    const refused = cleanViteCache({ cacheDir, apply: true, detectProcesses: running });
    expect(refused.applied).toBe(false);
    expect(refused.refused).toBe(true);
    expect(refused.reason).toBe('processes-running');
    expect(refused.processes.map((entry) => entry.pid)).toEqual([42]);
    expect(existsSync(join(cacheDir, 'deps_temp_beef'))).toBe(true);

    const forced = cleanViteCache({
      cacheDir,
      apply: true,
      force: true,
      detectProcesses: running,
    });
    expect(forced.applied).toBe(true);
    expect(existsSync(join(cacheDir, 'deps_temp_beef'))).toBe(false);
  });

  it('refuses when quiescence cannot be verified (fail-closed)', () => {
    seedCache(cacheDir, ['deps_temp_beef']);
    const undetectable = () => ({ ok: false, processes: [], error: 'ps unavailable' });

    const result = cleanViteCache({ cacheDir, apply: true, detectProcesses: undetectable });

    expect(result.applied).toBe(false);
    expect(result.refused).toBe(true);
    expect(result.reason).toBe('detection-failed');
    expect(existsSync(join(cacheDir, 'deps_temp_beef'))).toBe(true);

    const forced = cleanViteCache({
      cacheDir,
      apply: true,
      force: true,
      detectProcesses: undetectable,
    });
    expect(forced.applied).toBe(true);
  });

  it('reports not-found for a missing cache directory', () => {
    const result = cleanViteCache({
      cacheDir: join(cacheDir, 'nope'),
      apply: true,
      detectProcesses: quiet,
    });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('not-found');
  });
});

describe('parseArgs and main', () => {
  it('defaults to read-only dry-run', () => {
    expect(parseArgs([])).toMatchObject({ apply: false, force: false, json: false });
  });

  it('parses --apply, --force, --cache and --json', () => {
    const args = parseArgs(['--apply', '--force', '--cache', 'x/y', '--json']);
    expect(args.apply).toBe(true);
    expect(args.force).toBe(true);
    expect(args.json).toBe(true);
    expect(args.cacheDir.endsWith('x/y')).toBe(true);
  });

  it('rejects an unknown argument', () => {
    expect(() => parseArgs(['--nuke'])).toThrow(/Unknown argument/);
  });

  it('main dry-run reports the orphan count and returns 0', () => {
    seedCache(cacheDir, ['deps_temp_beef']);
    const calls: string[] = [];
    const logger = capture(calls);

    const code = main(['--cache', cacheDir], { logger, detectProcesses: quiet });

    expect(code).toBe(0);
    expect(calls.join('\n')).toContain('Dry run: 1 orphaned deps_temp_* dir(s) (1.0 KB)');
    expect(existsSync(join(cacheDir, 'deps_temp_beef'))).toBe(true);
  });

  it('main apply while a process runs refuses with exit 1', () => {
    seedCache(cacheDir, ['deps_temp_beef']);
    const calls: string[] = [];
    const logger = capture(calls);
    const running = () => ({
      ok: true,
      processes: [{ pid: 42, command: 'node /repos/game/node_modules/.bin/vite --host' }],
    });

    const code = main(['--apply', '--cache', cacheDir], { logger, detectProcesses: running });

    expect(code).toBe(1);
    expect(calls.join('\n')).toContain('Refusing to clean');
    expect(calls.join('\n')).toContain('pid 42');
    expect(existsSync(join(cacheDir, 'deps_temp_beef'))).toBe(true);
  });

  it('main --json prints a machine-readable result', () => {
    seedCache(cacheDir, ['deps_temp_beef']);
    const calls: string[] = [];
    const logger = capture(calls);

    const code = main(['--json', '--cache', cacheDir], { logger, detectProcesses: quiet });

    expect(code).toBe(0);
    const parsed = JSON.parse(calls[0]);
    expect(parsed.applied).toBe(false);
    expect(parsed.tempCount).toBe(1);
    expect(parsed.tempBytes).toBe(1024);
  });

  it('main returns usage error (2) for an unknown flag', () => {
    const calls: string[] = [];
    const code = main(['--nuke'], { logger: capture(calls) });
    expect(code).toBe(2);
    expect(calls.join('\n')).toMatch(/Unknown argument/);
  });
});

describe('formatBytes', () => {
  it('formats byte counts human-readably', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(158 * 1024 * 1024)).toBe('158.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

/** Builds a minimal Console-like spy collecting every call. */
function capture(calls: string[]) {
  return {
    log: (message: string) => void calls.push(String(message)),
    warn: (message: string) => void calls.push(String(message)),
    error: (message: string) => void calls.push(String(message)),
  } as unknown as Console;
}
