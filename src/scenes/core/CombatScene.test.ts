import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, BootedGame } from '../../test/gameHarness';
import { PLAYER_BULLET_SPEED, PLAYER_RESPAWN_INVULNERABLE } from '../../core/constants';
import { Player } from '../../entities/Player';
import { advanceAndCull, type PlayerBullet } from '../../entities/PlayerBullet';
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
import { isOnGrid } from '../../utils/beat';
import {
  WEAPON_BULLET_LIFETIME,
  WEAPON_CATALOGUE,
  type WeaponId,
} from '../../utils/weapons';

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

/** Multi-hit enemy (mirrors the Harvester) — `takeDamage()` instead of destruction. */
class ToughStubEnemy extends StubEnemy {
  private _health: number;
  destructionAudioCalls = 0;

  constructor(scene: Phaser.Scene, x: number, y: number, hitRadius = 10, health = 3) {
    super(scene, x, y, hitRadius);
    this._health = health;
  }

  takeDamage(): number {
    if (!this.alive) return 0;
    this.damageCalls += 1;
    this._health -= 1;
    if (this._health <= 0) {
      this._health = 0;
      this.destroySelf();
    }
    return this._health;
  }

  get health(): number {
    return this._health;
  }
}

/** Multi-hit enemy that also supplies the entity-specific destruction audio. */
class AudibleToughStubEnemy extends ToughStubEnemy {
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

/** Minimal drop satisfying the shared collect contract. */
class StubDrop implements CombatDrop {
  readonly powerUp: PowerUp;
  readonly dropId: 'speed_boost' | 'bomb';
  weaponDropId?: string;
  absorbing?: boolean;

  constructor(
    public x: number,
    public y: number,
    public readonly graphics: Phaser.GameObjects.Graphics,
    dropId: 'speed_boost' | 'bomb',
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
  runUpdateP4Bomb(dt: number) {
    this._updateP4Bomb(dt);
  }
  runUpdateAutoDefence(dt: number) {
    this._updateAutoDefence(dt);
  }
  runHitPlayer() {
    this._hitPlayer();
  }
  runCollisions() {
    this._handleCollisions();
  }
  runFlushSplits() {
    this.flushPendingSplitWarheads();
  }
  runSplitProjectile(bullet: PlayerBullet) {
    this.splitProjectile(bullet);
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
  addDrop(id: 'speed_boost' | 'bomb', weaponDropId?: string): StubDrop {
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
      '_updateAutoDefence',
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
    const drop = scene.addDrop('speed_boost', 'spread');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:spread');
    expect(scene.hooks).toContain('_playPickupCue:speed_boost');
    expect(drop.absorbing).toBe(true);
    expect(scene.effects.hasWeapon('spread')).toBe(true);
  });

  it('AC3 — _collectDrop dispatches the power-up hook', async () => {
    const scene = await boot();
    const drop = scene.addDrop('speed_boost');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onPowerUpCollected:speed_boost');
    expect(drop.absorbing).toBe(true);
  });

  it('AC2 — _collectDrop weapon reset preserves previously equipped weapons', async () => {
    const scene = await boot();
    scene.effects.applyWeapon('spread');
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    const drop = scene.addDrop('speed_boost', 'reset');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:reset');
    // Reset drop no longer clears weapons — spread is preserved.
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    expect(drop.absorbing).toBe(true);
  });

  it('AC3 — _collectDrop queues a P4 pulse; the shared bomb step clears in range', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 120, y: 120 });
    const inside = new StubBullet(scene, 130, 120);
    const outside = new StubBullet(scene, 900, 900);
    scene.bullets.push(inside, outside);
    const drop = scene.addDrop('bomb');

    scene.runCollectDrop(drop);
    // Collection queues the pulse but does not clear anything itself.
    expect(scene.bullets).toHaveLength(2);
    expect(scene.hooks).toContain('onPowerUpCollected:bomb');

    scene.runUpdateP4Bomb(0.016);
    expect(scene.bullets).toEqual([outside]);
    expect(inside.graphics.active).toBe(false);
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
    scene.effects.applyCollect('teleport');
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

