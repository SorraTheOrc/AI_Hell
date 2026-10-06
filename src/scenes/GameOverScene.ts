/**
 * Game over scene (GDD §4.5 / §5 — Game over screen & leaderboard).
 *
 * Displays the final score, prompts for a 3-character initials entry when the
 * score qualifies, and renders the full local leaderboard (rank, initials,
 * score, date) from `src/core/Leaderboard.ts`. A non-qualifying score is
 * explained and can be skipped without writing to storage.
 *
 * While a qualifying score is being entered, the leaderboard shows a single
 * highlighted prospective row (a leading `▶` marker plus the preview colour)
 * at the rank the score will occupy, with the initials filling in live on
 * every A–Z key press and Backspace. The preview is inserted with the same
 * stable tie-break and 10-entry cap as `addEntry`, so it matches the
 * persisted entry on submit (AH-0MUE86S5F002VVQD).
 *
 * Keyboard navigation (AH-0MU9LKQEP008LCX9-C3) is provided by the shared
 * {@link FocusManager}: the initials field is focused by default, Tab and
 * the arrow keys move focus to the Return to Menu button (and back), and
 * Enter/Space activate the focused control. A–Z and Backspace edit the
 * initials while the field is focused. Pointer handlers are unchanged.
 */

import Phaser from 'phaser';

import {
  addEntry,
  buildPreview,
  getEntries,
  INITIALS_LENGTH,
  isQualifying,
  type LeaderboardEntry,
  type LeaderboardPreviewRow,
} from '../core/Leaderboard';
import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { playDefeatStingSound } from '../audio/effects';
import {
  ENDOFRUN_VICTORY_SCREEN_FIREWORKS_DURATION_MS,
  spawnDefeatScreenJuice,
  spawnVictoryFireworks,
  spawnVictoryJuice,
} from '../vfx/endOfRunJuice';
import { renderLeaderboard } from '../ui/leaderboardView';
import { FocusManager } from '../utils/focusManager';

export { INITIALS_LENGTH };

/**
 * Depth of the opaque background — below every end-of-run juice layer
 * (which sit at negative depth) and the default-depth (0) UI.
 */
const BACKGROUND_DEPTH = -100;

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
/** Warning colour for a non-qualifying score. */
const WARNING_COLOR = '#ffaa00';

/** Vertical layout anchors (px, 960×540 canvas). */
const HEADER_Y = 45;
const SCORE_Y = 90;
const INITIALS_LABEL_Y = 128;
const INITIALS_FIELD_Y = 158;
const MESSAGE_Y = 192;
const LEADERBOARD_TITLE_Y = 220;
const LEADERBOARD_ROW_START_Y = 245;
const LEADERBOARD_ROW_HEIGHT = 18;
const LEADERBOARD_ROW_FONT = '13px';
const BUTTON_Y = 495;

