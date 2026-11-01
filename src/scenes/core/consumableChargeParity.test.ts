/**
 * Gym↔game parity for the **consumable charge model** (AH-0MVUXH3X60078QR3,
 * F6 of the parent AH-0MVTQMREN009DSFW).
 *
 * ## Why this file exists
 *
 * A permanently-owned consumable (hold-full reward) is now a **charge pool of
 * one-event uses**: the hold-full grant adds one charge (never a level), each
 * charge buys one event (one absorbed hit, one reflected bullet, one drone
 * spawn), and the pool regenerates on the level-derived interval through the
 * shared `EffectsRegistry.tick(dt)` clock. The spend → empty → regenerate →
 * re-use cycle must be **identical in `PlayScene` and in every gym** that
 * spawns the consumable, because the spend and regeneration never touch a
 * scene-local counter or timer (the parent's gym↔game parity rule,
 * AH-0MUGZDTFX004RBD1).
 *
 * ## Shared-code, not duplicated, assertions
 *
 * Both scenes are booted through the shared `bootScene` harness
 * (`src/test/gameHarness.ts`) and driven through the **shared** `CombatScene`
 * template loop: the same `_handleCollisions` pass (defined once in
 * `src/scenes/core/CombatScene.ts`, registered in the duplicate-body guard)
 * spends the charges, and the same registry charge pool (plus the shared tick
 * path in `EffectsRegistry.tick`) regenerates them. No expectation reads a
 * per-scene counter: every value is read from the shared registry accessors
 * (`consumableCharges`, `forceFieldRemaining`, `isShielded`) or the shared
 * level catalogue (`resolvePowerUpAtLevel`).
 *
 * @module scenes/core/consumableChargeParity (AH-0MVUXH3X60078QR3)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import { RULES_STORAGE_KEY } from '../../core/rules';
import { resolvePowerUpAtLevel } from '../../powerups/powerUpLevels';
import { LEVELS, type LevelDefinition } from '../../waves/Formations';
import type { Player } from '../../entities/Player';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import { GymPowerUpsCombat } from '../gym/GymPowerUpsCombat';

// Two real Phaser scenes are booted per case; under host load the default 5 s
// per-test timeout is not enough (observed 5.2–9.0 s at load ≈ 20).
vi.setConfig({ testTimeout: 30000 });

/** Any scene that inherits the shared `CombatScene` charge-spend loop. */
type ChargeParityScene = PlayScene | GymPowerUpsCombat;

/** The run seed pinned for the deterministic `PlayScene` boot. */
const RUN_SEED = 1;

let boots: BootedGame[] = [];

afterEach(() => {
  for (const booted of boots) booted.game.destroy(true);
  boots = [];
  document.body.innerHTML = '';
  window.localStorage.clear();
});

/**
 * A single-level campaign whose waves never fire (`shootEnabled: false`), so
 * the only bullets on screen are the ones the test parks — the charge-spend
 * assertions read the parked bullets, not incidental enemy fire.
 */
function benignCampaign(): LevelDefinition[] {
  const level = LEVELS[0];
  return [
    {
      ...level,
      level: 1,
      name: 'Consumable charge parity probe',
      waves: level.waves.map((w) => ({
        ...w,
        shootEnabled: false,
        groups: w.groups.slice(0, 1).map((g) => ({
          ...g,
          count: Math.min(g.count, 2),
        })),
      })),
    },
  ];
}

/** Boots `PlayScene` deterministically against the benign campaign. */
async function bootPlay(): Promise<PlayScene> {
  window.localStorage.setItem(
    RULES_STORAGE_KEY,
    JSON.stringify({ sequencedWavesEnabled: false }),
  );
  const booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
  boots.push(booted);
  const scene = booted.scene as PlayScene;
  scene.getWaveManager().setLevels(benignCampaign());
  scene.setAsteroidSpawnerEnabled(false);
  // Pinned seed + stopped loop: no live frame can advance the run between a
  // test's `await` points (the deterministic-boot contract, AH-0MVXWEE3L004SPTC).
  scene.setRunSeed(RUN_SEED);
  scene.scene.restart();
  await advanceGame(scene.game, 200);
  scene.game.loop.stop();
  return scene;
}

/** Boots the combat gym with the threat wave silenced. */
async function bootCombatGym(): Promise<GymPowerUpsCombat> {
  const booted = await bootScene([GymPowerUpsCombat]);
  boots.push(booted);
  const scene = booted.scene as GymPowerUpsCombat;
  scene.game.loop.stop();
  // Threats must never fire: their fire would consume the parked bullets'
  // charges unpredictably (a disabled feature is a permitted difference).
  if (scene.shootingEnabled) scene.toggleShooting();
  return scene;
}

