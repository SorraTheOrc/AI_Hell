import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import * as bulletImpactModule from '../../vfx/bulletImpact';
import * as muzzleFlashModule from '../../vfx/muzzleFlash';
import { advanceGame, bootScene, BootedGame } from '../../test/gameHarness';
import {
  FORCE_FIELD_COLOR,
  PLAYER_BULLET_SPEED,
  PLAYER_RESPAWN_INVULNERABLE,
} from '../../core/constants';
import { Player } from '../../entities/Player';
import { PlayerBullet, advanceAndCull } from '../../entities/PlayerBullet';
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
  BULLET_COLORS,
  OPTIONS_MAX_PODS,
  OPTIONS_ORBIT_RADIUS,
  OPTIONS_POD_BULLET_SPEED,
  type WeaponId,
} from '../../utils/weapons';
import { resolveWeaponDefinition } from '../../utils/weaponLevels';

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

/**
 * The colour of the LAST FILL_STYLE(7) in a Graphics command buffer. The
 * constructor seeds default zero-styles first, so a spawn's own fill is the
 * final one — layout `[7, color, alpha]` per Phaser's Commands.js. Walks the
 * buffer by command width so an ARC radius (also 7) is never mistaken for an
 * opcode.
 */
function lastFillColor(buf: number[]): number {
  // Command widths per Phaser Commands.js (opcode, then N args).
  const WIDTHS: Record<number, number> = {
    0: 8, // ARC
    1: 1, // BEGIN_PATH
    2: 1, // CLOSE_PATH
    3: 5, // FILL_RECT
    4: 3, // LINE_TO
    5: 3, // MOVE_TO
    6: 4, // LINE_STYLE
    7: 3, // FILL_STYLE
    8: 1, // FILL_PATH
    9: 1, // STROKE_PATH
    10: 7, // FILL_TRIANGLE
  };
  let color = -1;
  for (let i = 0; i < buf.length; ) {
    const op = buf[i];
    if (op === 7) color = buf[i + 1];
    i += WIDTHS[op] ?? 1;
  }
  return color;
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
  getFireFxEffects() {
    return this.fireFxEffects;
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

  it('AC5 — an identity-carrying enemy bullet tints its interception flash (AH-0MV822CQL005R4MM)', async () => {
    const scene = await boot();
    scene.useDefaultImpact = true;
    scene.spawnPlayerBullet(50, 50, 0, 0);
    const eb = new StubBullet(scene, 50, 50);
    // Scout shots carry their shot colour on the wrapper (the bullet-shape
    // seam hands `{ graphics, color }` to every scene's wrapper).
    (eb as unknown as { color?: number }).color = 0xff4444;
    scene.bullets.push(eb);

    scene.runCollisions();

    // The shared interception path still plays the existing per-enemy
    // destruction cue, but the impact flash now takes the shot's own
    // colour — a distinct Scout hit read, identical in game and gyms.
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    // FILL_STYLE(7) carries [color, alpha]; the flash's own fill is the LAST
    // FILL_STYLE in its buffer (the Graphics constructor seeds default
    // zero-styles before the flash draws).
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xff4444);
  });

  it('a scout bullet plays its identity impact pop and flash when it hits the player (AH-0MV822CQL005R4MM)', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0xff4444;
    scene.bullets.push(eb);

    scene.runCollisions();

    // The bullet lands: the shared hit lifecycle runs AND the identity
    // impact pop (existing per-enemy cue + tinted flash) plays through the
    // shared enemy-bullet-vs-player pass.
    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xff4444);
  });

  it('a Tank shell plays its identity impact pop and flash when it hits the player (AH-0MV822DF60001EPA)', async () => {
    // The Tank's heavy shell carries its amber bullet colour; the shared
    // impact pass (added by the Scout identity, AH-0MV822CQL005R4MM) tints
    // the impact flash and pops the existing per-enemy destruction cue — so
    // a Tank hit reads (and sounds) distinct from a Scout hit, identically
    // in the game and every gym. This test pins the amber Tank variant of
    // the generic path with the real TANK_BULLET_COLOR.
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0xffaa00; // TANK_BULLET_COLOR
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xffaa00);
  });

  it('a Diver shard plays its identity impact pop and flash when it hits the player (AH-0MV822D2U000LRFV)', async () => {
    // The Diver's shard carries its pale-yellow bullet colour; the shared
    // impact pass (added by the Scout identity, AH-0MV822CQL005R4MM) tints
    // the impact flash and pops the existing per-enemy destruction cue — so
    // a Diver hit reads (and sounds) distinct from a Scout or Tank hit,
    // identically in the game and every gym. This test pins the pale-yellow
    // Diver variant of the generic path with the real DIVER_BULLET_COLOR.
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0xffee88; // DIVER_BULLET_COLOR
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xffee88);
  });

  it('a Phaser bolt plays its identity impact pop and flash when it hits the player (AH-0MV822DRX009RYUB)', async () => {
    // The Phaser's bolt carries its lethal-red bullet colour; the shared
    // impact pass (added by the Scout identity, AH-0MV822CQL005R4MM) tints
    // the impact flash and pops the existing per-enemy destruction cue — so
    // a Phaser hit reads (and sounds) distinct from a Scout, Tank or Diver
    // hit, identically in the game and every gym. This test pins the red
    // Phaser variant of the generic path with the real PHASER_BULLET_COLOR.
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0xff4444; // PHASER_BULLET_COLOR
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xff4444);
  });

  it('a Swarm fleck plays its identity impact pop and flash when it hits the player (AH-0MV822E4T006F37Y)', async () => {
    // The Swarm's fleck carries its cyan bullet colour; the shared impact
    // pass (added by the Scout identity, AH-0MV822CQL005R4MM) tints the
    // impact flash and pops the existing per-enemy destruction cue — so a
    // Swarm hit reads (and sounds) distinct from every other identity,
    // identically in the game and every gym. This test pins the cyan Swarm
    // variant of the generic path with the real SWARM_BULLET_COLOR.
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0x00ccff; // SWARM_BULLET_COLOR
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0x00ccff);
  });

  it('a Raider dart plays its identity impact pop and flash when it hits the player (AH-0MV822EH800780GI)', async () => {
    // The Raider's dart carries its pale-amber bullet colour; the shared
    // impact pass (added by the Scout identity, AH-0MV822CQL005R4MM) tints
    // the impact flash and pops the existing per-enemy destruction cue — so
    // a Raider hit reads (and sounds) distinct from the Scout pellet whose
    // shared aimed-shot path it reuses, identically in the game and every
    // gym. This test pins the pale-amber Raider variant of the generic path
    // with the real RAIDER_BULLET_COLOR.
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0xffddaa; // RAIDER_BULLET_COLOR
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xffddaa);
  });

  it('a Boss spread pellet plays its identity impact pop and flash when it hits the player (AH-0MV822ETD008LLZX)', async () => {
    // The Boss spread pellet carries the white Boss bullet colour; the shared
    // impact pass (added by the Scout identity, AH-0MV822CQL005R4MM) tints
    // the impact flash and pops the existing per-enemy destruction cue — so
    // a Boss hit reads (and sounds) distinct from every other identity,
    // identically in the game and every gym. This test pins the white Boss
    // variant of the generic path with the real BOSS_BULLET_COLOR.
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    const eb = new StubBullet(scene, 100, 100);
    (eb as unknown as { color?: number }).color = 0xffffff; // BOSS_BULLET_COLOR
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).toHaveBeenCalledTimes(1);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(0xffffff);
  });

  it('legacy enemy bullets without an identity keep the plain hit behaviour (no added flash)', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playBulletDestructionSound');
    scene.bullets.push(new StubBullet(scene, 100, 100));

    scene.runCollisions();

    expect(scene.hooks).toContain('onPlayerHit');
    expect(cue).not.toHaveBeenCalled();
    expect(scene.getBulletImpactEffects()).toHaveLength(0);
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

  // ── Per-weapon impact feedback (AH-0MV8228YW0050IXS) ────────────

  it('AC4 — a cannon shot plays its baked hit cue and distinct impact flash on connect', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = {
      color: 0x00ffff,
      radius: 9,
      duration: 0.16,
      cue: 'playCannonImpactSound',
    };

    scene.runCollisions();

    expect(cue).toHaveBeenCalledTimes(1);
    expect(cue).toHaveBeenCalledWith('playCannonImpactSound');
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  it('AC4 — the cannon hit cue layer plays on the killing blow too', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 1);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = {
      color: 0x00ffff,
      radius: 9,
      duration: 0.16,
      cue: 'playCannonImpactSound',
    };

    scene.runCollisions();

    expect(enemy.alive).toBe(false);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  it('AC4 — a bullet without impactFx metadata keeps the generic hit behaviour (no hit cue)', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    scene.spawnPlayerBullet(40, 40, 0, 0);

    scene.runCollisions();

    expect(cue).not.toHaveBeenCalled();
    // The generic non-lethal impact flash still plays.
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  // ── Spread impact feedback (AH-0MV8229B9009DQGA) ─────────────────

  it('AC4 — a spread shot plays its baked hit cue and distinct amber impact flash on connect', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = {
      color: 0xffaa00,
      radius: 9,
      duration: 0.16,
      cue: 'playSpreadImpactSound',
    };

    scene.runCollisions();

    expect(cue).toHaveBeenCalledTimes(1);
    expect(cue).toHaveBeenCalledWith('playSpreadImpactSound');
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  it('AC4 — the spread hit cue layer plays on the killing blow too', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 1);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = {
      color: 0xffaa00,
      radius: 9,
      duration: 0.16,
      cue: 'playSpreadImpactSound',
    };

    scene.runCollisions();

    expect(enemy.alive).toBe(false);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  // ── Dual impact feedback (AH-0MV8229NM009CZOA) ─────────────────

  it('AC4 — a dual shot plays its baked hit cue and distinct magenta impact flash on connect', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    // The weapon definition's impactFx metadata (dual): magenta flash + the
    // newly baked twin-snap hit cue, routed through the shared impact seam.
    pb.impactFx = {
      color: 0xff00ff,
      radius: 8,
      duration: 0.14,
      cue: 'playDualImpactSound',
    };

    scene.runCollisions();

    expect(cue).toHaveBeenCalledTimes(1);
    expect(cue).toHaveBeenCalledWith('playDualImpactSound');
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  it('AC4 — the dual hit cue layer plays on the killing blow too', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 1);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = {
      color: 0xff00ff,
      radius: 8,
      duration: 0.14,
      cue: 'playDualImpactSound',
    };

    scene.runCollisions();

    expect(enemy.alive).toBe(false);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  // ── Rapid impact feedback (AH-0MV822A03006UT2P) ─────────────────

  it('AC4 — a rapid shot plays its baked hit cue and distinct yellow impact flash on connect', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    // The weapon definition's impactFx metadata (rapid): bright yellow flash
    // at the hit point + the newly baked staccato hit cue, routed through the
    // shared impact seam.
    pb.impactFx = {
      color: 0xffff00,
      radius: 7,
      duration: 0.1,
      cue: 'playRapidImpactSound',
    };

    scene.runCollisions();

    expect(cue).toHaveBeenCalledTimes(1);
    expect(cue).toHaveBeenCalledWith('playRapidImpactSound');
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  it('AC4 — the rapid hit cue layer plays on the killing blow too', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 1);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = {
      color: 0xffff00,
      radius: 7,
      duration: 0.1,
      cue: 'playRapidImpactSound',
    };

    scene.runCollisions();

    expect(enemy.alive).toBe(false);
    expect(cue).toHaveBeenCalledTimes(1);
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
  });

  // ── Railgun impact feedback (AH-0MVMIGVCE004VSNA) ────────────────

  it('AH-0MVMIGVCE004VSNA — an auto-fired railgun bullet carries the catalogue impact metadata', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 50, y: 50 });
    player.equipWeapon('railgun');
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(2);

    const shot = scene
      .getPlayerBullets()
      .find((b) => b.color === BULLET_COLORS.railgun);
    expect(shot).toBeDefined();
    // The shared core copied the weapon's declared impact feedback onto the
    // shot, so the connect routes through the shared seam with no per-scene
    // code.
    expect(shot!.impactFx).toEqual(WEAPON_CATALOGUE.railgun.impactFx);
  });

  it('AH-0MVQ6C1YL003HU9K — an auto-fired railgun spawns its launch flash through the shared core path', async () => {
    const scene = await boot();
    const flash = vi.spyOn(muzzleFlashModule, 'spawnMuzzleFlash');
    const player = scene.addPlayer({ x: 50, y: 50 });
    player.equipWeapon('railgun');
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(2);

    // `_autoFire` spawns the muzzle flash from the weapon's `muzzleFlash`
    // metadata through the one shared spawn path, so the game, GymWeapons and
    // GymWeaponLeveling all show the identical sky-blue launch cue with no
    // per-scene code.
    expect(flash).toHaveBeenCalledWith(
      scene,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({
        color: BULLET_COLORS.railgun,
        radius: WEAPON_CATALOGUE.railgun.muzzleFlash!.radius,
        duration: WEAPON_CATALOGUE.railgun.muzzleFlash!.duration,
      }),
    );
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  it('AH-0MVMIGVCE004VSNA — a railgun connect plays its baked hit cue and sky-blue impact flash', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const impact = vi.spyOn(bulletImpactModule, 'spawnBulletImpact');
    const enemy = new ToughStubEnemy(scene, 40, 40, 10, 3);
    scene.entities.push(enemy);
    const pb = scene.spawnPlayerBullet(40, 40, 0, 0);
    pb.impactFx = { ...WEAPON_CATALOGUE.railgun.impactFx! };

    scene.runCollisions();

    // The connect is audible (baked hit cue) and colour-matched to the sky
    // blue tracer instead of the generic warm-white fallback flash.
    expect(cue).toHaveBeenCalledTimes(1);
    expect(cue).toHaveBeenCalledWith('playRailgunImpactSound');
    expect(impact).toHaveBeenCalledWith(
      scene,
      expect.any(Number),
      expect.any(Number),
      expect.objectContaining({ color: BULLET_COLORS.railgun }),
    );
    expect(scene.getBulletImpactEffects()).toHaveLength(1);
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
      options: [],
      nova: [],
      mortar: [],
      arc: [],
      rear_guard: [],
      broadside: [],
      railgun: [],
      shard_swarm: [],
      heavy_slug: [],
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

// ── R-Type wave-laser damage budget (AH-0MV1BIUSJ0090W92, AH-0MV97RISJ002WR2S) ─

describe('damage-budget player bullets — Wave Laser maxHitPoints (AH-0MV97RISJ002WR2S)', () => {
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

  function destroyedHooks(scene: StubCombatScene): string[] {
    return scene.hooks.filter((h) => h.startsWith('onEnemyDestroyed'));
  }

  it('an ordinary bullet (maxHitPoints 0) damages one enemy and is consumed', async () => {
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

  it('a budget-2 beam destroys two 1-HP enemies and is consumed on the second', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const first = addEnemy(scene, 200, 200);
    const second = addEnemy(scene, 260, 200);
    const third: StubEnemy = new ToughStubEnemy(scene, 320, 200, 10, 3);

    // Budget 2: destroy the first (budget 2 → 1, pass through), destroy the
    // second (budget 1 → 0) and stop — the beam is consumed on the kill that
    // spends the last damage point, so the third enemy is never touched.
    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 2);
    scene.add.existing(third);
    scene.entities.push(third);

    scene.runCollisions(); // first
    expect(first.destroyed).toBe(true);
    expect(bullet.maxHitPoints).toBe(1);
    expect(scene.getPlayerBullets()).toContain(bullet);

    bullet.setPosition(260, 200);
    scene.runCollisions(); // second — budget spent, beam consumed
    expect(second.destroyed).toBe(true);
    expect(bullet.maxHitPoints).toBe(0);
    expect(scene.getPlayerBullets()).not.toContain(bullet);

    // The consumed beam never reaches the third enemy.
    bullet.setPosition(320, 200);
    scene.runCollisions();
    expect((third as ToughStubEnemy).damageCalls).toBe(0);
    expect((third as ToughStubEnemy).alive).toBe(true);
    expect(destroyedHooks(scene)).toHaveLength(2);
  });

  it('deals its remaining damage to a tougher enemy behind a destroyed one', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const tough1 = new ToughStubEnemy(scene, 200, 200, 10, 2);
    const tough2 = new ToughStubEnemy(scene, 320, 200, 10, 2);
    scene.add.existing(tough1);
    scene.add.existing(tough2);
    scene.entities.push(tough1, tough2);

    // Budget 3: destroys the 2-HP first ship (2 damage, budget 3 → 1, pass
    // through) then chips exactly 1 damage off the 2-HP second ship (budget
    // 1 → 0) before the beam is consumed.
    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 3);
    scene.runCollisions(); // first — destroyed, beam passes through
    expect(tough1.damageCalls).toBe(2);
    expect(tough1.alive).toBe(false);
    expect(bullet.maxHitPoints).toBe(1);
    expect(scene.getPlayerBullets()).toContain(bullet);

    bullet.setPosition(320, 200);
    scene.runCollisions(); // second — partial hit, budget spent, consumed
    expect(tough2.damageCalls).toBe(1);
    expect(tough2.health).toBe(1);
    expect(tough2.alive).toBe(true);
    expect(bullet.maxHitPoints).toBe(0);
    expect(scene.getPlayerBullets()).not.toContain(bullet);
    expect(destroyedHooks(scene)).toHaveLength(1);
  });

  it('caps per-enemy damage at the enemy\u2019s remaining HP', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    // One 5-HP harvester-style enemy; a 3-budget beam spends all of its
    // budget against it (3 damage, HP 5 → 2) and is consumed mid-fight: the
    // enemy survives and per-enemy damage is capped at the remaining budget.
    const tough = new ToughStubEnemy(scene, 200, 200, 10, 5);
    scene.add.existing(tough);
    scene.entities.push(tough);

    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 3);
    scene.runCollisions();

    expect(tough.damageCalls).toBe(3);
    expect(tough.health).toBe(2);
    expect(tough.alive).toBe(true);
    expect(bullet.maxHitPoints).toBe(0);
    expect(scene.getPlayerBullets()).not.toContain(bullet);
  });

  it('an enemy already charged is never damaged again across frames', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    // 2-HP enemy: the first contact spends 2 budget, destroys it and leaves
    // 1 budget — the beam passes through and keeps scanning. Re-running the
    // shared pass must not re-charge the remembered enemy.
    const tough = new ToughStubEnemy(scene, 200, 200, 10, 2);
    scene.add.existing(tough);
    scene.entities.push(tough);

    const bullet = scene.spawnPlayerBullet(200, 200, 0, 0, 0x3366ff, 1, 3, 3);
    scene.runCollisions();
    scene.runCollisions();
    scene.runCollisions();

    expect(tough.damageCalls).toBe(2);
    expect(tough.alive).toBe(false);
    expect(bullet.maxHitPoints).toBe(1);
    expect(scene.getPlayerBullets()).toContain(bullet);
    expect(destroyedHooks(scene)).toHaveLength(1);
  });

  it('auto-fire propagates the weapon maxHitPoints budget onto spawned bullets', async () => {
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
      expect(bullet.maxHitPoints).toBe(WEAPON_CATALOGUE.wave_laser.maxHitPoints);
    }
    expect(WEAPON_CATALOGUE.wave_laser.maxHitPoints).toBe(2);
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

  it('auto-fire wires the wall-bounce hook onto spawned ricochet bullets (AH-0MV822AP1006W2F9)', async () => {
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
      expect(typeof bullet.onWallBounce).toBe('function');
    }
  });

  it('a wall bounce plays the ricochet impact cue and spawns a distinct flash (AH-0MV822AP1006W2F9)', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const player = scene.addPlayer({ x: 100, y: 100 });
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

    // Steer one bullet so it crosses the left edge on the next advance.
    const bullet = ricochetBullets[0];
    bullet.x = 2;
    bullet.vx = -350;
    bullet.vy = 0;

    advanceAndCull(bullet, 0.01);

    expect(cue).toHaveBeenCalledWith('playRicochetImpactSound');
    expect(scene.getBulletImpactEffects().length).toBeGreaterThan(0);
    expect(bullet.onWallBounce).toBeDefined();
  });

  it('the final wall contact (expiry) still plays the impact cue once (AH-0MV822AP1006W2F9)', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('ricochet', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    const bullet = scene
      .getPlayerBullets()
      .find((b) => b.color === WEAPON_CATALOGUE.ricochet.bulletColor);
    expect(bullet).toBeDefined();
    // Exhaust the bounce budget so the next wall contact expires the bullet.
    bullet!.bounces = 0;
    bullet!.x = 2;
    bullet!.vx = -350;
    bullet!.vy = 0;

    expect(advanceAndCull(bullet!, 0.01)).toBe(false);

    expect(cue).toHaveBeenCalledWith('playRicochetImpactSound');
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

  /** Normalises an angle into (−π, π]. */
  function normalizeAngle(angle: number): number {
    let a = angle;
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a <= -Math.PI) a += 2 * Math.PI;
    return a;
  }

  /** Spawns a cluster missile tagged with the base (level 0) split definition. */
  function spawnClusterAtHeading(
    scene: StubCombatScene,
    heading: number,
  ): PlayerBullet {
    const bullet = scene.spawnPlayerBullet(
      0,
      0,
      Math.cos(heading) * PLAYER_BULLET_SPEED,
      Math.sin(heading) * PLAYER_BULLET_SPEED,
      WEAPON_CATALOGUE.cluster.bulletColor,
      1,
      3,
    );
    bullet.splitWeapon = resolveWeaponDefinition('cluster', 0);
    return bullet;
  }

  /** Splits a bullet and returns the flight headings (radians) of its warheads. */
  function splitHeadings(
    scene: StubCombatScene,
    bullet: PlayerBullet,
  ): number[] {
    scene.runSplitProjectile(bullet);
    scene.runFlushSplits();
    return scene
      .getPlayerBullets()
      .filter((b) => b.splitWeapon === undefined)
      .map((b) => Math.atan2(b.vy, b.vx))
      .sort((a, b) => a - b);
  }

  it('a base-level cluster missile splits into at least two warheads', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    // `resolveWeaponDefinition('cluster', 0)` is the first-collection def.
    const def = resolveWeaponDefinition('cluster', 0);
    expect(def.splits).toBeGreaterThanOrEqual(2);

    const bullet = spawnClusterAtHeading(scene, 0);
    scene.runSplitProjectile(bullet);
    scene.runFlushSplits();
    const warheads = scene
      .getPlayerBullets()
      .filter((b) => b.splitWeapon === undefined);
    expect(warheads.length).toBeGreaterThanOrEqual(2);
  });

  it('fans the two base warheads to +90°/−90° (90°/270°), never 0°/180°', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    // Fired to the right: baseHeading = 0.
    const bullet = spawnClusterAtHeading(scene, 0);
    const headings = splitHeadings(scene, bullet);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toBeCloseTo(-Math.PI / 2, 5); // 270°
    expect(headings[1]).toBeCloseTo(Math.PI / 2, 5); // 90°
    for (const heading of headings) {
      expect(Math.abs(heading)).not.toBeCloseTo(0, 5);
      expect(Math.abs(heading)).not.toBeCloseTo(Math.PI, 5);
    }
  });

  it.each([2, 3])(
    'evenly spaces %d warheads with a constant +90° phase around the parent heading',
    async (n) => {
      const scene = await boot();
      scene.addPlayer({ x: 50, y: 50 });
      // A diagonal parent heading — the phase must stay relative to it.
      const base = Math.PI / 4;
      const bullet = scene.spawnPlayerBullet(
        0,
        0,
        Math.cos(base) * PLAYER_BULLET_SPEED,
        Math.sin(base) * PLAYER_BULLET_SPEED,
        WEAPON_CATALOGUE.cluster.bulletColor,
        1,
        3,
      );
      bullet.splitWeapon = {
        ...resolveWeaponDefinition('cluster', 0),
        splits: n,
      };

      const headings = splitHeadings(scene, bullet);
      expect(headings).toHaveLength(n);
      const expected = Array.from({ length: n }, (_, i) =>
        normalizeAngle(base + Math.PI / 2 + (2 * Math.PI * i) / n),
      ).sort((a, b) => a - b);
      for (let i = 0; i < n; i++) {
        expect(headings[i]).toBeCloseTo(expected[i], 5);
      }
    },
  );

  it('keeps each warhead at the parent missile speed as an ordinary PlayerBullet', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 50, y: 50 });
    const bullet = spawnClusterAtHeading(scene, 0);
    const parentSpeed = Math.hypot(bullet.vx, bullet.vy);

    scene.runSplitProjectile(bullet);
    scene.runFlushSplits();
    const warheads = scene
      .getPlayerBullets()
      .filter((b) => b.splitWeapon === undefined);
    expect(warheads.length).toBeGreaterThanOrEqual(2);
    for (const warhead of warheads) {
      expect(Math.hypot(warhead.vx, warhead.vy)).toBeCloseTo(parentSpeed, 5);
      expect(warhead).toBeInstanceOf(PlayerBullet);
      expect(warhead.splitWeapon).toBeUndefined();
    }
  });

  it('auto-fire wires the cluster shell visual/feel metadata (AH-0MV822B1B0048UZT)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('cluster', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(2);
    const shell = scene
      .getPlayerBullets()
      .find((b) => b.color === WEAPON_CATALOGUE.cluster.bulletColor);
    expect(shell).toBeDefined();
    // The shell reads as a missile with a flickering exhaust flame...
    expect(shell!.shape).toBe('missile');
    expect(shell!.flame).toBeGreaterThan(0);
    expect(shell!.tail).toBeGreaterThan(0);
    // ...and carries the weapon's baked hit cue for its warheads.
    expect(shell!.impactFx?.cue).toBe('playClusterImpactSound');
    // The launch puff is spawned through the shared combat-core spawn path.
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  it('a warhead connect plays the cluster impact cue through the shared seam (AH-0MV822B1B0048UZT)', async () => {
    const scene = await boot();
    const cue = vi.spyOn(effectsModule, 'playWeaponImpactCue');
    scene.addPlayer({ x: 50, y: 50 });
    const victim = addEnemy(scene, 200, 200);
    spawnCluster(scene, 200, 200);

    // The shell splits on impact; the warheads are queued then admitted.
    scene.runCollisions();
    expect(victim.destroyed).toBe(false);
    scene.runFlushSplits();
    const warhead = scene
      .getPlayerBullets()
      .find(
        (b) =>
          b.color === WEAPON_CATALOGUE.cluster.bulletColor && b.impactFx,
      );
    expect(warhead).toBeDefined();

    // A warhead connecting damages the enemy and plays the baked hit cue +
    // hot-pink impact flash through the shared impact path.
    scene.runCollisions();
    expect(victim.destroyed).toBe(true);
    expect(cue).toHaveBeenCalledWith('playClusterImpactSound');
    expect(scene.getBulletImpactEffects().length).toBeGreaterThan(0);
  });
});

