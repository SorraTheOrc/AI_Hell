/**
 * Unit tests for the GameState module (AH-0MU72SZP1005X14G — child 1).
 *
 * Covers state initialization, default values, actions (startGame, addScore,
 * loseLife, addLife, advanceLevel, defeatBoss, playerDied, returnToMenu),
 * and serialisation (toJSON / fromJSON).
 */

import { describe, expect, it } from 'vitest';

import {
  GameState,
  DEFAULT_LIVES,
  MAX_LIVES,
  MIN_LEVEL,
  MAX_LEVEL,
  BOSS_LEVEL,
  DEFAULT_SCORE,
  GameSessionState,
} from './GameState';

describe('GameState (AH-0MU72SZP1005X14G)', () => {
  // ── Construction & defaults ────────────────────────────────────

  it('creates a new GameState with default values', () => {
    const gs = new GameState();
    expect(gs.lives).toBe(DEFAULT_LIVES);
    expect(gs.score).toBe(DEFAULT_SCORE);
    expect(gs.level).toBe(MIN_LEVEL);
    expect(gs.bossDefeated).toBe(false);
    expect(gs.gameState).toBe('menu');
  });

  it('accepts partial overrides at construction', () => {
    const gs = new GameState({ lives: 5, score: 100 });
    expect(gs.lives).toBe(5);
    expect(gs.score).toBe(100);
    expect(gs.level).toBe(MIN_LEVEL); // not overridden
    expect(gs.gameState).toBe('menu'); // not overridden
  });

  // ── startGame ──────────────────────────────────────────────────

  it('resets all state and sets gameState to playing', () => {
    const gs = new GameState({ lives: 5, score: 500, level: 3, gameState: 'playing' });
    gs.startGame();
    expect(gs.lives).toBe(DEFAULT_LIVES);
    expect(gs.score).toBe(DEFAULT_SCORE);
    expect(gs.level).toBe(MIN_LEVEL);
    expect(gs.bossDefeated).toBe(false);
    expect(gs.gameState).toBe('playing');
  });

  // ── addScore ───────────────────────────────────────────────────

  it('increments score by the given amount', () => {
    const gs = new GameState();
    gs.addScore(100);
    expect(gs.score).toBe(100);
    gs.addScore(50);
    expect(gs.score).toBe(150);
  });

  it('ignores non-positive amounts', () => {
    const gs = new GameState({ score: 100 });
    gs.addScore(0);
    expect(gs.score).toBe(100);
    gs.addScore(-10);
    expect(gs.score).toBe(100);
  });

  // ── loseLife ───────────────────────────────────────────────────

  it('decrements lives and returns true while lives remain', () => {
    const gs = new GameState({ lives: 3 });
    expect(gs.loseLife()).toBe(true);
    expect(gs.lives).toBe(2);
    expect(gs.loseLife()).toBe(true);
    expect(gs.lives).toBe(1);
    expect(gs.loseLife()).toBe(false);
    expect(gs.lives).toBe(0);
  });

  it('caps lives at 0', () => {
    const gs = new GameState({ lives: 0 });
    expect(gs.loseLife()).toBe(false);
    expect(gs.lives).toBe(0);
  });

  // ── addLife ────────────────────────────────────────────────────

  it('adds one life up to MAX_LIVES', () => {
    const gs = new GameState({ lives: 3 });
    expect(gs.addLife()).toBe(4);
    expect(gs.addLife()).toBe(MAX_LIVES);
    expect(gs.addLife()).toBe(MAX_LIVES); // capped
    expect(gs.lives).toBe(MAX_LIVES);
  });

  // ── advanceLevel ───────────────────────────────────────────────

  it('advances level 1 → 2 → 3 → 4 → 5', () => {
    const gs = new GameState();
    expect(gs.advanceLevel()).toBe(2);
    expect(gs.advanceLevel()).toBe(3);
    expect(gs.advanceLevel()).toBe(4);
    expect(gs.advanceLevel()).toBe(5);
  });

  it('transitions from MAX_LEVEL to BOSS_LEVEL', () => {
    const gs = new GameState({ level: MAX_LEVEL });
    expect(gs.advanceLevel()).toBe(BOSS_LEVEL);
    expect(gs.level).toBe(BOSS_LEVEL);
  });

  // ── defeatBoss / playerDied ────────────────────────────────────

  it('defeatBoss sets bossDefeated=true and gameState=gameover', () => {
    const gs = new GameState({ gameState: 'playing' });
    gs.defeatBoss();
    expect(gs.bossDefeated).toBe(true);
    expect(gs.gameState).toBe('gameover');
  });

  it('playerDied sets gameState=gameover and bossDefeated=false', () => {
    const gs = new GameState({ gameState: 'playing' });
    gs.playerDied();
    expect(gs.bossDefeated).toBe(false);
    expect(gs.gameState).toBe('gameover');
  });

  // ── returnToMenu ───────────────────────────────────────────────

  it('returns gameState to menu', () => {
    const gs = new GameState({ gameState: 'gameover' });
    gs.returnToMenu();
    expect(gs.gameState).toBe('menu');
  });

  // ── Type safety ────────────────────────────────────────────────

  it('GameState.gameState is typed as GameSessionState union', () => {
    const gs = new GameState();
    // These are the only valid values.
    const states: GameSessionState[] = ['menu', 'playing', 'gameover'];
    for (const state of states) {
      gs.gameState = state;
      expect(gs.gameState).toBe(state);
    }
  });

  // ── Serialisation ──────────────────────────────────────────────

  it('toJSON produces a serialisable object', () => {
    const gs = new GameState({ lives: 2, score: 300, level: 3, bossDefeated: true, gameState: 'gameover' });
    const json = gs.toJSON();
    expect(json).toEqual({
      lives: 2,
      score: 300,
      level: 3,
      bossDefeated: true,
      gameState: 'gameover',
    });
  });

  it('fromJSON reconstructs a GameState', () => {
    const data = {
      score: 999,
      lives: 1,
      level: BOSS_LEVEL,
      bossDefeated: true,
      gameState: 'gameover' as const,
    };
    const gs = GameState.fromJSON(data);
    expect(gs.score).toBe(999);
    expect(gs.lives).toBe(1);
    expect(gs.level).toBe(BOSS_LEVEL);
    expect(gs.bossDefeated).toBe(true);
    expect(gs.gameState).toBe('gameover');
  });
});
