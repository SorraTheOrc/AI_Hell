/**
 * Scene-level tests for the shared AOE dispatch and effect resolution
 * (parent AH-0MUOOB3OR001V8CD, feature F1).
 *
 * These exercise the real `CombatScene` implementation through a minimal
 * stub subclass: the `_autoFire` dispatch hook, enemy damage through the
 * shared kill seam, enemy-bullet clearing with shared impact feedback, the
 * boss hook, and the `onFire`/`onImpact` trigger split. Every assertion is
 * on observable behaviour (entity state, registered hooks, spawned bullets).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { PLAYER_BULLET_SPEED } from '../../core/constants';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { advanceAndCull } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { isOnGrid } from '../../utils/beat';
import { WEAPON_CATALOGUE, AOE_PROJECTILE_SPEEDS, type WeaponDefinition } from '../../utils/weapons';
import {
  CombatScene,
  type CombatDrop,
  type CombatEnemyBullet,
  type CombatEnemyEntity,
} from './CombatScene';

// These tests exercise the fourDirectional input mapping; the app default
// is Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

/** Single-hit enemy: destroyed outright by any hit. */
class StubEnemy extends Phaser.GameObjects.Container implements CombatEnemyEntity {
  alive = true;
  destroyed = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    private readonly radius = 10,
  ) {
    super(scene, x, y);
  }

  destroySelf(): void {
    this.alive = false;
    this.destroyed = true;
  }

  getHitRadius(): number {
    return this.radius;
  }
}

/** Multi-hit enemy mirroring the Harvester (E7) takeDamage seam. */
class ToughEnemy extends StubEnemy {
  private health: number;
  damageCalls = 0;
  destructionAudioCalls = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    health: number,
    radius = 10,
  ) {
    super(scene, x, y, radius);
    this.health = health;
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

  playDestructionAudio(): void {
    this.destructionAudioCalls += 1;
  }
}

/** Minimal enemy bullet (graphics + velocity). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    this.graphics = scene.add.graphics();
    this.graphics.setPosition(x, y);
  }
}

/** Minimal drop (the AOE path does not collect, but the base requires it). */
class StubDrop implements CombatDrop {
  readonly powerUp: PowerUp;
  readonly dropId = 'P5' as const;
  absorbing?: boolean;

  constructor(
    public x: number,
    public y: number,
    public readonly graphics: Phaser.GameObjects.Graphics,
  ) {
    this.powerUp = new PowerUp('P5');
  }
}

/** Stub combat scene wiring the participant contract to test-owned state. */
class AoeStubScene extends CombatScene<StubEnemy, StubBullet, StubDrop> {
  entities: StubEnemy[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();
  hooks: string[] = [];
  bossHitCount = 0;
  /** When false, `onAoeHitsBoss` reports no boss (the default). */
  bossPresent = false;

  constructor() {
    super({ key: 'AoeStubScene' });
  }

  create(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as never;
  }

  protected override getPlayer(): Player | null {
    return this.playerRef;
  }
  protected override getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }
  protected override getEnemyEntities(): readonly StubEnemy[] {
    return this.entities;
  }
  protected override getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected override setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  protected override onEnemyDestroyed(enemy: StubEnemy): void {
    this.hooks.push(`onEnemyDestroyed:${enemy.destroyed}`);
  }

  protected override onAoeFired(
    weaponId: string,
    def: WeaponDefinition,
    x: number,
    y: number,
  ): void {
    this.hooks.push(`onAoeFired:${weaponId}:${def.aoe?.trigger}:${x},${y}`);
    super.onAoeFired(weaponId as never, def, x, y);
  }

  protected override onAoeHitsBoss(
    x: number,
    y: number,
    radius: number,
  ): boolean {
    this.hooks.push(`onAoeHitsBoss:${x},${y},${radius}`);
    if (!this.bossPresent) return false;
    this.bossHitCount += 1;
    return true;
  }

