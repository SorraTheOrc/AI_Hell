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
 * - **EXPLODE** — defeats the mini-boss through the **same** shared death
 *   sweep the game runs (`spawnMiniBossDeathSweep`, AH-0MVROEMUO007Z3RY): the
 *   mini-boss's live minions are captured before the teardown, swept with the
 *   staggered cascade, and the status line reports the sweep's completion.
 * - **SHOOT: ON/OFF** — toggles the mini-boss's volleys.
 * - **← INDEX** — returns to the gym index.
 */

import Phaser from 'phaser';

import {
  MiniBoss,
  type MiniBossPhaseConfig,
  type MiniBossMinionWaveConfig,
} from '../../entities/MiniBoss';
import {
  MINI_BOSS_DESIGN_LEVELS,
  miniBossConfigForLevel,
  miniBossDesignForLevel,
} from '../../waves/miniBossDesigns';
import type { BossBullet } from '../../entities/Boss';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import type { EnemyEntity } from '../../entities/enemyFactory';
import type { FormationOffset } from '../../utils/formations';
import { loadEnemyConfig } from '../../core/enemyConfig';
import {
  collectSweepTargets,
  spawnMiniBossDeathSweep,
  type MiniBossDeathSweepHandle,
  type MiniBossSweepTarget,
} from '../core/miniBossDeathSweep';
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

/** The design level the dedicated gym row boots (level 1's bespoke design). */
export const MINI_BOSS_GYM_LEVEL = 1;
/**
 * Gym-only hit pool. The designs' real escalation pool is used in the game;
 * the gym keeps a small pool so a tester can step through every phase quickly
 * on the DAMAGE button (patterns/colours/minions/name still come from the
 * real design).
 */
export const MINI_BOSS_GYM_HP_PER_PHASE = 5;

/**
 * Fixed seed for the gym's death sweep (AH-0MVROEMUO007Z3RY). The game uses
 * the run seed; the gym has no run, so a constant keeps every repetition of
 * the EXPLODE display — and every parity assertion — identical.
 */
export const MINI_BOSS_GYM_SWEEP_SEED = 0x5eed_1b05;

// Level-1 design constants, surfaced for the gym's tests and the index row.
// They mirror the bespoke catalogue rather than a separate demo config, so a
// design change can never drift from what the gym exercises.
const LEVEL_ONE_DESIGN = miniBossDesignForLevel(MINI_BOSS_GYM_LEVEL);
export const MINI_BOSS_GYM_NAME = LEVEL_ONE_DESIGN.archetype;
export const MINI_BOSS_GYM_COLOR = LEVEL_ONE_DESIGN.color;
export const MINI_BOSS_GYM_DESPERATION_COLOR =
  LEVEL_ONE_DESIGN.desperationColor ?? LEVEL_ONE_DESIGN.color;
export const MINI_BOSS_GYM_PHASES: readonly MiniBossPhaseConfig[] =
  LEVEL_ONE_DESIGN.phases.map((pattern) => ({ pattern }));
export const MINI_BOSS_GYM_MINIONS: readonly MiniBossMinionWaveConfig[] =
  LEVEL_ONE_DESIGN.minions ?? [];

/**
 * The design level the gym currently exercises (1–10). The dedicated gym row
 * boots level 1; the DESIGN button cycles through the catalogue so every
 * bespoke design is exercised through the same shared entity/core code
 * (AH-0MVCRBXSS008JSV0 AC3).
 */
let selectedDesignLevel = MINI_BOSS_GYM_LEVEL;

/** Selects the design level the gym boots (used by the DESIGN button/tests). */
export function selectGymMiniBossDesign(level: number): number {
  if (!Number.isInteger(level) || level < 1 || level > MINI_BOSS_DESIGN_LEVELS) {
    throw new RangeError(
      `Mini-boss design level must be an integer 1–${MINI_BOSS_DESIGN_LEVELS} (got ${String(level)}).`,
    );
  }
  selectedDesignLevel = level;
  return selectedDesignLevel;
}

/** The design level the gym will boot next. */
export function getSelectedGymMiniBossDesign(): number {
  return selectedDesignLevel;
}

/** The design the gym will boot next (catalogue entry). */
export function selectedGymMiniBossDesign() {
  return miniBossDesignForLevel(selectedDesignLevel);
}

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
    // The same config helper the game uses, so the gym exercises the real
    // per-level design (phases, colour, minions, archetype name). The gym
    // alone overrides the hit pool so a tester can step through every phase
    // quickly on the DAMAGE button.
    new MiniBoss(
      scene,
      miniBossConfigForLevel(selectedDesignLevel, {
        x,
        y,
        formationOffset,
        hpPerPhase: MINI_BOSS_GYM_HP_PER_PHASE,
      }),
    ),
  collectBullets: () => [],
};

