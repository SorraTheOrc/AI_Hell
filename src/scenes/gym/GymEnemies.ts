/**
 * Single reusable enemy gym scene (AH-0MTHG5B83007W4W4 + editor panel AH-0MTHG5BIB006PP0P).
 *
 * Parameterized by an `EnemyConfig` key via `init({ enemyKey })`. Resolves
 * the active config through `loadEnemyConfig(enemyKey)` — so an empty or
 * corrupt storage entry falls back to seed defaults without throwing — and
 * derives every formation property + entity/shot behaviour from the config
 * and its registries (`FORMATION_BUILDERS`, `createEnemyFromConfig`).
 *
 * Editor panel (plain-DOM, mirrors `GymPlayer`): sliders/selects/colour
 * inputs for movement/shot/visuals/formationKind plus Save / Save As…
 * buttons. Live-applies to in-memory config and to spawned entities where
 * sensible; Save overwrites the active key, Save As sanitizes + validates
 * and creates a new entry. Removed on scene SHUTDOWN to avoid DOM leakage.
 */

import Phaser from 'phaser';

import {
  loadEnemyConfig,
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

export const GYM_ENEMIES_DEFAULT_KEY = 'scout';

/**
 * Enemy-config key of the boss archetype. The boss is deliberately excluded
 * from the gym wave-timeout — the operator asked for a timeout on every
 * enemy gym *except* the boss (AH-0MUNR5LM1004B223).
 */
export const GYM_ENEMIES_BOSS_KEY = 'boss';

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
export const ENEMY_RESPAWN_ID = 'enemy-gym-respawn';
export const ENEMY_TOGGLE_PLAYER_ID = 'enemy-gym-toggle-player';
/** Live 0–100 archetype difficulty readout (AH-0MTZWZ7MC002B01K, AC5). */
export const ENEMY_DIFFICULTY_ID = 'enemy-gym-difficulty';

// Numeric slider ranges (mirrors GymPlayer SLIDER_RANGES pattern).
const ENEMY_SLIDER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  count: { min: 1, max: 200, step: 1 },
  spacingX: { min: 10, max: 120, step: 1 },
  spacingY: { min: 10, max: 100, step: 1 },
  driftSpeed: { min: 0, max: 200, step: 1 },
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

const FORMATION_KINDS = ['v', 'diver', 'rect', 'swarm', 'orbital', 'single'] as const;
const SHOT_PATTERNS = ['none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated'] as const;

// ── Colour helpers (mirrors GymPlayer) ───────────────────────────

function colorToHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}
function hexToColor(value: string): number {
  return parseInt(value.replace('#', ''), 16);
}

type GymEnemiesBullet = FormationSceneBullet;

function enemyConfigToFormationConfig(enemyKey: string): EnemyFormationConfig<EnemyEntity, GymEnemiesBullet> {
  const cfg: EnemyConfig = loadEnemyConfig(enemyKey ?? GYM_ENEMIES_DEFAULT_KEY);
  const key = cfg.key || enemyKey || GYM_ENEMIES_DEFAULT_KEY;
  const builder = getFormationBuilder(cfg.formationKind);

  // Shared archetype→tryFire dispatch (AH-0MUII3BBW000XZ46): a new
  // archetype is wired once, in `src/entities/enemyFire.ts`.
  const collectBullets = (entity: EnemyEntity, now: number): GymEnemiesBullet[] =>
    fireForEnemy<GymEnemiesBullet>(entity, key, now);

  return {
    sceneKey: 'GymEnemies',
    buildOffsets: builder,
    count: cfg.count,
    spacingX: cfg.spacingX,
    spacingY: cfg.spacingY,
    driftSpeed: cfg.driftSpeed,
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
    timeoutDuration: key === GYM_ENEMIES_BOSS_KEY ? undefined : WAVE_TIME_LIMIT_SECONDS,
    // Opt-in power-up layer: one drop at a time on the rules interval,
    // weighted-random ID (P3–P9 plus weapon drops) and
    // enemy/player-avoiding placement.
    powerUps: {},
    createEntity: (scene: Phaser.Scene, x: number, y: number, offset: FormationOffset) =>
      createEnemyFromConfig(scene, cfg, x, y, offset),
    collectBullets,
    // Asteroid split seam (GDD §4.1 — E6 Asteroid): a destroyed large/medium
    // rock spawns exactly two smaller children that join the live formation
    // list, so the EXPLODE button and player bullets both cascade splits and
    // the wipe→respawn cycle only fires once the whole chain is cleared.
    // Uses the shared helper the shipped game also consumes (gap 8).
    onEntityDestroyed: (entity: EnemyEntity): void => {
      if (!(entity instanceof Asteroid)) return;
      const scene = entity.scene as
        | GymFormationScene<EnemyEntity, GymEnemiesBullet>
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

export class GymEnemies extends GymFormationScene<EnemyEntity, GymEnemiesBullet> {
  private pendingKey: string = GYM_ENEMIES_DEFAULT_KEY;
  private activeConfig: EnemyConfig = loadEnemyConfig(GYM_ENEMIES_DEFAULT_KEY);
  private panel: HTMLDivElement | null = null;
  private _playerEnabled = true;

  constructor() {
    super(enemyConfigToFormationConfig(GYM_ENEMIES_DEFAULT_KEY));
  }

  init(data?: { enemyKey?: string }): void {
    const key = data?.enemyKey ?? GYM_ENEMIES_DEFAULT_KEY;
    this.pendingKey = key;
    this.activeConfig = loadEnemyConfig(key);
    const next = enemyConfigToFormationConfig(key);
    this.config = next;
    this._resolveFormationBase();
  }

  override create(): void {
    super.create();
    this._buildPanel();
    this._applyPanelValues(this.activeConfig);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.panel?.remove();
      this.panel = null;
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

    // Numeric sliders.
    for (const [field, range] of Object.entries(ENEMY_SLIDER_RANGES)) {
      panel.appendChild(this._sliderRow(field, range));
    }

    // Colour inputs.
    for (const field of VISUAL_COLOR_FIELDS) {
      panel.appendChild(this._colorRow(field));
    }

    // Formation / shot enums as selects.
    panel.appendChild(this._selectRow('formationKind', [...FORMATION_KINDS]));
    panel.appendChild(this._selectRow('shotPattern', [...SHOT_PATTERNS]));

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
    panel.appendChild(utilRow);

    // Live spawn-interval control (power-up cadence, live-tunable).
    const spawnControl = buildSpawnIntervalSlider((seconds) => {
      this.setPowerUpSpawnInterval(seconds);
      applyAndPersistSpawnInterval(seconds);
    });
    panel.appendChild(spawnControl.row);

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
    panel.appendChild(actions);

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
    for (const field of ['formationKind', 'shotPattern'] as const) {
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
    for (const field of ['formationKind', 'shotPattern'] as const) {
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
    }
  }

  // ── Respawn / Player toggle ─────────────────────────────────────

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
      createEnemyFromConfig(scene, cfg, x, y, offset);

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

  get currentConfig(): EnemyConfig {
    return { ...this.activeConfig };
  }

  get isPlayerEnabled(): boolean {
    return this._playerEnabled;
  }
}
