/**
 * Shared mineral-chime dispatch — wiring, silence, reset, dense-burst and
 * defined-once guards (AH-0MWNMRDY60005Z4K).
 *
 * The cue (`playMineralCollectChimeSound`) and the pure escalation machine
 * (`audio/mineralChime.ts`) already exist. This suite pins the **single
 * dispatch point** that wires them into gameplay: `CombatCoreScene` owns one
 * `noteMineralCollected()` method, every player collection path in the game
 * and the gyms calls it exactly once per collected mineral, and nothing else
 * re-implements the ladder/gap/cue. Enemy absorption is asserted silent, the
 * run-reset/teardown seams reset the streak, and a one-frame burst is bounded
 * by the shared per-cue voice limiter.
 *
 * The repo-wide guards use `collectProductionSourceFiles` from
 * `src/test/duplicateBodyGuard.ts` (the shared source-scan helper), so the
 * "defined once" rules are enforced automatically rather than by review.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { MAX_CONCURRENT_CUE_VOICES } from '../../audio/cueVoiceLimiter';
import {
  mineralChimeStep,
  resetMineralChimeStreak,
} from '../../audio/mineralChime';
import {
  RecordingSfxProvider,
  type RecordedSfxPlay,
} from '../../test/audioTestDouble';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  collectProductionSourceFiles,
  definesFunction,
  definesMethod,
} from '../../test/duplicateBodyGuard';
import { PlayScene } from '../PlayScene';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { MineralChoiceScene } from '../MineralChoiceScene';
import { GymFodderEnemies } from '../gym/GymFodderEnemies';
import { GymLevel } from '../gym/GymLevel';
import { GymPowerUpsUtility } from '../gym/GymPowerUpsUtility';
import { GymWeaponLeveling } from '../gym/GymWeaponLeveling';
import { GymPowerUpLeveling } from '../gym/GymPowerUpLeveling';
import { Mineral } from '../../entities/Mineral';
import { Harvester } from '../../entities/Harvester';

// Boots real Phaser scenes (slow under parallel load) — give the file headroom.
vi.setConfig({ testTimeout: 60000 });

const SRC_ROOT = path.resolve(process.cwd(), 'src');

/** Reads a production source file. */
function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Repo-relative path for a source file. */
function rel(file: string): string {
  return path.relative(process.cwd(), file);
}

/** Every production (non-test) TypeScript file under `src`. */
function productionFiles(): string[] {
  return collectProductionSourceFiles(SRC_ROOT);
}

/** The baked mineral-chime asset URL (single seed, so it is deterministic). */
const CHIME_URL_FRAGMENT = 'aihell-mineral-chime';

/** The admitted chime voices recorded by the provider double. */
function chimePlays(recording: RecordingSfxProvider): RecordedSfxPlay[] {
  return recording.plays.filter((play) => play.url.includes(CHIME_URL_FRAGMENT));
}

/** Replaces a scene's live mineral field (clearing the existing one). */
function replaceMineralField<T extends { destroy(): void }>(
  scene: object,
  next: T[],
): void {
  const holder = scene as unknown as { minerals: T[] };
  for (const mineral of holder.minerals) mineral.destroy();
  holder.minerals = next;
}

