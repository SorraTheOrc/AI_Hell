/**
 * Leaderboard scene (GDD §5.1 — accessible from the main menu).
 *
 * Displays the full local high-score table (rank, initials, score, date),
 * highest score first, using the shared {@link renderLeaderboard} path so the
 * menu and game-over views stay consistent. The single **Back** control is
 * keyboard-navigable through the shared {@link FocusManager} (focused by
 * default; Enter/Space activate) and pointer-clickable.
 */

import Phaser from 'phaser';

import { getEntries } from '../core/Leaderboard';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { renderLeaderboard, LEADERBOARD_TEXT_COLOR } from '../ui/leaderboardView';
import { FocusManager } from '../utils/focusManager';

/** Neon-cyan colour for the title/back control. */
const TITLE_COLOR = LEADERBOARD_TEXT_COLOR;

/** Vertical layout anchors (px, 960×540 canvas). */
const TITLE_Y = 60;
const ROW_START_Y = 120;
const ROW_HEIGHT = 30;
const ROW_FONT = '20px';
const BACK_Y = 480;

/**
 * Main-menu leaderboard view — renders the full table and returns to the menu.
 */
export class LeaderboardScene extends Phaser.Scene {
  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager();

  constructor() {
    super('LeaderboardScene');
  }

  create(): void {
    this.focusManager = new FocusManager();

    // ── Background ───────────────────────────────────────────────
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // ── Title ────────────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, TITLE_Y, 'LEADERBOARD', {
      fontFamily: 'monospace',
      fontSize: '32px',
      color: TITLE_COLOR,
    }).setOrigin(0.5);

    // ── Full ranked table (shared rendering path) ────────────────
    renderLeaderboard(this, getEntries(), {
      topY: ROW_START_Y,
      rowHeight: ROW_HEIGHT,
      fontSize: ROW_FONT,
      color: TITLE_COLOR,
      emptyMessage: 'No scores yet',
    });

    // ── Back control ─────────────────────────────────────────────
    const backButton = this.add.text(GAME_WIDTH / 2, BACK_Y, '←  Back', {
      fontFamily: 'monospace',
      fontSize: '20px',
      color: TITLE_COLOR,
      backgroundColor: '#111111',
      padding: { x: 16, y: 8 },
    }).setOrigin(0.5);
    backButton.setInteractive({ useHandCursor: true });

    backButton.on('pointerover', () => backButton.setStyle({ color: '#88ffff' }));
    backButton.on('pointerout', () => backButton.setStyle({ color: TITLE_COLOR }));
    backButton.on('pointerdown', () => this.returnToMenu());

    // Keyboard navigation: Back is the only control, focused by default.
    this.focusManager.register(backButton, () => this.returnToMenu());
    this.focusManager.attachKeyboard(this);

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });
  }

  /** Returns to the main menu. */
  returnToMenu(): void {
    this.scene.start('MenuScene');
  }

  /** Number of entries rendered in the current view. */
  getEntryCount(): number {
    return getEntries().length;
  }
}
