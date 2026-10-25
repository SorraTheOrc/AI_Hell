/**
 * Single reusable *fodder* enemy gym scene (AH-0MTHG5B83007W4W4 + editor
 * panel AH-0MTHG5BIB006PP0P; renamed from `GymEnemies` and given an
 * in-panel enemy selector in AH-0MV13G5EV008D41E).
 *
 * Parameterized by an `EnemyConfig` key via `init({ enemyKey })`. Resolves
 * the active config through `loadEnemyConfig(enemyKey)` — so an empty or
 * corrupt storage entry falls back to seed defaults without throwing — and
 * derives every formation property + entity/shot behaviour from the config
 * and its registries (`FORMATION_BUILDERS`, `createEnemyFromConfig`).
 *
 * Editor panel (plain-DOM, mirrors `GymPlayer`): an enemy-type `<select>`
 * (every non-boss config, discovery-driven), sliders/selects/colour inputs
 * for movement/shot/visuals/formationKind plus Save / Save As… buttons.
 * Choosing a different enemy rebuilds the scene through the shared
 * `respawnFormation()` clean-slate seam and resyncs every panel control from
 * the newly selected config (discarding unsaved edits). Live-applies to
 * in-memory config and to spawned entities where sensible; Save overwrites
 * the active key, Save As sanitizes + validates and creates a new entry.
 * Removed on scene SHUTDOWN to avoid DOM leakage.
 */

import Phaser from 'phaser';

import {
  loadEnemyConfig,
  loadAllEnemyConfigs,
  saveEnemyConfig,
  sanitizeEnemyKey,
  isValidEnemyKey,
  listEnemyConfigKeys,
} from '../../core/enemyConfig';
import type { EnemyConfig } from '../../core/enemyConfig';
import { enemyDifficulty } from '../../core/enemyDifficulty';
import type { FormationOffset } from '../../utils/formations';
import { getFormationBuilder } from '../../utils/formations';
import { PLAYER_SPAWN, GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { splitAsteroid } from '../core/asteroidSplit';
import {
  applyAndPersistSpawnInterval,
  buildSpawnIntervalSlider,
} from '../../utils/gymPowerUpControl';
import { makeCollapsible } from '../../utils/gymPanel';
import { createEnemyFromConfig, type EnemyEntity } from '../../entities/enemyFactory';
import { fireForEnemy } from '../../entities/enemyFire';
import { Asteroid } from '../../entities/Asteroid';
import type { FormationSceneBullet } from './core/GymFormationScene';
import { GymFormationScene, type EnemyFormationConfig } from './core/GymFormationScene';
import { WAVE_TIME_LIMIT_SECONDS } from '../core/waveTimeout';
import {
  CENTIPEDE_SEGMENT_COUNT,
  CENTIPEDE_SEGMENT_SPACING,
  CENTIPEDE_ENEMY_KEY,
} from '../../waves/CentipedeSpawner';
import type { CentipedeChain } from '../core/centipedeChain';
import {
  centipedeFormationConfig,
  getCentipedeChain,
} from './core/centipedeFormation';

export const GYM_FODDER_ENEMIES_DEFAULT_KEY = 'scout';

/**
 * Enemy-config key of the boss archetype. The boss is deliberately excluded
 * from the gym wave-timeout — the operator asked for a timeout on every
 * enemy gym *except* the boss (AH-0MUNR5LM1004B223).
 */
export const GYM_FODDER_ENEMIES_BOSS_KEY = 'boss';

/**
 * Dropdown value + archetype key of the Centipede linked-chain enemy type
 * (AH-0MV4ZOIZR0086T66). The Centipede is a wave opt-in, not a CSV
 * `EnemyConfig`, so it is surfaced as a dedicated option in the in-panel
 * enemy selector (alongside the discovered configs) instead of a separate
 * ENEMIES row on the gym index.
 */
export const GYM_FODDER_ENEMIES_CENTIPEDE_KEY = CENTIPEDE_ENEMY_KEY;

/** Display label of the Centipede entry in the enemy selector. */
export const GYM_FODDER_ENEMIES_CENTIPEDE_LABEL = 'Centipede';

/**
 * Panel DOM ids — stable selectors for tests. The panel is a plain-DOM
 * overlay under `#game-container` (mirrors `GymPlayer`'s `gym-config-panel`),
 * removed on scene `SHUTDOWN` to avoid leakage across re-boots.
 */

export const ENEMY_PANEL_ID = 'enemy-gym-panel';
export const ENEMY_SAVE_ID = 'enemy-gym-save';
export const ENEMY_SAVE_AS_ID = 'enemy-gym-save-as';
export const ENEMY_SAVE_STATUS_ID = 'enemy-gym-save-status';
export const ENEMY_SAVE_AS_INPUT_ID = 'enemy-gym-save-as-input';
/** In-panel enemy-type selector (`<select>`); options are discovery-driven. */
export const ENEMY_SELECT_ID = 'enemy-gym-select';
/** Container wrapping the config-tuning controls (hidden for non-config archetypes). */
export const ENEMY_CONFIG_BODY_ID = 'enemy-gym-config-body';
export const ENEMY_RESPAWN_ID = 'enemy-gym-respawn';
export const ENEMY_TOGGLE_PLAYER_ID = 'enemy-gym-toggle-player';
/** Live 0–100 archetype difficulty readout (AH-0MTZWZ7MC002B01K, AC5). */
export const ENEMY_DIFFICULTY_ID = 'enemy-gym-difficulty';
/**
 * Divergence note for the force-field editor controls
 * (AH-0MVM8GXEF009883O, AC4). The formation gym has no campaign context, so
 * its force-field sliders set the spawned hits DIRECTLY instead of evaluating
 * the level curve the game and the level gym share.
 */
export const ENEMY_FORCE_FIELD_NOTE_ID = 'enemy-gym-force-field-note';

// Numeric slider ranges (mirrors GymPlayer SLIDER_RANGES pattern).
const ENEMY_SLIDER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  count: { min: 1, max: 200, step: 1 },
  spacingX: { min: 10, max: 120, step: 1 },
  spacingY: { min: 10, max: 100, step: 1 },
  driftSpeed: { min: 0, max: 200, step: 1 },
  // March-formation tuning (Space Invaders archetype, AH-0MV01EDZS0005R20):
  // neutral for other kinds, editable in the Enemies panel so the step/reverse
  // cadence and the per-reversal drop can be dialled in live.
  marchStep: { min: 4, max: 80, step: 1 },
  marchDrop: { min: 4, max: 80, step: 1 },
  // Tractor-beam tuning (Galaga capturer archetype, AH-0MV01EFII008298D):
  // neutral for other kinds, editable so the beam cadence and bounded pull
  // can be dialled in live.
  beamDuration: { min: 200, max: 4000, step: 50 },
  pullStrength: { min: 0, max: 200, step: 5 },
  // Robotron homing-horde tuning (AH-0MV01EKTL001NRE6): neutral for other
  // kinds, editable so the group size and spawn cadence can be dialled in
  // live. The horde's size and homing speed use the existing `count` and
  // `driftSpeed` sliders.
  hordeGroupSize: { min: 1, max: 20, step: 1 },
  hordeSpawnInterval: { min: 0.2, max: 6, step: 0.1 },
  // Defender raider tuning (AH-0MV01EM7U0033W7L): neutral for other kinds,
  // editable so the committed attack speed and commit range can be dialled
  // in live. The raider's patrol speed uses the existing `driftSpeed` slider.
  attackSpeed: { min: 40, max: 600, step: 5 },
  commitRange: { min: 40, max: 600, step: 10 },
  startX: { min: 0, max: GAME_WIDTH, step: 1 },
  startY: { min: 0, max: GAME_HEIGHT, step: 1 },
  // Spawn-position ranges (AH-0MUKCLXLW0032R67): bound to the canvas so a
  // designer cannot place a formation off-screen; validated min <= max.
  startXMin: { min: 0, max: GAME_WIDTH, step: 1 },
  startXMax: { min: 0, max: GAME_WIDTH, step: 1 },
  startYMin: { min: 0, max: GAME_HEIGHT, step: 1 },
  startYMax: { min: 0, max: GAME_HEIGHT, step: 1 },
  size: { min: 6, max: 80, step: 1 },
  bulletSize: { min: 1, max: 12, step: 1 },
  fireInterval: { min: 100, max: 5000, step: 50 },
  shotProbability: { min: 0, max: 1, step: 0.05 },
  bulletSpeed: { min: 40, max: 600, step: 5 },
  // Bullet TTL in seconds — matches FACTOR_RANGES.bulletLifetime so designers
  // stay inside the difficulty model's normalised range (AH-0MUDYTPMC002GLEJ).
  bulletLifetime: { min: 0.1, max: 5.0, step: 0.1 },
  burstCount: { min: 1, max: 24, step: 1 },
  // Enemy force-field tuning (AH-0MVM8GXEF009883O, AC4). The formation gym
  // has no campaign level, so `forceFieldStartHits` is used DIRECTLY as the
  // spawned field strength (documented divergence — the game and the level
  // gym evaluate the shared level curve instead). `forceFieldStartLevel` and
  // `forceFieldMaxHits` remain editable so a config authored here is still
  // coherent in the campaign, but they do not affect this gym's spawn.
  forceFieldStartLevel: { min: 0, max: 10, step: 1 },
  forceFieldStartHits: { min: 0, max: 5, step: 1 },
  forceFieldMaxHits: { min: 0, max: 5, step: 1 },
};

