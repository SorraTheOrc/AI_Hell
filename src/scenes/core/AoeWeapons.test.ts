/**
 * Scene-level tests for the shared AOE dispatch and effect resolution
 * (parent AH-0MUOOB3OR001V8CD, feature F1).
 *
 * These exercise the real `CombatScene` implementation through a minimal
 * stub subclass: the `_autoFire` dispatch hook, enemy damage through the
 * shared kill seam, enemy-bullet clearing with shared impact feedback, the
 * boss hook, and the `onFire`/`onRandom` trigger split. Every
 * assertion is on observable behaviour (entity state, registered hooks,
 * spawned bullets).
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
import { euclidPattern, isOnset } from '../../utils/euclid';
import { WEAPON_CATALOGUE, type AoEDescriptor, type WeaponDefinition } from '../../utils/weapons';
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
  health: number;
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

/**
 * An inert world-hazard stub: an enemy that reports the `asteroid` archetype
 * and counts every damage/death/accounting call, so "the Arc left the rock
 * untouched" is observable rather than inferred from a single flag
 * (AH-0MVNSIG1O0049G69). It is single-hit like a fully-killed rock and carries
 * the asteroid size-tier seam the shared kill accounting reads.
 */
class AsteroidStub extends StubEnemy {
  readonly archetype = 'asteroid';
  damageCalls = 0;
  destroyCalls = 0;
  destructionAudioCalls = 0;

  takeDamage(): number {
    this.damageCalls += 1;
    this.destroySelf();
    return 0;
  }

  override destroySelf(): void {
    if (!this.alive) return;
    this.destroyCalls += 1;
    super.destroySelf();
  }

  playDestructionAudio(): void {
    this.destructionAudioCalls += 1;
  }

  getSizeTier(): 'small' {
    return 'small';
  }
}