// ── Gradius Options orbit-emitter seam (AH-0MV1BIVVK0043TEM) ─────────

describe('Options orbit-emitter seam (AH-0MV1BIVVK0043TEM)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<StubCombatScene> {
    booted = await bootScene([StubCombatScene]);
    return booted.scene as StubCombatScene;
  }

  /** Equips Options and fires one volley, returning only the pod bullets. */
  function fireOptionsPods(scene: StubCombatScene): PlayerBullet[] {
    scene.runAutoFire(1);
    return scene
      .getPlayerBullets()
      .filter((b) => b.color === WEAPON_CATALOGUE.options.bulletColor);
  }

  it('auto-fire spawns one pod bullet per orbiting pod, each radially outward', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('options', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    const bullets = fireOptionsPods(scene);
    const expected = player.getWeaponDef('options').orbit?.pods ?? 0;
    expect(expected).toBe(2);
    expect(bullets).toHaveLength(expected);

    for (const bullet of bullets) {
      // Each pod fires radially outward along its own ship→pod line at the
      // pod bullet speed — not along the ship's heading (AH-0MV5DFBVW002J2XO).
      const radial = Math.atan2(bullet.y - player.y, bullet.x - player.x);
      expect(Math.atan2(bullet.vy, bullet.vx)).toBeCloseTo(radial, 5);
      expect(Math.hypot(bullet.vx, bullet.vy)).toBeCloseTo(
        OPTIONS_POD_BULLET_SPEED,
        5,
      );
      // Each pod launches from its own position on the orbit (not the ship
      // centre), so the escort reads as separate emitters.
      expect(Math.hypot(bullet.x - player.x, bullet.y - player.y)).toBeCloseTo(
        OPTIONS_ORBIT_RADIUS,
        3,
      );
    }
    // The two pods do not both copy the ship's heading: diametrically
    // opposite pods fire in opposite radial directions.
    expect(Math.atan2(bullets[0].vy, bullets[0].vx)).not.toBeCloseTo(
      Math.atan2(bullets[1].vy, bullets[1].vx),
      3,
    );
    // Distinct pod launch positions — one per pod.
    const positions = new Set(
      bullets.map((b) => `${b.x.toFixed(3)},${b.y.toFixed(3)}`),
    );
    expect(positions.size).toBe(expected);
  });

  it('the pod count is capped at OPTIONS_MAX_PODS at high levels', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    // Each permanent grant raises the weapon level; the resolved pod count
    // must saturate at the legibility cap rather than growing without bound.
    for (let i = 0; i < 30; i++) player.equipWeapon('options', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    expect(player.getWeaponDef('options').orbit?.pods).toBe(OPTIONS_MAX_PODS);
    const bullets = fireOptionsPods(scene);
    expect(bullets).toHaveLength(OPTIONS_MAX_PODS);
  });

  it('advances the orbit phase between frames so pods do not fire from a frozen point', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('options', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    const first = fireOptionsPods(scene)[0];
    // Advance the shared player step (which advances the orbit phase) without
    // firing again, then fire the next volley.
    (scene as unknown as { _updateOptionsEscort(dt: number): void })
      ._updateOptionsEscort(0.25);
    scene.getPlayerBullets().length = 0;
    const second = fireOptionsPods(scene)[0];
    expect(second.x).not.toBeCloseTo(first.x, 3);
  });
});

