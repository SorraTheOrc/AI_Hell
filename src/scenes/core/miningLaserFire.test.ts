/**
 * Shared Mining Laser fire-step tests (AH-0MW9QMP2P0032BWW, parent **Mining
 * laser** AH-0MW81181P007BDRU).
 *
 * These are shared-core tests: they drive the *real* shared
 * `CombatCoreScene._updateMiningLaser` and the real `CombatScene.onMiningLaserFire`
 * through a stub combat scene (the same harness shape as
 * `orbitalStrikeRetention.test.ts`), so the behaviour `PlayScene` and every gym
 * inherit is exactly what is pinned here — no scene-specific copy can drift out
 * of it.
 *
 * The fire step is the deliberate inverse of the Orbital Strike: the laser
 * auto-fires at the nearest live **asteroid** (never an enemy), is silent when
 * no asteroid exists, retargets on the next shot after a kill, and resolves its
 * level damage through the shared kill seam exactly once per shot
 * (`damageEnemyViaAoe`).
 *
 * @module scenes/core/miningLaserFire.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../../audio/effects';
import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { Player } from '../../entities/Player';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { beatPeriodMs, SIXTEENTH_NOTE_SUBDIVISIONS } from '../../utils/beat';
import type { FormationOffset } from '../../utils/formations';
import {
  CombatScene,
  type CombatDrop,
  type CombatEnemyBullet,
} from './CombatScene';

// The shared step reads the player's control scheme, so seed the
// fourDirectional scheme exactly as the sibling CombatScene suites do.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

const OFFSET: FormationOffset = { row: 0, col: 0 };

/**
 * A live body whose archetype is configurable, counting every hull hit it takes
 * so a test can prove a shot landed (and how many landed) without restating the
 * level damage.
 */
class MiningTarget extends BaseEnemy {
  /** Total `takeDamage` hits absorbed since spawn (readable observable). */
  hits = 0;

  constructor(
    scene: Phaser.Scene,
    x: number,
    y: number,
    hull: number,
    private readonly _archetype: string,
  ) {
    const config: BaseEnemyConfig = {
      formationOffset: OFFSET,
      size: 16,
      color: 0x00ff00,
      health: hull,
    };
    super(scene, x, y, config);
  }

  override get archetype(): string {
    return this._archetype;
  }

  override takeDamage(): number {
    this.hits += 1;
    return super.takeDamage();
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // No body needed: the fire-step contract is state, not pixels.
  }
}

/** Minimal enemy bullet (the base class requires the participant shape). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Image;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene) {
    // Bullets are cached-texture sprites (AH-0MW2DAY2L004QSKF).
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

/**
 * Stub combat scene wiring the participant contract to test-owned state. It
 * uses the *real* shared `_updateMiningLaser` / `onMiningLaserFire` (it
 * overrides neither), so the fire-step semantics inherited by `PlayScene` and
 * every gym are what these tests pin.
 */
class MiningFireScene extends CombatScene<
  MiningTarget,
  StubBullet,
  StubDrop
> {
  entities: MiningTarget[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();
  /** Enemies whose kill was finalised through the shared kill seam. */
  destroyed: MiningTarget[] = [];

  constructor() {
    super({ key: 'MiningFireScene' });
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
  protected getEnemyEntities(): readonly MiningTarget[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }
  protected override onEnemyDestroyed(enemy: MiningTarget): void {
    this.destroyed.push(enemy);
  }

  // ── Public wrappers for the protected template methods ───────────
  addPlayer(at: { x: number; y: number }): Player {
    const player = new Player(this, { x: at.x, y: at.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  addAsteroid(x: number, y: number, health = 5): MiningTarget {
    const rock = new MiningTarget(this, x, y, health, 'asteroid');
    this.entities.push(rock);
    return rock;
  }
  addEnemy(x: number, y: number, health = 5): MiningTarget {
    const enemy = new MiningTarget(this, x, y, health, 'scout');
    this.entities.push(enemy);
    return enemy;
  }
  /**
   * Runs the shared mining-laser step for `seconds` of frame time (fixed dt),
   * the same seam `_tickPlayer` drives each frame.
   */
  runMiningFrames(seconds: number, dt = 1 / 60): void {
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i += 1) this._updateMiningLaser(dt);
  }
  /** Runs the full shared `_tickPlayer` step (proves the call-site wiring). */
  runTickPlayer(dt: number): void {
    this._tickPlayer(dt);
  }
  /** Live AOE/VFX graphics (the registry the shared shot's beam joins). */
  beamRegistry(): readonly Phaser.GameObjects.Graphics[] {
    return this.aoeEffects;
  }
}

describe('Mining Laser fires only at asteroids (parent AC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  it('damages the nearest asteroid and ignores a nearer non-asteroid enemy', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    // The scout is nearer than the rock: the laser must skip it (parent AC).
    const scout = scene.addEnemy(player.x + 20, player.y);
    const rock = scene.addAsteroid(player.x + 180, player.y);

    scene.effects.applyCollect('mining_laser', true);
    scene.runMiningFrames(2.5);

    expect(rock.hits).toBeGreaterThan(0);
    expect(scout.hits).toBe(0);
    expect(scene.destroyed).not.toContain(scout);
  });

  it('never targets a non-asteroid body, even when it is the only body', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const scout = scene.addEnemy(player.x + 40, player.y);

    scene.effects.applyCollect('mining_laser', true);
    scene.runMiningFrames(3);

    expect(scout.hits).toBe(0);
    expect(scene.destroyed).toHaveLength(0);
  });
});

