/**
 * Unit tests for the shared LeaderboardScene (AH-0MUD9ZNZJ001P7RF).
 *
 * Covers the full ranked table (rank, initials, score, date, highest first),
 * the empty state, and the keyboard/pointer Return-to-Menu paths.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { addEntry } from '../core/Leaderboard';
import { bootScene, type BootedGame } from '../test/gameHarness';
import { LeaderboardScene } from './LeaderboardScene';
import { MenuScene } from './MenuScene';

/** Rendered leaderboard row texts (rows start with the `#rank` marker). */
function rowsOf(scene: Phaser.Scene): Phaser.GameObjects.Text[] {
  return (scene.children.list as Phaser.GameObjects.Text[]).filter(
    (c) => c instanceof Phaser.GameObjects.Text && /^ *#\d+/.test(c.text),
  );
}

function findText(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text | undefined {
  return (scene.children.list as Phaser.GameObjects.Text[]).find(
    (c) => c instanceof Phaser.GameObjects.Text && c.text === label,
  );
}

describe('LeaderboardScene — full view (AH-0MUD9ZNZJ001P7RF)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    localStorage.clear();
  });

  async function bootLeaderboard(): Promise<LeaderboardScene> {
    booted = await bootScene([LeaderboardScene, MenuScene]);
    return booted.scene as LeaderboardScene;
  }

  it('renders the title and every entry (rank, initials, score, date), highest first', async () => {
    for (const [initials, score] of [
      ['AAA', 100],
      ['BBB', 900],
      ['CCC', 500],
      ['DDD', 300],
      ['EEE', 700],
    ] as const) {
      addEntry(initials, score);
    }

    const scene = await bootLeaderboard();

    expect(findText(scene, 'LEADERBOARD')).toBeDefined();
    const rows = rowsOf(scene);
    expect(rows).toHaveLength(5);
    expect(scene.getEntryCount()).toBe(5);

    expect(rows[0].text).toContain('BBB');
    expect(rows[1].text).toContain('EEE');
    expect(rows[2].text).toContain('CCC');
    expect(rows[3].text).toContain('DDD');
    expect(rows[4].text).toContain('AAA');

    for (const row of rows) {
      expect(row.text).toMatch(/^ *#\d+ {2}[A-Z]{3} +\d+ +\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('shows an empty-state message when there are no scores', async () => {
    const scene = await bootLeaderboard();
    expect(rowsOf(scene)).toHaveLength(0);
    expect(findText(scene, 'No scores yet')).toBeDefined();
  });

  it('Back returns to the main menu when clicked', async () => {
    const scene = await bootLeaderboard();

    findText(scene, '←  Back')!.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('LeaderboardScene')).toBe(false);
  });

  it('Enter on the focused Back control returns to the main menu', async () => {
    const scene = await bootLeaderboard();

    scene.input.keyboard!.emit('keydown', {
      repeat: false,
      preventDefault: () => {},
      key: 'Enter',
    } as KeyboardEvent);
    await new Promise((r) => setTimeout(r, 350));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
  });
});