// ── Bullet visual metadata threading (AH-0MV8228MD009UBF7) ─────────

describe('auto-fire threads the weapon visual identity onto spawned bullets', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<StubCombatScene> {
    booted = await bootScene([StubCombatScene]);
    return booted.scene as StubCombatScene;
  }

  it('spawned wave-laser bullets carry the beam shape + length + rim', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('wave_laser', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    const bullets = scene.getPlayerBullets().filter(
      (b) => b.color === WEAPON_CATALOGUE.wave_laser.bulletColor,
    );
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      expect(bullet.shape).toBe('line');
      expect(bullet.shapeLength).toBe(7);
      expect(bullet.rimColor).toBe(0xffffff);
      expect(bullet.thickness).toBe(3);
    }
  });

  it('spawned dual bullets carry the short-beam shape', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('dual', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    const bullets = scene.getPlayerBullets().filter(
      (b) => b.color === WEAPON_CATALOGUE.dual.bulletColor,
    );
    expect(bullets.length).toBeCloseTo(2, 0);
    for (const bullet of bullets) {
      expect(bullet.shape).toBe('line');
      expect(bullet.shapeLength).toBe(2);
    }
  });

  it('an ordinary cannon bullet keeps the default disc shape', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('cannon'); // the permanent default weapon
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(0.5);
    for (const bullet of scene.getPlayerBullets()) {
      expect(bullet.shape).toBe('circle');
      expect(bullet.shapeLength).toBeUndefined();
    }
  });

  it('options pod bullets carry the weapon visual identity', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('options', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(1);
    const bullets = scene.getPlayerBullets().filter(
      (b) => b.color === WEAPON_CATALOGUE.options.bulletColor,
    );
    expect(bullets.length).toBeGreaterThan(0);
    for (const bullet of bullets) {
      expect(bullet.shape).toBe('chevron');
      // The pod shot carries its full visual identity through the shared
      // orbit spawn path (AH-0MV822BDN008IYL6): the pale-aqua rim, the
      // short fading trail, and the per-weapon impact feedback the shared
      // impact seam resolves when the shot connects.
      expect(bullet.rimColor).toBe(WEAPON_CATALOGUE.options.bulletRim);
      expect(bullet.tail).toBe(WEAPON_CATALOGUE.options.bulletTrail);
      expect(bullet.impactFx?.cue).toBe('playOptionsImpactSound');
    }
  });

  it('split warheads render as small discs, keeping the parent shell colour (AH-0MV822B1B0048UZT)', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('cluster', true);
    player.setBeatClock(scene.getBeatClock());
    scene.getBeatClock().reset();
    player.setInput({ up: false, down: false, left: false, right: true });
    player.physicsTick(0.1, scene.scale.width, scene.scale.height);

    scene.runAutoFire(1);
    const parent = scene.getPlayerBullets().find(
      (b) => b.color === WEAPON_CATALOGUE.cluster.bulletColor,
    );
    expect(parent).toBeDefined();
    expect(parent!.shape).toBe('missile');

    // Force a split and admit the queued warheads so they can be inspected.
    // Only the *new* bullets are checked — the always-active cannon also
    // fires here and must not be mistaken for a warhead.
    const before = new Set(scene.getPlayerBullets());
    scene.runSplitProjectile(parent!);
    scene.runFlushSplits();
    const warheads = scene.getPlayerBullets().filter((b) => !before.has(b));
    expect(warheads.length).toBeGreaterThan(0);
    for (const warhead of warheads) {
      // Small discs, never tiny missiles: the split reads as a cluster of
      // fragments (AC — "warheads render as small discs").
      expect(warhead.shape).toBe('disc');
      // The burst still reads as one weapon: warheads keep the shell colour.
      expect(warhead.color).toBe(WEAPON_CATALOGUE.cluster.bulletColor);
      // A warhead is a fragment of the (larger) parent shell.
      expect(warhead.radius).toBeLessThan(parent!.radius);
    }
  });
});

