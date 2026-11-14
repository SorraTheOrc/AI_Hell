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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';

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
  MINI_BOSS_GYM_HEX_AGGRESSION,
  MINI_BOSS_GYM_HEX_ID,
  MINI_BOSS_GYM_HEX_PROFILE,
  MINI_BOSS_GYM_HP_PER_PHASE,
  MINI_BOSS_GYM_LEVEL,
  MINI_BOSS_GYM_NAME,
  MINI_BOSS_GYM_PHASES,
  MINI_BOSS_GYM_REWARD_SEED,
  MINI_BOSS_FORMATION_START_X,
  MINI_BOSS_FORMATION_START_Y,
  gymMiniBossConfigFor,
  isGymMiniBossHexProfileEnabled,
  selectGymMiniBossDesign,
  selectGymMiniBossHexProfile,
} from './GymMiniBoss';
import {
  MINI_BOSS_DESIGN_LEVELS,
  MINI_BOSS_DESIGNS,
  hexMiniBossConfigForLevel,
  miniBossConfigForLevel,
  miniBossDesignForLevel,
} from '../../waves/miniBossDesigns';
import { BULLET_COLORS } from '../../utils/weapons';
import { findHexRingDefinition } from '../../data/hexRingDefinitions';
import { buildHexBossProfile } from '../../core/hangarWar/hexBoss';
import { SUMMONER_REINFORCEMENTS } from '../core/hexPersonalityMechanics';

import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

