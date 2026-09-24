/**
 * Reusable in-canvas focus manager for Phaser scenes (AH-0MU9LKQEP008LCX9-C1).
 *
 * Provides a conventional keyboard-navigation model on a single Phaser
 * canvas where native browser Tab-focus does not apply:
 *
 * - Controls are registered with {@link FocusManager.register}, which accepts
 *   a Phaser GameObject and an action callback.
 * - The first registered control is focused by default; it receives a visible
 *   {@link FocusManager.getFocusStyle} highlight (bright colour + stroke).
 * - {@link FocusManager.attachKeyboard} wires the scene's keyboard input so:
 *   - **Tab** cycles focus forward through registered controls (wrap-around).
 *   - **Shift+Tab** cycles focus backward (wrap-around).
 *   - **ArrowDown / ArrowRight** cycle forward (same as Tab).
 *   - **ArrowUp / ArrowLeft** cycle backward (same as Shift+Tab).
 *   - **Enter / Space** activates the focused control (focus stays put, so
 *     repeated Enter does not silently move the selection).
 * - {@link FocusManager.shutdown} removes the keyboard listener and clears
 *   the registry.
 * - {@link FocusManager.handleKey} processes a keydown event directly;
 *   scenes with extra text input (e.g. an initials field) can route text
 *   keys themselves and delegate focus keys to the manager instead of
 *   using {@link FocusManager.attachKeyboard}.
 *
 * ## Usage pattern
 *
 * ```ts
 * class MyScene extends Phaser.Scene {
 *   private fm = new FocusManager();
 *
 *   create() {
 *     const btn1 = this.add.text(400, 200, 'Play', …).setInteractive();
 *     const btn2 = this.add.text(400, 260, 'Settings', …).setInteractive();
 *
 *     this.fm.register(btn1, () => this.startGame());
 *     this.fm.register(btn2, () => this.openSettings());
 *     this.fm.attachKeyboard(this);
 *     this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.fm.shutdown());
 *   }
 * }
 * ```
 */

import Phaser from 'phaser';

/** Default focus highlight: bright cyan text with a white border. */
const DEFAULT_FOCUS_COLOR = '#88ffff';
const DEFAULT_FOCUS_STROKE = '#ffffff';
const DEFAULT_FOCUS_STROKE_WIDTH = 3;

/** Default unfocused style: dimmer cyan, no border. */
const DEFAULT_UNFOCUS_COLOR = '#00ffff';

/**
 * One focusable control in the manager.
 */
interface FocusControl {
  /** The Phaser GameObject rendered on-screen. */
  gameObject: Phaser.GameObjects.Text;
  /** Action invoked when the control is activated via Enter/Space. */
  activate: () => void;
}

/**
 * In-canvas focus manager for keyboard navigation in Phaser scenes.
 *
 * Tracks focusable controls, cycles focus on Tab/arrow keys, activates on
 * Enter/Space, renders a visible focus style, and cleans up on shutdown.
 */
export class FocusManager {
  /** Registered controls in focus order. */
  private controls: FocusControl[] = [];

  /** Index of the currently focused control (−1 when none / after shutdown). */
  private _focusedIndex = -1;

  /** The keyboard event handler reference (for listener removal). */
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

  /** The scene the keyboard listener was attached to (for removal). */
  private _scene: Phaser.Scene | null = null;

  /** Style applied to the focused control. */
  private focusStyle: Record<string, unknown>;

  /** Style applied to unfocused controls. */
  private unfocusStyle: Record<string, unknown>;

  /**
   * @param focusStyleOverride — optional override for the focus highlight
   *   (default: bright cyan text + white 3px stroke).
   * @param unfocusStyleOverride — optional override for the unfocused style
   *   (default: dimmer cyan text, no stroke).
   */
  constructor(
    focusStyleOverride?: Record<string, unknown>,
    unfocusStyleOverride?: Record<string, unknown>,
  ) {
    this.focusStyle = {
      color: DEFAULT_FOCUS_COLOR,
      stroke: DEFAULT_FOCUS_STROKE,
      // Phaser Text uses `strokeThickness` (not `strokeWidth`).
      strokeThickness: DEFAULT_FOCUS_STROKE_WIDTH,
      ...focusStyleOverride,
    };
    this.unfocusStyle = {
      color: DEFAULT_UNFOCUS_COLOR,
      // Explicitly clear the focus border: Phaser's Text.setStyle merges
      // with the existing style, so omitting these would leave the focused
      // control's stroke visible on the previously-focused control.
      stroke: '',
      strokeThickness: 0,
      ...unfocusStyleOverride,
    };
  }

  /**
   * Registers a focusable control with this manager.
   *
   * The first control registered becomes focused immediately (default focus,
   * AC2). Subsequent registrations receive the unfocused style and do not
   * change focus.
   *
   * @param gameObject — the Phaser GameObject to make focusable (typically a
   *   `Text` object created with `scene.add.text`).
   * @param action — callback invoked when the control is activated via
   *   Enter or Space.
   * @returns the index in the focus order.
   */
  register(
    gameObject: Phaser.GameObjects.Text,
    action: () => void,
  ): number {
    const index = this.controls.length;
    this.controls.push({ gameObject, activate: action });

    if (index === 0) {
      // First control — focus by default (AC2).
      this._focusedIndex = 0;
      this._applyFocusStyle(0);
    } else {
      // Subsequent controls — unfocused style.
      this._applyUnfocusStyle(index);
    }
    return index;
  }

