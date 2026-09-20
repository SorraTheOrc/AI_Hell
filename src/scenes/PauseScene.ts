/**
 * Pause menu scene (GDD §5.1 — in-game pause menu, parent
 * AH-0MU9LPZ0G0015292).
 *
 * Shown full-screen while `PlayScene` is paused. Offers **Resume**,
 * **Settings** and **Quit**; all three are pointer- and keyboard-operable.
 * Keyboard navigation is deliberately scene-local (a minimal focus list
 * with Tab/arrow cycling and Enter/Space activation) — the reusable
 * `FocusManager` is deferred to the Keyboard-only-control item
 * (AH-0MU9LKQEP008LCX9), per the producer's scope decision.
 *
 * Lifecycle: `PlayScene` pauses itself at the SceneManager level and
 * launches this scene, so gameplay state is preserved exactly. Resume
 * (button or ESC) un-pauses and resumes `PlayScene`; Quit stops the run
 * and returns to `MenuScene`; Settings starts `SettingsScene` (when it is
 * registered) and returns here on Back.
 *
 * Styling follows the neon-cyan / dark palette (GDD §7.1).
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { loadSettings, resolveBindings } from '../core/settingsStore';
import type { PlayScene } from './PlayScene';

/** Neon-cyan colour for menu text (GDD §7.1 art direction). */
const PAUSE_TEXT_COLOR = '#00ffff';
/** Colour applied to the currently focused control. */
const PAUSE_FOCUS_COLOR = '#ffffff';
/** Secondary/dim colour for unfocused controls. */
const PAUSE_DIM_COLOR = '#8899aa';
/** Opaque background — a full-screen replacement, not a translucent overlay. */
const PAUSE_BACKGROUND = 0x000000;

interface PauseControl {
  /** Display label (also used to locate the control in tests). */
  label: string;
  /** The rendered text object. */
  text: Phaser.GameObjects.Text;
  /** Action invoked when the control is activated. */
  activate: () => void;
}

export class PauseScene extends Phaser.Scene {
  private controls: PauseControl[] = [];
  private focusedIndex = 0;

  /** Configured DOM key names for pause / up / down (from the bindings). */
  private pauseKeyName = 'Escape';
  private upKeyName = 'w';
  private downKeyName = 's';

  constructor() {
    super('PauseScene');
  }

  create(): void {
    // Menu navigation honours the configured bindings (parent
    // AH-0MU9LPZ0G0015292): the pause key resumes, the move up/down keys
    // cycle focus — alongside the built-in arrow/Tab defaults.
    const bindings = resolveBindings(loadSettings().bindings);
    this.pauseKeyName = bindings.pauseToggle;
    this.upKeyName = bindings.moveUp;
    this.downKeyName = bindings.moveDown;
    // Full-screen opaque background — a replacement screen, not an overlay.
    this.add.rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, PAUSE_BACKGROUND).setOrigin(0);

    this.add
      .text(GAME_WIDTH / 2, 140, 'PAUSED', {
        fontFamily: 'monospace',
        fontSize: '40px',
        color: PAUSE_TEXT_COLOR,
      })
      .setOrigin(0.5);

    this.controls = [];
    this._addControl('▶  Resume', 280, () => this.resumeGame());
    this._addControl('⚙  Settings', 350, () => this.openSettings());
    this._addControl('✕  Quit', 420, () => this.quitToMenu());
    this._setFocus(0);

    this._bindKeyboard();
  }

  // ── Controls ────────────────────────────────────────────────────

  /** Builds one neon text button and adds it to the focus list. */
  private _addControl(
    label: string,
    y: number,
    activate: () => void,
  ): Phaser.GameObjects.Text {
    const text = this.add
      .text(GAME_WIDTH / 2, y, label, {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: PAUSE_DIM_COLOR,
        backgroundColor: '#111111',
        padding: { x: 16, y: 8 },
      })
      .setOrigin(0.5);
    text.setInteractive({ useHandCursor: true });
    text.on('pointerover', () => this._setFocusByLabel(label));
    text.on('pointerdown', () => activate());

    this.controls.push({ label, text, activate });
    return text;
  }

  /** Applies the focused visual style to the control at `index`. */
  private _setFocus(index: number): void {
    const count = this.controls.length;
    if (count === 0) return;
    this.focusedIndex = ((index % count) + count) % count;
    this.controls.forEach((control, i) => {
      control.text.setStyle({
        color: i === this.focusedIndex ? PAUSE_FOCUS_COLOR : PAUSE_DIM_COLOR,
      });
    });
  }

  /** Moves the focus by `delta` with wrap-around. */
  private _moveFocus(delta: number): void {
    this._setFocus(this.focusedIndex + delta);
  }

  private _setFocusByLabel(label: string): void {
    const index = this.controls.findIndex((c) => c.label === label);
    if (index >= 0) this._setFocus(index);
  }

  /** Wires the scene-local keyboard navigation and ESC-to-resume. */
  private _bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === this.pauseKeyName) {
        this.resumeGame();
        return;
      }
      if (
        event.key === 'Tab' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowRight' ||
        event.key === this.downKeyName
      ) {
        event.preventDefault?.();
        this._moveFocus(1);
      } else if (
        event.key === 'ArrowUp' ||
        event.key === 'ArrowLeft' ||
        event.key === this.upKeyName
      ) {
        event.preventDefault?.();
        this._moveFocus(-1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault?.();
        this.activateFocused();
      }
    });
  }

  // ── Actions ─────────────────────────────────────────────────────

  /** Activates the currently focused control (keyboard Enter/Space). */
  activateFocused(): void {
    this.controls[this.focusedIndex]?.activate();
  }

  /** Number of focusable controls. */
  getControlCount(): number {
    return this.controls.length;
  }

  /** Display label of the currently focused control ('' when none). */
  getFocusedLabel(): string {
    return this.controls[this.focusedIndex]?.label ?? '';
  }

  /** All control labels in focus order. */
  getControlLabels(): string[] {
    return this.controls.map((c) => c.label);
  }

  /** The rendered control text for `label`, or null. */
  getControl(label: string): Phaser.GameObjects.Text | null {
    return this.controls.find((c) => c.label === label)?.text ?? null;
  }

  /**
   * Resumes the paused `PlayScene` from exactly where it was paused and
   * closes this scene. Safe no-op for the scene-level resume when no
   * `PlayScene` is running (direct unit tests).
   */
  resumeGame(): void {
    const play = this.scene.manager.getScene('PlayScene');
    if (play) {
      (play as PlayScene).setPaused(false);
      if (this.scene.isPaused('PlayScene')) this.scene.resume('PlayScene');
    }
    this.scene.stop();
  }

  /**
   * Navigates to the settings screen when one is registered. Guarded so
   * the PauseScene child stays decoupled from the (later) SettingsScene
   * child; when absent the button is a no-op.
   */
  openSettings(): void {
    if (!this.scene.manager.getScene('SettingsScene')) return;
    this.scene.start('SettingsScene', { origin: 'PauseScene' });
  }

  /** Stops the run and returns to the main menu. */
  quitToMenu(): void {
    const play = this.scene.manager.getScene('PlayScene');
    if (play) this.scene.stop('PlayScene');
    this.scene.start('MenuScene');
  }
}