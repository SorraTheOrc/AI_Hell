/**
 * Hold-full power-up choice scene (GDD §4.5, AH-0MUBVGI62004ED9Q).
 *
 * A modal overlay shown when the ship's mineral hold fills. The owning
 * scene pauses itself at the SceneManager level and launches this scene, so
 * gameplay state is preserved exactly (mirroring `PauseScene`). It presents
 * the distinct options supplied by the launcher as pointer- and
 * keyboard-operable controls; selecting one hands the index back through the
 * single optional `onSelect` callback (the launcher applies the effect
 * permanently for the run, resumes play, and resets the hold with any
 * overflow) and closes the overlay.
 *
 * Each option renders as a three-part block: the option name, a description
 * area of up to two wrapped lines (from `ChoiceOption.description`, resolved
 * from the shared catalogues) and then the existing change summary / `★ New`
 * line, so an unfamiliar offer is self-explanatory (AH-0MV2N2591007UGPD,
 * AH-0MVBLBSG3002WHBI). The two-line description area keeps the longest
 * catalogue copy inside the 960 px playfield; copy that needs more than two
 * lines is ellipsised.
 *
 * The overlay deliberately knows nothing about its launcher (`PlayScene`,
 * `GymFormationScene`, …): the only selection contract is the `onSelect`
 * callback, so the game and every gym drive it identically.
 *
 * The strategy is pluggable (see `powerups/choice`): when a launcher omits
 * `options`, the scene draws its own defaults from the strategy, so swapping
 * the policy needs no scene change.
 *
 * @module src/scenes/MineralChoiceScene
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../core/constants';
import { HOLD_FULL_FIRE_VOLUME_SCALE, loadRules } from '../core/rules';
import { randomChoiceStrategy, type ChoiceOption, type ChoiceStrategy } from '../powerups/choice';
import {
  CHOICE_DESCRIPTION_MAX_LINES,
  wrapChoiceDescription,
} from './core/choiceDescriptionWrap';
import {
  createHoldFullFireMetronome,
  type HoldFullFireMetronome,
  type HoldFullFireSchedule,
} from './core/holdFullFire';
import {
  HOLD_FULL_COUNTDOWN_COUNTS,
  createHoldFullCountdown,
} from './core/holdFullCountdown';
import { playCountdownTickSound, playWeaponFireSound } from '../audio/effects';

/** Neon-gold heading colour (matches the mineral palette). */
const CHOICE_HEADING_COLOR = '#ffdd44';
/** Neon-cyan option colour. */
const CHOICE_OPTION_COLOR = '#00ffff';
/** Secondary / muted colour for change summaries. */
const CHOICE_DETAIL_COLOR = '#aaaaaa';
/** Muted colour for the two-line item description. */
const CHOICE_DESCRIPTION_COLOR = '#cccccc';
/** Accent colour for the "New" badge. */
const CHOICE_NEW_COLOR = '#ff8800';
/** Fully opaque backdrop, blanking the screen behind the choice dialog. */
const CHOICE_BACKDROP_ALPHA = 1.0;
/** Top (px) of the first option row's name text. */
const CHOICE_FIRST_ROW_TOP = 180;
/**
 * Wrap width (px) of the description area. Centred on the 960 px playfield it
 * leaves a 40 px margin on each side, so a wrapped line can never run off
 * screen (AH-0MVBLBSG3002WHBI · AC1/AC3).
 */
const CHOICE_DESCRIPTION_WRAP_WIDTH = GAME_WIDTH - 80;
/**
 * Expected line heights (px) used for layout when a headless harness cannot
 * measure canvas font metrics (`text.height` collapses to 0 there). In a real
 * browser the measured height is used instead, so the fallback never changes
 * rendering — it only keeps the layout (and its tests) deterministic.
 */
const CHOICE_NAME_LINE_HEIGHT = 36;
const CHOICE_DESCRIPTION_LINE_HEIGHT = 16;
const CHOICE_DETAIL_LINE_HEIGHT = 17;
/** Vertical gap (px) between the parts of one option block. */
const CHOICE_BLOCK_GAP = 6;
/** Vertical gap (px) between consecutive option blocks. */
const CHOICE_ROW_GAP = 18;
/** Neon-cyan colour of the large countdown numeral. */
const COUNTDOWN_COLOR = '#00ffff';
/** Vertical centre (px) of the large 3-2-1 countdown numeral. */
const COUNTDOWN_Y = 270;
/** Font size (px) of the large 3-2-1 countdown numeral. */
const COUNTDOWN_FONT_SIZE = '96px';

