/**
 * GymMiniBoss — config-driven mini-boss gym scene (AH-0MVCRAYSH0014BQJ AC3).
 *
 * Asserts observable behaviour through the scene's public API:
 *  - the single `MiniBoss` boots with the demo config (phases, HP, colour);
 *  - the shared `tick(dt)` advances the boss and collects its volley (the
 *    same shared `CombatScene._advanceBoss` path PlayScene uses);
 *  - the DAMAGE button advances phases at the configured HP;
 *  - config-summoned minions join the shared collision pass.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import {
  GymMiniBoss,
  MINI_BOSS_GYM_COLOR,
  MINI_BOSS_GYM_HP_PER_PHASE,
  MINI_BOSS_GYM_MINIONS,
  MINI_BOSS_GYM_NAME,
  MINI_BOSS_GYM_PHASES,
  MINI_BOSS_FORMATION_START_X,
  MINI_BOSS_FORMATION_START_Y,
} from './GymMiniBoss';

/** Finds an on-screen text button by label. */
function findButton(
  scene: Phaser.Scene,
  label: string,
): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `button "${label}" not found`).toBeDefined();
  return found!;
}

describe('GymMiniBoss — config-driven mini-boss gym (AH-0MVCRAYSH0014BQJ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymMiniBoss> {
    booted = await bootScene([GymMiniBoss]);
    return booted!.scene as GymMiniBoss;
  }

  it('AC3 — boots a scene rendering the config-driven MiniBoss entity', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;

    expect(scene.sys.isActive()).toBe(true);
    expect(boss).toBeDefined();
    expect(boss.alive).toBe(true);
    expect(scene.children.list.includes(boss)).toBe(true);
    expect(boss.bodyVisible).toBe(true);

    // Demo config is applied: phase set, HP, colour and identity.
    expect(boss.getPhaseCount()).toBe(MINI_BOSS_GYM_PHASES.length);
    expect(boss.getPhaseNumber()).toBe(1);
    expect(boss.getColor()).toBe(MINI_BOSS_GYM_COLOR);
    expect(boss.resolvedConfig.name).toBe(MINI_BOSS_GYM_NAME);
    expect(boss.getHpFraction()).toBe(1);

    // Spawn anchor is the shared formation start (figure-of-eight centre).
    expect(boss.getMoveAnchorX()).toBeCloseTo(MINI_BOSS_FORMATION_START_X, 1);
    expect(boss.getMoveAnchorY()).toBeCloseTo(MINI_BOSS_FORMATION_START_Y, 1);
  });

  it('AC3 — the shared tick advances the boss and collects its volley', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;
    boss.shootEnabled = true;
    // Simulate the telegraph elapsing and move the scene clock past the
    // volley interval; the shared `_advanceBoss` tick then appends the
    // configured phase-1 spread volley to the enemy-bullet list.
    boss._simulateTelegraphElapsed();
    scene.time.now = 2_000_000;

    scene.tick(1 / 60);

    expect(scene.getLiveEnemyBullets().length).toBeGreaterThan(0);
  });

  it('AC3 — DAMAGE advances phases at the configured HP and shows the phase', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;
    const damage = findButton(scene, 'DAMAGE');

    for (let hit = 1; hit < MINI_BOSS_GYM_HP_PER_PHASE; hit++) {
      scene.damageMiniBoss();
      expect(boss.getPhaseNumber()).toBe(1);
    }

    // The configured HP-th hit advances to phase 2.
    scene.damageMiniBoss();
    expect(boss.getPhaseNumber()).toBe(2);

    // The pointer path drives the same handler.
    damage.emit('pointerdown');
    expect(boss.getPhaseNumber()).toBe(2);
  });

  it('AC3 — the three demo phases can be traversed and the boss defeated', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;

    const totalHits =
      MINI_BOSS_GYM_HP_PER_PHASE * MINI_BOSS_GYM_PHASES.length;
    for (let hit = 0; hit < totalHits - 1; hit++) scene.damageMiniBoss();

    expect(boss.alive).toBe(true);
    expect(boss.getPhaseNumber()).toBe(MINI_BOSS_GYM_PHASES.length);

    scene.damageMiniBoss();
    expect(boss.alive).toBe(false);
    expect(boss.getHealthSegments()).toBe(0);
  });

  it('AC3 — config-summoned minions join the shared collision pass', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;

    const expectedPhase1Minions = MINI_BOSS_GYM_MINIONS.filter(
      (wave) => wave.phase === 1,
    ).reduce(
      (total, wave) =>
        total +
        wave.groups.reduce((count, group) => count + group.count, 0),
      0,
    );
    expect(expectedPhase1Minions).toBeGreaterThan(0);
    expect(boss.getMinions()).toHaveLength(expectedPhase1Minions);

    // The boss body plus every summoned minion is collision-resolved through
    // the same shared enemy-entity accessor (GymBoss parity).
    const collidable = scene.getCollidableEnemies();
    expect(collidable).toHaveLength(1 + expectedPhase1Minions);
    expect(collidable).toContain(boss);
    for (const minion of boss.getMinions()) {
      expect(collidable).toContain(minion);
    }
  });

  it('AC3 — the gym keeps the shared HUD controls (EXPLODE, SHOOT, back to index)', async () => {
    const scene = await bootGym();
    expect(findButton(scene, 'EXPLODE')).toBeDefined();
    expect(findButton(scene, 'SHOOT: OFF')).toBeDefined();
    expect(findButton(scene, BACK_TO_INDEX_LABEL)).toBeDefined();
  });

  it('AC3 — the mini-boss is rendered on the playfield (not off-screen)', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;
    expect(boss.x).toBeGreaterThan(0);
    expect(boss.x).toBeLessThan(GAME_WIDTH);
    expect(boss.y).toBeGreaterThan(0);
    expect(boss.y).toBeLessThan(GAME_HEIGHT);
  });
});