/** True when a key is an A–Z letter (case-insensitive). */
export function isInitialsLetter(key: string): boolean {
  return key.length === 1 && /^[A-Z]$/i.test(key);
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

  /** Whether the final score makes the leaderboard. */
  private qualifies: boolean;

  /** The current initials string being entered (empty on creation). */
  private initials: string;

  /** The visible initials text game object. */
  private initialsText: Phaser.GameObjects.Text | null = null;

  /**
   * Rendered leaderboard row texts, tracked so a keystroke re-render can
   * destroy and replace them instead of accumulating text objects.
   */
  private leaderboardRows: Phaser.GameObjects.Text[] = [];

  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager();

  /**
   * Caller-owned registry of end-of-run juice display objects (victory
   * celebration or defeat treatment). Anything still alive at SHUTDOWN is
   * destroyed here; layers remove themselves as their tweens complete.
   */
  private endOfRunEffects: Phaser.GameObjects.GameObject[] = [];

  /** Focus index of the initials field (−1 when the score does not qualify). */
  private initialsFocusIndex = -1;

  constructor() {
    super('GameOverScene');
    this.won = false;
    this.finalScore = 0;
    this.qualifies = true;
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
    this.initials = '';
    this.qualifies = isQualifying(this.finalScore);
    this.endOfRunEffects = [];

    // ── Background ───────────────────────────────────────────────
    // The background sits below the juice layers (negative depth) so the
    // victory/defeat treatment is visible over it, while the default-depth
    // (0) UI stays above the treatment. See src/vfx/endOfRunJuice.ts.
    this.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000)
      .setOrigin(0)
      .setDepth(BACKGROUND_DEPTH);

    // ── End-of-run juice (victory celebration / defeat treatment) ──
    // Rendered behind the UI; purely cosmetic and never interactive, so it
    // cannot intercept keyboard or pointer input.
    if (this.won) {
      spawnVictoryJuice(this, { registry: this.endOfRunEffects });
      // Continue the celebration for a shorter beat (1–2 s): a screen-centred
      // firework/explosion sequence layered on top of the confetti burst
      // (AH-0MUWZ5HCV0034H44 AC2). Bursts render behind the UI (negative depth).
      spawnVictoryFireworks(this, GAME_WIDTH / 2, GAME_HEIGHT / 2, {
        registry: this.endOfRunEffects,
        durationMs: ENDOFRUN_VICTORY_SCREEN_FIREWORKS_DURATION_MS,
      });
    } else {
      const defeat = spawnDefeatScreenJuice(this, { registry: this.endOfRunEffects });
      // Defeat sting — exactly once, gated by the shared sound toggle.
      if (defeat.params.soundEnabled) playDefeatStingSound();
    }

    // ── Game over header ─────────────────────────────────────────
    const headerColor = this.won ? VICTORY_COLOR : DEFEAT_COLOR;
    const headerText = this.won ? 'VICTORY' : 'DEFEAT';
    this.add.text(GAME_WIDTH / 2, HEADER_Y, headerText, {
      fontFamily: 'monospace',
      fontSize: '36px',
      color: headerColor,
    }).setOrigin(0.5);

    // ── Final score ──────────────────────────────────────────────
    this.add.text(GAME_WIDTH / 2, SCORE_Y, `Final Score: ${this.finalScore}`, {
      fontFamily: 'monospace',
      fontSize: '24px',
      color: SCORE_COLOR,
    }).setOrigin(0.5);

    // ── Initials entry (qualifying scores only) ─────────────────
    if (this.qualifies) {
      this._buildInitialsEntry();
    }

    // ── Qualifying message ───────────────────────────────────────
    this.add.text(
      GAME_WIDTH / 2,
      MESSAGE_Y,
      this.qualifies
        ? 'New high score! Enter your initials.'
        : 'Score does not qualify for the leaderboard.',
      {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: this.qualifies ? GAME_OVER_COLOR : WARNING_COLOR,
      },
    ).setOrigin(0.5);

    // ── Leaderboard (full, up to 10 entries) ─────────────────────
    this.add.text(GAME_WIDTH / 2, LEADERBOARD_TITLE_Y, 'LEADERBOARD', {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: DIM_COLOR,
    }).setOrigin(0.5);

    this._renderLeaderboard();

    // ── Return to Menu / Skip button ─────────────────────────────
    const menuButton = this.add.text(
      GAME_WIDTH / 2,
      BUTTON_Y,
      this.qualifies ? '←  Return to Menu' : '←  Skip',
      {
        fontFamily: 'monospace',
        fontSize: '18px',
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
      this.submitScoreAndReturn();
    });

    // ── Keyboard focus (AH-0MU9LKQEP008LCX9-C3) ──────────────────
    // The initials field is registered first when the score qualifies, so
    // it is focused by default. Text keys (A–Z / Backspace) are routed to
    // the initials model only while the field is focused and only when an
    // entry is possible; a non-qualifying score offers just the skip button.
    if (this.qualifies && this.initialsText) {
      this.initialsFocusIndex = this.focusManager.register(
        this.initialsText,
        () => this.submitInitials(),
      );
    } else {
      this.initialsFocusIndex = -1;
    }
    this.focusManager.register(menuButton, () => this.submitScoreAndReturn());
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.handleKey(event);
    });

    // ── Hygiene on shutdown: drop transient input state. ──────────
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
      this.initials = '';
      this.initialsText = null;
      this.leaderboardRows = [];
      // Destroy any juice objects still alive (tween still running) so a
      // scene restart leaves no orphaned display objects behind.
      for (const effect of this.endOfRunEffects) effect.destroy();
      this.endOfRunEffects = [];
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

  /** Whether the final score qualifies for the leaderboard. */
  getQualifies(): boolean {
    return this.qualifies;
  }

  /**
   * The live end-of-run juice display objects (victory celebration or defeat
   * treatment) still owned by the scene. Shrinks as each tween completes and
   * is emptied on SHUTDOWN. Exposed for teardown/leak tests.
   */
  getEndOfRunEffects(): Phaser.GameObjects.GameObject[] {
    return this.endOfRunEffects;
  }

  /** Snapshot of the entries currently rendered on the leaderboard. */
  getLeaderboardEntries(): LeaderboardEntry[] {
    return getEntries();
  }

  /**
   * The prospective (highlighted) leaderboard row for the score being
   * entered, or `null` when the score does not qualify or the table is full
   * and the score does not make it. Mirrors exactly what is rendered.
   */
  getPreviewEntry(): LeaderboardPreviewRow | null {
    if (!this.qualifies) return null;
    return (
      buildPreview(getEntries(), this.finalScore, this.initials).find(
        (row) => row.isPreview,
      ) ?? null
    );
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
   * Persists the score when the entry is complete and qualifying, then
   * returns to the menu. A no-op write for incomplete or non-qualifying
   * entries. This is the action for the initials field (Enter auto-submit).
   */
  submitInitials(): void {
    if (!this.qualifies) return;
    if (this.initials.length !== INITIALS_LENGTH) return;
    addEntry(this.initials, this.finalScore);
    this.scene.start('MenuScene');
  }

  /**
   * Returns to the menu from the Return to Menu / Skip button, persisting
   * the score first when it qualifies and the initials are complete. A
   * non-qualifying (or incomplete) entry writes nothing.
   */
  submitScoreAndReturn(): void {
    if (this.qualifies && this.initials.length === INITIALS_LENGTH) {
      addEntry(this.initials, this.finalScore);
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
    // Keep the prospective row in step with the letters just typed.
    this._renderLeaderboard();
  }

  /**
   * Creates the initials prompt and field. Called from {@link create} only
   * when the score qualifies; a non-qualifying score shows no input.
   */
  private _buildInitialsEntry(): void {
    this.add.text(GAME_WIDTH / 2, INITIALS_LABEL_Y, 'Enter Initials:', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: DIM_COLOR,
    }).setOrigin(0.5);

    this.initialsText = this.add.text(
      GAME_WIDTH / 2,
      INITIALS_FIELD_Y,
      this._initialsDisplay(),
      {
        fontFamily: 'monospace',
        fontSize: '28px',
        color: GAME_OVER_COLOR,
      },
    ).setOrigin(0.5);
  }

  /**
   * Renders the leaderboard, highest score first (up to 10 rows). A
   * qualifying score adds a single highlighted prospective row at the rank
   * it will occupy, with initials filling in live. Previous rows are
   * destroyed first so keystroke updates never accumulate text objects.
   */
  private _renderLeaderboard(): void {
    for (const row of this.leaderboardRows) row.destroy();
    this.leaderboardRows = [];

    const rows = this.qualifies
      ? buildPreview(getEntries(), this.finalScore, this.initials)
      : getEntries();

    this.leaderboardRows = renderLeaderboard(this, rows, {
      topY: LEADERBOARD_ROW_START_Y,
      rowHeight: LEADERBOARD_ROW_HEIGHT,
      fontSize: LEADERBOARD_ROW_FONT,
      color: GAME_OVER_COLOR,
      emptyMessage: 'No scores yet',
    });
  }
}
