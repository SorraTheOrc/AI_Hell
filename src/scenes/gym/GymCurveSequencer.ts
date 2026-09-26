/**
 * Gym scene — difficulty-curve editor + auto-sequencer preview
 * (AH-0MUGXDVPH005TIZL, surfaced under **Dev Utilities** on the gym index).
 *
 * The runtime auto-sequencer (`src/core/difficultySequencer.ts`,
 * AH-0MUDIWETP003XC3X) turns a design-time difficulty curve — one target score
 * per wave — into concrete `ShootableWave` definitions. This scene is the
 * hands-on testbed for that pipeline:
 *
 * - **Curve editor** (plain-DOM panel, same `.gym-panel` pattern as the other
 *   gyms): one 0–100 slider per wave plus a Remove button, an Add Wave button,
 *   and a Regenerate button.
 * - **Wave preview** (Phaser canvas text): each generated wave's number,
 *   target difficulty, actual difficulty, signed error (target − actual),
 *   enemy composition and shooting status.
 * - **Edit-to-clear**: any curve change marks the preview stale, clears the
 *   wave list and shows {@link CURVE_PREVIEW_STALE_TEXT} until Regenerate is
 *   pressed again.
 *
 * The scores shown come straight from the sequencer result — every
 * `AdjustedGroup.score` is the value produced by `enemyDifficulty()` while the
 * sequencer tunes the group's adjustable fields against the target.
 *
 * Non-goals (see the work item): saving/loading curves, visual formation
 * previews, multi-group waves, drag-to-reorder.
 */

import Phaser from 'phaser';

import {
  defaultCandidatePool,
  sequencer,
  type CandidateGroup,
} from '../../core/difficultySequencer';
import { makeCollapsible } from '../../utils/gymPanel';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';

// ── Panel element ids + data attributes (asserted by tests) ──────────

/** Id of the curve-editor panel. */
export const CURVE_PANEL_ID = 'gym-curve-panel';
/** Id of the "Add Wave" button. */
export const CURVE_ADD_BUTTON_ID = 'gym-curve-add';
/** Id of the "Regenerate" button. */
export const CURVE_REGENERATE_BUTTON_ID = 'gym-curve-regenerate';
/** Data attribute (value = wave index) identifying a wave's target slider. */
export const CURVE_WAVE_SLIDER_ATTR = 'data-curve-wave';
/** Data attribute (value = wave index) identifying a wave's value readout. */
export const CURVE_WAVE_VALUE_ATTR = 'data-curve-wave-value';
/** Data attribute (value = wave index) identifying a wave's Remove button. */
export const CURVE_WAVE_REMOVE_ATTR = 'data-curve-remove';
/** Class of a single curve-editor row. */
export const CURVE_ROW_CLASS = 'gym-curve-row';

// ── Preview text + curve defaults ────────────────────────────────────

/** Instruction shown when the curve changed since the last regeneration. */
export const CURVE_PREVIEW_STALE_TEXT = 'Edit made — click Regenerate to preview';
/** Heading rendered above the wave list. */
export const CURVE_PREVIEW_HEADER = 'WAVE PREVIEW';
/** Default target-difficulty curve (one score per wave). */
export const DEFAULT_DIFFICULTY_CURVE: readonly number[] = [10, 20, 30, 40, 50, 60];
/** Slider bounds (AC3 — target difficulty is on a 0–100 scale). */
export const CURVE_TARGET_MIN = 0;
export const CURVE_TARGET_MAX = 100;
/** Target applied to a newly added wave row. */
export const CURVE_NEW_WAVE_TARGET = 50;

/** Wave-list layout on the Phaser canvas. */
const PREVIEW_HEADER_X = 40;
const PREVIEW_HEADER_Y = 120;
const PREVIEW_START_Y = 150;
const PREVIEW_LINE_HEIGHT = 22;

/** A single rendered wave-preview row. */
export interface WavePreviewEntry {
  /** 1-based wave position. */
  waveNumber: number;
  /** Design-time target score for this wave. */
  targetDifficulty: number;
  /** Actual score of the sequencer's chosen group(s) (0–100). */
  actualDifficulty: number;
  /** Signed error `target − actual` (positive = easier than intended). */
  error: number;
  /** Enemy composition, e.g. `scout ×12`. */
  composition: string;
  /** Whether the wave's enemies fire projectiles. */
  shootEnabled: boolean;
}

