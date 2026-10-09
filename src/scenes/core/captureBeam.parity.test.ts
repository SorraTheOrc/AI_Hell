import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { CombatCoreScene, type CombatEnemyEntity } from './CombatCoreScene';
import { CombatScene } from './CombatScene';
import { PlayScene } from '../PlayScene';
import { GymFormationScene } from '../gym/core/GymFormationScene';
import {
  collectProductionSourceFiles,
  definesMethod,
} from '../../test/duplicateBodyGuard';
import { Player } from '../../entities/Player';
import { Capturer, CapturerState } from '../../entities/Capturer';
import { GymEnemies } from '../gym/GymEnemies';
import { GameOverScene } from '../GameOverScene';
import { MenuScene } from '../MenuScene';
import { DEFAULT_ENEMY_CONFIGS } from '../../core/enemyConfig';
import { resetConfigStore, seedConfigStore } from '../../core/configStore';
import {
  createCaptureBeam,
  DEFAULT_CAPTURE_DISABLE_MS,
  DEFAULT_CAPTURE_HOLD_MS,
  type CaptureBeamState,
} from './captureBeam';

/**
 * Shared tractor-beam seam tests (Galaga capturer, AH-0MV01EFII008298D).
 *
 * The capture effect is implemented **once** in `CombatCoreScene`
 * (`_updateCaptureBeams`) and consumed by the game and every player-bearing
 * gym. These tests prove the shared implementation is the only one, that it
 * applies the bounded pull / temporary capture / escape, and that it never
 * affects other enemies.
 */

/** A minimal beam-emitting enemy that satisfies `CombatEnemyEntity`. */
class StubBeamEnemy
  extends Phaser.GameObjects.Container
  implements CombatEnemyEntity
{
  alive = true;
  damageTaken = 0;
  captureNotifications = 0;
  beam: CaptureBeamState | null = null;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    scene.add.existing(this);
  }

  getHitRadius(): number {
    return 10;
  }

  destroySelf(): void {
    this.alive = false;
  }

  takeDamage(): number {
    this.damageTaken += 1;
    return 0;
  }

  getCaptureBeam(): CaptureBeamState | null {
    return this.beam;
  }

  notifyPlayerCaptured(): void {
    this.captureNotifications += 1;
    // Mimic the real Capturer: a completed capture ends the beam.
    this.beam = null;
  }
}

/** A non-emitting enemy for the "beam never affects enemies" test. */
class StubPlainEnemy
  extends Phaser.GameObjects.Container
  implements CombatEnemyEntity
{
  alive = true;
  damageTaken = 0;

  constructor(scene: Phaser.Scene, x: number, y: number) {
    super(scene, x, y);
    scene.add.existing(this);
  }

  getHitRadius(): number {
    return 10;
  }

  destroySelf(): void {
    this.alive = false;
  }

  takeDamage(): number {
    this.damageTaken += 1;
    return 0;
  }
}

/** Concrete `CombatCoreScene` harness exposing the shared capture step. */
class CaptureHarnessScene extends CombatCoreScene {
  private player: Player | null = null;
  private enemies: CombatEnemyEntity[] = [];
  autoFireCount = 0;

  constructor() {
    super('CaptureHarnessScene');
  }

  create(): void {
    this.player = new Player(this, { x: 300, y: 500 });
  }

  override getPlayer(): Player | null {
    return this.player;
  }

  override getEnemyEntities(): readonly CombatEnemyEntity[] {
    return this.enemies;
  }

  protected override _autoFire(dt: number): void {
    this.autoFireCount += 1;
    super._autoFire(dt);
  }

  setEnemies(enemies: CombatEnemyEntity[]): void {
    this.enemies = enemies;
  }

  stepCapture(dt: number): void {
    this._updateCaptureBeams(dt);
  }

  stepPlayer(dt: number): void {
    this._tickPlayer(dt);
  }
}

describe('shared capture-beam seam — defined once in the shared core', () => {
  it('is hosted only by CombatCoreScene repo-wide', () => {
    const files = collectProductionSourceFiles(
      path.resolve(process.cwd(), 'src/scenes'),
    );
    const definers = files
      .filter((file) =>
        definesMethod(fs.readFileSync(file, 'utf8'), '_updateCaptureBeams'),
      )
      .map((file) => path.relative(process.cwd(), file))
      .sort();
    expect(definers).toEqual(['src/scenes/core/CombatCoreScene.ts']);
  });

  it('the game and the player-bearing gym resolve to the same shared function object', () => {
    const core = CombatCoreScene.prototype as unknown as Record<string, unknown>;
    for (const [name, prototype] of [
      ['PlayScene', PlayScene.prototype],
      ['GymFormationScene', GymFormationScene.prototype],
      ['CombatScene', CombatScene.prototype],
    ] as const) {
      expect(
        Object.prototype.hasOwnProperty.call(prototype, '_updateCaptureBeams'),
        `${name} must not define its own _updateCaptureBeams`,
      ).toBe(false);
      expect(
        (prototype as unknown as Record<string, unknown>)._updateCaptureBeams,
        `${name} must resolve to the shared core`,
      ).toBe(core._updateCaptureBeams);
    }
  });

  it('the shared player-control step drives the capture step before auto-fire', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/core/CombatCoreScene.ts'),
      'utf8',
    );
    expect(source).toContain('this._updateCaptureBeams(dt)');
    expect(source).toContain('!this.isCaptureDisabled()');
  });
});