describe('shared mineral-chime dispatch (AH-0MWNMRDY60005Z4K)', () => {
  const games: BootedGame[] = [];
  let recording: RecordingSfxProvider;

  beforeEach(() => {
    resetMineralChimeStreak();
    effectsModule._resetAudioContextForTests();
    recording = new RecordingSfxProvider();
    effectsModule.setSfxSoundProvider(recording);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    effectsModule._resetAudioContextForTests();
    resetMineralChimeStreak();
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  /**
   * Boots a scene class list and tracks the game for teardown.
   *
   * The gym scenes seed a random mineral field in `create()`, so the
   * deterministic boot steps can legitimately collect a seeded mineral on the
   * player's spawn point and play a chime before a case sets up its own field.
   * Every case measures the chimes its *own* frame produces, so the recorded
   * plays and the shared streak are cleared once the boot settles.
   */
  async function boot<T extends Phaser.Scene>(
    sceneClasses: (typeof Phaser.Scene)[],
    parent: string,
  ): Promise<T> {
    const booted = await bootScene(sceneClasses, parent);
    games.push(booted);
    recording.plays.length = 0;
    resetMineralChimeStreak();
    return booted.scene as T;
  }

  // ── Every player collection path calls the one shared dispatch ────

  describe('every player collection path plays exactly one chime per mineral', () => {
    it('PlayScene._collectMineral', async () => {
      const play = await boot<PlayScene>(
        [PlayScene, GameOverScene, MenuScene],
        'chime-play',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const player = play.getPlayer()!;
      replaceMineralField(play, []);
      play.spawnMineralAt(player.x, player.y);
      play.tick(1 / 60);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('GymFormationScene._collectMineral (through a real formation gym)', async () => {
      const gym = await boot<GymFodderEnemies>(
        [GymFodderEnemies],
        'chime-formation',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const player = gym.getPlayer()!;
      replaceMineralField(gym, [
        new Mineral(gym, { x: player.x, y: player.y }),
      ]);
      gym.tick(1 / 60);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('GymLevel._collectMineral', async () => {
      const gym = await boot<GymLevel>([GymLevel], 'chime-level');
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const player = gym.getPlayer()!;
      replaceMineralField(gym, [
        new Mineral(gym, { x: player.x, y: player.y }),
      ]);
      gym.tick(1 / 60);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('GymPowerUpsUtility._collectGymMineral', async () => {
      const gym = await boot<GymPowerUpsUtility>(
        [GymPowerUpsUtility],
        'chime-utility',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const player = gym.getPlayer()!;
      replaceMineralField(gym, []);
      gym.spawnMineral(player.x, player.y);
      gym.tick(1 / 60);

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('GymWeaponLeveling._collectMineralsOverlapping', async () => {
      const gym = await boot<GymWeaponLeveling>(
        [GymWeaponLeveling, MineralChoiceScene],
        'chime-weapon-leveling',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const player = gym.getPlayer()!;
      replaceMineralField(gym, []);
      gym.spawnMineral(player.x, player.y);
      gym.collectMineralsOverlapping();

      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('GymPowerUpLeveling._collectMineralsOverlapping', async () => {
      const gym = await boot<GymPowerUpLeveling>(
        [GymPowerUpLeveling, MineralChoiceScene],
        'chime-power-up-leveling',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const player = gym.getPlayer()!;
      replaceMineralField(gym, []);
      gym.spawnMineral(player.x, player.y);
      gym.collectMineralsOverlapping();

      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  // ── Enemy absorption is silent (player-only feedback) ─────────────

  describe('enemy absorption plays no chime', () => {
    it('an enemy absorbing a mineral in the game stays silent', async () => {
      const play = await boot<PlayScene>(
        [PlayScene, GameOverScene, MenuScene],
        'chime-absorb-play',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const harvester = new Harvester(play, {
        x: 280,
        y: 100,
        formationOffset: { row: 0, col: 0 },
      });
      play.registerEnemy(harvester as unknown as never, 'harvester');
      replaceMineralField(play, [
        new Mineral(play, { x: 300, y: 100 }),
      ]);
      play.tick(1 / 60);

      expect(harvester.mineralCount).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    });

    it('an enemy absorbing a mineral in a gym stays silent', async () => {
      const gym = await boot<GymFodderEnemies>(
        [GymFodderEnemies],
        'chime-absorb-gym',
      );
      const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
      const harvester = new Harvester(gym, {
        x: 280,
        y: 100,
        formationOffset: { row: 0, col: 0 },
      });
      gym.registerDynamicEntity(harvester as never);
      replaceMineralField(gym, [
        new Mineral(gym, { x: 300, y: 100 }),
      ]);
      gym.tick(1 / 60);

      expect(harvester.mineralCount).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // ── Run reset and scene teardown return the streak to base ────────

  it('resetRunState and teardownRunState reset the streak to base', async () => {
    const play = await boot<PlayScene>(
      [PlayScene, GameOverScene, MenuScene],
      'chime-reset',
    );
    const spy = vi.spyOn(effectsModule, 'playMineralCollectChimeSound');
    const player = play.getPlayer()!;
    replaceMineralField(play, []);

    // Two quick pickups climb the shared ladder by one degree.
    play.spawnMineralAt(player.x, player.y);
    play.tick(1 / 60);
    play.spawnMineralAt(player.x, player.y);
    play.tick(1 / 60);
    expect(mineralChimeStep()).toBeGreaterThan(0);

    // A restarted run starts from the base pitch …
    (play as unknown as { resetRunState(): void }).resetRunState();
    expect(mineralChimeStep()).toBe(0);
    // … and the next pickup after the reset is the base degree.
    (play as unknown as { noteMineralCollected(): void }).noteMineralCollected();
    expect(spy).toHaveBeenLastCalledWith(0);

    // A scene shutdown returns the streak to base as well.
    (play as unknown as { noteMineralCollected(): void }).noteMineralCollected();
    (play as unknown as { noteMineralCollected(): void }).noteMineralCollected();
    expect(mineralChimeStep()).toBeGreaterThan(0);
    (play as unknown as { teardownRunState(): void }).teardownRunState();
    expect(mineralChimeStep()).toBe(0);
  });

  // ── Dense burst is bounded by the shared voice limiter ────────────

  describe('a dense burst is bounded by the shared voice limiter', () => {
    beforeEach(() => {
      // Freeze wall time so the limiter's 150 ms window cannot expire
      // mid-burst and the assertion is deterministic.
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    });

    it('a scattered pair plays one chime each (below the cap)', async () => {
      const play = await boot<PlayScene>(
        [PlayScene, GameOverScene, MenuScene],
        'chime-burst-pair',
      );
      const player = play.getPlayer()!;
      replaceMineralField(play, []);
      play.spawnMineralAt(player.x, player.y);
      play.spawnMineralAt(player.x + 1, player.y + 1);

      expect(() => play.tick(1 / 60)).not.toThrow();
      expect(chimePlays(recording)).toHaveLength(2);
      expect(mineralChimeStep()).toBe(1);
    });

    it('a Mineral Scoop sweep admits at most the shared cap', async () => {
      const gym = await boot<GymPowerUpsUtility>(
        [GymPowerUpsUtility],
        'chime-burst-scoop',
      );
      const player = gym.getPlayer()!;
      replaceMineralField(gym, []);
      gym.getEffectsRegistry().applyCollect('mineral_scoop');
      expect(gym.getEffectsRegistry().scoopEffectStacks()).toBeGreaterThan(0);

      // Ring the ship just outside the collection hull but inside the scoop
      // radius, so one large frame pulls them all in and collects them.
      const count = 24;
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2;
        gym.spawnMineral(
          player.x + Math.cos(angle) * 18,
          player.y + Math.sin(angle) * 18,
        );
      }
      expect(gym.getMinerals()).toHaveLength(count);

      expect(() => gym.tick(0.2)).not.toThrow();
      // Every mineral was swept into the hull in that one frame …
      expect(gym.getMinerals()).toHaveLength(0);
      // … and only the shared limiter throttled the cue dispatch.
      expect(chimePlays(recording)).toHaveLength(MAX_CONCURRENT_CUE_VOICES);
    });

    it('a 100-mineral gym field admits at most the shared cap', async () => {
      const gym = await boot<GymWeaponLeveling>(
        [GymWeaponLeveling, MineralChoiceScene],
        'chime-burst-100',
      );
      const player = gym.getPlayer()!;
      replaceMineralField(gym, []);
      for (let i = 0; i < 100; i++) gym.spawnMineral(player.x, player.y);
      expect(gym.getMinerals()).toHaveLength(100);

      expect(() => gym.collectMineralsOverlapping()).not.toThrow();
      expect(gym.getMinerals()).toHaveLength(0);
      expect(chimePlays(recording)).toHaveLength(MAX_CONCURRENT_CUE_VOICES);
    });
  });

  // ── Defined-once guard (no scene re-implements the rule) ──────────

  describe('the ladder/gap/cue dispatch is defined exactly once repo-wide', () => {
    it('the escalation machine, the cue and the dispatch are single-sourced', () => {
      const files = productionFiles();
      expect(files.length).toBeGreaterThan(0);

      const stateMachine = files
        .filter((file) => definesFunction(read(file), 'createMineralChime'))
        .map(rel)
        .sort();
      expect(stateMachine).toEqual(['src/audio/mineralChime.ts']);

      const cue = files
        .filter((file) =>
          definesFunction(read(file), 'playMineralCollectChimeSound'),
        )
        .map(rel)
        .sort();
      expect(cue).toEqual(['src/audio/effects.ts']);

      // The shared dispatch is defined once, in the shared core — no scene
      // defines its own copy or override.
      const sceneDispatch = files
        .filter(
          (file) =>
            rel(file).startsWith('src/scenes/') &&
            definesMethod(read(file), 'noteMineralCollected'),
        )
        .map(rel)
        .sort();
      expect(sceneDispatch).toEqual(['src/scenes/core/CombatCoreScene.ts']);
    });

    it('no production scene calls the cue directly or imports the escalation rule', () => {
      const files = productionFiles();

      // The only call site outside the cue's own definition module.
      const cueCallers = files
        .filter((file) => rel(file) !== 'src/audio/effects.ts')
        .filter((file) => read(file).includes('playMineralCollectChimeSound('))
        .map(rel)
        .sort();
      expect(cueCallers).toEqual(['src/scenes/core/CombatCoreScene.ts']);

      // Only the cue wrapper (rate lookup) and the shared core (state machine)
      // may touch the escalation module; no scene keeps a copy.
      const escalationImporters = files
        .filter((file) =>
          /from\s+['"][^'"]*\/mineralChime['"]/.test(read(file)),
        )
        .map(rel)
        .sort();
      expect(escalationImporters).toEqual([
        'src/audio/effects.ts',
        'src/scenes/core/CombatCoreScene.ts',
      ]);
    });
  });
});
