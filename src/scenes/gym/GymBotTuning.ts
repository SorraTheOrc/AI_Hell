/**
 * Gym scene — AI bot tuning panel (AH-0MV4D7LAD009XYR0).
 *
 * A designer opens this gym to watch the attract/demo bot play **randomly
 * generated levels** while tuning the bot's decision-making parameters live
 * through a plain-DOM slider panel. It is the hands-on counterpart to the
 * headless evaluation arena (`src/ai/eval/`): the arena measures, this gym
 * lets a human feel the difference a parameter makes.
 *
 * ## What it does
 *
 * - Generates a reproducible random `LevelDefinition` from a seed
 *   ({@link generateRandomLevel}) and plays it through the shared
 *   {@link GymLevel} wave loop. When the level is cleared, a fresh random
 *   level is generated, so the bot keeps playing.
 * - Drives the player through the shared {@link CombatCoreScene.getBotInput}
 *   seam: the same `createCompetentBotBrain()` policy and
 *   `BotInputGovernor` the shipped `PlayScene` demo uses, so the gym never
 *   forks bot behaviour (gym↔game parity, AGENTS.md § Game Architecture
 *   Conventions).
 * - Exposes one slider per entry in {@link BOT_TUNING_NUMERIC_FIELDS} (plus
 *   boolean toggles) so the designer has direct control over the bot's
 *   utility bands, seek ranges, margins, prediction, steering weights,
 *   commitment hysteresis, world model and human-input cadence. Moving a
 *   slider rebuilds the live brain/governor.
 * - Supports **Save** (overwrite the current named configuration),
 *   **Save As…** (create a named configuration), and a selector to **load**
 *   any saved configuration. Configurations persist via
 *   {@link ../core/botTuningStore} (localStorage).
 *
 * ## Divergence
 *
 * The scene is a gym-only dev tool: it is reached from the gym index only and
 * never shipped in normal play. The bot's *behaviour* is the shared code; only
 * the scenario (random waves with the shared mineral/power-up/weapon supply
 * layer, no boss) and the tuning UI are gym-specific. The supply behaviour
 * itself is shared (inherited from `GymLevel`), so the bot sees and reacts to
 * minerals, power-ups and weapons exactly as it does in the game
 * (AH-0MV4D7LAD009XYR0 producer-audit fix).
 *
 * @module src/scenes/gym/GymBotTuning
 */

import { BotInputGovernor } from '../../ai/botHumanLike';
import { buildBotSnapshot, type BotSnapshot, type BotSnapshotScene } from '../../ai/botSnapshot';
import {
  createCompetentBotBrain,
  type BotBrain,
} from '../../ai/framework';
import {
  BOT_TUNING_NUMERIC_FIELDS,
  BOT_TUNING_TOGGLES,
  coerceTuningValues,
  defaultBotTuningValues,
  readTuningBoolean,
  readTuningNumber,
  toCompetentOverrides,
  toHumanOverrides,
  type BotTuningFieldSpec,
  type BotTuningToggleSpec,
  type BotTuningValues,
} from '../../ai/tuningFields';
import {
  getCurrentBotTuningConfig,
  listBotTuningNames,
  saveBotTuningAs,
  saveBotTuningCurrent,
  selectBotTuning,
} from '../../core/botTuningStore';
import { normaliseSeed, randomSeed, createSeededRng } from '../../core/rng';
import { makeCollapsible } from '../../utils/gymPanel';
import { generateRandomLevel } from '../../utils/randomLevel';
import type { ControlInput } from '../../utils/movementModel';
import type { LevelDefinition } from '../../waves/Formations';
import { GymLevel } from './GymLevel';

/** Scene key — also the class name so the gym-index glob discovers it. */
export const GYM_BOT_TUNING_SCENE_KEY = 'GymBotTuning';

