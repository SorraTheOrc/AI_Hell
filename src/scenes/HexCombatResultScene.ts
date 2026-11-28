/**
 * Hex combat results dialog overlay
 * (AH-0MWMGPTNF004EX3T, child of AH-0MWMFGXD6005WTMN).
 *
 * The post-battle **results dialog** presented over the paused hex map once a
 * deployment ends. It is a body-only overlay: the launcher hands it the rows
 * it must draw, and it draws exactly those rows. It derives no reward, score,
 * weakness or rule of its own — the single source of the dialog text is the
 * pure `buildSortieResultView` builder
 * (`src/core/hangarWar/sortieResult.ts`). The scene therefore imports neither
 * the capture cycle, the authored hex definitions nor the hangar store, so a
 * shipped rule can never be re-implemented (or drift) here.
 *
 * ## The shipped overlay contract
 *
 * It mirrors the map's existing overlays (`MineralChoiceScene`,
 * `MiniBossWheelScene`): the launcher pauses itself at the `SceneManager`
 * level and launches this scene, so map/go gameplay state is preserved
 * exactly. Launch data is `{ title, rows, onDismiss, autoConfirmMs }` (plus an
 * optional `origin` label), where:
 *
 * - `title` / `rows` are rendered verbatim — a heading plus one labelled line
 *   per row, in the order handed over;
 * - `onDismiss` is the single optional callback; it fires **exactly once**
 *   when the dialog is confirmed. With it omitted the dialog simply closes
 *   (isolated tests);
 * - `autoConfirmMs > 0` auto-confirms after that delay — the attract/demo
 *   traversal must never stall on the dialog. Normal play omits it and waits
 *   for the player.
 *
 * One confirm input dismisses it: `Enter`, `Space` or a pointer press (either
 * on the `▶ Continue` row or anywhere on the overlay). The dismissal is
 * idempotent, so a repeat key, a second click or the demo timer racing the
 * player can never fire `onDismiss` twice.
 *
 * ## Two launch shapes, one scene
 *
 * The map (AH-0MWMGPV420013MGB) hands over the builder's whole view
 * (`{ view, onDismiss, autoDismissMs }`, pinned by the test-first contract
 * AH-0MWMGPPIR009DOKR), while the item that introduces this scene describes
 * the flattening (`{ origin, title, rows, onDismiss, autoConfirmMs }`). Both
 * are accepted: `view` contributes its `title` and ordered `rows`, explicit
 * `title`/`rows` win over it, and `autoDismissMs` is the map handoff's alias
 * for `autoConfirmMs`. There is exactly one rendering rule either way.
 *
 * @module src/scenes/HexCombatResultScene
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';

/** Scene key used by every launcher. */
export const HEX_COMBAT_RESULT_SCENE_KEY = 'HexCombatResultScene';

/** Heading copy used when neither `title` nor `view.title` is supplied. */
export const HEX_COMBAT_RESULT_DEFAULT_TITLE = 'Sortie results';

/**
 * The single confirm affordance's copy. The row is the pointer target as well
 * as the on-screen instruction ("one confirm to dismiss").
 */
export const HEX_COMBAT_RESULT_CONFIRM_COPY = '▶ Continue';

/** Semi-opaque backdrop: the paused map stays visible behind the dialog. */
const RESULT_BACKDROP_ALPHA = 0.92;
/** Heading copy/position/colour. */
const RESULT_HEADING_Y = 64;
const RESULT_HEADING_COLOR = '#ffdd44';
const RESULT_HEADING_FONT_SIZE = '24px';
/** Rows start below the heading, one labelled line each. */
const RESULT_FIRST_ROW_TOP = 132;
const RESULT_ROW_COLOR = '#00ffff';
const RESULT_ROW_FONT_SIZE = '18px';
/**
 * Fallback row line height (px) when a headless harness cannot measure canvas
 * font metrics (`text.height` collapses to 0 there). A real browser uses the
 * measured height, so the fallback only keeps the layout — and its tests —
 * deterministic.
 */