describe('Mining Laser is silent with no live asteroid (parent AC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  it('emits no shots on an empty field', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('mining_laser', true);

    // Several cadence intervals elapse: nothing may be banked or fired.
    scene.runMiningFrames(4);
    expect(scene.destroyed).toHaveLength(0);
    expect(scene.entities).toHaveLength(0);
  });

  it('emits no shots when only non-asteroid enemies are live', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const scout = scene.addEnemy(player.x + 30, player.y);
    const harvester = scene.addEnemy(player.x - 120, player.y, 50);

    scene.effects.applyCollect('mining_laser', true);
    scene.runMiningFrames(4);

    expect(scout.hits).toBe(0);
    expect(harvester.hits).toBe(0);
    expect(scene.destroyed).toHaveLength(0);
  });
});

describe('Mining Laser retargets on the next shot (parent AC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  it('retargets to the next nearest asteroid after a kill, with no wasted shot', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const interval = scene.effects.miningLaserInterval();
    scene.effects.applyCollect('mining_laser', true);
    const damage = scene.effects.miningLaserDamage();

    // The nearest rock is one-shot fragile; the far one survives.
    const near = scene.addAsteroid(player.x + 40, player.y, 1);
    const far = scene.addAsteroid(player.x + 220, player.y, 50);

    // First shot: the nearest rock dies.
    scene.runMiningFrames(1 / 60);
    expect(near.hits).toBe(1);
    expect(near.alive).toBe(false);
    expect(scene.destroyed).toEqual([near]);
    expect(far.hits).toBe(0);

    // Next due shot: the laser retargets to the surviving rock (no banked
    // shot, no wasted tick).
    scene.runMiningFrames(interval + 0.05, 1 / 120);
    expect(far.hits).toBe(damage);
    expect(scene.destroyed).toEqual([near]);
  });

  it('retargets to a nearer split child that spawns after the target dies', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const interval = scene.effects.miningLaserInterval();
    scene.effects.applyCollect('mining_laser', true);

    const parent = scene.addAsteroid(player.x + 40, player.y, 1);
    const far = scene.addAsteroid(player.x + 220, player.y, 50);

    // The parent is destroyed by the opening shot…
    scene.runMiningFrames(1 / 60);
    expect(parent.alive).toBe(false);

    // …and its split child appears nearer than the surviving rock.
    const child = scene.addAsteroid(player.x + 80, player.y, 50);

    // The next shot targets the child, not the once-next-nearest rock.
    scene.runMiningFrames(interval + 0.05, 1 / 120);
    expect(child.hits).toBeGreaterThan(0);
    expect(far.hits).toBe(0);
  });
});

