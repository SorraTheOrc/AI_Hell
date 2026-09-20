/**
 * Scene tests for the in-game pause menu (AH-0MUA8BDG4004AEIP — child of the
 * In-game menu epic AH-0MU9LPZ0G0015292).
 *
 * Covers: full-screen replacement rendering, the Resume/Settings/Quit
 * controls, ESC-to-resume, Quit-to-menu, Settings navigation, and the
 * scene-local keyboard focus traversal (default focus, wrap-around,
 * Enter/Space activation).
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene } from './GameOverScene';
import { MenuScene } from './MenuScene';
import { PauseScene } from './PauseScene';
import { PlayScene } from './PlayScene';

/** Minimal SettingsScene stand-in: child #6/#7 ship the real one. */
class StubSettingsScene extends Phaser.Scene {
  constructor() {
    super('SettingsScene');
  }
  create(): void {
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

function pressKey(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

describe('PauseScene — in-game pause menu (AH-0MUA8BDG4004AEIP)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Boots PlayScene active with PauseScene registered. */
  async function bootPlay(): Promise<PlayScene> {
    booted = await bootScene([PlayScene, PauseScene, MenuScene, GameOverScene]);
    return booted.scene as PlayScene;
  }

  function pauseScene(): PauseScene {
    return booted!.game.scene.getScene('PauseScene') as PauseScene;
  }

  /** Opens the pause menu via ESC and returns the PauseScene instance. */
  async function openPause(): Promise<PauseScene> {
    pressKey('Escape');
    await settle();
    return pauseScene();
  }

  // ── AC1 — full-screen replacement scene ─────────────────────────

  it('AC1 — ESC opens PauseScene full-screen over the paused PlayScene', async () => {
    const play = await bootPlay();
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);

    const scene = await openPause();

    expect(scene).toBeDefined();
    expect(booted!.game.scene.isActive('PauseScene')).toBe(true);
    // PlayScene is frozen at the SceneManager level and by its pause flag.
    expect(play.isPaused()).toBe(true);
    expect(booted!.game.scene.isPaused('PlayScene')).toBe(true);

    // A full-screen opaque rectangle, not a translucent overlay.
    const background = scene.children.list.find(
      (child) =>
        child instanceof Phaser.GameObjects.Rectangle &&
        (child as Phaser.GameObjects.Rectangle).width === GAME_WIDTH,
    ) as Phaser.GameObjects.Rectangle | undefined;
    expect(background).toBeDefined();
    expect(background!.height).toBe(GAME_HEIGHT);
    expect(background!.fillAlpha).toBe(1);
  });

  // ── AC2 — Resume / ESC resume exactly ───────────────────────────

  it('AC2 — the Resume button resumes PlayScene and closes the menu', async () => {
    const play = await bootPlay();
    const scene = await openPause();

    scene.getControl('▶  Resume')!.emit('pointerdown');
    await settle();

    expect(play.isPaused()).toBe(false);
    expect(booted!.game.scene.isPaused('PlayScene')).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
  });

  it('AC2 — ESC resumes the game and closes the menu', async () => {
    const play = await bootPlay();
    await openPause();

    pressKey('Escape');
    await settle();

    expect(play.isPaused()).toBe(false);
    expect(booted!.game.scene.isPaused('PlayScene')).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
  });

  it('AC2 — the Quit button returns to the main menu', async () => {
    await bootPlay();
    const scene = await openPause();

    scene.getControl('✕  Quit')!.emit('pointerdown');
    await settle();

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);
  });

  // ── AC3 — Settings navigation ───────────────────────────────────

  it('AC3 — the Settings button navigates to SettingsScene', async () => {
    booted = await bootScene([PlayScene, PauseScene, StubSettingsScene, MenuScene]);
    const scene = await openPause();

    scene.getControl('⚙  Settings')!.emit('pointerdown');
    await settle();

    expect(booted!.game.scene.isActive('SettingsScene')).toBe(true);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
  });

  // ── AC4 — scene-local keyboard navigation ───────────────────────

  it('AC4 — Resume has the default focus', async () => {
    await bootPlay();
    const scene = await openPause();
    expect(scene.getFocusedLabel()).toBe('▶  Resume');
    expect(scene.getControlCount()).toBe(3);
  });

  it('AC4 — Tab and arrow keys cycle focus with wrap-around', async () => {
    await bootPlay();
    const scene = await openPause();

    pressKey('Tab');
    await settle();
    expect(scene.getFocusedLabel()).toBe('⚙  Settings');

    pressKey('ArrowDown');
    await settle();
    expect(scene.getFocusedLabel()).toBe('✕  Quit');

    // Wrap forward past the last control back to the first.
    pressKey('ArrowRight');
    await settle();
    expect(scene.getFocusedLabel()).toBe('▶  Resume');

    // Wrap backward from the first control to the last.
    pressKey('ArrowUp');
    await settle();
    expect(scene.getFocusedLabel()).toBe('✕  Quit');

    pressKey('ArrowLeft');
    await settle();
    expect(scene.getFocusedLabel()).toBe('⚙  Settings');
  });

  it('AC4 — Enter activates the focused control', async () => {
    const play = await bootPlay();
    await openPause();

    // Focus Settings (default Resume → Tab once), then check Enter routes
    // to the focused control by returning to Resume and activating it.
    pressKey('Tab');
    await settle();
    pressKey('ArrowUp');
    await settle(); // back to Resume
    pressKey('Enter');
    await settle();

    expect(play.isPaused()).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
  });

  it('AC4 — Space activates the focused control', async () => {
    const play = await bootPlay();
    await openPause();

    pressKey(' ');
    await settle();

    expect(play.isPaused()).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(false);
  });
});