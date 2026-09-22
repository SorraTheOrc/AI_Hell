/**
 * Pause menu scene (GDD §5.1 — in-game pause menu, parent
 * AH-0MU9LPZ0G0015292).
 *
 * Shown full-screen while `PlayScene` is paused. Offers **Resume**,
 * **Settings** and **Quit**; all three are pointer- and keyboard-operable.
 * Keyboard navigation uses the shared in-canvas `FocusManager`
 * (AH-0MU9LKQEP008LCX9): **Resume** is focused by default, Tab / Shift+Tab
 * and the arrow keys cycle focus with wrap-around, and Enter / Space
 * activate the focused control. The configured pause key (default ESC)
 * resumes, and the configured move up/down keys additionally cycle focus
 * alongside the built-in arrow defaults.
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
import { FocusManager } from '../utils/focusManager';
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

  /** Shared in-canvas focus manager (AH-0MU9LKQEP008LCX9-C1). */
  private focusManager = new FocusManager(
    { color: PAUSE_FOCUS_COLOR, stroke: '#ffffff', strokeThickness: 3 },
    { color: PAUSE_DIM_COLOR },
  );

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
    this.focusManager = new FocusManager(
      { color: PAUSE_FOCUS_COLOR, stroke: '#ffffff', strokeThickness: 3 },
      { color: PAUSE_DIM_COLOR },
    );
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

    this._bindKeyboard();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.focusManager.shutdown();
    });
  }

  // ── Controls ────────────────────────────────────────────────────

  /** Builds one neon text button and registers it with the focus manager. */
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

    const control: PauseControl = { label, text, activate };
    this.controls.push(control);
    // Registering the first control focuses it by default (AC1).
    this.focusManager.register(text, () => control.activate());
    return text;
  }

  /** Moves focus to the control with the given label (hover). */
  private _setFocusByLabel(label: string): void {
    const index = this.controls.findIndex((c) => c.label === label);
    if (index >= 0) this.focusManager.setFocusedIndex(index);
  }

  /**
   * Wires keyboard navigation. The shared focus manager owns Tab / arrows /
   * Enter / Space; this scene adds the configured pause and move up/down
   * bindings on top.
   */
  private _bindKeyboard(): void {
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      this.handlePauseKey(event);
    });
  }

  /**
   * Processes one keyboard event and returns true when it was consumed.
   *
   * The configured pause key resumes; the configured move up/down keys
   * cycle focus; everything else is delegated to the shared focus manager.
   */
  handlePauseKey(event: KeyboardEvent): boolean {
    if (event.repeat) return false;
    if (event.key === this.pauseKeyName) {
      event.preventDefault?.();
      this.resumeGame();
      return true;
    }
    if (event.key === this.downKeyName) {
      event.preventDefault?.();
      this.focusManager.cycleFocus(1);
      return true;
    }
    if (event.key === this.upKeyName) {
      event.preventDefault?.();
      this.focusManager.cycleFocus(-1);
      return true;
    }
    return this.focusManager.handleKey(event);
  }

  // ── Actions ─────────────────────────────────────────────────────

  /** Activates the currently focused control (keyboard Enter/Space). */
  activateFocused(): void {
    this.focusManager.activateFocused();
  }

  /** Number of focusable controls. */
  getControlCount(): number {
    return this.focusManager.getControlCount();
  }

  /** Display label of the currently focused control ('' when none). */
  getFocusedLabel(): string {
    return this.controls[this.focusManager.getFocusedIndex()]?.label ?? '';
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
