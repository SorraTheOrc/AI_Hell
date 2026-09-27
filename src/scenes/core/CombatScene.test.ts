import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, BootedGame } from '../../test/gameHarness';
import { PLAYER_BULLET_SPEED, PLAYER_RESPAWN_INVULNERABLE } from '../../core/constants';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import {
  CombatDrop,
  CombatEnemyBullet,
  CombatEnemyEntity,
  CombatScene,
} from './CombatScene';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';

// These hook-contract tests exercise the fourDirectional input mapping; the
// app default is now Asteroids, so seed the scheme explicitly for the suite.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

/** Minimal enemy the shared core drives (mirrors the real entity contract). */
class StubEnemy extends Phaser.GameObjects.Container implements CombatEnemyEntity {
  alive = true;
  destroyed = false;
  damageCalls = 0;
  private readonly _hitRadius: number;

  constructor(scene: Phaser.Scene, x: number, y: number, hitRadius = 10) {
    super(scene, x, y);
    this._hitRadius = hitRadius;
  }

  destroySelf(): void {
    this.alive = false;
    this.destroyed = true;
  }

  getHitRadius(): number {
    return this._hitRadius;
  }
}

/** Multi-hit enemy (mirrors Boss) — `takeDamage()` instead of destruction. */
class ToughStubEnemy extends StubEnemy {
  takeDamage(): number | void {
    this.damageCalls += 1;
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
  ) {
    this.dropId = dropId;
    this.weaponDropId = weaponDropId;
    // Grow above the 3 % collection threshold so `tryCollect()` succeeds.
    this.powerUp = new PowerUp(dropId);
    this.powerUp.advance(0.5);
  }
}

/**
 * Lightweight stub subclass that pins the hook contract. Every hook is
 * overridden to record its dispatch, delegating to `super` where the
 * default behaviour itself is under test.
 */
