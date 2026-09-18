/**
 * Playable game scene (GDD §3 — Level structure, §4 — Boss).
 *
 * The core game scene that manages the 5-level progression plus a
 * final boss encounter. Uses the GameState module to track lives,
 * score, and level transitions.
 *
 * Flow:
 *   MenuScene → PlayScene (Level 1) → … → PlayScene (Boss) → GameOverScene
 *
 * This is the primary game scene; it is the foundation upon which
 * WaveManager, boss integration, collision detection, and HUD are
 * layered in subsequent work items.
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { BOSS_LEVEL, GameState } from '../core/GameState';
import { Player } from '../entities/Player';
import { EffectsRegistry } from '../powerups/effects';
import { HUD } from '../ui/HUD';
import { addBackToIndexButton } from '../utils/gymNavigation';

/** Neon-cyan colour for level indicator text. */
const LEVEL_TEXT_COLOR = '#00ffff';
/** Score text colour. */
const SCORE_TEXT_COLOR = '#ffffff';
/** Level transition announcement style. */
const LEVEL_ANNOUNCE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '36px',
  color: '#ffffff',
  backgroundColor: '#000000',
  padding: { x: 20, y: 12 },
};

/**
 * Minimal wave-manager contract consumed by PlayScene. The concrete
 * `WaveManager` (child work item AH-0MU72ZK3P006CH9G) implements this;
 * declared here as a structural interface so the scene registers and
 * boots before that module exists.
 */
export interface PlaySceneWaveManager {
  /** Advances the current wave by `dt` seconds. */
  tick(dt: number): void;
}

/**
 * The playable game scene — manages 5 levels + boss encounter.
 *
 * This scene is the core of the playable game. It:
 * - Creates and owns the GameState instance for the session.
 * - Spawns the player ship at scene start.
 * - Delegates to a WaveManager (child work item) for enemy spawning.
 * - Handles collision detection between player bullets and enemies.
 * - Manages level transitions and boss trigger.
 * - Displays HUD (lives, score, active effects).
 * - Transitions to GameOverScene on player death or boss victory.
 */
export class PlayScene extends Phaser.Scene {
  /** The game state for this session. */
  private gameState: GameState;

  /** The player-controlled ship (null until created). */
  private player: Player | null = null;

  /** Active-effect registry for power-up effects. */
  private effectsRegistry: EffectsRegistry;

  /** Standalone HUD rendering lives and effects. */
  private hud: HUD | null = null;

  /** Score display text object (top-right). */
  private scoreText: Phaser.GameObjects.Text | null = null;

  /** Level indicator text (top-left). */
  private levelText: Phaser.GameObjects.Text | null = null;

  /** Wave/level manager (injected by child work items). */
  private waveManager: PlaySceneWaveManager | null = null;

  constructor() {
    super('PlayScene');
    this.gameState = new GameState({ gameState: 'playing' });
    this.effectsRegistry = new EffectsRegistry();
  }

  create(): void {
    // ── Background ───────────────────────────────────────────────
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);

    // ── Player ship ──────────────────────────────────────────────
    this.player = new Player(this, { x: GAME_WIDTH / 2, y: GAME_HEIGHT - 80 });
    this.add.existing(this.player);

    // ── HUD ──────────────────────────────────────────────────────
    this.hud = new HUD(this, this.effectsRegistry, { showLives: true });

    // ── Score display (top-right) ────────────────────────────────
    this.scoreText = this.add.text(
      GAME_WIDTH - 10,
      10,
      'Score: 0',
      {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SCORE_TEXT_COLOR,
      },
    );
    this.scoreText.setOrigin(1, 0);

    // ── Level indicator (top-left) ───────────────────────────────
    this.levelText = this.add.text(
      10,
      10,
      'Level 1',
      {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: LEVEL_TEXT_COLOR,
      },
    );

    // ── Back to gym index (dev access) ───────────────────────────
    addBackToIndexButton(this);

    // ── Announce the level ───────────────────────────────────────
    this._announceLevel();

    // ── SHUTDOWN cleanup ─────────────────────────────────────────
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.player?.destroy();
      this.hud?.destroy();
      this.scoreText?.destroy();
      this.levelText?.destroy();
    });
  }

  update(_time: number, delta: number): void {
    const dt = delta / 1000;

    // ── Update effects registry (power-up timers, lives) ─────────
    this.effectsRegistry.tick(dt);
    this.hud?.refresh();

    // ── Update score display ─────────────────────────────────────
    if (this.scoreText) {
      this.scoreText.setText(`Score: ${this.gameState.score}`);
    }

    // ── Delegate to wave manager (if active) ─────────────────────
    this.waveManager?.tick(dt);
  }

  // ── Wave management ────────────────────────────────────────────

  /**
   * Starts (or restarts) the current level's wave.
   * Called automatically by the WaveManager when levels advance.
   */
  startLevel(level: number): void {
    this.gameState.level = level;
    if (this.levelText) {
      this.levelText.setText(level === BOSS_LEVEL ? 'BOSS' : `Level ${level}`);
    }
    this._announceLevel();
  }

  /**
   * Handles enemy destruction: awards score.
   */
  onEnemyDestroyed(scoreValue: number): void {
    this.gameState.addScore(scoreValue);
  }

  /**
   * Handles the player taking damage: loses a life and checks for game over.
   * Returns true if the player survived, false if game over.
   */
  onPlayerHit(): boolean {
    const survived = this.gameState.loseLife();
    if (!survived) {
      this.gameState.playerDied();
      this._gameOver(false);
    }
    return survived;
  }

  /**
   * Marks the boss as defeated and transitions to game over (win).
   */
  onBossDefeated(): void {
    this.gameState.defeatBoss();
    this._gameOver(true);
  }

  // ── Helpers ────────────────────────────────────────────────────

  /** Displays a level announcement in the centre of the screen. */
  private _announceLevel(): void {
    const text = this.add.text(
      GAME_WIDTH / 2,
      GAME_HEIGHT / 2,
      this.gameState.level === BOSS_LEVEL
        ? '⚠  BOSS  ⚠'
        : `Level ${this.gameState.level}`,
      LEVEL_ANNOUNCE_STYLE,
    ).setOrigin(0.5);

    // Fade in, hold briefly, then fade out and destroy.
    this.tweens.add({
      targets: text,
      alpha: { from: 0, to: 1 },
      duration: 500,
      delay: 0,
      yoyo: true,
      repeat: 1,
      onComplete: () => {
        text.destroy();
      },
    });
  }

  /** Transitions to GameOverScene with the final score. */
  private _gameOver(won: boolean): void {
    this.scene.start('GameOverScene', {
      won,
      score: this.gameState.score,
    });
  }

  /**
   * Sets the wave manager (called by the WaveManager work item's
   * integration into PlayScene).
   */
  setWaveManager(waveManager: PlaySceneWaveManager): void {
    this.waveManager = waveManager;
  }

  /**
   * Returns the current game state for the session.
   * Used by GameOverScene to display final score.
   */
  getGameState(): GameState {
    return this.gameState;
  }

  /** The player ship, or null before `create()`. */
  getPlayer(): Player | null {
    return this.player;
  }
}
