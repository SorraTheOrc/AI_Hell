/**
 * Repo-level guard against wall-clock waits in tests
 * (child AH-0MVF6VVDP003L39A, parent AH-0MVF3BESP005ZDAV).
 *
 * Wall-clock `setTimeout` waits made the suite load-sensitive: under
 * full-suite parallel execution the number of animation frames (and therefore
 * the scene state) that drains during a fixed wall-clock window varies, which
 * produced the flakes AH-0MUYALJ9S0002XXZ, AH-0MV1EN1NS000QLBK and
 * AH-0MTFTIZX7005DNFW. The supported replacements are:
 *
 * - `advanceGame(game, ms)` — fixed-delta simulated time (`src/test/gameHarness.ts`);
 * - `stepGameUntil(game, label, predicate)` — pump until a condition holds;
 * - `expect.poll` / bounded polling with explicit raises, or vitest fake timers.
 *
 * The kill-isolation flake family (AH-0MV1EN1NS000QLBK) gained a Robotron
 * horde sibling: AH-0MVMEI9V1005H0LU fixed the same auto-fire/overlapping-
 * enemy interference in `killing a grunt advances wave accounting exactly
 * once` (src/scenes/PlayScene.test.ts) and added seed-pinning to the
 * pattern — `bootWithHordeWave(horde, seed)` pins the run via `setRunSeed`
 * and the hardened test uses the fixed `HORDE_KILL_FIXED_SEED`
 * (~6197-6242), so the RNG-driven horde layout and spawn schedule are
 * reproducible instead of drawn fresh per run. New kill tests asserting
 * exactly-once accounting should reuse `isolateEnemyForKill` plus a pinned
 * seed.
 *
 * A third, non-wall-clock flake family was tracked by the load-remediation
 * epic AH-0MVSBEIVK003XAFB: **environmental saturation flakes** in the
 * `scripts/` capture suites. They never had a wall-clock wait — each one was
 * a correct test with an undeclared resource assumption, so the remediation
 * is a bound or a labelled skip, not a `setTimeout` removal:
 *
 * - AH-0MVS1O1ZG007VCX3 — `scripts/capture-chunk-sink.test.ts` writes a
 *   512 MiB file (32 x 16 MiB chunks) into `os.tmpdir()`, which is a shared
 *   16 GiB tmpfs on this host; under saturation it filled and the write
 *   failed with `ENOSPC`. Fixed by resolving a headroom-checked temp root
 *   (explicit `TMPDIR` → disk-backed fallback → `os.tmpdir()`) with a
 *   labelled environmental skip naming the item when no candidate has room.
 * - AH-0MVSAPI66009T6PU — the spawned-CLI fail-fast test in
 *   `scripts/capture-gameplay.test.ts` inherits Vitest's 5 s default while
 *   spawning the real CLI's Vite-SSR loader; under CPU saturation the spawn
 *   alone took ~5.9 s and vitest killed the test mid-spawn. Fixed with an
 *   explicit per-test budget (`{ timeout: 60_000 }`) while the child's own
 *   30 s `spawnSync` bound keeps the fail-fast contract, and a thrown
 *   spawn-error message that distinguishes a starved spawn from a real
 *   contract break.
 *
 * Both fixes keep the behaviour the tests assert; the per-file budgets and
 * the skip condition are documented in `docs/dev/test-suite-timing.md`
 * ("Per-file timing budgets" and its subprocess-spawn subsection).
 *
 * The scan asserts **code**, not prose: comments and string literals are
 * stripped first, so this file's own documentation and the deterministic-boot
 * guard's regexes do not count.
 *
 * `ALLOW_LIST` names the files that still contain a wall-clock wait. It is
 * **self-pruning**: an entry with no remaining wait fails the guard, so
 * migrating a file forces the list to shrink. Every entry records why it is
 * still there and links the work item that owns it.
 *
 * The list is now **empty** — every suite was migrated by
 * AH-0MVFPMT4P005UHZL (the final batch), completing the sweep started in
 * AH-0MVF6VVDP003L39A. A new wall-clock wait therefore fails immediately;
 * use `advanceGame` / `stepGameUntil` instead.
 *
 * @module test/wallClockWaitGuard
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';
import { describe, expect, it } from 'vitest';

import { advanceGame, bootScene } from './gameHarness';

/**
 * Files that still contain wall-clock waits, with the reason and owner.
 * Entries must be removed as each file is migrated (a stale entry fails the
 * guard below).
 */
