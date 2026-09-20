/**
 * Settings screen (GDD §6.6 `ai_hell_settings`, parent AH-0MU9LPZ0G0015292).
 *
 * Two sections:
 * - **Audio** — a labelled 0.0–1.0 SFX volume slider plus an SFX mute
 *   toggle. Changes apply live via the master-volume plumbing in
 *   `effects.ts` and persist to `ai_hell_settings`.
 * - **Controls** — every remappable action with its current binding, a
 *   press-a-key rebind flow, a conflict warning (permits the change but
 *   names the other action), and a "Reset to defaults" button. All
 *   changes persist to `ai_hell_settings.bindings`.
 *
 * Keyboard navigation is scene-local (same pattern as PauseScene): the
 * shared `FocusManager` is deferred to AH-0MU9LKQEP008LCX9. Up/down cycle
 * the controls, left/right adjust the slider when it is focused,
 * Enter/Space activate, ESC goes Back (or cancels a pending rebind).
 *
 * Entry points: PauseScene → origin 'PauseScene' (Back returns to the
 * pause menu); MenuScene → origin 'MenuScene' (Back returns to the menu).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import {
  ACTION_NAMES,
  DEFAULT_BINDINGS,
  DEFAULT_SETTINGS,
  findConflict,
  loadSettings,
  resolveBindings,
  saveSettings,
  type ActionName,
} from '../core/settingsStore';
import { setSfxMuted, setSfxVolume } from '../audio/effects';

/** Neon-cyan colour for the section heading (GDD §7.1). */
const SETTINGS_TEXT_COLOR = '#00ffff';
/** Colour of the focused control. */
const SETTINGS_FOCUS_COLOR = '#ffffff';
/** Colour of unfocused controls. */
const SETTINGS_DIM_COLOR = '#8899aa';
/** Amber colour for rebind-prompt / conflict-warning text. */
const SETTINGS_WARN_COLOR = '#ffaa00';
/** Slider track width (px). */
const SLIDER_WIDTH = 200;
/** Slider track height (px). */
const SLIDER_HEIGHT = 8;
/** Keyboard step for the slider (0.05 ≈ 5%). */
const SLIDER_KEY_STEP = 0.05;
/** Horizontal position of the audio column. */
const AUDIO_COL_X = 240;
/** Horizontal position of the controls column. */
const CONTROLS_COL_X = 720;
/** Vertical position of the first controls-section row. */
const CONTROLS_ROW_Y = 140;
/** Vertical spacing between controls-section rows. */
const CONTROLS_ROW_GAP = 30;

/** Human-readable names for each action (shown in the UI and warnings). */
const ACTION_DISPLAY_NAMES: Record<ActionName, string> = {
  moveUp: 'Move Up',
  moveDown: 'Move Down',
  moveLeft: 'Move Left',
  moveRight: 'Move Right',
  layerDrop: 'Layer Drop',
  pauseToggle: 'Pause',
};

/** Keys that should not be captured as a binding. */
const NON_CAPTURABLE_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'Tab',
]);

/** Scene-data shape passed by the caller (`{ origin }`). */
interface SettingsSceneData {
  origin?: string;
}

/** A focusable control with optional per-key and activation handlers. */
interface SettingsControl {
  label: string;
  onLeft?: () => void;
  onRight?: () => void;
  activate?: () => void;
}

export class SettingsScene extends Phaser.Scene {
  private origin = 'PauseScene';

  private sfxVolume = DEFAULT_SETTINGS.sfxVolume;
  private sfxMuted = DEFAULT_SETTINGS.sfxMuted;
  private bindings: Record<ActionName, string> = { ...DEFAULT_BINDINGS };

  private controls: SettingsControl[] = [];
  private focusedIndex = 0;
  /** Focusable text objects keyed by control label (for focus styling). */
  private focusStyles = new Map<string, Phaser.GameObjects.Text>();

  private sliderTrack!: Phaser.GameObjects.Rectangle;
  private sliderHandle!: Phaser.GameObjects.Rectangle;
  private volumeText!: Phaser.GameObjects.Text;
  private muteText!: Phaser.GameObjects.Text;
  private backText!: Phaser.GameObjects.Text;
  private resetText!: Phaser.GameObjects.Text;
  private conflictText!: Phaser.GameObjects.Text;
  private captureText!: Phaser.GameObjects.Text;
  private bindingRows = new Map<ActionName, Phaser.GameObjects.Text>();
  private dragging = false;
  /** Action currently awaiting a key press, or null when not capturing. */
  private capturing: ActionName | null = null;

