import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  PLAYER_BULLET_RADIUS,
  PLAYER_BULLET_SPEED,
  PLAYER_RESPAWN_INVULNERABLE,
} from '../../core/constants';
import { Player } from '../../entities/Player';
import type { PlayerBullet } from '../../entities/PlayerBullet';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import type { ControlInput } from '../../utils/movementModel';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { isOnGrid } from '../../utils/beat';
import {
  CombatCoreScene,
  type CombatDrop,
  type CombatEnemyBullet,
} from './CombatCoreScene';
import { expectRangedClear } from '../../test/powerUpEffectFixtures';

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
  /** Bot-input seam under test: null by default (keyboard-only). */
  botInput: ControlInput | null = null;

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
  /** Bot-input seam override: returns the injected decision (default null). */
  protected override getBotInput(): ControlInput | null {
    return this.botInput;
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
  runGetBotInput(): ControlInput | null {
    return this.getBotInput();
  }
  runUpdateCollectAnimations(dt: number): void {
    this._updateCollectAnimations(dt);
  }
  runTickPlayer(dt: number): void {
    this._tickPlayer(dt);
  }
  /** Drives the four-directional right key for the shared-step tests. */
  pressRight(down: boolean): void {
    if (this.cursors) this.cursors.right.isDown = down;
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
  runClearEnemyBulletsInRange(x: number, y: number, range: number): void {
    this._clearEnemyBulletsInRange(x, y, range);
  }
  runUpdateP4Bomb(dt: number): void {
    this._updateP4Bomb(dt);
  }
  getBombPulseEffects(): Phaser.GameObjects.Graphics[] {
    return this.bombPulseEffects;
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

  // ── Bot-input seam (AH-0MUX495VG0014MIY AC2) ─────────────────────

  it('AC2 — getBotInput defaults to null (keyboard-only)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    expect(scene.runGetBotInput()).toBeNull();
  });

  it('AC2/AC4 — _readPlayerInput uses the keyboard when no bot input is supplied', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    scene.pressRight(true);

    expect(scene.runReadInput()).toEqual({
      up: false,
      down: false,
      left: false,
      right: true,
    });
  });

  it('AC2 — a supplied bot input takes precedence over held keys', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    // Keyboard says right; the bot seam says left — the bot wins.
    scene.pressRight(true);
    scene.botInput = { up: false, down: false, left: true, right: false };

    expect(scene.runReadInput()).toEqual({
      up: false,
      down: false,
      left: true,
      right: false,
    });
  });

  it('AC2 — the bot input flows through _tickPlayer into the shared movement path', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    scene.botInput = { up: false, down: false, left: false, right: true };
    const beforeX = player.x;

    scene.runTickPlayer(0.5);

    expect(player.getInput()).toEqual({
      up: false,
      down: false,
      left: false,
      right: true,
    });
    expect(player.x).toBeGreaterThan(beforeX);
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

  it('AC1/AC2 — _autoFire uses the level-resolved projectiles and bullet size', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    const base = player.getWeaponDef('spread');
    expect(base.levelBulletSize).toBeUndefined();

    // Collect the spread weapon three times: the first unlock is base, the
    // next two are upgrades, then fire a burst.
    player.equipWeapon('spread');
    player.equipWeapon('spread');
    player.equipWeapon('spread');
    expect(player.getWeaponLevel('spread')).toBe(3);
    const resolved = player.getWeaponDef('spread');
    expect(resolved.offsets.length).toBeGreaterThan(base.offsets.length);
    expect(resolved.levelBulletSize).toBeGreaterThan(1);

    scene.runAutoFire(10);

    // Only the spread bullets carry the spread colour, and there are more of
    // them than the base 3-bullet pattern (projectile-count upgrade).
    const spreadBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === base.bulletColor);
    expect(spreadBullets.length).toBe(resolved.offsets.length);
    expect(spreadBullets.length).toBeGreaterThan(base.offsets.length);
    for (const bullet of spreadBullets) {
      expect(bullet.radius).toBeCloseTo(
        PLAYER_BULLET_RADIUS * resolved.levelBulletSize!,
        5,
      );
      // Bullet-size upgrades also scale the rendered radius above base.
      expect(bullet.radius).toBeGreaterThan(PLAYER_BULLET_RADIUS);
    }
  });

  it('AC2 — a base (level 0) weapon keeps the shared base bullet radius', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    scene.runAutoFire(10);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
    for (const bullet of scene.getPlayerBullets()) {
      expect(bullet.radius).toBe(PLAYER_BULLET_RADIUS);
    }
  });

  it('AC4 — spawnPlayerBullet registers the bullet on the shared player bullet list', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const bullet = scene.spawnPlayerBullet(10, 20, 1, 2, 0x00ffff, 1);
    expect(scene.getPlayerBullets()).toContain(bullet);
    expect(bullet.vx).toBe(1);
    expect(bullet.vy).toBe(2);
  });

  // ── Shared beat clock wiring (AH-0MUAYB8EH005RJ8B AC1/AC3/AC5) ──

  it('AC1/AC5 — the scene owns one shared beat clock and injects it into the player', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });

    // The player starts on its own clock; the shared auto-fire step adopts
    // the scene's single instance so every shot uses one grid.
    expect(scene.getBeatClock()).toBeDefined();
    expect(player.getBeatClock()).not.toBe(scene.getBeatClock());

    scene.runAutoFire(0.016);
    expect(player.getBeatClock()).toBe(scene.getBeatClock());

    // A separate scene gets its own instance — no module-level global.
    const other = await boot<StubCoreScene>(StubCoreScene);
    expect(other.getBeatClock()).not.toBe(scene.getBeatClock());
  });

  it('AC1/AC3 — auto-fire advances the shared clock with game time and fires on grid ticks', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });

    expect(scene.getBeatClock().now()).toBe(0); // anchored at scene start
    scene.runAutoFire(0.5);

    expect(scene.getBeatClock().now()).toBeCloseTo(500, 5); // dt*1000
    const cannonShot = player.getLastShotTime('cannon');
    expect(cannonShot).toBeDefined();
    expect(isOnGrid(cannonShot!, 375, scene.getBeatClock().anchorMs)).toBe(
      true,
    );
  });

  // ── AC1 — shared player-control step ─────────────────────────────

  it('AC1 — _tickPlayer is a no-op without a player', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.runTickPlayer(1);
    expect(scene.getPlayerBullets()).toEqual([]);
  });

  it('AC1 — _tickPlayer applies the live P5 multipliers and advances physics from dt', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    const baseMaxSpeed = player.getMovementConfig().maxSpeed;
    scene.effects.applyCollect('P5');
    scene.pressRight(true);
    const beforeX = player.x;
    scene.runTickPlayer(0.5);
    scene.pressRight(false);

    // P5 is 1.5× speed and fire rate, applied live by the shared step.
    expect(player.getFireRateMultiplier()).toBeCloseTo(1.5, 10);
    expect(player.getMovementConfig().maxSpeed).toBeCloseTo(
      baseMaxSpeed * 1.5,
      5,
    );
    // Physics advanced from the supplied dt and auto-fire produced a volley.
    expect(player.x).toBeGreaterThan(beforeX);
    expect(scene.getPlayerBullets().length).toBeGreaterThan(0);
  });

  it('AC1 — _tickPlayer advances timed-weapon timers before auto-fire', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('spread');
    expect(player.getActiveWeapons()).toContain('spread');

    // Longer than the 10 s weapon lifetime: the timers run before
    // auto-fire so the expired weapon cannot fire this frame.
    scene.runTickPlayer(10.1);
    expect(player.getActiveWeapons()).toEqual(['cannon']);
  });

  it('AC1 — _tickPlayer skips auto-fire when autoFireEnabled() is false', async () => {
    class NoAutoFireScene extends StubCoreScene {
      protected override autoFireEnabled(): boolean {
        return false;
      }
    }
    const scene = await boot<NoAutoFireScene>(NoAutoFireScene);
    scene.addPlayer({ x: 100, y: 100 });
    scene.runTickPlayer(1);
    expect(scene.getPlayerBullets()).toEqual([]);
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

  it('AC4 — _collectDrop applies an AOE weapon through the same shared path (F5 AC3)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 1, y: 1 });
    const drop = scene.addDrop('P5', 'nova');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:nova');
    expect(scene.effects.hasWeapon('nova')).toBe(true);
    expect(player.hasWeapon('nova')).toBe(true);
    expect(drop.absorbing).toBe(true);
  });

  it('AC4 — _collectDrop weapon reset preserves the equipped weapon via the registry', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.effects.applyWeapon('spread');
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    const drop = scene.addDrop('P5', 'reset');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:reset');
    // Reset drop no longer clears weapons — spread is preserved.
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    expect(drop.absorbing).toBe(true);
  });

  it('AC4 — _collectDrop queues a P4 pulse; the shared bomb step resolves it', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 120, y: 120 });
    const inside = new StubBullet(scene, 130, 120);
    const outside = new StubBullet(scene, 900, 900);
    scene.bullets.push(inside, outside);
    const drop = scene.addDrop('P4');

    scene.runCollectDrop(drop);

    // Collection queues the pulse but does not clear anything itself.
    expect(scene.bullets).toHaveLength(2);
    expect(scene.hooks).toContain('onPowerUpCollected:P4');

    // The shared per-frame bomb step fires the queued ranged clear.
    scene.runUpdateP4Bomb(0.016);
    expect(scene.bullets).toEqual([outside]);
    expect(inside.graphics.active).toBe(false);
  });

  it('AC4 (P4) — _clearEnemyBulletsInRange clears only in-range bullets (inclusive boundary)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const inside = new StubBullet(scene, 100, 100);
    const edge = new StubBullet(scene, 120, 100); // exactly range → cleared
    const outside = new StubBullet(scene, 121, 100);
    scene.bullets.push(inside, edge, outside);

    scene.runClearEnemyBulletsInRange(100, 100, 20);

    expect(scene.bullets).toEqual([outside]);
    expect(inside.graphics.active).toBe(false);
    expect(edge.graphics.active).toBe(false);
    expect(outside.graphics.active).toBe(true);

    // The shared range oracle agrees with the clear.
    expectRangedClear(
      [
        { x: 100, y: 100, destroyed: !inside.graphics.active },
        { x: 120, y: 100, destroyed: !edge.graphics.active },
        { x: 121, y: 100, destroyed: !outside.graphics.active },
      ],
      100,
      100,
      20,
    );
  });

  it('AC1 (P4) — a field pickup fires exactly one pulse (no persistent state)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    const inside = new StubBullet(scene, 150, 100);
    const outside = new StubBullet(scene, 900, 100);
    scene.bullets.push(inside, outside);

    scene.runCollectDrop(scene.addDrop('P4'));
    expect(scene.effects.isBombPermanent()).toBe(false);
    expect(scene.effects.activeEffects().some((e) => e.id === 'P4')).toBe(false);

    scene.runUpdateP4Bomb(0.016);
    expect(scene.bullets).toEqual([outside]);

    // One-shot: no later pulse fires.
    scene.bullets.push(new StubBullet(scene, 150, 100));
    scene.runUpdateP4Bomb(10);
    expect(scene.bullets).toHaveLength(2);
  });

  it('AC2/AC4 (P4) — a permanent bomb fires immediately, then every interval', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('P4', true);
    expect(scene.effects.isBombPermanent()).toBe(true);

    // Immediate pulse on the first update (hold-full reward).
    scene.bullets.push(new StubBullet(scene, 150, 100));
    scene.runUpdateP4Bomb(0.016);
    expect(scene.bullets).toHaveLength(0);

    // No pulse again before the resolved interval elapses.
    scene.bullets.push(new StubBullet(scene, 150, 100));
    scene.runUpdateP4Bomb(1);
    expect(scene.bullets).toHaveLength(1);

    // A pulse at the interval boundary clears the refreshed bullet.
    scene.runUpdateP4Bomb(scene.effects.bombInterval());
    expect(scene.bullets).toHaveLength(0);
  });

  it('AC3 (P4) — range resolves live so a level-up enlarges later pulses', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    scene.effects.applyCollect('P4', true);
    const baseRange = scene.effects.bombRange();

    // A second collection is a level-up; the live range grows.
    scene.effects.applyCollect('P4', true);
    expect(scene.effects.bombRange()).toBeGreaterThan(baseRange);
  });

  it('AC5 (P4) — each pulse spawns the shared expanding-ring VFX', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    expect(scene.getBombPulseEffects()).toHaveLength(0);

    scene.effects.applyCollect('P4', true);
    scene.runUpdateP4Bomb(0.016);

    expect(scene.getBombPulseEffects().length).toBeGreaterThan(0);
  });

  it('AC7 (P4) — reset() clears the permanent flag and pulse state', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.effects.applyCollect('P4', true);
    expect(scene.effects.isBombPermanent()).toBe(true);

    scene.effects.reset();

    expect(scene.effects.isBombPermanent()).toBe(false);
    expect(scene.effects.activeEffects().some((e) => e.id === 'P4')).toBe(false);
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