/** Minimal enemy bullet (graphics + velocity). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Image;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene, x = 0, y = 0) {
    // Bullets are cached-texture sprites (AH-0MW2DAY2L004QSKF).
    this.graphics = scene.add.image(x, y, '__DEFAULT');
  }
}

/** Minimal drop (the AOE path does not collect, but the base requires it). */
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
  runApplyAoeDescriptor(aoe: AoEDescriptor, x: number, y: number): void {
    this.applyAoEDescriptor(aoe, x, y);
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
  getFireFxEffects(): Phaser.GameObjects.Graphics[] {
    return this.fireFxEffects;
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

  it('AC1 — firing the Mortar spawns no travelling projectile', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');

    const spawned: PlayerBullet[] = [];
    const original = scene.spawnPlayerBullet.bind(scene);
    vi.spyOn(scene, 'spawnPlayerBullet').mockImplementation(
      (x, y, vx, vy, color, lifetime, radius) => {
        const bullet = original(x, y, vx, vy, color, lifetime, radius);
        spawned.push(bullet);
        return bullet;
      },
    );

    scene.runAutoFire(1.5);

    // The permanent cannon still fires its own bullets, but none is a Mortar
    // projectile: every spawned bullet travels at the shared speed (the Mortar
    // resolves instantly instead).
    expect(spawned.length).toBeGreaterThan(0);
    for (const bullet of spawned) {
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        PLAYER_BULLET_SPEED,
        5,
      );
    }
  });

  it('AC2 — firing the Mortar resolves its blast immediately at a random in-range point', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');
    const def = WEAPON_CATALOGUE.mortar;
    const range = def.aoe!.projectileSpeed! * def.bulletLifetime;

    // Deterministic sampling: u = 0.25 → r = range/2; v = 0.25 → θ = π/2
    // (straight down) → the point is (100, 100 + range/2).
    vi.spyOn(Math, 'random').mockReturnValue(0.25);

    scene.runAutoFire(1.5);

    // The blast resolved at fire time (hook recorded for the sampled point)...
    expect(scene.hooks).toContain('onAoeFired:mortar:onRandom:100,100');
    expect(scene.hooks).toContain(
      `onAoeHitsBoss:100,${100 + range / 2},${def.aoe!.radius}`,
    );
    // ...exactly once, at a point inside the disc of radius `range`...
    expect(
      scene.hooks.filter((h) => h.startsWith('onAoeHitsBoss')),
    ).toHaveLength(1);
    expect(range / 2).toBeLessThanOrEqual(range);
    // ...and the on-screen blast registered its VFX immediately.
    expect(scene.getAoeEffects()).toHaveLength(1);
  });

  // ── AC3 — enemy damage through the shared kill seam ───────────────

  it('AC3 — AOE damages only enemies inside the radius; enemies outside survive', async () => {
    const scene = await boot();
    // 20 px from the blast centre: inside the shipped (trimmed) Nova radius.
    const inside = new StubEnemy(scene, 120, 100);
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

    // Bomb uses the shared `_clearEnemyBullets` path (no enemy damage).
    (scene as unknown as { _clearEnemyBullets(): void })._clearEnemyBullets();

    expect(scene.bullets).toHaveLength(0);
    expect(enemy.destroyed).toBe(false);
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');
  });

  // ── AC5 — boss damage through the shared hook ─────────────────────

  it('AC5 — AOE reports its origin/radius to the boss hook', async () => {
    const scene = await boot();

    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 250, 300);

    expect(scene.hooks).toContain(
      `onAoeHitsBoss:250,300,${WEAPON_CATALOGUE.nova.aoe!.radius}`,
    );
    expect(scene.bossHitCount).toBe(0); // no boss present
  });

  it('AC5 — the boss override receives the hit exactly once per effect', async () => {
    const scene = await boot();
    scene.bossPresent = true;

    scene.runApplyAoe(WEAPON_CATALOGUE.mortar, 250, 300);

    expect(scene.bossHitCount).toBe(1);
    expect(scene.hooks).toContain(
      `onAoeHitsBoss:250,300,${WEAPON_CATALOGUE.mortar.aoe!.radius}`,
    );
  });

  // ── AC7 — beat-quantised triggering ───────────────────────────────

  it('AC7 — Nova fires on its one-onset-per-bar pattern and reports an onset tick', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');

    // The legacy nominal interval is one shot per bar (3000 ms at 80 BPM).
    expect(player.getFireInterval('nova')).toBe(3000);
    // The shipped cadence is the ladder's E(1, 16): one onset per bar.
    const pattern = player.getFirePattern('nova')!;
    expect(pattern.k).toBe(1);
    expect(pattern.n).toBe(16);
    expect(pattern.stepMs).toBe(187.5);

    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());
    scene.runAutoFire(3.0);

    const shot = player.getLastShotTime('nova');
    expect(shot).toBeDefined();
    expect(isOnGrid(shot!, pattern.stepMs, 0)).toBe(true);
    expect(
      isOnset(
        shot!,
        euclidPattern(pattern.k, pattern.n, pattern.rotation),
        pattern.stepMs,
        0,
      ),
    ).toBe(true);
    expect(shot! % 3000).toBe(0); // exactly one onset per 3 s bar
  });

  it('AC7 — conventional weapons keep their own on-grid cadence alongside AOE', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');

    scene.runAutoFire(3.0);

    // The cannon (E(9, 16)) and nova (E(1, 16)) each fired on their own
    // pattern's first onset of the bar.
    expect(player.getLastShotTime('cannon')).toBeDefined();
    expect(player.getLastShotTime('nova')).toBe(0);
    const cannonPattern = player.getFirePattern('cannon')!;
    expect(
      isOnset(
        player.getLastShotTime('cannon')!,
        euclidPattern(
          cannonPattern.k,
          cannonPattern.n,
          cannonPattern.rotation,
        ),
        cannonPattern.stepMs,
        0,
      ),
    ).toBe(true);
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

  it('F2 AC3 — the Nova launch flash plays the baked impact cue through the shared AOE seam (AH-0MV822BPT002GF17)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');
    const cue = vi.spyOn(effectsModule, 'playNovaImpactSound');

    scene.runAutoFire(3.0);

    // The ring expansion reads as the Nova's shockwave connecting: the baked
    // nova impact cue plays through the same shared onFire AOE VFX path that
    // spawns the ring, so the game and every gym sound identical.
    expect(cue).toHaveBeenCalledTimes(1);
  });

  it('F2 AC3 — the Nova launch flash is spawned through the shared combat-core fire-VFX path (AH-0MV822BPT002GF17)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('nova');
    expect(scene.getFireFxEffects()).toHaveLength(0);

    scene.runAutoFire(3.0);

    // `_autoFire` drives the muzzle flash from the weapon's `muzzleFlash`
    // metadata, so the fire VFX (launch cue) is wired through the shared
    // combat-core spawn path and the game + gyms show the identical flash.
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  it('F2 AC3 — a non-onFire weapon spawns no onFire ring at the ship', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');

    // Deterministic sampling keeps the Mortar blast away from the ship, so no
    // effect is centred there (where a Nova onFire ring would be drawn).
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    scene.runAutoFire(1.5);

    const effects = scene.getAoeEffects();
    expect(effects.length).toBeGreaterThanOrEqual(1);
    for (const effect of effects) {
      expect(effect.x === 100 && effect.y === 100).toBe(false);
    }
  });

  // ── F3 — Mortar random detonation (no travelling projectile) ───────

  it('AC3 — a leveled Mortar detonates once per pattern bullet', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');
    // The flattened projectile curve adds +1 at level 2 and +1 again at
    // level 4 (cap 4, k=0.18, AH-0MVWAVL6R001UI60), so level 4 → 3 bullets.
    player.equipWeapon('mortar');
    player.equipWeapon('mortar');
    player.equipWeapon('mortar');
    const def = player.getWeaponDef('mortar');
    expect(def.offsets.length).toBe(3);

    // rng=0 samples the ship centre each time → every detonation is on-screen,
    // so every blast draws VFX and hits the boss hook.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    scene.runAutoFire(1.5);

    expect(
      scene.hooks.filter((h) => h.startsWith('onAoeHitsBoss')),
    ).toHaveLength(3);
    expect(scene.getAoeEffects()).toHaveLength(3);
  });

  it('AC4 — an off-screen detonation plays the cue but draws no VFX', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 900, y: 100 });
    player.equipWeapon('mortar');
    const cue = vi.spyOn(effectsModule, 'playMortarDetonationSound');

    // rng≈1 → r≈range and θ≈0 → the point lands near (900 + 180, 100), beyond
    // the 960 px play area's right edge.
    vi.spyOn(Math, 'random').mockReturnValue(0.999);

    scene.runAutoFire(1.5);

    // The detonation cue still fires, but no off-screen graphics are created.
    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getAoeEffects()).toHaveLength(0);
  });

  it('AC5 — a random detonation damages enemies and clears bullets at the sampled point', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');
    const def = WEAPON_CATALOGUE.mortar;
    const range = def.aoe!.projectileSpeed! * def.bulletLifetime;

    // Deterministic point: (100, 100 + range/2) = (100, 190).
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const hit = new StubEnemy(scene, 100, 100 + range / 2);
    const missed = new StubEnemy(scene, 400, 400);
    scene.entities.push(hit, missed);
    const bulletHit = new StubBullet(scene, 100, 100 + range / 2);
    const bulletMiss = new StubBullet(scene, 400, 400);
    scene.bullets.push(bulletHit, bulletMiss);

    scene.runAutoFire(1.5);

    // The blast caught the enemy and bullet at the sampled point only.
    expect(hit.destroyed).toBe(true);
    expect(missed.destroyed).toBe(false);
    expect(scene.bullets).toEqual([bulletMiss]);
    expect(bulletHit.graphics.active).toBe(false);
  });

  it('F3 AC3 — the Mortar launch flash is spawned through the shared combat-core fire-VFX path (AH-0MV822C250051OVN)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');
    expect(scene.getFireFxEffects()).toHaveLength(0);

    scene.runAutoFire(1.5);

    // `_autoFire` drives the muzzle flash from the weapon's `muzzleFlash`
    // metadata, so the Mortar's launch cue is wired through the shared
    // combat-core spawn path — the game and every gym show the identical
    // flash.
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  it('F3 AC3 — the Mortar blast plays the baked impact cue through the shared AOE seam (AH-0MV822C250051OVN)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');
    const impactCue = vi.spyOn(effectsModule, 'playMortarImpactSound');
    const detonationCue = vi.spyOn(
      effectsModule,
      'playMortarDetonationSound',
    );

    // rng=0 samples the ship centre → the blast is on-screen and bursts.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    scene.runAutoFire(1.5);

    // The shell lands (baked impact crack) then detonates (heavy boom), both
    // through the same shared AOE detonation VFX seam, so the game and every
    // gym sound the identical Mortar connect.
    expect(impactCue).toHaveBeenCalledTimes(1);
    expect(detonationCue).toHaveBeenCalledTimes(1);
  });

  it('F3 AC3 — the Mortar burst is drawn from the ship origin (inbound arcing shell trail) (AH-0MV822C250051OVN)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('mortar');

    // rng=0.25 → the point is (100, 190): off the ship, so the inbound trail
    // has a real arc to draw.
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    scene.runAutoFire(1.5);

    // The burst is registered at the sampled point, and it carries the
    // inbound trail geometry (multiple stroked arc segments) so the blast
    // reads as an arcing shell landing.
    const effects = scene.getAoeEffects();
    expect(effects).toHaveLength(1);
    expect(effects[0].x).toBe(100);
    expect(effects[0].y).toBe(190);
    // STROKE_PATH (opcode 9) segments: the burst's 8 spikes plus the trail's
    // three arc strokes — strictly more than the 8 spikes alone.
    const buf = effects[0].commandBuffer as number[];
    // Per-opcode argument counts (Phaser Commands.js): MOVE_TO/LINE_TO carry 2
    // args, LINE_STYLE 3, FILL_STYLE 2; the path terminators none. Walking
    // with these strides keeps the counter aligned.
    const widths: Record<number, number> = {
      0: 7,
      1: 0,
      2: 0,
      3: 4,
      4: 2,
      5: 2,
      6: 3,
      7: 2,
      8: 0,
      9: 0,
    };
    let strokes = 0;
    for (let i = 0; i < buf.length; i += 1 + (widths[buf[i]] ?? 0)) {
      if (buf[i] === 9) strokes += 1;
    }
    expect(strokes).toBeGreaterThan(8);
  });

  // ── F4 — Arc nearest-enemy targeting + chaining ─────────────────────

  it('F4 AC3/AC4 — Arc strikes the nearest enemy then chains to nearby targets', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    // The Arc's chain reach is its shipped (trimmed) AOE radius, so both
    // targets sit well inside it (AH-0MVWAVKS0005P9VN).
    const nearest = new StubEnemy(scene, 130, 100); // 30 px from the ship
    const chained = new StubEnemy(scene, 170, 100); // 40 px from nearest
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
    const nearest = new StubEnemy(scene, 130, 100);
    const chained = new StubEnemy(scene, 170, 100);
    scene.entities.push(nearest, chained);
    const onPath = new StubBullet(scene, 150, 100);
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
      new StubEnemy(scene, 130, 100),
      new StubEnemy(scene, 170, 100),
    );

    scene.runAutoFire(0.75);

    expect(scene.getAoeEffects()).toHaveLength(1);
  });

  it('F4 AC5 — Arc connect fires the baked impact cue + a flash at each chained target (AH-0MV822CE7004MQ14)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    scene.entities.push(
      new StubEnemy(scene, 130, 100),
      new StubEnemy(scene, 170, 100),
    );
    const impactCue = vi.spyOn(effectsModule, 'playWeaponImpactCue');

    scene.runAutoFire(0.75);

    // One shot → one electric hit cue (the chain is a single attack), and
    // one impact flash per chained target through the shared impact seam —
    // the same path the game and every gym consume, so the connect cannot
    // drift between scenes. The cue dispatches through the shared
    // `playWeaponImpactCue` registry with the arc impact cue.
    expect(impactCue).toHaveBeenCalledTimes(1);
    expect(impactCue).toHaveBeenCalledWith('playArcImpactSound');
    // Primary target + one chain hop → two connect flashes.
    expect(scene.getBulletImpactEffects()).toHaveLength(2);
  });

  it('F4 AC3 — Arc is a no-op with no live enemies (no chain, no VFX, no impact cue)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    const impactCue = vi.spyOn(effectsModule, 'playWeaponImpactCue');

    scene.runAutoFire(0.75);

    // The chain is empty → no damage, no chain VFX and no connect feedback
    // to draw/play.
    expect(scene.getAoeEffects()).toHaveLength(0);
    expect(scene.hooks.filter((h) => h.startsWith('onEnemyDestroyed'))).toHaveLength(0);
    expect(impactCue).not.toHaveBeenCalled();
  });
});

