/**
 * HUD integration tests for PlayScene (AH-0MU731VTE004PPC9 — child 8).
 *
 * Verifies that the standalone HUD's lives counter, active-effects rows,
 * and the scene's neon score/level readouts stay in sync with the run
 * state during gameplay, persist across levels, and react immediately to
 * player damage.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { advanceGame, bootScene, stepGameUntil, type BootedGame } from '../test/gameHarness';
import {
  CHECKPOINT_STORAGE_KEY,
  CHECKPOINT_VERSION,
  type Checkpoint,
} from '../core/checkpointStore';
import { POWER_UP_CHARGE_CAP } from '../powerups/powerUpLevels';
import type { PowerUpId, WeaponDropId } from '../powerups/types';
import { toChoiceOption } from '../powerups/choice';
import { applyMineralChoiceReward } from '../powerups/choiceReward';
import type { WeaponId } from '../utils/weapons';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';

// The AC4 walk clears all of Level 1 (ten waves plus the wave-10 mini-boss)
// with deterministic ticks. That is pure computation, but it needs well over
// Vitest's default 5 s under full-suite parallel load (observed 6.5-8.0 s),
// which reported a spurious timeout (AH-0MVHCC9XI007DARU). Same convention as
// the other full-level walks (PlayScene.test.ts, SceneNavigation.test.ts):
// headroom for load, never weaker assertions.
vi.setConfig({ testTimeout: 120000 });

describe('PlayScene — HUD integration (AH-0MU731VTE004PPC9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    // Complete the wormhole spawn animation so enemies are collidable.
    scene.finishSpawnAnimations();
    scene.tick(0.001);
    return scene;
  }

  /** Grows a drop to full size so it is immediately collectible. */
  function growDrop(scene: PlayScene, id: 'speed_boost' | 'extra_life') {
    const player = scene.getPlayer()!;
    const drop = scene.spawnPowerUpDrop(id, player.x, player.y)!;
    for (let i = 0; i < 40; i++) drop.powerUp.advance(0.05);
    expect(drop.powerUp.canCollect()).toBe(true);
    return drop;
  }

  function scoreText(scene: PlayScene, text: string): Phaser.GameObjects.Text | undefined {
    return (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === text,
    );
  }

  it('AC1 — the HUD is present during gameplay with the lives counter', async () => {
    const scene = await bootPlay();
    const hud = scene.getHUD();
    expect(hud).not.toBeNull();
    // Default 3 lives shown by the HUD lives counter.
    expect(hud!.getLivesLabel()).toBe('Lives: 3');
  });

  it('AC5 — a player hit immediately decrements the HUD lives counter', async () => {
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    scene.spawnEnemyBullet(player.x, player.y, 0, 0);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(2);
    expect(scene.getHUD()!.getLivesLabel()).toBe('Lives: 2');
  });

  it('AC2 — the neon score readout updates as enemies are destroyed', async () => {
    const scene = await bootPlay();
    const score = 'Score: 0';
    expect(scoreText(scene, score)).toBeDefined();

    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);

    // Wave 1 is Scout-only (100 points per destroy, GDD §4.5).
    expect(scoreText(scene, 'Score: 100')).toBeDefined();
  });

  it('AC3 — collected timed power-ups appear as HUD effect rows', async () => {
    const scene = await bootPlay();
    growDrop(scene, 'speed_boost');
    scene.tick(0.016);
    scene.tick(0.016);

    const hud = scene.getHUD()!;
    expect(hud.getRows().some((row) => row.id === 'speed_boost')).toBe(true);
  });

  it('AC1/AC5P8 — collecting P8 Extra Life raises the HUD lives counter', async () => {
    const scene = await bootPlay();
    growDrop(scene, 'extra_life');
    scene.tick(0.016);
    scene.tick(0.016);

    expect(scene.getGameState().lives).toBe(4);
    expect(scene.getHUD()!.getLivesLabel()).toBe('Lives: 4');
  });

  it('AC4 — score accumulates across level transitions without resetting', async () => {
    const scene = await bootPlay();
    const wm = scene.getWaveManager();

    // Earn score on Level 1.
    const enemy = scene.getEnemies().find((e) => e.alive)!;
    scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    scene.tick(0.016);
    const scoreOnLevel1 = scene.getGameState().score;
    expect(scoreOnLevel1).toBeGreaterThan(0);

    // Clear the rest of Level 1 and advance to Level 2.
    for (let guard = 0; guard < 500 && scene.getAliveCount() > 0; guard++) {
      const e = scene.getEnemies().find((x) => x.alive)!;
      scene.spawnPlayerBullet(e.x, e.y, 0, 0);
      scene.tick(0.016);
    }
    if (scene.isTransitioning()) scene.tick(1.6);
    let guard = 0;
    while (wm.level === 1 && guard++ < 20) {
      for (let g = 0; g < 500 && scene.getAliveCount() > 0; g++) {
        const e = scene.getEnemies().find((x) => x.alive)!;
        scene.spawnPlayerBullet(e.x, e.y, 0, 0);
        scene.tick(0.016);
      }
      // Resolve the mini-boss reward choice if the defeat offered one
      // (AH-0MVCRBNO6003E1CH) so the walk can continue, then defeat the
      // wave-10 mini-boss (a separate gating entity, not in the spawned set)
      // so the level can complete (AH-0MVCRBISU006NUN5).
      if (scene.isMiniBossRewardOpen()) scene.selectMiniBossReward(0);
      const miniBoss = scene.getMiniBoss();
      if (miniBoss?.alive) {
        for (let h = 0; h < 400 && miniBoss.alive; h++) {
          // Resolve a hold-full pause so each tick resolves the bullet.
          if (scene.isMineralChoiceOpen()) {
            scene.selectMineralChoice(0);
            continue;
          }
          scene.spawnPlayerBullet(miniBoss.x, miniBoss.y, 0, 0);
          // A zero-length step resolves collisions without moving the target.
          scene.tick(0);
        }
      }
      // The defeat plays a tween-driven death sweep before finalising (the
      // reward overlay + the level advance); step the game loop to complete
      // it so the walk can continue (AH-0MVROELN600410GP).
      if (scene.isMiniBossSweepActive()) {
        stepGameUntil(
          scene.game,
          'mini-boss death sweep',
          () => !scene.isMiniBossSweepActive(),
          240,
        );
      }
      // The defeat offers the upgrade-or-unlock reward; resolve it.
      if (scene.isMiniBossRewardOpen()) scene.selectMiniBossReward(0);
      if (scene.isTransitioning()) scene.tick(1.6);
    }

    expect(wm.level).toBe(2);
    expect(scene.getGameState().score).toBeGreaterThanOrEqual(scoreOnLevel1);
  });
});