/** Rendered extent (px) of one element inside a choice row. */
export interface ChoiceRowElementBounds {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * Rendered geometry of one option row: the documented non-overlapping
 * `name → description area → detail` block (AH-0MVBLBSG3002WHBI · AC2).
 * `description` carries the number of wrapped lines actually drawn; its
 * horizontal bounds are the wrap box the copy is laid out in, so they show
 * the area reserved on screen rather than the glyph extent of one line.
 */
export interface ChoiceRowLayout {
  readonly index: number;
  readonly name: ChoiceRowElementBounds;
  readonly description:
    | (ChoiceRowElementBounds & { readonly lines: number })
    | null;
  readonly detail: ChoiceRowElementBounds | null;
  /** Vertical extent of the whole row block (name top → last line bottom). */
  readonly top: number;
  readonly bottom: number;
}

export class MineralChoiceScene extends Phaser.Scene {
  private options: ChoiceOption[] = [];
  private controls: Phaser.GameObjects.Text[] = [];
  /** Detail-line text objects (one per option). */
  private details: Phaser.GameObjects.Text[] = [];
  /** Description text objects (one per option that carries a description). */
  private descriptions: Phaser.GameObjects.Text[] = [];
  /** Catalogue copy for each description (unwrapped, see {@link getDescriptionLines}). */
  private descriptionCopy: string[] = [];
  /** Wrapped lines drawn for each description (see {@link getDescriptionRenderedLines}). */
  private renderedDescriptionLines: string[][] = [];
  /** Rendered geometry per option row (see {@link getRowLayout}). */
  private rows: ChoiceRowLayout[] = [];
  /** The full-screen backdrop rectangle (destroyed when the countdown starts). */
  private backdrop: Phaser.GameObjects.Rectangle | null = null;
  /** The "HOLD FULL — CHOOSE A POWER-UP" heading (destroyed with the choice UI). */
  private heading: Phaser.GameObjects.Text | null = null;
  /** The bound keydown listener (removed when the countdown starts). */
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  /** Optional generic selection handler supplied by the launcher. */
  private onSelect: ((index: number, option: ChoiceOption) => void) | null = null;
  /**
   * Demo-only auto-select delay (ms); 0 disables auto-select so the overlay
   * waits for a real pointer/keyboard selection (AH-0MUXXQ1MN002RXGB).
   */
  private autoSelectMs = 0;
  /** Pending demo auto-select timer (null when disabled or already fired). */
  private autoSelectTimer: Phaser.Time.TimerEvent | null = null;
  /** Demo-only option index the auto-select picks (default 0, the first). */
  private autoSelectIndex = 0;
  /**
   * Frozen player-fire schedule passed by the launcher: drives the
   * reduced-volume metronomic ghost fire while the overlay is open
   * (AH-0MV55O9R5005W6J0). Null when the launcher supplies none (isolated
   * tests) — then the overlay is silent as before.
   */
  private fireSchedule: HoldFullFireSchedule | null = null;
  /** Live metronome emitting the reduced-volume ghost ticks. */
  private metronome: HoldFullFireMetronome | null = null;
  /**
   * The pending selection (index + option) chosen by the player, held while
   * the 3-2-1 countdown plays and applied via `onSelect` when it completes
   * (AH-0MV55OAQT004NMSN · AC4). Null while awaiting a selection.
   */
  private pendingSelection: { index: number; option: ChoiceOption } | null =
    null;
  /**
   * The current 3-2-1 countdown scheduler (non-null while counting down).
   * Advances one count per beat with this scene's elapsed time; the
   * reduced-volume metronomic fire continues underneath.
   */
  private countdown: ReturnType<typeof createHoldFullCountdown> | null = null;
  /** The large on-screen countdown numeral ("3"/"2"/"1"). */
  private countdownText: Phaser.GameObjects.Text | null = null;
  /** Total overlay elapsed time (ms) — used to re-base the beat clock on resume. */
  private overlayElapsedMs = 0;