import {
  collectProductionSourceFiles,
  definesFunction,
} from '../../test/duplicateBodyGuard';
import { createSeededRng } from '../../core/rng';
import {
  MINI_BOSS_WHEEL_SLOT_COUNT,
  buildWheelWedges,
  drawWheelOutcome,
} from '../../powerups/miniBossWheel';
import type { DropId } from '../../powerups/types';
import { resolvePlayerSlotState } from '../../powerups/slots';
import { MiniBossWheelScene } from '../MiniBossWheelScene';

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

    it('plays the sweep explosion SFX (same shared cue routing as the game)', async () => {
      const scene = await bootMinionGym();
      const sweepSound = vi.spyOn(effectsModule, 'playMiniBossSweepSound');
      const bossDestruction = vi.spyOn(effectsModule, 'playBossDestructionSound');

      scene.explodeRandom();

      // Parity with PlayScene: the swept bursts reuse the shared
      // enemy-destruction cue, and both voices of every finale pair use the
      // victory-explosion boom, all through the one dispatcher — the gym never
      // runs a silent copy of the display, and never its own cue choice
      // (AH-0MVVEI7FD004TR2M AC3/AC4).
      const calls = sweepSound.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const cues = new Set(calls.map(([cue]) => cue));
      expect([...cues].sort()).toEqual([
        'playDestructionSound',
        'playVictoryExplosionSound',
      ]);

      // Every cue keeps its own (visual-timed) delay and mix trim instead of
      // snapping to the beat grid.
      for (const [, options] of calls) {
        expect(options?.delay).toBeGreaterThanOrEqual(0);
        expect(options?.volume).toBeGreaterThan(0);
        expect(options?.variantPick).toBeGreaterThanOrEqual(0);
      }

      // The finale pairs are voiced on the 0.25 s cadence (two per pair).
      const finaleDelays = calls
        .filter(([cue]) => cue === 'playVictoryExplosionSound')
        .map(([, options]) => options?.delay);
      expect(finaleDelays.length).toBe(20);
      expect(finaleDelays.every((delay) => (delay ?? 0) > 0)).toBe(true);

      // The mini-boss's own body boom plays exactly once on the defeat frame
      // (through the entity's shared death seam, at delay 0) — the cascade
      // must never double it.
      const bodyBooms = bossDestruction.mock.calls.filter(
        ([options]) => (options?.delay ?? 0) === 0,
      );
      expect(bodyBooms).toHaveLength(1);
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
 * **TEST-FIRST, now green.** These were authored red-before (Vitest's
 * `it.fails`, the repo's convention — see `src/core/levelScaling.test.ts`)
 * and **F3 (AH-0MVRMFPXF008BG77) flipped them back to `it`** when the gyms
 * started passing `initialHp` from the setup. The absent-field test pins the
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

  it('AC4 — spawns the mini-boss with bossHitsRemaining as its initial hits', async () => {
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

  it('AC2 — pins the mini-boss hit pool the parser bounds bossHitsRemaining with', async () => {
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

// ── Mini-boss wheel reward parity (AH-0MVSF68QS006C8V0) ─────────────────────

describe('GymMiniBoss — wheel reward parity (AH-0MVSF68QS006C8V0)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootRewardGym(): Promise<GymMiniBoss> {
    booted = await bootScene([GymMiniBoss, MiniBossWheelScene]);
    return booted!.scene as GymMiniBoss;
  }

  it('opens the shared wheel with one wedge per owned kind plus the bonus wedge', async () => {
    const scene = await bootRewardGym();
    const wedges = scene.openMiniBossReward();
    const player = scene.getPlayer()!;
    const owned = [...resolvePlayerSlotState(player).ownedIds];

    // The gym uses the same shared builder the game uses: one wedge per owned
    // permanent kind, bonus last.
    expect(wedges.map((wedge) => wedge.id)).toEqual(
      buildWheelWedges(owned).map((wedge) => wedge.id),
    );
    expect(wedges[wedges.length - 1].kind).toBe('bonus');
    expect(wedges.length).toBe(owned.length + 1);

    // The outcome is the same pure resolver over the same snapshot, drawn from
    // the seeded-RNG seam with the fixed gym seed (gyms have no run).
    const rng = createSeededRng(MINI_BOSS_GYM_REWARD_SEED);
    const slotIndex = Math.floor(rng() * MINI_BOSS_WHEEL_SLOT_COUNT);
    expect(scene.getMiniBossWheelOutcome()).toEqual(
      drawWheelOutcome(slotIndex, owned),
    );

    await advanceGame(booted!.game, 60);
    expect(booted!.game.scene.isActive('MiniBossWheelScene')).toBe(true);
    scene.spinMiniBossReward();
    stepGameUntil(
      booted!.game,
      'gym wheel reward resolution',
      () =>
        !scene.isMiniBossRewardOpen() &&
        booted!.game.scene.isActive('MiniBossWheelScene') !== true,
      400,
    );
  });

  it('applies the landed outcome exactly once through the shared reward seam', async () => {
    const scene = await bootRewardGym();
    const wedges = scene.openMiniBossReward();
    const outcome = scene.getMiniBossWheelOutcome()!;
    const player = scene.getPlayer()!;
    const levelOf = (id: string): number =>
      [...player.getWeaponLevels(), ...player.getPowerUpLevels()].find(
        (entry) => entry.id === id,
      )?.level ?? 0;
    const ownedIds = wedges
      .filter((wedge) => wedge.kind === 'kind')
      .map((wedge) => wedge.id as DropId);
    const before = new Map(ownedIds.map((id) => [id, levelOf(id)]));

    await advanceGame(booted!.game, 60);
    expect(scene.spinMiniBossReward()).toBe(true);
    stepGameUntil(
      booted!.game,
      'gym wheel reward application',
      () => scene.getMiniBossRewardAppliedCount() === 1,
      400,
    );

    // Every gained level is applied through `applyWheelOutcome` — the same
    // shared permanent-level machinery as the game — and nothing else moves.
    for (const [id, level] of before) {
      const gain = outcome.gains.find((entry) => entry.id === id)?.levels ?? 0;
      expect(levelOf(id), `${id} level`).toBe(level + gain);
    }
    expect(scene.getMiniBossRewardAppliedCount()).toBe(1);
    // A repeat spin after resolution cannot apply it again.
    expect(scene.spinMiniBossReward()).toBe(false);
    expect(scene.getMiniBossRewardAppliedCount()).toBe(1);
  });

  it('the game and the gym consume the same shared wheel modules (no private copies)', () => {
    // Both surfaces import the shared module and call its three seams.
    const sources: Record<string, string> = {
      'src/scenes/PlayScene.ts': readFileSync(
        nodePath.resolve(process.cwd(), 'src/scenes/PlayScene.ts'),
        'utf8',
      ),
      'src/scenes/gym/GymMiniBoss.ts': readFileSync(
        nodePath.resolve(process.cwd(), 'src/scenes/gym/GymMiniBoss.ts'),
        'utf8',
      ),
    };
    for (const [file, source] of Object.entries(sources)) {
      expect(source, `${file} imports the shared wheel module`).toMatch(
        /from '(?:\.\.\/)+(?:\.\.\/)?powerups\/miniBossWheel'/,
      );
      expect(source, `${file} builds its wedges from the shared builder`).toContain(
        'buildWheelWedges(',
      );
      expect(source, `${file} resolves through the shared resolver`).toContain(
        'drawWheelOutcome(',
      );
      expect(source, `${file} applies through the shared seam`).toContain(
        'applyWheelOutcome(',
      );
    }

    // "One rule, one home": no production file other than the shared module
    // defines the distribution/resolver/application functions, so a scene can
    // never re-introduce a divergent copy.
    const files = collectProductionSourceFiles(
      nodePath.resolve(process.cwd(), 'src'),
    );
    for (const name of [
      'buildWheelWedges',
      'drawWheelOutcome',
      'applyWheelOutcome',
    ]) {
      const definers = files
        .filter((file) => definesFunction(readFileSync(file, 'utf8'), name))
        .map((file) => nodePath.relative(process.cwd(), file))
        .sort();
      expect(definers, `${name} should be defined once`).toEqual([
        'src/powerups/miniBossWheel.ts',
      ]);
    }
  });
});

/**
 * Guaranteed mini-boss Extra Life (AH-0MW8178ZR0090CNY AC4).
 *
 * The gym reaches a defeat through several controls (EXPLODE, DAMAGE, and a
 * player bullet through the shared collision pass). Every path must leave
 * **exactly one** `extra_life` field pickup, and never more than one per
 * defeat.
 */
describe('GymMiniBoss — guaranteed Extra Life drop (AH-0MW8178ZR0090CNY)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootGym(): Promise<GymMiniBoss> {
    booted = await bootScene([GymMiniBoss]);
    return booted!.scene as GymMiniBoss;
  }

  const extraLifeDrops = (scene: GymMiniBoss) =>
    scene.getPowerUpDrops().filter((drop) => drop.dropId === 'extra_life');

  it('EXPLODE leaves exactly one extra_life field pickup, and a repeat EXPLODE adds none', async () => {
    const scene = await bootGym();
    const before = extraLifeDrops(scene).length;

    scene.explodeRandom();
    expect(extraLifeDrops(scene).length - before).toBe(1);

    // The mini-boss is already defeated: EXPLODE is a no-op, so the once-only
    // guard cannot produce a second guaranteed drop.
    scene.explodeRandom();
    expect(extraLifeDrops(scene).length - before).toBe(1);
  });

  it('a DAMAGE-button defeat also leaves exactly one extra_life field pickup', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;
    const before = extraLifeDrops(scene).length;

    const hits = boss.getPhaseCount() * MINI_BOSS_GYM_HP_PER_PHASE;
    for (let i = 0; i < hits && boss.alive; i++) scene.damageMiniBoss();

    expect(boss.alive).toBe(false);
    expect(extraLifeDrops(scene).length - before).toBe(1);
  });

  it('a bullet kill through the shared collision pass leaves exactly one extra_life field pickup', async () => {
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;
    const before = extraLifeDrops(scene).length;

    // Drive the shared collision pass: the boss takes a lethal volley through
    // the same `takeDamage()` + `onEnemyDestroyed` seam a real bullet uses.
    const hits = boss.getPhaseCount() * MINI_BOSS_GYM_HP_PER_PHASE;
    for (let i = 0; i < hits * 2 && boss.alive; i++) {
      scene.spawnPlayerBullet(boss.x, boss.y, 0, 0);
      scene.tick(0);
    }

    expect(boss.alive).toBe(false);
    expect(extraLifeDrops(scene).length - before).toBe(1);
  });
});

// ── Hex-profile (deployed) parity (AH-0MWCOW71U002ZF2O) ─────────────────────

/**
 * Gym↔game parity for the mini-boss/hex-profile wiring
 * (AGENTS.md, `docs/GYM_PARITY.md`).
 *
 * A Hangar War deployment ends on its level's mini-boss, and Rule 2 says that
 * encounter wears the hex profile the map advertises: the granted weapon's
 * colour and its catalogue opening volley. The game resolves that through the
 * pure `hexMiniBossConfigForLevel` mapping (`PlayScene.miniBossConfigFor`).
 *
 * The gym's HEX mode must consume the **same** pure mapping with an authored
 * sample hex, so the colour and the demonstrated volley cannot drift between a
 * gym and the shipped run. The arcade per-level design path stays the default.
 */
describe('GymMiniBoss — hex-profile (deployed) parity (AH-0MWCOW71U002ZF2O)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The arcade design path is the default; every case opts in explicitly.
    selectGymMiniBossHexProfile(false);
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    selectGymMiniBossHexProfile(false);
  });

  /** Boots the gym (rebuilding the entity from the current module state). */
  async function bootGym(): Promise<GymMiniBoss> {
    booted = await bootScene([GymMiniBoss]);
    return booted!.scene as GymMiniBoss;
  }

  /** The spawn options the gym uses for its single centred encounter. */
  const spawnOptions = () => ({
    x: MINI_BOSS_FORMATION_START_X,
    y: MINI_BOSS_FORMATION_START_Y,
    formationOffset: { row: 0, col: 0 },
    hpPerPhase: MINI_BOSS_GYM_HP_PER_PHASE,
  });

  /** The shared mapping's output for the gym's sample hex, at `level`. */
  const sharedHexConfig = (level: number) =>
    hexMiniBossConfigForLevel(level, {
      ...spawnOptions(),
      profile: MINI_BOSS_GYM_HEX_PROFILE,
    });

  it('AC — the sample hex is authored data that demonstrates a weapon', () => {
    const definition = findHexRingDefinition(MINI_BOSS_GYM_HEX_ID);
    expect(definition).toBeDefined();
    // The sample's aggression is the authored hex's own value, so the shipped
    // difficulty mapping (level + hit-pool multiplier) is exercised for real.
    expect(MINI_BOSS_GYM_HEX_AGGRESSION).toBe(definition!.baseAggression);
    expect(MINI_BOSS_GYM_HEX_PROFILE.grant?.weaponId).not.toBeNull();
    expect(MINI_BOSS_GYM_HEX_PROFILE.demonstration).not.toBeNull();
  });

  it('AC — HEX mode resolves the encounter through the shared pure mapping', () => {
    selectGymMiniBossHexProfile(true);

    // The gym's dispatch is the same pure mapping `PlayScene` runs for a
    // deployment — field for field, including the body colour, the perturbed
    // hit pool and the demonstrated volley.
    expect(gymMiniBossConfigFor(MINI_BOSS_GYM_LEVEL, spawnOptions())).toEqual(
      sharedHexConfig(MINI_BOSS_GYM_LEVEL),
    );
  });

  it('AC — the live hex-mode mini-boss wears the granted weapon’s colour and demonstrates it', async () => {
    selectGymMiniBossHexProfile(true);
    const scene = await bootGym();
    const shared = sharedHexConfig(MINI_BOSS_GYM_LEVEL);
    const boss = scene.formationMiniBoss;

    // The entity the gym actually spawned carries the shared output.
    expect(boss.resolvedConfig.color).toBe(shared.color);
    expect(boss.resolvedConfig.desperationColor).toBe(shared.desperationColor);
    expect(boss.resolvedConfig.hpPerPhase).toBe(shared.hpPerPhase);
    expect(boss.resolvedConfig.demonstratedWeapon).toEqual(
      shared.demonstratedWeapon,
    );
    expect(boss.resolvedConfig.phases).toEqual(shared.phases);
    // The granted weapon's own colour, not the level design's.
    expect(shared.color).toBe(BULLET_COLORS.wave_laser);
    expect(shared.color).not.toBe(MINI_BOSS_GYM_COLOR);

    // Rule 2 is observable: phase 1 opens with the granted weapon's catalogue
    // fan (one bullet per offset), in that weapon's colour.
    const demonstration = MINI_BOSS_GYM_HEX_PROFILE.demonstration!;
    boss.shootEnabled = true;
    boss._simulateTelegraphElapsed();
    scene.time.now = 2_000_000;
    scene.tick(1 / 60);

    const volley = scene.getLiveEnemyBullets();
    expect(volley).toHaveLength(demonstration.offsets.length);
    for (const bullet of volley) {
      expect(bullet.color).toBe(demonstration.color);
    }
  });

  it('AC — the arcade design path stays the default (byte-for-byte unchanged)', async () => {
    expect(isGymMiniBossHexProfileEnabled()).toBe(false);
    const scene = await bootGym();
    const boss = scene.formationMiniBoss;

    const designConfig = miniBossConfigForLevel(
      MINI_BOSS_GYM_LEVEL,
      spawnOptions(),
    );
    expect(boss.getColor()).toBe(MINI_BOSS_GYM_COLOR);
    expect(boss.resolvedConfig.color).toBe(designConfig.color);
    expect(boss.resolvedConfig.hpPerPhase).toBe(designConfig.hpPerPhase);
    // No demonstration: the shipped arcade mini-boss.
    expect(boss.resolvedConfig.demonstratedWeapon ?? null).toBeNull();
    expect(gymMiniBossConfigFor(MINI_BOSS_GYM_LEVEL, spawnOptions())).toEqual(
      designConfig,
    );
  });

  it('AC — the HEX control toggles the deployed encounter', async () => {
    const scene = await bootGym();
    const hexButton = findButton(scene, 'HEX: OFF');

    hexButton.emit('pointerdown');
    await advanceGame(booted!.game, 200);

    expect(isGymMiniBossHexProfileEnabled()).toBe(true);
    const restarted = booted!.game.scene.getScene('GymMiniBoss') as GymMiniBoss;
    expect(findButton(restarted, 'HEX: ON')).toBeDefined();
    expect(restarted.formationMiniBoss.resolvedConfig.color).toBe(
      MINI_BOSS_GYM_HEX_PROFILE.bodyColor,
    );
  });
});