// ── Force-field ram absorption (AH-0MVM8GTG7002IRTL, test-first) ────

/**
 * Contract tests for the shared ram rule once shields exist
 * (epic AH-0MVJ8W4GE007OMNT AC2, answer Q6 = **B**).
 *
 * **TEST-FIRST → IMPLEMENTED.** The ram-absorb branches were wrapped in
 * Vitest's `it.fails` (the repo's red-before/green-after convention) while
 * `CombatScene._handleCollisions` step 4 knew nothing about shields; the
 * implementation item (AH-0MVM8GUZG008AWSU) has now landed the branch and
 * flipped them back to `it`. The two green-guard tests (unshielded ram,
 * Thorn-Field precedence) pin behaviour that already held before and must
 * keep holding.
 *
 * `FieldStubEnemy` mirrors the pinned BaseEnemy force-field surface (see
 * `src/entities/BaseEnemy.test.ts`): `forceFieldHits` / `hasForceField` /
 * `lastHitAbsorbed` / `forceFieldBroken`, with `takeDamage()` depleting the
 * field before the hull. With that entity in place, this suite isolates the
 * **shared core** ram branch: the scene must ask the entity, consume exactly
 * one field hit **per ram contact** (never per overlapping frame — guarded
 * by the documented shared re-arm), destroy neither side, and never call
 * `onPlayerHit` / `_hitPlayer` while the field is up.
 *
 * Shipped values: a ram inside the re-arm window consumes nothing; once the
 * re-arm expires a later ram consumes the next field hit; once the field is
 * down, today's both-destroyed rule applies unchanged; an active Thorn Field
 * keeps precedence over the enemy shield and fires its own absorb cue.
 */