describe('Mining Laser cadence is frame-rate independent (parent AC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  /**
   * Counts the shots the shared step lands over `seconds` via the target's
   * hull-hit counter. A generous hull means no shot destroys the target
   * mid-measurement.
   */
  function countShots(
    scene: MiningFireScene,
    target: MiningTarget,
    seconds: number,
    dt: number,
  ): number {
    scene.runMiningFrames(seconds, dt);
    return target.hits;
  }

  it('lands on the shared sixteenth-note lattice', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('mining_laser', true);

    const interval = scene.effects.miningLaserInterval();
    const step = beatPeriodMs() / 1000 / SIXTEENTH_NOTE_SUBDIVISIONS;
    // Every shot must sit on the same lattice the rest of the mix uses.
    expect(interval / step).toBeCloseTo(Math.round(interval / step), 12);
  });

  it('produces the same number of shots for the same elapsed time at different dt', async () => {
    // Five intervals plus a margin: the opening shot at once, then one per
    // interval — six shots in total, whichever way the frame clock is stepped.
    const fine = await boot();
    fine.addPlayer({ x: 480, y: 270 });
    fine.effects.applyCollect('mining_laser', true);
    const interval = fine.effects.miningLaserInterval();
    const elapsed = interval * 5 + 0.3;
    const expected = 6;
    const fineRock = fine.addAsteroid(600, 270, 1000);
    const fineShots = countShots(fine, fineRock, elapsed, 1 / 120);
    booted?.game.destroy(true);
    booted = null;

    const coarse = await boot();
    coarse.addPlayer({ x: 480, y: 270 });
    coarse.effects.applyCollect('mining_laser', true);
    const coarseRock = coarse.addAsteroid(600, 270, 1000);
    const coarseShots = countShots(coarse, coarseRock, elapsed, 1 / 30);

    expect(fineShots).toBe(expected);
    expect(coarseShots).toBe(expected);
    expect(fineShots).toBe(coarseShots);
  });

  it('fires the first shot immediately and then one per interval', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('mining_laser', true);
    const interval = scene.effects.miningLaserInterval();
    const rock = scene.addAsteroid(600, 270, 1000);

    scene.runMiningFrames(1 / 60);
    expect(rock.hits).toBe(1);

    scene.runMiningFrames(interval * 2 + 0.1, 1 / 120);
    // Two more shots land over the next two intervals (opening + 2 = 3).
    expect(rock.hits).toBe(3);
  });
});

describe('Mining Laser resolves damage exactly once per shot (parent AC)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  it('applies one hull hit per shot, never a doubled kill', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const interval = scene.effects.miningLaserInterval();
    scene.effects.applyCollect('mining_laser', true);
    const rock = scene.addAsteroid(player.x + 80, player.y, 1000);

    scene.runMiningFrames(1 / 60);
    expect(rock.hits).toBe(1);

    // Two more cadence windows: exactly two more hull hits — the shot's
    // damage is not applied twice and the kill seam is not double-counted.
    scene.runMiningFrames(interval * 2 + 0.1, 1 / 120);
    expect(rock.hits).toBe(3);
  });

  it('finalises a kill exactly once and never re-finalises the dead rock', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const interval = scene.effects.miningLaserInterval();
    scene.effects.applyCollect('mining_laser', true);
    const rock = scene.addAsteroid(player.x + 80, player.y, 1);

    scene.runMiningFrames(1 / 60);
    expect(rock.hits).toBe(1);
    expect(rock.alive).toBe(false);
    expect(scene.destroyed).toEqual([rock]);

    // Further cadence ticks must not re-finalise the already-dead rock (no
    // live asteroid remains, so the step stays silent).
    scene.runMiningFrames(interval * 2 + 0.1, 1 / 120);
    expect(scene.destroyed).toEqual([rock]);
    expect(rock.hits).toBe(1);
  });
});

describe('Mining Laser step is driven from the shared _tickPlayer', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  it('lands a shot when the full shared player tick runs', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('mining_laser', true);
    const rock = scene.addAsteroid(player.x + 80, player.y, 1000);

    scene.runTickPlayer(1 / 60);
    expect(rock.hits).toBe(1);
  });
});

describe('Mining Laser shot shows the shared beam and cue (AH-0MW9QMQ7B005WFH9)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<MiningFireScene> {
    booted = await bootScene([MiningFireScene]);
    return booted.scene as MiningFireScene;
  }

  it('spawns one beam and plays one cue per shot through the shared hook', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('mining_laser', true);
    scene.addAsteroid(player.x + 80, player.y, 1000);
    const cueSpy = vi.spyOn(effectsModule, 'playMiningLaserFireSound');

    // Nothing is drawn or played before a shot is due.
    expect(scene.beamRegistry()).toHaveLength(0);
    scene.runMiningFrames(1 / 60);

    // The shot's feedback comes from the shared hook — the same code path
    // PlayScene and every gym inherit — so the beam and cue cannot be forked.
    expect(scene.beamRegistry()).toHaveLength(1);
    expect(cueSpy).toHaveBeenCalledTimes(1);

    cueSpy.mockRestore();
  });

  it('draws no beam and plays no cue when the laser has no asteroid to cut', async () => {
    const scene = await boot();
    scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('mining_laser', true);
    const cueSpy = vi.spyOn(effectsModule, 'playMiningLaserFireSound');

    scene.runMiningFrames(2);

    expect(scene.beamRegistry()).toHaveLength(0);
    expect(cueSpy).not.toHaveBeenCalled();

    cueSpy.mockRestore();
  });
});
