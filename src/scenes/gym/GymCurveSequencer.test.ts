/**
 * Tests for the GymCurveSequencer dev-utility gym scene
 * (AH-0MUGXDVPH005TIZL): the curve editor, the Regenerate flow, the
 * edit-to-clear behaviour and the wave-preview display.
 *
 * The curve editor is a plain-DOM overlay beside the canvas, so the tests
 * drive it via `document.querySelector` in happy-dom; the wave list is drawn
 * as Phaser text objects and inspected through the scene's public accessors
 * plus the display list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, BootedGame } from '../../test/gameHarness';
import { GAME_HEIGHT, GAME_WIDTH } from '../../core/constants';
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../../utils/gymNavigation';
import { GymIndex } from '../GymIndex';
import { MenuScene } from '../MenuScene';
import {
  CURVE_ADD_BUTTON_ID,
  CURVE_HELP_BOX_TITLE,
  CURVE_PANEL_ID,
  CURVE_PREVIEW_STALE_TEXT,
  CURVE_REGENERATE_BUTTON_ID,
  CURVE_TARGET_MAX,
  CURVE_TARGET_MIN,
  CURVE_WAVE_REMOVE_ATTR,
  CURVE_WAVE_SLIDER_ATTR,
  CURVE_WAVE_VALUE_ATTR,
  DEFAULT_DIFFICULTY_CURVE,
  GymCurveSequencer,
  WAVE_TABLE_COLUMNS,
  formatCurveHelpBox,
  formatWaveTableHeader,
  formatWaveTableRow,
  waveTableColumnWidths,
  type WavePreviewEntry,
} from './GymCurveSequencer';

/** Waits for Phaser scene transitions to settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

/** Finds an on-screen text by exact label. */
function findText(scene: Phaser.Scene, label: string): Phaser.GameObjects.Text | undefined {
  return scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text === label,
  );
}

/** All wave data rows — Phaser texts beginning with the 1-based wave number. */
function findWaveRows(scene: Phaser.Scene): Phaser.GameObjects.Text[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && /^\d/.test(child.text),
  );
}

/**
 * The wave-table header row: a single-line text carrying the WAVE and TARGET
 * headings (the multi-line help box also mentions them, so exclude newlines).
 */
function findTableHeader(
  scene: Phaser.Scene,
): Phaser.GameObjects.Text | undefined {
  return scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      !child.text.includes('\n') &&
      child.text.startsWith('WAVE') &&
      child.text.includes('TARGET'),
  );
}

/** The bottom-right column-guide help box (AC11). */
function findHelpBox(
  scene: Phaser.Scene,
): Phaser.GameObjects.Text | undefined {
  return scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      child.text.startsWith(CURVE_HELP_BOX_TITLE),
  );
}

