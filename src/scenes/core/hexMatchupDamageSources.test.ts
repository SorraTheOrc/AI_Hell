/**
 * Hex matchup hit-charge across every player damage source
 * (AH-0MWL88NDS003H2JW, **TEST-FIRST** — Phase 2 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC5, AC6, AC14).
 *
 * A hex's authored `strengths`/`weaknesses` now drive a **hit charge**:
 * `effective` = 2 hit points per connected shot, `resisted` = 1 hit point per
 * **two** connected shots (a per-target, per-weapon ledger), `neutral` = 1.
 * This suite proves every player damage source honours that one rule and pins
 * the measured ×2 / ×0.5 effect against a real mini-boss phase.
 *
 * ## The five damage entry points (why one seam is not enough)
 *
 * The parent description assumed `CombatScene.damageEnemyWithBullet` is the
 * single player-damage seam. It is not: the mini-boss and boss carry their own
 * paths. The tests below therefore drive **each** path through its real seam:
 *
 * | Path | Shared seam |
 * | --- | --- |
 * | ordinary bullet | `_resolvePlayerBulletsVsEnemies` → `damageEnemyWithBullet` |
 * | damage-budget beam (wave laser) | `fireHitscanBeam` → `applyHitscanHit` → `damageEnemyViaAoe` |
 * | AOE detonation | `applyAoeEffect` → `damageEnemyViaAoe` |
 * | mini-boss bullet | `_resolvePlayerBulletsVsEnemies` → `onPlayerBulletHitsBoss` → `_damageMiniBoss` |
 * | mini-boss AOE | `applyAoeEffect` → `onAoeHitsBoss` → `_damageMiniBoss` |
 * | boss AOE | `applyAoeEffect` → `onAoeHitsBoss` → `_damageBoss` |
 *
 * The final boss reuses the same two boss entry points as the mini-boss (it
 * dispatches to `_damageBoss` instead of `_damageMiniBoss`), so the boss AOE
 * case is covered explicitly as well — the deliverables ask for it.
 *
 * ## Red-before / green-after
 *
 * Every behavioural case below is authored red against pre-change HEAD (the
 * charge is not wired anywhere yet, so every weapon deals exactly one hit
 * point per connected hit) and is wrapped in Vitest's `it.fails` — the repo's
 * red-first convention (see `src/vfx/orbitalStrike.test.ts`). The
 * implementation item (AH-0MWL88REU009MO5G) **flips every `it.fails` back to a
 * plain `it`** once the charge lands; a leftover `it.fails` then fails the
 * suite, so this is a real target rather than a permanent exemption.
 *
 * Two cases are **scope guards** rather than red-first claims:
 *
 * - **chaff** (`health` = 1) must take exactly today's damage under every
 *   verdict — a plain `it` because it is already correct on HEAD by
 *   construction (there is no charge to over-apply) and must stay green after
 *   the charge lands;
 * - the **determinism** replay must stay identical. Its resisted-rate
 *   assertion is red now, so the case is `it.fails`; the replay equality is
 *   the guard.
 *
 * ## How the observable is read
 *
 * Damage is a hit-count model (`BaseEnemy.takeDamage()` takes no argument and
 * one call is one hit point). The targets below **count `takeDamage()` calls**,
 * so the assertions read the actual per-shot hit points without restating the
 * charge arithmetic. The verdict itself comes from the **real authored hex
 * data** through the deployment (`buildHangarDeployment` → `HexBossProfile`
 * → `hexMiniBossConfigForLevel`), never from a synthetic lookup, so the test
 * also pins the end-to-end hex→run hand-off (parent AC4/AC14).
 *
 * @module scenes/core/hexMatchupDamageSources.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { createRingState } from '../../core/hangarWar/hexRing';
import {
  createDefaultPayload,
  saveHangarWarPayload,
} from '../../core/hangarWar/hangarWarStore';
import type { HangarWarPayload } from '../../core/hangarWar/types';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { Boss } from '../../entities/Boss';
import { MiniBoss, type MiniBossConfig } from '../../entities/MiniBoss';
import { advanceGame, bootScene, type BootedGame } from '../../test/gameHarness';
import type { FormationOffset } from '../../utils/formations';
import { WEAPON_CATALOGUE, type WeaponId } from '../../utils/weapons';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { PlayScene } from '../PlayScene';
import {
  buildHangarDeployment,
  type HangarWarDeployment,
} from '../hangarWar/hangarDeployment';

// The Player's auto-fire reads the control scheme; the app default is
// Asteroids, so seed fourDirectional exactly as the other PlayScene suites.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

const OFFSET: FormationOffset = { row: 0, col: 0 };

/** A shot carrying its weapon identity (added to `PlayerBullet` by Phase 3). */
type WeaponCarrier = { weaponId?: string };