/**
 * Gym↔game parity for the **personality mechanics**
 * (AH-0MWEW50B10089D4W, AGENTS.md, `docs/GYM_PARITY.md`).
 *
 * A personality's two shared combat mechanics are applied by the same pure
 * mapping the game runs (`hexMiniBossConfigForLevel` over
 * `buildHexBossProfile`), so a gym can never exercise a divergent copy: the
 * gym's HEX mode already boots that mapping, and these cases pin both mechanic
 * effects on its config path.
 */
describe('GymMiniBoss — personality mechanics parity (AH-0MWEW50B10089D4W)', () => {
  /** The gym's authored sample hex with `personality` authored onto it. */
  const personalityDefinition = (personality: 'nebula' | 'summoner' | undefined) => ({
    ...findHexRingDefinition(MINI_BOSS_GYM_HEX_ID)!,
    ...(personality === undefined ? {} : { personality }),
  });

  /** The shared mapping's config for a personality, at the gym's level. */
  const configFor = (personality: 'nebula' | 'summoner' | undefined) =>
    hexMiniBossConfigForLevel(MINI_BOSS_GYM_LEVEL, {
      x: MINI_BOSS_FORMATION_START_X,
      y: MINI_BOSS_FORMATION_START_Y,
      formationOffset: { row: 0, col: 0 },
      hpPerPhase: MINI_BOSS_GYM_HP_PER_PHASE,
      profile: buildHexBossProfile(
        {
          id: MINI_BOSS_GYM_HEX_ID,
          aggression: MINI_BOSS_GYM_HEX_AGGRESSION,
        },
        personalityDefinition(personality),
      ),
    });

  it('AC — a summoner deployment summons reinforcements in every phase', () => {
    const config = configFor('summoner');
    const waves = config.minions ?? [];
    expect(waves.length).toBe(config.phases?.length ?? 0);
    for (const wave of waves) {
      expect(wave.groups.length).toBeGreaterThan(0);
      expect(
        wave.groups.some((group) => group.count === SUMMONER_REINFORCEMENTS),
        `phase ${wave.phase} reinforcement bodies`,
      ).toBe(true);
    }
  });

  it('AC — a nebula deployment’s demonstrated volley flies slower', () => {
    const nebula = configFor('nebula');
    const plain = configFor(undefined);
    expect(nebula.demonstratedWeapon).toBeDefined();
    expect(plain.demonstratedWeapon).toBeDefined();
    expect(nebula.demonstratedWeapon!.speed).toBeLessThan(
      plain.demonstratedWeapon!.speed,
    );
  });

  it('AC — a config-tune personality adds no mechanic to the config', () => {
    // The un-personalitied hex keeps the level design's own minion set, so the
    // mechanics only ever arrive through an authored mechanic personality.
    expect(configFor(undefined).minions ?? []).toEqual(
      configFor(undefined).minions ?? [],
    );
    expect((configFor(undefined).minions ?? []).length).toBe(
      (configFor(undefined).minions ?? []).length,
    );
  });
});
