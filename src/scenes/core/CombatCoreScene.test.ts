import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  PLAYER_BULLET_SPEED,
  PLAYER_RESPAWN_INVULNERABLE,
} from '../../core/constants';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import {
  CombatCoreScene,
  type CombatDrop,
  type CombatEnemyBullet,
} from './CombatCoreScene';

// These base tests exercise the fourDirectional input mapping; the app
// default is Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

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

/** Minimal drop satisfying the shared collect contract. */
class StubDrop implements CombatDrop {
  readonly powerUp: PowerUp;
  readonly dropId: 'P5' | 'P4';
  weaponDropId?: string;
  absorbing?: boolean;

  constructor(
    public x: number,
    public y: number,
    public readonly graphics: Phaser.GameObjects.Graphics,
    dropId: 'P5' | 'P4',
    weaponDropId?: string,
    growth = 0.5,
  ) {
    this.dropId = dropId;
    this.weaponDropId = weaponDropId;
    // Grow above the 3 % collection threshold so `tryCollect()` succeeds;
    // a growth of 0 leaves the drop uncollectible.
    this.powerUp = new PowerUp(dropId);
    this.powerUp.advance(growth);
  }
}

/**
 * Bare stub subclass: it only satisfies the participant contract so the
 * base's default hook implementations can be exercised directly.
 */
class BareCoreScene extends CombatCoreScene {
  playerRef: Player | null = null;
  effects = new EffectsRegistry();
  bullets: StubBullet[] = [];

  constructor() {
    super({ key: 'CombatCoreSceneBareStub' });
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
  protected override getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected override setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  addPlayer(at: { x: number; y: number }): Player {
    const player = new Player(this, { x: at.x, y: at.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }

  // Public wrappers for the protected hook defaults.
  runGetInvulnerabilityDuration(): number {
    return this.getInvulnerabilityDuration();
  }
  runTryAbsorbPlayerHit(player: Player): boolean {
    return this.tryAbsorbPlayerHit(player);
  }
  runIsPlayerPhased(): boolean {
    return this.isPlayerPhased();
  }
  runOnWeaponFired(weaponId: string): void {
    this.onWeaponFired(weaponId as never);
  }
  runPlayPickupCue(drop: StubDrop): void {
    this._playPickupCue(drop);
  }
  runOnPowerUpCollected(drop: StubDrop): void {
    this.onPowerUpCollected(drop);
  }
  runOnWeaponCollected(drop: StubDrop): void {
    this.onWeaponCollected(drop);
  }
  runReadInput() {
    return this._readPlayerInput();
  }
  runUpdateCollectAnimations(dt: number): void {
    this._updateCollectAnimations(dt);
  }
}

/**
 * Recording stub subclass: pins the hook contract by recording every
 * dispatch while delegating to `super` where the default behaviour is
 * itself under test.
 */
class StubCoreScene extends BareCoreScene {
  hooks: string[] = [];

  protected override onWeaponFired(weaponId: string): void {
    this.hooks.push(`onWeaponFired:${weaponId}`);
  }
  protected override onWeaponCollected(drop: StubDrop): void {
    this.hooks.push(`onWeaponCollected:${drop.weaponDropId}`);
  }
  protected override onPowerUpCollected(drop: StubDrop): void {
    this.hooks.push(`onPowerUpCollected:${drop.dropId}`);
  }
  protected override _playPickupCue(drop: StubDrop): void {
    this.hooks.push(`_playPickupCue:${drop.dropId}`);
  }

  runAutoFire(dt: number): void {
    this._autoFire(dt);
  }
  runCollectDrop(drop: StubDrop): void {
    this._collectDrop(drop);
  }
  runClearEnemyBullets(): void {
    this._clearEnemyBullets();
  }
  runSpawnPlayerExplosion(x: number, y: number): void {
    this._spawnPlayerExplosion(x, y);
  }
  getPlayerBullets(): PlayerBullet[] {
    return this.playerBullets;
  }
  getPlayerExplosions(): Phaser.GameObjects.Graphics[] {
    return this.playerExplosions;
  }
  getCollectAnimations() {
    return this.collectAnimations;
  }
  addDrop(id: 'P5' | 'P4', weaponDropId?: string): StubDrop {
    const g = this.add.graphics();
    return new StubDrop(120, 120, g, id, weaponDropId);
  }
}

describe('CombatCoreScene — shared base class', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function boot<T>(sceneClass: typeof Phaser.Scene): Promise<T> {
    const booted = await bootScene([sceneClass]);
    games.push(booted);
    return booted.scene as unknown as T;
  }

  // ── AC1 — structure ───────────────────────────────────────────────

  it('AC1 — is a concrete class extending Phaser.Scene declaring the shared template methods', () => {
    // The base itself is instantiable (concrete) and extends Phaser.Scene.
    expect(Object.getPrototypeOf(CombatCoreScene.prototype)).toBe(
      Phaser.Scene.prototype,
    );
    expect(
      new CombatCoreScene({ key: 'CombatCoreSceneInstantiable' }),
    ).toBeInstanceOf(CombatCoreScene);

    const proto = CombatCoreScene.prototype as unknown as Record<
      string,
      unknown
    >;
    for (const method of [
      '_readPlayerInput',
      '_autoFire',
      '_collectDrop',
      '_clearEnemyBullets',
      '_spawnPlayerExplosion',
    ]) {
      expect(typeof proto[method]).toBe('function');
    }
  });

  it('AC1 — a stub subclass inherits the base and can override the participant contract', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    expect(scene).toBeInstanceOf(CombatCoreScene);
    expect(scene.getPlayerBullets()).toEqual([]);
    expect(scene.getCollectAnimations()).toEqual([]);
    expect(scene.getPlayerExplosions()).toEqual([]);
  });

  // ── AC4 — input mapping ───────────────────────────────────────────

  it('AC4 — _readPlayerInput returns null until a player and input bindings exist', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    expect(scene.runReadInput()).toBeNull();

    scene.addPlayer({ x: 100, y: 100 });
    const input = scene.runReadInput();
    expect(input).not.toBeNull();
    expect(input).toHaveProperty('up');
  });

  // ── AC4 — auto-fire ───────────────────────────────────────────────

  it('AC4 — _autoFire is a no-op without a player', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.runAutoFire(10);
    expect(scene.hooks).toEqual([]);
    expect(scene.getPlayerBullets()).toEqual([]);
  });

