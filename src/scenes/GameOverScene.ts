/**
 * Game over scene (GDD §5.2 — Game over screen).
 *
 * Displays the final score, prompts for a 3-character initials entry
 * (leaderboard stub), and provides a "Return to Menu" button.
 *
 * Keyboard navigation (AH-0MU9LKQEP008LCX9-C3) is provided by the shared
 * {@link FocusManager}: the initials field is focused by default, Tab and
 * the arrow keys move focus to the Return to Menu button (and back), and
 * Enter/Space activate the focused control. A–Z and Backspace edit the
 * initials while the field is focused. Pointer handlers are unchanged.
 *
 * The leaderboard section is stubbed — it persists entries to localStorage
 * (`ai_hell_leaderboard`) as a placeholder until AH-0MU6VSKZT006HBTR is
 * completed.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { FocusManager } from '../utils/focusManager';

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
export const INITIALS_LENGTH = 3;

/** localStorage key for the leaderboard stub. */
export const LEADERBOARD_STORAGE_KEY = 'ai_hell_leaderboard';

/** One persisted leaderboard entry (stub schema). */
export interface LeaderboardEntry {
  initials: string;
  score: number;
}

/** True when a key is an A–Z letter (case-insensitive). */
export function isInitialsLetter(key: string): boolean {
  return key.length === 1 && /^[A-Z]$/i.test(key);
}

/**
 * Reads the stub leaderboard from localStorage (empty when absent/corrupt).
 */
