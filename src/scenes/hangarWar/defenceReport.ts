/**
 * Defence-report renderer — the one report screen used by the game's
 * `DefenceReportScene` and by `GymHexWar` (AH-0MVUXCBBK004EJIP, part of
 * **Build Candidate D — Hangar War**).
 *
 * The report's content is the pure read model built by
 * `src/core/hangarWar/defenceReport.ts`: the tick's aggression rise, the
 * held/fell summary, and one block per attacked hex carrying every number the
 * resolver used plus what it would take to retake it. This module only *draws*
 * that model and wires its single action (continue) to the shared
 * `FocusManager`; it contains no rule, no resolver call and no state.
 *
 * **One screen code path.** The shipped `DefenceReportScene` renders this with
 * a handler (continue → the map) and `GymHexWar` renders the **same** model and
 * renderer with no handlers, so the gym shows exactly what the game shows and
 * can never drift from it (AGENTS.md gym↔game parity, `docs/GYM_PARITY.md`).
 *
 * @module src/scenes/hangarWar/defenceReport
 */

import Phaser from 'phaser';

import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import type { DefenceReportModel } from '../../core/hangarWar/defenceReport';
import { FocusManager } from '../../utils/focusManager';

/** Bottom hint line (the shared keyboard controls). */
export const DEFENCE_REPORT_HINT =
  'enter/space continues to the map · ESC menu';

/** Text colours (matching the map/hangar screens). */
const TEXT_COLOR = '#a8e8ff';
const HEADING_COLOR = '#00ffff';
const MUTED_COLOR = '#557788';
const HELD_COLOR = '#00ff88';
const FELL_COLOR = '#ff6666';

/** How many attack blocks are drawn before the rest are summarised. */
const MAX_RENDERED_ROWS = 6;

/** Rendering options. */
export interface DefenceReportRenderOptions {
  /** Bottom hint line (defaults to {@link DEFENCE_REPORT_HINT}). */
  readonly hint?: string;
  /** The run's result line (e.g. `RUN: VICTORY · score 1200`), when known. */
  readonly runLine?: string | null;
}

/** The actions a rendered report invokes. */
export interface DefenceReportHandlers {
  /** Continue to the map (the screen's one action). */
  onContinue(): void;
}

/** One rendered row, exposed for tests and screen queries. */
export interface DefenceReportRow {
  /** Row key (`defence:<hexId>` for an attack block, `continue` for the action). */
  key: string;
  /** Rendered text. */
  label: string;
  /** Whether the row can be activated in this render. */
  actionable: boolean;
  /** The Phaser text object rendering the row. */
  text: Phaser.GameObjects.Text;
}

/** The handle returned by {@link renderDefenceReport}. */
export interface DefenceReportView {
  /** The model rendered. */
  readonly model: DefenceReportModel;
  /** Every rendered row (attack blocks in record order, then continue). */
  readonly rows: readonly DefenceReportRow[];
  /** The focused row key, or `null` when nothing is focusable. */
  getFocusedKey(): string | null;
  /** Moves focus to `key` when it is focusable (deterministic test seam). */
  focusRow(key: string): boolean;
  /** Activates the focused row (what Enter/Space does). */
  activateFocused(): void;
  /** Destroys the rendered objects and detaches the keyboard listener. */
  destroy(): void;
}

/**
 * Renders the defence-report model and wires its continue action to the shared
 * `FocusManager`.
 *
 * A render with no handlers (the read-only `GymHexWar` parity scene) shows the
 * same report but reports every row as non-actionable, so nothing can be
 * activated there.
 *
 * @param scene — the scene that owns the rendered objects.
 * @param model — the model to render (from `buildDefenceReport`).
 * @param handlers — the actions the rows invoke (omit to render read-only).
 * @param options — rendering knobs (hint line, run-result line).
 * @returns the view handle.
 */