// ── Arc-vs-asteroid targeting (AH-0MVNSIG1O0049G69) ─────────────────
//
// The Arc is the only auto-targeting AOE weapon: every beat it strikes the
// nearest target and chains to two more. Its candidate list is the raw enemy
// list, which also carries the inert `asteroid` world hazard — so a nearer
// rock used to absorb the bolt and could even be farmed for minerals and the
// rare Extra Life drop. These scene-level tests pin the shared rule end to
// end (the same `CombatScene.onAoeFired` path every gym inherits) and pin the
// unchanged weapons so a future change cannot silently widen the exclusion.

describe('Arc never affects asteroids (AH-0MVNSIG1O0049G69)', () => {
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

  it('AH-0MVNSIG1O0049G69 AC1 — a nearer asteroid is skipped for the ship enemy', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    const rock = new AsteroidStub(scene, 120, 100); // 20 px from the ship
    const enemy = new StubEnemy(scene, 140, 100); // 40 px from the ship
    scene.entities.push(rock, enemy);

    scene.runAutoFire(0.75);

    // The bolt spends itself on the threat, never on the closer rock.
    expect(enemy.destroyed).toBe(true);
    expect(rock.alive).toBe(true);
    expect(rock.destroyed).toBe(false);
    expect(rock.damageCalls).toBe(0);
    expect(rock.destroyCalls).toBe(0);
  });

  it('AH-0MVNSIG1O0049G69 AC2 — an enemy → asteroid → enemy line chains past the rock to both enemies', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    // enemyA 30 px from the ship; the rock sits 20 px from enemyA (nearer
    // than enemyB at 42 px, inside the shipped 46 px chain reach), so the
    // geometric next hop is the rock — the chain must step over it without
    // absorbing a link.
    const enemyA = new StubEnemy(scene, 130, 100);
    const rock = new AsteroidStub(scene, 150, 100);
    const enemyB = new StubEnemy(scene, 172, 100);
    scene.entities.push(enemyA, rock, enemyB);

    scene.runAutoFire(0.75);

    expect(enemyA.destroyed).toBe(true);
    expect(enemyB.destroyed).toBe(true);
    expect(rock.alive).toBe(true);
    expect(rock.damageCalls).toBe(0);
    // The link budget is unchanged: chains = 2 → primary + two hops.
    expect(WEAPON_CATALOGUE.arc.aoe!.chains).toBe(2);
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(2);
  });

  it('AH-0MVNSIG1O0049G69 AC3 — a rocks-only field is a full no-op (no damage, VFX, cue or kill accounting)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    const nearRock = new AsteroidStub(scene, 130, 100);
    const farRock = new AsteroidStub(scene, 150, 120);
    scene.entities.push(nearRock, farRock);
    const impactCue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');

    scene.runAutoFire(0.75);

    // No damage and no kill accounting: `onEnemyDestroyed` is the shared seam
    // that drives score, drops, minerals and the Extra Life roll, so a silent
    // seam means the Arc farms nothing from rock.
    expect(nearRock.alive).toBe(true);
    expect(farRock.alive).toBe(true);
    expect(nearRock.damageCalls).toBe(0);
    expect(farRock.damageCalls).toBe(0);
    expect(scene.hooks.filter((h) => h.startsWith('onEnemyDestroyed'))).toHaveLength(0);
    expect(destroySound).not.toHaveBeenCalled();
    // No chain VFX, no connect flash and no impact cue — identical to the
    // empty-field behaviour.
    expect(scene.getAoeEffects()).toHaveLength(0);
    expect(scene.getBulletImpactEffects()).toHaveLength(0);
    expect(impactCue).not.toHaveBeenCalled();
  });

  it('AH-0MVNSIG1O0049G69 AC4 — the bolt path and along-path bullet clear follow the filtered chain, never a rock segment', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    // The rock is due south of the ship; the enemy is due east. The filtered
    // chain is ship → enemy, so the vertical ship → rock segment is not part
    // of the bolt.
    const rock = new AsteroidStub(scene, 100, 150); // 50 px south
    const enemy = new StubEnemy(scene, 140, 100); // 40 px east
    scene.entities.push(rock, enemy);
    const onBoltPath = new StubBullet(scene, 120, 100); // on ship → enemy
    const onRockSegment = new StubBullet(scene, 100, 125); // on ship → rock only
    scene.bullets.push(onBoltPath, onRockSegment);

    scene.runAutoFire(0.75);

    expect(enemy.destroyed).toBe(true);
    expect(rock.alive).toBe(true);
    // The bullet through the real bolt segment is cleared; the one that only
    // lies on the discarded rock segment survives.
    expect(onBoltPath.graphics.active).toBe(false);
    expect(onRockSegment.graphics.active).toBe(true);
    expect(scene.bullets).toEqual([onRockSegment]);
  });

  it('AH-0MVNSIG1O0049G69 AC5 — the Nova ring still damages an asteroid inside its radius', async () => {
    const scene = await boot();
    const rock = new AsteroidStub(scene, 120, 100);
    scene.entities.push(rock);

    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);

    expect(rock.destroyed).toBe(true);
    expect(rock.damageCalls).toBe(1);
  });

  it('AH-0MVNSIG1O0049G69 AC5 — the Mortar blast still damages an asteroid inside its radius', async () => {
    const scene = await boot();
    const rock = new AsteroidStub(scene, 120, 100);
    scene.entities.push(rock);

    scene.runApplyAoe(WEAPON_CATALOGUE.mortar, 100, 100);

    expect(rock.destroyed).toBe(true);
    expect(rock.damageCalls).toBe(1);
  });

  it('AH-0MVNSIG1O0049G69 AC5 — the Smart Bomb pulse still damages an asteroid inside its area', async () => {
    const scene = await boot();
    const rock = new AsteroidStub(scene, 120, 100);
    scene.entities.push(rock);

    scene.runApplyAoeDescriptor(
      {
        trigger: 'screenPulse',
        radius: 200,
        damagesEnemies: true,
        clearsEnemyBullets: true,
        damage: 1,
      },
      100,
      100,
    );

    expect(rock.destroyed).toBe(true);
    expect(rock.damageCalls).toBe(1);
  });

  it('AH-0MVNSIG1O0049G69 AC5 — an entity with no archetype (gym TrainingTarget style) is still Arc-targetable', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    // `StubEnemy` carries no `archetype`, exactly like the GymWeapons
    // practice targets — an absent archetype must never look like a hazard.
    const bare = new StubEnemy(scene, 130, 100);
    scene.entities.push(bare);

    scene.runAutoFire(0.75);

    expect(bare.destroyed).toBe(true);
    expect(scene.hooks).toContain('onEnemyDestroyed:true');
  });

  it('AH-0MVNSIG1O0049G69 AC6 — Arc performs no asteroid kill accounting while other means still route the kill through the shared seam', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('arc');
    const rock = new AsteroidStub(scene, 120, 100);
    scene.entities.push(rock);

    // Arc beat: no damage, no destruction and therefore no `onEnemyDestroyed`
    // (the seam PlayScene._onEnemyKilled uses to award score/drops/minerals
    // and roll the Extra Life).
    scene.runAutoFire(0.75);
    expect(rock.damageCalls).toBe(0);
    expect(rock.destroyed).toBe(false);
    expect(rock.destructionAudioCalls).toBe(0);
    expect(scene.hooks.filter((h) => h.startsWith('onEnemyDestroyed'))).toHaveLength(0);

    // Other means (here the Nova ring) still destroy the rock and finalise it
    // through that same shared kill seam, so mineral/Extra Life accounting is
    // untouched for aimed or area play.
    scene.runApplyAoe(WEAPON_CATALOGUE.nova, 100, 100);
    expect(rock.destroyed).toBe(true);
    expect(rock.destructionAudioCalls).toBe(1);
    expect(scene.hooks).toContain('onEnemyDestroyed:true');
  });
});

