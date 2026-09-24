/**
 * Shared leaderboard rendering helpers (GDD §5.1).
 *
 * Both the game-over screen and the main-menu leaderboard scene render the
 * same ranked table through {@link renderLeaderboard}, so the two surfaces
 * stay visually and structurally consistent. Column layout lives in
 * {@link formatLeaderboardRow}.
 */

import Phaser from 'phaser';

import { GAME_WIDTH } from '../core/constants';
import { INITIALS_LENGTH, type LeaderboardEntry } from '../core/Leaderboard';

/** Neon-cyan colour for leaderboard text (GDD §7.1). */
export const LEADERBOARD_TEXT_COLOR = '#00ffff';
/** Dim colour for the empty-state message. */
export const LEADERBOARD_EMPTY_COLOR = '#666666';

/** Options controlling {@link renderLeaderboard}. */
export interface RenderLeaderboardOptions {
  /** Horizontal centre of the rows (defaults to the canvas centre). */
  x?: number;
  /** Top y of the first row (defaults to 0). */
  topY?: number;
  /** Vertical spacing between rows (defaults to 18). */
  rowHeight?: number;
  /** Row font size (defaults to 13px). */
  fontSize?: string;
  /** Row text colour (defaults to neon cyan). */
  color?: string;
  /** Message rendered when the leaderboard is empty. */
  emptyMessage?: string;
}

/**
 * Formats one leaderboard row as aligned monospace columns:
 * `#rank  INITIALS  SCORE  YYYY-MM-DD`.
 */
export function formatLeaderboardRow(entry: LeaderboardEntry): string {
  const rank = `#${entry.rank}`.padStart(3, ' ');
  return `${rank}  ${entry.initials.padEnd(INITIALS_LENGTH, ' ')}  ${entry.score
    .toString()
    .padStart(7, ' ')}  ${entry.date}`;
}

/**
 * Adds the leaderboard rows to `scene`, highest score first. Returns the
 * created text objects (a single empty-state message when `entries` is
 * empty). Callers own the surrounding title/controls.
 */
export function renderLeaderboard(
  scene: Phaser.Scene,
  entries: LeaderboardEntry[],
  options: RenderLeaderboardOptions = {},
): Phaser.GameObjects.Text[] {
  const x = options.x ?? GAME_WIDTH / 2;
  const topY = options.topY ?? 0;
  const rowHeight = options.rowHeight ?? 18;
  const fontSize = options.fontSize ?? '13px';
  const color = options.color ?? LEADERBOARD_TEXT_COLOR;

  if (entries.length === 0) {
    return [
      scene.add
        .text(x, topY, options.emptyMessage ?? 'No scores yet', {
          fontFamily: 'monospace',
          fontSize,
          color: LEADERBOARD_EMPTY_COLOR,
        })
        .setOrigin(0.5, 0),
    ];
  }

  return entries.map((entry, index) =>
    scene.add
      .text(x, topY + index * rowHeight, formatLeaderboardRow(entry), {
        fontFamily: 'monospace',
        fontSize,
        color,
      })
      .setOrigin(0.5, 0),
  );
}