export function renderDefenceReport(
  scene: Phaser.Scene,
  model: DefenceReportModel,
  handlers?: Partial<DefenceReportHandlers>,
  options?: DefenceReportRenderOptions,
): DefenceReportView {
  const objects: Phaser.GameObjects.GameObject[] = [];
  const rows: DefenceReportRow[] = [];
  const focusManager = new FocusManager();

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, 18, model.title, {
        fontFamily: 'monospace',
        fontSize: '20px',
        color: HEADING_COLOR,
      })
      .setOrigin(0.5, 0),
  );

  objects.push(
    scene.add.text(24, 56, model.tickLine, {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: TEXT_COLOR,
    }),
  );

  const runLine = options?.runLine ?? null;
  if (runLine) {
    objects.push(
      scene.add.text(24, 76, runLine, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: MUTED_COLOR,
      }),
    );
  }

  objects.push(
    scene.add.text(24, runLine ? 96 : 76, model.summaryLine, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: model.fellCount > 0 ? FELL_COLOR : HELD_COLOR,
    }),
  );

  const rendered = model.rows.slice(0, MAX_RENDERED_ROWS);
  const firstRowY = runLine ? 126 : 106;
  rendered.forEach((row, index) => {
    const text = scene.add.text(24, firstRowY + index * 62, row.label, {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: row.outcome === 'fell' ? FELL_COLOR : TEXT_COLOR,
      lineSpacing: 2,
    });
    objects.push(text);
    rows.push({
      key: row.key,
      label: row.label,
      // Attack blocks are a read-only view: the report has one action only.
      actionable: false,
      text,
    });
  });

  if (model.rows.length > rendered.length) {
    const hidden = model.rows.length - rendered.length;
    objects.push(
      scene.add.text(
        24,
        firstRowY + rendered.length * 62,
        `… and ${hidden} more attacked hex${hidden === 1 ? '' : 'es'}`,
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: MUTED_COLOR,
        },
      ),
    );
  }

  const continueText = scene.add.text(24, 452, model.continueLabel, {
    fontFamily: 'monospace',
    fontSize: '13px',
    color: TEXT_COLOR,
  });
  objects.push(continueText);
  const continueRow: DefenceReportRow = {
    key: model.continueKey,
    label: model.continueLabel,
    actionable: handlers?.onContinue !== undefined,
    text: continueText,
  };
  rows.push(continueRow);

  if (handlers?.onContinue) {
    const advance = (): void => handlers.onContinue!();
    continueText.on('pointerover', () => continueText.setStyle({ color: '#ffffff' }));
    continueText.on('pointerout', () => continueText.setStyle({ color: TEXT_COLOR }));
    continueText.on('pointerdown', advance);
    continueText.setInteractive({ useHandCursor: true });
    focusManager.register(continueText, advance);
  }

  objects.push(
    scene.add.text(24, 486, model.noBattleLine, {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: MUTED_COLOR,
    }),
  );

  objects.push(
    scene.add
      .text(GAME_WIDTH / 2, GAME_HEIGHT - 10, options?.hint ?? DEFENCE_REPORT_HINT, {
        fontFamily: 'monospace',
        fontSize: '11px',
        color: MUTED_COLOR,
      })
      .setOrigin(0.5, 1),
  );

  focusManager.attachKeyboard(scene);

  const focusable = (): DefenceReportRow[] => rows.filter((row) => row.actionable);

  const focusRow = (key: string): boolean => {
    const list = focusable();
    const index = list.findIndex((row) => row.key === key);
    if (index < 0) return false;
    focusManager.setFocusedIndex(index);
    return true;
  };

  if (model.defaultFocusKey !== null) focusRow(model.defaultFocusKey);

  return {
    model,
    rows,
    getFocusedKey(): string | null {
      const index = focusManager.getFocusedIndex();
      if (index < 0) return null;
      return focusable()[index]?.key ?? null;
    },
    focusRow,
    activateFocused(): void {
      focusManager.activateFocused();
    },
    destroy(): void {
      focusManager.shutdown();
      for (const object of objects) object.destroy();
      objects.length = 0;
      rows.length = 0;
    },
  };
}
