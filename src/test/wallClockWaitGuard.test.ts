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
 * The scan asserts **code**, not prose: comments and string literals are
 * stripped first, so this file's own documentation and the deterministic-boot
 * guard's regexes do not count.
 *
 * `ALLOW_LIST` names the files that still contain a wall-clock wait. It is
 * **self-pruning**: an entry with no remaining wait fails the guard, so
 * migrating a file forces the list to shrink. Every entry records why it is
 * still there and links the work item that owns it.
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
  'src/scenes/GameOverScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/MenuScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/SettingsScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/GymIndex.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/__tests__/MineralChoiceScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/TelemetryConsentScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/entities/Player.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymWeapons.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymPowerUpsCombat.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymBoss.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/__tests__/PlayScene.minerals.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/LeaderboardScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/PauseSettingsIntegration.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/demoMode.integration.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/demoBaselineDiscriminating.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/RebindableControls.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/PlayScenePause.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/PauseScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/HelpScene.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/utils/gymHelp.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/core/Game.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymPlayer.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymLevel.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymMinerals.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymPowerUpLeveling.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymWeaponLeveling.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymBotTuning.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
  'src/scenes/gym/GymCurveSequencer.test.ts':
    'pending migration — owned by the follow-up batch item for the remaining suites',
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
