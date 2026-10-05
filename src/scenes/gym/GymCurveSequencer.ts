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
 * - **Wave preview table** (Phaser canvas text): a column-heading row
 *   followed by one aligned row per wave — number, target difficulty, enemy
 *   composition and shooting status (AC6/AC10/AC12) — plus a bottom-right
 *   column-guide help box (AC11) summarising each column.
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
  type ShootableWave,
} from '../../core/difficultySequencer';
import { waveDifficulty } from '../../core/enemyDifficulty';
import type { DifficultyGeneration } from '../../core/configTypes';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { makeCollapsible } from '../../utils/gymPanel';
import {
  addBackToIndexButton,
  addBackToMenuOnEsc,
} from '../../utils/gymNavigation';
import type {
  LevelDefinition,
  WaveDefinition,
  WaveGroup,
} from '../../waves/Formations';
import { GYM_LEVEL_SCENE_KEY } from './GymLevel';

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
/** Data attribute (value = wave index) identifying a wave's generation-mode control. */
export const CURVE_WAVE_MODE_ATTR = 'data-curve-mode';
/** Data attribute set on a readout showing a `fixed` wave's derived difficulty. */
export const CURVE_WAVE_DERIVED_ATTR = 'data-curve-derived';
/** Class of a single curve-editor row. */
export const CURVE_ROW_CLASS = 'gym-curve-row';

/**
 * Generation modes offered by a wave's mode control (AH-0MUJSUT8P008UPQM).
 * Mirrors the engine's per-wave `generation` column; the editor default is
 * `curve`.
 */
export const CURVE_MODE_OPTIONS: readonly DifficultyGeneration[] = [
  'curve', 'fixed', 'dynamic',
];
/** Mode applied to a newly added wave row. */
export const CURVE_DEFAULT_MODE: DifficultyGeneration = 'curve';

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
/**
 * Accuracy (in difficulty points) the sequencer aims for per wave. The gym is
 * a design tool, so it asks the sequencer for a tighter match than the runtime
 * default; this is what lets it compose multi-group waves at higher targets
 * rather than settling for one saturated archetype (AC12/AC13).
 */
export const CURVE_TARGET_TOLERANCE = 3;

/** Wave-table layout on the Phaser canvas. */
const PREVIEW_HEADER_X = 40;
const PREVIEW_HEADER_Y = 120;
const PREVIEW_START_Y = 150;
const PREVIEW_LINE_HEIGHT = 20;
/** Blank characters between adjacent table columns. */
const COLUMN_GAP = 2;
/** Margin (px) between the column-guide help box and the canvas edges (AC11). */
export const CURVE_HELP_BOX_MARGIN = 16;

// ── Launch controls (AH-0MUNU6MGM007CI45) ─────────────────────────

/**
 * Number of consecutive generated waves folded into one level group by the
 * curve editor (AH-0MUNU6MGM007CI45). The editor edits a single flat curve,
 * so the generated preview is partitioned into level groups of this size —
 * each group becomes a {@link LevelDefinition} the Level Gym can play in full.
 */
export const CURVE_WAVES_PER_LEVEL = 3;
/** Gap (px) between a row's text and its "Launch Wave" button. */
export const CURVE_LAUNCH_BUTTON_GAP = 12;
/** Label of the per-group "Launch Level" button. */
export const CURVE_LAUNCH_LEVEL_LABEL = 'Launch Level';
/** Label prefix of the per-row "Launch Wave" button (suffixed with the wave number). */
export const CURVE_LAUNCH_WAVE_LABEL_PREFIX = 'Launch Wave';
/** Prefix of a level-group heading rendered above its waves. */
export const CURVE_LEVEL_HEADING_PREFIX = 'LEVEL';

/**
 * Partitions an ordered list into consecutive groups of at most
 * `perGroup` items (the final group may be shorter). A non-positive
 * `perGroup` puts everything in one group. Pure and order-preserving:
 * the curve editor's level grouping is a plain partition of the generated
 * wave list (AH-0MUNU6MGM007CI45).
 */
