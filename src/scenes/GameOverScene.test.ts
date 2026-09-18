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