const RESULT_ROW_LINE_HEIGHT = 24;
/** Vertical gap (px) between consecutive rows. */
const RESULT_ROW_GAP = 4;
/** Keep a wrapped row inside the 960 px playfield (40 px margin each side). */
const RESULT_ROW_WRAP_WIDTH = GAME_WIDTH - 80;
/** Confirm row position/colour. */
const RESULT_CONFIRM_Y = GAME_HEIGHT - 44;
const RESULT_CONFIRM_COLOR = '#ffdd44';
const RESULT_CONFIRM_FONT_SIZE = '20px';

/** One row of the pure builder's view (structurally `SortieResultRow`). */
export interface HexCombatResultRowLike {
  /** The whole rendered line. */
  readonly text: string;
}

/**
 * The pure builder's view, structurally (`SortieResultView`). The dialog
 * accepts it whole so the map can hand over the builder's output untouched;
 * the scene stores no reference to the builder itself.
 */
export interface HexCombatResultViewLike {
  /** The dialog title (defaults to {@link HEX_COMBAT_RESULT_DEFAULT_TITLE}). */
  readonly title?: string;
  /** The ordered rows to draw (strings or `{ text }` rows). */
  readonly rows?: readonly (string | HexCombatResultRowLike)[];
}

/** Launcher-supplied payload. */
export interface HexCombatResultSceneData {
  /**
   * Debug/observability label naming the launcher (e.g. `hex-map`). Purely
   * reported by {@link HexCombatResultScene.getOrigin}; never rendered.
   */
  readonly origin?: string;
  /** The heading line. Defaults to `view.title`, then the fixed title. */
  readonly title?: string;
  /** The ordered rows to render verbatim. Defaults to `view.rows`. */
  readonly rows?: readonly (string | HexCombatResultRowLike)[];
  /**
   * The single optional dismissal contract. Called exactly once when the
   * dialog is confirmed; the launcher resumes the paused map there. Omitted
   * by isolated tests, in which case the dialog simply closes.
   */
  readonly onDismiss?: () => void;
  /**
   * Demo/attract mode: auto-confirm after this many milliseconds so the
   * traversal cannot stall. `0`/absent waits for the player.
   */
  readonly autoConfirmMs?: number;
  /** The pure builder's whole view (what the map hands over). */
  readonly view?: HexCombatResultViewLike | null;
  /** Alias of {@link autoConfirmMs} used by the map handoff. */
  readonly autoDismissMs?: number;
}

/** One rendered row, exposed for tests (copy, never the live object). */
export interface HexCombatResultRowLayout {
  readonly index: number;
  readonly text: string;
  readonly top: number;
  readonly bottom: number;
}

/** Renders one row value (a string or a builder `{ text }` row) as its line. */
function toRowText(row: string | HexCombatResultRowLike): string {
  if (typeof row === 'string') return row;
  if (row !== null && typeof row === 'object' && typeof row.text === 'string') {
    return row.text;
  }
  return '';
}

/** The first positive, finite delay among the supplied candidates. */
function resolveDelay(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return 0;
}