/** DOM id of the tuning panel. */
export const BOT_TUNING_PANEL_ID = 'gym-bot-tuning-panel';
/** DOM id of the configuration selector. */
export const BOT_TUNING_CONFIG_SELECT_ID = 'gym-bot-tuning-config-select';
/** DOM id of the Save button. */
export const BOT_TUNING_SAVE_ID = 'gym-bot-tuning-save';
/** DOM id of the new-configuration name input. */
export const BOT_TUNING_SAVE_AS_INPUT_ID = 'gym-bot-tuning-save-as-input';
/** DOM id of the Save As… button. */
export const BOT_TUNING_SAVE_AS_ID = 'gym-bot-tuning-save-as';
/** DOM id of the "New Random Level" button. */
export const BOT_TUNING_NEW_LEVEL_ID = 'gym-bot-tuning-new-level';
/** DOM id of the "Reset to Defaults" button. */
export const BOT_TUNING_RESET_ID = 'gym-bot-tuning-reset';
/** DOM id of the status readout. */
export const BOT_TUNING_STATUS_ID = 'gym-bot-tuning-status';
/** Data attribute (value = field key) identifying a numeric slider. */
export const BOT_TUNING_SLIDER_ATTR = 'data-bot-field';
/** Data attribute (value = field key) identifying a slider's value readout. */
export const BOT_TUNING_SLIDER_VALUE_ATTR = 'data-bot-field-value';
/** Data attribute (value = toggle key) identifying a boolean checkbox. */
export const BOT_TUNING_TOGGLE_ATTR = 'data-bot-toggle';

/** Seconds the "COMPLETE" state is held before a fresh random level starts. */
export const BOT_TUNING_RESTART_DELAY_SECONDS = 1.2;

/** Synthetic life counts for the bot's Extra-Life preference (gym has no lives). */
export const BOT_TUNING_LIVES = 3;
/** Synthetic life cap for the bot's Extra-Life preference. */
export const BOT_TUNING_LIVES_CAP = 5;

/** Launch parameters accepted by {@link GymBotTuning}. */
export interface GymBotTuningData {
  /** Seed for the initial random level (defaults to a fresh random seed). */
  seed?: number;
  /** Optional pre-built level (bypasses the generator; used by tests). */
  level?: LevelDefinition;
}

/**
 * Returns an inactive wave state (the tuning gym has no timed waves). Extracted
 * so the snapshot adapter stays declarative and testable.
 */
export function inactiveWaveState(): { active: boolean; timeRemaining: number; timeLimit: number } {
  return { active: false, timeRemaining: 0, timeLimit: 0 };
}

export class GymBotTuning extends GymLevel {
  /** Seed of the current random level (also the bot's RNG seed). */
  private seed = 0;
  /** Live tuning values (panel state). */
  private tuningValues: BotTuningValues = defaultBotTuningValues();
  /** The live competent-bot policy, rebuilt when tuning changes. */
  private botBrain: BotBrain = createCompetentBotBrain();
  /** The live human-like governor, rebuilt when tuning changes. */
  private botGovernor = new BotInputGovernor();
  /** The plain-DOM tuning panel. */
  private tuningPanel: HTMLElement | null = null;
  /** Seconds spent in the level-complete state (drives the auto-restart). */
  private completionDwell = 0;

  constructor() {
    super(GYM_BOT_TUNING_SCENE_KEY);
  }

  // ── Initialisation ───────────────────────────────────────────────

  /**
   * Seeds the random level and loads the current persisted tuning before the
   * base scene starts its wave loop.
   */
  override init(data?: GymBotTuningData): void {
    this.seed = normaliseSeed(data?.seed ?? randomSeed());
    // Seed the inherited supply layer (minerals + drop placement) from the
    // same seed, so a seed reproduces the mineral field and drop sequence too.
    this.supplyRng = createSeededRng(this.seed);
    this.tuningValues = coerceTuningValues(getCurrentBotTuningConfig().values);
    this.completionDwell = 0;
    const level = data?.level ?? generateRandomLevel({ seed: this.seed });
    super.init({ level });
  }

  override create(): void {
    super.create();
    // Apply the persisted/overridden tuning to the fresh brain + governor.
    this._applyTuning();
    this._buildPanel();
  }

  // ── Bot wiring ───────────────────────────────────────────────────