/** Round to two decimals so preview values are stable and comparable. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Renders one wave-preview row as a single monospace line. */
export function formatWavePreviewLine(entry: WavePreviewEntry): string {
  const sign = entry.error >= 0 ? '+' : '';
  return (
    `Wave ${entry.waveNumber}` +
    `  target ${entry.targetDifficulty}` +
    `  actual ${entry.actualDifficulty.toFixed(1)}` +
    `  err ${sign}${entry.error.toFixed(1)}` +
    `  ${entry.composition}` +
    `  shooting: ${entry.shootEnabled ? 'yes' : 'no'}`
  );
}

export class GymCurveSequencer extends Phaser.Scene {
  /** Editable target curve — one score per wave. */
  private curve: number[] = [...DEFAULT_DIFFICULTY_CURVE];
  /** Last regenerated preview (empty while stale). */
  private preview: WavePreviewEntry[] = [];
  /** True when the curve changed since the last regeneration. */
  private previewStale = true;
  /** Phaser text objects making up the rendered wave list. */
  private previewTexts: Phaser.GameObjects.Text[] = [];
  /** Plain-DOM tuning panel (removed on shutdown). */
  private panel: HTMLDivElement | null = null;
  /** Container holding the per-wave editor rows (re-rendered on edit). */
  private rows: HTMLDivElement | null = null;
  /** Candidate pool the sequencer chooses from. */
  private readonly candidates: CandidateGroup[] = defaultCandidatePool();

  constructor() {
    super({ key: 'GymCurveSequencer' });
  }

