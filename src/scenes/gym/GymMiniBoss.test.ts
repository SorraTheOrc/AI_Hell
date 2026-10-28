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
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import Phaser from 'phaser';

import {
  advanceGame,
  bootScene,
  BootedGame,
  stepGameUntil,
} from '../../test/gameHarness';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { BACK_TO_INDEX_LABEL } from '../../utils/gymNavigation';
import {
  GymMiniBoss,
  MINI_BOSS_GYM_COLOR,
  MINI_BOSS_GYM_HP_PER_PHASE,
  MINI_BOSS_GYM_LEVEL,
  MINI_BOSS_GYM_NAME,
  MINI_BOSS_GYM_PHASES,
  MINI_BOSS_FORMATION_START_X,
  MINI_BOSS_FORMATION_START_Y,
  selectGymMiniBossDesign,
} from './GymMiniBoss';
import {
  MINI_BOSS_DESIGN_LEVELS,
  MINI_BOSS_DESIGNS,
  miniBossDesignForLevel,
} from '../../waves/miniBossDesigns';

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

    // The level-1 bespoke design is applied: phase set, colour and identity.
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

  it('AC3 — every design phase can be traversed and the boss defeated', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;
    const phaseCount = miniBossDesignForLevel(MINI_BOSS_GYM_LEVEL).phases.length;

    const totalHits = MINI_BOSS_GYM_HP_PER_PHASE * phaseCount;
    for (let hit = 0; hit < totalHits - 1; hit++) scene.damageMiniBoss();

    expect(boss.alive).toBe(true);
    expect(boss.getPhaseNumber()).toBe(phaseCount);

    scene.damageMiniBoss();
    expect(boss.alive).toBe(false);
    expect(boss.getHealthSegments()).toBe(0);
  });

  it('AC3 — config-summoned minions join the shared collision pass', async () => {
    // Level 3's design (Shard Matron) summons a phase-1 scout wave; select it
    // and rebuild the scene so the real design's minions are exercised.
    selectGymMiniBossDesign(3);
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;

    const expectedPhase1Minions = miniBossDesignForLevel(3)
      .minions!.filter((wave) => wave.phase === 1)
      .reduce(
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
    selectGymMiniBossDesign(1);
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

  it('AC3/AC4 — every bespoke design boots and runs in the gym through the shared core', async () => {
    // Iterate the full design catalogue: each level's bespoke encounter is
    // exercised by the gym (parity) and matches the catalogue 1:1.
    expect(MINI_BOSS_DESIGNS).toHaveLength(MINI_BOSS_DESIGN_LEVELS);
    for (let level = 1; level <= MINI_BOSS_DESIGN_LEVELS; level++) {
      selectGymMiniBossDesign(level);
      expect(miniBossDesignForLevel(level).level).toBe(level);

      // Rebuild the gym for this design and drive one shared tick.
      booted?.game.destroy(true);
      booted = await bootScene([GymMiniBoss]);
      const gym = booted!.scene as GymMiniBoss;
      const boss = gym.formationMiniBoss;
      const design = miniBossDesignForLevel(level);

      expect(boss.resolvedConfig.level).toBe(level);
      expect(boss.resolvedConfig.name).toBe(design.archetype);
      expect(boss.getColor()).toBe(design.color);
      expect(boss.getPhaseCount()).toBe(design.phases.length);
      expect(boss.getHpFraction()).toBe(1);

      // The shared tick advances the encounter (no per-design code path).
      boss.shootEnabled = true;
      boss._simulateTelegraphElapsed();
      gym.time.now = 2_000_000;
      gym.tick(1 / 60);
      expect(boss.alive).toBe(true);
    }
    selectGymMiniBossDesign(1);
  });
  // ── Mini-boss death sweep parity (AH-0MVROEMUO007Z3RY) ──────────

  describe('EXPLODE runs the shared mini-boss death sweep (AC5)', () => {
    /** Boots the design whose phase 1 summons minions (level 3, Shard Matron). */
    async function bootMinionGym(): Promise<GymMiniBoss> {
      selectGymMiniBossDesign(3);
      const scene = await bootGym();
      return scene;
    }

    afterEach(() => {
      selectGymMiniBossDesign(1);
    });

    it('sweeps the mini-boss minions captured before the teardown, then completes', async () => {
      const scene = await bootMinionGym();
      const boss = scene.formationMiniBoss;
      const minions = boss.getMinions();
      expect(minions.length).toBeGreaterThan(0);

      scene.explodeRandom();

      // The minions were captured before the entity tore them down, so the
      // sweep targets are exactly the live minions (the gym's wave-gating
      // scope — no hazards are ever in the formation list).
      const targets = scene.getMiniBossSweepTargets();
      expect(targets).toHaveLength(minions.length);
      for (const minion of minions) {
        expect(
          targets.some(
            (target) =>
              Math.abs(target.x - minion.x) < 0.001 &&
              Math.abs(target.y - minion.y) < 0.001,
          ),
        ).toBe(true);
        // Cosmetic removal: the entity is dead but never routed through a
        // reward-bearing kill path.
        expect(minion.alive).toBe(false);
      }
      expect(boss.alive).toBe(false);

      // Completion is real animation time (burst tweens + the shared Clock
      // watchdog), so it is reached by stepping the game, never on the
      // trigger frame.
      expect(scene.isMiniBossSweepActive()).toBe(true);
      stepGameUntil(
        booted!.game,
        'gym mini-boss sweep completion',
        () => !scene.isMiniBossSweepActive(),
      );
      expect(scene.isMiniBossSweepActive()).toBe(false);
    });

    it('is a no-op once the mini-boss is already defeated (one sweep per defeat)', async () => {
      const scene = await bootMinionGym();
      scene.explodeRandom();
      const targetsAfterFirst = scene.getMiniBossSweepTargets();
      stepGameUntil(
        booted!.game,
        'gym mini-boss sweep completion',
        () => !scene.isMiniBossSweepActive(),
      );

      scene.explodeRandom();

      // No second sweep is armed and the captured targets are unchanged.
      expect(scene.isMiniBossSweepActive()).toBe(false);
      expect(scene.getMiniBossSweepTargets()).toEqual(targetsAfterFirst);
    });

  });
});


// ── Scripted-video boss hit preview (AH-0MVRMFMJP0070KTS, TEST-FIRST) ──────

/** The entity's remaining hits, from its public HP accessors. */
function remainingHits(entity: {
  getHpFraction(): number;
  getTotalHp(): number;
}): number {
  return Math.round(entity.getHpFraction() * entity.getTotalHp());
}

/**
 * Contract tests for `setup.bossHitsRemaining` reaching the spawned mini-boss
 * (parent AH-0MVPJ3NSK008V5VB, AC2 part (b); spawn path, not a re-implemented
 * copy of it).
 *
 * **TEST-FIRST.** The field does not exist yet, so the differed test is
 * wrapped in Vitest's `it.fails` (the repo's red-before/green-after
 * convention — see `src/core/levelScaling.test.ts`), keeping the suite green
 * on pre-change HEAD. **F3 (AH-0MVRMFPXF008BG77) flips it back to `it`** once
 * the gyms pass `initialHp` from the setup; a leftover `it.fails` fails the
 * suite. The absent-field test is a normal green test: it pins today's
 * full-HP spawn as unchanged behaviour.
 */
describe('GymMiniBoss — scripted-video boss hit preview (AH-0MVRMFMJP0070KTS)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  /** Boots the gym with scene-start data (the capture `setup`). */
  async function bootWith(data: object): Promise<GymMiniBoss> {
    booted = await bootScene([GymMiniBoss]);
    booted.game.scene.start('GymMiniBoss', data);
    await advanceGame(booted.game, 200);
    return booted.game.scene.getScene('GymMiniBoss') as GymMiniBoss;
  }

  it.fails('AC4 — spawns the mini-boss with bossHitsRemaining as its initial hits', async () => {
    const scene = await bootWith({ bossHitsRemaining: 8 });

    expect(remainingHits(scene.formationMiniBoss)).toBe(8);
    // The hit preview configures the gym's existing pool — it does not
    // change it.
    expect(scene.formationMiniBoss.getTotalHp()).toBe(
      MINI_BOSS_GYM_PHASES.length * MINI_BOSS_GYM_HP_PER_PHASE,
    );
  });

  it('AC4 — an absent bossHitsRemaining keeps today\'s full-HP spawn', async () => {
    const scene = await bootWith({});

    expect(remainingHits(scene.formationMiniBoss)).toBe(
      MINI_BOSS_GYM_PHASES.length * MINI_BOSS_GYM_HP_PER_PHASE,
    );
  });

  it.fails('AC2 — pins the mini-boss hit pool the parser bounds bossHitsRemaining with', async () => {
    // Loaded by file URL (Vite ignores it) so the pure capture module — which
    // lives outside `src/` — is imported as plain Node ESM.
    const moduleUrl = pathToFileURL(
      resolvePath(process.cwd(), 'scripts/capture-scenes.mjs'),
    ).href;
    const module = (await import(/* @vite-ignore */ moduleUrl)) as unknown as {
      SCENE_SETUP_BOSS_TOTAL_HITS: Record<string, number>;
    };
    booted = await bootScene([GymMiniBoss]);
    const scene = booted.scene as GymMiniBoss;

    expect(module.SCENE_SETUP_BOSS_TOTAL_HITS.GymMiniBoss).toBe(
      scene.formationMiniBoss.getTotalHp(),
    );
  });
});
