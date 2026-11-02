/**
 * Orbital Strike no-silent-waste retention tests (AH-0MVS2SW8V007ZBJQ).
 *
 * **REGRESSION (parent AC3 / AH-0MVS2T2DJ0069C0Y).** The shared strike path
 * (`CombatCoreScene._updateOrbitalStrike` → `CombatScene.onOrbitalStrike`)
 * **retains** a due bolt while no live enemy (or no live player) is
 * available, and lands it — exactly once — on the first frame with a valid
 * target. Implemented by AH-0MVS2T2DJ0069C0Y: the registry latches a decided
 * bolt until the shared core acknowledges it via `resolveStrike()`.
 *
 * These are shared-core regression tests: they drive the *real* shared
 * `_updateOrbitalStrike` / `onOrbitalStrike` implementation through a stub
 * combat scene (the same harness shape as
 * `enemyForceFieldDamageSources.test.ts`), so the retention behaviour the
 * game inherits is exactly the behaviour pinned here — no scene-specific
 * copy can drift out of it.
 *
 * The acknowledgement surface read here by name (`resolveStrike` on the
 * effects registry) is the retention contract documented in
 * AH-0MVS2T2DJ0069C0Y; the scene/core ack is exercised implicitly: a bolt
 * "lands" when the enemy takes `strikeDamage()` hits.
 *
 * @module scenes/core/orbitalStrikeRetention.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { BaseEnemy, type BaseEnemyConfig } from '../../entities/BaseEnemy';
import { Player } from '../../entities/Player';
import { EffectsRegistry } from '../../powerups/effects';
import { PowerUp } from '../../powerups/PowerUp';
import { beatPeriodMs } from '../../utils/beat';
import type { FormationOffset } from '../../utils/formations';
import {
  CombatScene,
  type CombatDrop,
  type CombatEnemyBullet,
} from './CombatScene';

// The shared strike step reads the player's control scheme, so seed the
// fourDirectional scheme exactly as the sibling CombatScene suites do.
beforeEach(() => {
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
});

const OFFSET: FormationOffset = { row: 0, col: 0 };

/**
 * A live enemy that counts every hull hit it takes, so a test can prove a
 * bolt landed (and how many landed) without restating the strike damage.
 */
class StrikeTarget extends BaseEnemy {
  /** Total `takeDamage` hits absorbed since spawn (readable observable). */
  hits = 0;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    const config: BaseEnemyConfig = {
      formationOffset: OFFSET,
      size: 16,
      color: 0x00ff00,
      // Generous hull so a single bolt (and the couple in the interval
      // scenario) never destroy the target mid-assertion.
      health: 10,
    };
    super(scene, x, y, config);
  }

  override takeDamage(): number {
    this.hits += 1;
    return super.takeDamage();
  }

  protected getExplosionPatternName(): string {
    return 'scout';
  }

  protected _drawBody(): void {
    // No body needed: the retention contract is state, not pixels.
  }
}

/** A live asteroid: targetable by every other weapon, never by a strike. */
class AsteroidTarget extends StrikeTarget {
  override get archetype(): string {
    return 'asteroid';
  }
}

/** Minimal enemy bullet (the base class requires the participant shape). */
class StubBullet implements CombatEnemyBullet {
  readonly graphics: Phaser.GameObjects.Graphics;
  vx = 0;
  vy = 0;

