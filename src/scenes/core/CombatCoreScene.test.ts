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
import { resolvePowerUpAtLevel } from '../../powerups/powerUpLevels';
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
import * as muzzleFlashModule from '../../vfx/muzzleFlash';
import { BULLET_COLORS, WEAPON_CATALOGUE } from '../../utils/weapons';
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
  readonly dropId: 'speed_boost' | 'bomb';
  weaponDropId?: string;
  absorbing?: boolean;

  constructor(
    public x: number,
    public y: number,
    public readonly graphics: Phaser.GameObjects.Graphics,
    dropId: 'speed_boost' | 'bomb',
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
  runPlayerFireSuppressed(): boolean {
    return this.playerFireSuppressed();
  }
  runUpdateDroneSpawning(dt: number): void {
    this._updateDroneSpawning(dt);
  }
  runTeardownRunState(): void {
    this.teardownRunState();
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
  getFireFxEffects(): Phaser.GameObjects.Graphics[] {
    return this.fireFxEffects;
  }
  getCollectAnimations() {
    return this.collectAnimations;
  }
  addDrop(id: 'speed_boost' | 'bomb', weaponDropId?: string): StubDrop {
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

  // ── Cannon projectile visuals & feel (AH-0MV8228YW0050IXS) ──────

  it('spawns a clean muzzle flash through the shared spawn path when the cannon fires (AC3)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    // Only the cannon is active: exactly one shot → exactly one muzzle flash.
    expect(player.getActiveWeapons()).toEqual(['cannon']);

    scene.runAutoFire(10);

    expect(scene.getFireFxEffects()).toHaveLength(1);
    const flash = scene.getFireFxEffects()[0];
    expect(flash.active).toBe(true);
    // The flash is anchored at the ship and faces the firing heading.
    expect(flash.x).toBeCloseTo(100, 5);
    expect(flash.y).toBeCloseTo(100, 5);
  });

  it('tags the cannon bullet with its compact-neon-disc visual identity + impact FX (AC1/AC4)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });

    scene.runAutoFire(10);

    const bullet = scene.getPlayerBullets()[0];
    expect(bullet.shape).toBe('circle');
    expect(bullet.rimColor).toBe(0xffffff);
    expect(bullet.tail).toBeGreaterThan(0);
    expect(bullet.impactFx).toBeDefined();
    expect(bullet.impactFx?.cue).toBe('playCannonImpactSound');
  });

  // ── Spread projectile visuals & feel (AH-0MV8229B9009DQGA) ──────

  it('spawns a muzzle flash through the shared spawn path when the spread fires (AC3)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('spread');

    scene.runAutoFire(10);

    // The spread fires a 3-bullet fan; at least the spread weapon's launch
    // cue is present (the permanent cannon may fire alongside it).
    const spreadBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === 0xffaa00);
    expect(spreadBullets.length).toBeGreaterThan(0);
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
    const flash = scene.getFireFxEffects()[0];
    expect(flash.active).toBe(true);
    expect(flash.x).toBeCloseTo(100, 5);
    expect(flash.y).toBeCloseTo(100, 5);
  });

  it('tags the spread bullet with its diamond visual identity + impact FX (AC1/AC4)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('spread');

    scene.runAutoFire(10);

    const spreadBullet = scene
      .getPlayerBullets()
      .find((b) => b.color === 0xffaa00);
    expect(spreadBullet).toBeDefined();
    expect(spreadBullet!.shape).toBe('diamond');
    expect(spreadBullet!.rimColor).toBeDefined();
    expect(spreadBullet!.tail).toBeGreaterThan(0);
    expect(spreadBullet!.impactFx).toBeDefined();
    expect(spreadBullet!.impactFx?.cue).toBe('playSpreadImpactSound');
  });

  // ── Dual projectile visuals & feel (AH-0MV8229NM009CZOA) ────────

  it('spawns a quick muzzle flash through the shared spawn path when the dual fires (AC3)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('dual');

    scene.runAutoFire(10);

    // The dual fires two parallel side-by-side beams; each volley spawns one
    // shared launch flash at the ship (the permanent cannon may fire too).
    const dualBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === 0xff00ff);
    expect(dualBullets.length).toBeGreaterThan(0);
    expect(dualBullets.length).toBe(2); // twin pulse bars, one volley
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
    const flash = scene.getFireFxEffects()[0];
    expect(flash.active).toBe(true);
    expect(flash.x).toBeCloseTo(100, 5);
    expect(flash.y).toBeCloseTo(100, 5);
  });

  it('tags the dual bullet with its short-beam visual identity + impact FX (AC1/AC4)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('dual');

    scene.runAutoFire(10);

    const dualBullet = scene
      .getPlayerBullets()
      .find((b) => b.color === 0xff00ff);
    expect(dualBullet).toBeDefined();
    expect(dualBullet!.shape).toBe('line');
    expect(dualBullet!.shapeLength).toBeLessThan(3); // short beam, not a dot
    expect(dualBullet!.thickness).toBeGreaterThan(1);
    expect(dualBullet!.tail).toBeGreaterThan(0);
    expect(dualBullet!.impactFx).toBeDefined();
    expect(dualBullet!.impactFx?.cue).toBe('playDualImpactSound');
  });

  // ── Rapid projectile visuals & feel (AH-0MV822A03006UT2P) ──────

  it('spawns a staccato muzzle flash through the shared spawn path when the rapid fires (AC3)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('rapid');

    scene.runAutoFire(10);

    // Every rapid shot spawns exactly one short launch flash at the ship
    // (the permanent cannon may fire alongside it).
    const rapidFlash = scene
      .getFireFxEffects()
      .filter((f) => f.active);
    expect(rapidFlash.length).toBeGreaterThan(0);
    const flash = rapidFlash[0];
    expect(flash.x).toBeCloseTo(100, 5);
    expect(flash.y).toBeCloseTo(100, 5);
  });

  it('tags the rapid bullet with its small spark visual identity + impact FX (AC1/AC4)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('rapid');

    scene.runAutoFire(10);

    const rapidBullet = scene
      .getPlayerBullets()
      .find((b) => b.color === 0xffff00);
    expect(rapidBullet).toBeDefined();
    expect(rapidBullet!.shape).toBe('spark');
    expect(rapidBullet!.rimColor).toBeDefined();
    // The rapid's small (0.7×) scale is a visual-spec knob — the base spawn
    // radius stays the shared PLAYER_BULLET_RADIUS; the "small fast read"
    // comes from the spark + rim + trail + staccato flash on top.
    expect(rapidBullet!.tail).toBeGreaterThan(0);
    expect(rapidBullet!.impactFx).toBeDefined();
    expect(rapidBullet!.impactFx?.cue).toBe('playRapidImpactSound');
  });

  // ── Shard Swarm launch cue (AH-0MVV0WMTE0007NGS) ─────────────────

  it('AH-0MVV0WMTE0007NGS — a shard swarm shot spawns one lime muzzle flash at the muzzle through the shared core path', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const flash = vi.spyOn(muzzleFlashModule, 'spawnMuzzleFlash');
    flash.mockClear();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('shard_swarm');

    scene.runAutoFire(10);

    const spec = WEAPON_CATALOGUE.shard_swarm.muzzleFlash!;
    const limeCalls = flash.mock.calls.filter(
      (call) => (call[4] as { color?: number }).color === spec.color,
    );
    // One launch flash per shard_swarm shot — a five-bullet fan is one shot,
    // so the flash count matches the number of fired shots, not the bullets.
    const shardBullets = scene
      .getPlayerBullets()
      .filter((b) => b.color === BULLET_COLORS.shard_swarm);
    expect(shardBullets.length).toBeGreaterThan(0);
    expect(limeCalls).toHaveLength(shardBullets.length / 5);
    // The flash is anchored at the ship's muzzle with the declared lime spec.
    expect(limeCalls[0][1]).toBeCloseTo(100, 5);
    expect(limeCalls[0][2]).toBeCloseTo(100, 5);
    expect(limeCalls[0][4]).toEqual({
      color: spec.color,
      radius: spec.radius,
      duration: spec.duration,
      registry: expect.anything(),
    });
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  it('AH-0MVV0WMTE0007NGS — a weapon without muzzleFlash metadata spawns no launch flash', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const flash = vi.spyOn(muzzleFlashModule, 'spawnMuzzleFlash');
    flash.mockClear();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('shard_swarm');

    // The existing seam contract: `_autoFire` only spawns when the resolved
    // definition declares `muzzleFlash`. Drive the same shard_swarm weapon
    // with the launch spec removed to prove the shared core, not a
    // per-weapon special case, decides.
    const original = player.getWeaponDef.bind(player);
    vi.spyOn(player, 'getWeaponDef').mockImplementation((id) => {
      const def = original(id);
      return id === 'shard_swarm' ? { ...def, muzzleFlash: undefined } : def;
    });

    scene.runAutoFire(10);

    const limeCalls = flash.mock.calls.filter(
      (call) =>
        (call[4] as { color?: number }).color ===
        BULLET_COLORS.shard_swarm,
    );
    expect(limeCalls).toHaveLength(0);
    // The shards still fire — only the launch cue is absent.
    expect(
      scene
        .getPlayerBullets()
        .some((b) => b.color === BULLET_COLORS.shard_swarm),
    ).toBe(true);
  });

  // ── Rear Guard launch cue (AH-0MVV0WN96007TU9J) ──────────────────

  it('AH-0MVV0WN96007TU9J — a rear guard shot spawns one compact rose muzzle flash at the muzzle through the shared core path', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const flash = vi.spyOn(muzzleFlashModule, 'spawnMuzzleFlash');
    flash.mockClear();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('rear_guard');

    scene.runAutoFire(10);

    const spec = WEAPON_CATALOGUE.rear_guard.muzzleFlash!;
    const roseCalls = flash.mock.calls.filter(
      (call) => (call[4] as { color?: number }).color === spec.color,
    );
    // The Rear Guard fires one pellet per shot, so the launch flash count
    // matches the fired pellets exactly — no flash is emitted for the
    // backward direction beyond the shared `_autoFire` path.
    const pellets = scene
      .getPlayerBullets()
      .filter((b) => b.color === BULLET_COLORS.rear_guard);
    expect(pellets.length).toBeGreaterThan(0);
    expect(roseCalls).toHaveLength(pellets.length);
    // The flash is anchored at the ship with the declared compact rose spec.
    expect(roseCalls[0][1]).toBeCloseTo(100, 5);
    expect(roseCalls[0][2]).toBeCloseTo(100, 5);
    expect(roseCalls[0][4]).toEqual({
      color: spec.color,
      radius: spec.radius,
      duration: spec.duration,
      registry: expect.anything(),
    });
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  // ── Broadside launch cue (AH-0MVV0WNOX0078G9G) ──────────────

  it('AH-0MVV0WNOX0078G9G — a broadside shot spawns exactly one wide teal muzzle flash for the pair, not one per dart', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const flash = vi.spyOn(muzzleFlashModule, 'spawnMuzzleFlash');
    flash.mockClear();
    const player = scene.addPlayer({ x: 100, y: 100 });
    player.equipWeapon('broadside');

    scene.runAutoFire(10);

    const spec = WEAPON_CATALOGUE.broadside.muzzleFlash!;
    const tealCalls = flash.mock.calls.filter(
      (call) => (call[4] as { color?: number }).color === spec.color,
    );
    // The two-sided read comes from the pair of darts plus the baked cue and
    // the wide radius — the shared `_autoFire` path spawns **one** flash per
    // shot input, so the flash count is half the dart count (never one flash
    // per dart).
    const darts = scene
      .getPlayerBullets()
      .filter((b) => b.color === BULLET_COLORS.broadside);
    expect(darts.length).toBeGreaterThan(0);
    expect(darts.length % 2).toBe(0);
    expect(tealCalls).toHaveLength(darts.length / 2);
    // The flash is anchored at the ship with the declared wide teal spec.
    expect(tealCalls[0][1]).toBeCloseTo(100, 5);
    expect(tealCalls[0][2]).toBeCloseTo(100, 5);
    expect(spec.radius).toBeGreaterThan(WEAPON_CATALOGUE.cannon.muzzleFlash!.radius);
    expect(tealCalls[0][4]).toEqual({
      color: spec.color,
      radius: spec.radius,
      duration: spec.duration,
      registry: expect.anything(),
    });
    expect(scene.getFireFxEffects().length).toBeGreaterThan(0);
  });

  it('AH-0MVV0WNOX0078G9G — a levelled broadside still spawns one flash per shot input when the pair grows to 4/6 darts', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const flash = vi.spyOn(muzzleFlashModule, 'spawnMuzzleFlash');
    flash.mockClear();
    const player = scene.addPlayer({ x: 100, y: 100 });
    // Collect the Broadside three times so `projectileCount` widens the pair.
    player.equipWeapon('broadside');
    player.equipWeapon('broadside');
    player.equipWeapon('broadside');
    const resolved = player.getWeaponDef('broadside');
    expect(resolved.offsets.length).toBeGreaterThan(2);

    scene.runAutoFire(10);

    const spec = WEAPON_CATALOGUE.broadside.muzzleFlash!;
    const tealCalls = flash.mock.calls.filter(
      (call) => (call[4] as { color?: number }).color === spec.color,
    );
    const darts = scene
      .getPlayerBullets()
      .filter((b) => b.color === BULLET_COLORS.broadside);
    const shots = darts.length / resolved.offsets.length;
    expect(Number.isInteger(shots)).toBe(true);
    expect(shots).toBeGreaterThan(0);
    // One launch flash per shot **input**: the wider fan must not multiply the
    // flash count (the same metadata survives level resolution — pinned in
    // `weaponLevels.test.ts`).
    expect(tealCalls).toHaveLength(shots);
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
    scene.effects.applyCollect('speed_boost');
    scene.pressRight(true);
    const beforeX = player.x;
    scene.runTickPlayer(0.5);
    scene.pressRight(false);

    // Speed Boost is 1.5× speed and fire rate, applied live by the shared step.
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

  // ── Run-end fire suppression (AH-0MVCB6LBE007I6R8) ───────────────

  /** Runs the shared player step on a scene that reports a finished run. */
  class RunOverScene extends StubCoreScene {
    protected override playerFireSuppressed(): boolean {
      return true;
    }
  }

  it('AC5 — the shared fire-suppression hook defaults to "not suppressed"', async () => {
    // The default is what keeps every gym (including `GymBoss`) firing after
    // its own boss dies — the documented gym divergence.
    const scene = await boot<BareCoreScene>(BareCoreScene);
    expect(scene.runPlayerFireSuppressed()).toBe(false);
  });

  it('AC1 — _tickPlayer spawns no bullets and no fire cues while suppressed', async () => {
    const scene = await boot<RunOverScene>(RunOverScene);
    scene.addPlayer({ x: 100, y: 100 });

    // Control: the same step on the same stub fires without suppression.
    const control = await boot<StubCoreScene>(StubCoreScene);
    control.addPlayer({ x: 100, y: 100 });
    control.runTickPlayer(1);
    expect(control.getPlayerBullets().length).toBeGreaterThan(0);
    expect(control.hooks).toContain('onWeaponFired:cannon');

    scene.runTickPlayer(1);
    expect(scene.getPlayerBullets()).toEqual([]);
    expect(scene.hooks).not.toContain('onWeaponFired:cannon');
  });

  it('AC4 — the shared beat clock keeps advancing while fire is suppressed', async () => {
    const scene = await boot<RunOverScene>(RunOverScene);
    const player = scene.addPlayer({ x: 100, y: 100 });

    expect(scene.getBeatClock().now()).toBe(0);
    scene.runTickPlayer(0.5);
    expect(scene.getBeatClock().now()).toBeCloseTo(500, 5);
    scene.runTickPlayer(0.25);
    expect(scene.getBeatClock().now()).toBeCloseTo(750, 5);

    // The clock is shared with the player from the first suppressed frame, so
    // the beat-modulated thruster hum / explosion grid stay on the run's grid.
    expect(player.getBeatClock()).toBe(scene.getBeatClock());
  });

  // ── AC4 — drop collection ─────────────────────────────────────────

  it('AC4 — _collectDrop applies a power-up, dispatches the hook and starts the absorb animation', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const drop = scene.addDrop('speed_boost');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onPowerUpCollected:speed_boost');
    expect(scene.hooks).toContain('_playPickupCue:speed_boost');
    expect(drop.absorbing).toBe(true);
    expect(scene.getCollectAnimations().length).toBe(1);
  });

  it('AC4 — _collectDrop applies a weapon, dispatches the weapon hook and starts the absorb animation', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const drop = scene.addDrop('speed_boost', 'spread');

    scene.runCollectDrop(drop);

    expect(scene.hooks).toContain('onWeaponCollected:spread');
    expect(scene.hooks).toContain('_playPickupCue:speed_boost');
    expect(scene.effects.hasWeapon('spread')).toBe(true);
    expect(drop.absorbing).toBe(true);
    expect(scene.getCollectAnimations().length).toBe(1);
  });

  it('AC4 — _collectDrop applies an AOE weapon through the same shared path (F5 AC3)', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const player = scene.addPlayer({ x: 1, y: 1 });
    const drop = scene.addDrop('speed_boost', 'nova');

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
    const drop = scene.addDrop('speed_boost', 'reset');

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
    const drop = scene.addDrop('bomb');

    scene.runCollectDrop(drop);

    // Collection queues the pulse but does not clear anything itself.
    expect(scene.bullets).toHaveLength(2);
    expect(scene.hooks).toContain('onPowerUpCollected:bomb');

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

    scene.runCollectDrop(scene.addDrop('bomb'));
    expect(scene.effects.isBombPermanent()).toBe(false);
    expect(scene.effects.activeEffects().some((e) => e.id === 'bomb')).toBe(false);

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
    scene.effects.applyCollect('bomb', true);
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
    scene.effects.applyCollect('bomb', true);
    const baseRange = scene.effects.bombRange();

    // A second collection is a level-up; the live range grows.
    scene.effects.applyCollect('bomb', true);
    expect(scene.effects.bombRange()).toBeGreaterThan(baseRange);
  });

  it('AC5 (P4) — each pulse spawns the shared expanding-ring VFX', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.addPlayer({ x: 100, y: 100 });
    expect(scene.getBombPulseEffects()).toHaveLength(0);

    scene.effects.applyCollect('bomb', true);
    scene.runUpdateP4Bomb(0.016);

    expect(scene.getBombPulseEffects().length).toBeGreaterThan(0);
  });

  it('AC7 (P4) — reset() clears the permanent flag and pulse state', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    scene.effects.applyCollect('bomb', true);
    expect(scene.effects.isBombPermanent()).toBe(true);

    scene.effects.reset();

    expect(scene.effects.isBombPermanent()).toBe(false);
    expect(scene.effects.activeEffects().some((e) => e.id === 'bomb')).toBe(false);
  });

  it('AC4 — _collectDrop ignores a drop that is not yet collectible', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const g = scene.add.graphics();
    // Growth 0 leaves the drop below the collection threshold.
    const uncollectible = new StubDrop(120, 120, g, 'speed_boost', undefined, 0);

    scene.runCollectDrop(uncollectible);

    expect(scene.hooks).toEqual([]);
    expect(uncollectible.absorbing).toBeUndefined();
    expect(scene.getCollectAnimations()).toHaveLength(0);
  });

  it('AC4 — _updateCollectAnimations advances and prunes completed animations', async () => {
    const scene = await boot<StubCoreScene>(StubCoreScene);
    const drop = scene.addDrop('speed_boost');
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
    const drop = new StubDrop(1, 1, scene.add.graphics(), 'speed_boost');
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

// ── Collector-drone spawn wiring (AH-0MVBMQ04X0051002) ────────────────
//
// A `mystery_ufo` field pickup queues one drone spawn in the shared registry;
// the shared `_updateDroneSpawning` step turns that request into a visible
// collector drone, and the full-hull (permanent) reward re-spawns one on the
// level-resolved interval. These tests drive the step directly with a
// stepped clock, so the schedule is deterministic and load-independent.

describe('CombatCoreScene — collector-drone spawn wiring (AH-0MVBMQ04X0051002)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function bootDroneScene(): Promise<BareCoreScene> {
    const booted = await bootScene([BareCoreScene]);
    games.push(booted);
    return booted.scene as unknown as BareCoreScene;
  }

  /** Advances the spawn step in small deterministic slices totalling `seconds`. */
  function advance(scene: BareCoreScene, seconds: number): void {
    const step = 1 / 60;
    let remaining = seconds;
    while (remaining > 1e-9) {
      const dt = Math.min(step, remaining);
      scene.runUpdateDroneSpawning(dt);
      remaining -= dt;
    }
  }

  it('a field pickup spawns exactly one visible drone at the ship', async () => {
    const scene = await bootDroneScene();
    scene.addPlayer({ x: 320, y: 240 });

    scene.effects.applyCollect('mystery_ufo');
    scene.runUpdateDroneSpawning(1 / 60);

    const drones = scene.getDrones();
    expect(drones).toHaveLength(1);
    expect(drones[0].x).toBe(320);
    expect(drones[0].y).toBe(240);
    expect(drones[0].lifetimeSeconds).toBe(
      resolvePowerUpAtLevel('mystery_ufo', 1).mysteryUfoLifetime,
    );
  });

  it('spawns one drone per field pickup and never on a timer without the permanent reward', async () => {
    const scene = await bootDroneScene();
    scene.addPlayer({ x: 320, y: 240 });

    scene.effects.applyCollect('mystery_ufo');
    advance(scene, 1 / 60);
    expect(scene.getDrones()).toHaveLength(1);

    // No permanent reward → no periodic spawn, however long the run lasts.
    advance(scene, 120);
    expect(scene.getDrones()).toHaveLength(1);
  });

  it('the permanent reward re-spawns a drone on the resolved interval (AC4)', async () => {
    const scene = await bootDroneScene();
    scene.addPlayer({ x: 320, y: 240 });

    scene.effects.applyCollect('mystery_ufo', true);
    const interval = scene.effects.mysteryUfoSpawnInterval();
    expect(scene.effects.isMysteryUfoPermanent()).toBe(true);
    // 30 s at the curve base, descending 2 s per level: level 1 → 28 s.
    expect(interval).toBe(
      resolvePowerUpAtLevel('mystery_ufo', 1).mysteryUfoSpawnInterval,
    );
    expect(interval).toBeLessThan(30);

    // The first permanent spawn lands one interval after the reward. The
    // arming step runs on the first call and does not consume `dt`.
    scene.runUpdateDroneSpawning(1 / 60);
    advance(scene, interval - 0.05);
    expect(scene.getDrones()).toHaveLength(0);
    advance(scene, 0.1);
    expect(scene.getDrones()).toHaveLength(1);

    // And again on the next interval.
    advance(scene, interval - 0.1);
    expect(scene.getDrones()).toHaveLength(1);
    advance(scene, 0.2);
    expect(scene.getDrones()).toHaveLength(2);
  });

  it('does not spawn without a ship and leaves the request queued', async () => {
    const scene = await bootDroneScene();

    scene.effects.applyCollect('mystery_ufo');
    scene.runUpdateDroneSpawning(1 / 60);
    expect(scene.getDrones()).toHaveLength(0);
    // Still queued, so the drone appears as soon as a ship exists.
    expect(scene.effects.consumeMysteryUfoSpawns()).toBe(1);

    // Re-queue and add a ship: the next step spawns it.
    scene.effects.applyCollect('mystery_ufo');
    scene.addPlayer({ x: 320, y: 240 });
    scene.runUpdateDroneSpawning(1 / 60);
    expect(scene.getDrones()).toHaveLength(1);
  });
});

