/**
 * Behaviour tests for the reusable-boot helper (`createReusableBoot`,
 * AH-0MVF6VZG9000AN6E).
 *
 * The helper lets heavy suites boot one Phaser game shell per file and reboot
 * into a **fresh scene instance** before each test, instead of constructing
 * and destroying a whole game per test. This file asserts the safety contract
 * that makes per-describe reuse acceptable: every `boot()` returns a *new*
 * scene instance (no scene-instance state can leak across tests), scene state
 * observed after a reboot matches a fresh per-test boot, and `dispose()`
 * releases the game.
 */

import { describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, createReusableBoot } from './gameHarness';
import { GymWeapons } from '../scenes/gym/GymWeapons';

/**
 * Minimal scene whose `create()` sets fresh state and whose `update()` counts
 * frames — used to prove that reboots start from a fresh instance.
 */
class CounterScene extends Phaser.Scene {
  hits = 0;
  createCount = 0;
  updateCount = 0;

  constructor() {
    super('CounterScene');
  }

  create(): void {
    this.createCount += 1;
  }

  update(): void {
    this.updateCount += 1;
  }

  /** Mutates instance state so a leaked instance would observably differ. */
  hit(): void {
    this.hits += 1;
  }
}

describe('createReusableBoot (AH-0MVF6VZG9000AN6E)', () => {
  it('first boot creates the game lazily and reports it on the pool', async () => {
    const pool = createReusableBoot('reuse-lazy-test');
    expect(pool.game).toBeNull();
    const first = await pool.boot([GymWeapons]);
    expect(pool.game).toBe(first.game);
    expect(first.scene).toBeInstanceOf(GymWeapons);
    pool.dispose();
  });

  it('every reboot returns a fresh scene instance on the same game shell', async () => {
    const pool = createReusableBoot('reuse-fresh-instances');
    try {
      const first = await pool.boot([GymWeapons]);
      const game = first.game;

      const scenes: Phaser.Scene[] = [first.scene];
      expect(first.scene.sys.isActive()).toBe(true);
      for (let i = 0; i < 3; i += 1) {
        const { game: g, scene } = await pool.boot([GymWeapons]);
        expect(g).toBe(game); // game shell reused
        expect(scene.sys.isActive()).toBe(true);
        scenes.push(scene);
      }
      // Every boot must produce a distinct instance — no state carry-over.
      expect(new Set(scenes).size).toBe(scenes.length);
      // `GymWeapons` drives the whole gym: a rebooted scene must still own a
      // player and the shared back button, not just be an empty shell.
      const last = scenes[scenes.length - 1] as GymWeapons;
      expect(last.getPlayer()).toBeDefined();
    } finally {
      pool.dispose();
    }
  });

  it('scene instance state does not leak across reboots', async () => {
    const pool = createReusableBoot('reuse-no-leak');
    try {
      const { game, scene } = await pool.boot([CounterScene]);
      const firstInstance = scene as CounterScene;
      firstInstance.hit();
      firstInstance.hit();
      expect(firstInstance.hits).toBe(2);
      expect(firstInstance.createCount).toBe(1);

      const { scene: rebooted } = await pool.boot([CounterScene]);
      const secondInstance = rebooted as CounterScene;
      // Fresh instance: create() has run exactly once and `hits` restarted.
      expect(secondInstance).not.toBe(firstInstance);
      expect(secondInstance.hits).toBe(0);
      expect(secondInstance.createCount).toBe(1);
      expect(game.isBooted).toBe(true);
      expect(game.loop.running).toBe(true);
    } finally {
      pool.dispose();
    }
  });

  it('rebooted scene state matches a fresh per-test boot (deterministic parity)', async () => {
    // Both paths must advance the scene by the same fixed-delta boot steps, so
    // a suite that adopts reuse observes identical booted state to per-test
    // boot regardless of host load.
    const fresh = await bootScene([CounterScene]);
    const freshUpdates = (fresh.scene as CounterScene).updateCount;
    expect(freshUpdates).toBeGreaterThan(0);

    const pool = createReusableBoot('reuse-parity');
    try {
      await pool.boot([CounterScene]); // first boot = fresh game
      let rebooted: CounterScene | null = null;
      for (let i = 0; i < 3; i += 1) {
        rebooted = (await pool.boot([CounterScene])).scene as CounterScene;
      }
      expect(rebooted!.updateCount).toBe(freshUpdates);
    } finally {
      pool.dispose();
      fresh.game.destroy(true);
    }
  });

  it('dispose destroys the game shell; boot after dispose re-creates it', async () => {
    const pool = createReusableBoot('reuse-dispose');
    const first = await pool.boot([GymWeapons]);
    const game = first.game;
    pool.dispose();
    expect(pool.game).toBeNull();

    const second = await pool.boot([GymWeapons]);
    expect(second.game).not.toBe(game);
    pool.dispose();
  });

  it('boot is a no-op on the DOM host: the canvas is created once (no re-parenting)', async () => {
    const pool = createReusableBoot('reuse-host');
    await pool.boot([GymWeapons]);
    const canvas = document.querySelector('#reuse-host canvas');
    expect(canvas).not.toBeNull();
    await pool.boot([GymWeapons]);
    // Same host element reused — not replaced.
    expect(document.querySelector('#reuse-host canvas')).toBe(canvas);
    pool.dispose();
  });
});