// ── Smart Bomb screen-pulse descriptor seam (AH-0MV1BIWP9003EHRQ) ─────
//
// The Defender Smart Bomb resolves its pulse through the SAME
// `AoEDescriptor` / `applyAoEDescriptor` seam as the AOE weapons, so these
// tests pin that shared path: one descriptor application damages every enemy
// in range for `damage` HP, clears every bullet in range, and reports the
// origin/radius to the boss hook.

describe('Smart Bomb screen pulse reuses the AOE descriptor seam (AH-0MV1BIWP9003EHRQ)', () => {
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

  /** The descriptor shape the Smart Bomb resolves. */
  const screenPulse = (
    radius: number,
    damage = 1,
  ): AoEDescriptor => ({
    trigger: 'screenPulse',
    radius,
    damagesEnemies: true,
    clearsEnemyBullets: true,
    damage,
  });

  it('damages every in-range enemy exactly once and leaves a beyond-radius enemy untouched', async () => {
    const scene = await boot();
    const inRangeA = new ToughEnemy(scene, 430, 270, 3); // 50 px from origin
    const inRangeB = new ToughEnemy(scene, 540, 220, 3); // ≈ 81 px from origin
    const beyondRadius = new ToughEnemy(scene, 700, 350, 3); // ≈ 234 px — on-screen but beyond 200 px
    const offScreen = new ToughEnemy(scene, 5000, 5000, 3);
    scene.entities.push(inRangeA, inRangeB, beyondRadius, offScreen);

    // 200 px base pulse radius (10× ship size, AH-0MV8GPGBL009M0D8) covers the
    // ship-centred area but not the (700,350) neighbour nor (5000,5000).
    scene.runApplyAoeDescriptor(screenPulse(200), 480, 270);

    expect(inRangeA.damageCalls).toBe(1); // exactly one damage instance
    expect(inRangeB.damageCalls).toBe(1);
    expect(beyondRadius.damageCalls).toBe(0);
    expect(offScreen.damageCalls).toBe(0);
  });

  it('applies the descriptor damage count per enemy (multi-hit chip)', async () => {
    const scene = await boot();
    const tough = new ToughEnemy(scene, 480, 270, 5);
    scene.entities.push(tough);

    scene.runApplyAoeDescriptor(screenPulse(200, 2), 480, 270);

    expect(tough.damageCalls).toBe(2);
    expect(tough.health).toBe(3);
  });

  it('clears every enemy bullet in range and keeps an out-of-range bullet', async () => {
    const scene = await boot();
    const inside = new StubBullet(scene, 480, 270);
    const farInside = new StubBullet(scene, 600, 350); // ≈ 156 px — just inside 200 px
    const outside = new StubBullet(scene, 5000, 5000);
    scene.bullets.push(inside, farInside, outside);

    scene.runApplyAoeDescriptor(screenPulse(200), 480, 270);

    expect(scene.bullets).toEqual([outside]);
    expect(inside.graphics.active).toBe(false);
    expect(farInside.graphics.active).toBe(false);
    expect(outside.graphics.active).toBe(true);
  });

  it('reports the pulse origin and radius to the shared boss hook', async () => {
    const scene = await boot();
    scene.bossPresent = true;

    scene.runApplyAoeDescriptor(screenPulse(200), 480, 270);

    expect(scene.hooks).toContain('onAoeHitsBoss:480,270,200');
    expect(scene.bossHitCount).toBe(1);
  });
});
