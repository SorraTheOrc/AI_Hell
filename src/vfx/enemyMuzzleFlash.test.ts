/**
 * Unit tests for the shared enemy launch-pop VFX (AH-0MV822CQL005R4MM).
 *
 * The enemy muzzle flash is the cheap fire-time cue an enemy shows at its
 * body when a shot leaves — the enemy side of the player's per-weapon
 * `spawnMuzzleFlash`, spawned from the entity's shared fire method (the
 * single fire seam every scene drives via `fireForEnemy`), so the game and
 * every gym pop identically. Lifecycle (create at the aim point, track in
 * the caller's registry, fade and self-destroy) is asserted here — the same
 * pattern as `vfx/muzzleFlash`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import {
  ENEMY_MUZZLE_FLASH_DURATION,
  spawnEnemyMuzzleFlash,
} from './enemyMuzzleFlash';

/** Minimal bootable scene for the VFX helper. */
class EnemyMuzzleStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'EnemyMuzzleStubScene' });
  }
}

const Cmd = {
  ARC: 0,
  BEGIN_PATH: 1,
  FILL_PATH: 8,
  STROKE_PATH: 9,
  LINE_TO: 4,
} as const;

/** Parameter count following each opcode (0 for path terminators). */
const CmdWidths: Record<number, number> = {
  [Cmd.ARC]: 7,
  [Cmd.BEGIN_PATH]: 0,
  [Cmd.FILL_PATH]: 0,
  [Cmd.STROKE_PATH]: 0,
  [Cmd.LINE_TO]: 2,
};

/** Counts occurrences of a command opcode in a Graphics command buffer. */
function countOps(buf: number[], target: number): number {
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (CmdWidths[buf[i]] ?? 0)) {
    if (buf[i] === target) count += 1;
  }
  return count;
}

describe('enemyMuzzleFlash — shared enemy fire-time launch pop', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([EnemyMuzzleStubScene]);
    return booted.scene;
  }

  it('spawns a pop at the enemy body facing the fire heading', async () => {
    const scene = await boot();

    const flash = spawnEnemyMuzzleFlash(scene, 210, 90, Math.PI / 2);

    expect(flash.x).toBe(210);
    expect(flash.y).toBe(90);
    expect(flash.rotation).toBeCloseTo(Math.PI / 2, 5);
    expect(scene.children.list).toContain(flash);
  });

  it('tracks the pop in the caller registry and fades it over the configured duration', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnEnemyMuzzleFlash(scene, 10, 20, 0, {
      registry,
      duration: 0.15,
    });

    expect(registry).toContain(flash);
    const config =
      tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(150);
    expect(config.targets).toBe(flash);
  });

  it('defaults to the shared brief duration', async () => {
    const scene = await boot();
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    spawnEnemyMuzzleFlash(scene, 10, 20, 0);

    const config =
      tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    expect(config.duration).toBe(ENEMY_MUZZLE_FLASH_DURATION * 1000);
  });

  it('removes the pop from the registry and destroys it when the fade completes', async () => {
    const scene = await boot();
    const registry: Phaser.GameObjects.Graphics[] = [];
    const tweenSpy = vi.spyOn(scene.tweens, 'add');

    const flash = spawnEnemyMuzzleFlash(scene, 10, 20, 0, { registry });
    const config =
      tweenSpy.mock.calls[0][0] as Phaser.Types.Tweens.TweenBuilderConfig;
    (config.onComplete as () => void)();

    expect(registry).not.toContain(flash);
    expect(flash.active).toBe(false);
  });

  it('renders a compact hot launch core plus the enemy-coloured burst', async () => {
    const scene = await boot();
    const buf = spawnEnemyMuzzleFlash(scene, 5, 5, 0, {
      color: 0x00ff66,
    }).commandBuffer as number[];

    // A hot core + tinted burst (≥ 2 filled discs) and a short aim pop (≥ 1
    // stroked path), all drawn as cheap Graphics primitives.
    expect(countOps(buf, Cmd.ARC)).toBeGreaterThanOrEqual(3);
    expect(countOps(buf, Cmd.FILL_PATH)).toBeGreaterThanOrEqual(2);
    expect(countOps(buf, Cmd.STROKE_PATH)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.BEGIN_PATH)).toBeGreaterThanOrEqual(1);
    expect(countOps(buf, Cmd.LINE_TO)).toBeGreaterThanOrEqual(2);
  });
});