describe('shared capture-beam seam — behaviour (game and gym run one implementation)', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    vi.clearAllMocks();
  });

  async function bootHarness(): Promise<CaptureHarnessScene> {
    const booted = await bootScene([CaptureHarnessScene]);
    games.push(booted);
    return booted.scene as unknown as CaptureHarnessScene;
  }

  function wireBeam(
    scene: CaptureHarnessScene,
    x = 300,
    topY = 200,
    pullStrength = 90,
  ): StubBeamEnemy {
    const enemy = new StubBeamEnemy(scene, x, topY);
    enemy.beam = createCaptureBeam(x, topY, {
      durationMs: 60_000,
      length: 400,
      width: 80,
      pullStrength,
    });
    scene.setEnemies([enemy]);
    return enemy;
  }

  it('applies a bounded pull toward the beam origin (the player is dragged off course)', async () => {
    const scene = await bootHarness();
    wireBeam(scene);
    const player = scene.getPlayer()!;
    player.respawn(300, 500);
    const startY = player.y;

    scene.stepCapture(0.1);

    // Pulled straight up toward the capturer, by at most pullSpeed * dt.
    expect(player.y).toBeLessThan(startY);
    expect(startY - player.y).toBeLessThanOrEqual(90 * 0.1 + 1e-6);
    expect(player.x).toBeCloseTo(300, 5);
  });

  it('leaves the player untouched when outside the beam', async () => {
    const scene = await bootHarness();
    wireBeam(scene);
    const player = scene.getPlayer()!;
    player.respawn(900, 500); // far outside the 80 px corridor
    const before = player.getMovementState();

    scene.stepCapture(0.1);

    expect(player.getMovementState().x).toBeCloseTo(before.x, 5);
    expect(player.getMovementState().y).toBeCloseTo(before.y, 5);
    expect(scene.isCaptureDisabled()).toBe(false);
  });

  it('captures after a continuous hold and triggers the temporary, non-fatal effect', async () => {
    const scene = await bootHarness();
    const enemy = wireBeam(scene);
    const player = scene.getPlayer()!;
    player.respawn(300, 500);

    // Each step is 0.1 s; hold one step short of the threshold.
    const justUnder = Math.ceil(DEFAULT_CAPTURE_HOLD_MS / 100) - 1;
    for (let i = 0; i < justUnder; i++) scene.stepCapture(0.1);
    expect(scene.isCaptureDisabled()).toBe(false);
    expect(enemy.captureNotifications).toBe(0);

    // Crossing the threshold captures and tells the emitting entity.
    scene.stepCapture(0.1);
    expect(scene.isCaptureDisabled()).toBe(true);
    expect(enemy.captureNotifications).toBe(1);
  });

  it('lets the player escape by leaving the beam before the hold fills', async () => {
    const scene = await bootHarness();
    wireBeam(scene);
    const player = scene.getPlayer()!;
    player.respawn(300, 500);

    // Build up most of the hold, then leave the beam for one frame.
    const justUnder = Math.ceil(DEFAULT_CAPTURE_HOLD_MS / 100) - 1;
    for (let i = 0; i < justUnder; i++) scene.stepCapture(0.1);
    player.respawn(900, 500);
    scene.stepCapture(0.1);

    // Re-enter: the hold restarted, so a short re-entry does NOT capture.
    player.respawn(300, 500);
    scene.stepCapture(0.1);
    expect(scene.isCaptureDisabled()).toBe(false);
  });

  it('suppresses auto-fire while captured and restores it when the effect expires', async () => {
    const scene = await bootHarness();
    wireBeam(scene);
    const player = scene.getPlayer()!;
    player.respawn(300, 500);

    for (let i = 0; i < 10; i++) scene.stepCapture(0.1);
    expect(scene.isCaptureDisabled()).toBe(true);

    // Auto-fire is suppressed while the capture penalty is live.
    const before = scene.autoFireCount;
    scene.stepPlayer(0.05);
    expect(scene.autoFireCount).toBe(before);

    // After the penalty expires (and the beam has ended on capture), fire resumes.
    scene.stepPlayer(DEFAULT_CAPTURE_DISABLE_MS / 1000 + 0.05);
    expect(scene.isCaptureDisabled()).toBe(false);
    expect(scene.autoFireCount).toBeGreaterThan(before);
  });

  it('never damages or captures another enemy caught in the beam (no enemy-enemy interaction)', async () => {
    const scene = await bootHarness();
    const emitter = wireBeam(scene);
    const innocent = new StubPlainEnemy(scene, 310, 400); // inside the corridor
    scene.setEnemies([emitter, innocent]);
    const player = scene.getPlayer()!;
    player.respawn(300, 500);

    for (let i = 0; i < 12; i++) scene.stepCapture(0.1);

    // The capture landed and the player was dragged, yet the other enemy is
    // completely untouched: the beam has no enemy-capture/enemy-damage path.
    expect(scene.isCaptureDisabled()).toBe(true);
    expect(innocent.alive).toBe(true);
    expect(innocent.damageTaken).toBe(0);
  });
});

