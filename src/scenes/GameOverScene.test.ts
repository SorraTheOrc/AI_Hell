/**
 * Unit tests for the GameOverScene (AH-0MU731426003FE71 — child 6).
 *
 * Covers score display, initials input validation (A–Z only, 3 chars,
 * backspace, submit), the leaderboard stub persistence, and the return
 * to the main menu.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { GameOverScene, INITIALS_LENGTH, isInitialsLetter, readLeaderboard, saveScoreEntry } from './GameOverScene';
import { MenuScene } from './MenuScene';

async function bootGameOver(): Promise<BootedGame> {
  return bootScene([GameOverScene, MenuScene]);
}

describe('GameOverScene — score display & navigation (AH-0MU731426003FE71)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  it('AC1 — renders the final score in neon style at the top', async () => {
    booted = await bootGameOver();
    // Restart the active scene with the run's data (init → create).
    booted.game.scene.start('GameOverScene', { score: 4321, won: false });
    await new Promise((r) => setTimeout(r, 350));
    const scene = booted.game.scene.getScene('GameOverScene') as GameOverScene;

    const text = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text.startsWith('Final Score:'),
    );
    expect(text).toBeDefined();
    expect(text!.text).toBe('Final Score: 4321');
    expect(scene.getFinalScore()).toBe(4321);
  });

  it('AC4 — the Return to Menu button navigates to MenuScene', async () => {
    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    const button = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === '←  Return to Menu',
    );
    expect(button).toBeDefined();
    expect(button!.input?.enabled).toBe(true);

    button!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(false);
  });
});

describe('GameOverScene — initials input (AC2)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  it('accepts letters only, uppercase, up to 3 characters', async () => {
    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    expect(scene.handleInitialsKey('a')).toBe(true);
    expect(scene.handleInitialsKey('B')).toBe(true);
    expect(scene.handleInitialsKey('c')).toBe(true);
    expect(scene.getInitials()).toBe('ABC');

    // Fourth letter is ignored.
    expect(scene.handleInitialsKey('D')).toBe(true);
    expect(scene.getInitials()).toBe('ABC');
  });

  it('ignores digits, symbols, and whitespace', async () => {
    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    expect(scene.handleInitialsKey('1')).toBe(false);
    expect(scene.handleInitialsKey('!')).toBe(false);
    expect(scene.handleInitialsKey(' ')).toBe(false);
    expect(scene.getInitials()).toBe('');
  });

  it('Backspace removes the last character', async () => {
    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    scene.handleInitialsKey('X');
    scene.handleInitialsKey('Y');
    expect(scene.getInitials()).toBe('XY');
    expect(scene.handleInitialsKey('Backspace')).toBe(true);
    expect(scene.getInitials()).toBe('X');
    expect(scene.handleInitialsKey('Backspace')).toBe(true);
    expect(scene.getInitials()).toBe('');
    // Backspace on empty input is a no-op.
    expect(scene.handleInitialsKey('Backspace')).toBe(false);
  });

  it('the initials field model exposes the input width', () => {
    expect(INITIALS_LENGTH).toBe(3);
    expect(isInitialsLetter('a')).toBe(true);
    expect(isInitialsLetter('Z')).toBe(true);
    expect(isInitialsLetter('0')).toBe(false);
    expect(isInitialsLetter('')).toBe(false);
  });
});

describe('GameOverScene — leaderboard stub (AC3)', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('shows a placeholder message when no data is available', async () => {
    const booted = await bootScene([GameOverScene, MenuScene]);
    const scene = booted.scene as GameOverScene;

    // With an empty store the placeholder is guaranteed.
    expect(readLeaderboard()).toEqual([]);

    const placeholder = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === 'Leaderboard coming soon',
    );
    expect(placeholder).toBeDefined();
    booted.game.destroy(true);
  });

  it('persists initials + score and sorts descending', () => {
    const entries = saveScoreEntry({ initials: 'AAA', score: 500 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ initials: 'AAA', score: 500 });

    const sorted = saveScoreEntry({ initials: 'BBB', score: 900 });
    expect(sorted.map((e) => e.score)).toEqual([900, 500]);
    expect(sorted.map((e) => e.initials)).toEqual(['BBB', 'AAA']);
  });

  it('survives a reload (persisted to localStorage)', () => {
    saveScoreEntry({ initials: 'A1A', score: 100 });
    expect(readLeaderboard()).toEqual([{ initials: 'A1A', score: 100 }]);
  });

  it('tolerates corrupt storage', () => {
    localStorage.setItem('ai_hell_leaderboard', 'not-json');
    expect(readLeaderboard()).toEqual([]);

    localStorage.setItem('ai_hell_leaderboard', JSON.stringify({ nope: 1 }));
    expect(readLeaderboard()).toEqual([]);
  });

  it('renders populated leaderboard rows (top 3) when data exists', async () => {
    saveScoreEntry({ initials: 'ZZZ', score: 9000 });
    saveScoreEntry({ initials: 'YYY', score: 5000 });

    const booted = await bootScene([GameOverScene, MenuScene]);
    const scene = booted.scene as GameOverScene;
    const texts = scene.children.list.filter(
      (c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text,
    );
    // No placeholder when entries exist…
    expect(texts.some((t) => t.text === 'Leaderboard coming soon')).toBe(false);
    // …and the top rows are rendered (rank, initials, score).
    const rows = texts.find((t) => t.text.includes('ZZZ'));
    expect(rows).toBeDefined();
    expect(rows!.text).toContain('9000');
    expect(rows!.text).toContain('YYY');
    booted.game.destroy(true);
  });

  it('submitting with Enter saves the score and returns to the menu', async () => {
    const booted = await bootScene([GameOverScene, MenuScene]);
    const scene = booted.scene as GameOverScene;
    scene.init({ score: 12345 });

    scene.handleInitialsKey('A');
    scene.handleInitialsKey('B');
    scene.handleInitialsKey('C');

    expect(scene.handleInitialsKey('Enter')).toBe(true);
    expect(readLeaderboard()).toEqual([{ initials: 'ABC', score: 12345 }]);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted.game.scene.isActive('MenuScene')).toBe(true);
    booted.game.destroy(true);
  });
});
describe('GameOverScene — keyboard focus model (AH-0MU9LKQEP008LCX9-C3)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function boot(): Promise<GameOverScene> {
    booted = await bootScene([GameOverScene, MenuScene]);
    return booted.scene as GameOverScene;
  }

  /** Dispatches a keydown through the scene keyboard plugin (as a user would). */
  function pressKey(scene: GameOverScene, event: Partial<KeyboardEvent>): void {
    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      ...event,
    } as KeyboardEvent);
  }

  /** The rendered initials field (text '___' while empty). */
  function initialsField(scene: GameOverScene): Phaser.GameObjects.Text {
    const found = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === '___',
    );
    expect(found).toBeDefined();
    return found!;
  }

  it('AC1 — initials field is focused by default with a visible highlight', async () => {
    const scene = await boot();
    expect(scene.getFocusedIndex()).toBe(0);
    expect(scene.getControlCount()).toBe(2);
    expect(initialsField(scene).style.stroke).toBeTruthy();
  });

  it('AC2 — Tab moves focus from initials to the Return to Menu button', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'Tab' });
    expect(scene.getFocusedIndex()).toBe(1);
  });

  it('AC2 — Shift+Tab moves focus back to the initials field', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'Tab' });
    pressKey(scene, { key: 'Tab', shiftKey: true });
    expect(scene.getFocusedIndex()).toBe(0);
  });

  it('AC5 — A–Z and Backspace edit the initials while the field is focused', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'a' });
    pressKey(scene, { key: 'B' });
    pressKey(scene, { key: 'c' });
    expect(scene.getInitials()).toBe('ABC');

    pressKey(scene, { key: 'Backspace' });
    expect(scene.getInitials()).toBe('AB');
  });

  it('AC5 — letters do not type while the button is focused', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'Tab' }); // focus button
    expect(scene.getFocusedIndex()).toBe(1);
    pressKey(scene, { key: 'X' });
    expect(scene.getInitials()).toBe('');
  });

  it('AC4 — Enter auto-submits complete initials and returns to the menu', async () => {
    const scene = await boot();
    scene.init({ score: 777 });
    pressKey(scene, { key: 'A' });
    pressKey(scene, { key: 'B' });
    pressKey(scene, { key: 'C' });

    pressKey(scene, { key: 'Enter' });
    expect(readLeaderboard()).toEqual([{ initials: 'ABC', score: 777 }]);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('AC4 — Enter with incomplete initials does NOT return to the menu', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'A' });
    pressKey(scene, { key: 'Enter' });

    await new Promise((r) => setTimeout(r, 200));
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(readLeaderboard()).toEqual([]);
  });

  it('AC3 — Enter on the focused button submits complete initials and returns', async () => {
    const scene = await boot();
    scene.init({ score: 321 });
    pressKey(scene, { key: 'A' });
    pressKey(scene, { key: 'B' });
    pressKey(scene, { key: 'C' });
    pressKey(scene, { key: 'Tab' }); // focus button
    expect(scene.getFocusedIndex()).toBe(1);

    pressKey(scene, { key: 'Enter' });
    expect(readLeaderboard()).toEqual([{ initials: 'ABC', score: 321 }]);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('AC3 — Space on the button returns to the menu even without complete initials', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'Tab' }); // focus button
    pressKey(scene, { key: ' ' });

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(readLeaderboard()).toEqual([]);
  });

  it('AC6 — pointerdown on the button still returns to the menu', async () => {
    const scene = await boot();
    const button = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === '←  Return to Menu',
    );
    button!.emit('pointerdown');

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });
});