  // ── Public wrappers ───────────────────────────────────────────────
  addPlayer(at: { x: number; y: number }): Player {
    const player = new Player(this, { x: at.x, y: at.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  runAutoFire(dt: number): void {
    this._autoFire(dt);
  }
  runApplyAoe(def: WeaponDefinition, x: number, y: number): void {
    this.applyAoeEffect(def, x, y);
  }
  runOnAoeProjectileSpawned(bullet: PlayerBullet, def: WeaponDefinition): void {
    this.onAoeProjectileSpawned(bullet, def);
  }
  runDetonateAoeProjectile(bullet: PlayerBullet): void {
    this.detonateAoeProjectile(bullet);
  }
  runCollisions(): void {
    this._handleCollisions();
  }
  getPlayerBullets(): PlayerBullet[] {
    return this.playerBullets;
  }
  getBulletImpactEffects(): Phaser.GameObjects.Graphics[] {
    return this.bulletImpactEffects;
  }
  getAoeEffects(): Phaser.GameObjects.Graphics[] {
    return this.aoeEffects;
  }
}

describe('AOE weapons — shared dispatch and effect resolution (F1)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<AoeStubScene> {
    booted = await bootScene([AoeStubScene]);
    return booted.scene as AoeStubScene;
  }

  // ── AC2 — dispatch from auto-fire ─────────────────────────────────

  it('AC2 — auto-fire dispatches an onFire AOE weapon and resolves it at the ship', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    const enemy = new StubEnemy(scene, 120, 100);
    scene.entities.push(enemy);
    player.equipWeapon('nova');

    scene.runAutoFire(3.0);

    // The AOE hook fired with the weapon, trigger and ship position.
    expect(scene.hooks).toContain('onAoeFired:nova:onFire:100,100');
    // The Nova ring resolved: the nearby enemy was destroyed and finalised.
    expect(enemy.destroyed).toBe(true);
    expect(scene.hooks).toContain('onEnemyDestroyed:true');
  });

  it('AC2 — an onFire AOE weapon does not spawn a travelling projectile', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');

    const spawned: Array<number | undefined> = [];
    vi.spyOn(scene, 'spawnPlayerBullet').mockImplementation(
      (x, y, vx, vy, color, lifetime) => {
        spawned.push(color);
        return { x, y, vx, vy, color, lifetime, active: true } as never;
      },
    );

    scene.runAutoFire(3.0);

    // The cannon still spawns its own bullets, but none carries Nova's colour.
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned).not.toContain(WEAPON_CATALOGUE.nova.bulletColor);
  });

  it('AC2 — an onImpact AOE weapon launches a projectile and does not resolve immediately', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    const enemy = new StubEnemy(scene, 110, 100);
    scene.entities.push(enemy);
    player.equipWeapon('mortar');

    const spawned: Array<number | undefined> = [];
    const original = scene.spawnPlayerBullet.bind(scene);
    vi.spyOn(scene, 'spawnPlayerBullet').mockImplementation(
      (x, y, vx, vy, color, lifetime) => {
        spawned.push(color);
        return original(x, y, vx, vy, color, lifetime);
      },
    );

    scene.runAutoFire(1.5);

    // Mortar fired (hook recorded) and launched its own projectile...
    expect(scene.hooks).toContain('onAoeFired:mortar:onImpact:100,100');
    expect(spawned).toContain(WEAPON_CATALOGUE.mortar.bulletColor);
    // ...but the blast has not resolved yet (it detonates on impact).
    expect(enemy.destroyed).toBe(false);
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');
  });

  // ── AC3 — enemy damage through the shared kill seam ───────────────

  it('AC3 — AOE damages only enemies inside the radius; enemies outside survive', async () => {
    const scene = await boot();
    const inside = new StubEnemy(scene, 150, 100);
    const outside = new StubEnemy(scene, 400, 100);
    scene.entities.push(inside, outside);

    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);

    expect(inside.destroyed).toBe(true);
    expect(outside.destroyed).toBe(false);
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
  });

  it('AC3 — multi-hit enemies take one damage per effect and finalise exactly once', async () => {
    const scene = await boot();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const tough = new ToughEnemy(scene, 120, 100, 2);
    scene.entities.push(tough);

    // First application: non-lethal, no finalisation.
    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);
    expect(tough.alive).toBe(true);
    expect(tough.damageCalls).toBe(1);
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');
    expect(destroySound).not.toHaveBeenCalled();

    // Second application: lethal, finalised exactly once.
    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);
    expect(tough.alive).toBe(false);
    expect(tough.damageCalls).toBe(2);
    expect(tough.destructionAudioCalls).toBe(1);
    expect(destroySound).not.toHaveBeenCalled(); // entity supplies its own cue
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
  });

  it('AC3 — a killed enemy floats one destruction cue through the shared fallback', async () => {
    const scene = await boot();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const single = new StubEnemy(scene, 120, 100);
    scene.entities.push(single);

    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);

    expect(single.destroyed).toBe(true);
    expect(destroySound).toHaveBeenCalledTimes(1);
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
  });

  // ── AC4 — enemy bullet clearing ───────────────────────────────────

  it('AC4 — AOE clears enemy bullets inside the radius with shared impact feedback', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const inside = new StubBullet(scene, 130, 100);
    const outside = new StubBullet(scene, 400, 100);
    scene.bullets.push(inside, outside);

    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);

    expect(scene.bullets).toEqual([outside]);
    expect(inside.graphics.active).toBe(false);
    expect(outside.graphics.active).toBe(true);
    // Shared interception feedback fired once (cue + flash).
    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  it('AC4 — P4 bomb semantics are untouched: clearing bullets never damages enemies', async () => {
    const scene = await boot();
    const enemy = new StubEnemy(scene, 100, 100);
    scene.entities.push(enemy);
    scene.bullets.push(new StubBullet(scene, 100, 100));

    // P4 uses the shared `_clearEnemyBullets` path (no enemy damage).
    (scene as unknown as { _clearEnemyBullets(): void })._clearEnemyBullets();

    expect(scene.bullets).toHaveLength(0);
    expect(enemy.destroyed).toBe(false);
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');
  });

  // ── AC5 — boss damage through the shared hook ─────────────────────

  it('AC5 — AOE reports its origin/radius to the boss hook', async () => {
    const scene = await boot();

    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 250, 300);

    expect(scene.hooks).toContain('onAoeHitsBoss:250,300,45');
    expect(scene.bossHitCount).toBe(0); // no boss present
  });

  it('AC5 — the boss override receives the hit exactly once per effect', async () => {
    const scene = await boot();
    scene.bossPresent = true;

    scene.runApplyAoe(WEAPON_CATALOGUE.mortar, 250, 300);

    expect(scene.bossHitCount).toBe(1);
    expect(scene.hooks).toContain('onAoeHitsBoss:250,300,35');
  });

  // ── AC7 — beat-quantised triggering ───────────────────────────────

  it('AC7 — Nova fires on the 3000 ms beat grid and reports an on-grid shot', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');

    expect(player.getFireInterval('nova')).toBe(3000);

    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());
    scene.runAutoFire(3.0);

    const shot = player.getLastShotTime('nova');
    expect(shot).toBeDefined();
    expect(isOnGrid(shot!, 3000, 0)).toBe(true);
    expect(shot! % 3000).toBe(0);
  });

  it('AC7 — conventional weapons keep their own on-grid cadence alongside AOE', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');

    scene.runAutoFire(3.0);

    // The cannon (375 ms) and nova (3000 ms) both fired on their own grids.
    expect(player.getLastShotTime('cannon')).toBeDefined();
    expect(player.getLastShotTime('nova')).toBe(3000);
    expect(player.getLastShotTime('cannon')! % 375).toBe(0);
  });

  // ── Regression: ordinary bullets still travel at the shared speed ──

  it('AC2 — auto-fire still produces shared-speed bullets for conventional weapons', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });

    scene.runAutoFire(0.5);

    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
    for (const bullet of scene.getPlayerBullets()) {
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        PLAYER_BULLET_SPEED,
        5,
      );
    }
  });

  // ── F2 — Nova expanding-ring VFX through the shared dispatch ──────

  it('F2 AC3 — firing Nova spawns the expanding-ring VFX through the shared core', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');
    expect(scene.getAoeEffects()).toHaveLength(0);

    scene.runAutoFire(3.0);

    // Exactly one Nova ring was registered (the cannon spawns no AOE VFX).
    expect(scene.getAoeEffects()).toHaveLength(1);
    const ring = scene.getAoeEffects()[0];
    expect(ring.x).toBe(100);
    expect(ring.y).toBe(100);
  });

  it('F2 AC3 — an onImpact weapon spawns no onFire ring', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');

    scene.runAutoFire(1.5);

    // Mortar detonates later (F3); no Nova ring is drawn at fire time.
    expect(scene.getAoeEffects()).toHaveLength(0);
  });

  // ── F3 — Mortar onImpact projectile + detonation ───────────────────

  it('F3 AC3 — the Mortar projectile travels at the slower AOE projectile speed', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');

    scene.runAutoFire(1.5);

    const shell = scene
      .getPlayerBullets()
      .find((b) => b.color === WEAPON_CATALOGUE.mortar.bulletColor);
    expect(shell).toBeDefined();
    expect(Math.hypot(shell!.vx, shell!.vy)).toBeCloseTo(
      AOE_PROJECTILE_SPEEDS.mortar,
      5,
    );
    // Deliberately slower than a conventional bullet, so the blast point is
    // readable.
    expect(AOE_PROJECTILE_SPEEDS.mortar).toBeLessThan(PLAYER_BULLET_SPEED);
  });

  it('F3 AC4 — the Mortar shell detonates on lifetime expiry', async () => {
    const scene = await boot();
    const def = WEAPON_CATALOGUE.mortar;
    const enemy = new StubEnemy(scene, 100, 100);
    scene.entities.push(enemy);
    const bullet = scene.spawnPlayerBullet(
      100,
      100,
      0,
      0,
      def.bulletColor,
      def.bulletLifetime,
    );
    bullet.aoeWeapon = def;
    scene.runOnAoeProjectileSpawned(bullet, def);
    expect(scene.getAoeEffects()).toHaveLength(0);

    // Advance past the lifetime: the expiry callback detonates the blast.
    advanceAndCull(bullet, def.bulletLifetime + 0.01);

    expect(bullet.active).toBe(false);
    expect(enemy.destroyed).toBe(true);
    expect(scene.getAoeEffects()).toHaveLength(1);
  });

  it('F3 AC4 — the Mortar shell detonates when it hits an enemy', async () => {
    const scene = await boot();
    const def = WEAPON_CATALOGUE.mortar;
    const enemy = new StubEnemy(scene, 120, 100);
    scene.entities.push(enemy);
    const bullet = scene.spawnPlayerBullet(
      120,
      100,
      0,
      0,
      def.bulletColor,
      def.bulletLifetime,
    );
    bullet.aoeWeapon = def;
    scene.runOnAoeProjectileSpawned(bullet, def);

    scene.runCollisions();

    // The blast (not a direct hit) resolved the damage and the VFX.
    expect(enemy.destroyed).toBe(true);
    expect(bullet.active).toBe(false);
    expect(scene.getAoeEffects()).toHaveLength(1);
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
  });

  it('F3 AC4 — the Mortar shell detonates when it intercepts an enemy bullet', async () => {
    const scene = await boot();
    const def = WEAPON_CATALOGUE.mortar;
    scene.bullets.push(new StubBullet(scene, 120, 100));
    // Far enough not to be hit directly by the projectile's pass-1 scan, but
    // inside the Mortar blast radius (35 px) from the interception point.
    const enemy = new StubEnemy(scene, 150, 100);
    scene.entities.push(enemy);
    const bullet = scene.spawnPlayerBullet(
      120,
      100,
      0,
      0,
      def.bulletColor,
      def.bulletLifetime,
    );
    bullet.aoeWeapon = def;
    scene.runOnAoeProjectileSpawned(bullet, def);

    scene.runCollisions();

    expect(scene.bullets).toHaveLength(0); // intercepted
    expect(enemy.destroyed).toBe(true); // blast caught the nearby enemy
    expect(scene.getAoeEffects()).toHaveLength(1);
  });

  it('F3 AC4 — a projectile detonates at most once (collision + expiry)', async () => {
    const scene = await boot();
    const def = WEAPON_CATALOGUE.mortar;
    const tough = new ToughEnemy(scene, 100, 100, 3);
    scene.entities.push(tough);
    const bullet = scene.spawnPlayerBullet(
      100,
      100,
      0,
      0,
      def.bulletColor,
      def.bulletLifetime,
    );
    bullet.aoeWeapon = def;
    scene.runOnAoeProjectileSpawned(bullet, def);

    scene.runDetonateAoeProjectile(bullet);
    scene.runDetonateAoeProjectile(bullet);

    expect(tough.damageCalls).toBe(1);
    expect(scene.getAoeEffects()).toHaveLength(1);
  });

  it('F3 AC6 — the detonation plays the dedicated Mortar detonation cue', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playMortarDetonationSound');
    const def = WEAPON_CATALOGUE.mortar;
    const bullet = scene.spawnPlayerBullet(
      100,
      100,
      0,
      0,
      def.bulletColor,
      def.bulletLifetime,
    );
    bullet.aoeWeapon = def;

    scene.runDetonateAoeProjectile(bullet);

    expect(cue).toHaveBeenCalledTimes(1);
  });

  // ── F4 — Arc nearest-enemy targeting + chaining ─────────────────────

  it('F4 AC3/AC4 — Arc strikes the nearest enemy then chains to nearby targets', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    const nearest = new StubEnemy(scene, 150, 100); // 50 px from the ship
    const chained = new StubEnemy(scene, 200, 100); // 50 px from nearest
    const far = new StubEnemy(scene, 700, 450); // out of reach
    scene.entities.push(nearest, chained, far);

    scene.runAutoFire(0.75);

    expect(nearest.destroyed).toBe(true);
    expect(chained.destroyed).toBe(true);
    expect(far.destroyed).toBe(false);
  });

  it('F4 AC4 — Arc chains at most the descriptor chain count', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    // A tight line of four enemies all within reach of each other.
    const enemies = [
      new StubEnemy(scene, 140, 100),
      new StubEnemy(scene, 180, 100),
      new StubEnemy(scene, 220, 100),
      new StubEnemy(scene, 260, 100),
    ];
    scene.entities.push(...enemies);

    scene.runAutoFire(0.75);

    const destroyed = enemies.filter((e) => e.destroyed).length;
    // chains = 2 → the primary plus two chained targets.
    expect(destroyed).toBe(3);
    expect(WEAPON_CATALOGUE.arc.aoe!.chains).toBe(2);
  });

  it('F4 AC4 — Arc clears enemy bullets lying along the bolt path only', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    const nearest = new StubEnemy(scene, 150, 100);
    const chained = new StubEnemy(scene, 200, 100);
    scene.entities.push(nearest, chained);
    const onPath = new StubBullet(scene, 175, 100);
    const offPath = new StubBullet(scene, 175, 300);
    scene.bullets.push(onPath, offPath);

    scene.runAutoFire(0.75);

    expect(scene.bullets).toEqual([offPath]);
    expect(onPath.graphics.active).toBe(false);
  });

  it('F4 AC5 — Arc spawns the chaining-bolt VFX through the shared core', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    scene.entities.push(
      new StubEnemy(scene, 150, 100),
      new StubEnemy(scene, 200, 100),
    );

    scene.runAutoFire(0.75);

    expect(scene.getAoeEffects()).toHaveLength(1);
  });

  it('F4 AC3 — Arc is a no-op with no live enemies (no chain, no VFX)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');

    scene.runAutoFire(0.75);

    // The chain is empty → no damage and no chain VFX to draw.
    expect(scene.getAoeEffects()).toHaveLength(0);
    expect(scene.hooks.filter((h) => h.startsWith('onEnemyDestroyed'))).toHaveLength(0);
  });
});