  constructor() {
    super('MineralChoiceScene');
  }

  /**
   * @param data.options — the options to present (defaults to the strategy's
   *   three picks).
   * @param data.strategy — pluggable strategy used when `options` is absent.
   * @param data.onSelect — the single selection contract every launcher
   *   supplies: receives the chosen index and option. When omitted the
   *   overlay simply closes (used by isolated tests).
   * @param data.autoSelectMs — when > 0 the overlay auto-selects an option
   *   after this delay (the shipped attract/demo mode). Normal play omits it
   *   and waits for a real selection.
   * @param data.autoSelectIndex — the option index the demo auto-select
   *   picks (default `0`, the first option). The demo launcher passes the
   *   preferred option (e.g. the offered Extra Life below the life cap);
   *   normal play never sets it (AH-0MV03GXZQ00801T4 · AC1).
   * @param data.fireSchedule — the frozen player-fire schedule captured at
   *   launch; when present the overlay plays each active weapon's fire cue
   *   on the beat grid at {@link HOLD_FULL_FIRE_VOLUME_SCALE} until a
   *   selection closes it (AH-0MV55O9R5005W6J0 · AC1/AC2).
   */
  init(
    data: {
      options?: ChoiceOption[];
      strategy?: ChoiceStrategy;
      onSelect?: (index: number, option: ChoiceOption) => void;
      autoSelectMs?: number;
      autoSelectIndex?: number;
      fireSchedule?: HoldFullFireSchedule;
    } = {},
  ): void {
    const strategy = data.strategy ?? randomChoiceStrategy;
    this.options = data.options ?? strategy.choose(3);
    this.onSelect = data.onSelect ?? null;
    this.autoSelectMs = data.autoSelectMs ?? 0;
    this.autoSelectIndex = data.autoSelectIndex ?? 0;
    this.fireSchedule = data.fireSchedule ?? null;
    this.pendingSelection = null;
    this.countdown = null;
    this.countdownText = null;
    this.overlayElapsedMs = 0;
    this.backdrop = null;
    this.heading = null;
    this.keydownHandler = null;
  }

