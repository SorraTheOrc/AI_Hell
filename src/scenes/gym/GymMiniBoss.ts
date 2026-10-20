/**
 * Gym scene — MiniBoss (config-driven multi-phase encounter).
 *
 * The gym is the canonical parity reference for the mini-boss family
 * (epic AH-0MVCC8XSS007P01Z, AH-0MVCRAYSH0014BQJ AC3). It boots exactly one
 * {@link MiniBoss} through the shared {@link GymFormationScene} /
 * `CombatScene` core, so the shared `_advanceBoss` tick, collision pass,
 * teleport avoidance, bullet lifecycle and player combat are the *same code*
 * the shipped game will run when PlayScene spawns a mini-boss.
 *
 * The demo config exercises every config-driven axis:
 *
 * - **pattern set** — phase 1 spread, phase 2 spiral, phase 3 pulse;
 * - **HP** — 5 hits per phase (fast iteration on the DAMAGE button);
 * - **colour** — violet body, lighter final-phase tint;
 * - **optional minions** — scouts join phase 1, divers join phase 2 (spawned
 *   and advanced by the entity through the shared planner/factory/fire seam).
 *
 * On-screen controls mirror `GymBoss`:
 *
 * - **DAMAGE** — applies one hit, advancing phases at the configured HP.
 * - **EXPLODE** — destroys the mini-boss (shared HUD button).
 * - **SHOOT: ON/OFF** — toggles the mini-boss's volleys.
 * - **← INDEX** — returns to the gym index.
 */

import Phaser from 'phaser';

import {
  MiniBoss,
  MINI_BOSS_DEFAULT_COLOR,
  type MiniBossPhaseConfig,
  type MiniBossMinionWaveConfig,
} from '../../entities/MiniBoss';
import type { BossBullet } from '../../entities/Boss';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import type { EnemyEntity } from '../../entities/enemyFactory';
import type { FormationOffset } from '../../utils/formations';
import {
  EnemyFormationConfig,
  GymFormationScene,
} from './core/GymFormationScene';

/** Player spawn position for the mini-boss gym (bottom centre). */
const MINI_BOSS_PLAYER_SPAWN_X = GAME_WIDTH / 2;
const MINI_BOSS_PLAYER_SPAWN_Y = GAME_HEIGHT - 40;

/** Formation anchor (single centred entity). */
export const MINI_BOSS_FORMATION_START_X = GAME_WIDTH / 2;
export const MINI_BOSS_FORMATION_START_Y = GAME_HEIGHT / 2 - 30;
export const MINI_BOSS_FORMATION_SPACING_X = 0;
export const MINI_BOSS_FORMATION_SPACING_Y = 0;
export const MINI_BOSS_FORMATION_DRIFT_SPEED = 0;

/** Demo config surfaced to tests and the gym index row. */
export const MINI_BOSS_GYM_LEVEL = 1;
export const MINI_BOSS_GYM_NAME = 'Gym Sentinel';
export const MINI_BOSS_GYM_HP_PER_PHASE = 5;
export const MINI_BOSS_GYM_COLOR = MINI_BOSS_DEFAULT_COLOR;
export const MINI_BOSS_GYM_DESPERATION_COLOR = 0xff88ff;
export const MINI_BOSS_GYM_PHASES: readonly MiniBossPhaseConfig[] = [
  { pattern: 'spread' },
  { pattern: 'spiral' },
  { pattern: 'pulse' },
];
export const MINI_BOSS_GYM_MINIONS: readonly MiniBossMinionWaveConfig[] = [
  {
    phase: 1,
    shootEnabled: true,
    groups: [
      {
        enemyKey: 'scout',
        formation: 'v',
        count: 2,
        spacingX: 28,
        spacingY: 24,
        startX: GAME_WIDTH * 0.15,
        startY: GAME_HEIGHT * 0.3,
      },
    ],
  },
  {
    phase: 2,
    shootEnabled: true,
    groups: [
      {
        enemyKey: 'diver',
        formation: 'diver',
        count: 2,
        spacingX: 30,
        spacingY: 26,
        startX: GAME_WIDTH * 0.65,
        startY: GAME_HEIGHT * 0.2,
      },
    ],
  },
];

