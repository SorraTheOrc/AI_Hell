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
 * ### Optional grid (column-aware) navigation
 *
 * A scene may opt in to a two-dimensional navigation model by passing
 * `{ navigation: 'grid', columns }` to {@link FocusManager.attachKeyboard}
 * (AH-0MV1BKZ0J00946EX). `columns` is an ordered list of columns, each an
 * ordered list of registered control indices (left-to-right by column,
 * top-to-bottom by row). With grid navigation enabled:
 *   - **ArrowLeft / ArrowRight** move to the adjacent column, wrapping at the
 *     outer columns. Entering a shorter column clamps to its last valid row
 *     (there is no per-column row memory).
 *   - **ArrowUp / ArrowDown** move within the current column, wrapping top ↔
 *     bottom, and never change column.
 *   - **Tab / Shift+Tab** keep their linear reading-order cycling.
 *   - **Enter / Space** activation is unchanged.
 *   - **Shared rows.** A control listed in **more than one** column (the hex
 *     map folds its `◀ HANGAR` row into every column so arrows always reach
 *     it) resolves to the column the player last navigated in, so a vertical
 *     move from that row stays in the same column instead of jumping to the
 *     leftmost one (AH-0MWEWYVD7008PPQT).
 * The default remains the linear model above, so every other consumer
 * (`MenuScene`, `GameOverScene`, `PauseScene`, `HelpScene`,
 * `LeaderboardScene`, `TelemetryConsentScene` and the Hangar War screens) is
 * untouched.
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
 * Options for {@link FocusManager.attachKeyboard}.
 */
export interface KeyboardNavigationOptions {
  /**
   * Navigation model: `'linear'` (default) or `'grid'` (column-aware arrows).
   */
  navigation?: 'linear' | 'grid';
  /**
   * Ordered columns of registered control indices used by grid navigation.
   * Each column lists its controls top-to-bottom; columns are ordered
   * left-to-right. Ignored in linear mode.
   */
  columns?: ReadonlyArray<ReadonlyArray<number>>;
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

  /** Active navigation model (linear by default). */
  private _navigation: 'linear' | 'grid' = 'linear';

  /** Ordered grid columns of control indices (empty in linear mode). */
  private _columns: number[][] = [];

  /**
   * Column the grid focus last belonged to, used to disambiguate a control
   * listed in several columns (a row folded into every column). `null` until a
   * focus move resolves one; the first matching column is used then.
   */
  private _gridColumn: number | null = null;

