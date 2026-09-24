/**
 * End-to-end pause/settings integration verification (AH-0MUA8BP19000ORCG —
 * final gate of the In-game menu epic AH-0MU9LPZ0G0015292).
 *
 * Chains the real flows with all six scenes registered: menu → play → ESC
 * pause (exact resume), pause → settings (live changes) → back → resume,
 * settings persistence across a page reload, and the menu settings entry.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  findConflict,
  loadSettings,
} from '../core/settingsStore';
import { GameOverScene } from './GameOverScene';
import { GymIndex } from './GymIndex';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { PlayScene } from './PlayScene';
import { SettingsScene } from './SettingsScene';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

function clickText(scene: Phaser.Scene, label: string): void {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
  found!.emit('pointerdown');
}

async function bootAllGames(): Promise<Phaser.Game> {
  if (document.body.querySelector('#game-container') === null) {
    const div = document.createElement('div');
    div.id = 'game-container';
    document.body.appendChild(div);
  }
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: GAME_WIDTH,
    height: GAME_HEIGHT,
    backgroundColor: '#000000',
    parent: 'game-container',
    scene: [MenuScene, PlayScene, PauseScene, SettingsScene, GameOverScene, GymIndex],
  });
  await sleep(300);
  return game;
}

/** Starts PlayScene from the menu and returns the scene. */
async function startPlay(game: Phaser.Game): Promise<PlayScene> {
  clickText(game.scene.getScene('MenuScene'), '▶  Play Game');
  await sleep(350);
  const play = game.scene.getScene('PlayScene') as PlayScene;
  expect(play.sys.isActive()).toBe(true);
  return play;
}

describe('End-to-end pause/settings integration (AH-0MUA8BP19000ORCG)', () => {
  let game: Phaser.Game | null = null;

  afterEach(() => {
    game?.destroy(true);
    game = null;
    window.localStorage.clear();
    document.getElementById('enemy-gym-panel')?.remove();
    document.getElementById('gym-config-panel')?.remove();
  });

  // ── AC1 — pause flow ────────────────────────────────────────────

  it('AC1 — ESC pauses to PauseScene; no time passes; ESC resumes', async () => {
    game = await bootAllGames();
    const play = await startPlay(game);

    const score = play.getGameState().score;

    // ESC opens the pause menu.
    pressKey('Escape');
    await sleep(200);
    expect(game.scene.isActive('PauseScene')).toBe(true);
    expect(play.isPaused()).toBe(true);
    expect(game.scene.isPaused('PlayScene')).toBe(true);

    // Simulate a long pause: direct ticks must not advance the simulation
    // (no time counted during the pause).
    play.tick(1.0);
    play.tick(1.0);
    expect(play.getGameState().score).toBe(score);

    // ESC again resumes the run (PlayScene active and playable).
    pressKey('Escape');
    await sleep(200);
    expect(game.scene.isActive('PauseScene')).toBe(false);
    expect(play.isPaused()).toBe(false);
    expect(game.scene.isPaused('PlayScene')).toBe(false);
    expect(play.getPlayer()).not.toBeNull();
    expect(play.getAliveCount()).toBeGreaterThan(0);
  });

  // ── AC2 — settings flow from pause ──────────────────────────────

  it('AC2 — pause → settings changes apply live → back → resume', async () => {
    game = await bootAllGames();
    const play = await startPlay(game);

    pressKey('Escape');
    await sleep(200);
    const pause = game.scene.getScene('PauseScene') as PauseScene;

    // Open settings from the pause menu.
    clickText(pause, '⚙  Settings');
    await sleep(200);
    const settings = game.scene.getScene('SettingsScene') as SettingsScene;
    expect(game.scene.isActive('SettingsScene')).toBe(true);
    expect(game.scene.isActive('PauseScene')).toBe(false);
    // PlayScene is still paused underneath.
    expect(game.scene.isPaused('PlayScene')).toBe(true);

    // Change volume, mute and a binding — all persist live.
    settings.setVolume(0.3);
    settings.setMuted(true);
    const conflict = settings.rebind('moveUp', 'i');
    expect(conflict).toBeNull();
    const stored = loadSettings();
    expect(stored.sfxVolume).toBe(0.3);
    expect(stored.sfxMuted).toBe(true);
    expect(stored.bindings.moveUp).toBe('i');

    // Back returns to the pause menu, Resume returns to the game.
    clickText(settings, '←  Back');
    await sleep(200);
    expect(game.scene.isActive('PauseScene')).toBe(true);
    expect(game.scene.isActive('SettingsScene')).toBe(false);

    const pause2 = game.scene.getScene('PauseScene') as PauseScene;
    clickText(pause2, '▶  Resume');
    await sleep(200);
    expect(play.isPaused()).toBe(false);
    expect(game.scene.isPaused('PlayScene')).toBe(false);
    expect(game.scene.isActive('PauseScene')).toBe(false);
  });

  // ── AC3 — persistence across reload ─────────────────────────────

  it('AC3 — a simulated reload restores volume, mute and bindings', async () => {
    game = await bootAllGames();
    await startPlay(game);

    // Configure settings via the pause → settings path.
    pressKey('Escape');
    await sleep(200);
    clickText(game.scene.getScene('PauseScene'), '⚙  Settings');
    await sleep(200);
    const settings = game.scene.getScene('SettingsScene') as SettingsScene;
    settings.setVolume(0.45);
    settings.setMuted(true);
    settings.rebind('moveDown', 'k');
    expect(loadSettings().bindings.moveDown).toBe('k');

    // Simulate a page reload.
    game.destroy(true);
    game = null;
    game = await bootAllGames();

    // Re-open settings from the main menu: values are restored.
    clickText(game.scene.getScene('MenuScene'), '⚙  Settings');
    await sleep(200);
    const settings2 = game.scene.getScene('SettingsScene') as SettingsScene;
    expect(settings2.getSfxVolume()).toBe(0.45);
    expect(settings2.isSfxMuted()).toBe(true);
    expect(settings2.getBinding('moveDown')).toBe('k');
    expect(game.scene.isActive('SettingsScene')).toBe(true);
    expect(game.scene.isActive('MenuScene')).toBe(false);
  });

  // ── AC4 — menu settings entry ───────────────────────────────────

  it('AC4 — Settings from the main menu opens and Back returns to the menu', async () => {
    game = await bootAllGames();
    const menu = game.scene.getScene('MenuScene');

    clickText(menu, '⚙  Settings');
    await sleep(200);
    expect(game.scene.isActive('SettingsScene')).toBe(true);
    expect(game.scene.isActive('MenuScene')).toBe(false);

    clickText(game.scene.getScene('SettingsScene'), '←  Back');
    await sleep(200);
    expect(game.scene.isActive('MenuScene')).toBe(true);
    expect(game.scene.isActive('SettingsScene')).toBe(false);
  });

  // ── AC5 — suite health helpers stay consistent with stores ──────

  it('AC5 — the shipped defaults are conflict-free per store contract', () => {
    expect(DEFAULT_SETTINGS.sfxVolume).toBe(1);
    expect(DEFAULT_SETTINGS.sfxMuted).toBe(false);
    expect(loadSettings().bindings).toEqual(DEFAULT_BINDINGS);
    // The intentional S overlap is not flagged.
    expect(findConflict(DEFAULT_BINDINGS, 'moveDown', 's')).toBeNull();
    expect(findConflict(DEFAULT_BINDINGS, 'layerDrop', 's')).toBeNull();
  });
});