  create(): void {
    // Bring this scene above PlayScene in the z-order so the opaque backdrop
    // covers the entire screen (GDD §4.5, AH-0MUDYSIRY0036EDC).
    this.scene.bringToTop();

    const backdrop = this.add
      .rectangle(0, 0, GAME_WIDTH, GAME_HEIGHT, 0x000000, CHOICE_BACKDROP_ALPHA)
      .setOrigin(0);

    const heading = this.add
      .text(GAME_WIDTH / 2, 120, 'HOLD FULL — CHOOSE A POWER-UP', {
        fontFamily: 'monospace',
        fontSize: '24px',
        color: CHOICE_HEADING_COLOR,
      })
      .setOrigin(0.5);

    // Keep references to the choice UI so a selection can tear it down the
    // moment the countdown starts (AH-0MV722WJS0075UTZ).
    this.backdrop = backdrop;
    this.heading = heading;

    this.controls = [];
    this.details = [];
    this.descriptions = [];
    this.descriptionCopy = [];
    this.renderedDescriptionLines = [];
    this.rows = [];
    let cursorTop = CHOICE_FIRST_ROW_TOP;
    this.options.forEach((option, index) => {
      // Primary label: "1.  Spread Shot Lv.3". Top-anchored so the block below
      // it starts exactly at its bottom edge (AC2).
      const label = this.add
        .text(GAME_WIDTH / 2, cursorTop, `${index + 1}.  ${option.name}`, {
          fontFamily: 'monospace',
          fontSize: '20px',
          color: CHOICE_OPTION_COLOR,
          backgroundColor: '#111111',
          padding: { x: 16, y: 8 },
        })
        .setOrigin(0.5, 0);
      label.setInteractive({ useHandCursor: true });
      label.on('pointerdown', () => this.select(index));
      this.controls.push(label);

      const nameHeight = Math.max(label.height, CHOICE_NAME_LINE_HEIGHT);
      const nameBounds: ChoiceRowElementBounds = {
        left: label.x - label.width / 2,
        right: label.x + label.width / 2,
        top: cursorTop,
        bottom: cursorTop + nameHeight,
      };
      cursorTop = nameBounds.bottom;

      // Description area: what the item actually does, resolved from the
      // shared catalogue, wrapped here onto at most two lines so the longest
      // copy stays inside the 960 px playfield (AH-0MVBLBSG3002WHBI · AC1).
      // Omitted entirely when an option carries no description — never an
      // empty text object.
      let descriptionBounds:
        | (ChoiceRowElementBounds & { lines: number })
        | null = null;
      const description = option.description?.trim();
      if (description) {
        const wrapped = wrapChoiceDescription(description);
        const descriptionTop = cursorTop + CHOICE_BLOCK_GAP;
        const descriptionLine = this.add
          .text(GAME_WIDTH / 2, descriptionTop, wrapped.lines.join('\n'), {
            fontFamily: 'monospace',
            fontSize: '13px',
            color: CHOICE_DESCRIPTION_COLOR,
            align: 'center',
            // Safety net only: the copy is already wrapped to the character
            // budget above, so Phaser never needs to re-wrap it (and cannot
            // grow it past two lines).
            wordWrap: {
              width: CHOICE_DESCRIPTION_WRAP_WIDTH,
              useAdvancedWrap: true,
            },
            maxLines: CHOICE_DESCRIPTION_MAX_LINES,
          })
          .setOrigin(0.5, 0);
        const descriptionHeight = Math.max(
          descriptionLine.height,
          wrapped.lines.length * CHOICE_DESCRIPTION_LINE_HEIGHT,
        );
        this.descriptions.push(descriptionLine);
        this.descriptionCopy.push(description);
        this.renderedDescriptionLines.push(wrapped.lines);
        descriptionBounds = {
          left: GAME_WIDTH / 2 - CHOICE_DESCRIPTION_WRAP_WIDTH / 2,
          right: GAME_WIDTH / 2 + CHOICE_DESCRIPTION_WRAP_WIDTH / 2,
          top: descriptionTop,
          bottom: descriptionTop + descriptionHeight,
          lines: wrapped.lines.length,
        };
        cursorTop = descriptionBounds.bottom;
      }

      // Detail line: change summary or "New" badge, beneath the description.
      let detailBounds: ChoiceRowElementBounds | null = null;
      let detailText = '';
      if (option.isNew) {
        detailText = '★ New';
      } else if (option.changeSummary) {
        detailText = option.changeSummary;
      }
      if (detailText) {
        const detailTop = cursorTop + CHOICE_BLOCK_GAP;
        const detail = this.add
          .text(GAME_WIDTH / 2, detailTop, detailText, {
            fontFamily: 'monospace',
            fontSize: '14px',
            color: option.isNew ? CHOICE_NEW_COLOR : CHOICE_DETAIL_COLOR,
          })
          .setOrigin(0.5, 0);
        const detailHeight = Math.max(
          detail.height,
          CHOICE_DETAIL_LINE_HEIGHT,
        );
        this.details.push(detail);
        detailBounds = {
          left: detail.x - detail.width / 2,
          right: detail.x + detail.width / 2,
          top: detailTop,
          bottom: detailTop + detailHeight,
        };
        cursorTop = detailBounds.bottom;
      }

      this.rows.push({
        index,
        name: nameBounds,
        description: descriptionBounds,
        detail: detailBounds,
        top: nameBounds.top,
        bottom: cursorTop,
      });
      // Start the next row below this block so a two-line description can
      // never collide with the following option (AC2).
      cursorTop += CHOICE_ROW_GAP;
    });

    // Number keys 1..n select the matching option. The handler is stored so
    // it can be removed when the countdown starts.
    const keydownHandler = (event: KeyboardEvent) => {
      const n = Number.parseInt(event.key, 10);
      if (n >= 1 && n <= this.options.length) this.select(n - 1);
    };
    this.keydownHandler = keydownHandler;
    this.input.keyboard?.on('keydown', keydownHandler);

    // Demo/attract mode: pick an option automatically after a human-like
    // delay so the run never stalls on the overlay
    // (AH-0MUXXQ1MN002RXGB · AC4). Normal play leaves `autoSelectMs` at 0 and
    // waits for a real selection (AC5). The demo launcher may nominate a
    // preferred index (e.g. an offered Extra Life); default 0 keeps the
    // previous first-option behaviour (AH-0MV03GXZQ00801T4 · AC1).
    if (this.autoSelectMs > 0) {
      this.autoSelectTimer = this.time.delayedCall(this.autoSelectMs, () =>
        this.select(this.autoSelectIndex),
      );
    }
    // Start the reduced-volume metronomic ghost fire from the frozen
    // player-fire schedule (AC1/AC2). The overlay scene keeps running while
    // the launcher is paused, so its own update loop drives the metronome.
    this.metronome = this.fireSchedule
      ? createHoldFullFireMetronome(this.fireSchedule)
      : null;
  }

