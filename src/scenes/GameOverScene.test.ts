/**
 * Unit tests for the GameOverScene (AH-0MU731426003FE71 — child 6; extended by
 * AH-0MUD9ZNN30065ZLP — game-over leaderboard UX).
 *
 * Covers score display, initials input validation (A–Z only, 3 chars,
 * backspace, submit), qualifying vs non-qualifying leaderboard behaviour,
 * the full ranked leaderboard display (module-backed, no stub), and the
 * return to the main menu.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import * as effectsModule from '../audio/effects';
import * as endOfRunModule from '../vfx/endOfRunJuice';
import { bootScene, type BootedGame } from '../test/gameHarness';
import { addEntry, getEntries, MAX_ENTRIES } from '../core/Leaderboard';
import {
  LEADERBOARD_PREVIEW_COLOR,
  LEADERBOARD_TEXT_COLOR,
} from '../ui/leaderboardView';
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

  it('shows a prospective #1 row (not the empty message) on an empty board', async () => {
    booted = await bootGameOver();
    const scene = booted.scene as GameOverScene;

    expect(getEntries()).toEqual([]);
    // A qualifying score replaces the empty-state message with the preview row
    // (AC1 has no persisted entries to show but still renders the rank).
    const preview = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text.startsWith('▶'),
    );
    expect(preview).toBeDefined();
    expect(preview!.text).toContain('#1');
    expect(preview!.text).toContain('___');
    expect(findTextContaining(scene, 'No scores yet')).toBeUndefined();
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

describe('GameOverScene — live leaderboard preview (AH-0MUE86S5F002VVQD)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Rendered prospective row texts (they start with the highlight marker). */
  function previewRows(scene: GameOverScene): Phaser.GameObjects.Text[] {
    return (scene.children.list as Phaser.GameObjects.Text[]).filter(
      (c) => c instanceof Phaser.GameObjects.Text && c.text.startsWith('▶'),
    );
  }

  /** Numeric score column for each persisted row rendered on screen. */
  function scoresOf(scene: GameOverScene): number[] {
    return leaderboardRows(scene).map((r) =>
      Number(r.text.split(/\s+/).filter(Boolean)[2]),
    );
  }

  async function startWith(score: number): Promise<GameOverScene> {
    booted = await bootGameOver();
    booted.game.scene.start('GameOverScene', { score, won: false });
    await new Promise((r) => setTimeout(r, 350));
    return booted.game.scene.getScene('GameOverScene') as GameOverScene;
  }

  it('AC1 — qualifying score shows one highlighted row immediately, before typing', async () => {
    addEntry('AAA', 300);
    addEntry('BBB', 100);

    const scene = await startWith(200);

    expect(scene.getQualifies()).toBe(true);
    const preview = previewRows(scene);
    expect(preview).toHaveLength(1);
    expect(preview[0].text).toContain('#2');
    expect(preview[0].text).toContain('___');
    expect(preview[0].style.color).toBe(LEADERBOARD_PREVIEW_COLOR);
    expect(scene.getPreviewEntry()).toMatchObject({
      rank: 2,
      initials: '',
      score: 200,
      isPreview: true,
    });
  });

  it('AC2 — each letter and Backspace updates the prospective row live', async () => {
    addEntry('AAA', 300);
    const scene = await startWith(200);

    scene.handleInitialsKey('A');
    expect(previewRows(scene)[0].text).toContain('A__');
    scene.handleInitialsKey('B');
    expect(previewRows(scene)[0].text).toContain('AB_');
    scene.handleInitialsKey('Backspace');
    expect(previewRows(scene)[0].text).toContain('A__');
    scene.handleInitialsKey('Backspace');
    expect(previewRows(scene)[0].text).toContain('___');

    // Re-rendering replaces the row rather than accumulating text objects.
    expect(previewRows(scene)).toHaveLength(1);
    // Only the prospective row shows placeholders.
    expect(leaderboardRows(scene).every((r) => !r.text.includes('_'))).toBe(true);
  });

  it('AC3 — only the prospective row is highlighted and marked', async () => {
    addEntry('AAA', 300);
    addEntry('BBB', 100);
    const scene = await startWith(200);

    expect(previewRows(scene)).toHaveLength(1);
    for (const row of leaderboardRows(scene)) {
      expect(row.text).not.toContain('▶');
      expect(row.style.color).toBe(LEADERBOARD_TEXT_COLOR);
    }
    expect(previewRows(scene)[0].style.color).toBe(LEADERBOARD_PREVIEW_COLOR);
  });

  it(`AC4 — full table inserts the prospective row at its rank and drops the lowest`, async () => {
    for (let i = 1; i <= 10; i++) addEntry('AAA', i * 100);
    const scene = await startWith(1100);

    expect(scene.getQualifies()).toBe(true);
    // Nine persisted rows survive (the 100-point entry is displaced) + preview.
    expect(leaderboardRows(scene)).toHaveLength(MAX_ENTRIES - 1);
    expect(scoresOf(scene)).not.toContain(100);
    expect(scoresOf(scene)).toContain(200);

    const preview = previewRows(scene);
    expect(preview).toHaveLength(1);
    expect(preview[0].text).toContain('#1');
    expect(scene.getPreviewEntry()).toMatchObject({ rank: 1, score: 1100 });
  });

  it('AC5 — non-qualifying score renders no prospective row and writes nothing', async () => {
    for (let i = 1; i <= 10; i++) addEntry('AAA', i * 100);
    const before = getEntries();

    const scene = await startWith(50);

    expect(scene.getQualifies()).toBe(false);
    expect(previewRows(scene)).toHaveLength(0);
    expect(scene.getPreviewEntry()).toBeNull();

    scene.submitScoreAndReturn();
    await new Promise((r) => setTimeout(r, 350));
    expect(getEntries()).toEqual(before);
  });

  it('AC6 — the persisted entry takes the rank shown by the preview', async () => {
    addEntry('AAA', 500);
    addEntry('BBB', 300);
    const scene = await startWith(400);

    const previewRank = scene.getPreviewEntry()!.rank;
    expect(previewRank).toBe(2);

    scene.handleInitialsKey('X');
    scene.handleInitialsKey('Y');
    scene.handleInitialsKey('Z');
    scene.handleInitialsKey('Enter');

    const persisted = getEntries().find((e) => e.initials === 'XYZ')!;
    expect(persisted.rank).toBe(previewRank);
    expect(persisted.score).toBe(400);
  });
});