export function groupWavesByLevel<T>(
  items: readonly T[],
  perGroup: number = CURVE_WAVES_PER_LEVEL,
): T[][] {
  if (!Number.isFinite(perGroup) || perGroup < 1) return items.length ? [[...items]] : [];
  const groups: T[][] = [];
  for (let start = 0; start < items.length; start += perGroup) {
    groups.push(items.slice(start, start + perGroup));
  }
  return groups;
}

/** Maps a sequencer-adjusted group to a plain, spawnable `WaveGroup`. */
export function toWaveGroup(group: ShootableWave['groups'][number]): WaveGroup {
  return {
    enemyKey: group.enemyKey,
    formation: group.formation,
    count: group.count,
    spacingX: group.spacingX,
    spacingY: group.spacingY,
    startX: group.startX,
    startY: group.startY,
  };
}

/** Maps one sequencer wave to the `WaveDefinition` shape the game consumes. */
export function toWaveDefinition(wave: ShootableWave): WaveDefinition {
  return {
    groups: wave.groups.map(toWaveGroup),
    shootEnabled: wave.shootEnabled,
  };
}

/**
 * Builds the level definitions the curve editor can launch from a flat
 * sequencer result: consecutive waves are folded into level groups of
 * {@link CURVE_WAVES_PER_LEVEL} (the final group may be shorter). Each group
 * is a complete, sequentially-playable {@link LevelDefinition}
 * (AH-0MUNU6MGM007CI45).
 */
export function buildCurveLevels(
  waves: readonly ShootableWave[],
  perGroup: number = CURVE_WAVES_PER_LEVEL,
): LevelDefinition[] {
  return groupWavesByLevel(waves, perGroup).map((group, index) => ({
    level: index + 1,
    name: `Curve Level ${index + 1}`,
    waves: group.map(toWaveDefinition),
  }));
}

// ── Per-wave variety (AH-0MUNU6MGM007CI45) ─────────────────────────

/**
 * Initial per-wave target jitter (0–100 difficulty points). The sequencer is
 * a pure function of its target, so two waves with the same target — or two
 * targets inside one archetype's band — compose identically. A small,
 * deterministic per-wave nudge breaks those ties so a level's waves do not
 * all play the same (the producer-audit rejection of AH-0MUNU6MGM007CI45: a
 * flat curve produced three identical waves). Kept small so a launched wave
 * still tracks the curve the designer drew.
 */
export const CURVE_WAVE_VARIATION_JITTER = 2;

/**
 * Maximum number of progressively larger nudges tried when a wave still
 * duplicates an earlier wave in its level. Each attempt alternates direction
 * and grows by {@link CURVE_WAVE_VARIATION_JITTER}, so the search walks
 * outward from the caller's target until a distinct composition is found (or
 * the budget is exhausted). Bounded so sequencing stays fast and a genuinely
 * saturated target can never loop forever.
 */
export const CURVE_WAVE_MAX_VARIATION_ATTEMPTS = 24;

/**
 * Deterministic `[0, 1)` hash of two integers. Pure: the same inputs always
 * yield the same fraction, so regenerating an unchanged curve reproduces the
 * same waves exactly (the curve editor has no run-seed concept, so variety is
 * derived from the wave's position rather than a mutable seed).
 */