class FieldStubEnemy extends StubEnemy {
  private _fieldHits: number;
  private _hull: number;
  lastHitAbsorbed = false;
  forceFieldBroken = false;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    fieldHits: number,
    hull = 1,
    hitRadius = 10,
  ) {
    super(scene, x, y, hitRadius);
    this._fieldHits = fieldHits;
    this._hull = hull;
  }

  get forceFieldHits(): number {
    return this._fieldHits;
  }

  get hasForceField(): boolean {
    return this._fieldHits > 0;
  }

  get health(): number {
    return this._hull;
  }

  /** absorbs one hit while the field is up; hull damage once it is down. */
  takeDamage(): number {
    if (!this.alive) return 0;
    if (this._fieldHits > 0) {
      this._fieldHits -= 1;
      this.lastHitAbsorbed = true;
      if (this._fieldHits === 0) this.forceFieldBroken = true;
      return this._hull;
    }
    this.lastHitAbsorbed = false;
    this._hull -= 1;
    if (this._hull <= 0) {
      this._hull = 0;
      this.destroySelf();
    }
    return this._hull;
  }
}

describe('CombatScene — force-field ram absorption (AH-0MVM8GTG7002IRTL)', () => {
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

  it(
    'AC2/Q6-B — ramming a shielded enemy consumes exactly one field hit, destroys neither side and never hits the player',
    async () => {
      const scene = await boot();
      const player = scene.addPlayer({ x: 80, y: 80 });
      const enemy = new FieldStubEnemy(scene, player.x, player.y, 2, 3);
      scene.entities.push(enemy);

      scene.runCollisions();

      // The field ate the ram: one field hit gone, hull untouched.
      expect(enemy.forceFieldHits).toBe(1);
      expect(enemy.health).toBe(3);
      expect(enemy.alive).toBe(true);
      expect(enemy.destroyed).toBe(false);
      // No kill finalisation — score/drops/wave accounting must not fire.
      expect(scene.hooks.some((h) => h.startsWith('onEnemyDestroyed'))).toBe(false);
      // The player survives the collision unhit.
      expect(scene.getPlayerHitCount()).toBe(0);
      expect(scene.hooks).not.toContain('onPlayerHit');
    },
  );

  it(
    'AC2 — a sustained overlap never drains the field frame by frame (documented re-arm)',
    async () => {
      const scene = await boot();
      const player = scene.addPlayer({ x: 80, y: 80 });
      const enemy = new FieldStubEnemy(scene, player.x, player.y, 2);
      scene.entities.push(enemy);

      // Two collision passes back-to-back, same instant: the second ram
      // happens inside the shared re-arm window and must consume nothing.
      scene.runCollisions();
      scene.runCollisions();

      expect(enemy.forceFieldHits).toBe(1);
      expect(enemy.alive).toBe(true);
      expect(scene.getPlayerHitCount()).toBe(0);
    },
  );

  it(
    'AC2 — once the shared re-arm expires, a later ram consumes the next field hit',
    async () => {
      const scene = await boot();
      const player = scene.addPlayer({ x: 80, y: 80 });
      const enemy = new FieldStubEnemy(scene, player.x, player.y, 2);
      scene.entities.push(enemy);

      scene.runCollisions();
      expect(enemy.forceFieldHits).toBe(1);

      // Advance comfortably past the documented ~0.5 s re-arm. `advanceGame`
      // anchors its fixed steps to a fresh wall-clock reading rather than to
      // the scene clock's last value, and the deterministic boot already
      // settles ~150 ms of simulated time, so 600 ms of steps is not
      // guaranteed to land 600 ms past the re-arm; 1000 ms always is.
      await advanceGame(booted!.game, 1000);
      scene.runCollisions();

      expect(enemy.forceFieldHits).toBe(0);
      expect(enemy.alive).toBe(true);
      expect(scene.getPlayerHitCount()).toBe(0);
      expect(scene.hooks).not.toContain('onPlayerHit');
    },
  );

  it(
    'AC2 — once the field is down, the ram falls through to today\'s both-destroyed rule',
    async () => {
      const scene = await boot();
      const player = scene.addPlayer({ x: 80, y: 80 });
      const enemy = new FieldStubEnemy(scene, player.x, player.y, 1);
      scene.entities.push(enemy);

      scene.runCollisions();
      expect(enemy.forceFieldHits).toBe(0);
      expect(enemy.alive).toBe(true);
      expect(scene.getPlayerHitCount()).toBe(0);

      await advanceGame(booted!.game, 600);
      scene.runCollisions();

      // Field down → the existing contact rule applies unchanged: both die.
      expect(enemy.destroyed).toBe(true);
      expect(scene.getPlayerHitCount()).toBe(1);
      expect(scene.hooks).toContain('onPlayerHit');
    },
  );

  it('AC2 — ramming an unshielded enemy keeps today\'s both-destroyed behaviour', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 80, y: 80 });
    // A field-capable enemy carrying zero hits is byte-for-byte today's ram.
    const enemy = new FieldStubEnemy(scene, player.x, player.y, 0);
    scene.entities.push(enemy);

    scene.runCollisions();

    expect(enemy.destroyed).toBe(true);
    expect(scene.getPlayerHitCount()).toBe(1);
    expect(scene.hooks).toContain('onPlayerHit');
    expect(scene.hooks).toContain('onPlayerRamsEnemy');
  });

  it('AC2 — an active Thorn Field keeps precedence and its own cue over the enemy shield', async () => {
    const scene = await boot();
    scene.effects.applyCollect('thorns', true);
    const player = scene.addPlayer({ x: 80, y: 80 });
    const enemy = new FieldStubEnemy(scene, player.x, player.y, 2);
    scene.entities.push(enemy);

    scene.runCollisions();

    // The ram resolves through the Thorn Field exactly as today: the enemy
    // still dies, the player takes no hit, and the distinct thorn absorb
    // burst/cue fires (its own registry).
    expect(enemy.destroyed).toBe(true);
    expect(scene.getPlayerHitCount()).toBe(0);
    expect(scene.hooks).not.toContain('onPlayerHit');
    expect(scene.getThornsAbsorbEffects().length).toBeGreaterThan(0);
    // Precedence: one thorn ram budget spent, and the enemy shield is
    // untouched by the same contact.
    expect(scene.effects.thornsRemaining()).toBe(1);
    expect(enemy.forceFieldHits).toBe(2);
  });
});