  /** Configured DOM key names for back / up / down (from the bindings). */
  private pauseKeyName = 'Escape';
  private upKeyName = 'w';
  private downKeyName = 's';

  constructor() {
    super('SettingsScene');
  }

  create(data?: SettingsSceneData): void {
    this.origin = data?.origin ?? 'PauseScene';

    // Restore persisted values (defaults when unset) and apply them live.
    const settings = loadSettings();
    this.sfxVolume = settings.sfxVolume;
    this.sfxMuted = settings.sfxMuted;
    this.bindings = { ...settings.bindings };
    // Menu navigation honours the configured bindings (parent
    // AH-0MU9LPZ0G0015292): pause key = Back, move up/down = focus cycle.
    const configured = resolveBindings(settings.bindings);
    this.pauseKeyName = configured.pauseToggle;
    this.upKeyName = configured.moveUp;
    this.downKeyName = configured.moveDown;
    setSfxVolume(this.sfxVolume);
    setSfxMuted(this.sfxMuted);

    // Reset per-instance state (create() can run again on scene restart).
    this.focusStyles = new Map();
    this.bindingRows = new Map();
    this.capturing = null;
    this.dragging = false;

    // Full-screen background.
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000).setOrigin(0);
    this.add
      .text(GAME_WIDTH / 2, 44, 'SETTINGS', {
        fontFamily: 'monospace',
        fontSize: '32px',
        color: SETTINGS_TEXT_COLOR,
      })
      .setOrigin(0.5);

    this._buildAudioSection();
    this._buildControlsSection();
    this._buildBack();

    // Focus order: audio → each binding → reset → back.
    this.controls = [
      {
        label: 'volume',
        onLeft: () => this._nudgeVolume(-SLIDER_KEY_STEP),
        onRight: () => this._nudgeVolume(SLIDER_KEY_STEP),
      },
      { label: 'mute', activate: () => this._toggleMute() },
      ...ACTION_NAMES.map((action) => ({
        label: action,
        activate: () => this.beginCapturing(action),
      })),
      { label: 'reset', activate: () => this.resetBindings() },
      { label: 'back', activate: () => this.goBack() },
    ];

    this._drawSlider();
    this._drawMute();
    this._drawBindings();
    this._setFocus(0);

