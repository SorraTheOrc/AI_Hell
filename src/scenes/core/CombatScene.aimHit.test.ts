/**
 * Shared aim-hit seam firing rules (AH-0MWR054VE006YSLN, Feature 5 of 8 of
 * the aim-accuracy epic AH-0MWPOET5A002IPTP).
 *
 * The seam publishes one signal per **damage point that actually landed on an
 * enemy's hull** from the shared combat collision path. These tests pin the
 * firing contract directly on a `CombatScene` stub that records every
 * `onPlayerBulletHitEnemy` dispatch:
 *
 * - an ordinary bullet on a single-hit enemy reports exactly once;
 * - a damage-budget beam reports once per hit point it spends;
 * - the AOE seam reports once per damage point it applies;
 * - nothing reports for a ram, a wall bounce, an enemy bullet hitting the
 *   player, or a hit a force field absorbed (no hull damage);
 * - the base hook is a no-op, so a scene with no bot behaves exactly as before.
 *
 * The shielded case uses the **real** `BaseEnemy` force-field implementation
 * rather than a re-statement of the rule, so the seam reading the entity's
 * own `lastHitAbsorbed` result cannot drift from the production field logic.
 *
 * @module scenes/core/CombatScene.aimHit.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { PLAYER_BULLET_RADIUS, PLAYER_BULLET_SPEED } from '../../core/constants';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { advanceAndCull, PlayerBullet } from '../../entities/PlayerBullet';
import { Player } from '../../entities/Player';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import type { FormationOffset } from '../../utils/formations';
import {
  CombatScene,
  type CombatDrop,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatScene';

// The Player's auto-fire reads the control scheme; the app default is
// Asteroids, so seed fourDirectional exactly as the other CombatScene suites.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

const OFFSET: FormationOffset = { row: 0, col: 0 };

/** Single-hit enemy: a bullet destroys it outright (no `takeDamage` seam). */
class SimpleTarget
  extends Phaser.GameObjects.Container
  implements CombatEnemyEntity
{
  alive = true;
  destroyed = false;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
  }

  destroySelf(): void {
    this.alive = false;
    this.destroyed = true;
  }

  getHitRadius(): number {
    return 10;
  }
}

/** Multi-hit enemy: a bullet spends one hit point per `takeDamage()` call. */
class ToughTarget
  extends Phaser.GameObjects.Container
  implements CombatEnemyEntity
{
  alive = true;
  damageCalls = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private health = 3,
  ) {
    super(scene, x, y);
  }

  destroySelf(): void {
    this.alive = false;
  }

  getHitRadius(): number {
    return 10;
  }

  takeDamage(): number {
    if (!this.alive) return 0;
    this.damageCalls += 1;
    this.health -= 1;
    if (this.health <= 0) {
      this.health = 0;
      this.destroySelf();
    }
    return this.health;
  }
}

/**
 * A real `BaseEnemy` carrying a force field: the field absorbs hits before
 * the hull and reports `lastHitAbsorbed`, exactly as the production entity
 * does.
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
    // The field contract is state, not pixels.
  }
}

/** Minimal enemy bullet (the base class requires the participant shape). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Image;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.image(0, 0, '__DEFAULT');
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

type Target = SimpleTarget | ToughTarget | FieldTarget;

/**
 * Stub combat scene that records every aim-hit dispatch. The participant
 * accessors are wired to test-owned state, matching the other shared-core
 * suites; the recording override is the only behaviour under test.
 */
