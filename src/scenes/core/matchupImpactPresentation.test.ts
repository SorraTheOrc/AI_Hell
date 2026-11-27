/**
 * Hex matchup impact presentation through the shared impact seam
 * (AH-0MWL88YYO0053DWH — implementation of Phase 3 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC8).
 *
 * `src/vfx/impactStateFeedback.test.ts` pins the state → cue / state → spec
 * **mapping**. This suite proves the mapping is actually **consumed** by the
 * one shared impact seam every player damage source uses: an effective or
 * resisted ordinary-bullet connect resolves the state's own spec (colour *and*
 * shape) and dedicated baked cue, while a neutral connect is byte-for-byte
 * today's per-weapon `impactFx` feedback.
 *
 * The verdict comes from the injectable `getMatchupLookup()` seam the run
 * publishes, so the test drives a synthetic lookup rather than authored data —
 * the same seam the game builds from the fought hex's `HexBossProfile`.
 *
 * @module scenes/core/matchupImpactPresentation.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import * as bulletImpactModule from '../../vfx/bulletImpact';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { EffectsRegistry } from '../../powerups/effects';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import {
  buildAuthoredVerdictLookup,
  type WeaponVerdictLookup,
} from '../../core/hangarWar/hexMatchup';
import {
  MATCHUP_EFFECTIVE_IMPACT_FX,
  MATCHUP_RESISTED_IMPACT_FX,
  WEAPON_CATALOGUE,
} from '../../utils/weapons';
import {
  CombatScene,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatScene';

/** Multi-hit enemy: eligible for the matchup charge (chaff is neutral). */
class MultiHitEnemy
  extends Phaser.GameObjects.Container
  implements CombatEnemyEntity
{
  alive = true;
  readonly maxHealth = 20;
  health = 20;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
  }

  takeDamage(): number {
    this.health -= 1;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
    return this.health;
  }

  destroySelf(): void {
    this.alive = false;
    this.health = 0;
  }

  getHitRadius(): number {
    return 12;
  }
}

/** Minimal combat scene exposing the shared bullet-vs-enemy pass. */
class PresentationScene extends CombatScene {
  entities: MultiHitEnemy[] = [];
  bullets: CombatEnemyBullet[] = [];
  effects = new EffectsRegistry();
  lookup: WeaponVerdictLookup | null = null;

  constructor() {
    super({ key: 'MatchupImpactPresentationScene' });
  }

  protected override getPlayer(): null {
    return null;
  }

  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }

  protected override getEnemyEntities(): readonly MultiHitEnemy[] {
    return this.entities;
  }

  protected override getEnemyBullets(): readonly CombatEnemyBullet[] {
    return this.bullets;
  }

  protected override setEnemyBullets(bullets: CombatEnemyBullet[]): void {
    this.bullets = bullets;
  }

  protected override getMatchupLookup(): WeaponVerdictLookup | null {
    return this.lookup;
  }

  runCollisions(): void {
    this._resolvePlayerBulletsVsEnemies();
  }
}

