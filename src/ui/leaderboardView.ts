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
import { INITIALS_LENGTH } from '../core/Leaderboard';

/** Neon-cyan colour for leaderboard text (GDD §7.1). */
export const LEADERBOARD_TEXT_COLOR = '#00ffff';
/** Dim colour for the empty-state message. */
export const LEADERBOARD_EMPTY_COLOR = '#666666';
/** Highlight colour for the prospective (being-entered) row (GDD §5.1). */
export const LEADERBOARD_PREVIEW_COLOR = '#ffff00';
/** Leading marker flagging the prospective (being-entered) row (GDD §5.1). */
export const LEADERBOARD_PREVIEW_MARKER = '▶';

/**
 * One row accepted by {@link renderLeaderboard}. A persisted
 * {@link LeaderboardEntry} satisfies it directly; the game-over screen adds
 * preview rows flagged with {@link isPreview}, whose (possibly partial)
 * initials are padded with `_` placeholders.
 */
export interface LeaderboardDisplayRow {
  /** 1-based position once the table is sorted by score descending. */
  rank: number;
  /** Initials to show; preview rows may be partial and are padded with `_`. */
  initials: string;
  /** Points earned in the run. */
  score: number;
  /** ISO calendar date, `YYYY-MM-DD`. */
  date: string;
  /** True for the prospective entry being typed (rendered highlighted). */
  isPreview?: boolean;
}

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
  /** Colour for a prospective ({@link LeaderboardDisplayRow.isPreview}) row. */
  highlightColor?: string;
  /** Leading marker for a prospective row. */
  highlightMarker?: string;
}

/**
 * Formats one leaderboard row as aligned monospace columns:
 * `#rank  INITIALS  SCORE  YYYY-MM-DD`. A prospective row is prefixed with
 * `marker` and its initials are padded with `_` placeholders.
 */
export function formatLeaderboardRow(
  row: LeaderboardDisplayRow,
  marker: string = LEADERBOARD_PREVIEW_MARKER,
): string {
  const rank = `#${row.rank}`.padStart(3, ' ');
  const initials = row.initials.padEnd(INITIALS_LENGTH, '_');
  const prefix = row.isPreview ? `${marker} ` : '';
  return `${prefix}${rank}  ${initials}  ${row.score
    .toString()
    .padStart(7, ' ')}  ${row.date}`;
}

/**
 * Adds the leaderboard rows to `scene`, highest score first. A prospective
 * row ({@link LeaderboardDisplayRow.isPreview}) is rendered in the highlight
 * colour with a leading marker. Returns the created text objects (a single
 * empty-state message when `rows` is empty). Callers own the surrounding
 * title/controls.
 */
export function renderLeaderboard(
  scene: Phaser.Scene,
  rows: LeaderboardDisplayRow[],
  options: RenderLeaderboardOptions = {},
): Phaser.GameObjects.Text[] {
  const x = options.x ?? GAME_WIDTH / 2;
  const topY = options.topY ?? 0;
  const rowHeight = options.rowHeight ?? 18;
  const fontSize = options.fontSize ?? '13px';
  const color = options.color ?? LEADERBOARD_TEXT_COLOR;
  const highlightColor = options.highlightColor ?? LEADERBOARD_PREVIEW_COLOR;
  const highlightMarker = options.highlightMarker ?? LEADERBOARD_PREVIEW_MARKER;

  if (rows.length === 0) {
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

  return rows.map((row, index) =>
    scene.add
      .text(x, topY + index * rowHeight, formatLeaderboardRow(row, highlightMarker), {
        fontFamily: 'monospace',
        fontSize,
        color: row.isPreview ? highlightColor : color,
      })
      .setOrigin(0.5, 0),
  );
}