const ALLOW_LIST: Record<string, string> = {
  // Empty: every suite is migrated (AH-0MVFPMT4P005UHZL). Genuine external
  // async (child process, file I/O, telemetry flush) lives in the subprocess
  // suites, which never wait on animation frames — keep this list empty so a
  // new wall-clock wait fails the guard instead of being allow-listed.
};

const ROOT = process.cwd();
const SELF = path.resolve(ROOT, 'src/test/wallClockWaitGuard.test.ts');
/** The deterministic-boot guard also scans for `setTimeout` by design. */
const OTHER_GUARD = path.resolve(ROOT, 'src/test/deterministicBootGuard.test.ts');

/** Strips comments and string literals so only code is scanned. */
function stripNonCode(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      collectTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(path.relative(ROOT, full));
    }
  }
  return out;
}

/** Test files whose *code* contains a `setTimeout` reference. */
function filesWithWallClockWaits(): string[] {
  const roots = ['src', 'scripts'].map((dir) => path.join(ROOT, dir)).filter((d) => fs.existsSync(d));
  return roots
    .flatMap((dir) => collectTestFiles(dir))
    .filter((file) => {
      const abs = path.resolve(ROOT, file);
      if (abs === SELF || abs === OTHER_GUARD) return false;
      return /setTimeout\s*\(/.test(stripNonCode(fs.readFileSync(abs, 'utf8')));
    })
    .sort();
}

/** Minimal scene that counts the fixed-delta steps it receives. */
class StepCountingScene extends Phaser.Scene {
  updates = 0;

  constructor() {
    super('StepCountingScene');
  }

  update(): void {
    this.updates += 1;
  }
}

describe('wall-clock wait guard (AH-0MVF6VVDP003L39A)', () => {
  it('no test file outside the allow-list contains a wall-clock setTimeout wait', () => {
    const offenders = filesWithWallClockWaits().filter((file) => !(file in ALLOW_LIST));
    expect(offenders).toEqual([]);
  });

  it('the allow-list is self-pruning: every entry still has a wait to migrate', () => {
    const withWaits = new Set(filesWithWallClockWaits());
    const stale = Object.keys(ALLOW_LIST).filter((file) => !withWaits.has(file));
    expect(stale).toEqual([]);
  });

  it('the migrated batch contains no wall-clock waits', () => {
    const withWaits = filesWithWallClockWaits();
    for (const file of [
      'src/scenes/PlayScene.test.ts',
      'src/scenes/gym/GymPowerUpsUtility.test.ts',
      'src/scenes/gym/core/GymFormationScene.test.ts',
      'src/scenes/core/CombatScene.equivalence.test.ts',
    ]) {
      expect(withWaits, file).not.toContain(file);
    }
  });
});

describe('advanceGame (AH-0MVF6VVDP003L39A)', () => {
  it('advances an exact, repeatable number of fixed-delta steps and restores the loop', async () => {
    const counts: number[] = [];
    let loopRunningAfter: boolean[] = [];
    for (let run = 0; run < 2; run += 1) {
      const { game, scene } = await bootScene([StepCountingScene]);
      const stub = scene as StepCountingScene;
      const before = stub.updates;
      await advanceGame(game, 350);
      counts.push(stub.updates - before);
      loopRunningAfter.push(game.loop.running);
      game.destroy(true);
    }
    // ceil(350 / (1000/60)) = 21 fixed steps, identical on both runs.
    expect(counts[0]).toBe(21);
    expect(counts[1]).toBe(counts[0]);
    // The loop state is restored (bootScene resumes it).
    expect(loopRunningAfter).toEqual([true, true]);
  });

  it('keeps a stopped loop stopped', async () => {
    const { game, scene } = await bootScene([StepCountingScene]);
    const stub = scene as StepCountingScene;
    game.loop.stop();
    const before = stub.updates;
    await advanceGame(game, 100);
    expect(stub.updates).toBeGreaterThan(before);
    expect(game.loop.running).toBe(false);
    game.destroy(true);
  });
});