export function readLeaderboard(): LeaderboardEntry[] {
  try {
    const raw = localStorage.getItem(LEADERBOARD_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is LeaderboardEntry =>
          typeof e?.initials === 'string' && typeof e?.score === 'number',
      )
      .sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

/**
 * Merges an entry into the stub leaderboard (sorted desc, capped at 10).
 * Returns the updated list.
 */
export function saveScoreEntry(
  entry: LeaderboardEntry,
): LeaderboardEntry[] {
  const entries = [...readLeaderboard(), entry]
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  try {
    localStorage.setItem(LEADERBOARD_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage may be unavailable (headless tests); ignore.
  }
  return entries;
}

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

  /** The visible initials text game object. */
  private initialsText: Phaser.GameObjects.Text | null = null;

  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager();

  /** Focus index of the initials field (registration order: 0). */
  private initialsFocusIndex = 0;

  constructor() {
    super('GameOverScene');
    this.won = false;
    this.finalScore = 0;
    this.initials = '';
  }

  /**
   * Initialises the scene data passed from PlayScene.
   */
  init(data?: { won?: boolean; score?: number }): void {
    this.won = data?.won ?? false;
    this.finalScore = data?.score ?? 0;
  }

  create(): void {
    this.focusManager = new FocusManager();

    // ── Background ───────────────────────────────────────────────
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // ── Game over header ─────────────────────────────────────────
    const headerColor = this.won ? VICTORY_COLOR : DEFEAT_COLOR;
    const headerText = this.won ? 'VICTORY' : 'DEFEAT';
    this.add.text(GAME_WIDTH / 2, 80, headerText, {
      fontFamily: 'monospace',
      fontSize: '40px',
      color: headerColor,
    }).setOrigin(0.5);

    // ── Final score ──────────────────────────────────────────────
    this.add.text(
      GAME_WIDTH / 2,
      150,
      `Final Score: ${this.finalScore}`,
      {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: SCORE_COLOR,
      },
    ).setOrigin(0.5);

    // ── Initials entry ───────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, 220, 'Enter Initials:', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: DIM_COLOR,
    }).setOrigin(0.5);

    this.initialsText = this.add.text(
      GAME_WIDTH / 2,
      255,
      this._initialsDisplay(),
      {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: GAME_OVER_COLOR,
      },
    ).setOrigin(0.5);

    // ── Leaderboard stub ─────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, 320, 'LEADERBOARD', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: DIM_COLOR,
    }).setOrigin(0.5);

    this._renderLeaderboard();

    // ── Return to Menu button ────────────────────────────────────
    const menuButton = this.add.text(
      GAME_WIDTH / 2,
      440,
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

    // ── Keyboard focus (AH-0MU9LKQEP008LCX9-C3) ──────────────────
    // The initials field is registered first, so it is focused by default.
    // Text keys (A–Z / Backspace) are routed to the initials model only
    // while the field is focused; all focus keys are owned by the manager.
    const initialsField = this.initialsText;
    if (initialsField) {
      this.initialsFocusIndex = this.focusManager.register(
        initialsField,
        () => this.submitInitials(),
      );
    }
    this.focusManager.register(menuButton, () =>
      this.submitScoreAndReturn(),
    );
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.handleKey(event);
    });

    // ── Hygiene on shutdown: drop transient input state. ──────────
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
      this.initials = '';
      this.initialsText = null;
    });
  }

  // ── Public input model (unit-testable without real key events) ─

  /**
   * Routes one keyboard event: while the initials field is focused, A–Z
   * and Backspace edit the initials; everything else (Tab / arrows /
   * Enter / Space) is handled by the shared focus manager. Returns true
   * when the key was consumed.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.repeat) return false;
    if (this.focusManager.getFocusedIndex() === this.initialsFocusIndex) {
      if (isInitialsLetter(event.key) || event.key === 'Backspace') {
        this.handleInitialsKey(event.key);
        return true;
      }
    }
    return this.focusManager.handleKey(event);
  }

  /** Focus index of the currently focused control (−1 when none). */
  getFocusedIndex(): number {
    return this.focusManager.getFocusedIndex();
  }

  /** Number of focusable controls (initials field + Return to Menu). */
  getControlCount(): number {
    return this.focusManager.getControlCount();
  }

  /** The initials entered so far (0–3 A–Z characters). */
  getInitials(): string {
    return this.initials;
  }

  /** The final score shown on this screen. */
  getFinalScore(): number {
    return this.finalScore;
  }

  /** Whether this session ended in victory. */
  getWon(): boolean {
    return this.won;
  }

  /**
   * Processes one keyboard key against the initials input. Letters are
   * appended (up to {@link INITIALS_LENGTH}), Backspace deletes, Enter
   * submits the score and returns to the menu. Returns true when the key
   * was consumed.
   */
  handleInitialsKey(key: string): boolean {
    if (isInitialsLetter(key)) {
      if (this.initials.length < INITIALS_LENGTH) {
        this.initials += key.toUpperCase();
        this._updateInitialsDisplay();
      }
      return true;
    }
    if (key === 'Backspace' && this.initials.length > 0) {
      this.initials = this.initials.slice(0, -1);
      this._updateInitialsDisplay();
      return true;
    }
    if (key === 'Enter' && this.initials.length === INITIALS_LENGTH) {
      this.submitInitials();
      return true;
    }
    return false;
  }

  /**
   * Submits the score and returns to the menu when the initials are
   * complete; a no-op otherwise. This is the action for the initials field
   * (Enter auto-submit, AC4).
   */
  submitInitials(): void {
    if (this.initials.length !== INITIALS_LENGTH) return;
    saveScoreEntry({ initials: this.initials, score: this.finalScore });
    this.scene.start('MenuScene');
  }

  /**
   * Returns to the menu from the Return to Menu button, persisting the
   * score first when the initials are complete (AC3).
   */
  submitScoreAndReturn(): void {
    if (this.initials.length === INITIALS_LENGTH) {
      saveScoreEntry({ initials: this.initials, score: this.finalScore });
    }
    this.scene.start('MenuScene');
  }

  // ── Rendering helpers ──────────────────────────────────────────

  /** The display string for the initials field (underscores while empty). */
  private _initialsDisplay(): string {
    return this.initials.padEnd(INITIALS_LENGTH, '_');
  }

  private _updateInitialsDisplay(): void {
    this.initialsText?.setText(this._initialsDisplay());
  }

  /** Renders the stub leaderboard row (or the placeholder message). */
  private _renderLeaderboard(): void {
    const entries = readLeaderboard().slice(0, 3);
    if (entries.length === 0) {
      this.add.text(GAME_WIDTH / 2, 355, 'Leaderboard coming soon', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: DIM_COLOR,
      }).setOrigin(0.5);
      return;
    }
    const lines = entries.map(
      (e, i) => `${i + 1}.  ${e.initials.padEnd(3, '_')}  ${e.score}`,
    );
    this.add.text(GAME_WIDTH / 2, 355, lines.join('\n'), {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: GAME_OVER_COLOR,
      align: 'center',
    }).setOrigin(0.5, 0);
  }
}