class StubCombatScene extends CombatScene<StubEnemy, StubBullet, StubDrop> {
  entities: StubEnemy[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();

  hooks: string[] = [];
  teleportAllowed = true;
  phased = false;
  absorbHit = false;
  ramBoss = false;
  bossBulletConsumed = false;

  constructor() {
    super({ key: 'CombatSceneStub' });
  }

  create(): void {
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys('W,A,S,D') as never;
  }

  // ── Accessors ────────────────────────────────────────────────────
  protected getPlayer(): Player | null {
    return this.playerRef;
  }
  protected getEffectsRegistry(): EffectsRegistry {
    return this.effects;
  }
  protected getEnemyEntities(): readonly StubEnemy[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  // ── Hooks ────────────────────────────────────────────────────────
  protected override onWeaponFired(weaponId: string): void {
    this.hooks.push(`onWeaponFired:${weaponId}`);
  }
  protected override onPlayerBulletHitsEnemy(
    enemy: StubEnemy,
    bullet: PlayerBullet,
  ): boolean {
    this.hooks.push('onPlayerBulletHitsEnemy');
    return super.onPlayerBulletHitsEnemy(enemy, bullet);
  }
  protected override onPlayerBulletHitsBoss(bullet: PlayerBullet): boolean {
    this.hooks.push('onPlayerBulletHitsBoss');
    if (this.bossBulletConsumed) {
      bullet.destroy();
      return true;
    }
    return false;
  }
  protected override onEnemyDestroyed(enemy: StubEnemy): void {
    this.hooks.push(`onEnemyDestroyed:${enemy.destroyed}`);
  }
  protected override onPlayerRamsEnemy(enemy: StubEnemy): void {
    this.hooks.push('onPlayerRamsEnemy');
    super.onPlayerRamsEnemy(enemy);
  }
  protected override onPlayerRamsBoss(): boolean {
    this.hooks.push('onPlayerRamsBoss');
    return this.ramBoss;
  }
  protected override onBulletVsBulletImpact(
    enemyBullet: StubBullet,
    playerBullet: PlayerBullet,
  ): void {
    this.hooks.push('onBulletVsBulletImpact');
    if (this.useDefaultImpact) {
      super.onBulletVsBulletImpact(enemyBullet, playerBullet);
    }
  }
  useDefaultImpact = false;
  protected override onAfterBulletVsBullet(): void {
    this.hooks.push('onAfterBulletVsBullet');
  }
  protected override onPlayerHit(player: Player): void {
    this.hooks.push('onPlayerHit');
    super.onPlayerHit(player);
  }
  protected override tryAbsorbPlayerHit(): boolean {
    this.hooks.push('tryAbsorbPlayerHit');
    return this.absorbHit;
  }
  protected override onPowerUpCollected(drop: StubDrop): void {
    this.hooks.push(`onPowerUpCollected:${drop.dropId}`);
  }
  protected override onWeaponCollected(drop: StubDrop): void {
    this.hooks.push(`onWeaponCollected:${drop.weaponDropId}`);
  }
  protected override _playPickupCue(drop: StubDrop): void {
    this.hooks.push(`_playPickupCue:${drop.dropId}`);
  }
  protected override canTeleport(): boolean {
    return this.teleportAllowed;
  }
  protected override isPlayerPhased(): boolean {
    return this.phased;
  }
  protected override getEnemyBulletRadius(): number {
    return this.bulletRadius;
  }
  bulletRadius = 5;

  /** Overridable invulnerability window (AC4 hook coverage). */
  invulnDuration = PLAYER_RESPAWN_INVULNERABLE;
  protected override getInvulnerabilityDuration(): number {
    return this.invulnDuration;
  }

  // ── Public wrappers for the protected template methods ───────────
  runReadInput() {
    return this._readPlayerInput();
  }
  runAutoFire(dt: number) {
    this._autoFire(dt);
  }
  runCollectDrop(drop: StubDrop) {
    this._collectDrop(drop);
  }
  runSpawnExplosion(x: number, y: number) {
    this._spawnPlayerExplosion(x, y);
  }
  runClearEnemyBullets() {
    this._clearEnemyBullets();
  }
  runHandleTeleport() {
    this._handleTeleport();
  }
  runHitPlayer() {
    this._hitPlayer();
  }
  runCollisions() {
    this._handleCollisions();
  }
  runApplyPlayerHit(player: Player) {
    this.applyPlayerHit(player);
  }
  runUpdateInvulnerability(dt: number) {
    this._updateInvulnerability(dt);
  }
  getPlayerBullets() {
    return this.playerBullets;
  }
  getPlayerExplosions() {
    return this.playerExplosions;
  }
  getPlayerDeathEffects() {
    return this.playerDeathEffects;
  }
  getBulletImpactEffects() {
    return this.bulletImpactEffects;
  }
  getInvulnerable() {
    return this.invulnerable;
  }
  getPlayerHitCount() {
    return this.playerHitCount;
  }
  addPlayer(dropAt: { x: number; y: number }): Player {
    const player = new Player(this, { x: dropAt.x, y: dropAt.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  setTeleportKey(key: Phaser.Input.Keyboard.Key | null) {
    this.teleportKey = key;
  }
  addDrop(id: 'P5' | 'P4', weaponDropId?: string): StubDrop {
    const g = this.add.graphics();
    const drop = new StubDrop(120, 120, g, id, weaponDropId);
    return drop;
  }
}

describe('CombatScene — shared combat core hook contract', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<StubCombatScene> {
    booted = await bootScene([StubCombatScene]);
    return booted.scene as StubCombatScene;
  }

  // ── AC1 — contract surface ────────────────────────────────────────

  it('AC1 — is an abstract Phaser.Scene declaring the shared template methods', () => {
    const proto = StubCombatScene.prototype;
    for (const method of [
      '_handleCollisions',
      '_hitPlayer',
      '_autoFire',
      '_collectDrop',
      '_spawnPlayerExplosion',
      '_clearEnemyBullets',
      '_handleTeleport',
      '_readPlayerInput',
    ]) {
      expect(typeof (proto as unknown as Record<string, unknown>)[method]).toBe(
        'function',
      );
    }
    // The base itself is abstract and extends Phaser.Scene.
    expect(Object.getPrototypeOf(StubCombatScene)).toBe(CombatScene);
    expect(typeof CombatScene).toBe('function');
  });

  // ── AC3 — hook dispatch ───────────────────────────────────────────

  it('AC3 — _autoFire dispatches onWeaponFired once per firing weapon and spawns bullets per weapon', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    const activeWeapons = player.getActiveWeapons();

    scene.runAutoFire(10);

    const fired = scene.hooks.filter((h) => h.startsWith('onWeaponFired:'));
    expect(fired).toHaveLength(activeWeapons.length);
    expect(activeWeapons.length).toBeGreaterThan(0);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
    // Every bullet travels at the shared PLAYER_BULLET_SPEED.
    for (const bullet of scene.getPlayerBullets()) {
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        PLAYER_BULLET_SPEED,
        5,
      );
    }
  });

  it('AC3/AC4 — _autoFire is a no-op without a player', async () => {
    const scene = await boot();
    scene.runAutoFire(10);
    expect(scene.hooks).toEqual([]);
    expect(scene.getPlayerBullets()).toEqual([]);
  });

  it('AC3 — _readPlayerInput maps input through the player control scheme', async () => {
    const scene = await boot();
    expect(scene.runReadInput()).toBeNull();

    scene.addPlayer({ x: 100, y: 100 });
    const input = scene.runReadInput();
    expect(input).not.toBeNull();
    expect(input).toHaveProperty('up');
  });

  it('AC3 — _spawnPlayerExplosion registers the burst in playerExplosions', async () => {
    const scene = await boot();
    expect(scene.getPlayerExplosions()).toHaveLength(0);
    scene.runSpawnExplosion(10, 20);
    expect(scene.getPlayerExplosions().length).toBeGreaterThan(0);
  });

  it('AC3 — _collectDrop dispatches the weapon hook and starts the absorb', async () => {
    const scene = await boot();
    const drop = scene.addDrop('P5', 'spread');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:spread');
    expect(scene.hooks).toContain('_playPickupCue:P5');
    expect(drop.absorbing).toBe(true);
    expect(scene.effects.hasWeapon('spread')).toBe(true);
  });

  it('AC3 — _collectDrop dispatches the power-up hook', async () => {
    const scene = await boot();
    const drop = scene.addDrop('P5');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onPowerUpCollected:P5');
    expect(drop.absorbing).toBe(true);
  });

  it('AC2 — _collectDrop weapon reset clears the equipped weapon via the registry', async () => {
    const scene = await boot();
    scene.effects.applyWeapon('spread');
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    const drop = scene.addDrop('P5', 'reset');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:reset');
    expect(scene.effects.hasWeapon('spread')).toBe(false);
    expect(drop.absorbing).toBe(true);
  });

  it('AC3 — _collectDrop clears enemy bullets for a P4 bomb', async () => {
    const scene = await boot();
    scene.bullets.push(new StubBullet(scene, 1, 1), new StubBullet(scene, 2, 2));
    const drop = scene.addDrop('P4');

    scene.runCollectDrop(drop);

    expect(scene.bullets).toHaveLength(0);
    expect(scene.hooks).toContain('onPowerUpCollected:P4');
  });

  it('AC3 — _clearEnemyBullets destroys and empties the enemy bullets', async () => {
    const scene = await boot();
    const a = new StubBullet(scene, 1, 1);
    const b = new StubBullet(scene, 2, 2);
    scene.bullets.push(a, b);
    const destroyA = vi.spyOn(a.graphics, 'destroy');

    scene.runClearEnemyBullets();

    expect(destroyA).toHaveBeenCalled();
    expect(scene.bullets).toHaveLength(0);
  });

  it('AC3 — _hitPlayer dispatches tryAbsorbPlayerHit then onPlayerHit', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });

    scene.runHitPlayer();

    expect(scene.hooks).toContain('tryAbsorbPlayerHit');
    expect(scene.hooks).toContain('onPlayerHit');
    expect(scene.getPlayerHitCount()).toBe(1);
  });

