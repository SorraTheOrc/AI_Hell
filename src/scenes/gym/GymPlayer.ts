/**
 * Gym scene — the bare-bones testbed for player movement and ship tuning
 * (listed as `Player` on the gym index; AC1 rename, convention `Gym<Name>`).
 *
 * Renders exactly one entity (the player ship) with thrust-based Newtonian
 * movement with tunable deceleration on release (GDD §2.2 revision). No
 * enemies, no bullets, no HUD, no power-ups — just the ship, space-style
 * movement, and a control panel for tuning the ship configuration values
 * live.
 *
 * The control panel is a plain-DOM overlay (beside the canvas) so it can
 * be asserted with document.querySelector in happy-dom tests:
 * - one slider per numeric config value (thrust, max speed, size, flame,
 *   deceleration),
 * - colour inputs for the ship/flame colours,
 * - a Save button that persists the current values via `saveShipConfig`.
 *
 * Input is polled level-triggered each frame (key.isDown) so a held key
 * applies continuous thrust, and diagonals combine when two perpendicular
 * keys are held simultaneously.
 *
 * A shared "← INDEX" back button (AC5) lets the tester return to the gym
 * index without reloading the page.
 */

import Phaser from 'phaser';

import { Player } from '../../entities/Player';
import {
  FourDirectionalInputHandler,
  AsteroidsInputHandler,
  ControlInput,
  ControlSchemeType,
} from '../../utils/movementModel';
import { WasdKeysLike } from '../../utils/input';
import { GAME_WIDTH, GAME_HEIGHT } from '../../core/constants';
import {
  loadShipConfig,
  saveShipConfig,
  ShipConfig,
  ControlScheme,
} from '../../core/config';
import { addBackToIndexButton } from '../../utils/gymNavigation';

/** Slider ranges for the numeric ship config values. */
const SLIDER_RANGES: Record<string, { min: number; max: number; step: number }> = {
  thrustAcceleration: { min: 0, max: 1200, step: 10 },
  maxSpeed: { min: 0, max: 500, step: 5 },
  shipSize: { min: 4, max: 60, step: 1 },
  thrustFlameLength: { min: 0.1, max: 2, step: 0.05 },
  frictionDeceleration: { min: 0, max: 400, step: 5 },
  asteroidsRotationSpeed: { min: 0.5, max: 10, step: 0.5 },
};

/** Scheme toggle button id. */
export const SCHEME_TOGGLE_ID = 'gym-scheme-toggle';

/** Scheme toggle text label for display. */
function schemeLabel(scheme: ControlSchemeType): string {
  return scheme === 'asteroids' ? 'Scheme: Asteroids' : 'Scheme: 4-Directional';
}

/** Colour config values (rendered with `<input type="color">`). */
const COLOR_FIELDS = ['shipColor', 'thrustFlameColor', 'thrustFlameInnerColor'];

/** Panel element ids. */
export const PANEL_ID = 'gym-config-panel';
export const SAVE_BUTTON_ID = 'gym-save-config';
export const STATUS_ID = 'gym-save-status';

/** Converts a Phaser hex colour number to a "#rrggbb" string. */
export function colorToHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

/** Converts a "#rrggbb" string to a Phaser hex colour number. */
export function hexToColor(value: string): number {
  return parseInt(value.replace('#', ''), 16);
}

export class GymPlayer extends Phaser.Scene {
  private player: Player | null = null;
  private cursors: Phaser.Types.Input.Keyboard.CursorKeys | undefined;
  private wasd: WasdKeysLike | undefined;
  private panel: HTMLDivElement | null = null;
  /** Pluggable input handlers (one per control scheme, AC5). */
  private fourDirHandler = new FourDirectionalInputHandler();
  private asteroidsHandler = new AsteroidsInputHandler();
  /** The scheme currently driving player input — kept in sync with the player. */
  private scheme: ControlSchemeType = 'fourDirectional';

  constructor() {
    super({ key: 'GymPlayer' });
  }

