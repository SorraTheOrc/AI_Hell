/**
 * Scene tests for applying the resolved player control scheme in `PlayScene`
 * (`AH-0MVI7LRCJ006Q8SA` AC4, test-first item `AH-0MVIAQEI600528E2`).
 *
 * The settings-driven boot is verified end to end: a saved
 * `fourDirectional` setting makes the spawned ship drive four-directionally,
 * a saved `asteroids` setting (or nothing saved) makes it drive Asteroids, and
 * the resolution never mutates the loaded ship config or the CSV. A change
 * made mid-run only takes effect on the next ship spawn.
 *
 * Lives in its own file rather than growing the 7k-line `PlayScene.test.ts`:
 * it seeds `ai_hell_settings` (the suite-wide `beforeEach` there seeds the
 * ship config only) and asserts one focused seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONFIG } from '../core/config';
import { loadShipConfig, seedConfigStore } from '../core/configStore';
import type { ShipConfig } from '../core/configTypes';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from '../core/settingsStore';
import { advanceGame, bootScene, type BootedGame } from '../test/gameHarness';
import { Player } from '../entities/Player';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PlayScene } from './PlayScene';

/** Internals the movement assertions need (the shared `wasd` key objects). */
interface PlayInternals {
  wasd?: {
    W: { isDown: boolean };
    A: { isDown: boolean };
    S: { isDown: boolean };
    D: { isDown: boolean };
  };
}

/** Saves a settings record carrying `scheme`, leaving the rest at defaults. */
function saveScheme(scheme: 'asteroids' | 'fourDirectional'): void {
  saveSettings({ ...DEFAULT_SETTINGS, controlScheme: scheme });
}

describe('PlayScene — resolved control scheme applied at spawn (AH-0MVI7LRCJ006Q8SA AC4)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    // The shipped designer default is Asteroids; the per-player setting is the
    // only thing that varies between these cases.
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'asteroids' });
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, GameOverScene, MenuScene]);
    const scene = booted.scene as PlayScene;
    // Isolate from the random asteroid spawner so movement assertions are
    // about the ship's input mapping, not about dodging rocks.
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  function heldKeys(scene: PlayScene): NonNullable<PlayInternals['wasd']> {
    return (scene as unknown as PlayInternals).wasd!;
  }

  /** Facing angle of the ship, defaulting to 0 for the four-directional state. */
  function facingOf(player: Player): number {
    return player.getMovementState().facing ?? 0;
  }

  /** Holds `key` for `seconds` of ticks, releasing it afterwards. */
  function hold(scene: PlayScene, key: 'W' | 'A' | 'S' | 'D', seconds: number): void {
    const keys = heldKeys(scene);
    keys[key].isDown = true;
    scene.tick(seconds);
    keys[key].isDown = false;
  }

  it('drives four-directional movement when the player saved fourDirectional', async () => {
    saveScheme('fourDirectional');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    expect(player.getScheme()).toBe('fourDirectional');

    // Under four-directional, A is a translation to the left and does not
    // rotate the ship.
    const xBefore = player.getMovementState().x;
    hold(scene, 'A', 0.2);

    expect(player.getMovementState().x).toBeLessThan(xBefore);
    expect(Math.abs(facingOf(player))).toBeLessThan(0.05);
  });

  it('drives Asteroids movement when the player saved asteroids', async () => {
    saveScheme('asteroids');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    expect(player.getScheme()).toBe('asteroids');

    // Under Asteroids, A is a turn: the facing angle changes while the ship
    // does not translate sideways.
    const xBefore = player.getMovementState().x;
    const facingBefore = facingOf(player);
    hold(scene, 'A', 0.2);

    expect(facingOf(player)).not.toBeCloseTo(facingBefore, 5);
    expect(Math.abs(player.getMovementState().x - xBefore)).toBeLessThan(1);
  });

  it('defaults to the shipped Asteroids scheme when nothing is saved', async () => {
    // Nothing written to ai_hell_settings at all.
    const scene = await bootPlay();
    expect(scene.getPlayer()!.getScheme()).toBe('asteroids');
    expect(loadSettings().controlScheme).toBe('asteroids');
  });

  it('falls back to the ship-config scheme when the stored setting is invalid', async () => {
    seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
    window.localStorage.setItem(
      'ai_hell_settings',
      JSON.stringify({ controlScheme: 'orbital' }),
    );

    const scene = await bootPlay();
    expect(scene.getPlayer()!.getScheme()).toBe('fourDirectional');
  });

  it('never mutates the loaded ship config or writes the CSV', async () => {
    saveScheme('fourDirectional');
    const before: ShipConfig = loadShipConfig();
    const snapshot = { ...before };

    const scene = await bootPlay();

    expect(scene.getPlayer()!.getScheme()).toBe('fourDirectional');
    // The designer-owned config keeps Asteroids: the player premium is applied
    // to a copy handed to the ship, never to the store.
    expect(loadShipConfig()).toEqual(snapshot);
    expect(loadShipConfig().controlScheme).toBe('asteroids');
  });

  it('does not swap the current ship when the setting changes mid-run', async () => {
    saveScheme('asteroids');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;
    expect(player.getScheme()).toBe('asteroids');

    // The player visits Settings mid-run and picks four-directional.
    saveScheme('fourDirectional');
    scene.tick(0.1);

    // The live ship keeps its scheme — the change applies next run/spawn.
    expect(scene.getPlayer()).toBe(player);
    expect(player.getScheme()).toBe('asteroids');

    // Asteroids turning still behaves as Asteroids after the change.
    const facingBefore = facingOf(player);
    hold(scene, 'A', 0.2);
    expect(facingOf(player)).not.toBeCloseTo(facingBefore, 5);
  });

  it('spawns the ship with the resolved scheme on a new run', async () => {
    saveScheme('asteroids');
    const first = await bootPlay();
    expect(first.getPlayer()!.getScheme()).toBe('asteroids');

    // Next run: the saved choice has changed.
    saveScheme('fourDirectional');
    booted!.game.destroy(true);
    booted = null;
    const second = await bootPlay();

    expect(second.getPlayer()).toBeInstanceOf(Player);
    expect(second.getPlayer()!.getScheme()).toBe('fourDirectional');
  });

  it('keeps the scheme when another setting changes', async () => {
    saveScheme('fourDirectional');
    const scene = await bootPlay();

    saveSettings({ ...DEFAULT_SETTINGS, sfxVolume: 0.2, controlScheme: 'fourDirectional' });
    await advanceGame(booted!.game, 30);

    expect(scene.getPlayer()!.getScheme()).toBe('fourDirectional');
    expect(loadSettings().controlScheme).toBe('fourDirectional');
  });
});