    scene.effects.applyCollect('teleport');
    scene.teleportAllowed = false;
    expect(scene.triggerTeleport()).toBe(false);
    expect(scene.effects.hasTeleport()).toBe(true);
  });

  it('AC1/AC3 — automatic defence warps on danger with no key press when Teleport is chosen', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('teleport');
    // Three hostile bodies within DANGER_RADIUS (40 px) → in danger.
    for (let i = 0; i < 3; i += 1) {
      scene.entities.push(new StubEnemy(scene, 110 + i * 5, 100));
    }

    scene.runUpdateAutoDefence(0.016);

    expect(scene.effects.hasTeleport()).toBe(false);
    expect(scene.effects.isPhased).toBe(true);
    expect(Math.hypot(player.x - 100, player.y - 100)).toBeGreaterThan(0);
  });

  it('AC1 — automatic defence does nothing below the danger threshold', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('teleport');
    // Only two threats → below DANGER_THREAT_THRESHOLD (3).
    for (let i = 0; i < 2; i += 1) {
      scene.entities.push(new StubEnemy(scene, 110 + i * 5, 100));
    }

    scene.runUpdateAutoDefence(0.016);

    expect(scene.effects.hasTeleport()).toBe(true);
    expect(scene.effects.isPhased).toBe(false);
  });

  it('AC1 — automatic defence auto-triggers Phase Shift when only phase charges are held', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('phase_shift');
    for (let i = 0; i < 3; i += 1) {
      scene.entities.push(new StubEnemy(scene, 110 + i * 5, 100));
    }

    scene.runUpdateAutoDefence(0.016);

    expect(scene.effects.isPhased).toBe(true);
    expect(scene.effects.phaseCharges()).toBe(0);
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

  it('F2 — a non-lethal multi-hit hit consumes the bullet with no destruction side effects', async () => {
    const scene = await boot();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    expect(enemy.alive).toBe(true);
    expect(enemy.health).toBe(2);
    expect(pb.active).toBe(false);
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');
    expect(destroySound).not.toHaveBeenCalled();
  });

  it('producer fix — a non-lethal multi-hit hit spawns the shared bullet-impact flash', async () => {
    const scene = await boot();
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    // The hit registered (exactly one flash) while the enemy survived and
    // no destruction finalisation ran.
    expect(pb.active).toBe(false);
    expect(enemy.alive).toBe(true);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');
  });

  it('producer fix — the lethal blow finalises without a stray impact flash', async () => {
    const scene = await boot();
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 1);
    scene.entities.push(enemy);
    scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    // The kill already carries its own explosion feedback — no extra flash.
    expect(enemy.alive).toBe(false);
    expect(scene.getBulletImpactEffects()).toHaveLength(0);
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
  });

  it('F2 — the killing blow finalises exactly once (destruction audio + onEnemyDestroyed)', async () => {
    const scene = await boot();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 2);
    scene.entities.push(enemy);

    // First hit: non-lethal — no finalisation yet.
    scene.spawnPlayerBullet(40, 40, 0, 0);
    scene.runCollisions();
    expect(enemy.alive).toBe(true);
    expect(destroySound).not.toHaveBeenCalled();
    expect(scene.hooks).not.toContain('onEnemyDestroyed:true');

    // Second hit: lethal — exactly one finalisation.
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    scene.runCollisions();
    expect(enemy.alive).toBe(false);
    expect(pb.active).toBe(false);
    expect(destroySound).toHaveBeenCalledTimes(1);
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
  });

  it('F2 — a multi-hit enemy with its own destruction audio plays it once and skips the shared sound', async () => {
    const scene = await boot();
    const destroySound = vi.spyOn(effectsModule, 'playDestructionSound');
    const enemy = new AudibleToughStubEnemy(scene, 40, 40, 10, 1);
    scene.entities.push(enemy);
    scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    expect(enemy.alive).toBe(false);
    expect(enemy.destructionAudioCalls).toBe(1);
    expect(destroySound).not.toHaveBeenCalled();
    expect(scene.hooks.filter((h) => h === 'onEnemyDestroyed:true')).toHaveLength(1);
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

// ── AH-0MUAYB8EH005RJ8B: real bullet spawns land on grid ticks ──────

describe('CombatScene — beat-grid bullet spawns (AH-0MUAYB8EH005RJ8B)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
  });

  const COLOR_TO_WEAPON = new Map<number, WeaponId>(
    (Object.keys(WEAPON_CATALOGUE) as WeaponId[]).map((id) => [
      WEAPON_CATALOGUE[id].bulletColor,
      id,
    ]),
  );

  /**
   * Boots a fresh scene, activates several weapons, then records the exact
   * beat-grid tick of every **real** bullet spawned while stepping the
   * supplied frame deltas. Returns the recorded ticks per weapon.
   *
   * The grid is reset to a deterministic t=0 anchor and shared with the
   * player, so the recorded ticks are independent of boot timing.
   */
  async function collectSpawnTicks(
    frameDeltasMs: number[],
  ): Promise<Record<WeaponId, number[]>> {
    booted = await bootScene([StubCombatScene]);
    const scene = booted.scene as StubCombatScene;
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('spread');
    player.equipWeapon('rapid');

    scene.getBeatClock().reset();
    player.setBeatClock(scene.getBeatClock());

    const ticks: Record<WeaponId, number[]> = {
      cannon: [],
      spread: [],
      dual: [],
      rapid: [],
      wave_laser: [],
      ricochet: [],
      cluster: [],
      nova: [],
      mortar: [],
      arc: [],
    };
    const original = scene.spawnPlayerBullet.bind(scene);
    vi.spyOn(scene, 'spawnPlayerBullet').mockImplementation(
      (x, y, vx, vy, color, lifetime) => {
        const weapon = COLOR_TO_WEAPON.get(color ?? 0);
        // Attribute the real spawn to the grid tick the weapon fired on.
        if (weapon) ticks[weapon].push(player.getLastShotTime(weapon)!);
        return original(x, y, vx, vy, color, lifetime);
      },
    );

    for (const dtMs of frameDeltasMs) {
      scene.runAutoFire(dtMs / 1000);
    }

    vi.restoreAllMocks();
    booted.game.destroy(true);
    booted = null;
    return ticks;
  }

  it('AC1/AC4 — every spawned bullet lands on its weapon grid tick; active weapons share the phase', async () => {
    const ticks = await collectSpawnTicks(
      Array.from({ length: 300 }, () => 10),
    );

    for (const weapon of ['cannon', 'spread', 'rapid'] as WeaponId[]) {
      const interval = WEAPON_CATALOGUE[weapon].fireRateMs;
      expect(ticks[weapon].length).toBeGreaterThan(0);
      for (const tick of ticks[weapon]) {
        expect(isOnGrid(tick, interval, 0)).toBe(true);
        expect(tick % interval).toBe(0); // exact tick, anchored at 0
      }
      // All default intervals are multiples of the finest (125 ms) grid, so
      // simultaneously active weapons stay phase-locked.
      for (const tick of ticks[weapon]) expect(tick % 125).toBe(0);
    }
  });

  it('AC3 — the spawned-bullet grid is framerate-independent', async () => {
    const at10ms = await collectSpawnTicks(
      Array.from({ length: 300 }, () => 10), // 3000 ms at 10 ms/frame
    );
    const at25ms = await collectSpawnTicks(
      Array.from({ length: 120 }, () => 25), // 3000 ms at 25 ms/frame
    );

    for (const weapon of ['cannon', 'spread', 'rapid'] as WeaponId[]) {
      expect(at10ms[weapon].length).toBeGreaterThan(0);
      expect(at10ms[weapon]).toEqual(at25ms[weapon]);
    }
  });
});