/**
 * A real `BaseEnemy` that records how many hit points a shot applied — one
 * `takeDamage()` call is one hit point, the game's damage model. A multi-hit
 * hull keeps every verifiable target alive through two shots.
 */
class ChargeTarget extends BaseEnemy {
  hits = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, health = 40) {
    const config: BaseEnemyConfig = {
      formationOffset: OFFSET,
      size: 16,
      color: 0x00ff00,
      health,
    };
    super(scene, x, y, config);
  }

  override takeDamage(): number {
    this.hits += 1;
    return super.takeDamage();
  }

  /** Static target: the shared formation-positioning step is a no-op. */
  applyFormationPosition(
    _x: number,
    _y: number,
    _dt: number,
    _spacingX = 0,
    _spacingY = 0,
  ): void {
    // Intentionally still: the test observes damage, not motion.
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // State, not pixels: this target exists to observe damage.
  }
}

/** A real `MiniBoss` that records the hit points a shot applied. */
class ChargeMiniBoss extends MiniBoss {
  hits = 0;

  constructor(scene: Phaser.Scene, config: MiniBossConfig) {
    super(scene, config);
  }

  override takeDamage(hitX?: number, hitY?: number) {
    this.hits += 1;
    return super.takeDamage(hitX, hitY);
  }
}

/** Private scene seams these tests drive (the same seams the shipped suites use). */
interface SceneSeams {
  spawned: unknown[];
  playerBullets: unknown[];
  miniBoss: MiniBoss | null;
  boss: Boss | null;
  autoFireEnabled(): boolean;
  _resolvePlayerBulletsVsEnemies(): void;
  fireHitscanBeam(
    def: unknown,
    headingRad: number,
    x: number,
    y: number,
  ): unknown;
  applyAoeEffect(def: unknown, x: number, y: number): void;
  miniBossConfigFor(level: number): MiniBossConfig;
  spawnBoss(): void;
}

/** A fresh war with the requested ring materialised from the authored data. */
function payloadFor(hexId: string): HangarWarPayload {
  const match = /^hex-r(\d+)-/.exec(hexId);
  const ringIndex = match ? Number(match[1]) : 1;
  return {
    ...createDefaultPayload(4242),
    ring: createRingState(ringIndex, HEX_RING_DEFINITIONS),
  };
}

/** A deployment at `hexId`, seeding the run deterministically. */
function deploymentFor(hexId: string): HangarWarDeployment {
  return buildHangarDeployment(payloadFor(hexId), { hexId, seed: 7 });
}

/**
 * The authored facts this suite relies on, pinned so a ring re-authoring that
 * changes them fails loudly rather than silently weakening the test:
 *
 * - `hex-r1-1` weaknesses `nova` (effective), `hex-r1-6` strengths `mortar`
 *   (resisted), `hex-r1-4` neither (neutral) for the AOE paths;
 * - `hex-r1-4` weaknesses `ricochet` (effective) / strengths `cannon`
 *   (resisted), `spread` neutral for the ordinary-bullet and mini-boss-bullet
 *   paths;
 * - `hex-r1-2` weaknesses `waveLaser` (effective), `hex-r2-9` strengths
 *   `waveLaser` (resisted), `hex-r1-4` neither for the beam path;
 * - `hex-r1-1` also resists `cannon` **and** `dual`, which the per-weapon
 *   ledger case needs.
 */