  /** Optional listener invoked after every focus change (the hex-map detail panel). */
  private _focusListener: (() => void) | null = null;

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
      this._notifyFocusChange();
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
      this._notifyFocusChange();
    } else if (this._focusedIndex === index) {
      this._focusedIndex = Math.min(index, this.controls.length - 1);
      this._repaintFocus();
    } else if (this._focusedIndex > index) {
      this._focusedIndex--;
      this._notifyFocusChange();
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
   * Registers a listener invoked after every focus change (the hex-map detail
   * panel subscribes so it re-renders the focused hex). Pass `null` to stop
   * listening.
   *
   * @param listener — the callback, or `null` to detach.
   */
  setFocusChangeListener(listener: (() => void) | null): void {
    this._focusListener = listener;
  }

  /**
   * Moves focus to the control at the given index (with wrap-around).
   */
  setFocusedIndex(index: number): void {
    if (this.controls.length === 0) {
      this._focusedIndex = -1;
      this._notifyFocusChange();
      return;
    }
    this._focusedIndex =
      ((index % this.controls.length) + this.controls.length) %
      this.controls.length;
    this._rememberGridColumn(this._focusedIndex);
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
   * Pass `{ navigation: 'grid', columns }` to opt in to column-aware arrow
   * navigation; the default (`'linear'`) keeps the historical behaviour.
   *
   * @param scene — the Phaser.Scene that owns these controls.
   * @param options — optional navigation model and grid columns.
   */
  attachKeyboard(
    scene: Phaser.Scene,
    options: KeyboardNavigationOptions = {},
  ): void {
    this._navigation = options.navigation ?? 'linear';
    this._columns = (options.columns ?? []).map((column) => [...column]);
    this._gridColumn = null;
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
    this._navigation = 'linear';
    this._columns = [];
    this._gridColumn = null;

    this.controls = [];
    this._focusedIndex = -1;
  }

  // ─── private helpers ────────────────────────────────────────────

  /** Handles one keydown event and returns whether it was consumed. */
  private _handleKey(event: KeyboardEvent): boolean {
    if (this.controls.length === 0) return false;

    if (this._isGridActive()) {
      if (event.key === 'Tab') {
        this.cycleFocus(event.shiftKey ? -1 : 1);
        return true;
      }
      if (event.key === 'ArrowRight') {
        this._moveGridHorizontally(1);
        return true;
      }
      if (event.key === 'ArrowLeft') {
        this._moveGridHorizontally(-1);
        return true;
      }
      if (event.key === 'ArrowDown') {
        this._moveGridVertically(1);
        return true;
      }
      if (event.key === 'ArrowUp') {
        this._moveGridVertically(-1);
        return true;
      }
    } else {
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
    }

    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      this.activateFocused();
      return true;
    }
    return false;
  }

  /** Whether grid navigation is configured and usable. */
  private _isGridActive(): boolean {
    return this._navigation === 'grid' && this._columns.length > 0;
  }

  /**
   * Locates the focused control inside the grid.
   *
   * A control can be listed in several columns (a row folded into every column,
   * such as the hex map's `◀ HANGAR` row). It resolves to the column the player
   * last navigated in, falling back to the leftmost column that lists it.
   *
   * @returns the column and row indices, or `null` when the focused control is
   *   not part of any configured column.
   */
  private _findGridPosition(index: number): { col: number; row: number } | null {
    let first: { col: number; row: number } | null = null;
    for (let col = 0; col < this._columns.length; col++) {
      const row = this._columns[col].indexOf(index);
      if (row < 0) continue;
      if (col === this._gridColumn) return { col, row };
      first ??= { col, row };
    }
    return first;
  }

  /**
   * Remembers the column a newly focused control belongs to.
   *
   * A control in exactly one column pins the current column; a control listed in
   * several columns (a folded-in row) keeps the remembered column so navigation
   * stays where the player is, and a control outside the grid leaves it alone.
   */
  private _rememberGridColumn(index: number): void {
    if (!this._isGridActive()) return;
    const position = this._findGridPosition(index);
    if (position === null) return;
    const shared = this._columns.filter((rows) => rows.includes(index)).length;
    if (shared === 1) this._gridColumn = position.col;
  }

  /**
   * Moves focus to the adjacent column (wrapping), clamping the row to the
   * target column's last valid row. Skips empty columns.
   */
  private _moveGridHorizontally(delta: 1 | -1): boolean {
    const position = this._findGridPosition(this._focusedIndex);
    if (!position) return false;

    const columnCount = this._columns.length;
    for (let step = 1; step <= columnCount; step++) {
      const targetCol =
        ((position.col + delta * step) % columnCount + columnCount) %
        columnCount;
      const targetRows = this._columns[targetCol];
      if (targetRows.length === 0) continue;
      const targetRow = Math.min(position.row, targetRows.length - 1);
      this.setFocusedIndex(targetRows[targetRow]);
      this._gridColumn = targetCol;
      return true;
    }
    return false;
  }

  /**
   * Moves focus to the adjacent row within the current column (wrapping).
   * Never changes column.
   */
  private _moveGridVertically(delta: 1 | -1): boolean {
    const position = this._findGridPosition(this._focusedIndex);
    if (!position) return false;

    const rows = this._columns[position.col];
    if (rows.length === 0) return false;
    const targetRow =
      ((position.row + delta) % rows.length + rows.length) % rows.length;
    this.setFocusedIndex(rows[targetRow]);
    this._gridColumn = position.col;
    return true;
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
    this._notifyFocusChange();
  }

  /** Fires the focus-change listener, if one is registered. */
  private _notifyFocusChange(): void {
    this._focusListener?.();
  }
}
