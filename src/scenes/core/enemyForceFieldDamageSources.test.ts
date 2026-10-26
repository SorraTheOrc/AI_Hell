/**
 * Enemy force-field damage-source routing (AH-0MVM8GUZG008AWSU, epic
 * AH-0MVJ8W4GE007OMNT AC2).
 *
 * The field is a separate durability layer in front of the data-driven hull,
 * and it must be depleted by **every** player damage source through the one
 * shared `BaseEnemy.takeDamage()` seam — there is no parallel damage path.
 * This suite drives each source through the real shared scene code with a
 * **real** `BaseEnemy` subclass as the target (not a re-implementation of the
 * field logic), so a source that bypassed `takeDamage()` would show up as an
 * untouched field.
 *
 * Sources covered (one parameterised case each):
 *
 * | Source | Shared path |
 * | --- | --- |
 * | normal bullet | `_handleCollisions` → `onPlayerBulletHitsEnemy` |
 * | damage-budget beam (Wave Laser) | the same bullet seam with `bullet.maxHitPoints > 0` |
 * | AOE weapon (Nova) | `_autoFire` → `applyAoEDescriptor` → `damageEnemyViaAoe` |
 * | Smart Bomb | `_updateSmartBomb` → `onSmartBombPulse` → `applyAoEDescriptor` |
 * | Orbital Strike | `_updateOrbitalStrike` → `onOrbitalStrike` → `damageEnemyViaAoe` |
 * | Frenzy bonus hits | the bullet seam applies `1 + frenzyBonusHits()` hits |
 *
 * Every case asserts observable entity state: the field loses exactly the
 * damage the source resolves, the hull (`health`) is untouched, the enemy
 * stays alive and the hit is reported as absorbed.
 *
 * @module scenes/core/enemyForceFieldDamageSources.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { PLAYER_BULLET_RADIUS } from '../../core/constants';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { Player } from '../../entities/Player';
import { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import type { FormationOffset } from '../../utils/formations';
import {
  CombatScene,
  type CombatDrop,
  type CombatEnemyBullet,
} from './CombatScene';

// The Player's auto-fire reads the control scheme; the app default is
// Asteroids, so seed fourDirectional exactly as the other CombatScene suites.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

const OFFSET: FormationOffset = { row: 0, col: 0 };

/**
 * A real `BaseEnemy` target: the force-field state, absorb-before-hull rule
 * and break latch are the production implementation under test.
 */
class FieldTarget extends BaseEnemy {
  constructor(scene: Phaser.Scene, x: number, y: number, forceFieldHits: number) {
    const config: BaseEnemyConfig = {
      formationOffset: OFFSET,
      size: 16,
      color: 0x00ff00,
      health: 3,
      forceFieldHits,
    };
    super(scene, x, y, config);
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // No body needed: the field contract is state, not pixels.
  }
}

/** Minimal enemy bullet (the base class requires the participant shape). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
  }
}

/** Minimal drop (never collected here, but the base class requires it). */
class StubDrop implements CombatDrop {
  readonly powerUp: PowerUp;
  readonly dropId = 'speed_boost' as const;
  absorbing?: boolean;

  constructor(
    public x: number,
    public y: number,
    public readonly graphics: Phaser.GameObjects.Graphics,
  ) {
    this.powerUp = new PowerUp('speed_boost');
  }
}

