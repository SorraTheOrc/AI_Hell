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
  CURVE_DEFAULT_MODE,
  CURVE_HELP_BOX_TITLE,
  CURVE_LAUNCH_LEVEL_LABEL,
  CURVE_LAUNCH_WAVE_LABEL_PREFIX,
  CURVE_LEVEL_HEADING_PREFIX,
  CURVE_MODE_OPTIONS,
  CURVE_PANEL_ID,
  CURVE_PREVIEW_STALE_TEXT,
  CURVE_REGENERATE_BUTTON_ID,
  CURVE_TARGET_MAX,
  CURVE_TARGET_MIN,
  CURVE_TARGET_TOLERANCE,
  CURVE_WAVE_DERIVED_ATTR,
  CURVE_WAVE_MODE_ATTR,
  CURVE_WAVE_REMOVE_ATTR,
  CURVE_WAVE_SLIDER_ATTR,
  CURVE_WAVE_VALUE_ATTR,
  CURVE_WAVES_PER_LEVEL,
  DEFAULT_DIFFICULTY_CURVE,
  GymCurveSequencer,
  WAVE_TABLE_COLUMNS,
  buildCurveLevels,
  formatCurveHelpBox,
  formatWaveTableHeader,
  formatWaveTableRow,
  groupWavesByLevel,
  toWaveDefinition,
  waveTableColumnWidths,
  type WavePreviewEntry,
} from './GymCurveSequencer';
import { GymLevel } from './GymLevel';
import type { ShootableWave } from '../../core/difficultySequencer';

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

/**
 * Preview launch buttons of one kind (`level` or `wave`), in render order.
 * Level buttons carry {@link CURVE_LAUNCH_LEVEL_LABEL}; wave buttons start
 * with {@link CURVE_LAUNCH_WAVE_LABEL_PREFIX}.
 */