  constructor(scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
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
 * uses the *real* shared `_updateOrbitalStrike` / `onOrbitalStrike` (it
 * overrides neither), so the retention semantics inherited by `PlayScene`
 * and every gym are what these tests pin.
 */
class OrbitalRetentionScene extends CombatScene<
  StrikeTarget,
  StubBullet,
  StubDrop
> {
  entities: StrikeTarget[] = [];
  bullets: StubBullet[] = [];
  playerRef: Player | null = null;
  effects = new EffectsRegistry();

  constructor() {
    super({ key: 'OrbitalRetentionScene' });
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
  protected getEnemyEntities(): readonly StrikeTarget[] {
    return this.entities;
  }
  protected getEnemyBullets(): readonly StubBullet[] {
    return this.bullets;
  }
  protected setEnemyBullets(bullets: StubBullet[]): void {
    this.bullets = bullets;
  }

  // ── Public wrappers for the protected template methods ───────────
  addPlayer(at: { x: number; y: number }): Player {
    const player = new Player(this, { x: at.x, y: at.y });
    this.add.existing(player);
    this.playerRef = player;
    return player;
  }
  removePlayer(): void {
    this.playerRef = null;
  }
  addEnemy(x: number, y: number): StrikeTarget {
    const enemy = new StrikeTarget(this, x, y);
    this.entities.push(enemy);
    return enemy;
  }
  /** Adds a live asteroid-shaped entity to the same field. */
  addAsteroid(x: number, y: number): AsteroidTarget {
    const rock = new AsteroidTarget(this, x, y);
    this.entities.push(rock);
    return rock;
  }
  /**
   * Runs the shared strike step for `seconds` of frame time (fixed dt), the
   * same seam `_tickPlayer` drives each frame.
   */
  runStrikeFrames(seconds: number, dt = 1 / 60): void {
    const frames = Math.round(seconds / dt);
    for (let i = 0; i < frames; i += 1) this._updateOrbitalStrike(dt);
  }
  /** The shared run-reset seam (clears a latched bolt on restart). */
  resetRun(): void {
    this.resetRunState();
  }
}

describe('Orbital Strike retention — no live enemy (parent AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<OrbitalRetentionScene> {
    booted = await bootScene([OrbitalRetentionScene]);
    return booted.scene as OrbitalRetentionScene;
  }

  it('retains a queued bolt while no enemy is alive and lands it on the next one, exactly once', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const damage = scene.effects.strikeDamage();
    scene.effects.applyCollect('strike');

    // Picked up between waves: frames tick past with no live enemy — the
    // bolt must NOT be silently consumed.
    scene.runStrikeFrames(2);
    expect(scene.entities).toHaveLength(0);

    // The next enemy to appear becomes the bolt's target.
    const target = scene.addEnemy(player.x + 60, player.y);
    scene.runStrikeFrames(1);
    expect(target.hits).toBe(damage);

    // A field pickup is one bolt: it never re-fires.
    scene.runStrikeFrames(5);
    expect(target.hits).toBe(damage);
  });

  it('a permanent strike banks at most one bolt across a long enemy-free gap', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const damage = scene.effects.strikeDamage();
    const interval = scene.effects.strikeInterval();
    scene.effects.applyCollect('strike', true);

    // Several intervals pass with nobody to hit — at most ONE bolt may be
    // retained (a permanent strike simply resumes its interval).
    scene.runStrikeFrames(interval * 2 + 1, 0.1);

    const near = scene.addEnemy(player.x + 60, player.y);
    const far = scene.addEnemy(player.x + 240, player.y);
    scene.runStrikeFrames(1);

    // The single retained bolt lands on the nearest live enemy…
    expect(near.hits).toBe(damage);
    expect(far.hits).toBe(0);
    // …and the interval then resumes: exactly one more bolt next interval,
    // not the whole banked gap's worth.
    scene.runStrikeFrames(interval + 0.5, 0.1);
    expect(near.hits).toBe(damage * 2);
    expect(far.hits).toBe(0);
  });
});

describe('Orbital Strike retention — no live player (parent AC3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<OrbitalRetentionScene> {
    booted = await bootScene([OrbitalRetentionScene]);
    return booted.scene as OrbitalRetentionScene;
  }

  it('retains a queued bolt while no player is alive and lands it once a player exists', async () => {
    const scene = await boot();
    const target = scene.addEnemy(320, 200);
    const damage = scene.effects.strikeDamage();
    scene.effects.applyCollect('strike');

    // No ship: the due bolt must wait, not vanish.
    scene.runStrikeFrames(2);
    expect(target.hits).toBe(0);

    // The respawned ship is all a bolt needs — it lands on the next frame.
    scene.addPlayer({ x: 480, y: 270 });
    scene.runStrikeFrames(1);
    expect(target.hits).toBe(damage);

    // Still one bolt, never a volley.
    scene.runStrikeFrames(5);
    expect(target.hits).toBe(damage);
  });
});

describe('Orbital Strike retention — run reset clears a latched bolt', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<OrbitalRetentionScene> {
    booted = await bootScene([OrbitalRetentionScene]);
    return booted.scene as OrbitalRetentionScene;
  }

  it('a bolt latched before a restart never lands in the fresh run', async () => {
    const scene = await boot();
    const damage = scene.effects.strikeDamage();
    scene.addPlayer({ x: 480, y: 270 });
    scene.effects.applyCollect('strike');
    scene.runStrikeFrames(1); // bolt is due, no enemy to hit

    scene.resetRun(); // restart: nothing may survive into the new run

    const target = scene.addEnemy(320, 200);
    scene.runStrikeFrames(2);
    expect(target.hits).toBe(0);

    // Control: a pickup collected *after* the restart lands normally.
    scene.effects.applyCollect('strike');
    scene.runStrikeFrames(1);
    expect(target.hits).toBe(damage);
  });
});