  /**
   * Drives the hold-full metronome with this scene's elapsed time: every
   * frame advances the ghost-fire scheduler and plays a reduced-volume fire
   * cue for each active weapon whose beat tick was reached, then (once a
   * selection is made) advances the 3-2-1 countdown — one count per beat,
   * each with its cue and on-screen numeral — and completes the selection on
   * the beat after "1". Pure timing: no projectiles, no gameplay simulation
   * (AH-0MV55O9R5005W6J0 · AC1; AH-0MV55OAQT004NMSN · AC4).
   */
  override update(_time: number, delta: number): void {
    this.overlayElapsedMs += Math.max(0, delta);
    const metronome = this.metronome;
    if (metronome !== null) {
      for (const weaponId of metronome.advance(delta)) {
        playWeaponFireSound(weaponId, {
          volume: HOLD_FULL_FIRE_VOLUME_SCALE,
        });
      }
    }
    const countdown = this.countdown;
    if (countdown === null) return;
    for (const count of countdown.advance(delta)) {
      this.showCountdownNumeral(count);
      // The tone rises with each beat: count 3→step 0 (base), 2→step 1,
      // 1→step 2 (highest) (AH-0MV722WJS0075UTZ).
      playCountdownTickSound(HOLD_FULL_COUNTDOWN_COUNTS - count);
    }
    if (countdown.isComplete()) this.completeSelection();
  }

  /** Renders (or replaces) the large countdown numeral, e.g. "3". */
  private showCountdownNumeral(count: number): void {
    if (this.countdownText === null) {
      this.countdownText = this.add
        .text(GAME_WIDTH / 2, COUNTDOWN_Y, '', {
          fontFamily: 'monospace',
          fontSize: COUNTDOWN_FONT_SIZE,
          color: COUNTDOWN_COLOR,
        })
        .setOrigin(0.5);
    }
    this.countdownText.setText(String(count));
  }

  /**
   * Applies the pending selection when the 3-2-1 countdown completes: the
   * metronomic ghost fire stops, the single `onSelect` contract hands the
   * choice to the launcher (which applies it, resumes play and resets the
   * hold) and the overlay closes. The ghost fire continues underneath the
   * countdown (producer decision) and only ends here with play.
   */
  private completeSelection(): void {
    const pending = this.pendingSelection;
    if (pending === null) return;
    this.pendingSelection = null;
    this.countdown = null;
    this.countdownText?.destroy();
    this.countdownText = null;
    this.metronome = null;
    this.autoSelectTimer?.remove(false);
    this.autoSelectTimer = null;
    const handler = this.onSelect;
    this.onSelect = null;
    handler?.(pending.index, pending.option);
    this.scene.stop();
  }

  /** The options currently presented (copy). */
  getOptions(): ChoiceOption[] {
    return [...this.options];
  }

  /** The rendered option labels (e.g. `["1.  Shield", ...]`). */
  getOptionLabels(): string[] {
    return this.controls.map((control) => control.text);
  }

  /**
   * The rendered detail lines beneath each option (e.g.
   * `["+1 Projectiles", "★ New", ...]`).  Returns an empty array when no
   * detail lines are present. The change-summary / `★ New` contract is
   * unchanged; the description is a separate line (see
   * {@link getDescriptionLines}).
   */
  getDetailLines(): string[] {
    return this.details.map((d) => d.text);
  }