describe('GameOverScene — end-of-run treatment (AH-0MUTYKDH1002I35C)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  /** Boots the scene and restarts it with `data`, then settles ~350 ms. */
  async function bootWith(data: {
    won: boolean;
    score?: number;
  }): Promise<GameOverScene> {
    booted = await bootGameOver();
    booted.game.scene.start('GameOverScene', data);
    await new Promise((r) => setTimeout(r, 350));
    return booted.game.scene.getScene('GameOverScene') as GameOverScene;
  }

  /** The juice-layer tags still alive in the scene's effects registry. */
  function liveLayers(scene: GameOverScene): string[] {
    return scene
      .getEndOfRunEffects()
      .map((o) => (o.getData ? o.getData('juiceLayer') : undefined))
      .filter((v): v is string => typeof v === 'string');
  }

  it('wires the victory celebration on the victory branch and not the defeat treatment', async () => {
    booted = await bootGameOver();
    const victorySpy = vi.spyOn(endOfRunModule, 'spawnVictoryJuice');
    const defeatSpy = vi.spyOn(endOfRunModule, 'spawnDefeatScreenJuice');

    booted.game.scene.start('GameOverScene', { won: true, score: 100 });
    await new Promise((r) => setTimeout(r, 350));
    const scene = booted.game.scene.getScene('GameOverScene') as GameOverScene;

    expect(victorySpy).toHaveBeenCalledTimes(1);
    expect(defeatSpy).not.toHaveBeenCalled();
    // The victory layers are alive in the registry.
    const layers = liveLayers(scene);
    expect(layers.some((t) => t.startsWith('victory'))).toBe(true);
    expect(layers.some((t) => t.startsWith('defeat'))).toBe(false);
  });

  it('wires the defeat treatment and plays the sting exactly once on the defeat branch', async () => {
    booted = await bootGameOver();
    const victorySpy = vi.spyOn(endOfRunModule, 'spawnVictoryJuice');
    const defeatSpy = vi.spyOn(endOfRunModule, 'spawnDefeatScreenJuice');
    const stingSpy = vi.spyOn(effectsModule, 'playDefeatStingSound');

    booted.game.scene.start('GameOverScene', { won: false, score: 100 });
    await new Promise((r) => setTimeout(r, 350));
    const scene = booted.game.scene.getScene('GameOverScene') as GameOverScene;

    expect(defeatSpy).toHaveBeenCalledTimes(1);
    expect(victorySpy).not.toHaveBeenCalled();
    expect(stingSpy).toHaveBeenCalledTimes(1);
    const layers = liveLayers(scene);
    expect(layers.some((t) => t.startsWith('defeat'))).toBe(true);
    expect(layers.some((t) => t.startsWith('victory'))).toBe(false);
  });

  it('does not play the defeat sting on the victory branch', async () => {
    booted = await bootGameOver();
    const stingSpy = vi.spyOn(effectsModule, 'playDefeatStingSound');

    booted.game.scene.start('GameOverScene', { won: true, score: 5000 });
    await new Promise((r) => setTimeout(r, 350));

    expect(stingSpy).not.toHaveBeenCalled();
  });

  it('renders the treatment behind the UI (negative depth vs depth-0 UI)', async () => {
    const scene = await bootWith({ won: false, score: 12345 });

    const effects = scene.getEndOfRunEffects();
    expect(effects.length).toBeGreaterThan(0);
    const header = findTextContaining(scene, 'DEFEAT');
    expect(header).toBeDefined();
    for (const effect of effects) {
      const depth = (effect as unknown as { depth: number }).depth;
      expect(depth).toBeLessThan(0);
      expect(header!.depth).toBeGreaterThan(depth);
    }
  });

  it('keeps initials entry and focus navigation usable while the treatment is active', async () => {
    const scene = await bootWith({ won: false, score: 12345 });
    expect(scene.getEndOfRunEffects().length).toBeGreaterThan(0);

    // Keyboard initials: A–Z typing and Backspace all still work.
    expect(scene.handleKey(new KeyboardEvent('keydown', { key: 'A' }))).toBe(true);
    expect(scene.handleKey(new KeyboardEvent('keydown', { key: 'b' }))).toBe(true);
    expect(scene.handleKey(new KeyboardEvent('keydown', { key: 'C' }))).toBe(true);
    expect(scene.getInitials()).toBe('ABC');
    expect(scene.handleKey(new KeyboardEvent('keydown', { key: 'Backspace' }))).toBe(true);
    expect(scene.getInitials()).toBe('AB');
    scene.handleKey(new KeyboardEvent('keydown', { key: 'C' }));

    // Focus navigation: Tab moves to the menu button and back.
    scene.handleKey(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(scene.getFocusedIndex()).toBe(1);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(scene.getFocusedIndex()).toBe(0);
    // Return to Menu is still focusable.
    expect(scene.getControlCount()).toBe(2);
  });

  it('keeps the Return to Menu pointer handler usable while the treatment is active', async () => {
    const scene = await bootWith({ won: true, score: 12345 });
    expect(scene.getEndOfRunEffects().length).toBeGreaterThan(0);

    const button = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) =>
        c instanceof Phaser.GameObjects.Text &&
        c.text === '←  Return to Menu',
    );
    expect(button).toBeDefined();
    expect(button!.input?.enabled).toBe(true);
    button!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('GameOverScene')).toBe(false);
  });

  it('destroys every treatment object on SHUTDOWN and clears the registry', async () => {
    const scene = await bootWith({ won: false, score: 12345 });
    const effects = scene.getEndOfRunEffects();
    expect(effects.length).toBeGreaterThan(0);

    // Restarting the scene fires SHUTDOWN on the old instance.
    scene.scene.start('MenuScene');
    await new Promise((r) => setTimeout(r, 300));

    expect(scene.getEndOfRunEffects()).toHaveLength(0);
    for (const effect of effects) {
      expect(effect.active).toBe(false);
    }
  });

  it('leaves no orphaned treatment objects across a defeat→victory restart', async () => {
    const defeatScene = await bootWith({ won: false, score: 100 });
    const defeatEffects = defeatScene.getEndOfRunEffects();
    expect(defeatEffects.length).toBeGreaterThan(0);

    booted!.game.scene.start('GameOverScene', { won: true, score: 200 });
    await new Promise((r) => setTimeout(r, 350));
    const victoryScene = booted!.game.scene.getScene('GameOverScene') as GameOverScene;

    // The old defeat treatment is gone…
    for (const effect of defeatEffects) {
      expect(effect.active).toBe(false);
    }
    // …and the new scene only owns victory layers.
    const layers = liveLayers(victoryScene);
    expect(layers.some((t) => t.startsWith('victory'))).toBe(true);
    expect(layers.some((t) => t.startsWith('defeat'))).toBe(false);
  });
});

