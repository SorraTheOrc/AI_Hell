/**
 * Game over scene (GDD §5.2 — Game over screen).
 *
 * Displays the final score, prompts for 3-character initials entry
 * (leaderboard stub), and provides a "Return to Menu" button.
 *
 * The leaderboard section is stubbed — it shows a placeholder message
 * until AH-0MU6VSKZT006HBTR is completed.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';

/** Neon-cyan colour for game over text. */
const GAME_OVER_COLOR = '#00ffff';
/** White for score display. */
const SCORE_COLOR = '#ffffff';
/** Red for "DEFEAT" message. */
const DEFEAT_COLOR = '#ff4444';
/** Green for "VICTORY" message. */
const VICTORY_COLOR = '#44ff44';
/** Secondary/dim text colour. */
const DIM_COLOR = '#666666';

/** Initials input field width in characters. */
const INITIALS_LENGTH = 3;

/**
 * Game over scene — shows final score, accepts initials, and
 * provides navigation back to the main menu.
 */
export class GameOverScene extends Phaser.Scene {
  /** Whether the player won (defeated the boss). */
  won: boolean;

  /** Final score passed from PlayScene. */
  finalScore: number;

  /** The current initials string being entered (empty on creation). */
  private initials: string;

  /** The cursor position within the initials field (0–3). */
  private cursorPos: number;

  /** The visible initials text game object. */
  private initialsText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super('GameOverScene');
    this.won = false;
    this.finalScore = 0;
    this.initials = '';
    this.cursorPos = 0;
  }

  /**
   * Initialises the scene data passed from PlayScene.
   */
  init(data?: { won?: boolean; score?: number }): void {
    this.won = data?.won ?? false;
    this.finalScore = data?.score ?? 0;
  }

  create(): void {
    // ── Background ───────────────────────────────────────────────
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // ── Game over header ─────────────────────────────────────────
    const headerColor = this.won ? VICTORY_COLOR : DEFEAT_COLOR;
    const headerText = this.won ? 'VICTORY' : 'DEFEAT';
    this.add.text(GAME_WIDTH / 2, 100, headerText, {
      fontFamily: 'monospace',
      fontSize: '40px',
      color: headerColor,
    }).setOrigin(0.5);

    // ── Final score ──────────────────────────────────────────────
    this.add.text(
      GAME_WIDTH / 2,
      180,
      `Final Score: ${this.finalScore}`,
      {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: SCORE_COLOR,
      },
    ).setOrigin(0.5);

    // ── Initials entry ───────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, 250, 'Enter Initials:', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: DIM_COLOR,
    }).setOrigin(0.5);

    this.initialsText = this.add.text(
      GAME_WIDTH / 2,
      290,
      '___',
      {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: GAME_OVER_COLOR,
      },
    ).setOrigin(0.5);

    // ── Leaderboard stub ─────────────────────────────────────────
    this.add.text(
      GAME_WIDTH / 2,
      360,
      'Leaderboard coming soon',
      {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: DIM_COLOR,
      },
    ).setOrigin(0.5);

    // ── Return to Menu button ────────────────────────────────────
    const menuButton = this.add.text(
      GAME_WIDTH / 2,
      430,
      '←  Return to Menu',
      {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: GAME_OVER_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      },
    ).setOrigin(0.5);
    menuButton.setInteractive({ useHandCursor: true });

    menuButton.on('pointerover', () => {
      menuButton.setStyle({ color: '#88ffff' });
    });
    menuButton.on('pointerout', () => {
      menuButton.setStyle({ color: GAME_OVER_COLOR });
    });

    menuButton.on('pointerdown', () => {
      this.scene.start('MenuScene');
    });

    // ── Keyboard input for initials ──────────────────────────────
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      // Accept A–Z only.
      if (event.key.length === 1 && /^[A-Z]$/i.test(event.key)) {
        if (this.initials.length < INITIALS_LENGTH) {
          this.initials += event.key.toUpperCase();
          this.cursorPos = this.initials.length;
          this._updateInitialsDisplay();
        }
      }
      // Backspace to delete.
      if (event.key === 'Backspace' && this.initials.length > 0) {
        this.initials = this.initials.slice(0, -1);
        this.cursorPos = this.initials.length;
        this._updateInitialsDisplay();
      }
      // Submit with Enter when 3 characters entered.
      if (event.key === 'Enter' && this.initials.length === INITIALS_LENGTH) {
        // Leaderboard stub: save to localStorage placeholder.
        this._saveScore();
        this.scene.start('MenuScene');
      }
    });
  }

  /**
   * Updates the initials display with a cursor indicator.
   */
  private _updateInitialsDisplay(): void {
    const display = this.initials.length < INITIALS_LENGTH
      ? this.initials.padEnd(INITIALS_LENGTH, '_').slice(0, this.cursorPos + 1) + '|'
      : this.initials;
    this.initialsText?.setText(display);
  }

  /**
   * Stub: saves the score with initials to localStorage.
   * The leaderboard work item will replace this with full persistence.
   */
  private _saveScore(): void {
    try {
      const key = 'ai_hell_leaderboard';
      const existing: Array<{ score: number; initials: string }> = [];
      try {
        const raw = localStorage.getItem(key);
        if (raw) existing.push(JSON.parse(raw));
      } catch {
        // Ignore corrupt data.
      }
      existing.push({ score: this.finalScore, initials: this.initials });
      existing.sort((a, b) => b.score - a.score);
      localStorage.setItem(key, JSON.stringify(existing.slice(0, 10)));
    } catch {
      // localStorage may be unavailable in tests; silently ignore.
    }
  }
}