/** Stub combat scene wiring the participant contract to test-owned state. */
class FieldSourceScene extends CombatScene<FieldTarget, StubBullet, StubDrop> {
  entities: FieldTarget[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();

  constructor() {
    super({ key: 'EnemyFieldSourceScene' });
  }

  create(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as never;
  }

  // ── Participant accessors ────────────────────────────────────────
  protected getPlayer(): Player | null {
    return this.playerRef;
  }
  protected getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }
  protected getEnemyEntities(): readonly FieldTarget[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  // ── Public wrappers for the protected template methods ───────────
  addPlayer(at: { x: number; y: number }): Player {
    const player = new Player(this, { x: at.x, y: at.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  addEnemy(x: number, y: number, forceFieldHits: number): FieldTarget {
    const enemy = new FieldTarget(this, x, y, forceFieldHits);
    this.entities.push(enemy);
    return enemy;
  }
  spawnBulletAt(x: number, y: number, maxHitPoints = 0): PlayerBullet {
    const bullet = new PlayerBullet(
      this,
      x,
      y,
      0,
      0,
      PLAYER_BULLET_RADIUS,
      0xffffff,
    );
    bullet.maxHitPoints = maxHitPoints;
    this.playerBullets.push(bullet);
    return bullet;
  }
  runAutoFire(dt: number): void {
    this._autoFire(dt);
  }
  runCollisions(): void {
    this._handleCollisions();
  }
  runUpdateSmartBomb(dt: number): void {
    this._updateSmartBomb(dt);
  }
  runUpdateOrbitalStrike(dt: number): void {
    this._updateOrbitalStrike(dt);
  }
}

/** Damage sources, one parameterised case each (parent AC2). */
type DamageSource =
  | 'normal bullet'
  | 'damage-budget beam (Wave Laser)'
  | 'AOE weapon (Nova)'
  | 'Smart Bomb'
  | 'Orbital Strike'
  | 'Frenzy bonus hits';

const DAMAGE_SOURCES: DamageSource[] = [
  'normal bullet',
  'damage-budget beam (Wave Laser)',
  'AOE weapon (Nova)',
  'Smart Bomb',
  'Orbital Strike',
  'Frenzy bonus hits',
];

describe('Enemy force field — every player damage source depletes it (AH-0MVM8GUZG008AWSU)', () => {
  /** Plenty of field hits: one resolved source can never break it here. */
  const FIELD_HITS = 5;

  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<FieldSourceScene> {
    booted = await bootScene([FieldSourceScene]);
    return booted.scene as FieldSourceScene;
  }

  /**
   * Drives one damage source at a field target and returns the number of
   * field hits that source resolves — read from the scene/registry so the
   * assertion follows balance tuning rather than restating it.
   */
  function driveSource(
    scene: FieldSourceScene,
    source: DamageSource,
    target: FieldTarget,
    player: Player,
  ): number {
    switch (source) {
      case 'normal bullet': {
        scene.spawnBulletAt(target.x, target.y);
        scene.runCollisions();
        return 1;
      }
      case 'damage-budget beam (Wave Laser)': {
        scene.spawnBulletAt(target.x, target.y, 1);
        scene.runCollisions();
        return 1;
      }
      case 'AOE weapon (Nova)': {
        player.equipWeapon('nova');
        scene.runAutoFire(3.0);
        return 1;
      }
      case 'Smart Bomb': {
        scene.effects.applyCollect('smart_bomb');
        const aoe = scene.effects.smartBombAoe();
        scene.runUpdateSmartBomb(0.016);
        return Math.max(1, Math.floor(aoe.damage ?? 1));
      }
      case 'Orbital Strike': {
        scene.effects.applyCollect('strike');
        scene.runUpdateOrbitalStrike(0.016);
        return scene.effects.strikeDamage();
      }
      case 'Frenzy bonus hits': {
        scene.effects.applyCollect('frenzy');
        scene.spawnBulletAt(target.x, target.y);
        scene.runCollisions();
        return 1 + scene.effects.frenzyBonusHits();
      }
    }
  }

  it.each(DAMAGE_SOURCES)(
    'AC2 — %s depletes the field before the hull and keeps the enemy alive',
    async (source) => {
      const scene = await boot();
      // The ship sits well clear of the target so the body-collision step
      // (a ram) can never contaminate a bullet case.
      const player = scene.addPlayer({ x: 60, y: 60 });
      // A target inside the ship-centred AOE radii (Nova 45 px, Smart Bomb
      // 200 px) but outside the ram contact range.
      const target = scene.addEnemy(player.x + 40, player.y, FIELD_HITS);

      const loss = driveSource(scene, source, target, player);

      expect(loss).toBeGreaterThan(0);
      expect(target.forceFieldHits).toBe(FIELD_HITS - loss);
      expect(target.hasForceField).toBe(true);
      // The hull is untouched while the field is up...
      expect(target.health).toBe(3);
      // ...and the enemy survives, reporting the hit as absorbed.
      expect(target.alive).toBe(true);
      expect(target.lastHitAbsorbed).toBe(true);
      expect(target.forceFieldBroken).toBe(false);
    },
  );
});