// ── Verification sweep (AH-0MUTYKR1O007XE2N) ────────────────────────

describe('GameOverScene — end-of-run treatment input & teardown sweep (AH-0MUTYKR1O007XE2N)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootWith(data: {
    won: boolean;
    score?: number;
  }): Promise<GameOverScene> {
    booted = await bootGameOver();
    booted.game.scene.start('GameOverScene', data);
    await new Promise((r) => setTimeout(r, 350));
    return booted.game.scene.getScene('GameOverScene') as GameOverScene;
  }

  it('arrows and Shift+Tab move focus while the treatment is active', async () => {
    const scene = await bootWith({ won: false, score: 12345 });
    expect(scene.getEndOfRunEffects().length).toBeGreaterThan(0);

    expect(scene.getFocusedIndex()).toBe(0);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(scene.getFocusedIndex()).toBe(1);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(scene.getFocusedIndex()).toBe(0);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(scene.getFocusedIndex()).toBe(1);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(scene.getFocusedIndex()).toBe(0);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
    expect(scene.getFocusedIndex()).toBe(1);
  });

  it('Enter activates the focused Return to Menu control while the treatment is active', async () => {
    const scene = await bootWith({ won: true, score: 12345 });
    expect(scene.getEndOfRunEffects().length).toBeGreaterThan(0);

    // Focus the Return to Menu button (index 1), then activate with Enter.
    scene.handleKey(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(scene.getFocusedIndex()).toBe(1);
    scene.handleKey(new KeyboardEvent('keydown', { key: 'Enter' }));
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('Space activates the focused control while the treatment is active', async () => {
    const scene = await bootWith({ won: false, score: 200 });
    expect(scene.getEndOfRunEffects().length).toBeGreaterThan(0);

    scene.handleKey(new KeyboardEvent('keydown', { key: 'Tab' }));
    scene.handleKey(new KeyboardEvent('keydown', { key: ' ' }));
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('the Skip pointer handler works for a non-qualifying score while the treatment is active', async () => {
    // Fill the board so this low score cannot qualify.
    for (let i = 1; i <= 10; i++) addEntry('AAA', i * 1000);
    const scene = await bootWith({ won: false, score: 50 });
    expect(scene.getEndOfRunEffects().length).toBeGreaterThan(0);

    const skip = (scene.children.list as Phaser.GameObjects.Text[]).find(
      (c) => c instanceof Phaser.GameObjects.Text && c.text === '←  Skip',
    );
    expect(skip).toBeDefined();
    skip!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });

  it('the treatment objects are non-interactive and cannot intercept input', async () => {
    const scene = await bootWith({ won: false, score: 12345 });

    const effects = scene.getEndOfRunEffects();
    expect(effects.length).toBeGreaterThan(0);
    for (const effect of effects) {
      // No input component → the object cannot capture a pointer event.
      expect(effect.input ?? null).toBeNull();
    }
  });

  it('a stop/restart sweep leaves no orphaned treatment objects in the scene', async () => {
    const scene = await bootWith({ won: false, score: 12345 });
    const effects = scene.getEndOfRunEffects();
    expect(effects.length).toBeGreaterThan(0);

    // Restart the scene: SHUTDOWN destroys the old treatment.
    scene.scene.restart({ won: true, score: 999 });
    await new Promise((r) => setTimeout(r, 350));

    for (const effect of effects) expect(effect.active).toBe(false);

    // No leftover juice layer from the previous defeat treatment survives.
    const restarted = booted!.game.scene.getScene('GameOverScene') as GameOverScene;
    const layers = restarted
      .getEndOfRunEffects()
      .map((o) => (o.getData ? o.getData('juiceLayer') : undefined));
    expect(layers.some((t) => typeof t === 'string' && t.startsWith('defeat'))).toBe(false);
    expect(layers.some((t) => typeof t === 'string' && t.startsWith('victory'))).toBe(true);
  });
});
