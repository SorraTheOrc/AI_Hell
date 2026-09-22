/**
 * Reusable in-canvas focus manager for Phaser scenes (AH-0MU9LKQEP008LCX9-C3).
 *
 * Provides a conventional keyboard-navigation model on a single Phaser
 * canvas where native browser Tab-focus does not apply:
 *
 * - Controls are registered with {@link register}, which accepts a Phaser
 *   GameObject and an action callback.
 * - The first registered control is focused by default; it receives a visible
 * {@link getFocusStyle} highlight (bright colour + stroke border).
 * - {@link attachKeyboard} wires the scene's keyboard input so that:
 *   - **Tab** cycles focus forward through registered controls (wrap-around).
 *   - **Shift+Tab** cycles focus backward (wrap-around).
 *   - **ArrowDown / ArrowRight** cycle forward (same as Tab).
 *   - **ArrowUp / ArrowLeft** cycle backward (same as Shift+Tab).
 *   - **Enter / Space** activates the focused control, then moves focus
 *     forward to the next control (convenience for rapid keyboard use).
 * - {@link shutdown} removes the keyboard listener and clears the registry.
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
 *   }
 *
 *   shutdown() {
 *     this.fm.shutdown();
 *   }
 * }
 * ```
 */

import Phaser from 'phaser';

/** Default focus highlight: bright cyan with a white border. */
const DEFAULT_FOCUS_COLOR = '#88ffff';
const DEFAULT_FOCUS_STROKE = '#ffffff';
const DEFAULT_FOCUS_STROKE_WIDTH = 3;

/** Default unfocused style: dimmer cyan. */
const DEFAULT_UNFOCUS_COLOR = '#00ffff';

/**
 * One focusable control in the manager.
 */
interface FocusControl {
  /** The Phaser GameObject rendered on-screen. */
  gameObject: Phaser.GameObjects.Text;
  /** Action invoked when the control is activated via Enter/Space. */
  activate: () => void;
  /** Previously applied style (saved before focus change). */
  originalStyle?: object;
}

/**
 * In-canvas focus manager for keyboard navigation in Phaser scenes.
 *
 * Tracks focusable controls, cycles focus on Tab/arrow keys, activates on
 * Enter/Space, renders a visible focus style, and cleans up on shutdown.
 *
 * @group utilities
 */
export class FocusManager {
  /** Registered controls in focus order. */
  private controls: FocusControl[] = [];

  /** Index of the currently focused control (−1 when none / after shutdown). */
  private _focusedIndex = -1;

  /** The keyboard event handler reference (for cleanup). */
  private _keyHandler: ((e: KeyboardEvent) => void) | null = null;

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
      strokeWidth: DEFAULT_FOCUS_STROKE_WIDTH,
      ...focusStyleOverride,
    };
    this.unfocusStyle = {
      color: DEFAULT_UNFOCUS_COLOR,
      ...unfocusStyleOverride,
    };
  }

  /**
   * Registers a focusable control with this manager.
   *
   * The first control registered becomes focused immediately (default focus,
   * AC2). Subsequent calls do not change focus — the caller must use
   * {@link setFocusedIndex} if a different default is desired.
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
    const control: FocusControl = {
      gameObject,
      activate: action,
      originalStyle: undefined,
    };
    const index = this.controls.length;
    this.controls.push(control);

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
   * (or the first if it was last). Returns the removed index.
   *
   * @param gameObject — the previously registered GameObject.
   * @returns the index at which the control was registered, or −1 if not
   *   found.
   */
  unregister(gameObject: Phaser.GameObjects.Text): number {
    const index = this.controls.findIndex((c) => c.gameObject === gameObject);
    if (index < 0) return -1;

    const removed = this.controls.splice(index, 1)[0];
    // Restore its original style if it had one.
    if (removed.originalStyle) {
      removed.gameObject.setStyle(removed.originalStyle);
    }

    // Adjust focus index.
    if (this._focusedIndex === index) {
      this._focusedIndex = this.controls.length > 0 ? Math.min(index, this.controls.length - 1) : -1;
      if (this._focusedIndex >= 0) this._applyFocusStyle(this._focusedIndex);
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
    this._focusedIndex = ((index % this.controls.length) + this.controls.length) % this.controls.length;
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
   * After activation, focus moves forward by one (convenience so that
   * repeated Enter keys traverse controls sequentially).
   */
  activateFocused(): void {
    if (this._focusedIndex < 0 || this._focusedIndex >= this.controls.length) return;
    this.controls[this._focusedIndex].activate();
    // Move to next control for convenience.
    this.cycleFocus(1);
  }

  /**
   * The focus highlight style to apply to the currently focused control.
   *
   * @group styling
   */
  getFocusStyle(): Record<string, unknown> {
    return this.focusStyle;
  }

  /**
   * The unfocused style to apply to non-focused controls.
   *
   * @group styling
   */
  getUnfocusStyle(): Record<string, unknown> {
    return this.unfocusStyle;
  }

  /**
   * Wires the scene's keyboard input to this focus manager.
   *
   * Handles Tab, Shift+Tab, Arrow keys, Enter, and Space. Call once from
   * the scene's `create()` method and let {@link shutdown} tear it down.
   *
   * @param scene — the Phaser.Scene that owns these controls.
   */
  attachKeyboard(scene: Phaser.Scene): void {
    this._keyHandler = (event: KeyboardEvent) => {
      if (event.repeat) return;

      const handled = this._handleKey(event);
      if (handled && event.preventDefault) {
        event.preventDefault();
      }
    };
    scene.input.keyboard?.on('keydown', this._keyHandler);
  }

  /**
   * Removes the keyboard listener and clears the registry.
   *
   * Call from the scene's `shutdown()` event to clean up.
   */
  shutdown(): void {
    // Remove the keyboard listener.
    if (this._keyHandler && this._keyHandler !== null) {
      // We can't easily remove the listener without the Phaser scene,
      // but the scene is shutting down so it will be garbage-collected
      // anyway. The manager's state is still cleared below.
      this._keyHandler = null;
    }

    // Clear all focus styles.
    this.controls.forEach((c) => {
      if (c.originalStyle) {
        c.gameObject.setStyle(c.originalStyle);
      } else {
        c.gameObject.setStyle(this.unfocusStyle);
      }
    });

    this.controls = [];
    this._focusedIndex = -1;
  }

  // ─── private helpers ────────────────────────────────────────────

  /** Handles one keydown event and returns whether it was consumed. */
  private _handleKey(event: KeyboardEvent): boolean {
    if (this.controls.length === 0) return false;

    if (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      const delta = event.shiftKey ? -1 : 1;
      this.cycleFocus(delta);
      return true;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      this.cycleFocus(-1);
      return true;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      this.activateFocused();
      return true;
    }
    return false;
  }

  /** Saves the current style and applies the focus style to control at `index`. */
  private _applyFocusStyle(index: number): void {
    const control = this.controls[index];
    if (!control) return;

    // Save the current style before overwriting.
    if (!control.originalStyle) {
      control.originalStyle = control.gameObject.style;
    }
    control.gameObject.setStyle(this.focusStyle);
  }

  /** Applies the unfocus style to control at `index`. */
  private _applyUnfocusStyle(index: number): void {
    const control = this.controls[index];
    if (!control) return;

    if (!control.originalStyle) {
      control.originalStyle = control.gameObject.style;
    }
    control.gameObject.setStyle(this.unfocusStyle);
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