  /** Shared demo seam: the bot's committed input wins over the keyboard. */
  protected override getBotInput(): ControlInput | null {
    return this.botGovernor.current();
  }

  /** Rebuilds the brain and governor from the current panel values. */
  private _applyTuning(): void {
    this.botBrain = createCompetentBotBrain({
      tunables: toCompetentOverrides(this.tuningValues),
    });
    this.botGovernor = new BotInputGovernor(
      toHumanOverrides(this.tuningValues),
      this.seed,
    );
  }

  /** Samples the pure decision and commits it through the human-like governor. */
  private _advanceBot(dt: number): void {
    const player = this.getPlayer();
    if (!player) return;
    const movement = player.getMovementState();
    const rotation = player.getRotationConfig();
    this.botGovernor.update(
      this.botBrain.decide(this._buildSnapshot(), dt),
      dt,
      {
        scheme: player.getScheme() ?? 'asteroids',
        facing: movement.facing ?? 0,
        // Same inertia-aware turn config the shipped PlayScene demo supplies,
        // so the gym and the game fly the bot identically
        // (AH-0MV1DUSM2005HL98 · AC1).
        angularVelocity: movement.angularVelocity ?? 0,
        rotationSpeed: rotation.rotationSpeed,
        rotationAcceleration: rotation.rotationAcceleration,
        rotationDeceleration: rotation.rotationDeceleration,
        reverseEnabled: player.isReverseEnabled() ?? true,
      },
    );
  }

  /**
   * Builds the bot snapshot from the gym's live state. The supply layer
   * inherits from `GymLevel`, so the bot sees the live power-up/weapon drops
   * and minerals (the `collect-powerup`, `collect-mineral` and `secure-life`
   * goals). The gym has no boss and no timed waves, so those read as
   * null/inactive; the bot core handles the empty collections unchanged.
   */
  private _buildSnapshot(): BotSnapshot {
    const source: BotSnapshotScene = {
      getPlayer: () => this.getPlayer(),
      getBoss: () => null,
      getBossPhase: () => 0,
      getEnemies: () => this.getEnemies(),
      getEnemyBullets: () => this.getEnemyBullets(),
      getPlayerBullets: () => this.getPlayerBullets(),
      getDrops: () => this.getDrops(),
      getMinerals: () => this.getMinerals(),
      getAliveCount: () => this.getEnemies().filter((enemy) => enemy.alive).length,
      getWaveState: () => inactiveWaveState(),
      getRunSeed: () => this.seed,
      getLives: () => BOT_TUNING_LIVES,
      getLivesCap: () => BOT_TUNING_LIVES_CAP,
    };
    return buildBotSnapshot(source);
  }

  /**
   * Read-only snapshot of the state the bot decides from — the live supply
   * layer included. Exposed for tests to assert the bot sees drops/minerals.
   */
  getBotSnapshot(): BotSnapshot {
    return this._buildSnapshot();
  }

  // ── Tick / level cycling ─────────────────────────────────────────

  override tick(dt: number): void {
    // Advance the bot *before* the shared player step so `getBotInput()`
    // returns the input committed for this tick.
    this._advanceBot(dt);
    super.tick(dt);

    if (this.isLevelComplete()) {
      this.completionDwell += dt;
      if (this.completionDwell >= BOT_TUNING_RESTART_DELAY_SECONDS) {
        this._newRandomLevel();
      }
    } else {
      this.completionDwell = 0;
    }
  }

  /** Generates a new random level and starts it on the existing field. */
  private _newRandomLevel(): void {
    this.seed = normaliseSeed(randomSeed());
    const level = generateRandomLevel({ seed: this.seed });
    this.loadLevel(level);
    this.completionDwell = 0;
    this._updateStatus(`New random level (seed ${this.seed})`);
  }

  // ── Panel ────────────────────────────────────────────────────────

  /** Builds the plain-DOM tuning panel (bottom-left, collapsible). */
  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    const panel = document.createElement('div');
    panel.id = BOT_TUNING_PANEL_ID;
    panel.className = 'gym-panel';

    // Configuration row: load selector + Save + Save As + new level + reset.
    panel.appendChild(this._buildConfigRow());
    panel.appendChild(this._buildActionRow());