const VISUAL_COLOR_FIELDS = ['color', 'bulletColor'] as const;

/** The four slider-backed spawn-range fields (AH-0MUKCLXLW0032R67). */
export const SPAWN_RANGE_FIELDS = ['startXMin', 'startXMax', 'startYMin', 'startYMax'] as const;

/** Clamp `value` into the inclusive `[lo, hi]` band. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Clamp and order the spawn-range fields so the editor always exposes a
 * valid band: each bound is clamped to the canvas and `min <= max` is
 * enforced by swapping a reversed pair (AC3c/AC3d). Mutates and returns the
 * supplied config. A missing/NaN bound falls back to the scalar start value.
 */
export function normaliseSpawnRanges(config: EnemyConfig): EnemyConfig {
  const clampTo = (value: number | undefined, fallback: number, hi: number): number =>
    clamp(Number.isFinite(value as number) ? (value as number) : fallback, 0, hi);

  let xMin = clampTo(config.startXMin, config.startX, GAME_WIDTH);
  let xMax = clampTo(config.startXMax, config.startX, GAME_WIDTH);
  if (xMin > xMax) [xMin, xMax] = [xMax, xMin];

  let yMin = clampTo(config.startYMin, config.startY, GAME_HEIGHT);
  let yMax = clampTo(config.startYMax, config.startY, GAME_HEIGHT);
  if (yMin > yMax) [yMin, yMax] = [yMax, yMin];

  config.startXMin = xMin;
  config.startXMax = xMax;
  config.startYMin = yMin;
  config.startYMax = yMax;
  return config;
}