// ── R-Type wave-laser piercing budget (AH-0MV1BIUSJ0090W92) ──────────

describe('piercing player bullets — pass-through budget (AH-0MV1BIUSJ0090W92)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<StubCombatScene> {
    booted = await bootScene([StubCombatScene]);
    return booted.scene as StubCombatScene;
  }

  /** Adds a single-hit stub enemy at (x, y) and returns it. */
  function addEnemy(scene: StubCombatScene, x: number, y: number): StubEnemy {
    const enemy = new StubEnemy(scene, x, y);
    scene.add.existing(enemy);
    scene.entities.push(enemy);
    return enemy;
  }

  it('an ordinary bullet (piercing 0) damages one enemy and is consumed', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const first = addEnemy(scene, 200, 200);
    const second = addEnemy(scene, 240, 200);

    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 0);
    scene.runCollisions();

    expect(first.destroyed).toBe(true);
    expect(second.destroyed).toBe(false);
    expect(scene.getPlayerBullets()).not.toContain(bullet);
  });

  it('a piercing bullet damages its budget of enemies and survives each of them', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const first = addEnemy(scene, 200, 200);
    const second = addEnemy(scene, 260, 200);
    const third = addEnemy(scene, 320, 200);

    // Budget 2: survive the first two, consume on the third.
    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 2);

    scene.runCollisions(); // first
    expect(first.destroyed).toBe(true);
    expect(bullet.piercing).toBe(1);
    expect(scene.getPlayerBullets()).toContain(bullet);

    bullet.setPosition(260, 200);
    scene.runCollisions(); // second
    expect(second.destroyed).toBe(true);
    expect(bullet.piercing).toBe(0);
    expect(scene.getPlayerBullets()).toContain(bullet);

    bullet.setPosition(320, 200);
    scene.runCollisions(); // third — budget exhausted, bullet consumed
    expect(third.destroyed).toBe(true);
    expect(scene.getPlayerBullets()).not.toContain(bullet);
  });

  it('an enemy already passed through is never damaged twice', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const tough = new ToughStubEnemy(scene, 200, 200, 10, 5);
    scene.add.existing(tough);
    scene.entities.push(tough);

    scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 3);
    scene.runCollisions();
    scene.runCollisions();
    scene.runCollisions();

    expect(tough.damageCalls).toBe(1);
    expect(tough.alive).toBe(true);
  });

  it('the budget boundary: a bullet with piercing 1 stops on its second enemy', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const first = addEnemy(scene, 200, 200);
    const second = addEnemy(scene, 260, 200);
    const third = addEnemy(scene, 320, 200);
    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 1);

    scene.runCollisions();
    expect(first.destroyed).toBe(true);
    expect(bullet.piercing).toBe(0);
    expect(scene.getPlayerBullets()).toContain(bullet); // survived the first

    bullet.setPosition(260, 200);
    scene.runCollisions();
    expect(second.destroyed).toBe(true);
    expect(third.destroyed).toBe(false);
    expect(scene.getPlayerBullets()).not.toContain(bullet); // consumed on the second
  });

  it('auto-fire propagates the weapon piercing budget onto spawned bullets', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    // Equip the wave laser permanently so it fires this frame.
    player.equipWeapon('wave_laser', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    // Establish a heading (right) without moving the ship far.
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    const waveBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === WEAPON_CATALOGUE.wave_laser.bulletColor);
    expect(waveBullets.length).toBeGreaterThan(0);
    for (const bullet of waveBullets) {
      expect(bullet.piercing).toBe(WEAPON_CATALOGUE.wave_laser.piercing);
    }
  });
});