// ── Scene lifecycle: shared effect teardown (AH-0MVNTY0700053T9E) ────

/**
 * The Phase Shift treatment owns a camera-filter driver that a plain overlay
 * registry sweep cannot reach. A scene `SHUTDOWN` must therefore go through
 * the treatment's own `destroy()` — otherwise a WebGL camera keeps the phase
 * distortion (and its controllers) into a restarted scene.
 */
describe('CombatCoreScene — SHUTDOWN releases the shared Phase Shift treatment (AH-0MVNTY0700053T9E)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
  });

  async function boot(): Promise<StubCoreScene> {
    const booted = await bootScene([StubCoreScene]);
    games.push(booted);
    return booted.scene as unknown as StubCoreScene;
  }

  it('destroys the treatment (and therefore clears its camera filters) on teardown', async () => {
    const scene = await boot();
    const destroy = vi.fn();
    const overlayDestroy = vi.fn();
    // The overlay registry may still hold a leftover; teardown must destroy
    // that too, but the filter-owning driver is only reachable via destroy().
    (scene as unknown as { phaseShiftJuice: unknown }).phaseShiftJuice = {
      destroy,
    };
    (scene as unknown as { phaseShiftEffects: unknown[] }).phaseShiftEffects = [
      { destroy: overlayDestroy },
    ];

    scene.runTeardownRunState();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(overlayDestroy).toHaveBeenCalledTimes(1);
    expect(
      (scene as unknown as { phaseShiftJuice: unknown }).phaseShiftJuice,
    ).toBeNull();
    expect(
      (scene as unknown as { phaseShiftEffects: unknown[] }).phaseShiftEffects,
    ).toHaveLength(0);
  });

  it('a second teardown is safe — no double destroy, no throw', async () => {
    const scene = await boot();
    const destroy = vi.fn();
    (scene as unknown as { phaseShiftJuice: unknown }).phaseShiftJuice = {
      destroy,
    };

    scene.runTeardownRunState();
    expect(() => scene.runTeardownRunState()).not.toThrow();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
