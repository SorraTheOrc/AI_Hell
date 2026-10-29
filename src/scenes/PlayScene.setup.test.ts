/**
 * TEST-FIRST contract: the shipped game scene consumes a capture `setup`
 * (AH-0MVTNTGXR0026LVN, parent AH-0MVTN7EJY004713X, producer Q3).
 *
 * The teaser video records the **real game** with the **bot playing**, so the
 * gym `setup` seam it used before is not available — gym scenes draw debug
 * chrome (index link, DAMAGE buttons) and never move the ship. These tests
 * specify the same capability on `PlayScene`: a dev-gated launch-data `setup`
 * that grants the starting loadout/power-ups, forces the hold-full reward and
 * previews the boss's remaining hits.
 *
 * These started life as `it.fails` red-before markers (the convention used by
 * AH-0MVRMFMJP0070KTS) in AH-0MVTNTGXR0026LVN; the implementation slice
 * AH-0MVTNTHE0008UT2C turned them green, so they are ordinary assertions now.
 */

import { describe, expect, it } from 'vitest';

import { PlayScene } from './PlayScene';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { parseSceneConfig, parseSceneSetup } from '../../scripts/capture-scenes.mjs';

/** Boots a real game and hands back the running `PlayScene`. */
async function bootPlay(
  data?: Record<string, unknown>,
): Promise<{ scene: PlayScene; booted: BootedGame }> {
  const booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
  const scene = booted.scene as PlayScene;
  scene.scene.start('PlayScene', { demo: true, ...(data ?? {}) });
  await advanceGame(scene.game, 60);
  return { scene, booted };
}

const setupOf = (scene: PlayScene): unknown =>
  (scene as unknown as { getSceneSetup(): unknown }).getSceneSetup();

describe('PlayScene setup contract (AH-0MVTNTGXR0026LVN)', () => {
  // ── AC1: the parser accepts a setup on PlayScene ──────────────────

  it('AC1 — parses a PlayScene entry carrying a setup', () => {
    const [scene] = parseSceneConfig({
      scenes: [
        {
          target: 'PlayScene',
          playMs: 1000,
          captureMs: 9000,
          label: 'boss beat',
          seed: 4242,
          level: 10,
          setup: {
            player: { weapons: ['spread'], weaponLevels: { rapid: 3 } },
            powerUps: { magnet: 2 },
            mineralReward: 'mineral_scoop',
            bossHitsRemaining: 12,
          },
        },
      ],
    });

    expect(scene.target).toBe('PlayScene');
    expect(scene.seed).toBe(4242);
    expect(scene.level).toBe(10);
    expect(scene.setup?.player?.weaponLevels).toEqual({ rapid: 3 });
    expect(scene.setup?.mineralReward).toBe('mineral_scoop');
    expect(scene.setup?.bossHitsRemaining).toBe(12);
    // The normalised setup re-validates for the game scene.
    expect(() =>
      parseSceneSetup(scene.setup as object, 'PlayScene'),
    ).not.toThrow();
  });

  // Already true today (PlayScene refuses any setup); it must stay true once
  // the documented subset is accepted, so this one is a plain assertion.
  it('AC1 — rejects a gym-only field inside a PlayScene setup', () => {
    expect(() =>
      parseSceneSetup(
        { level: { level: 1, name: 'nope', waves: [] } },
        'PlayScene',
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'setup-not-supported' }),
    );
  });

  // ── AC2: the loadout reaches the run's player ────────────────────

  it('AC2 — grants the configured loadout and power-ups to the player', async () => {
    const { scene, booted } = await bootPlay({
      setup: {
        player: { weapons: ['spread'], weaponLevels: { rapid: 2 } },
        powerUps: { magnet: 3 },
      },
    });
    try {
      const player = scene.getPlayer()!;
      const weaponLevels = player.getWeaponLevels();
      expect(weaponLevels.find((w) => w.id === 'spread')?.level).toBe(1);
      expect(weaponLevels.find((w) => w.id === 'rapid')?.level).toBe(2);
      expect(
        player.getPowerUpLevels().find((p) => p.id === 'magnet')?.level,
      ).toBe(3);
    } finally {
      booted.game.destroy(true);
    }
  });

  // ── AC3: forced hold-full reward ─────────────────────────────────

  it('AC3 — forces the configured hold-full reward instead of a random one', async () => {
    const { scene, booted } = await bootPlay({
      setup: { mineralReward: 'mineral_scoop' },
    });
    try {
      // The scene reports what it will apply (a seam like the level gym's
      // `pendingMineralReward`), so the resolution is inspectable without
      // driving a full mineral hold in a test.
      const forced = (
        scene as unknown as { getForcedMineralReward(): string | null }
      ).getForcedMineralReward();
      expect(forced).toBe('mineral_scoop');

      // And the option the demo auto-select applies is that reward, so the
      // forced resolution is what lands on camera.
      const options = scene.openMineralChoice();
      const index = (
        scene as unknown as { preferredDemoChoiceIndex(): number }
      ).preferredDemoChoiceIndex();
      expect(options[index]?.id).toBe('mineral_scoop');
    } finally {
      booted.game.destroy(true);
    }
  });

  // ── AC4: boss hits preview ───────────────────────────────────────

  it('AC4 — spawns the boss with the configured hits remaining', async () => {
    const { scene, booted } = await bootPlay({
      setup: { bossHitsRemaining: 12 },
    });
    try {
      (scene as unknown as { spawnBoss(options?: unknown): void }).spawnBoss();
      const boss = scene.getBoss();
      expect(boss).not.toBeNull();
      expect(
        boss!.getHpFraction() * (4 * 50), // BOSS_PHASE_COUNT * HIT_POINTS
      ).toBeCloseTo(12, 0);
    } finally {
      booted.game.destroy(true);
    }
  });

  // ── AC5: production inertness ────────────────────────────────────

  it('AC5 — reports the dev-gated setup the scene will apply', async () => {
    const { scene, booted } = await bootPlay({
      setup: { player: { weaponLevels: { rapid: 3 } }, bossHitsRemaining: 12 },
    });
    try {
      // `getSceneSetup()` reports what the scene will actually apply; a
      // production build must report `null` (the dev gate folds it away).
      expect(setupOf(scene)).not.toBeNull();
    } finally {
      booted.game.destroy(true);
    }
  });
});
