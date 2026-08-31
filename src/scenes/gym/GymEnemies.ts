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
import type { FormationOffset } from '../../utils/formations';
import { getFormationBuilder } from '../../utils/formations';
import { PLAYER_SPAWN, GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import { createEnemyFromConfig, type EnemyEntity } from '../../entities/enemyFactory';
import type { FormationSceneBullet } from './core/GymFormationScene';
import { GymFormationScene, type EnemyFormationConfig } from './core/GymFormationScene';

export const GYM_ENEMIES_DEFAULT_KEY = 'scout';

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

// Numeric slider ranges (mirrors GymPlayer SLIDER_RANGES pattern).
const ENEMY_SLIDER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  count: { min: 1, max: 30, step: 1 },
  spacingX: { min: 10, max: 120, step: 1 },
  spacingY: { min: 10, max: 100, step: 1 },
  driftSpeed: { min: 0, max: 200, step: 1 },
  startX: { min: 0, max: GAME_WIDTH, step: 1 },
  startY: { min: 0, max: GAME_HEIGHT, step: 1 },
  size: { min: 6, max: 80, step: 1 },
  bulletSize: { min: 1, max: 12, step: 1 },
  fireInterval: { min: 100, max: 5000, step: 50 },
  bulletSpeed: { min: 40, max: 600, step: 5 },
  burstCount: { min: 1, max: 24, step: 1 },
};

const VISUAL_COLOR_FIELDS = ['color', 'bulletColor'] as const;

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

  const collectBullets = (entity: EnemyEntity, now: number): GymEnemiesBullet[] => {
    const e = entity as unknown as Record<string, unknown>;
    switch (key) {
      case 'scout': {
        const m = e['tryFireAimedBullet'] as ((now: number) => unknown) | undefined;
        const b = m?.call(entity, now) as GymEnemiesBullet | null | undefined;
        return b ? [b] : [];
      }
      case 'diver': {
        const m = e['tryFireSpreadBurst'] as ((now: number) => GymEnemiesBullet[]) | undefined;
        return m?.call(entity, now) ?? [];
      }
      case 'tank': {
        const m = e['tryFireRadialBurst'] as ((now: number) => GymEnemiesBullet[]) | undefined;
        return m?.call(entity, now) ?? [];
      }
      case 'phaser': {
        const m = e['tryFireRadialBullets'] as ((now: number) => GymEnemiesBullet[]) | undefined;
        return m?.call(entity, now) ?? [];
      }
      case 'swarm': {
        const m = e['tryFireBurstBullet'] as ((now: number) => GymEnemiesBullet | null) | undefined;
        const b = m?.call(entity, now) as GymEnemiesBullet | null | undefined;
        return b ? [b] : [];
      }
      default: {
        const m = e['tryFireAimedBullet'] as ((now: number) => unknown) | undefined;
        const b = m?.call(entity, now) as GymEnemiesBullet | null | undefined;
        return b ? [b] : [];
      }
    }
  };

  return {
    sceneKey: 'GymEnemies',
    buildOffsets: builder,
    count: cfg.count,
    spacingX: cfg.spacingX,
    spacingY: cfg.spacingY,
    driftSpeed: cfg.driftSpeed,
    startX: cfg.startX,
    startY: cfg.startY,
    statusLabel: cfg.displayName.toLowerCase(),
    hintText: `${cfg.displayName} — ${cfg.formationKind} formation (config-driven)`,
    player: { ...PLAYER_SPAWN },
    createEntity: (scene: Phaser.Scene, x: number, y: number, offset: FormationOffset) =>
      createEnemyFromConfig(scene, cfg, x, y, offset),
    collectBullets,
  };
}

export class GymEnemies extends GymFormationScene<EnemyEntity, GymEnemiesBullet> {
  private pendingKey: string = GYM_ENEMIES_DEFAULT_KEY;
  private activeConfig: EnemyConfig = loadEnemyConfig(GYM_ENEMIES_DEFAULT_KEY);
  private panel: HTMLDivElement | null = null;

  constructor() {
    super(enemyConfigToFormationConfig(GYM_ENEMIES_DEFAULT_KEY));
  }

  init(data?: { enemyKey?: string }): void {
    const key = data?.enemyKey ?? GYM_ENEMIES_DEFAULT_KEY;
    this.pendingKey = key;
    this.activeConfig = loadEnemyConfig(key);
    const next = enemyConfigToFormationConfig(key);
    this.config = next;
    this.formationBaseX = next.startX;
    this.formationBaseY = next.startY;
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
    input.addEventListener('input', () => this._onConfigInput());
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
    input.addEventListener('input', () => this._onConfigInput());
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
    select.addEventListener('change', () => this._onConfigInput());
    row.append(label, select);
    return row;
  }

  // ── Panel ↔ config sync ─────────────────────────────────────────

  private _readPanelValues(): EnemyConfig {
    const next: EnemyConfig = { ...this.activeConfig };
    for (const field of Object.keys(ENEMY_SLIDER_RANGES)) {
      const input = this.panel?.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      if (input) (next as unknown as Record<string, unknown>)[field] = Number(input.value);
    }
    for (const field of VISUAL_COLOR_FIELDS) {
      const input = this.panel?.querySelector<HTMLInputElement>(`input[data-config="${field}"]`);
      if (input) (next as unknown as Record<string, unknown>)[field] = hexToColor(input.value);
    }
    for (const field of ['formationKind', 'shotPattern'] as const) {
      const sel = this.panel?.querySelector<HTMLSelectElement>(`select[data-config="${field}"]`);
      if (sel) (next as unknown as Record<string, unknown>)[field] = sel.value;
    }
    return next;
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
  }

  private _updateValueLabels(config: EnemyConfig): void {
    for (const field of Object.keys(ENEMY_SLIDER_RANGES)) {
      const value = this.panel?.querySelector<HTMLElement>(`output[data-config-value="${field}"]`);
      if (value) value.textContent = String((config as unknown as Record<string, unknown>)[field] ?? '');
    }
  }

  /** Any control change updates in-memory config and live-applies to the scene/entities. */
  private _onConfigInput(): void {
    const next = this._readPanelValues();
    this.activeConfig = next;
    this._updateValueLabels(next);
    this._applyLive(next);
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
      if ('_fireInterval' in e) (e as Record<string, unknown>)['_fireInterval'] = config.fireInterval;
      if ('_burstCount' in e) (e as Record<string, unknown>)['_burstCount'] = config.burstCount;
    }
  }

  // ── Save flows ─────────────────────────────────────────────────

  private _setStatus(text: string): void {
    const el = this.panel?.querySelector<HTMLElement>(`#${ENEMY_SAVE_STATUS_ID}`);
    if (el) el.textContent = text;
  }

  private _onSave(): void {
    try {
      const config = this._readPanelValues();
      config.key = this.pendingKey;
      this.activeConfig = config;
      saveEnemyConfig(config);
      this._setStatus('Saved');
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
      saveEnemyConfig(config);
      this.pendingKey = key;
      this.activeConfig = config;
      this._setStatus(`Saved as ${key}`);
      if (input) input.value = '';
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
}
