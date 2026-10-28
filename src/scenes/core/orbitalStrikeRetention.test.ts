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