  /**
   * The catalogue copy rendered beneath each option name (e.g.
   * `["Adds a 3-bullet fan (−30°/0°/+30°).", ...]`). One entry per option
   * that carries a non-empty `description`; empty when none do. This is the
   * shared catalogue copy verbatim — the wrapped layout actually drawn is
   * exposed by {@link getDescriptionRenderedLines}
   * (AH-0MV2N2591007UGPD · AC2/AC6, AH-0MVBLBSG3002WHBI · AC4).
   */
  getDescriptionLines(): string[] {
    return [...this.descriptionCopy];
  }

  /**
   * The wrapped description lines actually drawn, one entry per option that
   * carries a description. Each entry holds at most
   * {@link CHOICE_DESCRIPTION_MAX_LINES} lines of at most
   * {@link CHOICE_DESCRIPTION_MAX_CHARS_PER_LINE} characters
   * (AH-0MVBLBSG3002WHBI · AC1/AC3).
   */
  getDescriptionRenderedLines(): string[][] {
    return this.renderedDescriptionLines.map((lines) => [...lines]);
  }

  /**
   * The rendered geometry of every option row: the name → description area →
   * detail block plus the row's overall vertical extent. Exposed so tests can
   * assert the parts never overlap and consecutive rows never collide
   * (AH-0MVBLBSG3002WHBI · AC2).
   */
  getRowLayout(): ChoiceRowLayout[] {
    return this.rows.map((row) => ({
      ...row,
      name: { ...row.name },
      description: row.description ? { ...row.description } : null,
      detail: row.detail ? { ...row.detail } : null,
    }));
  }

  /**
   * Selects option `index`: records the choice, tears down the choice screen
   * and starts the beat-locked 3-2-1 countdown. The choice is applied through
   * the `onSelect` callback when the countdown completes (on the beat after
   * "1"); the reduced-volume metronomic fire continues underneath. Returns
   * the chosen option, or null for an out-of-range index.
   */
  select(index: number): ChoiceOption | null {
    const option = this.options[index];
    if (!option || this.pendingSelection !== null) return null;

    // Cancel any pending demo auto-select so it cannot fire twice.
    this.autoSelectTimer?.remove(false);
    this.autoSelectTimer = null;
    // The player has chosen: remove the choice UI (backdrop, heading,
    // options, keydown listener) so only the countdown numeral remains
    // (AH-0MV722WJS0075UTZ).
    this._teardownChoiceUi();
    // Record the pending selection and start the 3-2-1 countdown — one count
    // per beat of the shared grid, with the metronome continuing underneath
    // (AH-0MV55OAQT004NMSN · AC4/AC3).
    this.pendingSelection = { index, option };
    this.countdown = createHoldFullCountdown(
      this.fireSchedule?.bpm ?? loadRules().beatBpm,
    );
    this.showCountdownNumeral(3);
    // First count "3": the base (step 0) pitch of the rising tick.
    playCountdownTickSound(0);
    return option;
  }

  /** Destroys the choice screen objects and unregisters the keydown listener. */
  private _teardownChoiceUi(): void {
    this.backdrop?.destroy();
    this.backdrop = null;
    this.heading?.destroy();
    this.heading = null;
    for (const item of [...this.controls, ...this.details, ...this.descriptions]) {
      item.destroy();
    }
    this.controls = [];
    this.details = [];
    this.descriptions = [];
    this.descriptionCopy = [];
    this.renderedDescriptionLines = [];
    this.rows = [];
    if (this.keydownHandler !== null) {
      this.input.keyboard?.off('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
  }

  /** Total overlay-relative elapsed time (ms) since the scene started. */
  getOverlayElapsedMs(): number {
    return this.overlayElapsedMs;
  }

  /**
   * The countdown numeral currently on screen ("3"), or null when the
   * overlay is not counting down (awaiting input or already applied).
   */
  getCountdownText(): string | null {
    return this.countdownText?.text ?? null;
  }

  /** True while the beat-locked 3-2-1 countdown is running. */
  isCountdownActive(): boolean {
    return this.countdown !== null;
  }

  /**
   * True while the choice screen (backdrop/heading/options) is on screen.
   * Becomes false the moment the countdown starts, since `select()` tears
   * the choice UI down (AH-0MV722WJS0075UTZ).
   */
  isChoiceScreenVisible(): boolean {
    return this.backdrop !== null || this.heading !== null;
  }
}
