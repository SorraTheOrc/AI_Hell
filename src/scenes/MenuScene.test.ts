/**
 * Unit tests for the Main Menu scene (AH-0MU72YVFR005VB2N — child 2).
 *
 * Covers:
 * - MenuScene boots as an active scene with the neon title.
 * - The **Play Game** button navigates to PlayScene (Level 1 start).
 * - The **Gym Scene Index** button navigates to the GymIndex dev scene
 *   and is clearly marked as a dev tool.
 * - The Play button initialises the Phaser Audio context (Web Audio
 *   autoplay policy compliance, GDD §6.7) via `resumeAudioContext`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../test/gameHarness';
import { MenuScene, resumeAudioContext } from './MenuScene';
import { PlayScene } from './PlayScene';
import { GameOverScene } from './GameOverScene';
import { GymIndex } from './GymIndex';

/** Finds an on-screen text by label. */
function findText(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text {
  const found = scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
  expect(found, `text "${label}" not found`).toBeDefined();
  return found!;
}

describe('MenuScene — main menu (AH-0MU72YVFR005VB2N)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function bootMenu(): Promise<MenuScene> {
    booted = await bootScene([MenuScene, PlayScene, GameOverScene, GymIndex]);
    return booted!.scene as MenuScene;
  }

  it('AC1 — boots as an active scene and renders the neon title + subtitle', async () => {
    const scene = await bootMenu();
    expect(scene.sys.isActive()).toBe(true);
    expect(findText(scene, 'AI HELL')).toBeDefined();
    expect(findText(scene, 'Defeat 5 levels then the Central AI')).toBeDefined();
  });

  it('AC1 — renders a Play Game button and a Gym Scene Index (dev) button', async () => {
    const scene = await bootMenu();
    const play = findText(scene, '▶  Play Game');
    const dev = findText(scene, '⚙  Gym Scene Index (dev)');
    // Both are interactive click targets.
    expect(play.input?.enabled).toBe(true);
    expect(dev.input?.enabled).toBe(true);
  });

  it('AC4 — Gym Index button is clearly marked as a dev tool', async () => {
    const scene = await bootMenu();
    const dev = findText(scene, '⚙  Gym Scene Index (dev)');
    expect(dev.text).toMatch(/\(dev\)/i);
  });

  it('AC1+N — clicking Play Game starts PlayScene (Level 1)', async () => {
    const scene = await bootMenu();
    expect(booted!.game.scene.isActive('PlayScene')).toBe(false);

    findText(scene, '▶  Play Game').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC1 — clicking Gym Scene Index navigates to GymIndex', async () => {
    const scene = await bootMenu();
    expect(booted!.game.scene.isActive('GymIndex')).toBe(false);

    findText(scene, '⚙  Gym Scene Index (dev)').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('GymIndex')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC3+AC5 — clicking Play Game resumes a suspended audio context', async () => {
    const scene = await bootMenu();

    const resume = vi.fn();
    // Replace the scene's sound manager with a suspended-context stub.
    Object.defineProperty(scene, 'sound', {
      value: {
        context: { state: 'suspended', resume },
      },
      configurable: true,
    });

    findText(scene, '▶  Play Game').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    // Audio context initialised on the user gesture…
    expect(resume).toHaveBeenCalledOnce();
    // …and the game scene started.
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
  });

  it('AC3+AC5 — Play Game does not resume an already-running audio context', async () => {
    const scene = await bootMenu();

    const resume = vi.fn();
    Object.defineProperty(scene, 'sound', {
      value: { context: { state: 'running', resume } },
      configurable: true,
    });

    findText(scene, '▶  Play Game').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(resume).not.toHaveBeenCalled();
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
  });
});

describe('resumeAudioContext (GDD §6.7 autoplay policy)', () => {
  it('resumes a suspended context and returns true', () => {
    const resume = vi.fn();
    const sound = {
      context: { state: 'suspended', resume },
    } as unknown as Phaser.Sound.BaseSoundManager;
    expect(resumeAudioContext(sound)).toBe(true);
    expect(resume).toHaveBeenCalledOnce();
  });

  it('is a no-op (returns false) when the context is running', () => {
    const resume = vi.fn();
    const sound = {
      context: { state: 'running', resume },
    } as unknown as Phaser.Sound.BaseSoundManager;
    expect(resumeAudioContext(sound)).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it('is a no-op (returns false) when no WebAudio context exists', () => {
    const sound = {} as unknown as Phaser.Sound.BaseSoundManager;
    expect(resumeAudioContext(sound)).toBe(false);
  });

  it('is a no-op (returns false) when resume is not a function', () => {
    const sound = {
      context: { state: 'suspended', resume: 'nope' },
    } as unknown as Phaser.Sound.BaseSoundManager;
    expect(resumeAudioContext(sound)).toBe(false);
  });
});