// ── Real scenes: the game and the player-bearing gym both run the beam ──
/** Drives a capturer through hold + approach until its beam is active. */
function driveToBeam(
  scene: { tick(dt: number): void },
  capturer: Capturer,
): void {
  for (let i = 0; i < 300 && capturer.behaviourState !== CapturerState.BEAM; i++) {
    scene.tick(0.1);
  }
  expect(capturer.behaviourState).toBe(CapturerState.BEAM);
}

describe('capture beam — the game and the player-bearing gym both run it', () => {
  const games: BootedGame[] = [];

  afterEach(() => {
    for (const game of games.splice(0)) game.game.destroy(true);
    resetConfigStore();
    vi.restoreAllMocks();
  });

  async function bootGymCapturer(): Promise<GymEnemies> {
    resetConfigStore();
    seedConfigStore(Object.values(DEFAULT_ENEMY_CONFIGS));
    class Wrapper extends GymEnemies {
      override init(): void {
        super.init({ enemyKey: 'capturer' });
      }
    }
    Object.defineProperty(Wrapper, 'name', { value: 'CapturerParityGym' });
    const booted = await bootScene([Wrapper as unknown as typeof Phaser.Scene]);
    games.push(booted);
    const scene = booted.scene as unknown as GymEnemies;
    // Suppress player fire so the test isolates the beam interaction: a live
    // auto-firing player would destroy the 2-HP capturer before the capture
    // hold fills, which is valid gameplay but not what this test asserts.
    vi.spyOn(
      scene as unknown as { spawnPlayerBullet: (...args: unknown[]) => unknown },
      'spawnPlayerBullet',
    ).mockReturnValue({} as never);
    return scene;
  }

  async function bootPlayCapturer(): Promise<PlayScene> {
    const booted = await bootScene(
      [PlayScene, GameOverScene, MenuScene],
      'capture-parity-play-host',
    );
    games.push(booted);
    const scene = booted.scene as PlayScene;
    // Keep the wave clear of other enemies and suppress player fire so the
    // test isolates the beam interaction.
    (scene as unknown as { spawned: unknown[] }).spawned.length = 0;
    vi.spyOn(
      scene as unknown as { spawnPlayerBullet: (...args: unknown[]) => unknown },
      'spawnPlayerBullet',
    ).mockReturnValue({} as never);

    const player = scene.getPlayer()!;
    player.respawn(480, 270);
    const capturer = new Capturer(scene, {
      x: 480,
      y: 108,
      formationOffset: { row: 0, col: 0 },
      beamDuration: 1800,
      pullStrength: 90,
    });
    (
      scene as unknown as { spawned: Array<Record<string, unknown>> }
    ).spawned.push({
      entity: capturer,
      enemyKey: 'capturer',
      startX: 480,
      startY: 108,
      spacingX: 0,
      spacingY: 0,
    });
    return scene;
  }

  it('GymEnemies — the capturer’s beam drags the live player and captures it', async () => {
    const scene = await bootGymCapturer();
    const player = scene.getPlayer()!;
    player.respawn(480, 270);
    const capturer = scene.formationEntities[0] as unknown as Capturer;
    expect(capturer.archetype).toBe('capturer');

    driveToBeam(scene, capturer);

    const before = player.y;
    scene.tick(0.1);
    expect(player.y).toBeLessThan(before); // dragged up toward the capturer

    // Held in the beam past the capture threshold → temporary capture.
    for (let i = 0; i < 12; i++) scene.tick(0.1);
    expect(scene.isCaptureDisabled()).toBe(true);
  });

  it('PlayScene — the same shared beam drags the live player in the game', async () => {
    const scene = await bootPlayCapturer();
    const player = scene.getPlayer()!;
    const capturer = (
      scene as unknown as { spawned: Array<{ entity: Capturer }> }
    ).spawned[0].entity;

    driveToBeam(scene, capturer);

    const before = player.y;
    scene.tick(0.1);
    expect(player.y).toBeLessThan(before);

    for (let i = 0; i < 12; i++) scene.tick(0.1);
    expect(scene.isCaptureDisabled()).toBe(true);
  });
});
