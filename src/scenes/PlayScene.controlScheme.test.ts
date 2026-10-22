/**
 * Scene tests for applying the resolved player control scheme in `PlayScene`
 * (`AH-0MVI7LRCJ006Q8SA` AC4, test-first item `AH-0MVIAQEI600528E2`).
 *
 * The settings-driven boot is verified end to end: a saved
 * `fourDirectional` setting makes the spawned ship drive four-directionally,
 * a saved `asteroids` setting (or nothing saved) makes it drive Asteroids, and
 * the resolution never mutates the loaded ship config or the CSV. A change
 * made in the in-game Settings is applied to the live ship when the player
 * resumes (AH-0MVIMPC11001F7WU) as well as on the next ship spawn.
 *
 * Lives in its own file rather than growing the 7k-line `PlayScene.test.ts`:
 * it seeds `ai_hell_settings` (the suite-wide `beforeEach` there seeds the
 * ship config only) and asserts one focused seam.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

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
import { PauseScene } from './PauseScene';
import { PlayScene } from './PlayScene';
import { SettingsScene } from './SettingsScene';

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

  /**
   * Boots the game with the pause menu and Settings registered, so the real
   * in-game Settings flow can be driven end to end.
   */
  async function bootPlayWithMenus(): Promise<PlayScene> {
    booted = await bootScene([
      PlayScene,
      GameOverScene,
      MenuScene,
      PauseScene,
      SettingsScene,
    ]);
    const scene = booted.scene as PlayScene;
    scene.setAsteroidSpawnerEnabled(false);
    return scene;
  }

  /** Runs the real Play → Esc → Settings → scheme → Back → Resume flow. */
  async function chooseSchemeMidRun(scheme: 'asteroids' | 'fourDirectional'): Promise<void> {
    const game = booted!.game;
    const scene = booted!.scene as PlayScene;

    scene.togglePause();
    await advanceGame(game, 100);
    const pause = game.scene.getScene('PauseScene') as PauseScene;
    expect(game.scene.isActive('PauseScene')).toBe(true);

    pause.openSettings();
    await advanceGame(game, 100);
    const settings = game.scene.getScene('SettingsScene') as SettingsScene;
    expect(game.scene.isActive('SettingsScene')).toBe(true);
    settings.setControlScheme(scheme);
    expect(loadSettings().controlScheme).toBe(scheme);

    settings.goBack();
    await advanceGame(game, 100);
    const pauseAgain = game.scene.getScene('PauseScene') as PauseScene;
    pauseAgain.resumeGame();
    await advanceGame(game, 100);
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

  it('applies a scheme chosen mid-run to the live ship on resume', async () => {
    saveScheme('asteroids');
    const scene = await bootPlayWithMenus();
    const player = scene.getPlayer()!;
    expect(player.getScheme()).toBe('asteroids');

    // The player pauses, visits Settings and picks four-directional.
    await chooseSchemeMidRun('fourDirectional');

    // The same live ship is still flying, now with the chosen scheme: the
    // setting is honoured during gameplay, not only from the next run.
    expect(scene.isPaused()).toBe(false);
    expect(scene.getPlayer()).toBe(player);
    expect(player.getScheme()).toBe('fourDirectional');

    // Four-directional behaviour is live: A translates left without rotating.
    const xBefore = player.getMovementState().x;
    hold(scene, 'A', 0.2);
    expect(player.getMovementState().x).toBeLessThan(xBefore);
    expect(Math.abs(facingOf(player))).toBeLessThan(0.05);
  });

  it('applies a switch back to Asteroids mid-run on resume', async () => {
    saveScheme('fourDirectional');
    const scene = await bootPlayWithMenus();
    const player = scene.getPlayer()!;
    expect(player.getScheme()).toBe('fourDirectional');

    await chooseSchemeMidRun('asteroids');

    expect(scene.getPlayer()).toBe(player);
    expect(player.getScheme()).toBe('asteroids');

    // Asteroids behaviour is live: A turns the hull without translating.
    const xBefore = player.getMovementState().x;
    const facingBefore = facingOf(player);
    hold(scene, 'A', 0.2);
    expect(facingOf(player)).not.toBeCloseTo(facingBefore, 5);
    expect(Math.abs(player.getMovementState().x - xBefore)).toBeLessThan(1);
  });

  it('does not disturb the live ship when the scheme is unchanged', async () => {
    saveScheme('asteroids');
    const scene = await bootPlay();
    const player = scene.getPlayer()!;

    // Get the hull spinning (Asteroids turning) so there is live state that
    // `setScheme` would snap back to zero on an (incorrect) re-application.
    hold(scene, 'A', 0.2);
    const facingBefore = facingOf(player);
    const angularBefore = player.getMovementState().angularVelocity ?? 0;
    expect(facingBefore).not.toBeCloseTo(0, 5);

    // A real resume (e.g. after visiting Settings without changing the scheme);
    // the paused game is PlayScene-only here, so emit the RESUME seam directly.
    scene.events.emit(Phaser.Scenes.Events.RESUME);

    // Same scheme, and no live-state reset: facing/angular velocity survive.
    expect(player.getScheme()).toBe('asteroids');
    expect(player.getMovementState().facing).toBeCloseTo(facingBefore, 5);
    expect(player.getMovementState().angularVelocity ?? 0).toBeCloseTo(angularBefore, 5);
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