/**
 * Direct force-field hits for a formation-gym spawn (AH-0MVM8GXEF009883O,
 * AC4). The gym has no campaign level, so the authored `forceFieldStartHits`
 * is applied DIRECTLY instead of evaluating `enemyForceFieldHits` — the
 * documented divergence recorded next to the panel controls. Archetypes that
 * the campaign never shields (`forceFieldStartLevel` = 0, e.g. asteroids and
 * lane traffic) stay unshielded here too, so the gym editor cannot fabricate
 * a field on a never-shielded enemy; to force one, raise the start level and
 * set the hit count.
 */
export function gymDirectForceFieldHits(config: EnemyConfig): number {
  const level = config.forceFieldStartLevel;
  if (typeof level !== 'number' || !Number.isFinite(level) || level <= 0) {
    return 0;
  }
  const hits = config.forceFieldStartHits;
  if (typeof hits !== 'number' || !Number.isFinite(hits)) return 0;
  return Math.min(5, Math.max(0, Math.round(hits)));
}

const FORMATION_KINDS = ['v', 'diver', 'rect', 'swarm', 'orbital', 'single', 'march'] as const;
const SHOT_PATTERNS = ['none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated'] as const;
// Behavioural classification enums (AH-0MV29NWI1007NKN7): coarse
// movement/attack roles consumed by wave-design balance tooling.
const MOVEMENT_CLASSES = ['formation', 'diver', 'chaser', 'patroller', 'roamer'] as const;
const ATTACK_CLASSES = ['contact', 'projectile', 'beam', 'area'] as const;

// ── Colour helpers (mirrors GymPlayer) ───────────────────────────

function colorToHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
function hexToColor(value: string): number {
  return parseInt(value.replace('#', ''), 16);
}

type GymFodderEnemiesBullet = FormationSceneBullet;

function enemyConfigToFormationConfig(enemyKey: string): EnemyFormationConfig<EnemyEntity, GymFodderEnemiesBullet> {
  const cfg: EnemyConfig = loadEnemyConfig(enemyKey ?? GYM_FODDER_ENEMIES_DEFAULT_KEY);
  const key = cfg.key || enemyKey || GYM_FODDER_ENEMIES_DEFAULT_KEY;
  const builder = getFormationBuilder(cfg.formationKind);

  // Shared archetype→tryFire dispatch (AH-0MUII3BBW000XZ46): a new
  // archetype is wired once, in `src/entities/enemyFire.ts`.
  const collectBullets = (entity: EnemyEntity, now: number): GymFodderEnemiesBullet[] =>
    fireForEnemy<GymFodderEnemiesBullet>(entity, key, now);

  return {
    sceneKey: 'GymFodderEnemies',
    buildOffsets: builder,
    count: cfg.count,
    spacingX: cfg.spacingX,
    spacingY: cfg.spacingY,
    driftSpeed: cfg.driftSpeed,
    formationKind: cfg.formationKind,
    marchStep: cfg.marchStep,
    marchDrop: cfg.marchDrop,
    startX: cfg.startX,
    startY: cfg.startY,
    startXMin: cfg.startXMin,
    startXMax: cfg.startXMax,
    startYMin: cfg.startYMin,
    startYMax: cfg.startYMax,
    statusLabel: cfg.displayName.toLowerCase(),
    hintText: `${cfg.displayName} — ${cfg.formationKind} formation (config-driven)`,
    player: { ...PLAYER_SPAWN },
    // Every enemy gym gets the shared wave-timeout except the boss
    // (AH-0MUNR5LM1004B223). The base class runs the shared
    // major-explosion cue + limiter on expiry.
    timeoutDuration: key === GYM_FODDER_ENEMIES_BOSS_KEY ? undefined : WAVE_TIME_LIMIT_SECONDS,
    // Opt-in power-up layer: one drop at a time on the rules interval,
    // weighted-random ID (Shield–Magnet plus weapon drops) and
    // enemy/player-avoiding placement.
    powerUps: {},
    createEntity: (scene: Phaser.Scene, x: number, y: number, offset: FormationOffset) =>
      createEnemyFromConfig(
        scene,
        cfg,
        x,
        y,
        offset,
        undefined,
        // Documented divergence (AH-0MVM8GXEF009883O): a formation gym has
        // no campaign level, so the authored start hits are applied directly
        // instead of evaluating `enemyForceFieldHits`. Must never leak into
        // the shipped campaign CSV path — the game and level gym always use
        // the level curve.
        gymDirectForceFieldHits(cfg),
      ),
    collectBullets,
    // Asteroid split seam (GDD §4.1 — E6 Asteroid): a destroyed large/medium
    // rock spawns exactly two smaller children that join the live formation
    // list, so the EXPLODE button and player bullets both cascade splits and
    // the wipe→respawn cycle only fires once the whole chain is cleared.
    // Uses the shared helper the shipped game also consumes (gap 8).
    onEntityDestroyed: (entity: EnemyEntity): void => {
      if (!(entity instanceof Asteroid)) return;
      const scene = entity.scene as
        | GymFormationScene<EnemyEntity, GymFodderEnemiesBullet>
        | null;
      if (!scene) return;
      splitAsteroid({
        scene,
        parent: entity,
        register: (child) => scene.registerDynamicEntity(child),
      });
    },
  };
}

/**
 * Synthetic in-memory `EnemyConfig` describing the Centipede chain for the
 * panel/accessor surface. The Centipede is a wave opt-in, not a CSV config, so
 * this is never persisted (the config-tuning controls are hidden while it is
 * the active archetype) — it exists only so the difficulty readout and
 * `currentConfig` stay coherent.
 */