describe('matchup impact presentation through the shared seam (AC8)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<PresentationScene> {
    booted = await bootScene([PresentationScene]);
    return booted.scene as PresentationScene;
  }

  /**
   * Fires a shot at the enemy, carrying the weapon's own impactFx. `baseIds`,
   * when supplied, is what an evolved shot carries alongside its primary
   * `weaponId` (AH-0MWXJEZET003B2IC).
   */
  function connect(
    scene: PresentationScene,
    enemy: MultiHitEnemy,
    options: {
      weaponId?: keyof typeof WEAPON_CATALOGUE;
      baseIds?: readonly string[];
    } = {},
  ): PlayerBullet {
    const weaponId = options.weaponId ?? 'cannon';
    const bullet = scene.spawnPlayerBullet(enemy.x, enemy.y, 0, 0);
    bullet.weaponId = weaponId;
    bullet.baseIds = options.baseIds;
    bullet.impactFx = WEAPON_CATALOGUE[weaponId].impactFx;
    scene.runCollisions();
    return bullet;
  }

  it('an effective connect spawns the bright shard spec and its dedicated cue', async () => {
    const scene = await boot();
    scene.lookup = { cannon: 'effective' };
    const enemy = new MultiHitEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');

    connect(scene, enemy);

    expect(cue).toHaveBeenCalledWith(
      effectsModule.MATCHUP_IMPACT_STATE_CUES.effective.cue,
    );
    expect(impact).toHaveBeenCalledWith(
      scene,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({
        color: MATCHUP_EFFECTIVE_IMPACT_FX.color,
        radius: MATCHUP_EFFECTIVE_IMPACT_FX.radius,
        shape: 'shard',
      }),
    );
    // Effective doubles the offered hit point.
    expect(enemy.health).toBe(18);
  });

  it('a resisted connect spawns the dull spall spec and its dedicated cue', async () => {
    const scene = await boot();
    scene.lookup = { cannon: 'resisted' };
    const enemy = new MultiHitEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');

    connect(scene, enemy);

    expect(cue).toHaveBeenCalledWith(
      effectsModule.MATCHUP_IMPACT_STATE_CUES.resisted.cue,
    );
    expect(impact).toHaveBeenCalledWith(
      scene,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({
        color: MATCHUP_RESISTED_IMPACT_FX.color,
        radius: MATCHUP_RESISTED_IMPACT_FX.radius,
        shape: 'spall',
      }),
    );
    // The first resisted shot of a pair is shrugged off by the ledger.
    expect(enemy.health).toBe(20);
  });

  it('a neutral connect is unchanged: the weapon’s own spec and cue, no shape', async () => {
    const scene = await boot();
    scene.lookup = null;
    const enemy = new MultiHitEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');

    connect(scene, enemy);

    const base = WEAPON_CATALOGUE.cannon.impactFx!;
    expect(cue).toHaveBeenCalledWith(base.cue);
    expect(impact).toHaveBeenCalledWith(
      scene,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({
        color: base.color,
        radius: base.radius,
        duration: base.duration,
        shape: undefined,
      }),
    );
    expect(enemy.health).toBe(19);
  });

  it('an evolved shot resolves effective from its second half (Chain Ricochet vs the-dawnbreaker’s arc weakness)', async () => {
    const scene = await boot();
    // Mirrors hex-r1-1 (the-dawnbreaker): weaknesses = nova|arc. Chain Ricochet
    // fires as `ricochet` (primary) but carries `arc` as its second base id.
    scene.lookup = buildAuthoredVerdictLookup([], ['nova', 'arc']);
    const enemy = new MultiHitEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');

    connect(scene, enemy, { weaponId: 'ricochet', baseIds: ['ricochet', 'arc'] });

    // The second-half weakness doubles the offered hit point.
    expect(cue).toHaveBeenCalledWith(
      effectsModule.MATCHUP_IMPACT_STATE_CUES.effective.cue,
    );
    expect(enemy.health).toBe(18);
  });

  it('a non-evolved shot resolves exactly as today (no second id, no behaviour change)', async () => {
    const scene = await boot();
    // The same authored arc weakness must NOT apply to a bare ricochet shot
    // that carries no base ids: the single-id path is unchanged.
    scene.lookup = buildAuthoredVerdictLookup([], ['nova', 'arc']);
    const enemy = new MultiHitEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');

    connect(scene, enemy, { weaponId: 'ricochet' });

    // Neutral: the weapon's own cue, one ordinary hit point.
    expect(cue).toHaveBeenCalledWith(WEAPON_CATALOGUE.ricochet.impactFx!.cue);
    expect(enemy.health).toBe(19);
  });

  it('an unauthored / blank hex still resolves neutral for an evolved shot', async () => {
    const scene = await boot();
    scene.lookup = null;
    const enemy = new MultiHitEnemy(scene, 40, 40);
    scene.entities.push(enemy);

    connect(scene, enemy, { weaponId: 'ricochet', baseIds: ['ricochet', 'arc'] });

    expect(enemy.health).toBe(19);
  });

  it('keeps the spec cue and the state → cue mapping in agreement', () => {
    // The published specs' cues are exactly the mapping's cues (no drift).
    expect(MATCHUP_EFFECTIVE_IMPACT_FX.cue).toBe(
      effectsModule.MATCHUP_IMPACT_STATE_CUES.effective.cue,
    );
    expect(MATCHUP_RESISTED_IMPACT_FX.cue).toBe(
      effectsModule.MATCHUP_IMPACT_STATE_CUES.resisted.cue,
    );
  });
});