    // Numeric sliders (one per exposed tunable).
    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      panel.appendChild(this._sliderRow(field));
    }
    // Boolean toggles.
    for (const toggle of BOT_TUNING_TOGGLES) {
      panel.appendChild(this._toggleRow(toggle));
    }

    makeCollapsible({ panel, title: `Bot Tuning — seed ${this.seed}` });
    host.appendChild(panel);
    this.tuningPanel = panel;
    this._applyPanelValues(this.tuningValues);
    this._refreshConfigOptions();
  }

  /** The load/save configuration control row. */
  private _buildConfigRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gym-panel-row';

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = 'config';

    const select = document.createElement('select');
    select.id = BOT_TUNING_CONFIG_SELECT_ID;
    select.setAttribute('aria-label', 'Bot tuning configuration');
    select.addEventListener('change', () => this._onSelectConfig());

    row.append(label, select);
    return row;
  }

  /** Save / Save As… / New Random Level / Reset action row. */
  private _buildActionRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'gym-panel-row';

    const save = document.createElement('button');
    save.id = BOT_TUNING_SAVE_ID;
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => this._onSave());

    const nameInput = document.createElement('input');
    nameInput.id = BOT_TUNING_SAVE_AS_INPUT_ID;
    nameInput.type = 'text';
    nameInput.placeholder = 'New config name…';
    nameInput.setAttribute('aria-label', 'New configuration name');

    const saveAs = document.createElement('button');
    saveAs.id = BOT_TUNING_SAVE_AS_ID;
    saveAs.type = 'button';
    saveAs.textContent = 'Save As…';
    saveAs.addEventListener('click', () => this._onSaveAs());

    const newLevel = document.createElement('button');
    newLevel.id = BOT_TUNING_NEW_LEVEL_ID;
    newLevel.type = 'button';
    newLevel.textContent = 'New Random Level';
    newLevel.addEventListener('click', () => this._newRandomLevel());

    const reset = document.createElement('button');
    reset.id = BOT_TUNING_RESET_ID;
    reset.type = 'button';
    reset.textContent = 'Reset to Defaults';
    reset.addEventListener('click', () => this._onReset());

    const status = document.createElement('span');
    status.id = BOT_TUNING_STATUS_ID;

    row.append(save, nameInput, saveAs, newLevel, reset, status);
    return row;
  }

  /** One slider row for a numeric tunable. */
  private _sliderRow(field: BotTuningFieldSpec): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = `${field.group === 'human' ? 'human.' : ''}${field.label}`;

    const input = document.createElement('input');
    input.type = 'range';
    input.setAttribute(BOT_TUNING_SLIDER_ATTR, field.key);
    input.min = String(field.min);
    input.max = String(field.max);
    input.step = String(field.step);
    input.addEventListener('input', () => this._onControlInput());

    const value = document.createElement('output');
    value.setAttribute(BOT_TUNING_SLIDER_VALUE_ATTR, field.key);

    row.append(label, input, value);
    return row;
  }

  /** One checkbox row for a boolean toggle. */
  private _toggleRow(toggle: BotTuningToggleSpec): HTMLElement {
    const row = document.createElement('label');
    row.className = 'gym-panel-row';

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = `${toggle.group === 'human' ? 'human.' : ''}${toggle.label}`;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute(BOT_TUNING_TOGGLE_ATTR, toggle.key);
    input.addEventListener('change', () => this._onControlInput());

    row.append(label, input);
    return row;
  }

  /** Reads every control into a fresh {@link BotTuningValues}. */
  private _readPanelValues(): BotTuningValues {
    const values = defaultBotTuningValues();
    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      const input = this.tuningPanel?.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_SLIDER_ATTR}="${field.key}"]`,
      );
      if (input) values[field.group][field.key] = Number(input.value);
    }
    for (const toggle of BOT_TUNING_TOGGLES) {
      const input = this.tuningPanel?.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_TOGGLE_ATTR}="${toggle.key}"]`,
      );
      if (input) values[toggle.group][toggle.key] = input.checked;
    }
    return values;
  }

  /** Sets every control from `values` without firing change events. */
  private _applyPanelValues(values: BotTuningValues): void {
    if (!this.tuningPanel) return;
    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      const input = this.tuningPanel.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_SLIDER_ATTR}="${field.key}"]`,
      );
      const output = this.tuningPanel.querySelector<HTMLElement>(
        `output[${BOT_TUNING_SLIDER_VALUE_ATTR}="${field.key}"]`,
      );
      const current = readTuningNumber(values, field);
      if (input) input.value = String(current);
      if (output) output.textContent = String(current);
    }
    for (const toggle of BOT_TUNING_TOGGLES) {
      const input = this.tuningPanel.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_TOGGLE_ATTR}="${toggle.key}"]`,
      );
      if (input) input.checked = readTuningBoolean(values, toggle);
    }
  }

  /** Any slider/toggle change applies the new tuning to the live bot. */
  private _onControlInput(): void {
    this.tuningValues = this._readPanelValues();
    this._applyTuning();
    // Keep every readout in sync (clamping may differ from the raw input).
    this._applyPanelValues(this.tuningValues);
  }

  /** Repopulates the configuration selector and selects the current config. */
  private _refreshConfigOptions(): void {
    const select = this.tuningPanel?.querySelector<HTMLSelectElement>(
      `#${BOT_TUNING_CONFIG_SELECT_ID}`,
    );
    if (!select) return;
    select.replaceChildren();
    for (const name of listBotTuningNames()) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    const current = getCurrentBotTuningConfig().name;
    // `current` is always present because the store always keeps at least one.
    select.value = current;
  }

  /** Load the selected named configuration into the panel and the live bot. */
  private _onSelectConfig(): void {
    const select = this.tuningPanel?.querySelector<HTMLSelectElement>(
      `#${BOT_TUNING_CONFIG_SELECT_ID}`,
    );
    if (!select) return;
    const config = selectBotTuning(select.value);
    if (!config) {
      this._updateStatus(`No config named "${select.value}"`);
      return;
    }
    this.tuningValues = coerceTuningValues(config.values);
    this._applyPanelValues(this.tuningValues);
    this._applyTuning();
    this._updateStatus(`Loaded "${config.name}"`);
  }

  /** Save over the current configuration. */
  private _onSave(): void {
    try {
      const saved = saveBotTuningCurrent(this._readPanelValues());
      this.tuningValues = coerceTuningValues(saved.values);
      this._refreshConfigOptions();
      this._updateStatus(`Saved "${saved.name}"`);
    } catch (error) {
      this._updateStatus(`Save failed: ${String(error)}`);
    }
  }

  /** Save the current values as a new named configuration. */
  private _onSaveAs(): void {
    const input = this.tuningPanel?.querySelector<HTMLInputElement>(
      `#${BOT_TUNING_SAVE_AS_INPUT_ID}`,
    );
    if (!input) return;
    try {
      const saved = saveBotTuningAs(input.value, this._readPanelValues());
      if (!saved) {
        this._updateStatus('Enter a non-empty config name');
        return;
      }
      input.value = '';
      this.tuningValues = coerceTuningValues(saved.values);
      this._refreshConfigOptions();
      this._updateStatus(`Saved as "${saved.name}"`);
    } catch (error) {
      this._updateStatus(`Save As failed: ${String(error)}`);
    }
  }

  /** Reset the panel (in memory) to the built-in defaults. */
  private _onReset(): void {
    this.tuningValues = defaultBotTuningValues();
    this._applyPanelValues(this.tuningValues);
    this._applyTuning();
    this._updateStatus('Reset to defaults');
  }

  /** Updates the panel's status readout. */
  private _updateStatus(message: string): void {
    const status = this.tuningPanel?.querySelector<HTMLElement>(
      `#${BOT_TUNING_STATUS_ID}`,
    );
    if (status) status.textContent = message;
  }

  // ── Teardown ─────────────────────────────────────────────────────

  protected override teardownRunState(): void {
    super.teardownRunState();
    this.tuningPanel?.remove();
    this.tuningPanel = null;
  }
}