  it('AC3/AC4 — _hitPlayer short-circuits onPlayerHit when the hit is absorbed', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    scene.absorbHit = true;

    scene.runHitPlayer();

    expect(scene.hooks).toContain('tryAbsorbPlayerHit');
    expect(scene.hooks).not.toContain('onPlayerHit');
  });

  it('AC4 — _hitPlayer is a no-op without a player', async () => {
    const scene = await boot();
    scene.runHitPlayer();
    expect(scene.hooks).toEqual([]);
    expect(scene.getPlayerHitCount()).toBe(0);
  });

  it('AC4 — applyPlayerHit runs the composed player-death juice and starts invulnerability', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 300, y: 300 });
    const soundSpy = vi.spyOn(effectsModule, 'playPlayerDestructionSound');
    const genericSpy = vi.spyOn(effectsModule, 'playDestructionSound');
    const shakeSpy = vi
      .spyOn(scene.cameras.main, 'shake')
      .mockImplementation(() => scene.cameras.main as never);

    scene.runApplyPlayerHit(player);

    expect(soundSpy).toHaveBeenCalledTimes(1);
    expect(genericSpy).not.toHaveBeenCalled();
    expect(shakeSpy).toHaveBeenCalledTimes(1);
    expect(scene.getPlayerDeathEffects().length).toBeGreaterThan(0);
    expect(scene.getInvulnerable()).toBeGreaterThan(0);
  });

  it('AC2 — the shared invulnerability window is PLAYER_RESPAWN_INVULNERABLE and expires cleanly', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 300, y: 300 });

    scene.runApplyPlayerHit(player);
    expect(scene.getInvulnerable()).toBe(PLAYER_RESPAWN_INVULNERABLE);

    // Count down the full window: invulnerability reaches 0 and the ship's
    // alpha is restored to fully opaque.
    scene.runUpdateInvulnerability(PLAYER_RESPAWN_INVULNERABLE + 0.01);
    expect(scene.getInvulnerable()).toBe(0);
    expect(player.alpha).toBe(1);
  });

  it('AC4 — _startInvulnerability uses the overridable getInvulnerabilityDuration hook', async () => {
    const scene = await boot();
    scene.invulnDuration = 0.8;
    const player = scene.addPlayer({ x: 300, y: 300 });

    scene.runApplyPlayerHit(player);

    // The hook is what supplies the window (inherited default is 1.5 s).
    expect(scene.getInvulnerable()).toBe(0.8);
  });

  // ── Teleport ──────────────────────────────────────────────────────

  it('AC3 — triggerTeleport consumes a stack and warps the player', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('P7');
    expect(scene.effects.hasTeleport()).toBe(true);

    const moved = scene.triggerTeleport();

    expect(moved).toBe(true);
    expect(scene.effects.hasTeleport()).toBe(false);
    expect(player.x !== 100 || player.y !== 100).toBe(true);
  });

  it('AC3/AC4 — triggerTeleport is blocked by canTeleport() and absent player/stack', async () => {
    const scene = await boot();
    // No player.
    expect(scene.triggerTeleport()).toBe(false);

    scene.addPlayer({ x: 100, y: 100 });
    // No teleport stack.
    expect(scene.triggerTeleport()).toBe(false);

    scene.effects.applyCollect('P7');
    scene.teleportAllowed = false;
    expect(scene.triggerTeleport()).toBe(false);
    expect(scene.effects.hasTeleport()).toBe(true);
  });

  it('AC3 — _handleTeleport triggers on a held teleport key', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('P7');
    const key = scene.input.keyboard!.addKey('S');
    (key as unknown as { _justDown: boolean })._justDown = true;
    scene.setTeleportKey(key);

    scene.runHandleTeleport();

    expect(scene.effects.hasTeleport()).toBe(false);
  });

  // ── AC5 — shared bullet-vs-bullet impact path ────────────────────

  it('AC5 — bullet-vs-bullet interception destroys both and fires the impact hook', async () => {
    const scene = await boot();
    const pb = scene.spawnPlayerBullet(50, 50, 0, 0);
    const eb = new StubBullet(scene, 50, 50);
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(pb.active).toBe(false);
    expect(scene.getPlayerBullets()).toHaveLength(0);
    expect(scene.bullets).toHaveLength(0);
    expect(scene.hooks).toContain('onBulletVsBulletImpact');
    expect(scene.hooks).toContain('onAfterBulletVsBullet');
  });

  it('AC5 — the default impact hook plays the dedicated cue and spawns the flash', async () => {
    const scene = await boot();
    scene.useDefaultImpact = true;
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    scene.spawnPlayerBullet(50, 50, 0, 0);
    scene.bullets.push(new StubBullet(scene, 50, 50));

    scene.runCollisions();

    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  // ── Collision bookkeeping ─────────────────────────────────────────

  it('AC4 — player bullet vs enemy consumes the bullet and destroys one enemy', async () => {
    const scene = await boot();
    const enemy = new StubEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerBulletHitsEnemy');
    expect(scene.hooks).toContain('onEnemyDestroyed:true');
    expect(enemy.destroyed).toBe(true);
    expect(pb.active).toBe(false);
    expect(scene.getPlayerBullets()).toHaveLength(0);
  });

  it('AC4 — multi-hit enemies take damage instead of being destroyed', async () => {
    const scene = await boot();
    const enemy = new ToughStubEnemy(scene, 40, 40);
    scene.entities.push(enemy);
    scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    expect(enemy.damageCalls).toBe(1);
    expect(enemy.destroyed).toBe(false);
  });

  it('AC4 — no boss means the boss hooks are consulted but never consume', async () => {
    const scene = await boot();
    // No enemies and no boss: the bullet survives the enemy/boss scans.
    const pb = scene.spawnPlayerBullet(50, 50, 0, 0);
    scene.runCollisions();
    expect(scene.hooks).toContain('onPlayerBulletHitsBoss');
    expect(scene.getPlayerBullets()).toContain(pb);
  });

  it('AC4 — boss hook consumes the bullet and a boss ram costs a hit', async () => {
    const scene = await boot();
    scene.bossBulletConsumed = true;
    scene.ramBoss = true;
    const player = scene.addPlayer({ x: 60, y: 60 });
    const pb = scene.spawnPlayerBullet(60, 60, 0, 0);

    scene.runCollisions();

    expect(scene.getPlayerBullets()).not.toContain(pb);
    expect(pb.active).toBe(false);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(player).toBeDefined();
  });

  it('AC4 — enemy bullet vs player hits the player and consumes the bullet', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 70, y: 70 });
    const eb = new StubBullet(scene, 70, 70);
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.bullets).toHaveLength(0);
    expect(scene.hooks).toContain('onPlayerHit');
  });

  it('AC4/AC5 — an enemy bullet hitting the player plays only the player-hit feedback, never the bullet-destruction SFX/VFX', async () => {
    const scene = await boot();
    // Keep the real default impact path active so any stray bullet-vs-bullet
    // feedback would be observable instead of masked by the stub hook.
    scene.useDefaultImpact = true;
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    // Spies on the shared audio module persist across tests in this suite;
    // clear the count so this test observes only its own collisions.
    cue.mockClear();
    scene.addPlayer({ x: 70, y: 70 });
    scene.bullets.push(new StubBullet(scene, 70, 70));

    scene.runCollisions();

    // The existing player-hit feedback fires exactly once...
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.hooks).toContain('onPlayerHit');
    // ...and the bullet-destruction cue/flash is NOT also played at the point.
    expect(scene.hooks).not.toContain('onBulletVsBulletImpact');
    expect(cue).not.toHaveBeenCalled();
    expect(scene.getBulletImpactEffects()).toHaveLength(0);
  });

  it('AC4 — player body ram destroys the enemy and hits the player', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 80, y: 80 });
    const enemy = new StubEnemy(scene, player.x, player.y);
    scene.entities.push(enemy);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerRamsEnemy');
    expect(enemy.destroyed).toBe(true);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.hooks).toContain('onPlayerHit');
  });

  it('AC4 — a phased player skips the enemy-bullet/ram collision passes', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 90, y: 90 });
    scene.phased = true;
    scene.bullets.push(new StubBullet(scene, 90, 90));

    scene.runCollisions();

    expect(scene.getPlayerHitCount()).toBe(0);
    // Phased players are immune — the enemy bullet survives this pass.
    expect(scene.bullets).toHaveLength(1);
  });

  it('AC4 — invulnerable players are not hit again', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 95, y: 95 });
    // First hit starts invulnerability.
    scene.runApplyPlayerHit(scene.playerRef!);
    const before = scene.getPlayerHitCount();
    scene.bullets.push(new StubBullet(scene, 95, 95));

    scene.runCollisions();

    expect(scene.getPlayerHitCount()).toBe(before);
    expect(scene.bullets).toHaveLength(1);
  });
});