  /**
   * Removes a registered control from the manager.
   *
   * If the removed control was focused, focus moves to the next control
   * (or the last when the removed control was final). Returns the removed
   * index, or −1 when the control was not registered.
   *
   * @param gameObject — the previously registered GameObject.
   */
  unregister(gameObject: Phaser.GameObjects.Text): number {
    const index = this.controls.findIndex((c) => c.gameObject === gameObject);
    if (index < 0) return -1;

    this.controls.splice(index, 1);

    if (this.controls.length === 0) {
      this._focusedIndex = -1;
    } else if (this._focusedIndex === index) {
      this._focusedIndex = Math.min(index, this.controls.length - 1);
      this._repaintFocus();
    } else if (this._focusedIndex > index) {
      this._focusedIndex--;
    }
    return index;
  }

  /**
   * Returns the number of registered controls.
   */
  getControlCount(): number {
    return this.controls.length;
  }

  /**
   * Returns the index of the currently focused control, or −1 when none.
   */
  getFocusedIndex(): number {
    return this._focusedIndex;
  }

  /**
   * Moves focus to the control at the given index (with wrap-around).
   */
  setFocusedIndex(index: number): void {
    if (this.controls.length === 0) {
      this._focusedIndex = -1;
      return;
    }
    this._focusedIndex =
      ((index % this.controls.length) + this.controls.length) %
      this.controls.length;
    this._repaintFocus();
  }

  /**
   * Cycles focus by `delta` (positive = forward, negative = backward)
   * with wrap-around.
   *
   * @param delta — number of steps to move (1 for Tab, −1 for Shift+Tab).
   */
  cycleFocus(delta: number): void {
    this.setFocusedIndex(this._focusedIndex + delta);
  }

  /**
   * Activates the currently focused control by invoking its action callback.
   *
   * Focus stays on the activated control — navigation is driven by Tab and
   * the arrow keys, so activation does not surprise the player by moving
   * focus (conventional menu behaviour).
   */
  activateFocused(): void {
    if (
      this._focusedIndex < 0 ||
      this._focusedIndex >= this.controls.length
    ) {
      return;
    }
    this.controls[this._focusedIndex].activate();
  }

  /**
   * The focus highlight style to apply to the currently focused control.
   */
  getFocusStyle(): Record<string, unknown> {
    return this.focusStyle;
  }

  /**
   * The unfocused style to apply to non-focused controls.
   */
  getUnfocusStyle(): Record<string, unknown> {
    return this.unfocusStyle;
  }

  /**
   * Wires the scene's keyboard input to this focus manager.
   *
   * Handles Tab, Shift+Tab, arrow keys, Enter, and Space. Call once from the
   * scene's `create()` method and let {@link shutdown} tear it down.
   *
   * @param scene — the Phaser.Scene that owns these controls.
   */
  attachKeyboard(scene: Phaser.Scene): void {
    this._scene = scene;
    this._keyHandler = (event: KeyboardEvent) => {
      this.handleKey(event);
    };
    scene.input.keyboard?.on('keydown', this._keyHandler);
  }

  /**
   * Processes one keydown event and returns whether it was consumed.
   *
   * Tab / Shift+Tab / arrow keys cycle focus (wrap-around); Enter / Space
   * activate the focused control. Scenes with additional text-input
   * handling (for example an initials field) can call this directly instead
   * of {@link attachKeyboard}, routing text keys themselves first.
   */
  handleKey(event: KeyboardEvent): boolean {
    if (event.repeat) return false;
    const handled = this._handleKey(event);
    if (handled && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    return handled;
  }

  /**
   * Removes the keyboard listener and clears the registry.
   *
   * Call from the scene's `SHUTDOWN` event. Safe to call more than once.
   */
  shutdown(): void {
    // Detach the keyboard listener from the owning scene.
    if (this._scene && this._keyHandler) {
      this._scene.input.keyboard?.off('keydown', this._keyHandler);
    }
    this._keyHandler = null;
    this._scene = null;

    this.controls = [];
    this._focusedIndex = -1;
  }

  // ─── private helpers ────────────────────────────────────────────

  /** Handles one keydown event and returns whether it was consumed. */
  private _handleKey(event: KeyboardEvent): boolean {
    if (this.controls.length === 0) return false;

    if (
      event.key === 'Tab' ||
      event.key === 'ArrowDown' ||
      event.key === 'ArrowRight'
    ) {
      this.cycleFocus(event.shiftKey ? -1 : 1);
      return true;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      this.cycleFocus(-1);
      return true;
    }
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      this.activateFocused();
      return true;
    }
    return false;
  }

  /** Applies the focus style to the control at `index`. */
  private _applyFocusStyle(index: number): void {
    this.controls[index]?.gameObject.setStyle(this.focusStyle);
  }

  /** Applies the unfocus style to the control at `index`. */
  private _applyUnfocusStyle(index: number): void {
    this.controls[index]?.gameObject.setStyle(this.unfocusStyle);
  }

  /** Repaints focus styles across all controls (after focus index changed). */
  private _repaintFocus(): void {
    this.controls.forEach((_, i) => {
      if (i === this._focusedIndex) {
        this._applyFocusStyle(i);
      } else {
        this._applyUnfocusStyle(i);
      }
    });
  }
}
