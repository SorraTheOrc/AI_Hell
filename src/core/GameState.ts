/**
 * Game state management (GDD §4.1, §4.5).
 *
 * Tracks the player's lives, score, current level, boss defeat status,
 * and overall game state (menu / playing / game-over). State persists
 * across wave/level transitions within a single PlaySession and is
 * serialisable for the leaderboard stub (AH-0MU6VSKZT006HBTR).
 *
 * Default values:
 * - lives: 3 (up to 5 with P8 Extra Life power-up)
 * - score: 0 (increments on enemy/boss destruction)
 * - level: 1–5 (boss triggered after level 5)
 * - minerals: 0 (run-scoped ship's hold; capacity 20)
 * - gameState: 'menu' | 'playing' | 'gameover'
 */

import { DEFAULT_MINERAL_HOLD_CAPACITY } from './rules';

// ── Game state enum ───────────────────────────────────────────────────

/**
 * The three lifecycle states of the game session.
 * - `menu`: main menu is shown; no gameplay active.
 * - `playing`: player is actively playing (levels 1–5 or boss).
 * - `gameover`: player has lost all lives or defeated the boss.
 */
export type GameSessionState = 'menu' | 'playing' | 'gameover';

// ── Defaults ──────────────────────────────────────────────────────────

/** Default number of lives the player starts with. */
export const DEFAULT_LIVES = 3;

/** Maximum number of lives (capped by P8 Extra Life stacking). */
export const MAX_LIVES = 5;

/** Minimum level number. */
export const MIN_LEVEL = 1;

/** Maximum regular level number before the boss (5 levels). */
export const MAX_LEVEL = 5;

/**
 * The level number that triggers the boss encounter.
 * Equals MAX_LEVEL + 1 — the boss appears after all 5 levels.
 */
export const BOSS_LEVEL = MAX_LEVEL + 1;

/** Starting score. */
export const DEFAULT_SCORE = 0;

// ── GameState class ───────────────────────────────────────────────────

/**
 * Mutable game state holder. Created fresh when the player starts
 * a new game from the menu; state is reset to defaults on restart.
 */
export class GameState {
  /** Remaining lives (default 3). */
  lives: number;
  /** Current score (default 0). */
  score: number;
  /** Current level (1–5 for regular levels, BOSS_LEVEL for boss). */
  level: number;
  /** Whether the boss has been defeated (true → player wins). */
  bossDefeated: boolean;
  /** Current game state (menu / playing / gameover). */
  gameState: GameSessionState;

  // ── Ship's hold (minerals, GDD §4.5) ────────────────────────────

  /** Current minerals in the ship's hold (run-scoped, 0..capacity). */
  minerals: number;
  /** Hold capacity before the hold-full power-up choice is offered. */
  mineralCapacity: number;
  /**
   * Overflow recorded when the hold last filled (collected − capacity).
   * Carried back into the hold once the power-up choice is resolved.
   */
  private _mineralOverflow = 0;

  /**
   * Creates a new GameState with default values.
   * Optionally override individual fields.
   */
  constructor(overrides?: Partial<GameState>) {
    this.lives = overrides?.lives ?? DEFAULT_LIVES;
    this.score = overrides?.score ?? DEFAULT_SCORE;
    this.level = overrides?.level ?? MIN_LEVEL;
    this.bossDefeated = overrides?.bossDefeated ?? false;
    this.gameState = overrides?.gameState ?? 'menu';
    this.minerals = overrides?.minerals ?? 0;
    this.mineralCapacity =
      overrides?.mineralCapacity ?? DEFAULT_MINERAL_HOLD_CAPACITY;
  }

  // ── Actions ─────────────────────────────────────────────────────

  /**
   * Starts a new game session: resets all state to defaults,
   * sets gameState to 'playing', and level to 1.
   */
  startGame(): void {
    this.lives = DEFAULT_LIVES;
    this.score = DEFAULT_SCORE;
    this.level = MIN_LEVEL;
    this.bossDefeated = false;
    this.gameState = 'playing';
    this.minerals = 0;
    this._mineralOverflow = 0;
  }

  // ── Ship's hold (minerals) ──────────────────────────────────────

  /**
   * Adds minerals to the ship's hold, capping the store at
   * {@link mineralCapacity}. Returns the overflow beyond capacity (0 when
   * the hold was not over-filled). The overflow is remembered so
   * {@link resolveHold} can carry it into the next hold.
   *
   * @param amount — minerals to add (non-positive values are ignored).
   */
  addMinerals(amount: number): number {
    if (amount <= 0) return 0;
    const total = this.minerals + amount;
    if (total >= this.mineralCapacity) {
      this.minerals = this.mineralCapacity;
      this._mineralOverflow = total - this.mineralCapacity;
      return this._mineralOverflow;
    }
    this.minerals = total;
    return 0;
  }

  /** Whether the hold has reached capacity (a power-up choice is due). */
  isHoldFull(): boolean {
    return this.minerals >= this.mineralCapacity;
  }

  /**
   * Resolves the hold-full choice: resets the hold to 0 carrying any
   * overflow (store = collected − capacity) recorded when it filled.
   */
  resolveHold(): void {
    this.minerals = this._mineralOverflow;
    this._mineralOverflow = 0;
  }

  /**
   * Increments the score by the given amount.
   * @param amount — points to add (must be positive).
   */
  addScore(amount: number): void {
    if (amount > 0) {
      this.score += amount;
    }
  }

  /**
   * Loses one life. Returns true if the player still has lives remaining.
   * Caps at 0 lives minimum.
   */
  loseLife(): boolean {
    this.lives = Math.max(0, this.lives - 1);
    return this.lives > 0;
  }

  /**
   * Adds an extra life (up to MAX_LIVES). Returns the new lives count.
   */
  addLife(): number {
    this.lives = Math.min(MAX_LIVES, this.lives + 1);
    return this.lives;
  }

  /**
   * Advances to the next level. Returns the new level.
   * Level 5 → BOSS_LEVEL (boss) automatically.
   */
  advanceLevel(): number {
    if (this.level < MAX_LEVEL) {
      this.level += 1;
    } else {
      this.level = BOSS_LEVEL;
    }
    return this.level;
  }

  /**
   * Marks the boss as defeated and transitions to 'gameover'
   * with a winning state (bossDefeated = true).
   */
  defeatBoss(): void {
    this.bossDefeated = true;
    this.gameState = 'gameover';
  }

  /**
   * Marks the game as over due to player death (lives = 0).
   * Sets gameState to 'gameover' and bossDefeated to false.
   */
  playerDied(): void {
    this.gameState = 'gameover';
    this.bossDefeated = false;
  }

  /**
   * Transitions back to the menu state (called when returning
   * from GameOverScene).
   */
  returnToMenu(): void {
    this.gameState = 'menu';
  }

  // ── Serialisation (for leaderboard stub) ────────────────────────

  /**
   * Serialises the current state to a plain object.
   * Used by the leaderboard stub to store scores.
   */
  toJSON(): {
    score: number;
    lives: number;
    level: number;
    bossDefeated: boolean;
    gameState: GameSessionState;
  } {
    return {
      score: this.score,
      lives: this.lives,
      level: this.level,
      bossDefeated: this.bossDefeated,
      gameState: this.gameState,
    };
  }

  /**
   * Creates a GameState from a serialised object.
   * Used by the leaderboard stub to restore high-score display.
   */
  static fromJSON(data: {
    score: number;
    lives: number;
    level: number;
    bossDefeated: boolean;
    gameState: GameSessionState;
  }): GameState {
    return new GameState(data);
  }
}