// ── Centipede ricochet wall-bounce budget (AH-0MV1BIV5L005NJAI) ──────

describe('ricochet player bullets — wall-bounce budget (AH-0MV1BIV5L005NJAI)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<StubCombatScene> {
    booted = await bootScene([StubCombatScene]);
    return booted.scene as StubCombatScene;
  }

  it('auto-fire propagates the weapon bounce budget onto spawned bullets', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    // Equip the ricochet permanently so it fires this frame.
    player.equipWeapon('ricochet', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    const ricochetBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === WEAPON_CATALOGUE.ricochet.bulletColor);
    expect(ricochetBullets.length).toBeGreaterThan(0);
    for (const bullet of ricochetBullets) {
      expect(bullet.bounces).toBe(WEAPON_CATALOGUE.ricochet.bounce);
    }
  });

  it('an ordinary weapon leaves the bounce budget undefined on spawned bullets', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('spread', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    for (const bullet of scene.getPlayerBullets()) {
      expect(bullet.bounces).toBeUndefined();
    }
  });
});

// ── Missile Command cluster/MIRV split seam (AH-0MV1BIVIJ007KYXU) ────

describe('cluster-missile split seam (AH-0MV1BIVIJ007KYXU)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<StubCombatScene> {
    booted = await bootScene([StubCombatScene]);
    return booted.scene as StubCombatScene;
  }

  function addEnemy(scene: StubCombatScene, x: number, y: number): StubEnemy {
    const enemy = new StubEnemy(scene, x, y);
    scene.add.existing(enemy);
    scene.entities.push(enemy);
    return enemy;
  }

  /** Spawns a base cluster missile (tagged but not yet split). */
  function spawnCluster(scene: StubCombatScene, x: number, y: number): PlayerBullet {
    const bullet = scene.spawnPlayerBullet(
      x,
      y,
      PLAYER_BULLET_SPEED,
      0,
      WEAPON_CATALOGUE.cluster.bulletColor,
      1,
      3,
    );
    bullet.splitWeapon = WEAPON_CATALOGUE.cluster;
    return bullet;
  }

  it('auto-fire tags a cluster missile with its split definition and leaves ordinary weapons untagged', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('cluster', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(2);
    const clusterBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === WEAPON_CATALOGUE.cluster.bulletColor);
    expect(clusterBullets.length).toBeGreaterThan(0);
    for (const bullet of clusterBullets) {
      expect(bullet.splitWeapon?.id).toBe('cluster');
      expect(bullet.splitSpawned).toBe(false);
    }
    for (const bullet of scene
      .getPlayerBullets()
      .filter((b) => b.color === WEAPON_CATALOGUE.cannon.bulletColor)) {
      expect(bullet.splitWeapon).toBeUndefined();
    }
  });

  it('splits into exactly its configured warhead count once on impact', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    addEnemy(scene, 200, 200);
    const bullet = spawnCluster(scene, 200, 200);

    scene.runCollisions();
    expect(bullet.splitSpawned).toBe(true);
    // The parent shell is consumed; the warheads are queued, not yet live.
    expect(scene.getPlayerBullets()).not.toContain(bullet);
    scene.runFlushSplits();
    expect(scene.getPlayerBullets()).toHaveLength(
      WEAPON_CATALOGUE.cluster.splits!,
    );

    // Splitting again is a no-op — the split resolves exactly once.
    scene.runSplitProjectile(bullet);
    expect(scene.getPlayerBullets()).toHaveLength(
      WEAPON_CATALOGUE.cluster.splits!,
    );
  });

  it('each split warhead damages enemies on contact through the shared collision path', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const victim = addEnemy(scene, 200, 200);
    spawnCluster(scene, 200, 200);

    scene.runCollisions(); // splits; the parent shell deals no direct hit
    expect(victim.destroyed).toBe(false);
    scene.runFlushSplits();
    scene.runCollisions(); // a warhead damages the enemy on contact
    expect(victim.destroyed).toBe(true);
  });

  it('splits on lifetime expiry through the shared advance/cull path', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('cluster', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);
    scene.runAutoFire(2);

    const missile = scene
      .getPlayerBullets()
      .find((b) => b.color === WEAPON_CATALOGUE.cluster.bulletColor);
    expect(missile).toBeDefined();
    const expected = player.getWeaponDef('cluster').splits ?? 0;
    expect(expected).toBeGreaterThan(0);

    expect(
      advanceAndCull(missile!, WEAPON_BULLET_LIFETIME.cluster + 0.01),
    ).toBe(false);
    expect(missile!.splitSpawned).toBe(true);

    scene.runFlushSplits();
    const warheads = scene
      .getPlayerBullets()
      .filter(
        (b) =>
          b.color === WEAPON_CATALOGUE.cluster.bulletColor &&
          b.splitWeapon === undefined,
      );
    expect(warheads).toHaveLength(expected);
  });

  it('an ordinary weapon never splits and damages its target directly', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const enemy = addEnemy(scene, 200, 200);
    const bullet = scene.spawnPlayerBullet(
      200,
      200,
      PLAYER_BULLET_SPEED,
      0,
      WEAPON_CATALOGUE.cannon.bulletColor,
      1,
      3,
    );
    expect(bullet.splitWeapon).toBeUndefined();

    scene.runCollisions();
    expect(enemy.destroyed).toBe(true);
    scene.runFlushSplits();
    expect(scene.getPlayerBullets()).toHaveLength(0);
  });
});
