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
import { addEntry } from '../core/Leaderboard';
import { MenuScene, resumeAudioContext } from './MenuScene';
import { PlayScene } from './PlayScene';
import { PauseScene } from './PauseScene';
import { SettingsScene } from './SettingsScene';
import { GameOverScene } from './GameOverScene';
import { LeaderboardScene } from './LeaderboardScene';
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
describe('MenuScene — Settings button (AH-0MUA8BLMA003U18N)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  async function bootMenu(): Promise<MenuScene> {
    booted = await bootScene([
      MenuScene,
      PlayScene,
      PauseScene,
      SettingsScene,
      GameOverScene,
      GymIndex,
    ]);
    return booted!.scene as MenuScene;
  }

  it('AC1 — renders an interactive Settings button', async () => {
    const scene = await bootMenu();
    const settings = findText(scene, '⚙  Settings');
    expect(settings.input?.enabled).toBe(true);
  });

  it('AC1 — activating Settings opens SettingsScene', async () => {
    const scene = await bootMenu();
    expect(booted!.game.scene.isActive('SettingsScene')).toBe(false);

    findText(scene, '⚙  Settings').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 200));

    expect(booted!.game.scene.isActive('SettingsScene')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC2 — Back from menu-opened settings returns to MenuScene', async () => {
    const scene = await bootMenu();
    findText(scene, '⚙  Settings').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 200));

    const settings = booted!.game.scene.getScene('SettingsScene') as SettingsScene;
    settings.goBack();
    await new Promise((r) => setTimeout(r, 200));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('SettingsScene')).toBe(false);
  });

  it('AC3 — entering settings resumes a suspended audio context', async () => {
    const scene = await bootMenu();
    const resume = vi.fn();
    Object.defineProperty(scene, 'sound', {
      value: { context: { state: 'suspended', resume } },
      configurable: true,
    });

    findText(scene, '⚙  Settings').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 200));

    expect(resume).toHaveBeenCalledOnce();
    expect(booted!.game.scene.isActive('SettingsScene')).toBe(true);
  });
});

describe('MenuScene — keyboard-only navigation (AH-0MU9LKQEP008LCX9-C2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  async function bootMenu(): Promise<MenuScene> {
    booted = await bootScene([
      MenuScene,
      PlayScene,
      PauseScene,
      SettingsScene,
      GameOverScene,
      GymIndex,
    ]);
    return booted!.scene as MenuScene;
  }

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressKey(scene: MenuScene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  it('AC1 — Play Game is focused by default with a visible highlight', async () => {
    const scene = await bootMenu();
    expect(scene.getFocusedLabel()).toBe('▶  Play Game');
    const play = findText(scene, '▶  Play Game');
    // Focus highlight applies a white stroke border.
    expect(play.style.stroke).toBeTruthy();
  });

  it('AC2 — Tab cycles focus: Play → Settings → Leaderboard → Gym Index → Play (wrap)', async () => {
    const scene = await bootMenu();
    expect(scene.getFocusedLabel()).toBe('▶  Play Game');

    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe('⚙  Settings');

    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe('🏆  Leaderboard');

    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe('⚙  Gym Scene Index (dev)');

    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe('▶  Play Game');
  });

  it('AC3 — ArrowDown cycles in the same order and wraps', async () => {
    const scene = await bootMenu();
    expect(scene.getFocusedLabel()).toBe('▶  Play Game');

    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('⚙  Settings');

    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('🏆  Leaderboard');

    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('⚙  Gym Scene Index (dev)');

    pressKey(scene, { key: 'ArrowDown' });
    expect(scene.getFocusedLabel()).toBe('▶  Play Game');
  });

  it('AC2 — Shift+Tab cycles focus backward with wrap', async () => {
    const scene = await bootMenu();
    pressKey(scene, { key: 'Tab', shiftKey: true });
    expect(scene.getFocusedLabel()).toBe('⚙  Gym Scene Index (dev)');

    pressKey(scene, { key: 'Tab', shiftKey: true });
    expect(scene.getFocusedLabel()).toBe('🏆  Leaderboard');

    pressKey(scene, { key: 'Tab', shiftKey: true });
    expect(scene.getFocusedLabel()).toBe('⚙  Settings');
  });

  it('AC4 — Enter on focused Play Game starts PlayScene with audio resume', async () => {
    const scene = await bootMenu();
    const resume = vi.fn();
    Object.defineProperty(scene, 'sound', {
      value: { context: { state: 'suspended', resume } },
      configurable: true,
    });

    expect(scene.getFocusedLabel()).toBe('▶  Play Game');
    pressKey(scene, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 350));

    expect(resume).toHaveBeenCalledOnce();
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC4 — Space on focused Play Game starts PlayScene', async () => {
    const scene = await bootMenu();
    pressKey(scene, { key: ' ' });
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
  });

  it('AC5 — Enter on focused Settings opens SettingsScene', async () => {
    const scene = await bootMenu();
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe('⚙  Settings');

    pressKey(scene, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 200));

    expect(booted!.game.scene.isActive('SettingsScene')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC6 — Enter on focused Gym Scene Index opens GymIndex', async () => {
    const scene = await bootMenu();
    pressKey(scene, { key: 'Tab' });
    pressKey(scene, { key: 'Tab' });
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedLabel()).toBe('⚙  Gym Scene Index (dev)');

    pressKey(scene, { key: ' ' });
    await new Promise((r) => setTimeout(r, 200));

    expect(booted!.game.scene.isActive('GymIndex')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);
  });

  it('AC7 — pointerdown still navigates (regression preserved)', async () => {
    const scene = await bootMenu();
    findText(scene, '▶  Play Game').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('PlayScene')).toBe(true);
  });
});

