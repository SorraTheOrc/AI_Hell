/**
 * Gym scene — Boss (The Central AI, GDD §4.3) testbed.
 *
 * Renders the Boss — a large, imposing neon geometric structure with a
 * visible central core — and demonstrates all 4 attack phases:
 *
 *   Phase 1 — **Scan (Spread):** wide spread bullet pattern.
 *   Phase 2 — **Firestorm (Spiral):** spiral bullet pattern.
 *   Phase 3 — **Pulse:** screen-wide pulse wave + aimed shots.
 *   Phase 4 — **DESPERATION:** all patterns combined at higher speed;
 *              core becomes more exposed/bright.
 *
 * A 4-phase health bar is displayed at the top of the screen. Each phase
 * depletes independently and transitions to the next attack pattern.
 *
 * Standalone gym scope: player ship for combat testing, no other enemy
 * types, no HUD beyond the health bar, no power-ups.
 *
 * On-screen controls:
 *
 * - **EXPLODE** — destroys the Boss with an explosion animation.
 * - **DAMAGE** — deals one segment of damage to the Boss, advancing the
 *   health bar through phases (testing tool).
 * - **SHOOT: ON/OFF** — toggles the Boss's attack firing (simulates
 *   Level 4+ behaviour).
 * - **← INDEX** — returns to the gym index.
 *
 * This scene extends `GymFormationScene` to reuse the shared core
 * library (HUD buttons, status line, back button, bullet lifecycle)
 * and adds Boss-specific configuration, health bar rendering, and a
 * damage button. Per `docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md` §3–§5.
 */

import Phaser from 'phaser';

import {
  Boss,
  BOSS_PHASE_COUNT,
  BossBullet,
} from '../../entities/Boss';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
  FormationSceneBullet,
} from './core/GymFormationScene';

/** Player spawn position for the Boss gym (bottom centre, same as GymEnemies). */
const BOSS_PLAYER_SPAWN_X = GAME_WIDTH / 2;
const BOSS_PLAYER_SPAWN_Y = GAME_HEIGHT - 40;

/** Initial formation base position (Boss is centred). */
export const BOSS_FORMATION_START_X = GAME_WIDTH / 2;
export const BOSS_FORMATION_START_Y = GAME_HEIGHT / 2 - 30;

/** Formation spacing (unused for single Boss, but required by config). */
export const BOSS_FORMATION_SPACING_X = 0;
export const BOSS_FORMATION_SPACING_Y = 0;
/** Forward drift speed (Boss does not drift). */
export const BOSS_FORMATION_DRIFT_SPEED = 0;

/** Damage per click (one health segment = one phase). */
export const BOSS_DAMAGE_PER_CLICK = 1;

/**
 * A pulse-wave bullet wrapper so the base class can track pulse rings.
 * Pulse waves are managed directly by the Boss entity, not by the
 * base class bullet collection.
 */
export interface PulseWaveBullet extends FormationSceneBullet {
  readonly isPulseWave: true;
}

const BOSS_CONFIG: EnemyFormationConfig<
  Boss,
  BossBullet | PulseWaveBullet
> = {
  sceneKey: 'GymBoss',
  buildOffsets: () => [{ row: 0, col: 0 }],
  count: 1,
  spacingX: BOSS_FORMATION_SPACING_X,
  spacingY: BOSS_FORMATION_SPACING_Y,
  driftSpeed: BOSS_FORMATION_DRIFT_SPEED,
  startX: BOSS_FORMATION_START_X,
  startY: BOSS_FORMATION_START_Y,
  statusLabel: 'boss',
  hintText: 'Boss (Central AI) gym — 4-phase health & attack patterns',
  player: {
    x: BOSS_PLAYER_SPAWN_X,
    y: BOSS_PLAYER_SPAWN_Y,
  },
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): Boss => {
    return new Boss(scene, {
      x,
      y,
      formationOffset,
    });
  },
  collectBullets: (_entity, _now): (BossBullet | PulseWaveBullet)[] => []
};

/**
 * GymBoss — Boss gym scene extending the shared core library.
 *
 * Reuses the base class for HUD, navigation, and bullet lifecycle
 * management, while overriding key methods to handle the Boss's
 * unique state machine (multi-phase health, attack patterns, telegraphing).
 */
export class GymBoss extends GymFormationScene<
  Boss,
  BossBullet | PulseWaveBullet
> {
  private damageButton!: Phaser.GameObjects.Text;

  constructor() {
    super(BOSS_CONFIG);
  }

  /** Override create to add the damage button and custom initialisation. */
  override create(): void {
    // Call the base class create to get HUD + back button.
    super.create();

    // ── Damage button (right side, under SHOOT) ───────────────────
    const shootButton = this.shootButton;
    this.damageButton = this._addButton(
      shootButton.x + 120,
      shootButton.y,
      'DAMAGE',
      LABEL_STYLE,
    );

    this.damageButton.on('pointerdown', () => this.damageBoss());

    // Update status line with initial Boss phase.
    const boss = this.formationEntities[0] as Boss;
    this.statusText.setText(
      `SCORE: n/a — boss: ${this.aliveCount} | Phase ${boss.getPhaseNumber()}/${BOSS_PHASE_COUNT}`,
    );
  }

  /** Override update to handle Boss-specific attack logic. */
  override update(_time: number, delta: number): void {
    const dt = delta / 1000;

    // Run the base class tick to handle player input, auto-fire,
    // collision detection, bullet advancement, and formation positioning.
    super.tick(dt);

    // Advance the Boss's attack state machine and collect its bullets.
    const boss = this.formationEntities[0] as Boss;
    const bossBullets = boss.update(
      this.time.now,
      delta,
      GAME_WIDTH,
      GAME_HEIGHT,
    );

    // Add Boss bullets to the base class bullet collection (skip
    // pulse waves — Boss manages their radius expansion separately).
    for (const bullet of bossBullets) {
      if (!('isPulseWave' in bullet && bullet.isPulseWave)) {
        this.bullets.push(bullet);
      }
    }

    // Advance pulse waves (radius-based, not velocity-based).
    boss.advancePulseWave(dt, GAME_WIDTH, GAME_HEIGHT);
  }

  // ── Damage button handler ───────────────────────────────────────

  /**
   * Deals damage to the Boss, advancing the health bar through phases.
   */
  damageBoss(): void {
    const boss = this.formationEntities[0] as Boss;
    if (!boss.alive) return;

    const newPhase = boss.takeDamage();

    // Update the status line with the new phase.
    if (newPhase > 0) {
      this.statusText.setText(
        `DAMAGED — Phase ${boss.getPhaseNumber()}/${BOSS_PHASE_COUNT} | boss: ${this.aliveCount}`,
      );
    } else {
      // Boss destroyed.
      this.statusText.setText(
        `Boss destroyed! — boss: ${this.aliveCount}`,
      );
    }
  }

  // ── Public test accessors ───────────────────────────────────────

  /** The Boss entity in the scene. */
  get formationBoss(): Boss {
    return this.formationEntities[0] as Boss;
  }
}

/** Monospace neon HUD button style (reuses the core library concept). */
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  color: '#00ff00',
  backgroundColor: '#1a1a1a',
  padding: { x: 8, y: 4 },
};