function centipedePanelConfig(): EnemyConfig {
  const base = loadEnemyConfig(GYM_FODDER_ENEMIES_DEFAULT_KEY);
  const startX = GAME_WIDTH / 2;
  const startY = CENTIPEDE_SEGMENT_COUNT * CENTIPEDE_SEGMENT_SPACING;
  return {
    ...base,
    key: GYM_FODDER_ENEMIES_CENTIPEDE_KEY,
    displayName: GYM_FODDER_ENEMIES_CENTIPEDE_LABEL,
    formationKind: 'single',
    count: CENTIPEDE_SEGMENT_COUNT,
    spacingX: 0,
    spacingY: 0,
    driftSpeed: 0,
    startX,
    startY,
    startXMin: startX,
    startXMax: startX,
    startYMin: startY,
    startYMax: startY,
    shotPattern: 'none',
    movementClass: 'roamer',
    attackClass: 'contact',
  };
}

export class GymFodderEnemies extends GymFormationScene<EnemyEntity, GymFodderEnemiesBullet> {
  private pendingKey: string = GYM_FODDER_ENEMIES_DEFAULT_KEY;
  private activeConfig: EnemyConfig = loadEnemyConfig(GYM_FODDER_ENEMIES_DEFAULT_KEY);
  private panel: HTMLDivElement | null = null;
  /** Config-tuning controls container; hidden while a non-config archetype runs. */
  private _configBody: HTMLDivElement | null = null;
  private _playerEnabled = true;

  constructor() {
    super(enemyConfigToFormationConfig(GYM_FODDER_ENEMIES_DEFAULT_KEY));
  }

  init(data?: { enemyKey?: string }): void {
    const key = data?.enemyKey ?? GYM_FODDER_ENEMIES_DEFAULT_KEY;
    this.pendingKey = key;
    if (key === GYM_FODDER_ENEMIES_CENTIPEDE_KEY) {
      // The Centipede is a chain archetype (wave opt-in), not a CSV config:
      // boot the shared centipede formation the game and GymCentipede run.
      this.activeConfig = centipedePanelConfig();
      this.config = centipedeFormationConfig('GymFodderEnemies');
    } else {
      this.activeConfig = loadEnemyConfig(key);
      const next = enemyConfigToFormationConfig(key);
      this.config = next;
    }
    this._resolveFormationBase();
  }