function findLaunchButtons(
  scene: Phaser.Scene,
  kind: 'level' | 'wave',
): Phaser.GameObjects.Text[] {
  return scene.children.list.filter(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text &&
      child.getData('curveLaunch') === true &&
      (kind === 'level'
        ? child.text === CURVE_LAUNCH_LEVEL_LABEL
        : child.text.startsWith(CURVE_LAUNCH_WAVE_LABEL_PREFIX)),
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

  const modeControl = (index: number): HTMLSelectElement =>
    panel()!.querySelector(
      `select[${CURVE_WAVE_MODE_ATTR}="${index}"]`,
    ) as HTMLSelectElement;

  const setSlider = (index: number, value: string): void => {
    const input = slider(index);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  const setMode = (index: number, value: string): void => {
    const select = modeControl(index);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
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

  // ── Generation-mode control (AH-0MUJSUT8P008UPQM) ──────────────

  it('renders a labelled mode control with curve/fixed/dynamic, default curve', async () => {
    const scene = await boot();
    const controls = panel()!.querySelectorAll(
      `select[${CURVE_WAVE_MODE_ATTR}]`,
    );
    expect(controls.length).toBe(DEFAULT_DIFFICULTY_CURVE.length);
    expect(scene.waveModes).toEqual(
      DEFAULT_DIFFICULTY_CURVE.map(() => CURVE_DEFAULT_MODE),
    );

    for (let i = 0; i < DEFAULT_DIFFICULTY_CURVE.length; i++) {
      const control = modeControl(i);
      expect(control.value).toBe('curve');
      expect([...control.options].map((o) => o.value)).toEqual([
        ...CURVE_MODE_OPTIONS,
      ]);
      // Labelled + keyboard reachable (native select, aria-label).
      expect(control.getAttribute('aria-label')).toContain(String(i + 1));
    }
  });

  it('choosing fixed disables the target slider and shows the derived difficulty', async () => {
    const scene = await boot();
    setMode(1, 'fixed');

    expect(scene.waveModes[1]).toBe('fixed');
    expect(slider(1).disabled).toBe(true);
    // The readout is a derived (non-editable) value, not the raw target.
    const derived = Number(valueReadout(1).textContent);
    expect(Number.isFinite(derived)).toBe(true);
    expect(valueReadout(1).getAttribute(CURVE_WAVE_DERIVED_ATTR)).toBe('true');
    // The slider cannot change the value while disabled.
    expect(slider(1).value).toBe(String(DEFAULT_DIFFICULTY_CURVE[1]));
  });

  it('choosing curve or dynamic re-enables the editable target slider', async () => {
    const scene = await boot();
    setMode(0, 'fixed');
    expect(slider(0).disabled).toBe(true);

    setMode(0, 'dynamic');
    expect(scene.waveModes[0]).toBe('dynamic');
    expect(slider(0).disabled).toBe(false);
    expect(valueReadout(0).getAttribute(CURVE_WAVE_DERIVED_ATTR)).toBeNull();
    expect(valueReadout(0).textContent).toBe(String(scene.curveTargets[0]));

    setMode(0, 'curve');
    expect(scene.waveModes[0]).toBe('curve');
    expect(slider(0).disabled).toBe(false);
    setSlider(0, '64');
    expect(scene.curveTargets[0]).toBe(64);
    expect(valueReadout(0).textContent).toBe('64');
  });

  it('changing a mode marks the preview stale and clears the wave list', async () => {
    const scene = await boot();
    expect(scene.isPreviewStale).toBe(false);

    setMode(2, 'dynamic');

    expect(scene.isPreviewStale).toBe(true);
    expect(scene.wavePreview).toEqual([]);
    expect(findText(scene, CURVE_PREVIEW_STALE_TEXT)).toBeDefined();
    expect(findTableHeader(scene)).toBeUndefined();
    expect(findWaveRows(scene)).toHaveLength(0);
  });

  it('regenerating reflects the mode: fixed previews derived difficulty, others sequenced', async () => {
    const scene = await boot();
    setMode(0, 'fixed');
    setMode(1, 'dynamic');
    (
      panel()!.querySelector(`#${CURVE_REGENERATE_BUTTON_ID}`) as HTMLButtonElement
    ).click();

    const preview = scene.wavePreview;
    expect(preview).toHaveLength(scene.curveTargets.length);
    expect(preview[0].mode).toBe('fixed');
    expect(typeof preview[0].derivedDifficulty).toBe('number');
    expect(preview[0].composition.length).toBeGreaterThan(0);
    expect(preview[1].mode).toBe('dynamic');
    expect(preview[1].derivedDifficulty).toBeUndefined();
    // The fixed wave's table row shows the derived difficulty, not the target.
    const fixedRow = findWaveRows(scene).find((row) =>
      row.text.includes(preview[0].composition),
    );
    expect(fixedRow!.text).toContain(String(preview[0].derivedDifficulty));
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
      // AC12 — the generated wave lands within a small tolerance of target.
      expect(
        Math.abs(entry.actualDifficulty - entry.targetDifficulty),
      ).toBeLessThanOrEqual(CURVE_TARGET_TOLERANCE + 2);
      // Composition renders as one or more `<enemyKey> ×<count>` groups.
      expect(entry.composition).toMatch(
        /^[a-z0-9-]+ ×\d+( \+ [a-z0-9-]+ ×\d+)*$/,
      );
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
      expect(row.text).toContain(entry.composition);
      expect(row.text).toContain(entry.shootEnabled ? 'yes' : 'no');
      // Same fixed width as the header keeps the columns aligned.
      expect(row.text.length).toBe(header!.text.length);
    });
  });

  it('AC12 — targets above the old single-group ceiling are matched, up to 100', async () => {
    const scene = await boot();
    const targets = [10, 30, 50, 70, 90, 100];
    targets.forEach((t, i) => setSlider(i, String(t)));
    (
      panel()!.querySelector(`#${CURVE_REGENERATE_BUTTON_ID}`) as HTMLButtonElement
    ).click();

    const preview = scene.wavePreview;
    expect(preview).toHaveLength(targets.length);
    preview.forEach((entry, index) => {
      expect(entry.targetDifficulty).toBe(targets[index]);
      expect(
        Math.abs(entry.actualDifficulty - entry.targetDifficulty),
      ).toBeLessThanOrEqual(CURVE_TARGET_TOLERANCE + 2);
    });
    // The previous single-group sequencer saturated near 33; the top target
    // must now genuinely exceed that ceiling.
    expect(preview[preview.length - 1].actualDifficulty).toBeGreaterThan(80);
  });

  it('AC13 — higher targets yield varied, multi-group compositions', async () => {
    const scene = await boot();
    const targets = [50, 60, 70, 80, 90, 100];
    targets.forEach((t, i) => setSlider(i, String(t)));
    (
      panel()!.querySelector(`#${CURVE_REGENERATE_BUTTON_ID}`) as HTMLButtonElement
    ).click();

    const preview = scene.wavePreview;
    expect(preview).toHaveLength(targets.length);
    preview.forEach((entry, index) => {
      expect(entry.targetDifficulty).toBe(targets[index]);
      expect(
        Math.abs(entry.actualDifficulty - entry.targetDifficulty),
      ).toBeLessThanOrEqual(CURVE_TARGET_TOLERANCE + 2);
    });
    // No two consecutive high waves repeat the exact same composition.
    for (let i = 1; i < preview.length; i++) {
      expect(preview[i].composition).not.toBe(preview[i - 1].composition);
    }
    // The very high targets require composing more than one group.
    expect(preview[preview.length - 1].composition).toContain(' + ');
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
      actualDifficulty: 41.5,
      composition: 'scout ×12 + phaser ×4',
      shootEnabled: true,
      mode: 'curve',
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
      expect(row).toContain('scout ×12 + phaser ×4');
      expect(row).toContain('yes');
      // Fixed-width cells make the header and every row the same width.
      expect(row.length).toBe(header.length);
    });

    it('renders a non-firing wave as "no"', () => {
      const entry: WavePreviewEntry = {
        ...sampleEntry,
        shootEnabled: false,
      };
      const row = formatWaveTableRow(entry, waveTableColumnWidths([entry]));
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

  // ── Level grouping + launch buttons (AH-0MUNU6MGM007CI45) ──────

  describe('level grouping (AC1/AC2, AH-0MUNU6MGM007CI45)', () => {
    /** A minimal sequencer wave with one scout group. */
    function wave(count: number): ShootableWave {
      return {
        groups: [
          {
            enemyKey: 'scout',
            formation: 'v',
            count,
            spacingX: 30,
            spacingY: 26,
            startX: 200,
            startY: 150,
            score: 5,
          },
        ],
        shootEnabled: false,
        targetDifficulty: 10,
      };
    }

    it('groupWavesByLevel partitions in order, last group short', () => {
      expect(groupWavesByLevel([1, 2, 3, 4, 5], 2)).toEqual([
        [1, 2],
        [3, 4],
        [5],
      ]);
      expect(groupWavesByLevel([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    });

    it('groupWavesByLevel handles empty and non-positive group sizes', () => {
      expect(groupWavesByLevel([], 3)).toEqual([]);
      expect(groupWavesByLevel([1, 2], 0)).toEqual([[1, 2]]);
      expect(groupWavesByLevel([1, 2], -1)).toEqual([[1, 2]]);
    });

    it('toWaveDefinition drops the sequencer-only score and keeps the shape', () => {
      const def = toWaveDefinition(wave(7));
      expect(def.shootEnabled).toBe(false);
      expect(def.groups).toHaveLength(1);
      expect(def.groups[0]).toEqual({
        enemyKey: 'scout',
        formation: 'v',
        count: 7,
        spacingX: 30,
        spacingY: 26,
        startX: 200,
        startY: 150,
      });
      expect('score' in def.groups[0]).toBe(false);
    });

    it('buildCurveLevels folds waves into level definitions', () => {
      const levels = buildCurveLevels([wave(1), wave(2), wave(3), wave(4)], 3);
      expect(levels).toHaveLength(2);
      expect(levels[0].level).toBe(1);
      expect(levels[0].waves).toHaveLength(3);
      expect(levels[1].level).toBe(2);
      expect(levels[1].waves).toHaveLength(1);
      expect(levels[0].waves[1].groups[0].count).toBe(2);
    });

    it('exposes curveLevels and a level group per chunk after Regenerate', async () => {
      booted = await bootScene([GymCurveSequencer]);
      const scene = booted.scene as GymCurveSequencer;
      const expectedGroups = Math.ceil(
        DEFAULT_DIFFICULTY_CURVE.length / CURVE_WAVES_PER_LEVEL,
      );
      expect(scene.wavesPerLevel).toBe(CURVE_WAVES_PER_LEVEL);
      expect(scene.curveLevels).toHaveLength(expectedGroups);
      const totalWaves = scene.curveLevels.reduce(
        (sum, level) => sum + level.waves.length,
        0,
      );
      expect(totalWaves).toBe(DEFAULT_DIFFICULTY_CURVE.length);
    });

    it('AC1 — renders a level heading + Launch Level button per group', async () => {
      booted = await bootScene([GymCurveSequencer]);
      const scene = booted.scene as GymCurveSequencer;
      const groups = scene.curveLevels.length;

      for (let i = 0; i < groups; i++) {
        expect(
          findText(scene, `${CURVE_LEVEL_HEADING_PREFIX} ${i + 1}`),
          `level heading ${i + 1} missing`,
        ).toBeDefined();
      }
      const levelButtons = findLaunchButtons(scene, 'level');
      expect(levelButtons).toHaveLength(groups);
    });

    it('AC1 — clicking Launch Level boots GymLevel with the level waves', async () => {
      booted = await bootScene([GymCurveSequencer, GymLevel]);
      const scene = booted.scene as GymCurveSequencer;
      const expected = scene.curveLevels[0];

      findLaunchButtons(scene, 'level')[0].emit('pointerdown');
      await tick();

      const launched = booted.game.scene.getScene('GymLevel') as GymLevel;
      expect(booted.game.scene.isActive('GymLevel')).toBe(true);
      expect(launched.getLabel()).toBe(expected.name);
      expect(launched.getWavesToPlayCount()).toBe(expected.waves.length);
      // The launched level's first wave matches the generated composition.
      expect(launched.getCurrentWave()?.groups[0].enemyKey).toBe(
        expected.waves[0].groups[0].enemyKey,
      );
    });

    it('AC2 — renders one Launch Wave button per wave row', async () => {
      booted = await bootScene([GymCurveSequencer]);
      const scene = booted.scene as GymCurveSequencer;
      const waveButtons = findLaunchButtons(scene, 'wave');
      expect(waveButtons).toHaveLength(scene.wavePreview.length);
      waveButtons.forEach((button, index) => {
        expect(button.text).toBe(
          `${CURVE_LAUNCH_WAVE_LABEL_PREFIX} ${index + 1}`,
        );
      });
    });

    it('AC2 — clicking Launch Wave boots GymLevel with only that wave', async () => {
      booted = await bootScene([GymCurveSequencer, GymLevel]);
      const scene = booted.scene as GymCurveSequencer;

      findLaunchButtons(scene, 'wave')[1].emit('pointerdown');
      await tick();

      const launched = booted.game.scene.getScene('GymLevel') as GymLevel;
      expect(booted.game.scene.isActive('GymLevel')).toBe(true);
      expect(launched.getWavesToPlayCount()).toBe(1);
      expect(launched.getLabel()).toBe('Wave 2');
      expect(launched.getCurrentWave()?.groups[0].enemyKey).toBe(
        scene.curveLevels[0].waves[1].groups[0].enemyKey,
      );
    });

    it('editing the curve removes the launch buttons until Regenerate', async () => {
      booted = await bootScene([GymCurveSequencer]);
      const scene = booted.scene as GymCurveSequencer;
      expect(findLaunchButtons(scene, 'level').length).toBeGreaterThan(0);

      setSlider(0, '55');
      expect(findLaunchButtons(scene, 'level')).toHaveLength(0);
      expect(findLaunchButtons(scene, 'wave')).toHaveLength(0);

      (
        panel()!.querySelector(
          `#${CURVE_REGENERATE_BUTTON_ID}`,
        ) as HTMLButtonElement
      ).click();
      expect(findLaunchButtons(scene, 'level').length).toBeGreaterThan(0);
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