// ── Force Field reflect feedback (AH-0MVRDMMYO002SC5V) ────────────────
//
// Producer decision Q2 = c (parent AH-0MVBKT2WO001AR14): every bullet the
// Force Field reflects flashes at the intercept point AND plays its own
// dedicated baked "bounce" cue, so a reflection reads (and sounds) distinct
// from a bullet destruction, a ricochet tick or taking a hit. The feedback
// lives in the shared reflect branch, so `PlayScene` and every gym get it
// with no scene edits (gym↔game parity, AH-0MUGZDTFX004RBD1).

describe('CombatScene — Force Field reflect feedback (AH-0MVRDMMYO002SC5V)', () => {
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

  /** Arms the shared reflect bubble and drops the player in mid-field. */
  function armField(scene: StubCombatScene): Player {
    scene.effects.applyCollect('force_field');
    return scene.addPlayer({ x: 100, y: 100 });
  }

  it('AC5/AC6 — an intercepted bullet flashes once at the intercept point and plays the reflect cue once', async () => {
    const scene = await boot();
    const player = armField(scene);
    const cue = vi.spyOn(effectsModule, 'playForceFieldReflectSound');
    // Inside the shared bubble radius (SHIP_SIZE × 1.8 = 36 px + bullet 5 px)
    // but well off the player centre, so the flash position proves the
    // intercept point is used and not the ship's position.
    const eb = new StubBullet(scene, player.x + 25, player.y + 10);
    scene.bullets.push(eb);

    scene.runCollisions();

    // The reflection itself is unchanged: one player-owned bullet, no hit.
    expect(scene.getPlayerBullets()).toHaveLength(1);
    expect(scene.hooks).not.toContain('onPlayerHit');

    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(1);
    expect(flashes[0].x).toBe(player.x + 25);
    expect(flashes[0].y).toBe(player.y + 10);
    expect(lastFillColor(flashes[0].commandBuffer as number[])).toBe(FORCE_FIELD_COLOR);

    expect(cue).toHaveBeenCalledTimes(1);
  });

  it('AC5/AC6 — two intercepted bullets produce two flashes and two cue calls', async () => {
    const scene = await boot();
    const player = armField(scene);
    const cue = vi.spyOn(effectsModule, 'playForceFieldReflectSound');
    const first = new StubBullet(scene, player.x + 20, player.y);
    const second = new StubBullet(scene, player.x, player.y + 24);
    scene.bullets.push(first, second);

    scene.runCollisions();

    expect(scene.getPlayerBullets()).toHaveLength(2);
    const flashes = scene.getBulletImpactEffects();
    expect(flashes).toHaveLength(2);
    expect(flashes.map((flash) => flash.x)).toEqual([player.x + 20, player.x]);
    for (const flash of flashes) {
      expect(lastFillColor(flash.commandBuffer as number[])).toBe(FORCE_FIELD_COLOR);
    }
    expect(cue).toHaveBeenCalledTimes(2);
  });

  it('AC5/AC6 — a bullet with no active field is not reflected and produces neither flash nor cue', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 100, y: 100 });
    const cue = vi.spyOn(effectsModule, 'playForceFieldReflectSound');
    const eb = new StubBullet(scene, player.x, player.y);
    scene.bullets.push(eb);

    scene.runCollisions();

    expect(scene.getPlayerBullets()).toHaveLength(0);
    expect(scene.hooks).toContain('onPlayerHit');
    expect(scene.getBulletImpactEffects()).toHaveLength(0);
    expect(cue).not.toHaveBeenCalled();
  });

  it('AC5/AC6 — a spent reflect budget produces neither flash nor cue', async () => {
    const scene = await boot();
    const player = armField(scene);
    const cue = vi.spyOn(effectsModule, 'playForceFieldReflectSound');
    // Spend the whole budget first: the bubble stays visible but no longer
    // reflects, so the same overlap must fall through to the hull hit.
    let drained = 0;
    while (scene.effects.tryConsumeForceFieldReflect()) drained += 1;
    expect(drained).toBeGreaterThan(0);

    scene.bullets.push(new StubBullet(scene, player.x, player.y));

    scene.runCollisions();

    expect(scene.getPlayerBullets()).toHaveLength(0);
    expect(scene.hooks).toContain('onPlayerHit');
    expect(scene.getBulletImpactEffects()).toHaveLength(0);
    expect(cue).not.toHaveBeenCalled();
  });
});