/**
 * Checkpoint-resume HUD parity (AH-0MVSHI07B003BZIP).
 *
 * The HUD renders its upgrade rows from `EffectsRegistry` runtime state, so a
 * resume that only replayed the ship's levels left the list (almost) empty and
 * several permanent upgrades inert. These tests pin the fix: a resumed run is
 * granted through the **same shared seam** live play uses, so its rows and
 * effect state match a live run with identical grants.
 */
describe('PlayScene — checkpoint resume restores HUD + effect state (AH-0MVSHI07B003BZIP)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** The permanent weapon levels the seeded checkpoint owns. */
  const WEAPON_LEVELS: Array<{ id: WeaponId; level: number }> = [
    { id: 'spread', level: 2 },
  ];

  /**
   * The permanent power-up levels the seeded checkpoint owns. Deliberately
   * exercises every HUD visibility rule: timed-but-permanent (shield, speed
   * boost, frenzy, chrono, force field), permanent pulses (bomb, smart bomb,
   * strike), the thorns budget, the charge pools (phase shift, teleport —
   * teleport is over-granted to prove the cap) and the permanent-stack hybrids
   * (magnet, mineral scoop). Extra Life is included to pin the lives hazard.
   */
  const POWER_UP_LEVELS: Array<{ id: PowerUpId; level: number }> = [
    { id: 'shield', level: 1 },
    { id: 'speed_boost', level: 1 },
    { id: 'bomb', level: 1 },
    { id: 'smart_bomb', level: 1 },
    { id: 'strike', level: 1 },
    { id: 'thorns', level: 1 },
    { id: 'frenzy', level: 1 },
    { id: 'chrono', level: 1 },
    { id: 'force_field', level: 1 },
    { id: 'phase_shift', level: 2 },
    // Over the charge cap on purpose: the replay must clamp, never stack.
    { id: 'teleport', level: POWER_UP_CHARGE_CAP + 2 },
    { id: 'magnet', level: 1 },
    { id: 'mineral_scoop', level: 1 },
    { id: 'extra_life', level: 2 },
  ];

  /** A resumable checkpoint carrying permanent weapon/power-up progress. */
  const CHECKPOINT: Checkpoint = {
    version: CHECKPOINT_VERSION,
    level: 4,
    wave: 1,
    lives: 2,
    score: 9876,
    minerals: 3,
    weaponLevels: WEAPON_LEVELS,
    powerUpLevels: POWER_UP_LEVELS,
    unlockedWeapons: [],
    runSeed: 4242,
    savedAt: '2026-10-20T00:00:00.000Z',
  };

  /** Boots a fresh game whose PlayScene continues from {@link CHECKPOINT}. */
  async function bootResumed(): Promise<PlayScene> {
    localStorage.setItem(CHECKPOINT_STORAGE_KEY, JSON.stringify(CHECKPOINT));
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    // Mirror `MenuScene`'s Continue flow: restart PlayScene with `resume`.
    booted.game.scene.start('PlayScene', { resume: true });
    await advanceGame(booted.game, 150);
    const scene = booted.game.scene.getScene('PlayScene') as PlayScene;
    scene.finishSpawnAnimations();
    scene.tick(0.001);
    return scene;
  }

  /**
   * Boots a **non-resumed** run and applies the identical permanent grants
   * through the live-play seam — the reference a resumed run must match.
   */
  async function bootLiveGrants(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    const registry = scene.getEffectsRegistry();
    const player = scene.getPlayer();
    for (const entry of WEAPON_LEVELS) {
      for (let i = 0; i < entry.level; i += 1) {
        applyMineralChoiceReward(
          toChoiceOption(entry.id as WeaponDropId),
          registry,
          player,
        );
      }
    }
    for (const entry of POWER_UP_LEVELS) {
      for (let i = 0; i < entry.level; i += 1) {
        applyMineralChoiceReward(toChoiceOption(entry.id), registry, player);
      }
    }
    scene.finishSpawnAnimations();
    scene.tick(0.001);
    return scene;
  }

  /** Text of every HUD row name/value rendered for the scene. */
  function hudTexts(scene: PlayScene): string[] {
    return (scene.getHUD()!.list as Phaser.GameObjects.GameObject[])
      .filter((child): child is Phaser.GameObjects.Text =>
        child instanceof Phaser.GameObjects.Text,
      )
      .map((child) => child.text);
  }

  it('AC1 — a resumed run renders the same upgrade rows as a live run with the same grants', async () => {
    const resumed = await bootResumed();
    const resumedRows = resumed.getHUD()!.getRows();
    // Every seeded power-up is represented: the bug left most of them out.
    expect(resumedRows.length).toBeGreaterThanOrEqual(POWER_UP_LEVELS.length - 1);
    expect(resumedRows.some((row) => row.id === 'shield')).toBe(true);
    expect(resumedRows.some((row) => row.id === 'bomb')).toBe(true);
    expect(resumedRows.every((row) => row.value === '∞')).toBe(true);

    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();

    const live = await bootLiveGrants();
    // Exact parity: same labels, levels and ∞ values as live play.
    expect(resumedRows).toEqual(live.getHUD()!.getRows());
  });

  it('AC1 — weapon rows are restored with their run-scoped level', async () => {
    const scene = await bootResumed();
    expect(hudTexts(scene)).toContain('Weapon: spread Lvl 2');
  });

  it('AC2 — a resumed run arms every restored permanent effect', async () => {
    const scene = await bootResumed();
    const registry = scene.getEffectsRegistry();

    expect(registry.isBombPermanent()).toBe(true);
    expect(registry.isSmartBombPermanent()).toBe(true);
    expect(registry.isStrikePermanent()).toBe(true);
    expect(registry.isActive('shield')).toBe(true);
    expect(registry.shieldAbsorptionsRemaining()).toBeGreaterThan(0);
    expect(registry.thornsRemaining()).toBeGreaterThan(0);
    expect(registry.isActive('frenzy')).toBe(true);
    expect(registry.isActive('chrono')).toBe(true);
    expect(registry.isForceFieldActive()).toBe(true);

    const weapons = registry.activeWeapons();
    expect(weapons.map((weapon) => weapon.weaponId)).toContain('spread');
    expect(weapons.every((weapon) => weapon.permanent === true)).toBe(true);
  });

  it('AC4 — Extra Life replay never raises lives above the saved value', async () => {
    const scene = await bootResumed();
    expect(scene.getGameState().lives).toBe(CHECKPOINT.lives);
    expect(scene.getEffectsRegistry().lives()).toBe(CHECKPOINT.lives);
    expect(scene.getHUD()!.getLivesLabel()).toBe(`Lives: ${CHECKPOINT.lives}`);
    expect(scene.getGameState().score).toBe(CHECKPOINT.score);
    expect(scene.getGameState().minerals).toBe(CHECKPOINT.minerals);
    expect(scene.getRunSeed()).toBe(CHECKPOINT.runSeed);
  });

  it('AC5 — replaying an over-granted charge pool stays within POWER_UP_CHARGE_CAP', async () => {
    const scene = await bootResumed();
    const registry = scene.getEffectsRegistry();
    expect(registry.teleportStacks()).toBe(POWER_UP_CHARGE_CAP);
    expect(registry.teleportStacks()).toBeLessThanOrEqual(POWER_UP_CHARGE_CAP);
    expect(registry.phaseCharges()).toBeLessThanOrEqual(POWER_UP_CHARGE_CAP);
    expect(registry.phaseCharges()).toBeGreaterThan(0);
  });

  it('AC3 — a fresh (non-resume) run starts with no upgrade rows or effects', async () => {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.finishSpawnAnimations();
    scene.tick(0.001);

    expect(scene.getHUD()!.getRows()).toHaveLength(0);
    expect(scene.getEffectsRegistry().activeWeapons()).toHaveLength(0);
  });
});