  override create(): void {
    super.create();
    this._buildPanel();
    this._applyPanelValues(this.activeConfig);
    // Non-config archetypes (the Centipede chain) hide the config-tuning
    // controls — there is no CSV row to tune or save.
    this._setConfigBodyVisible(this.pendingKey !== GYM_FODDER_ENEMIES_CENTIPEDE_KEY);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.panel?.remove();
      this.panel = null;
      this._configBody = null;
    });
  }

  // ── Panel construction (mirrors GymPlayer._buildPanel) ──────────

  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    // Remove any stale panel left behind by a previous test/game instance.
    document.getElementById(ENEMY_PANEL_ID)?.remove();
    const panel = document.createElement('div');
    panel.id = ENEMY_PANEL_ID;
    // Shared bottom-left anchoring + viewport height cap (AH-0MUAYB7O4009LWBF).
    panel.className = 'gym-panel';

    // Live archetype difficulty readout (AH-0MTZWZ7MC002B01K, AC5) — gives
    // designers immediate feedback while tuning, without a running game.
    const difficultyRow = document.createElement('div');
    difficultyRow.className = 'gym-panel-row';
    const difficultyLabel = document.createElement('span');
    difficultyLabel.textContent = 'difficulty';
    difficultyLabel.className = 'gym-panel-label';
    const difficultyValue = document.createElement('output');
    difficultyValue.id = ENEMY_DIFFICULTY_ID;
    difficultyValue.setAttribute('aria-label', 'Enemy difficulty (0-100)');
    difficultyRow.append(difficultyLabel, difficultyValue);
    panel.appendChild(difficultyRow);

    // Enemy-type selector (AH-0MV13G5EV008D41E): one option per non-boss
    // `EnemyConfig` (resolved from the config store so seed and Save As
    // entries both appear with no hard-coded key list) plus the dedicated
    // Centipede linked-chain option (AH-0MV4ZOIZR0086T66). Choosing an option
    // rebuilds the scene and resyncs the rest of the panel.
    panel.appendChild(this._enemySelectRow());

    // Everything below tunes a specific `EnemyConfig`; the Centipede chain has
    // fixed tuning (no CSV row), so these controls are wrapped in one container
    // that is hidden while the centipede is the active archetype.
    const configBody = document.createElement('div');
    configBody.id = ENEMY_CONFIG_BODY_ID;

    // Numeric sliders.
    for (const [field, range] of Object.entries(ENEMY_SLIDER_RANGES)) {
      configBody.appendChild(this._sliderRow(field, range));
    }

    // Force-field divergence copy (AH-0MVM8GXEF009883O, AC4): the editor
    // controls are direct hit counts, not the shared campaign level curve.
    const forceFieldNote = document.createElement('p');
    forceFieldNote.id = ENEMY_FORCE_FIELD_NOTE_ID;
    forceFieldNote.textContent =
      'Force fields: this formation gym sets hits DIRECTLY from ' +
      'forceFieldStartHits (no campaign level curve is evaluated here); ' +
      'archetypes with forceFieldStartLevel 0 stay unshielded. The game and ' +
      'the level gym resolve the shared curve.';
    configBody.appendChild(forceFieldNote);

    // Colour inputs.
    for (const field of VISUAL_COLOR_FIELDS) {
      configBody.appendChild(this._colorRow(field));
    }

    // Formation / shot enums as selects.
    configBody.appendChild(this._selectRow('formationKind', [...FORMATION_KINDS]));
    configBody.appendChild(this._selectRow('shotPattern', [...SHOT_PATTERNS]));

    // Behavioural classification selects (AH-0MV29NWI1007NKN7): persisted
    // through the same CSV save path as every other control.
    configBody.appendChild(this._selectRow('movementClass', [...MOVEMENT_CLASSES]));
    configBody.appendChild(this._selectRow('attackClass', [...ATTACK_CLASSES]));

    // Respawn + Player toggle row (controls that affect the live scene, not persistence).
    const utilRow = document.createElement('div');
    utilRow.className = 'gym-panel-actions';

    const respawn = document.createElement('button');
    respawn.id = ENEMY_RESPAWN_ID;
    respawn.type = 'button';
    respawn.textContent = 'Respawn';
    respawn.addEventListener('click', () => this._onRespawn());

    const togglePlayer = document.createElement('button');
    togglePlayer.id = ENEMY_TOGGLE_PLAYER_ID;
    togglePlayer.type = 'button';
    togglePlayer.dataset['enabled'] = this._playerEnabled ? 'true' : 'false';
    togglePlayer.textContent = this._playerEnabled ? 'Player: ON' : 'Player: OFF';
    togglePlayer.addEventListener('click', () => this._onTogglePlayer());

    utilRow.append(respawn, togglePlayer);
    configBody.appendChild(utilRow);

    // Live spawn-interval control (power-up cadence, live-tunable).
    const spawnControl = buildSpawnIntervalSlider((seconds) => {
      this.setPowerUpSpawnInterval(seconds);
      applyAndPersistSpawnInterval(seconds);
    });
    configBody.appendChild(spawnControl.row);

    // Save / Save As row.
    const actions = document.createElement('div');
    actions.className = 'gym-panel-actions';

    const save = document.createElement('button');
    save.id = ENEMY_SAVE_ID;
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => this._onSave());

    const saveAsInput = document.createElement('input');
    saveAsInput.id = ENEMY_SAVE_AS_INPUT_ID;
    saveAsInput.type = 'text';
    saveAsInput.placeholder = 'New enemy name…';
    saveAsInput.setAttribute('aria-label', 'New enemy name');

    const saveAs = document.createElement('button');
    saveAs.id = ENEMY_SAVE_AS_ID;
    saveAs.type = 'button';
    saveAs.textContent = 'Save As…';
    saveAs.addEventListener('click', () => this._onSaveAs());

    const status = document.createElement('span');
    status.id = ENEMY_SAVE_STATUS_ID;

    actions.append(save, saveAsInput, saveAs, status);
    configBody.appendChild(actions);

    panel.appendChild(configBody);
    this._configBody = configBody;

    // Wrap the controls in a collapsible body + header (AH-0MUDYFMUX007Q0W3).
    makeCollapsible({ panel, title: 'AI Config' });

    host.appendChild(panel);
    this.panel = panel;
  }

  private _sliderRow(field: string, range: { min: number; max: number; step: number }): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';
    const label = document.createElement('span');
    label.textContent = field;
    label.className = 'gym-panel-label';
    const input = document.createElement('input');
    input.type = 'range';
    input.dataset['config'] = field;
    input.min = String(range.min);
    input.max = String(range.max);
    input.step = String(range.step);
    input.addEventListener('input', () => this._onConfigInput(field));
    const value = document.createElement('output');
    value.dataset['configValue'] = field;
    row.append(label, input, value);
    return row;
  }

  private _colorRow(field: string): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';
    const label = document.createElement('span');
    label.textContent = field;
    label.className = 'gym-panel-label';
    const input = document.createElement('input');
    input.type = 'color';
    input.dataset['config'] = field;
    input.addEventListener('input', () => this._onConfigInput(field));
    row.append(label, input);
    return row;
  }

  private _selectRow(field: string, options: string[]): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';
    const label = document.createElement('span');
    label.textContent = field;
    label.className = 'gym-panel-label';
    const select = document.createElement('select');
    select.dataset['config'] = field;
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }
    select.addEventListener('change', () => this._onConfigInput(field));
    row.append(label, select);
    return row;
  }

  /**
   * The enemy-type selector row (AH-0MV13G5EV008D41E). Options are the
   * non-boss `EnemyConfig` keys discovered from the config store (seed +
   * Save As), labelled by `displayName`, plus the dedicated Centipede
   * linked-chain option (AH-0MV4ZOIZR0086T66); the whole roster is sorted
   * alphabetically and the scene's active key is preselected. The `boss`
   * archetype is deliberately excluded — it has its own dedicated gym entry.
   */
  private _enemySelectRow(): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';
    const label = document.createElement('span');
    label.textContent = 'enemy';
    label.className = 'gym-panel-label';
    const select = document.createElement('select');
    select.id = ENEMY_SELECT_ID;
    select.setAttribute('aria-label', 'Enemy type');
    for (const option of this._selectableEnemyOptions()) {
      const o = document.createElement('option');
      o.value = option.value;
      o.textContent = option.label;
      select.appendChild(o);
    }
    select.value = this.pendingKey;
    select.addEventListener('change', () => this._onEnemySelect());
    row.append(label, select);
    return row;
  }

  /**
   * Every option offered by the enemy selector: the non-boss `EnemyConfig`
   * keys (discovery-driven, so a Save As entry appears on the next boot) plus
   * the dedicated Centipede linked-chain archetype, which is a wave opt-in
   * rather than a CSV config. Sorted alphabetically by label so the selector
   * reads as one coherent roster.
   */
  private _selectableEnemyOptions(): { value: string; label: string }[] {
    const configs = this._selectableEnemyConfigs().map((cfg) => ({
      value: cfg.key,
      label: cfg.displayName,
    }));
    return [
      ...configs,
      {
        value: GYM_FODDER_ENEMIES_CENTIPEDE_KEY,
        label: GYM_FODDER_ENEMIES_CENTIPEDE_LABEL,
      },
    ].sort(
      (a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value),
    );
  }

  /**
   * Non-boss configs offered by the enemy selector, sorted alphabetically by
   * display name then key. Reads the live config store so a Save As entry is
   * picked up on the next boot without a code change; corrupt storage falls
   * back to the seed defaults via {@link loadAllEnemyConfigs}.
   */
  private _selectableEnemyConfigs(): EnemyConfig[] {
    return loadAllEnemyConfigs()
      .filter((cfg) => cfg.key !== GYM_FODDER_ENEMIES_BOSS_KEY)
      .sort(
        (a, b) =>
          a.displayName.localeCompare(b.displayName) || a.key.localeCompare(b.key),
      );
  }

  // ── Panel ↔ config sync ─────────────────────────────────────────

  private _readPanelValues(changedField?: string): EnemyConfig {
    const next: EnemyConfig = { ...this.activeConfig };
    for (const field of Object.keys(ENEMY_SLIDER_RANGES)) {
      const input = this.panel?.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      if (input) (next as unknown as Record<string, unknown>)[field] = Number(input.value);
    }
    // The legacy scalar start sliders remain functional (AC3e): editing one
    // collapses its range to that point so the base still follows the slider.
    if (changedField === 'startX') {
      next.startXMin = next.startX;
      next.startXMax = next.startX;
    }
    if (changedField === 'startY') {
      next.startYMin = next.startY;
      next.startYMax = next.startY;
    }
    for (const field of VISUAL_COLOR_FIELDS) {
      const input = this.panel?.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      if (input) (next as unknown as Record<string, unknown>)[field] = hexToColor(input.value);
    }
    for (const field of ['formationKind', 'shotPattern', 'movementClass', 'attackClass'] as const) {
      const sel = this.panel?.querySelector<HTMLSelectElement>(`select[data-config="${field}"]`);
      if (sel) (next as unknown as Record<string, unknown>)[field] = sel.value;
    }
    // Clamp to the canvas and enforce min <= max before the value is used.
    return normaliseSpawnRanges(next);
  }

  private _applyPanelValues(config: EnemyConfig): void {
    if (!this.panel) return;
    for (const field of Object.keys(ENEMY_SLIDER_RANGES)) {
      const input = this.panel.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      const value = this.panel.querySelector<HTMLElement>(`output[data-config-value="${field}"]`);
      if (input) input.value = String((config as unknown as Record<string, unknown>)[field] ?? 0);
      if (value) value.textContent = String((config as unknown as Record<string, unknown>)[field] ?? '');
    }
    for (const field of VISUAL_COLOR_FIELDS) {
      const input = this.panel.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      if (input) input.value = colorToHex((config as unknown as Record<string, unknown>)[field] as number);
    }
    for (const field of ['formationKind', 'shotPattern', 'movementClass', 'attackClass'] as const) {
      const sel = this.panel.querySelector<HTMLSelectElement>(`select[data-config="${field}"]`);
      if (sel) sel.value = String((config as unknown as Record<string, unknown>)[field] ?? '');
    }
    this._updateDifficulty(config);
  }

  /**
   * Recomputes and renders the live archetype difficulty (0–100) for the
   * supplied in-memory config. Updates whenever a slider/select/colour
   * control changes, so designers see the effect of a change immediately
   * (AH-0MTZWZ7MC002B01K, AC5).
   */
  private _updateDifficulty(config: EnemyConfig): void {
    const el = this.panel?.querySelector<HTMLElement>(`#${ENEMY_DIFFICULTY_ID}`);
    if (!el) return;
    const { score } = enemyDifficulty(config);
    el.textContent = `${score.toFixed(1)} / 100`;
  }

  private _updateValueLabels(config: EnemyConfig): void {
    for (const field of Object.keys(ENEMY_SLIDER_RANGES)) {
      const value = this.panel?.querySelector<HTMLElement>(`output[data-config-value="${field}"]`);
      if (value) value.textContent = String((config as unknown as Record<string, unknown>)[field] ?? '');
    }
  }

  /** Any control change updates in-memory config and live-applies to the scene/entities. */
  private _onConfigInput(changedField?: string): void {
    const next = this._readPanelValues(changedField);
    this.activeConfig = next;
    this._updateValueLabels(next);
    this._updateDifficulty(next);
    this._applyLive(next);
    // Write normalised range bounds back so the sliders always show the
    // clamped, ordered band the scene will actually use (AC3c/AC3d).
    this._syncSpawnRangeInputs(next);
  }

  /** Mirrors the normalised spawn-range values back onto their sliders. */
  private _syncSpawnRangeInputs(config: EnemyConfig): void {
    for (const field of SPAWN_RANGE_FIELDS) {
      const input = this.panel?.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      if (input) input.value = String((config as unknown as Record<string, unknown>)[field]);
    }
  }

  // Live apply — where sensible, without full formation respawn.

  private _applyLive(config: EnemyConfig): void {
    // Drift / start / spacing / formationKind affect the formation base
    // and builder; count is noted but not respawned live (requires rebuild).
    // Keep config protected seam up to date for future ticks.
    const builder = getFormationBuilder(config.formationKind);
    this.config.buildOffsets = builder;
    this.config.spacingX = config.spacingX;
    this.config.spacingY = config.spacingY;
    this.config.driftSpeed = config.driftSpeed;
    this.config.formationKind = config.formationKind;
    this.config.marchStep = config.marchStep;
    this.config.marchDrop = config.marchDrop;
    this.config.startX = config.startX;
    this.config.startY = config.startY;
    this.config.startXMin = config.startXMin;
    this.config.startXMax = config.startXMax;
    this.config.startYMin = config.startYMin;
    this.config.startYMax = config.startYMax;
    this.config.count = config.count;

    // Re-derive shot dispatch if the active key's pattern changed — the
    // closure captures the old key; re-wire collectBullets to the new pattern.
    // Rather than rebuilding the closure over `key`, map shotPattern generically:
    // keep the entity-type dispatch (key) but re-read burst/interval via
    // entity seam where applicable. Shot-pattern selector is informational
    // for future use; entity fire methods remain the source of truth.
    void config.shotPattern; // acknowledged

    // Per-entity live visuals / shot tuning where seam exists.
    for (const entity of this.entities) {
      const e = entity as unknown as Record<string, unknown>;
      // Apply colour/size if entity exposes a seam — Scout/Diver/Tank/Phaser/Swarm
      // expose effectiveColor/effectiveSize getters backed by ctor opts, but
      // live mutation requires a direct graphics refresh; at minimum update
      // any mutable tuning the entity exposes.
      // Bullet tunings are picked up on the next fire via the entity's
      // internal interval/burst fields; we patch them if writable.

      // Try to patch known private fields if present (best-effort live tuning).
      // These are `_color`/`_colorNumber`/`_size`/`_bulletColor` etc — not all
      // entities expose setters, so no-op when absent.
      if ('_color' in e) (e as Record<string, unknown>)['_color'] = config.color;
      if ('_colorNumber' in e) (e as Record<string, unknown>)['_colorNumber'] = config.color;
      if ('_size' in e) (e as Record<string, unknown>)['_size'] = config.size;
      if ('_bulletColor' in e) (e as Record<string, unknown>)['_bulletColor'] = config.bulletColor;
      if ('_bulletSize' in e) (e as Record<string, unknown>)['_bulletSize'] = config.bulletSize;
      if ('_bulletSpeed' in e) (e as Record<string, unknown>)['_bulletSpeed'] = config.bulletSpeed;
      if ('_bulletLifetime' in e) (e as Record<string, unknown>)['_bulletLifetime'] = config.bulletLifetime;
      if ('_fireInterval' in e) (e as Record<string, unknown>)['_fireInterval'] = config.fireInterval;
      if ('_burstCount' in e) (e as Record<string, unknown>)['_burstCount'] = config.burstCount;
      if ('_shotProbability' in e) (e as Record<string, unknown>)['_shotProbability'] = config.shotProbability;
      // Tractor-beam tuning (Galaga capturer archetype, AH-0MV01EFII008298D).
      if ('_beamDuration' in e) (e as Record<string, unknown>)['_beamDuration'] = config.beamDuration ?? 0;
      if ('_pullStrength' in e) (e as Record<string, unknown>)['_pullStrength'] = config.pullStrength ?? 0;
    }
  }

  // ── Respawn / Player toggle ─────────────────────────────────────

  /**
   * Enemy-selector change handler (AH-0MV13G5EV008D41E): swaps the active
   * archetype to the chosen key, rebuilding the whole scene from that config.
   * Unknown/empty values are ignored.
   */
  private _onEnemySelect(): void {
    const select = this.panel?.querySelector<HTMLSelectElement>(`#${ENEMY_SELECT_ID}`);
    const key = select?.value;
    if (!key) return;
    this._selectEnemy(key);
  }

  /**
   * Rebuilds the scene for `key` through the shared clean-slate seam:
   *
   * 1. load the selected `EnemyConfig` and rebuild the formation config
   *    (entity factory, bullet dispatch, formation builder, timeout) — or,
   *    for the Centipede option, swap to the shared linked-chain formation
   *    (the same code `GymCentipede`/`PlayScene` run) and hide the
   *    config-tuning controls (its tuning is fixed, there is no CSV row);
   * 2. destroy every live formation entity and the player's in-flight
   *    bullets via `respawnFormation()` (the same path the Respawn button
   *    uses — no forked destroy/spawn logic);
   * 3. reload every panel control from the newly selected config, discarding
   *    unsaved edits made against the previous enemy.
   */
  private _selectEnemy(key: string): void {
    this.pendingKey = key;

    // A selection change is a clean slate for the player's shots too (the
    // shared respawn seam deliberately keeps them).
    for (const pb of this.playerBullets) pb.destroy();
    this.playerBullets = [];

    if (key === GYM_FODDER_ENEMIES_CENTIPEDE_KEY) {
      // Centipede is a wave opt-in / linked chain, not a CSV config: the
      // whole formation config is the shared centipede one and the
      // config-tuning controls are hidden.
      this.activeConfig = centipedePanelConfig();
      this.config = centipedeFormationConfig('GymFodderEnemies');
      this._setConfigBodyVisible(false);
      // Shared formation-respawn seam — destroys the old formation and spawns
      // the newly selected one (a fresh chain) at the initial geometry.
      this.respawnFormation();
      const centipedeSelect = this.panel?.querySelector<HTMLSelectElement>(
        `#${ENEMY_SELECT_ID}`,
      );
      if (centipedeSelect) centipedeSelect.value = this.activeConfig.key || key;
      return;
    }

    this.activeConfig = loadEnemyConfig(key);
    this.config = enemyConfigToFormationConfig(key);
    this._setConfigBodyVisible(true);

    // Shared formation-respawn seam — destroys the old formation and spawns
    // the newly selected one at the initial geometry.
    this.respawnFormation();

    // Reload every other control from the new persisted config.
    this._applyPanelValues(this.activeConfig);
    const select = this.panel?.querySelector<HTMLSelectElement>(`#${ENEMY_SELECT_ID}`);
    if (select) select.value = this.activeConfig.key || key;
  }

  /**
   * Shows/hides the config-tuning controls. They only apply to CSV
   * `EnemyConfig` archetypes, so they are hidden while the Centipede chain
   * (a fixed, non-config archetype) is active.
   */
  private _setConfigBodyVisible(visible: boolean): void {
    if (this._configBody) this._configBody.style.display = visible ? '' : 'none';
  }

  private _onRespawn(): void {
    // Read the freshest panel values (sliders may have changed since last input event
    // if the test set .value directly without dispatching — _readPanelValues covers it).
    const cfg = this._readPanelValues();
    this.activeConfig = cfg;

    // Keep the protected formation seam in sync so future ticks use the new
    // tuning, and rebuild the entity factory so the shared respawn spawns with
    // the live-edited config (createEntity is closed over the construction cfg).
    const builder = getFormationBuilder(cfg.formationKind);
    this.config.buildOffsets = builder;
    this.config.count = cfg.count;
    this.config.spacingX = cfg.spacingX;
    this.config.spacingY = cfg.spacingY;
    this.config.driftSpeed = cfg.driftSpeed;
    this.config.startX = cfg.startX;
    this.config.startY = cfg.startY;
    this.config.startXMin = cfg.startXMin;
    this.config.startXMax = cfg.startXMax;
    this.config.startYMin = cfg.startYMin;
    this.config.startYMax = cfg.startYMax;
    this.config.createEntity = (scene, x, y, offset) =>
      createEnemyFromConfig(
        scene,
        cfg,
        x,
        y,
        offset,
        undefined,
        // Documented divergence (AH-0MVM8GXEF009883O): direct slider value,
        // never the campaign level curve.
        gymDirectForceFieldHits(cfg),
      );

    // A manual respawn is a clean slate for the player's shots too; the
    // shared respawn seam deliberately keeps them for the wipe→countdown path.
    for (const pb of this.playerBullets) pb.destroy();
    this.playerBullets = [];

    // Shared formation-respawn seam (gap 9) — the same code the
    // wipe→countdown path runs, so the two can never drift apart.
    this.respawnFormation();

    // The active config's display name may differ from the construction-time
    // status label after Save As; keep the HUD accurate.
    this.statusText?.setText(
      `SCORE: n/a — ${cfg.displayName.toLowerCase()}: ${this.entities.length}`,
    );
  }

  private _onTogglePlayer(): void {
    const btn = this.panel?.querySelector<HTMLButtonElement>(`#${ENEMY_TOGGLE_PLAYER_ID}`);
    // Shared player-enable seam (gap 9): the base owns the destroy/respawn
    // and spawn-coordinate bookkeeping — no casts into base internals.
    this._playerEnabled = this.setPlayerEnabled(!this._playerEnabled);
    if (btn) {
      btn.dataset['enabled'] = this._playerEnabled ? 'true' : 'false';
      btn.textContent = this._playerEnabled ? 'Player: ON' : 'Player: OFF';
    }
  }

  // ── Save flows ─────────────────────────────────────────────────

  private _setStatus(text: string): void {
    const el = this.panel?.querySelector<HTMLElement>(`#${ENEMY_SAVE_STATUS_ID}`);
    if (el) el.textContent = text;
  }

  /** Persist via the CSV store, then report success/failure in the panel. */
  private async _persist(config: EnemyConfig, successMessage: string): Promise<void> {
    this._setStatus('Saving…');
    try {
      const result = await saveEnemyConfig(config);
      if (result.ok) {
        // Re-read so the in-memory active config reflects the persisted row.
        this.activeConfig = loadEnemyConfig(config.key);
        this._setStatus(successMessage);
      } else {
        this._setStatus(`Save failed — ${result.reason ?? 'writes unavailable'}`);
      }
    } catch (err) {
      this._setStatus(`Save failed: ${String(err)}`);
    }
  }

  private _onSave(): void {
    try {
      const config = this._readPanelValues();
      config.key = this.pendingKey;
      this.activeConfig = config;
      void this._persist(config, 'Saved');
    } catch (err) {
      this._setStatus(`Save failed: ${String(err)}`);
    }
  }

  private _onSaveAs(): void {
    const input = this.panel?.querySelector<HTMLInputElement>(`#${ENEMY_SAVE_AS_INPUT_ID}`);
    const raw = (input?.value ?? '').trim();
    if (!raw) {
      this._setStatus('Name must not be empty');
      return;
    }
    const key = sanitizeEnemyKey(raw);
    if (!isValidEnemyKey(key)) {
      this._setStatus('Invalid name — use letters, numbers and hyphens (max 40 chars)');
      return;
    }
    if (listEnemyConfigKeys().includes(key)) {
      this._setStatus(`An enemy named "${key}" already exists`);
      return;
    }
    try {
      const config = this._readPanelValues();
      config.key = key;
      config.displayName = raw;
      this.pendingKey = key;
      this.activeConfig = config;
      if (input) input.value = '';
      void this._persist(config, `Saved as ${key}`);
    } catch (err) {
      this._setStatus(`Save failed: ${String(err)}`);
    }
  }

  // ── Public accessors ────────────────────────────────────────────

  get formationEnemies(): EnemyEntity[] {
    return this.formationEntities;
  }

  get activeEnemyKey(): string {
    return this.pendingKey;
  }

  /**
   * The shared `CentipedeChain` backing the scene when the Centipede
   * archetype is active (the same chain the game and `GymCentipede` run).
   */
  get centipedeChain(): CentipedeChain | undefined {
    return getCentipedeChain(this);
  }

  get currentConfig(): EnemyConfig {
    return { ...this.activeConfig };
  }

  get isPlayerEnabled(): boolean {
    return this._playerEnabled;
  }
}