  create(): void {
    this.player = new Player(this, {
      x: GAME_WIDTH / 2,
      y: GAME_HEIGHT / 2,
    });

    // Shared "← INDEX" button so the tester can return to the gym index.
    addBackToIndexButton(this);
    // A Graphics built via `new` is not on the scene display list until
    // added — without this the ship is never rendered.
    this.add.existing(this.player);

    // ── Input keys ─────────────────────────────────────────────────
    // cursor keys (arrows) + WASD via a comma-separated key string,
    // per the Phaser KeyboardPlugin API.
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys(
      'W,A,S,D',
    ) as WasdKeysLike | undefined;

    this._buildPanel();

    // ── Config panel ───────────────────────────────────────────────
    // Seed the controls from the persisted config, apply it to the ship,
    // then remove the panel when the scene shuts down (e.g. tests).
    const config = loadShipConfig();
    this._applyPanelValues(config);
    this.player.setConfig(config);
    this.scheme = this.player.getScheme();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.panel?.remove();
      this.panel = null;
    });

    if (!this.cursors || !this.wasd) {
      // No keyboard input available — the ship just sits idle.
      return;
    }
  }

  // ── Control panel ────────────────────────────────────────────────

  /** Builds the plain-DOM tuning panel beside the canvas. */
  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // Control-scheme toggle (AC3 — button to switch schemes).
    const schemeRow = document.createElement('div');
    schemeRow.className = 'gym-panel-row';
    const toggle = document.createElement('button');
    toggle.id = SCHEME_TOGGLE_ID;
    toggle.type = 'button';
    toggle.dataset['scheme'] = 'fourDirectional';
    toggle.textContent = schemeLabel('fourDirectional');
    toggle.addEventListener('click', () => this._onToggleScheme());
    schemeRow.appendChild(toggle);
    panel.appendChild(schemeRow);

    // Numeric sliders.
    for (const [field, range] of Object.entries(SLIDER_RANGES)) {
      panel.appendChild(this._sliderRow(field, range));
    }

    // Colour inputs.
    for (const field of COLOR_FIELDS) {
      panel.appendChild(this._colorRow(field));
    }

    // Save button + status.
    const save = document.createElement('button');
    save.id = SAVE_BUTTON_ID;
    save.type = 'button';
    save.textContent = 'Save';
    save.addEventListener('click', () => this._onSave());

    const status = document.createElement('span');
    status.id = STATUS_ID;

    const actions = document.createElement('div');
    actions.className = 'gym-panel-actions';
    actions.append(save, status);
    panel.appendChild(actions);

    host.appendChild(panel);
    this.panel = panel;
  }

  private _sliderRow(
    field: string,
    range: { min: number; max: number; step: number },
  ): HTMLElement {
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
    input.addEventListener('input', () => this._onControlInput());

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
    input.addEventListener('input', () => this._onControlInput());

    row.append(label, input);
    return row;
  }

  /** Toggles the control scheme button and applies it live (AC3). */
  private _onToggleScheme(): void {
    const toggle = this.panel?.querySelector<HTMLButtonElement>(
      `#${SCHEME_TOGGLE_ID}`,
    );
    if (!toggle) return;
    const next: ControlSchemeType =
      toggle.dataset['scheme'] === 'asteroids'
        ? 'fourDirectional'
        : 'asteroids';
    toggle.dataset['scheme'] = next;
    toggle.textContent = schemeLabel(next);
    // Applies the merged config (with the new scheme) to the player live.
    this._onControlInput();
  }

  /** Reads all controls into a ShipConfig. */
  private _readPanelValues(): ShipConfig {
    const source = loadShipConfig();
    for (const field of Object.keys(SLIDER_RANGES)) {
      const input = this.panel?.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      if (input) (source as unknown as Record<string, unknown>)[field] = Number(input.value);
    }
    for (const field of COLOR_FIELDS) {
      const input = this.panel?.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      if (input) (source as unknown as Record<string, unknown>)[field] = hexToColor(input.value);
    }
    // The scheme toggle is the source of truth for controlScheme (AC3).
    const toggle = this.panel?.querySelector<HTMLButtonElement>(
      `#${SCHEME_TOGGLE_ID}`,
    );
    if (toggle) {
      source.controlScheme = (toggle.dataset['scheme'] ??
        'fourDirectional') as ControlScheme;
    }
    return source;
  }

  /** Sets control values (and labels) from a ShipConfig without firing events. */
  private _applyPanelValues(config: ShipConfig): void {
    if (!this.panel) return;
    for (const field of Object.keys(SLIDER_RANGES)) {
      const input = this.panel.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      const value = this.panel.querySelector<HTMLElement>(
        `output[data-config-value="${field}"]`,
      );
      if (input) input.value = String(config[field as keyof ShipConfig]);
      if (value) value.textContent = String(config[field as keyof ShipConfig]);
    }
    for (const field of COLOR_FIELDS) {
      const input = this.panel.querySelector<HTMLInputElement>(
        `input[data-config="${field}"]`,
      );
      if (input) {
        input.value = colorToHex(config[field as keyof ShipConfig] as number);
      }
    }
    // Sync the scheme toggle button with the config's control scheme.
    const toggle = this.panel.querySelector<HTMLButtonElement>(
      `#${SCHEME_TOGGLE_ID}`,
    );
    if (toggle) {
      toggle.dataset['scheme'] = config.controlScheme ?? 'fourDirectional';
      toggle.textContent = schemeLabel(config.controlScheme ?? 'fourDirectional');
    }
  }

  /** Any slider/colour change applies the merged config to the player live. */
  private _onControlInput(): void {
    if (!this.player) return;
    const config = this._readPanelValues();
    this.player.setConfig(config);
    this._updateValueLabels(config);
  }

  /** Keeps the output labels in sync with the current control values. */
  private _updateValueLabels(config: ShipConfig): void {
    for (const field of Object.keys(SLIDER_RANGES)) {
      const value = this.panel?.querySelector<HTMLElement>(
        `output[data-config-value="${field}"]`,
      );
      if (value) value.textContent = String(config[field as keyof ShipConfig]);
    }
  }

  /** Persists the current control values and shows a status message. */
  private _onSave(): void {
    const status = this.panel?.querySelector<HTMLElement>(`#${STATUS_ID}`);
    try {
      const config = this._readPanelValues();
      saveShipConfig(config);
      if (status) status.textContent = 'Saved';
    } catch (err) {
      if (status) status.textContent = `Save failed: ${String(err)}`;
    }
  }

  /**
   * Reads the current held-key state into a ControlInput for the active
   * control scheme (AC5 — pluggable input handlers).
   * Level-triggered per frame: a key that is held down returns true
   * every frame until released, so thrust accumulates continuously.
   */
  private _readInput(): ControlInput | undefined {
    const raw = { cursors: this.cursors, wasd: this.wasd };
    return this.scheme === 'asteroids'
      ? this.asteroidsHandler.mapInput(raw)
      : this.fourDirHandler.mapInput(raw);
  }

  update(_time: number, delta: number): void {
    if (!this.player) return;

    // Keep the scheme in sync with the player (scheme switches also
    // happen on setConfig from the panel / saved config).
    this.scheme = this.player.getScheme();

    const input = this._readInput();
    if (input) this.player.setInput(input);

    const dt = delta / 1000;
    const width = this.scale.width;
    const height = this.scale.height;

    this.player.physicsTick(dt, width, height);
    // Player.preUpdate() is invoked by Phaser's update list (add.existing)
    // and advances the thrust-flame animation with the same delta.
  }
}