  it('AC4 — _autoFire dispatches the hook once per firing weapon and spawns bullets at the shared speed', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    const activeWeapons = player.getActiveWeapons();

    scene.runAutoFire(10);

    const fired = scene.hooks.filter((h) => h.startsWith('onWeaponFired:'));
    expect(fired).toHaveLength(activeWeapons.length);
    expect(activeWeapons.length).toBeGreaterThan(0);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
    for (const bullet of scene.getPlayerBullets()) {
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        PLAYER_BULLET_SPEED,
        5,
      );
    }
  });

  it('AC4 — spawnPlayerBullet registers the bullet on the shared player bullet list', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const bullet = scene.spawnPlayerBullet(10, 20, 1, 2, 0x00ffff, 1);
    expect(scene.getPlayerBullets()).toContain(bullet);
    expect(bullet.vx).toBe(1);
    expect(bullet.vy).toBe(2);
  });

  // ── AC4 — drop collection ─────────────────────────────────────────

  it('AC4 — _collectDrop applies a power-up, dispatches the hook and starts the absorb animation', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const drop = scene.addDrop('P5');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onPowerUpCollected:P5');
    expect(scene.hooks).toContain('_playPickupCue:P5');
    expect(drop.absorbing).toBe(true);
    expect(scene.getCollectAnimations().length).toBe(1);
  });

  it('AC4 — _collectDrop applies a weapon, dispatches the weapon hook and starts the absorb animation', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const drop = scene.addDrop('P5', 'spread');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:spread');
    expect(scene.hooks).toContain('_playPickupCue:P5');
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    expect(drop.absorbing).toBe(true);
    expect(scene.getCollectAnimations().length).toBe(1);
  });

  it('AC4 — _collectDrop weapon reset clears the equipped weapon through the registry', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.effects.applyWeapon('spread');
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    const drop = scene.addDrop('P5', 'reset');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:reset');
    expect(scene.effects.hasWeapon('spread')).toBe(false);
    expect(drop.absorbing).toBe(true);
  });

  it('AC4 — _collectDrop clears enemy bullets for a P4 bomb', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.bullets.push(
      new StubBullet(scene, 1, 1),
      new StubBullet(scene, 2, 2),
    );
    const drop = scene.addDrop('P4');

    scene.runCollectDrop(drop);

    expect(scene.bullets).toHaveLength(0);
    expect(scene.hooks).toContain('onPowerUpCollected:P4');
  });

  it('AC4 — _collectDrop ignores a drop that is not yet collectible', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const g = scene.add.graphics();
    // Growth 0 leaves the drop below the collection threshold.
    const uncollectible = new StubDrop(120, 120, g, 'P5', undefined, 0);

    scene.runCollectDrop(uncollectible);

    expect(scene.hooks).toEqual([]);
    expect(uncollectible.absorbing).toBeUndefined();
    expect(scene.getCollectAnimations()).toHaveLength(0);
  });

  it('AC4 — _updateCollectAnimations advances and prunes completed animations', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const drop = scene.addDrop('P5');
    scene.runCollectDrop(drop);
    expect(scene.getCollectAnimations().length).toBe(1);

    scene.runUpdateCollectAnimations(10);

    expect(scene.getCollectAnimations()).toHaveLength(0);
  });

  // ── AC4 — clear / explosion registries ────────────────────────────

  it('AC4 — _clearEnemyBullets destroys and empties the enemy bullets', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const a = new StubBullet(scene, 1, 1);
    const b = new StubBullet(scene, 2, 2);
    scene.bullets.push(a, b);
    const destroyA = vi.spyOn(a.graphics, 'destroy');

    scene.runClearEnemyBullets();

    expect(destroyA).toHaveBeenCalled();
    expect(scene.bullets).toHaveLength(0);
  });

  it('AC4 — _spawnPlayerExplosion registers the burst in the shared registry', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    expect(scene.getPlayerExplosions()).toHaveLength(0);
    scene.runSpawnPlayerExplosion(10, 20);
    expect(scene.getPlayerExplosions().length).toBeGreaterThan(0);
  });

  // ── AC3/AC4 — hook defaults ───────────────────────────────────────

  it('AC3 — getInvulnerabilityDuration defaults to the shared PLAYER_RESPAWN_INVULNERABLE', async () => {
    const scene = await boot<BareCoreScene>(BareCoreScene);
    expect(scene.runGetInvulnerabilityDuration()).toBe(
      PLAYER_RESPAWN_INVULNERABLE,
    );
  });

  it('AC3 — tryAbsorbPlayerHit and isPlayerPhased default to false', async () => {
    const scene = await boot<BareCoreScene>(BareCoreScene);
    const player = scene.addPlayer({ x: 1, y: 1 });
    expect(scene.runTryAbsorbPlayerHit(player)).toBe(false);
    expect(scene.runIsPlayerPhased()).toBe(false);
  });

  it('AC3 — the cue/collect/weapon hooks are no-ops by default', async () => {
    const scene = await boot<BareCoreScene>(BareCoreScene);
    const drop = new StubDrop(1, 1, scene.add.graphics(), 'P5');
    expect(() => scene.runOnWeaponFired('spread')).not.toThrow();
    expect(() => scene.runPlayPickupCue(drop)).not.toThrow();
    expect(() => scene.runOnPowerUpCollected(drop)).not.toThrow();
    expect(() => scene.runOnWeaponCollected(drop)).not.toThrow();
  });

  it('AC3 — getInvulnerabilityDuration is overridable by subclasses', () => {
    class ShortInvulnScene extends BareCoreScene {
      protected override getInvulnerabilityDuration(): number {
        return 0.8;
      }
    }
    const scene = new ShortInvulnScene();
    expect(scene.runGetInvulnerabilityDuration()).toBe(0.8);
  });
});