/** GymMiniBoss — one config-driven mini-boss on the shared combat core. */
export class GymMiniBoss extends GymFormationScene<
  MiniBoss | EnemyEntity,
  BossBullet
> {
  private damageButton!: Phaser.GameObjects.Text;

  /**
   * Live handle for the in-flight mini-boss death sweep, or null between
   * defeats (AH-0MVROEMUO007Z3RY). The gym runs the *same* shared executor as
   * `PlayScene`, so what a tester verifies here is what ships (AC5).
   */
  private defeatSweep: MiniBossDeathSweepHandle | null = null;

  /** Targets captured for the current/last defeat sweep (test seam). */
  private defeatSweepTargets: readonly MiniBossSweepTarget[] = [];

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

    // Cycle through the ten bespoke per-level designs; restarting the scene
    // rebuilds the entity through the same shared config helper.
    this._addButton(explodeButton.x - 240, explodeButton.y, 'DESIGN', LABEL_STYLE)
      .on('pointerdown', () => {
        selectGymMiniBossDesign(
          (selectedDesignLevel % MINI_BOSS_DESIGN_LEVELS) + 1,
        );
        this.scene.restart();
      });

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

  // ── Defeat sweep (shared with PlayScene, AC5) ───────────────────

  /**
   * The gym's EXPLODE path (AH-0MVROEMUO007Z3RY).
   *
   * Replaces the generic "destroy one random entity" behaviour with the
   * mini-boss **defeat sweep** the game runs, through the same shared
   * `spawnMiniBossDeathSweep` helper: the mini-boss's live minions are
   * captured *before* the teardown (the entity clears them on destruction),
   * every captured target is removed cosmetically, and the staggered cascade
   * plus the scattered/anchored celebration bursts play out. The gym has no
   * reward overlay or wave accounting, so completion only reports itself on
   * the status line — the same display the game shows, minus the reward.
   */
  override explodeRandom(): void {
    const boss = this.formationMiniBoss;
    if (!boss?.alive) return;

    // Capture on this frame, before the entity is destroyed: the death
    // position the anchored bursts cluster around and the live minions the
    // entity tears down with its own body (AC1/AC5).
    const deathX = boss.x;
    const deathY = boss.y;
    const minionTargets = boss
      .getMinions()
      .map((minion) => this._sweepTargetForEntity(minion.archetype, minion));

    // The gym's wave-gating scope: any live formation enemy that is not the
    // mini-boss itself (the mini-boss plays its own boss-scale death), plus
    // the captured minions. Hazards are dropped by the shared splitter.
    const sweptEscorts = this.entities.filter(
      (entity): entity is EnemyEntity =>
        entity !== boss &&
        entity.alive &&
        typeof (entity as { archetype?: unknown }).archetype === 'string',
    );
    const targets = collectSweepTargets(
      sweptEscorts.map((entity) =>
        this._sweepTargetForEntity(entity.archetype, entity),
      ),
      minionTargets,
    );

    // Cosmetic removal: the shared silent seam marks the entity dead, then its
    // scene-level graphics are released. The burst visuals come from the sweep
    // itself, and nothing here awards score, drops or a kill roll.
    for (const entity of sweptEscorts) {
      entity.destroySilently();
      entity.destroy(true);
    }
    for (const minion of boss.getMinions()) {
      minion.destroySilently();
      minion.destroy(true);
    }

    // The mini-boss's own boss-scale death, then the shared sweep from the
    // death point the entity occupied when the blow landed.
    boss.destroySelf();
    boss.destroy(true);

    this.defeatSweepTargets = targets;
    this.defeatSweep = spawnMiniBossDeathSweep(
      this,
      {
        targets,
        deathX,
        deathY,
        bounds: { x: 0, y: 0, width: GAME_WIDTH, height: GAME_HEIGHT },
        seed: MINI_BOSS_GYM_SWEEP_SEED,
      },
      {
        onComplete: () => {
          this._refreshStatus('sweep complete');
        },
      },
    );
    this._refreshStatus(`exploded — ${targets.length} swept`);
  }

  /** Captures one sweep target from a live entity (archetype size/colour). */
  private _sweepTargetForEntity(
    key: string,
    entity: EnemyEntity,
  ): MiniBossSweepTarget {
    const cfg = loadEnemyConfig(key);
    return { key, x: entity.x, y: entity.y, size: cfg.size, color: cfg.color };
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

  /**
   * Test/inspection seam: whether the defeat sweep is still animating. The
   * gym mirrors `PlayScene.isMiniBossSweepActive()` so the same parity check
   * holds in both scenes (AH-0MVROEMUO007Z3RY).
   */
  isMiniBossSweepActive(): boolean {
    return this.defeatSweep !== null && !this.defeatSweep.complete;
  }

  /** Test/inspection seam: the targets captured for the defeat sweep. */
  getMiniBossSweepTargets(): readonly MiniBossSweepTarget[] {
    return [...this.defeatSweepTargets];
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