export class HexCombatResultScene extends Phaser.Scene {
  /** The heading line currently drawn. */
  private title = HEX_COMBAT_RESULT_DEFAULT_TITLE;
  /** The rows rendered, in draw order (verbatim copies). */
  private rows: string[] = [];
  /** Rendered row geometry, for tests. */
  private rowLayouts: HexCombatResultRowLayout[] = [];
  /** The launcher label, or null when none was supplied. */
  private origin: string | null = null;
  /** The single optional dismissal contract. */
  private onDismiss: (() => void) | null = null;
  /** Demo auto-confirm delay (ms); 0 waits for the player. */
  private autoConfirmMs = 0;
  /** Pending demo auto-confirm timer (null when disabled or already fired). */
  private autoConfirmTimer: Phaser.Time.TimerEvent | null = null;
  /** True once a confirm has been accepted (dismissal is single-shot). */
  private dismissed = false;
  /** How many times `onDismiss` has been invoked (0 or 1). */
  private dismissCallCount = 0;
  /** The bound keydown listener (removed on dismissal/shutdown). */
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  /** The bound scene-level pointer listener (removed on dismissal/shutdown). */
  private pointerdownHandler: (() => void) | null = null;
  /** The `▶ Continue` row (the explicit pointer target). */
  private confirmRow: Phaser.GameObjects.Text | null = null;
  /** Every text object this scene created, so teardown is total. */
  private textObjects: Phaser.GameObjects.Text[] = [];

  constructor() {
    super(HEX_COMBAT_RESULT_SCENE_KEY);
  }

  /**
   * @param data.title — the heading line.
   * @param data.rows — the ordered rows to render verbatim.
   * @param data.onDismiss — the single dismissal contract, called once. When
   *   omitted the dialog simply closes.
   * @param data.autoConfirmMs — when > 0 auto-confirm after this delay (the
   *   attract/demo traversal); normal play omits it and waits for the player.
   * @param data.origin — an optional launcher label, reported by
   *   {@link getOrigin}.
   * @param data.view — the pure builder's whole view; its `title`/`rows` are
   *   used when the flattened fields are absent.
   * @param data.autoDismissMs — alias of `autoConfirmMs` (map handoff).
   */
  init(data: HexCombatResultSceneData = {}): void {
    const view = data.view ?? null;
    const title = data.title ?? view?.title;
    this.title =
      typeof title === 'string' && title.trim().length > 0
        ? title
        : HEX_COMBAT_RESULT_DEFAULT_TITLE;

    const suppliedRows = data.rows ?? view?.rows ?? [];
    this.rows = Array.isArray(suppliedRows)
      ? suppliedRows
          .map((row) => toRowText(row))
          // An empty row is not drawn at all — never an empty label.
          .filter((text) => text.length > 0)
      : [];

    this.origin =
      typeof data.origin === 'string' && data.origin.length > 0
        ? data.origin
        : null;
    this.onDismiss = data.onDismiss ?? null;
    this.autoConfirmMs = resolveDelay(data.autoConfirmMs, data.autoDismissMs);
    this.autoConfirmTimer = null;
    this.dismissed = false;
    this.dismissCallCount = 0;
    this.keydownHandler = null;
    this.pointerdownHandler = null;
    this.confirmRow = null;
    this.textObjects = [];
    this.rowLayouts = [];
  }

  create(): void {
    // Cover the whole screen above the paused launcher, exactly like the
    // shipped reward overlays (GDD §4.5).
    this.scene.bringToTop();
    this.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, RESULT_BACKDROP_ALPHA)
      .setOrigin(0);

    this._addText(GAME_WIDTH / 2, RESULT_HEADING_Y, this.title, {
      fontFamily: 'monospace',
      fontSize: RESULT_HEADING_FONT_SIZE,
      color: RESULT_HEADING_COLOR,
    }).setOrigin(0.5, 0);

    let cursorTop = RESULT_FIRST_ROW_TOP;
    this.rows.forEach((text, index) => {
      const row = this._addText(GAME_WIDTH / 2, cursorTop, text, {
        fontFamily: 'monospace',
        fontSize: RESULT_ROW_FONT_SIZE,
        color: RESULT_ROW_COLOR,
        align: 'center',
        wordWrap: { width: RESULT_ROW_WRAP_WIDTH, useAdvancedWrap: true },
      }).setOrigin(0.5, 0);
      const bottom =
        cursorTop + Math.max(row.height, RESULT_ROW_LINE_HEIGHT);
      this.rowLayouts.push({ index, text, top: cursorTop, bottom });
      cursorTop = bottom + RESULT_ROW_GAP;
    });