describe('GymCurveSequencer — curve editor and preview (AC3-AC6, AC9)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    document.getElementById(CURVE_PANEL_ID)?.remove();
  });

  async function boot(): Promise<GymCurveSequencer> {
    booted = await bootScene([GymCurveSequencer]);
    return booted!.scene as GymCurveSequencer;
  }

  const panel = (): HTMLElement | null =>
    document.querySelector(`#${CURVE_PANEL_ID}`);

  const slider = (index: number): HTMLInputElement =>
    panel()!.querySelector(
      `input[${CURVE_WAVE_SLIDER_ATTR}="${index}"]`,
    ) as HTMLInputElement;

  const valueReadout = (index: number): HTMLElement =>
    panel()!.querySelector(
      `[${CURVE_WAVE_VALUE_ATTR}="${index}"]`,
    ) as HTMLElement;

  const removeButton = (index: number): HTMLButtonElement =>
    panel()!.querySelector(
      `button[${CURVE_WAVE_REMOVE_ATTR}="${index}"]`,
    ) as HTMLButtonElement;

  const setSlider = (index: number, value: string): void => {
    const input = slider(index);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ── AC3 — curve editor ───────────────────────────────────────────

  it('AC3 — renders one 0–100 slider per wave plus Add Wave and Regenerate', async () => {
    const scene = await boot();
    expect(scene.sys.isActive()).toBe(true);
    expect(panel()).not.toBeNull();

    expect(scene.curveTargets).toEqual([...DEFAULT_DIFFICULTY_CURVE]);

    const sliders = panel()!.querySelectorAll(
      `input[type="range"][${CURVE_WAVE_SLIDER_ATTR}]`,
    );
    expect(sliders.length).toBe(DEFAULT_DIFFICULTY_CURVE.length);
    for (let i = 0; i < DEFAULT_DIFFICULTY_CURVE.length; i++) {
      expect(slider(i).min).toBe(String(CURVE_TARGET_MIN));
      expect(slider(i).max).toBe(String(CURVE_TARGET_MAX));
      expect(slider(i).value).toBe(String(DEFAULT_DIFFICULTY_CURVE[i]));
    }

    expect(panel()!.querySelector(`#${CURVE_ADD_BUTTON_ID}`)).not.toBeNull();
    expect(panel()!.querySelector(`#${CURVE_REGENERATE_BUTTON_ID}`)).not.toBeNull();
  });

  it('AC3 — Add Wave appends a row and Remove deletes the chosen wave', async () => {
    const scene = await boot();
    const initial = scene.curveTargets.length;

    (panel()!.querySelector(`#${CURVE_ADD_BUTTON_ID}`) as HTMLButtonElement).click();
    expect(scene.curveTargets.length).toBe(initial + 1);
    expect(
      panel()!.querySelectorAll(`input[${CURVE_WAVE_SLIDER_ATTR}]`).length,
    ).toBe(initial + 1);

    removeButton(0).click();
    expect(scene.curveTargets.length).toBe(initial);
    // Removing wave 1 shifts the remaining targets left by one.
    expect(scene.curveTargets).toEqual([
      ...DEFAULT_DIFFICULTY_CURVE.slice(1),
      50,
    ]);
  });

  it('AC3 — moving a slider updates the curve and the value readout', async () => {
    const scene = await boot();
    setSlider(0, '77');
    expect(scene.curveTargets[0]).toBe(77);
    expect(valueReadout(0).textContent).toBe('77');
  });

  // ── AC5 — edit-to-clear behaviour ────────────────────────────────

  it('AC5 — editing the curve clears the wave list and shows the instruction', async () => {
    const scene = await boot();
    // Boot shows a preview by default.
    expect(scene.isPreviewStale).toBe(false);
    expect(scene.wavePreview.length).toBe(DEFAULT_DIFFICULTY_CURVE.length);

    setSlider(0, '45');

    expect(scene.isPreviewStale).toBe(true);
    expect(scene.wavePreview).toEqual([]);
    expect(findText(scene, CURVE_PREVIEW_STALE_TEXT)).toBeDefined();
    // No table header or wave rows remain on the canvas.
    expect(findTableHeader(scene)).toBeUndefined();
    expect(findWaveRows(scene)).toHaveLength(0);

    // Adding a wave also clears the preview.
    expect(scene.isPreviewStale).toBe(true);
    (panel()!.querySelector(`#${CURVE_ADD_BUTTON_ID}`) as HTMLButtonElement).click();
    expect(scene.isPreviewStale).toBe(true);
    expect(scene.wavePreview).toEqual([]);
  });

  // ── AC4 — regenerate ─────────────────────────────────────────────

  it('AC4 — Regenerate runs the sequencer and repopulates the wave list', async () => {
    const scene = await boot();
    setSlider(1, '55');
    expect(scene.isPreviewStale).toBe(true);

    (
      panel()!.querySelector(`#${CURVE_REGENERATE_BUTTON_ID}`) as HTMLButtonElement
    ).click();

    expect(scene.isPreviewStale).toBe(false);
    expect(scene.wavePreview.length).toBe(scene.curveTargets.length);
    expect(findText(scene, CURVE_PREVIEW_STALE_TEXT)).toBeUndefined();
    expect(findTableHeader(scene)).toBeDefined();
    expect(findWaveRows(scene)).toHaveLength(scene.curveTargets.length);
  });

  // ── AC6/AC10/AC11 — wave table + column guide ───────────────────

  it('AC6/AC10 — renders a heading row plus one aligned row per wave', async () => {
    const scene = await boot();
    const curve = scene.curveTargets;
    const preview = scene.wavePreview;

    expect(preview.length).toBe(curve.length);
    preview.forEach((entry, index) => {
      expect(entry.waveNumber).toBe(index + 1);
      expect(entry.targetDifficulty).toBe(curve[index]);
      expect(entry.actualDifficulty).toBeGreaterThanOrEqual(0);
      expect(entry.actualDifficulty).toBeLessThanOrEqual(100);
      // Signed error is target minus actual (AC6).
      expect(entry.error).toBeCloseTo(
        entry.targetDifficulty - entry.actualDifficulty,
        5,
      );
      // Composition renders as `<enemyKey> ×<count>`.
      expect(entry.composition).toMatch(/^[a-z0-9-]+ ×\d+/);
      expect(typeof entry.shootEnabled).toBe('boolean');
    });

    // The table header carries every column heading and the value columns line up.
    const header = findTableHeader(scene);
    expect(header, 'wave-table header row missing').toBeDefined();
    for (const column of WAVE_TABLE_COLUMNS) {
      expect(header!.text).toContain(column.heading);
    }

    // One row per wave, each showing target, actual, error, composition and shooting.
    const rows = findWaveRows(scene);
    expect(rows).toHaveLength(preview.length);
    rows.forEach((row, index) => {
      const entry = preview[index];
      expect(row.text).toContain(String(entry.targetDifficulty));
      expect(row.text).toContain(entry.actualDifficulty.toFixed(1));
      expect(row.text).toContain(entry.composition);
      expect(row.text).toContain(entry.shootEnabled ? 'yes' : 'no');
      // Same fixed width as the header keeps the columns aligned.
      expect(row.text.length).toBe(header!.text.length);
    });
  });

  it('AC11 — renders a bottom-right help box summarising every column', async () => {
    const scene = await boot();
    const helpBox = findHelpBox(scene);
    expect(helpBox, 'column-guide help box missing').toBeDefined();
    expect(helpBox!.text).toContain(CURVE_HELP_BOX_TITLE);
    for (const column of WAVE_TABLE_COLUMNS) {
      expect(helpBox!.text).toContain(column.heading);
      expect(helpBox!.text).toContain(column.help);
    }
    // Anchored to the bottom-right of the canvas.
    expect(helpBox!.x).toBeGreaterThan(GAME_WIDTH / 2);
    expect(helpBox!.y).toBeGreaterThan(GAME_HEIGHT / 2);
  });

  // ── Wave table formatting (pure) ─────────────────────────────────

  describe('wave table formatting (AC6/AC10/AC11)', () => {
    const sampleEntry: WavePreviewEntry = {
      waveNumber: 3,
      targetDifficulty: 42,
      actualDifficulty: 40.5,
      error: 1.5,
      composition: 'scout ×12',
      shootEnabled: true,
    };

    it('formats a header naming every column and a row with each cell', () => {
      const widths = waveTableColumnWidths([sampleEntry]);
      const header = formatWaveTableHeader(widths);
      for (const column of WAVE_TABLE_COLUMNS) {
        expect(header).toContain(column.heading);
      }

      const row = formatWaveTableRow(sampleEntry, widths);
      expect(row).toContain('3');
      expect(row).toContain('42');
      expect(row).toContain('40.5');
      expect(row).toContain('+1.5');
      expect(row).toContain('scout ×12');
      expect(row).toContain('yes');
      // Fixed-width cells make the header and every row the same width.
      expect(row.length).toBe(header.length);
    });

    it('renders a negative error without a leading plus sign', () => {
      const entry: WavePreviewEntry = {
        ...sampleEntry,
        error: -0.5,
        shootEnabled: false,
      };
      const row = formatWaveTableRow(entry, waveTableColumnWidths([entry]));
      expect(row).toContain('-0.5');
      expect(row).not.toContain('+-0.5');
      expect(row).toContain('no');
    });

    it('help box lists every column heading and its explanation', () => {
      const help = formatCurveHelpBox();
      expect(help.startsWith(CURVE_HELP_BOX_TITLE)).toBe(true);
      for (const column of WAVE_TABLE_COLUMNS) {
        expect(help).toContain(column.heading);
        expect(help).toContain(column.help);
      }
    });
  });

  // ── AC7/AC8 — navigation ─────────────────────────────────────────

  it('AC7 — the ← INDEX button returns to the gym index', async () => {
    booted = await bootScene([GymCurveSequencer, GymIndex]);
    const scene = booted.scene as GymCurveSequencer;
    expect(scene.sys.isActive()).toBe(true);
    expect(booted.game.scene.isActive(GYM_INDEX_KEY)).toBe(false);

    const button = findText(scene, BACK_TO_INDEX_LABEL);
    expect(button, 'back-to-index button missing').toBeDefined();
    button!.emit('pointerdown');
    await tick();

    expect(booted.game.scene.isActive(GYM_INDEX_KEY)).toBe(true);
    expect(scene.sys.isActive()).toBe(false);
  });

  it('AC8 — pressing ESC returns to the main menu', async () => {
    booted = await bootScene([GymCurveSequencer, MenuScene]);
    const scene = booted.scene as GymCurveSequencer;
    expect(scene.sys.isActive()).toBe(true);
    expect(booted.game.scene.isActive('MenuScene')).toBe(false);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await tick();

    expect(booted.game.scene.isActive('MenuScene')).toBe(true);
    expect(scene.sys.isActive()).toBe(false);
  });
});