describe('Orbital Strike targets the nearest enemy, never an asteroid (AH-0MVU3341U001B40T)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<OrbitalRetentionScene> {
    booted = await bootScene([OrbitalRetentionScene]);
    return booted.scene as OrbitalRetentionScene;
  }

  it('lands on the nearest enemy even when an asteroid is closer to the ship', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const damage = scene.effects.strikeDamage();

    // REGRESSION (producer rejection): the rock is the *nearest* entity, so
    // the old nearest-entity loop burned the bolt on it.
    const rock = scene.addAsteroid(player.x + 20, player.y);
    const enemy = scene.addEnemy(player.x + 180, player.y);

    scene.effects.applyCollect('strike');
    scene.runStrikeFrames(1);

    expect(enemy.hits).toBe(damage);
    expect(rock.hits).toBe(0);
  });

  it('retains the bolt while only asteroids are live, then lands it on the next enemy', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const damage = scene.effects.strikeDamage();
    const rock = scene.addAsteroid(player.x + 40, player.y);

    scene.effects.applyCollect('strike');
    // An asteroid-only field is "no enemy": the pickup must not be wasted on
    // rock, and it must not be consumed either.
    scene.runStrikeFrames(3);
    expect(rock.hits).toBe(0);

    const enemy = scene.addEnemy(player.x - 120, player.y);
    scene.runStrikeFrames(1);
    expect(enemy.hits).toBe(damage);
    expect(rock.hits).toBe(0);

    // Still one bolt — the retained bolt never becomes a volley.
    scene.runStrikeFrames(5);
    expect(enemy.hits).toBe(damage);
    expect(rock.hits).toBe(0);
  });
});

describe('Orbital Strike cadence is evidence-backed end-to-end (AH-0MVU3341U001B40T)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<OrbitalRetentionScene> {
    booted = await bootScene([OrbitalRetentionScene]);
    return booted.scene as OrbitalRetentionScene;
  }

  it('lands a permanent bolt every 9 beats (~7 s) through the real shared step', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });
    const target = scene.addEnemy(player.x + 120, player.y);
    const beatSeconds = beatPeriodMs() / 1000; // 0.75 s at the default 80 BPM
    const expected = 9 * beatSeconds; // 6.75 s — the producer's "approx 7 s"

    // The registry and the shared step agree on the cadence …
    expect(scene.effects.strikeInterval()).toBeCloseTo(expected, 12);

    scene.effects.applyCollect('strike', true); // hold-full (permanent) reward

    // … and the *observed* bolt-to-bolt gap, measured frame by frame through
    // the real `_updateOrbitalStrike` → `onOrbitalStrike` path, matches it.
    const step = 1 / 60;
    const windows = Math.round((expected * 3 + 0.5) / step);
    const landings: number[] = [];
    let previous = target.hits;
    for (let frame = 0; frame < windows; frame += 1) {
      scene.runStrikeFrames(step, step);
      if (target.hits > previous) {
        previous = target.hits;
        landings.push((frame + 1) * step);
      }
    }

    // The opening bolt lands at once, then one per interval: 4 bolts in ~20 s.
    expect(landings).toHaveLength(4);
    const gaps = landings.slice(1).map((at, i) => at - landings[i]);
    for (const gap of gaps) {
      expect(Math.abs(gap - expected)).toBeLessThanOrEqual(step + 1e-9);
    }
  });
});

describe('Orbital Strike keeps its decision-time damage (AH-0MVUGI448000GNMJ)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<OrbitalRetentionScene> {
    booted = await bootScene([OrbitalRetentionScene]);
    return booted.scene as OrbitalRetentionScene;
  }

  it('lands a latched bolt for its pickup-time damage after its window expires', async () => {
    const scene = await boot();
    const player = scene.addPlayer({ x: 480, y: 270 });

    // Permanently owned strike (upgrade level 0) plus a field pickup
    // (upgrade level 1): the pickup-time bolt is worth more than the
    // reverted level.
    scene.effects.applyCollect('strike', true);
    scene.effects.applyCollect('strike');
    const pickupDamage = scene.effects.strikeDamage();

    // No live enemy: the bolt is latched, not wasted.
    scene.runStrikeFrames(1);
    expect(scene.entities).toHaveLength(0);

    // The temporary level window EXPIRES while the bolt is still waiting.
    scene.effects.tick(11);
    expect(scene.effects.powerUpLevel('strike')).toBe(1);
    expect(scene.effects.strikeDamage()).toBe(pickupDamage);

    // A target appears: the bolt lands for its decision-time damage.
    const target = scene.addEnemy(player.x + 60, player.y);
    scene.runStrikeFrames(1);
    expect(target.hits).toBe(pickupDamage);

    // The next (permanent-cadence) bolt uses the reverted level.
    const interval = scene.effects.strikeInterval();
    const before = target.hits;
    scene.runStrikeFrames(interval + 0.5, 0.1);
    expect(target.hits - before).toBe(scene.effects.strikeDamage());
  });
});
