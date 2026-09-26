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
import { BACK_TO_INDEX_LABEL, GYM_INDEX_KEY } from '../../utils/gymNavigation';
import { GymIndex } from '../GymIndex';
import { MenuScene } from '../MenuScene';
import {
  CURVE_ADD_BUTTON_ID,
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

/** Finds an on-screen text starting with a prefix. */
function findTextStartingWith(
  scene: Phaser.Scene,
  prefix: string,
): Phaser.GameObjects.Text | undefined {
  return scene.children.list.find(
    (child): child is Phaser.GameObjects.Text =>
      child instanceof Phaser.GameObjects.Text && child.text.startsWith(prefix),
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
    // No wave lines remain on the canvas.
    expect(findTextStartingWith(scene, 'Wave 1')).toBeUndefined();

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
    expect(findTextStartingWith(scene, 'Wave 1')).toBeDefined();
  });

  // ── AC6 — wave list contents ─────────────────────────────────────

  it('AC6 — each wave entry shows target, actual, error, composition and shooting', async () => {
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

    // The first wave line is rendered on the canvas.
    const firstLine = findTextStartingWith(scene, 'Wave 1');
    expect(firstLine).toBeDefined();
    expect(firstLine!.text).toContain('target');
    expect(firstLine!.text).toContain('actual');
    expect(firstLine!.text).toContain('shooting:');
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