const MINI_BOSS_CONFIG: EnemyFormationConfig<MiniBoss | EnemyEntity, BossBullet> = {
  sceneKey: 'GymMiniBoss',
  buildOffsets: () => [{ row: 0, col: 0 }],
  count: 1,
  spacingX: MINI_BOSS_FORMATION_SPACING_X,
  spacingY: MINI_BOSS_FORMATION_SPACING_Y,
  driftSpeed: MINI_BOSS_FORMATION_DRIFT_SPEED,
  startX: MINI_BOSS_FORMATION_START_X,
  startY: MINI_BOSS_FORMATION_START_Y,
  statusLabel: 'mini-boss',
  hintText: 'MiniBoss gym — config-driven phases, patterns, colour & minions',
  player: {
    x: MINI_BOSS_PLAYER_SPAWN_X,
    y: MINI_BOSS_PLAYER_SPAWN_Y,
  },
  powerUps: {},
  createEntity: (
    scene: Phaser.Scene,
    x: number,
    y: number,
    formationOffset: FormationOffset,
  ): MiniBoss =>
    new MiniBoss(scene, {
      level: MINI_BOSS_GYM_LEVEL,
      name: MINI_BOSS_GYM_NAME,
      x,
      y,
      formationOffset,
      color: MINI_BOSS_GYM_COLOR,
      desperationColor: MINI_BOSS_GYM_DESPERATION_COLOR,
      hpPerPhase: MINI_BOSS_GYM_HP_PER_PHASE,
      phases: MINI_BOSS_GYM_PHASES.map((phase) => ({ ...phase })),
      minions: MINI_BOSS_GYM_MINIONS.map((wave) => ({
        ...wave,
        groups: wave.groups.map((group) => ({ ...group })),
      })),
    }),
  collectBullets: () => [],
};

/** GymMiniBoss — one config-driven mini-boss on the shared combat core. */
export class GymMiniBoss extends GymFormationScene<
  MiniBoss | EnemyEntity,
  BossBullet
> {
  private damageButton!: Phaser.GameObjects.Text;

  constructor() {
    super(MINI_BOSS_CONFIG);
  }

  override create(): void {
    super.create();

    // DAMAGE button beside EXPLODE (mirrors GymBoss's layout).
    const explodeButton = this.explodeButton;
    this.damageButton = this._addButton(
      explodeButton.x - 120,
      explodeButton.y,
      'DAMAGE',
      LABEL_STYLE,
    );
    this.damageButton.on('pointerdown', () => this.damageMiniBoss());

    this._refreshStatus();
  }

  // ── Shared boss hooks ───────────────────────────────────────────

  /** The single mini-boss entity for the shared `_advanceBoss` tick. */
  protected override getBoss(): MiniBoss | null {
    return (this.entities[0] as MiniBoss | undefined) ?? null;
  }

  /**
   * Includes the entity's config-summoned minions in the shared collision
   * pass, exactly as `GymBoss` does for its phase minions. Minion motion and
   * fire advance inside {@link MiniBoss.update} on the shared tick.
   */
  protected override getEnemyEntities(): readonly (MiniBoss | EnemyEntity)[] {
    return [...this.entities, ...this.formationMiniBoss.getMinions()];
  }

  // ── Damage button handler ───────────────────────────────────────

  /** Applies one hit; phase advances happen at the configured HP. */
  damageMiniBoss(): void {
    const boss = this.formationMiniBoss;
    if (!boss.alive) return;

    const result = boss.takeDamage();
    this._refreshStatus(
      result.destroyed
        ? 'MiniBoss destroyed!'
        : result.phaseAdvanced
          ? `PHASE ${result.phase}/${boss.getPhaseCount()}`
          : 'DAMAGED',
    );
  }

  /** Updates the status line with the live phase/pattern/minion state. */
  private _refreshStatus(prefix?: string): void {
    const boss = this.formationMiniBoss;
    const phase = boss.getPhaseNumber();
    const pattern =
      boss.resolvedConfig.phases[phase - 1]?.pattern ?? 'spread';
    const state = boss.alive
      ? `Phase ${phase}/${boss.getPhaseCount()} (${pattern}) | minions: ${
          boss.getMinions().length
        } | boss: ${this.aliveCount}`
      : `destroyed — boss: ${this.aliveCount}`;
    this.statusText.setText(
      `${prefix ? `${prefix} — ` : ''}${state}`,
    );
  }

  // ── Public test accessors ───────────────────────────────────────

  /** The MiniBoss entity in the scene. */
  get formationMiniBoss(): MiniBoss {
    return this.formationEntities[0] as MiniBoss;
  }

  /** The DAMAGE button (test seam for pointer activation). */
  get damageLabel(): Phaser.GameObjects.Text {
    return this.damageButton;
  }

  /** Entities in the shared collision pass (boss body + summoned minions). */
  getCollidableEnemies(): readonly (MiniBoss | EnemyEntity)[] {
    return this.getEnemyEntities();
  }

  /** Live enemy bullets (test seam for the shared tick's volley collection). */
  getLiveEnemyBullets(): readonly BossBullet[] {
    return this.getEnemyBullets();
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