describe('MenuScene — leaderboard access (AH-0MUD9ZNZJ001P7RF)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  async function bootMenu(): Promise<MenuScene> {
    booted = await bootScene([
      MenuScene,
      PlayScene,
      PauseScene,
      SettingsScene,
      GameOverScene,
      LeaderboardScene,
      GymIndex,
    ]);
    return booted!.scene as MenuScene;
  }

  function pressKey(scene: MenuScene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  /** Rendered leaderboard rows from the active LeaderboardScene. */
  function leaderboardRows(): Phaser.GameObjects.Text[] {
    const scene = booted!.game.scene.getScene('LeaderboardScene');
    return (scene.children.list as Phaser.GameObjects.Text[]).filter(
      (c) => c instanceof Phaser.GameObjects.Text && /^ *#\d+/.test(c.text),
    );
  }

  it('AC1 — exposes an interactive Leaderboard control', async () => {
    const scene = await bootMenu();
    const leaderboard = findText(scene, '🏆  Leaderboard');
    expect(leaderboard.input?.enabled).toBe(true);
  });

  it('AC2 — clicking Leaderboard opens the full ranked table', async () => {
    for (const [initials, score] of [
      ['AAA', 100],
      ['BBB', 900],
      ['CCC', 500],
    ] as const) {
      addEntry(initials, score);
    }

    const scene = await bootMenu();
    findText(scene, '🏆  Leaderboard').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('LeaderboardScene')).toBe(true);
    expect(booted!.game.scene.isActive('MenuScene')).toBe(false);

    const rows = leaderboardRows();
    expect(rows).toHaveLength(3);
    expect(rows[0].text).toContain('BBB');
    expect(rows[1].text).toContain('CCC');
    expect(rows[2].text).toContain('AAA');
    for (const row of rows) {
      expect(row.text).toMatch(/^ *#\d+ {2}[A-Z]{3} +\d+ +\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('AC2 — keyboard: Tab to Leaderboard then Enter opens it', async () => {
    const scene = await bootMenu();
    pressKey(scene, { key: 'Tab' }); // Settings
    pressKey(scene, { key: 'Tab' }); // Leaderboard
    expect(scene.getFocusedLabel()).toBe('🏆  Leaderboard');

    pressKey(scene, { key: 'Enter' });
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('LeaderboardScene')).toBe(true);
  });

  it('AC3 — returning from the leaderboard restores the menu with Play focused', async () => {
    const scene = await bootMenu();
    findText(scene, '🏆  Leaderboard').emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    const leaderboard = booted!.game.scene.getScene('LeaderboardScene') as LeaderboardScene;
    leaderboard.returnToMenu();
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect((booted!.game.scene.getScene('MenuScene') as MenuScene).getFocusedLabel()).toBe(
      '▶  Play Game',
    );
  });
});