    this._bindKeyboard();
  }

  // ── Audio section ───────────────────────────────────────────────

  private _buildAudioSection(): void {
    this.add
      .text(AUDIO_COL_X, 96, 'SFX Volume', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: SETTINGS_TEXT_COLOR,
      })
      .setOrigin(0.5);

    this.volumeText = this.add
      .text(AUDIO_COL_X, 168, '0.00', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: SETTINGS_DIM_COLOR,
      })
      .setOrigin(0.5);
    this.focusStyles.set('volume', this.volumeText);

    const trackY = 140;
    this.sliderTrack = this.add.rectangle(
      AUDIO_COL_X,
      trackY,
      SLIDER_WIDTH,
      SLIDER_HEIGHT,
      0x223344,
    );
    this.sliderTrack.setInteractive({ useHandCursor: true });
    this.sliderTrack.on('pointerdown', (pointer: { x: number }) => {
      this.dragging = true;
      this._sliderFromPointer(pointer.x);
    });
    this.sliderTrack.on('pointermove', (pointer: { x: number }) => {
      if (this.dragging) this._sliderFromPointer(pointer.x);
    });
    this.input.on('pointerup', () => {
      this.dragging = false;
    });

    this.sliderHandle = this.add.rectangle(AUDIO_COL_X, trackY, 10, 22, 0x00ffff);

    this.muteText = this.add
      .text(AUDIO_COL_X, 224, '', {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: SETTINGS_DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 14, y: 6 },
      })
      .setOrigin(0.5);
    this.muteText.setInteractive({ useHandCursor: true });
    this.muteText.on('pointerdown', () => this._toggleMute());
    this.focusStyles.set('mute', this.muteText);
  }

  // ── Controls (key bindings) section ─────────────────────────────

  private _buildControlsSection(): void {
    this.add
      .text(CONTROLS_COL_X, 96, 'Controls', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: SETTINGS_TEXT_COLOR,
      })
      .setOrigin(0.5);

    ACTION_NAMES.forEach((action, i) => {
      const row = this.add
        .text(
          CONTROLS_COL_X,
          CONTROLS_ROW_Y + i * CONTROLS_ROW_GAP,
          '',
          {
            fontFamily: 'monospace',
            fontSize: '15px',
            color: SETTINGS_DIM_COLOR,
            backgroundColor: '#111111',
            padding: { x: 8, y: 3 },
          },
        )
        .setOrigin(0.5);
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => this.beginCapturing(action));
      this.bindingRows.set(action, row);
      this.focusStyles.set(action, row);
    });

    this.conflictText = this.add
      .text(GAME_WIDTH / 2, 344, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SETTINGS_WARN_COLOR,
      })
      .setOrigin(0.5)
      .setVisible(false);

    this.captureText = this.add
      .text(GAME_WIDTH / 2, 344, '', {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: SETTINGS_WARN_COLOR,
      })
      .setOrigin(0.5)
      .setVisible(false);

    this.resetText = this.add
      .text(CONTROLS_COL_X, 388, '↺  Reset to defaults', {
        fontFamily: 'monospace',
        fontSize: '16px',
        color: SETTINGS_DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 12, y: 6 },
      })
      .setOrigin(0.5);
    this.resetText.setInteractive({ useHandCursor: true });
    this.resetText.on('pointerdown', () => this.resetBindings());
    this.focusStyles.set('reset', this.resetText);
  }

  private _buildBack(): void {
    this.backText = this.add
      .text(GAME_WIDTH / 2, 480, '←  Back', {
        fontFamily: 'monospace',
        fontSize: '18px',
        color: SETTINGS_DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 14, y: 6 },
      })
      .setOrigin(0.5);
    this.backText.setInteractive({ useHandCursor: true });
    this.backText.on('pointerdown', () => this.goBack());
    this.focusStyles.set('back', this.backText);
  }

  // ── Value rendering ─────────────────────────────────────────────

  private _drawSlider(): void {
    const left = AUDIO_COL_X - SLIDER_WIDTH / 2;
    this.sliderHandle.x = left + this.sfxVolume * SLIDER_WIDTH;
    this.volumeText.text = this.sfxVolume.toFixed(2);
  }

  private _drawMute(): void {
    this.muteText.text = this.sfxMuted ? 'SFX: MUTED' : 'SFX: ON';
  }

  private _drawBindings(): void {
    for (const action of ACTION_NAMES) {
      const row = this.bindingRows.get(action);
      if (row) row.text = `${ACTION_DISPLAY_NAMES[action]} — ${this.bindings[action]}`;
    }
  }

  // ── Audio actions ───────────────────────────────────────────────

  /** Current SFX volume (0–1). */
  getSfxVolume(): number {
    return this.sfxVolume;
  }

  /** Whether SFX is muted. */
  isSfxMuted(): boolean {
    return this.sfxMuted;
  }

  /** Sets the SFX volume (clamped 0–1), applying it live and persisting. */
  setVolume(value: number): void {
    const clamped = Math.max(0, Math.min(1, value));
    this.sfxVolume = Math.round(clamped * 100) / 100;
    this._drawSlider();
    setSfxVolume(this.sfxVolume);
    this._persist();
  }

  /** Mutes/un-mutes SFX; the volume level is preserved. */
  setMuted(muted: boolean): void {
    this.sfxMuted = muted;
    this._drawMute();
    setSfxMuted(this.sfxMuted);
    this._persist();
  }

  private _nudgeVolume(delta: number): void {
    this.setVolume(this.sfxVolume + delta);
  }

  private _toggleMute(): void {
    this.setMuted(!this.sfxMuted);
  }

  private _sliderFromPointer(x: number): void {
    const left = AUDIO_COL_X - SLIDER_WIDTH / 2;
    this.setVolume((x - left) / SLIDER_WIDTH);
  }

  // ── Binding actions ─────────────────────────────────────────────

  /** Current binding for `action`. */
  getBinding(action: ActionName): string {
    return this.bindings[action];
  }

  /** A copy of the current binding map. */
  getBindings(): Record<ActionName, string> {
    return { ...this.bindings };
  }

  /** The pending-capture action, or null when not capturing. */
  isCapturing(): ActionName | null {
    return this.capturing;
  }

  /** The current conflict-warning message ('' when no warning is shown). */
  getConflictMessage(): string {
    return this.conflictText.visible ? this.conflictText.text : '';
  }

  /** Enters capture mode: the next key press rebinds `action`. */
  beginCapturing(action: ActionName): void {
    this.capturing = action;
    this.conflictText.setVisible(false);
    this.captureText
      .setText(`Press a key for ${ACTION_DISPLAY_NAMES[action]}…`)
      .setVisible(true);
    const index = this.controls.findIndex((c) => c.label === action);
    if (index >= 0) this._setFocus(index);
  }

  /**
   * Rebinds `action` to `key` (permitting the change even on a conflict),
   * persists it and shows a conflict warning when the key is already used
   * by another action. Returns the conflicting action, or null.
   */
  rebind(action: ActionName, key: string): ActionName | null {
    this.bindings = { ...this.bindings, [action]: key };
    this._drawBindings();
    this._persist();
    const conflict = findConflict(this.bindings, action, key);
    this._showConflict(conflict, key);
    return conflict;
  }

  /** Restores and persists the default bindings; clears any warning. */
  resetBindings(): void {
    this.bindings = { ...DEFAULT_BINDINGS };
    this._drawBindings();
    this._persist();
    this._showConflict(null, '');
  }

  private _showConflict(conflict: ActionName | null, key: string): void {
    if (conflict) {
      this.conflictText
        .setText(`⚠ '${key}' is also used by ${ACTION_DISPLAY_NAMES[conflict]}`)
        .setVisible(true);
    } else {
      this.conflictText.setText('').setVisible(false);
    }
  }

  /** Persists the full settings record (audio + bindings). */
  private _persist(): void {
    saveSettings({
      sfxVolume: this.sfxVolume,
      sfxMuted: this.sfxMuted,
      bindings: this.bindings,
    });
  }

  // ── Back navigation ─────────────────────────────────────────────

  /** Returns to the scene that opened the settings screen. */
  goBack(): void {
    this.scene.start(this.origin);
  }

  // ── Focus + keyboard ────────────────────────────────────────────

  private _setFocus(index: number): void {
    const count = this.controls.length;
    if (count === 0) return;
    this.focusedIndex = ((index % count) + count) % count;
    const focused = this.controls[this.focusedIndex].label;
    for (const [label, text] of this.focusStyles) {
      text.setStyle({
        color: label === focused ? SETTINGS_FOCUS_COLOR : SETTINGS_DIM_COLOR,
      });
    }
  }

  /** Moves the focus by `delta` with wrap-around. */
  private _moveFocus(delta: number): void {
    this._setFocus(this.focusedIndex + delta);
  }

  private _activateFocused(): void {
    this.controls[this.focusedIndex]?.activate?.();
  }

  private _cancelCapture(): void {
    this.capturing = null;
    this.captureText.setVisible(false);
  }

  private _handleCaptureKey(event: KeyboardEvent): void {
    const key = event.key;
    if (key === 'Escape') {
      this._cancelCapture();
      return;
    }
    if (NON_CAPTURABLE_KEYS.has(key)) return;
    const action = this.capturing!;
    this._cancelCapture();
    this.rebind(action, key);
  }

  private _bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (this.capturing) {
        this._handleCaptureKey(event);
        return;
      }
      if (event.key === this.pauseKeyName) {
        this.goBack();
        return;
      }
      if (
        event.key === 'Tab' ||
        event.key === 'ArrowDown' ||
        event.key === this.downKeyName
      ) {
        event.preventDefault?.();
        this._moveFocus(1);
      } else if (event.key === 'ArrowUp' || event.key === this.upKeyName) {
        event.preventDefault?.();
        this._moveFocus(-1);
      } else if (event.key === 'ArrowRight') {
        this.controls[this.focusedIndex]?.onRight?.();
      } else if (event.key === 'ArrowLeft') {
        this.controls[this.focusedIndex]?.onLeft?.();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault?.();
        this._activateFocused();
      }
    });
  }

  // ── Test accessors ──────────────────────────────────────────────

  /** Focusable control labels in focus order. */
  getControlLabels(): string[] {
    return this.controls.map((c) => c.label);
  }

  /** Label of the currently focused control. */
  getFocusedLabel(): string {
    return this.controls[this.focusedIndex]?.label ?? '';
  }
}