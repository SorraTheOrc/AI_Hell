/**
 * Unit tests for the GameOverScene (AH-0MU731426003FE71 — child 6; extended by
 * AH-0MUD9ZNN30065ZLP — game-over leaderboard UX).
 *
 * Covers score display, initials input validation (A–Z only, 3 chars,
 * backspace, submit), qualifying vs non-qualifying leaderboard behaviour,
 * the full ranked leaderboard display (module-backed, no stub), and the
 * return to the main menu.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { addEntry, getEntries } from '../core/Leaderboard';
import { GameOverScene, INITIALS_LENGTH, isInitialsLetter } from './GameOverScene';
import { MenuScene } from './MenuScene';

async function bootGameOver(): Promise<BootedGame> {
  return bootScene([GameOverScene, MenuScene]);
}

/** All rendered leaderboard row texts (rows start with the `#rank` marker). */
function leaderboardRows(scene: GameOverScene): Phaser.GameObjects.Text[] {
  return (scene.children.list as Phaser.GameObjects.Text[]).filter(
    (c) => c instanceof Phaser.GameObjects.Text && /^ *#\d+/.test(c.text),
  );
}

/** Finds an on-screen text whose content includes `needle`. */
function findTextContaining(
  scene: GameOverScene,
  needle: string,
): Phaser.GameObjects.Text | undefined {
  return (scene.children.list as Phaser.GameObjects.Text[]).find(
    (c) => c instanceof Phaser.GameObjects.Text && c.text.includes(needle),
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

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

describe('GameOverScene — initials input (AC3)', () => {
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

describe('GameOverScene — qualifying & skip UX (AC5)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  it('a qualifying score prompts for initials and persists one ranked entry', async () => {
    booted = await bootGameOver();
    booted.game.scene.start('GameOverScene', { score: 12345, won: false });
    await new Promise((r) => setTimeout(r, 350));
    const scene = booted.game.scene.getScene('GameOverScene') as GameOverScene;

    expect(scene.getQualifies()).toBe(true);
    // The initials field is focused by default.
    expect(scene.getControlCount()).toBe(2);
    expect(scene.getFocusedIndex()).toBe(0);

    scene.handleInitialsKey('A');
    scene.handleInitialsKey('B');
    scene.handleInitialsKey('C');
    expect(scene.handleInitialsKey('Enter')).toBe(true);

    const entries = getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ rank: 1, initials: 'ABC', score: 12345 });
    expect(entries[0].date).toMatch(ISO_DATE);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('fewer than three initials cannot be submitted', async () => {
    booted = await bootGameOver();
    booted.game.scene.start('GameOverScene', { score: 500, won: false });
    await new Promise((r) => setTimeout(r, 350));
    const scene = booted.game.scene.getScene('GameOverScene') as GameOverScene;

    scene.handleInitialsKey('A');
    scene.handleInitialsKey('B');
    expect(scene.handleInitialsKey('Enter')).toBe(false);

    await new Promise((r) => setTimeout(r, 200));
    expect(booted.game.scene.isActive('GameOverScene')).toBe(true);
    expect(getEntries()).toEqual([]);
  });

  it('a non-qualifying score is explained and can be skipped with no write', async () => {
    // Fill the board so a low score cannot make the top 10.
    for (let i = 1; i <= 10; i++) addEntry('AAA', i * 1000);
    const before = getEntries();

    booted = await bootGameOver();
    booted.game.scene.start('GameOverScene', { score: 50, won: false });
    await new Promise((r) => setTimeout(r, 350));
    const scene = booted.game.scene.getScene('GameOverScene') as GameOverScene;

    expect(scene.getQualifies()).toBe(false);
    // No initials field — only the skip control is focusable.
    expect(scene.getControlCount()).toBe(1);
    expect(findTextContaining(scene, 'does not qualify')).toBeDefined();
    expect(findTextContaining(scene, 'Enter Initials')).toBeUndefined();

    const skip = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === '←  Skip',
    );
    expect(skip).toBeDefined();
    skip!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted.game.scene.isActive('MenuScene')).toBe(true);
    expect(getEntries()).toEqual(before);
  });

  it('reads the leaderboard through the shared module (no stub storage)', async () => {
    addEntry('MOD', 4242);

    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    // The module-persisted entry is what the scene renders…
    expect(getEntries()[0]).toMatchObject({ initials: 'MOD', score: 4242 });
    expect(leaderboardRows(scene).some((t) => t.text.includes('MOD'))).toBe(true);
    // …and submitting through the scene writes the same module schema.
    scene.init({ score: 999 });
    scene.handleInitialsKey('X');
    scene.handleInitialsKey('Y');
    scene.handleInitialsKey('Z');
    scene.submitInitials();
    expect(getEntries().map((e) => e.initials)).toEqual(['MOD', 'XYZ']);
  });
});

describe('GameOverScene — full leaderboard display (AC6)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  it('renders all entries (rank, initials, score, date), highest first', async () => {
    const seed = [
      ['AAA', 100],
      ['BBB', 500],
      ['CCC', 300],
      ['DDD', 900],
      ['EEE', 700],
    ] as const;
    for (const [initials, score] of seed) addEntry(initials, score);

    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    const rows = leaderboardRows(scene);
    // All five entries render — the old stub only showed the top 3.
    expect(rows).toHaveLength(5);

    // Ranked highest first.
    expect(rows[0].text).toContain('DDD');
    expect(rows[0].text).toContain('900');
    expect(rows[1].text).toContain('EEE');
    expect(rows[2].text).toContain('BBB');
    expect(rows[3].text).toContain('CCC');
    expect(rows[4].text).toContain('AAA');

    // Each row carries rank, initials, score and ISO date.
    for (const row of rows) {
      expect(row.text).toMatch(/^ *#\d+ {2}[A-Z]{3} +\d+ +\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('shows a placeholder when the leaderboard is empty', async () => {
    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    expect(getEntries()).toEqual([]);
    expect(findTextContaining(scene, 'No scores yet')).toBeDefined();
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
    expect(getEntries()).toMatchObject([{ initials: 'ABC', score: 777, rank: 1 }]);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('AC4 — Enter with incomplete initials does NOT return to the menu', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'A' });
    pressKey(scene, { key: 'Enter' });

    await new Promise((r) => setTimeout(r, 200));
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(true);
    expect(getEntries()).toEqual([]);
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
    expect(getEntries()).toMatchObject([{ initials: 'ABC', score: 321, rank: 1 }]);

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('AC3 — Space on the button returns to the menu even without complete initials', async () => {
    const scene = await boot();
    pressKey(scene, { key: 'Tab' }); // focus button
    pressKey(scene, { key: ' ' });

    await new Promise((r) => setTimeout(r, 350));
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(getEntries()).toEqual([]);
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
