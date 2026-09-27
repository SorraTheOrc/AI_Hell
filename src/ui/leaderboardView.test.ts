/**
 * Unit tests for the shared leaderboard rendering helpers
 * (AH-0MUE86S5F002VVQD — live prospective row).
 *
 * Covers the row format for persisted and prospective rows, the placeholder
 * padding of partial initials, and the highlight marker/colour applied by
 * {@link renderLeaderboard}.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  formatLeaderboardRow,
  LEADERBOARD_PREVIEW_COLOR,
  LEADERBOARD_PREVIEW_MARKER,
  LEADERBOARD_TEXT_COLOR,
  renderLeaderboard,
} from './leaderboardView';

/** A bare scene so {@link renderLeaderboard} has a real display list. */
class ViewScene extends Phaser.Scene {
  constructor() {
    super({ key: 'ViewScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

describe('leaderboardView — formatLeaderboardRow (AH-0MUE86S5F002VVQD)', () => {
  it('formats a persisted row as aligned rank/initials/score/date columns', () => {
    const text = formatLeaderboardRow({
      rank: 3,
      initials: 'ABC',
      score: 1234,
      date: '2026-09-27',
    });

    expect(text).toBe(' #3  ABC     1234  2026-09-27');
    expect(text).not.toContain(LEADERBOARD_PREVIEW_MARKER);
  });

  it('prefixes a prospective row with the marker and pads initials with placeholders', () => {
    const empty = formatLeaderboardRow({
      rank: 2,
      initials: '',
      score: 500,
      date: '2026-09-27',
      isPreview: true,
    });
    expect(empty.startsWith(`${LEADERBOARD_PREVIEW_MARKER} `)).toBe(true);
    expect(empty).toContain(' #2');
    expect(empty).toContain('___');
    expect(empty).toContain('500');

    const partial = formatLeaderboardRow({
      rank: 2,
      initials: 'A',
      score: 500,
      date: '2026-09-27',
      isPreview: true,
    });
    expect(partial).toContain('A__');
  });
});

describe('leaderboardView — renderLeaderboard highlight (AH-0MUE86S5F002VVQD)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  async function boot(): Promise<Phaser.Scene> {
    booted = await bootScene([ViewScene]);
    return booted.scene;
  }

  it('renders the prospective row in the highlight colour with a marker only', async () => {
    const scene = await boot();

    const rows = renderLeaderboard(scene, [
      { rank: 1, initials: 'AAA', score: 900, date: '2026-09-27' },
      { rank: 2, initials: '', score: 500, date: '2026-09-27', isPreview: true },
    ]);

    expect(rows).toHaveLength(2);
    // Persisted row: normal colour, no marker.
    expect(rows[0].style.color).toBe(LEADERBOARD_TEXT_COLOR);
    expect(rows[0].text).not.toContain(LEADERBOARD_PREVIEW_MARKER);
    // Prospective row: highlight colour, leading marker, placeholder initials.
    expect(rows[1].style.color).toBe(LEADERBOARD_PREVIEW_COLOR);
    expect(rows[1].text.startsWith(`${LEADERBOARD_PREVIEW_MARKER} `)).toBe(true);
    expect(rows[1].text).toContain('___');
  });

  it('renders the empty-state message when there are no rows', async () => {
    const scene = await boot();

    const rows = renderLeaderboard(scene, [], { emptyMessage: 'No scores yet' });

    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe('No scores yet');
  });
});