    // The single confirm affordance. It is the pointer target *and* the
    // on-screen instruction; clicking anywhere on the overlay confirms too.
    const confirmRow = this._addText(
      GAME_WIDTH / 2,
      RESULT_CONFIRM_Y,
      HEX_COMBAT_RESULT_CONFIRM_COPY,
      {
        fontFamily: 'monospace',
        fontSize: RESULT_CONFIRM_FONT_SIZE,
        color: RESULT_CONFIRM_COLOR,
      },
    )
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    confirmRow.on('pointerdown', () => this.confirm());
    this.confirmRow = confirmRow;

    const pointerdownHandler = () => this.confirm();
    this.pointerdownHandler = pointerdownHandler;
    this.input.on('pointerdown', pointerdownHandler);

    // One confirm input: Enter or Space. Any other key is ignored, so the
    // dialog cannot be dismissed by a stray press.
    const keydownHandler = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') this.confirm();
    };
    this.keydownHandler = keydownHandler;
    this.input.keyboard?.on('keydown', keydownHandler);

    // Demo/attract mode: auto-confirm so the traversal cannot stall on the
    // dialog. Normal play leaves the delay at 0 and waits for the player.
    if (this.autoConfirmMs > 0) {
      this.autoConfirmTimer = this.time.delayedCall(this.autoConfirmMs, () =>
        this.confirm(),
      );
    }

    // Defensive teardown so no listener or timer can outlive the overlay
    // however it is closed.
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this._teardown());
  }

  /**
   * Accepts the one confirm input: stops the demo timer, removes the input
   * listeners, invokes the single `onDismiss` contract (if any) and closes
   * the overlay. Idempotent — a repeat key, a second pointer press or the demo
   * timer racing the player can never fire the callback twice.
   *
   * @returns true when this call dismissed the dialog, false for a repeat.
   */
  confirm(): boolean {
    if (this.dismissed) return false;
    this.dismissed = true;
    this._teardown();
    this.dismissCallCount += 1;
    const handler = this.onDismiss;
    this.onDismiss = null;
    handler?.();
    this.scene.stop();
    return true;
  }

  // ── Public, test-observable surface ────────────────────────────────

  /** The heading line currently drawn. */
  getTitle(): string {
    return this.title;
  }

  /** The rows rendered, in draw order (verbatim copies). */
  getRows(): string[] {
    return [...this.rows];
  }

  /** The rendered row geometry, one entry per row, in draw order. */
  getRowLayouts(): HexCombatResultRowLayout[] {
    return this.rowLayouts.map((row) => ({ ...row }));
  }

  /** The launcher label, or null when none was supplied. */
  getOrigin(): string | null {
    return this.origin;
  }

  /** The rendered confirm row copy (e.g. `▶ Continue`), or null before `create`. */
  getConfirmText(): string | null {
    return this.confirmRow?.text ?? null;
  }

  /** True once a confirm has been accepted. */
  isConfirmed(): boolean {
    return this.dismissed;
  }

  /** How many times the dismissal callback has fired (0 or 1). */
  getDismissCallCount(): number {
    return this.dismissCallCount;
  }

  // ── Internals ─────────────────────────────────────────────────────

  /** Adds and tracks a text object so teardown destroys every one of them. */
  private _addText(
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text {
    const object = this.add.text(x, y, text, style);
    this.textObjects.push(object);
    return object;
  }

  /** Removes the input listeners and cancels the demo timer (safe twice). */
  private _teardown(): void {
    this.autoConfirmTimer?.remove(false);
    this.autoConfirmTimer = null;
    if (this.pointerdownHandler !== null) {
      this.input.off('pointerdown', this.pointerdownHandler);
      this.pointerdownHandler = null;
    }
    if (this.keydownHandler !== null) {
      this.input.keyboard?.off('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }
}