/** Drives the shared collision pass once (the same `_handleCollisions` code). */
function resolveCollisions(scene: ChargeParityScene): void {
  (scene as unknown as { _handleCollisions(): void })._handleCollisions();
}

/** Parks one enemy bullet on the ship, then resolves the shared collision pass. */
function hitWithBullet(scene: ChargeParityScene, player: Player): void {
  scene.spawnEnemyBullet(player.x, player.y, 0, 0);
  resolveCollisions(scene);
}

describe('consumable charge parity — PlayScene and GymPowerUpsCombat (AH-0MVUXH3X60078QR3 AC3)', () => {
  it('Shield: a permanent charge is spent once per absorbed hit and re-arms on the shared recharge clock, in the game and the gym', async () => {
    const cases: Array<[string, ChargeParityScene]> = [
      ['PlayScene', await bootPlay()],
      ['GymPowerUpsCombat', await bootCombatGym()],
    ];

    for (const [label, scene] of cases) {
      const registry = scene.getEffectsRegistry();
      const player = scene.getPlayer()!;

      // Hold-full reward: one charge, never a level (parent AC1).
      registry.applyCollect('shield', true);
      expect(registry.consumableCharges('shield'), label).toBe(1);

      // Spend: the shared hit-absorb branch spends exactly one charge.
      hitWithBullet(scene, player);
      expect(registry.consumableCharges('shield'), `${label} spent`).toBe(0);
      expect(registry.isShielded, `${label} empty`).toBe(false);

      // Regenerate: one charge returns on the level-derived interval through
      // `registry.tick` — the same shared clock the scene tick drives.
      registry.tick((resolvePowerUpAtLevel('shield', 0).shieldRecharge ?? 0) + 0.1);
      expect(registry.consumableCharges('shield'), `${label} regenerated`).toBe(1);
      expect(registry.isShielded, `${label} re-armed`).toBe(true);

      // Re-use: a fresh parked bullet is absorbed again.
      (scene as unknown as { invulnerable: number }).invulnerable = 0;
      hitWithBullet(scene, player);
      expect(registry.consumableCharges('shield'), `${label} re-used`).toBe(0);
    }
  });

  it('Force Field: a permanent charge reflects one bullet, the empty pool is inert, and the recharge re-arms both scenes', async () => {
    const cases: Array<[string, ChargeParityScene]> = [
      ['PlayScene', await bootPlay()],
      ['GymPowerUpsCombat', await bootCombatGym()],
    ];

    for (const [label, scene] of cases) {
      const registry = scene.getEffectsRegistry();
      const player = scene.getPlayer()!;

      registry.applyCollect('force_field', true);
      expect(registry.forceFieldRemaining(), label).toBe(1);
      expect(registry.isForceFieldActive(), `${label} armed`).toBe(true);

      // Bullets are parked at distinct offsets around the ship so the
      // reflected player bullets and the next parked enemy bullet never
      // co-locate (they would destroy each other in the shared
      // bullets-vs-bullets pass before the reflect branch runs).
      // Spend: a bullet meeting the bubble is reflected; the shared branch
      // spends exactly one charge.
      scene.spawnEnemyBullet(player.x + 25, player.y, -100, 0);
      resolveCollisions(scene);
      expect(registry.forceFieldRemaining(), `${label} spent`).toBe(0);
      // The bubble stays up (dimmed, never an always-on armed look) but the
      // empty pool reflects nothing: a hull bullet hits the unshielded ship.
      expect(registry.isForceFieldActive(), `${label} bubble up`).toBe(true);
      scene.spawnEnemyBullet(player.x, player.y, 0, 0);
      resolveCollisions(scene);
      expect(registry.forceFieldRemaining(), `${label} still empty`).toBe(0);

      // Regenerate → re-use: the level-derived recharge returns the charge
      // and the shared reflect branch spends it again.
      registry.tick(
        (resolvePowerUpAtLevel('force_field', 0).forceFieldRecharge ?? 0) +
        0.1,
      );
      expect(registry.forceFieldRemaining(), `${label} regenerated`).toBe(1);
      scene.spawnEnemyBullet(player.x - 25, player.y, -100, 0);
      resolveCollisions(scene);
      expect(registry.forceFieldRemaining(), `${label} re-used`).toBe(0);
    }
  });
});