  create(): void {
    // Shared gym navigation: "← INDEX" button + ESC → main menu (AC7/AC8).
    addBackToIndexButton(this);
    addBackToMenuOnEsc(this);

    this._buildPreviewArea();
    this._buildPanel();

    // Show a preview immediately so the scene is useful on first load; the
    // stale instruction appears as soon as the curve is edited (AC5).
    this.regenerate();

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.panel?.remove();
      this.panel = null;
      this.rows = null;
      this.previewTexts = [];
    });
  }

  // ── Wave preview (Phaser canvas) ─────────────────────────────────

  /** Draws the static "WAVE PREVIEW" heading above the wave list. */
  private _buildPreviewArea(): void {
    this.add.text(PREVIEW_HEADER_X, PREVIEW_HEADER_Y, CURVE_PREVIEW_HEADER, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#00ffff',
    });
  }

  /** Re-renders the wave list (or the stale instruction) from `preview`. */
  private _renderPreview(): void {
    for (const text of this.previewTexts) text.destroy();
    this.previewTexts = [];

    if (this.previewStale) {
      this.previewTexts.push(
        this.add.text(PREVIEW_HEADER_X, PREVIEW_START_Y, CURVE_PREVIEW_STALE_TEXT, {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: '#ffcc00',
        }),
      );
      return;
    }

    this.preview.forEach((entry, index) => {
      this.previewTexts.push(
        this.add.text(
          PREVIEW_HEADER_X,
          PREVIEW_START_Y + index * PREVIEW_LINE_HEIGHT,
          formatWavePreviewLine(entry),
          {
            fontFamily: 'monospace',
            fontSize: '14px',
            color: '#00ff00',
          },
        ),
      );
    });
  }

  // ── Curve editor (plain-DOM panel) ───────────────────────────────

  /** Builds the bottom-left curve-editor panel. */
  private _buildPanel(): void {
    const host = document.querySelector('#game-container') ?? document.body;
    const panel = document.createElement('div');
    panel.id = CURVE_PANEL_ID;
    // Shared bottom-left anchoring + collapsible body (AH-0MUAYB7O4009LWBF).
    panel.className = 'gym-panel';

    const rows = document.createElement('div');
    rows.className = 'gym-curve-rows';
    this.rows = rows;
    panel.appendChild(rows);

    const actions = document.createElement('div');
    actions.className = 'gym-panel-actions';

    const add = document.createElement('button');
    add.id = CURVE_ADD_BUTTON_ID;
    add.type = 'button';
    add.textContent = 'Add Wave';
    add.addEventListener('click', () => this._onAddWave());

    const regenerate = document.createElement('button');
    regenerate.id = CURVE_REGENERATE_BUTTON_ID;
    regenerate.type = 'button';
    regenerate.textContent = 'Regenerate';
    regenerate.addEventListener('click', () => this.regenerate());

    actions.append(add, regenerate);
    panel.appendChild(actions);

    // Wrap in a collapsible body ("Difficulty Curve") — a long curve would
    // otherwise occupy most of the screen.
    makeCollapsible({ panel, title: 'Difficulty Curve' });

    host.appendChild(panel);
    this.panel = panel;

    this._renderCurveRows();
  }

  /** Rebuilds every curve row from `curve` (used on add/remove). */
  private _renderCurveRows(): void {
    const rows = this.rows;
    if (!rows) return;
    rows.replaceChildren(
      ...this.curve.map((target, index) => this._waveRow(index, target)),
    );
  }

  /** Builds one curve row: label, 0–100 slider, value readout, Remove button. */
  private _waveRow(index: number, target: number): HTMLElement {
    const row = document.createElement('div');
    row.className = CURVE_ROW_CLASS;
    row.dataset['waveIndex'] = String(index);

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = `Wave ${index + 1}`;

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(CURVE_TARGET_MIN);
    input.max = String(CURVE_TARGET_MAX);
    input.step = '1';
    input.value = String(target);
    input.setAttribute(CURVE_WAVE_SLIDER_ATTR, String(index));
    input.addEventListener('input', () => this._onTargetChanged(index, input.value));

    const value = document.createElement('output');
    value.setAttribute(CURVE_WAVE_VALUE_ATTR, String(index));
    value.textContent = String(target);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute(CURVE_WAVE_REMOVE_ATTR, String(index));
    remove.addEventListener('click', () => this._onRemoveWave(index));

    row.append(label, input, value, remove);
    return row;
  }

  /** Applies a slider change and marks the preview stale (AC3/AC5). */
  private _onTargetChanged(index: number, raw: string): void {
    const target = Number(raw);
    if (!Number.isFinite(target) || index < 0 || index >= this.curve.length) return;
    this.curve[index] = target;
    const readout = this.rows?.querySelector<HTMLElement>(
      `[${CURVE_WAVE_VALUE_ATTR}="${index}"]`,
    );
    if (readout) readout.textContent = String(target);
    this._markStale();
  }

  /** Appends a new wave row and marks the preview stale (AC3/AC5). */
  private _onAddWave(): void {
    this.curve.push(CURVE_NEW_WAVE_TARGET);
    this._renderCurveRows();
    this._markStale();
  }

  /** Removes a wave row and marks the preview stale (AC3/AC5). */
  private _onRemoveWave(index: number): void {
    if (index < 0 || index >= this.curve.length) return;
    this.curve.splice(index, 1);
    this._renderCurveRows();
    this._markStale();
  }

  /** Clears the preview and switches to the "click Regenerate" instruction. */
  private _markStale(): void {
    this.previewStale = true;
    this.preview = [];
    this._renderPreview();
  }

  // ── Regeneration ─────────────────────────────────────────────────

  /**
   * Runs the auto-sequencer against the current curve and candidate pool and
   * renders the resulting waves (AC4). Wired to the Regenerate button and
   * also run once on scene create.
   */
  regenerate(): void {
    const result = sequencer(this.curve, this.candidates);
    this.preview = result.waves.map((wave, index) => {
      // The sequencer currently picks exactly one candidate group per wave, so
      // the wave's actual difficulty is that group's `enemyDifficulty` score.
      const actualDifficulty = round2(
        wave.groups.reduce((sum, group) => sum + group.score, 0),
      );
      const targetDifficulty = wave.targetDifficulty;
      return {
        waveNumber: index + 1,
        targetDifficulty,
        actualDifficulty,
        error: round2(targetDifficulty - actualDifficulty),
        composition:
          wave.groups.map((group) => `${group.enemyKey} ×${group.count}`).join(', ') ||
          'none',
        shootEnabled: wave.shootEnabled,
      };
    });
    this.previewStale = false;
    this._renderPreview();
  }

  // ── Public test accessors ────────────────────────────────────────

  /** A copy of the current editable target curve. */
  get curveTargets(): number[] {
    return [...this.curve];
  }

  /** A copy of the last regenerated wave preview (empty while stale). */
  get wavePreview(): WavePreviewEntry[] {
    return this.preview.map((entry) => ({ ...entry }));
  }

  /** True when the curve changed since the last regeneration. */
  get isPreviewStale(): boolean {
    return this.previewStale;
  }
}