function curveHashUnit(a: number, b: number): number {
  let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

/** Clamps a difficulty target to the 0–100 editor scale. */
function clampTarget(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/**
 * Selects a target for variation attempt `attempt` (0-based). Attempt 0 is the
 * smallest nudge ({@link CURVE_WAVE_VARIATION_JITTER}, direction from the
 * wave's hash); later attempts alternate direction and grow linearly. The
 * shift is added to `base` and clamped to the 0–100 scale.
 */
function variationTarget(base: number, wave: number, attempt: number): number {
  if (!Number.isFinite(base)) return base;
  if (attempt === 0) {
    const dir = curveHashUnit(wave, 7) >= 0.5 ? 1 : -1;
    return clampTarget(base + dir * CURVE_WAVE_VARIATION_JITTER);
  }
  const magnitude = Math.ceil(attempt / 2) * CURVE_WAVE_VARIATION_JITTER;
  const direction = attempt % 2 === 1 ? 1 : -1;
  return clampTarget(base + direction * magnitude);
}

/**
 * Builds one level's waves with a guarantee of visible variety
 * (AH-0MUNU6MGM007CI45): if a wave composes identically to an earlier wave in
 * the same level, its target is progressively nudged (see
 * {@link variationTarget}) until the composition differs. The caller's target
 * is preserved on each returned wave's `targetDifficulty`, so the editor still
 * reports the designer's curve value while the launched composition varies.
 */
export function sequenceVariedWaves(
  targets: readonly number[],
  candidates: readonly CandidateGroup[] = defaultCandidatePool(),
  tolerance: number = CURVE_TARGET_TOLERANCE,
): ShootableWave[] {
  const pool: CandidateGroup[] = [...candidates];
  const chosen: ShootableWave[] = [];
  const seen = new Set<string>();

  for (let wave = 0; wave < targets.length; wave++) {
    const base = targets[wave];
    let selected: ShootableWave | null = null;

    for (
      let attempt = 0;
      attempt < CURVE_WAVE_MAX_VARIATION_ATTEMPTS && !selected;
      attempt++
    ) {
      const target =
        attempt === 0 && Number.isFinite(base)
          ? base
          : variationTarget(base, wave, attempt - 1);
      const waveResult = sequencer([target], pool, { tolerance }).waves[0];
      if (!waveResult) continue;
      const composition = compositionKey(waveResult);
      if (!seen.has(composition)) {
        seen.add(composition);
        selected = { ...waveResult, targetDifficulty: base };
      }
    }

    // Exhausted the budget (e.g. every neighbouring target saturates to the
    // same composition) — fall back to the caller's unmodified target rather
    // than dropping the wave. The wave is still playable; it is simply the
    // best the sequencer can do for the curve. Record its composition so a
    // later wave still tries to differ.
    if (!selected) {
      const fallback = sequencer([base], pool, { tolerance }).waves[0];
      if (fallback) {
        seen.add(compositionKey(fallback));
        selected = { ...fallback, targetDifficulty: base };
      }
    }

    if (selected) chosen.push(selected);
  }

  return chosen;
}

/** Canonical composition string used to detect duplicate waves. */
function compositionKey(wave: ShootableWave): string {
  return (
    wave.groups
      .map((group) => `${group.enemyKey}:${group.count}`)
      .join('+') || 'none'
  );
}

/** A single rendered wave-preview row. */
export interface WavePreviewEntry {
  /** 1-based wave position. */
  waveNumber: number;
  /** Design-time target score for this wave. */
  targetDifficulty: number;
  /** Enemy composition, e.g. `scout ×12` (multiple groups joined by ` + `). */
  composition: string;
  /**
   * Summed difficulty score of the wave's chosen groups (0–100+). Kept on
   * the model so tests (and future tooling) can verify the sequencer matched
   * the target; it is deliberately not a table column (AC12).
   */
  actualDifficulty: number;
  /** Whether the wave's enemies fire projectiles. */
  shootEnabled: boolean;
  /** Per-wave generation mode used for this preview (AH-0MUJSUT8P008UPQM). */
  mode: DifficultyGeneration;
  /**
   * For a `fixed` wave, the difficulty derived from its (read-only) authored
   * composition. `undefined` for `curve`/`dynamic` waves, whose target is the
   * editable value.
   */
  derivedDifficulty?: number;
}

/** One column of the wave-preview table (AC10) + its guide entry (AC11). */
export interface WaveTableColumn {
  /** Column heading rendered in the table header row. */
  heading: string;
  /** One-line explanation shown in the bottom-right help box. */
  help: string;
  /** Renders this column's cell for one wave. */
  value: (entry: WavePreviewEntry) => string;
}

/**
 * The wave-preview table columns, in render order (AC10). Single source of
 * truth for the table header, the per-wave rows and the bottom-right
 * column-guide help box (AC11), so the guide can never drift from the table.
 */
export const WAVE_TABLE_COLUMNS: readonly WaveTableColumn[] = [
  {
    heading: 'WAVE',
    help: '1-based wave number',
    value: (entry) => String(entry.waveNumber),
  },
  {
    heading: 'TARGET',
    help: 'Target (or fixed derived) difficulty',
    // A `fixed` wave's target is read-only, so its column shows the difficulty
    // derived from the authored composition instead.
    value: (entry) => String(entry.derivedDifficulty ?? entry.targetDifficulty),
  },
  {
    heading: 'COMPOSITION',
    help: 'Enemy type and count',
    value: (entry) => entry.composition,
  },
  {
    heading: 'SHOOTING',
    help: 'Enemies fire projectiles?',
    value: (entry) => (entry.shootEnabled ? 'yes' : 'no'),
  },
];

/** Title line of the bottom-right column-guide help box (AC11). */
export const CURVE_HELP_BOX_TITLE = 'COLUMN GUIDE';

/**
 * Per-column character widths, sized to the widest of each heading and its
 * rendered cells so every row lines up (AC10).
 */
export function waveTableColumnWidths(
  entries: readonly WavePreviewEntry[],
): number[] {
  return WAVE_TABLE_COLUMNS.map((column) => {
    const cells = entries.map((entry) => column.value(entry));
    return Math.max(column.heading.length, 0, ...cells.map((cell) => cell.length));
  });
}

/** Joins one padded cell per column into an aligned fixed-width row. */
function formatTableCells(
  cells: readonly string[],
  widths: readonly number[],
): string {
  return cells
    .map((cell, index) => cell.padEnd(widths[index], ' '))
    .join(' '.repeat(COLUMN_GAP));
}

/** Renders the wave-table header row (AC10). */
export function formatWaveTableHeader(widths: readonly number[]): string {
  return formatTableCells(
    WAVE_TABLE_COLUMNS.map((column) => column.heading),
    widths,
  );
}

/** Renders one wave as an aligned table row (AC6/AC10). */
export function formatWaveTableRow(
  entry: WavePreviewEntry,
  widths: readonly number[],
): string {
  return formatTableCells(
    WAVE_TABLE_COLUMNS.map((column) => column.value(entry)),
    widths,
  );
}

/**
 * Renders the bottom-right column-guide help box (AC11): one line per table
 * column with its heading and one-line explanation.
 */
export function formatCurveHelpBox(): string {
  const width = Math.max(
    ...WAVE_TABLE_COLUMNS.map((column) => column.heading.length),
  );
  return [
    CURVE_HELP_BOX_TITLE,
    ...WAVE_TABLE_COLUMNS.map(
      (column) => `${column.heading.padEnd(width, ' ')}  ${column.help}`,
    ),
  ].join('\n');
}

export class GymCurveSequencer extends Phaser.Scene {
  /** Editable target curve — one score per wave. */
  private curve: number[] = [...DEFAULT_DIFFICULTY_CURVE];
  /** Per-wave generation mode (AH-0MUJSUT8P008UPQM), parallel to `curve`. */
  private modes: DifficultyGeneration[] = DEFAULT_DIFFICULTY_CURVE.map(
    () => CURVE_DEFAULT_MODE,
  );
  /** Last regenerated preview (empty while stale). */
  private preview: WavePreviewEntry[] = [];
  /** Raw sequencer waves backing `preview` (for building launchable levels). */
  private sequencedWaves: ShootableWave[] = [];
  /** Level groups built from `sequencedWaves` during regeneration. */
  private levels: LevelDefinition[] = [];
  /** True when the curve changed since the last regeneration. */
  private previewStale = true;
  /** Phaser text objects making up the rendered wave list. */
  private previewTexts: Phaser.GameObjects.Text[] = [];
  /** Phaser launch buttons rendered alongside the wave list (destroyed on re-render). */
  private previewButtons: Phaser.GameObjects.Text[] = [];
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
      this.previewButtons = [];
    });
  }

  // ── Wave preview (Phaser canvas) ─────────────────────────────────

  /**
   * Draws the static "WAVE PREVIEW" heading above the wave list and the
   * bottom-right column-guide help box (AC11).
   */
  private _buildPreviewArea(): void {
    this.add.text(PREVIEW_HEADER_X, PREVIEW_HEADER_Y, CURVE_PREVIEW_HEADER, {
      fontFamily: 'monospace',
      fontSize: '14px',
      color: '#00ffff',
    });

    // Bottom-right help box summarising every wave-table column (AC11).
    this.add
      .text(
        GAME_WIDTH - CURVE_HELP_BOX_MARGIN,
        GAME_HEIGHT - CURVE_HELP_BOX_MARGIN,
        formatCurveHelpBox(),
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: '#8899aa',
          backgroundColor: '#111111',
          padding: { x: 8, y: 6 },
        },
      )
      .setOrigin(1, 1);
  }

  /** Re-renders the wave list (or the stale instruction) from `preview`. */
  private _renderPreview(): void {
    for (const text of this.previewTexts) text.destroy();
    this.previewTexts = [];
    for (const button of this.previewButtons) button.destroy();
    this.previewButtons = [];

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

    // Header row, then one aligned group per level: a LEVEL heading with its
    // "Launch Level" button, then each wave row with its "Launch Wave"
    // button (AC1/AC2, AH-0MUNU6MGM007CI45).
    const widths = waveTableColumnWidths(this.preview);
    this.previewTexts.push(
      this.add.text(PREVIEW_HEADER_X, PREVIEW_START_Y, formatWaveTableHeader(widths), {
        fontFamily: 'monospace',
        fontSize: '14px',
        color: '#00ffff',
      }),
    );

    const groups = groupWavesByLevel(this.preview, CURVE_WAVES_PER_LEVEL);
    let y = PREVIEW_START_Y + PREVIEW_LINE_HEIGHT;
    groups.forEach((entries, levelIndex) => {
      // Level heading + "Launch Level" button for the whole group.
      const heading = this.add.text(
        PREVIEW_HEADER_X,
        y,
        `${CURVE_LEVEL_HEADING_PREFIX} ${levelIndex + 1}`,
        {
          fontFamily: 'monospace',
          fontSize: '14px',
          color: '#ffcc00',
        },
      );
      this.previewTexts.push(heading);
      this.previewButtons.push(
        this._launchButton(
          heading.x + heading.width + CURVE_LAUNCH_BUTTON_GAP,
          y,
          CURVE_LAUNCH_LEVEL_LABEL,
          levelIndex,
          () => this._launchLevel(levelIndex),
        ),
      );
      y += PREVIEW_LINE_HEIGHT;

      entries.forEach((entry, offset) => {
        const waveIndex = levelIndex * CURVE_WAVES_PER_LEVEL + offset;
        const row = this.add.text(
          PREVIEW_HEADER_X,
          y,
          formatWaveTableRow(entry, widths),
          {
            fontFamily: 'monospace',
            fontSize: '14px',
            color: '#00ff00',
          },
        );
        this.previewTexts.push(row);
        this.previewButtons.push(
          this._launchButton(
            row.x + row.width + CURVE_LAUNCH_BUTTON_GAP,
            y,
            `${CURVE_LAUNCH_WAVE_LABEL_PREFIX} ${entry.waveNumber}`,
            waveIndex,
            () => this._launchWave(waveIndex),
          ),
        );
        y += PREVIEW_LINE_HEIGHT;
      });
    });
  }

  /**
   * Builds one interactive preview launch button. `key` is stored as a data
   * attribute so tests can identify the exact group/wave it launches.
   */
  private _launchButton(
    x: number,
    y: number,
    label: string,
    key: number,
    onClick: () => void,
  ): Phaser.GameObjects.Text {
    const button = this.add
      .text(x, y, label, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#00ffff',
        backgroundColor: '#1a1a1a',
        padding: { x: 6, y: 2 },
      })
      .setOrigin(0, 0)
      .setData('curveLaunch', true)
      .setInteractive({ useHandCursor: true });
    button.setData('curveLaunchKey', key);
    button.on('pointerdown', onClick);
    return button;
  }

  /** Boots the Level Gym scene with a whole level group (AC1). */
  private _launchLevel(levelIndex: number): void {
    const level = this.levels[levelIndex];
    if (!level) return;
    this.scene.start(GYM_LEVEL_SCENE_KEY, { level });
  }

  /** Boots the Level Gym scene with one wave (AC2). */
  private _launchWave(waveIndex: number): void {
    const wave = this.sequencedWaves[waveIndex];
    if (!wave) return;
    const name = `Wave ${waveIndex + 1}`;
    this.scene.start(GYM_LEVEL_SCENE_KEY, {
      level: { level: 0, name, waves: [toWaveDefinition(wave)] },
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

  /**
   * Builds one curve row: label, generation-mode control, 0–100 slider, value
   * readout and Remove button (AH-0MUJSUT8P008UPQM).
   */
  private _waveRow(index: number, target: number): HTMLElement {
    const row = document.createElement('div');
    row.className = CURVE_ROW_CLASS;
    row.dataset['waveIndex'] = String(index);

    const label = document.createElement('span');
    label.className = 'gym-panel-label';
    label.textContent = `Wave ${index + 1}`;

    // Native <select>: keyboard accessible out of the box and labelled via
    // aria-label, so the mode is never reachable only through the slider.
    const mode = document.createElement('select');
    mode.setAttribute(CURVE_WAVE_MODE_ATTR, String(index));
    mode.setAttribute('aria-label', `Generation mode for wave ${index + 1}`);
    for (const option of CURVE_MODE_OPTIONS) {
      const opt = document.createElement('option');
      opt.value = option;
      opt.textContent = option;
      mode.appendChild(opt);
    }
    mode.value = this.modes[index] ?? CURVE_DEFAULT_MODE;
    mode.addEventListener('change', () => this._onModeChanged(index, mode.value));

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

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute(CURVE_WAVE_REMOVE_ATTR, String(index));
    remove.addEventListener('click', () => this._onRemoveWave(index));

    row.append(label, mode, input, value, remove);
    this._syncRowMode(index, input, value);
    return row;
  }

  /**
   * Applies a wave's generation mode to its row (AH-0MUJSUT8P008UPQM): a
   * `fixed` wave disables the target slider and shows the difficulty derived
   * from its authored composition; `curve`/`dynamic` waves keep the editable
   * target slider and target readout.
   */
  private _syncRowMode(
    index: number,
    input: HTMLInputElement,
    value: HTMLElement,
  ): void {
    const mode = this.modes[index] ?? CURVE_DEFAULT_MODE;
    if (mode === 'fixed') {
      input.disabled = true;
      value.textContent = String(this._derivedDifficultyFor(index));
      value.setAttribute(CURVE_WAVE_DERIVED_ATTR, 'true');
      value.title = 'Fixed composition — derived difficulty (read-only)';
    } else {
      input.disabled = false;
      value.textContent = String(this.curve[index]);
      value.removeAttribute(CURVE_WAVE_DERIVED_ATTR);
      value.removeAttribute('title');
    }
  }

  /**
   * Difficulty derived from a `fixed` wave's authored composition. The gym has
   * no per-wave composition editor, so a `fixed` wave freezes the composition
   * the sequencer produces for its (disabled) target and derives its
   * difficulty from that composition via `waveDifficulty()` — the same scorer
   * the runtime campaign uses.
   */
  private _derivedDifficultyFor(index: number): number {
    const target = this.curve[index];
    if (!Number.isFinite(target)) return 0;
    const result = sequencer([target], this.candidates, {
      tolerance: CURVE_TARGET_TOLERANCE,
    });
    const wave = result.waves[0];
    if (!wave) return 0;
    return waveDifficulty({
      groups: wave.groups,
      shootEnabled: wave.shootEnabled,
    }).score;
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

  /**
   * Applies a mode change, re-enabling/disabling the slider as appropriate,
   * and marks the preview stale (AH-0MUJSUT8P008UPQM).
   */
  private _onModeChanged(index: number, raw: string): void {
    if (index < 0 || index >= this.curve.length) return;
    if (!CURVE_MODE_OPTIONS.includes(raw as DifficultyGeneration)) return;
    this.modes[index] = raw as DifficultyGeneration;
    const input = this.rows?.querySelector<HTMLInputElement>(
      `input[${CURVE_WAVE_SLIDER_ATTR}="${index}"]`,
    );
    const value = this.rows?.querySelector<HTMLElement>(
      `[${CURVE_WAVE_VALUE_ATTR}="${index}"]`,
    );
    if (input && value) this._syncRowMode(index, input, value);
    this._markStale();
  }

  /** Appends a new wave row and marks the preview stale (AC3/AC5). */
  private _onAddWave(): void {
    this.curve.push(CURVE_NEW_WAVE_TARGET);
    this.modes.push(CURVE_DEFAULT_MODE);
    this._renderCurveRows();
    this._markStale();
  }

  /** Removes a wave row and marks the preview stale (AC3/AC5). */
  private _onRemoveWave(index: number): void {
    if (index < 0 || index >= this.curve.length) return;
    this.curve.splice(index, 1);
    this.modes.splice(index, 1);
    this._renderCurveRows();
    this._markStale();
  }

  /** Clears the preview and switches to the "click Regenerate" instruction. */
  private _markStale(): void {
    this.previewStale = true;
    this.preview = [];
    this.sequencedWaves = [];
    this.levels = [];
    this._renderPreview();
  }

  // ── Regeneration ─────────────────────────────────────────────────

  /**
   * Runs the auto-sequencer against the current curve and candidate pool and
   * renders the resulting waves (AC4). Wired to the Regenerate button and
   * also run once on scene create.
   */
  regenerate(): void {
    // Sequence each level group independently so every wave within a level
    // differs from its neighbours even when the curve is flat (the audit
    // rejection of AH-0MUNU6MGM007CI45: three identical waves). `targets`
    // keeps the designer's curve values; the variety nudge only affects the
    // composition the sequencer selects, never the displayed target.
    const levelTargetGroups = groupWavesByLevel(
      this.curve,
      CURVE_WAVES_PER_LEVEL,
    );
    const waves: ShootableWave[] = [];
    for (const targets of levelTargetGroups) {
      waves.push(
        ...sequenceVariedWaves(
          targets,
          this.candidates,
          CURVE_TARGET_TOLERANCE,
        ),
      );
    }
    // Keep the raw sequencer waves so the grouped level definitions (below)
    // and the per-wave launch buttons can rebuild the exact spawnable shape.
    this.sequencedWaves = waves;
    this.levels = buildCurveLevels(waves);
    this.preview = waves.map((wave, index) => {
      const mode = this.modes[index] ?? CURVE_DEFAULT_MODE;
      const actualDifficulty =
        Math.round(
          wave.groups.reduce((sum, group) => sum + group.score, 0) * 100,
        ) / 100;
      // A `fixed` wave's composition is frozen (the sequencer output for its
      // disabled target); its displayed difficulty is derived from it.
      const derivedDifficulty =
        mode === 'fixed'
          ? waveDifficulty({
              groups: wave.groups,
              shootEnabled: wave.shootEnabled,
            }).score
          : undefined;
      return {
        waveNumber: index + 1,
        targetDifficulty: wave.targetDifficulty,
        composition:
          wave.groups
            .map((group) => `${group.enemyKey} ×${group.count}`)
            .join(' + ') || 'none',
        actualDifficulty,
        shootEnabled: wave.shootEnabled,
        mode,
        ...(derivedDifficulty !== undefined ? { derivedDifficulty } : {}),
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

  /** A copy of the current per-wave generation modes. */
  get waveModes(): DifficultyGeneration[] {
    return [...this.modes];
  }

  /** A copy of the last regenerated wave preview (empty while stale). */
  get wavePreview(): WavePreviewEntry[] {
    return this.preview.map((entry) => ({ ...entry }));
  }

  /**
   * Level groups the sequencer result was folded into for launching
   * (AH-0MUNU6MGM007CI45). Empty while the preview is stale.
   */
  get curveLevels(): LevelDefinition[] {
    return this.levels.map((level) => ({
      ...level,
      waves: level.waves.map((wave) => ({
        ...wave,
        groups: wave.groups.map((group) => ({ ...group })),
      })),
    }));
  }

  /** Number of waves a level group holds in the current preview. */
  get wavesPerLevel(): number {
    return CURVE_WAVES_PER_LEVEL;
  }

  /** True when the curve changed since the last regeneration. */
  get isPreviewStale(): boolean {
    return this.previewStale;
  }
}