const HEXES = {
  aoeEffective: 'hex-r1-1',
  aoeResisted: 'hex-r1-6',
  aoeNeutral: 'hex-r1-4',
  bulletEffective: 'hex-r1-4',
  bulletResisted: 'hex-r1-4',
  bulletNeutral: 'hex-r1-4',
  beamEffective: 'hex-r1-2',
  beamResisted: 'hex-r2-9',
  beamNeutral: 'hex-r1-4',
  twoResisted: 'hex-r1-1',
} as const;

/**
 * The two-shot charge for each verdict: 2/2 effective, 1/1 neutral and 0/1
 * resisted. Expressed once so every path asserts the same magnitudes.
 */
const TWO_SHOT_HITS: Record<'effective' | 'neutral' | 'resisted', number> = {
  effective: 4,
  neutral: 2,
  resisted: 1,
};

describe('Hex matchup hit-charge (AH-0MWL88NDS003H2JW)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /**
   * Boots `PlayScene` running the deployment for `hexId`, then isolates the
   * damage surface: the wave enemies and any auto-fired bullets are cleared so
   * only the target this test injects can take the shot.
   */
  async function bootIsolated(hexId: string): Promise<PlayScene> {
    // A case boots several deployments in sequence; tear the previous game
    // down first so no stale loop ticks a scene that holds a test target.
    if (booted) {
      booted.game.destroy(true);
      booted = null;
    }
    saveHangarWarPayload(payloadFor(hexId));
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    scene.scene.restart({ demo: false, hangarWar: deploymentFor(hexId) });
    await advanceGame(scene.game, 200);
    const seams = scene as unknown as SceneSeams;
    // No wave enemy, no auto-fire and no stray bullet may absorb the shot.
    seams.spawned.length = 0;
    seams.playerBullets.length = 0;
    seams.autoFireEnabled = () => false;
    return scene;
  }

  /** Injects a multi-hit regular target into the scene's live enemy list. */
  function addTarget(
    scene: PlayScene,
    x: number,
    y: number,
    health = 40,
  ): ChargeTarget {
    const target = new ChargeTarget(scene, x, y, health);
    (scene as unknown as SceneSeams).spawned.push({
      entity: target,
      enemyKey: 'charge-target',
      startX: x,
      startY: y,
      spacingX: 0,
      spacingY: 0,
    });
    return target;
  }

  /** Injects a mini-boss built from the run's own (hex-profiled) configuration. */
  function addMiniBoss(scene: PlayScene, level = 3): ChargeMiniBoss {
    const seams = scene as unknown as SceneSeams;
    const miniBoss = new ChargeMiniBoss(scene, seams.miniBossConfigFor(level));
    seams.miniBoss = miniBoss;
    return miniBoss;
  }

  /** The live ship position (used to aim the wave-laser beam). */
  function playerPosition(scene: PlayScene): { x: number; y: number } {
    const player = scene.getPlayer();
    if (!player) throw new Error('bootIsolated: the run has no player');
    return { x: player.x, y: player.y };
  }

  /** Fires one ordinary-bullet shot carrying `weaponId` at `(x, y)`. */
  function fireBullet(
    scene: PlayScene,
    x: number,
    y: number,
    weaponId: WeaponId,
  ): void {
    const bullet = scene.spawnPlayerBullet(x, y, 0, 0);
    (bullet as unknown as WeaponCarrier).weaponId = weaponId;
    (scene as unknown as SceneSeams)._resolvePlayerBulletsVsEnemies();
  }

  /** Fires one wave-laser beam (hitscan) from the ship through `(x, y)`. */
  function fireBeam(
    scene: PlayScene,
    x: number,
    y: number,
    weaponId: WeaponId,
  ): void {
    const player = scene.getPlayer()!;
    const def = WEAPON_CATALOGUE[weaponId];
    const heading = Math.atan2(y - player.y, x - player.x);
    (scene as unknown as SceneSeams).fireHitscanBeam(
      def,
      heading,
      player.x,
      player.y,
    );
  }

  /** Resolves one AOE detonation of `weaponId` centred on `(x, y)`. */
  function detonateAoe(
    scene: PlayScene,
    x: number,
    y: number,
    weaponId: WeaponId,
  ): void {
    const def = WEAPON_CATALOGUE[weaponId];
    (scene as unknown as SceneSeams).applyAoeEffect(def, x, y);
  }

  // ──────────────────────────────────────────────────────────────────
  // AC5 — every player damage source honours the one rule
  // ──────────────────────────────────────────────────────────────────

  it(
    'AC5 — ordinary bullet: effective 2/shot, neutral 1/shot, resisted 1 per 2 shots',
    async () => {
      const effective = await bootIsolated(HEXES.bulletEffective);
      const effectiveTarget = addTarget(effective, 200, 200);
      for (let shot = 0; shot < 2; shot += 1) {
        fireBullet(effective, effectiveTarget.x, effectiveTarget.y, 'ricochet');
      }
      expect(effectiveTarget.hits).toBe(TWO_SHOT_HITS.effective);

      const neutral = await bootIsolated(HEXES.bulletNeutral);
      const neutralTarget = addTarget(neutral, 200, 200);
      for (let shot = 0; shot < 2; shot += 1) {
        fireBullet(neutral, neutralTarget.x, neutralTarget.y, 'spread');
      }
      expect(neutralTarget.hits).toBe(TWO_SHOT_HITS.neutral);

      const resisted = await bootIsolated(HEXES.bulletResisted);
      const resistedTarget = addTarget(resisted, 200, 200);
      for (let shot = 0; shot < 2; shot += 1) {
        fireBullet(resisted, resistedTarget.x, resistedTarget.y, 'cannon');
      }
      expect(resistedTarget.hits).toBe(TWO_SHOT_HITS.resisted);
    },
  );

  it(
    'AC5 — damage-budget beam (wave laser): effective 2/shot, neutral 1/shot, resisted 1 per 2 shots',
    async () => {
      const effective = await bootIsolated(HEXES.beamEffective);
      const effectivePlayer = playerPosition(effective);
      const effectiveTarget = addTarget(
        effective,
        effectivePlayer.x + 80,
        effectivePlayer.y,
      );
      for (let shot = 0; shot < 2; shot += 1) {
        fireBeam(effective, effectiveTarget.x, effectiveTarget.y, 'wave_laser');
      }
      expect(effectiveTarget.hits).toBe(TWO_SHOT_HITS.effective);

      const neutral = await bootIsolated(HEXES.beamNeutral);
      const neutralPlayer = playerPosition(neutral);
      const neutralTarget = addTarget(
        neutral,
        neutralPlayer.x + 80,
        neutralPlayer.y,
      );
      for (let shot = 0; shot < 2; shot += 1) {
        fireBeam(neutral, neutralTarget.x, neutralTarget.y, 'wave_laser');
      }
      expect(neutralTarget.hits).toBe(TWO_SHOT_HITS.neutral);

      const resisted = await bootIsolated(HEXES.beamResisted);
      const resistedPlayer = playerPosition(resisted);
      const resistedTarget = addTarget(
        resisted,
        resistedPlayer.x + 80,
        resistedPlayer.y,
      );
      for (let shot = 0; shot < 2; shot += 1) {
        fireBeam(resisted, resistedTarget.x, resistedTarget.y, 'wave_laser');
      }
      expect(resistedTarget.hits).toBe(TWO_SHOT_HITS.resisted);
    },
  );

  it(
    'AC5 — AOE detonation: effective 2/shot, neutral 1/shot, resisted 1 per 2 shots',
    async () => {
      const effective = await bootIsolated(HEXES.aoeEffective);
      const effectiveTarget = addTarget(effective, 200, 200);
      for (let shot = 0; shot < 2; shot += 1) {
        detonateAoe(effective, effectiveTarget.x, effectiveTarget.y, 'nova');
      }
      expect(effectiveTarget.hits).toBe(TWO_SHOT_HITS.effective);

      const neutral = await bootIsolated(HEXES.aoeNeutral);
      const neutralTarget = addTarget(neutral, 200, 200);
      for (let shot = 0; shot < 2; shot += 1) {
        detonateAoe(neutral, neutralTarget.x, neutralTarget.y, 'nova');
      }
      expect(neutralTarget.hits).toBe(TWO_SHOT_HITS.neutral);

      const resisted = await bootIsolated(HEXES.aoeResisted);
      const resistedTarget = addTarget(resisted, 200, 200);
      for (let shot = 0; shot < 2; shot += 1) {
        detonateAoe(resisted, resistedTarget.x, resistedTarget.y, 'mortar');
      }
      expect(resistedTarget.hits).toBe(TWO_SHOT_HITS.resisted);
    },
  );

  it(
    'AC5 — mini-boss bullet: effective 2/shot, neutral 1/shot, resisted 1 per 2 shots',
    async () => {
      const effective = await bootIsolated(HEXES.bulletEffective);
      const effectiveBoss = addMiniBoss(effective);
      for (let shot = 0; shot < 2; shot += 1) {
        fireBullet(effective, effectiveBoss.x, effectiveBoss.y, 'ricochet');
      }
      expect(effectiveBoss.hits).toBe(TWO_SHOT_HITS.effective);

      const neutral = await bootIsolated(HEXES.bulletNeutral);
      const neutralBoss = addMiniBoss(neutral);
      for (let shot = 0; shot < 2; shot += 1) {
        fireBullet(neutral, neutralBoss.x, neutralBoss.y, 'spread');
      }
      expect(neutralBoss.hits).toBe(TWO_SHOT_HITS.neutral);

      const resisted = await bootIsolated(HEXES.bulletResisted);
      const resistedBoss = addMiniBoss(resisted);
      for (let shot = 0; shot < 2; shot += 1) {
        fireBullet(resisted, resistedBoss.x, resistedBoss.y, 'cannon');
      }
      expect(resistedBoss.hits).toBe(TWO_SHOT_HITS.resisted);
    },
  );

  it(
    'AC5 — mini-boss AOE: effective 2/shot, neutral 1/shot, resisted 1 per 2 shots',
    async () => {
      const effective = await bootIsolated(HEXES.aoeEffective);
      const effectiveBoss = addMiniBoss(effective);
      for (let shot = 0; shot < 2; shot += 1) {
        detonateAoe(effective, effectiveBoss.x, effectiveBoss.y, 'nova');
      }
      expect(effectiveBoss.hits).toBe(TWO_SHOT_HITS.effective);

      const neutral = await bootIsolated(HEXES.aoeNeutral);
      const neutralBoss = addMiniBoss(neutral);
      for (let shot = 0; shot < 2; shot += 1) {
        detonateAoe(neutral, neutralBoss.x, neutralBoss.y, 'nova');
      }
      expect(neutralBoss.hits).toBe(TWO_SHOT_HITS.neutral);

      const resisted = await bootIsolated(HEXES.aoeResisted);
      const resistedBoss = addMiniBoss(resisted);
      for (let shot = 0; shot < 2; shot += 1) {
        detonateAoe(resisted, resistedBoss.x, resistedBoss.y, 'mortar');
      }
      expect(resistedBoss.hits).toBe(TWO_SHOT_HITS.resisted);
    },
  );

  // ── Final-boss AOE (the deliverables ask for the boss AOE path too) ──

  it(
    'AC5 — boss AOE: effective 2/shot, neutral 1/shot, resisted 1 per 2 shots',
    async () => {
      const cases = [
        [HEXES.aoeEffective, 'nova', TWO_SHOT_HITS.effective],
        [HEXES.aoeNeutral, 'nova', TWO_SHOT_HITS.neutral],
        [HEXES.aoeResisted, 'mortar', TWO_SHOT_HITS.resisted],
      ] as const;

      for (const [hexId, weaponId, expected] of cases) {
        const scene = await bootIsolated(hexId);
        (scene as unknown as SceneSeams).spawnBoss();
        const boss = (scene as unknown as SceneSeams).boss as Boss;
        // The final boss is a shared singleton, so its hit count is observed
        // through a spy rather than a counting subclass.
        const hits = vi.spyOn(boss, 'takeDamage');
        for (let shot = 0; shot < 2; shot += 1) {
          detonateAoe(scene, boss.x, boss.y, weaponId);
        }
        expect(hits).toHaveBeenCalledTimes(expected);
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // AC6 — the measured ×2 / ×0.5 effect against the same mini-boss phase
  // ──────────────────────────────────────────────────────────────────

  /**
   * Fires neutral bullets until the mini-boss advances out of its opening
   * phase (or dies) and returns the number of shots that took.
   */
  function shotsToLeaveFirstPhase(
    scene: PlayScene,
    miniBoss: ChargeMiniBoss,
    weaponId: WeaponId,
  ): number {
    const startPhase = miniBoss.getPhaseNumber();
    let shots = 0;
    for (let guard = 0; guard < 5000; guard += 1) {
      if (!miniBoss.alive || miniBoss.getPhaseNumber() !== startPhase) break;
      fireBullet(scene, miniBoss.x, miniBoss.y, weaponId);
      shots += 1;
    }
    return shots;
  }

  it(
    'AC6 — the effective weapon clears a mini-boss phase ≥1.8× faster and the resisted ≥1.8× slower than neutral',
    async () => {
      // All three runs fight the same hex (hex-r1-4), so the mini-boss carries
      // the same authored phase pool; only the weapon's verdict differs.
      const neutralScene = await bootIsolated(HEXES.bulletNeutral);
      const neutralBoss = addMiniBoss(neutralScene);
      const phaseHp = neutralBoss.getHitPointsPerPhase();
      const neutralShots = shotsToLeaveFirstPhase(
        neutralScene,
        neutralBoss,
        'spread',
      );

      const effectiveScene = await bootIsolated(HEXES.bulletEffective);
      const effectiveBoss = addMiniBoss(effectiveScene);
      const effectiveShots = shotsToLeaveFirstPhase(
        effectiveScene,
        effectiveBoss,
        'ricochet',
      );

      const resistedScene = await bootIsolated(HEXES.bulletResisted);
      const resistedBoss = addMiniBoss(resistedScene);
      const resistedShots = shotsToLeaveFirstPhase(
        resistedScene,
        resistedBoss,
        'cannon',
      );

      // Precondition: a pool large enough that rounding cannot masquerade as
      // the measured effect (level 3 authors 16 hits per phase).
      expect(phaseHp).toBeGreaterThanOrEqual(10);
      expect(neutralShots / effectiveShots).toBeGreaterThanOrEqual(1.8);
      expect(resistedShots / neutralShots).toBeGreaterThanOrEqual(1.8);
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // Q2 scope guard — chaff is untouched by the charge
  // ──────────────────────────────────────────────────────────────────

  it(
    'scope guard — chaff (health = 1) dies in exactly one shot under every verdict',
    async () => {
      for (const [hexId, weaponId] of [
        [HEXES.bulletEffective, 'ricochet'],
        [HEXES.bulletNeutral, 'spread'],
        [HEXES.bulletResisted, 'cannon'],
      ] as const) {
        const scene = await bootIsolated(hexId);
        const chaff = addTarget(scene, 200, 200, 1);
        fireBullet(scene, chaff.x, chaff.y, weaponId);
        // A resisted chaff must still die on its first shot: the charge only
        // applies to multi-hit hulls (the Q2 scope guard).
        expect(chaff.hits).toBe(1);
        expect(chaff.alive).toBe(false);
      }
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // The resisted ledger, observed at the seam
  // ──────────────────────────────────────────────────────────────────

  it(
    'ledger — never charges more than one hit point per two connected resisted shots',
    async () => {
      const scene = await bootIsolated(HEXES.bulletResisted);
      const target = addTarget(scene, 200, 200);
      for (let shot = 0; shot < 10; shot += 1) {
        fireBullet(scene, target.x, target.y, 'cannon');
      }
      expect(target.hits).toBe(5);
    },
  );

  it(
    'ledger — is per-target: two targets never share a resisted pair',
    async () => {
      const scene = await bootIsolated(HEXES.bulletResisted);
      const first = addTarget(scene, 200, 200);
      const second = addTarget(scene, 260, 200);
      fireBullet(scene, first.x, first.y, 'cannon');
      fireBullet(scene, second.x, second.y, 'cannon');
      // Both are the first of their own pair, so neither has credited yet.
      expect(first.hits).toBe(0);
      expect(second.hits).toBe(0);
      fireBullet(scene, first.x, first.y, 'cannon');
      fireBullet(scene, second.x, second.y, 'cannon');
      expect(first.hits).toBe(1);
      expect(second.hits).toBe(1);
    },
  );

  it(
    'ledger — is per-weapon: two resisted weapons never share a pair',
    async () => {
      // hex-r1-1 resists both cannon and dual.
      const scene = await bootIsolated(HEXES.twoResisted);
      const target = addTarget(scene, 200, 200);
      fireBullet(scene, target.x, target.y, 'cannon');
      fireBullet(scene, target.x, target.y, 'dual');
      // Each weapon's opening shot is still pending, so no credit yet.
      expect(target.hits).toBe(0);
      fireBullet(scene, target.x, target.y, 'cannon');
      fireBullet(scene, target.x, target.y, 'dual');
      expect(target.hits).toBe(2);
    },
  );

  it(
    'ledger — drops a target killed mid-pair so a recycled hull starts a fresh pair',
    async () => {
      const scene = await bootIsolated(HEXES.bulletResisted);
      const first = addTarget(scene, 200, 200);
      const recycled = addTarget(scene, 260, 200);
      // The same identity, so a name-keyed ledger would carry the half-pair
      // from the dead hull to the recycled one unless death clears it.
      first.name = 'recycled-hull';
      recycled.name = 'recycled-hull';

      fireBullet(scene, first.x, first.y, 'cannon');
      expect(first.hits).toBe(0); // first of the pair: pending, no credit
      first.destroySelf(); // killed with the pair still pending

      fireBullet(scene, recycled.x, recycled.y, 'cannon');
      // The dead hull's pending shot must not pay out on the recycled hull.
      expect(recycled.hits).toBe(0);
      fireBullet(scene, recycled.x, recycled.y, 'cannon');
      expect(recycled.hits).toBe(1);
    },
  );

  // ──────────────────────────────────────────────────────────────────
  // Determinism — the charge adds no randomness
  // ──────────────────────────────────────────────────────────────────

  it(
    'determinism — a replay of the same resisted sequence lands an identical hit count (no new RNG)',
    async () => {
      const run = async (): Promise<number> => {
        const scene = await bootIsolated(HEXES.bulletResisted);
        const target = addTarget(scene, 200, 200);
        for (let shot = 0; shot < 10; shot += 1) {
          fireBullet(scene, target.x, target.y, 'cannon');
        }
        return target.hits;
      };

      const firstReplay = await run();
      const secondReplay = await run();

      // Identical replay: the ledger is deterministic and consumes no RNG.
      expect(secondReplay).toBe(firstReplay);
      // And the pinned resisted rate is one hit point per two shots.
      expect(firstReplay).toBe(5);
    },
  );
});