class AimHitScene extends CombatScene<Target, StubBullet, StubDrop> {
  entities: Target[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();

  /** Every enemy the shared seam published a hit for, in order. */
  readonly hits: Target[] = [];

  constructor() {
    super({ key: 'AimHitScene' });
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
  protected getEnemyEntities(): readonly Target[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  // ── Hook under test ──────────────────────────────────────────────
  protected override onPlayerBulletHitEnemy(enemy: Target): void {
    this.hits.push(enemy);
  }

  // ── Public wrappers for the protected template methods ───────────
  addPlayer(at: { x: number; y: number }): Player {
    const player = new Player(this, { x: at.x, y: at.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  addTarget<T extends Target>(target: T): T {
    this.entities.push(target);
    return target;
  }
  spawnBulletAt(x: number, y: number, maxHitPoints = 0): PlayerBullet {
    return this.spawnPlayerBullet(x, y, 0, 0, 0xffffff, 5, PLAYER_BULLET_RADIUS, maxHitPoints);
  }
  runCollisions(): void {
    this._handleCollisions();
  }
  runAoe(enemy: Target, damage: number): void {
    this.damageEnemyViaAoe(enemy, damage);
  }
  /** The ship's post-hit invulnerability window (a registered player hit). */
  isPlayerInvulnerable(): boolean {
    return this.invulnerable > 0;
  }
}

/** A scene that never overrides the hook — proves the default is a true no-op. */
class PlainAimScene extends CombatScene<SimpleTarget, StubBullet, StubDrop> {
  entities: SimpleTarget[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();

  constructor() {
    super({ key: 'PlainAimScene' });
  }

  create(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as never;
  }

  protected getPlayer(): Player | null {
    return this.playerRef;
  }
  protected getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }
  protected getEnemyEntities(): readonly SimpleTarget[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }
}

describe('shared aim-hit seam fires once per applied hull-damage point (AH-0MWR054VE006YSLN)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<AimHitScene> {
    booted = await bootScene([AimHitScene]);
    return booted.scene as AimHitScene;
  }

  it('reports an ordinary bullet on a single-hit enemy exactly once', async () => {
    const scene = await boot();
    const target = scene.addTarget(new SimpleTarget(scene, 40, 40));
    scene.spawnBulletAt(40, 40);

    scene.runCollisions();

    expect(target.destroyed).toBe(true);
    expect(scene.hits).toEqual([target]);
  });

  it('reports a lethal multi-hit blow exactly once', async () => {
    const scene = await boot();
    const target = scene.addTarget(new ToughTarget(scene, 40, 40, 1));
    scene.spawnBulletAt(40, 40);

    scene.runCollisions();

    expect(target.alive).toBe(false);
    expect(scene.hits).toEqual([target]);
  });

  it('reports once per hit point a damage-budget beam spends', async () => {
    const scene = await boot();
    const target = scene.addTarget(new ToughTarget(scene, 40, 40, 5));
    // A damage-budget beam (Wave Laser): up to two hit points on one target.
    scene.spawnBulletAt(40, 40, 2);

    scene.runCollisions();

    expect(target.damageCalls).toBe(2);
    expect(scene.hits).toEqual([target, target]);
  });

  it('reports once per damage point applied through the AOE seam', async () => {
    const scene = await boot();
    const target = scene.addTarget(new ToughTarget(scene, 40, 40, 5));

    scene.runAoe(target, 2);

    expect(target.damageCalls).toBe(2);
    expect(scene.hits).toEqual([target, target]);
  });

  it('does not report a player-body ram', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    const target = scene.addTarget(new SimpleTarget(scene, player.x, player.y));

    scene.runCollisions();

    expect(target.destroyed).toBe(true);
    expect(scene.hits).toEqual([]);
  });

  it('does not report a wall bounce', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 800, y: 500 });
    // A distant enemy proves the absence is real (nothing was damaged).
    const target = scene.addTarget(new ToughTarget(scene, 500, 500, 3));
    const bullet = scene.spawnPlayerBullet(
      2,
      300,
      -PLAYER_BULLET_SPEED,
      0,
      0xffffff,
      5,
      PLAYER_BULLET_RADIUS,
      0,
      2,
    );

    advanceAndCull(bullet, 0.01);
    scene.runCollisions();

    expect(target.damageCalls).toBe(0);
    expect(scene.hits).toEqual([]);
  });

  it('does not report an enemy bullet hitting the player', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    const target = scene.addTarget(new ToughTarget(scene, 500, 500, 3));
    const enemyBullet = new StubBullet(scene);
    enemyBullet.graphics.setPosition(player.x, player.y);
    scene.bullets.push(enemyBullet);

    scene.runCollisions();

    expect(scene.bullets).toHaveLength(0);
    expect(scene.isPlayerInvulnerable()).toBe(true);
    expect(target.damageCalls).toBe(0);
    expect(scene.hits).toEqual([]);
  });

  it('does not report a hit a force field absorbed, but does once the hull is hit', async () => {
    const scene = await boot();
    const target = scene.addTarget(new FieldTarget(scene, 40, 40, 2));

    // Two field hits: absorbed before the hull, so no damage lands and the
    // seam stays silent (the second hit also breaks the field).
    scene.spawnBulletAt(40, 40);
    scene.runCollisions();
    expect(target.forceFieldHits).toBe(1);
    expect(target.lastHitAbsorbed).toBe(true);
    expect(target.health).toBe(3);
    expect(scene.hits).toEqual([]);

    scene.spawnBulletAt(40, 40);
    scene.runCollisions();
    expect(target.hasForceField).toBe(false);
    expect(target.health).toBe(3);
    expect(scene.hits).toEqual([]);

    // The third hit lands on the hull and the seam reports it.
    scene.spawnBulletAt(40, 40);
    scene.runCollisions();
    expect(target.health).toBe(2);
    expect(target.lastHitAbsorbed).toBe(false);
    expect(scene.hits).toEqual([target]);
  });
});

describe('the default aim-hit hook is inert (AH-0MWR054VE006YSLN)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('leaves bullet damage and finalisation unchanged when no scene overrides it', async () => {
    booted = await bootScene([PlainAimScene]);
    const scene = booted.scene as PlainAimScene;
    const target = new SimpleTarget(scene, 40, 40);
    scene.entities.push(target);
    scene.spawnPlayerBullet(40, 40, 0, 0, 0xffffff, 5);
    (scene as unknown as { _handleCollisions(): void })._handleCollisions();

    expect(target.destroyed).toBe(true);
  });
});
