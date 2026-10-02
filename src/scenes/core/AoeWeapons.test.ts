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
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { isOnGrid } from '../../utils/beat';
import { WEAPON_CATALOGUE, type WeaponDefinition } from '../../utils/weapons';
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

    expect(scene.hooks).toContain('onAoeHitsBoss:250,300,90');
    expect(scene.bossHitCount).toBe(0); // no boss present
  });

  it('AC5 — the boss override receives the hit exactly once per effect', async () => {
    const scene = await boot();
    scene.bossPresent = true;

    scene.runApplyAoe(WEAPON_CATALOGUE.mortar, 250, 300);

    expect(scene.bossHitCount).toBe(1);
    expect(scene.hooks).toContain('onAoeHitsBoss:250,300,70');
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
});
