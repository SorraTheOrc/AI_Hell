/**
 * AH-0MV4D7LAD009XYR0 — bot-tuning gym scene.
 *
 * Verifies the scene is discoverable, that its panel exposes one control per
 * tunable, that the bot actually plays the generated level, and that the
 * Save / Save As / Load wiring persists and restores configurations.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import {
  BOT_TUNING_CONFIG_SELECT_ID,
  BOT_TUNING_PANEL_ID,
  BOT_TUNING_SAVE_AS_ID,
  BOT_TUNING_SAVE_AS_INPUT_ID,
  BOT_TUNING_SLIDER_ATTR,
  BOT_TUNING_SLIDER_VALUE_ATTR,
  BOT_TUNING_TOGGLE_ATTR,
  GYM_BOT_TUNING_SCENE_KEY,
  GymBotTuning,
  type GymBotTuningData,
} from './GymBotTuning';
import {
  BOT_TUNING_NUMERIC_FIELDS,
  BOT_TUNING_TOGGLES,
} from '../../ai/tuningFields';
import {
  listBotTuningNames,
  resetBotTuningStore,
} from '../../core/botTuningStore';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';

/** Waits for Phaser scene transitions to settle. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 200));

describe('GymBotTuning — AI bot tuning gym (AH-0MV4D7LAD009XYR0)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="game-container"></div>';
    resetBotTuningStore();
    window.localStorage.clear();
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function bootTuning(data?: GymBotTuningData): Promise<GymBotTuning> {
    booted = await bootScene([GymBotTuning]);
    const manager = booted.game.scene;
    manager.start(GYM_BOT_TUNING_SCENE_KEY, data);
    await tick();
    return manager.getScene(GYM_BOT_TUNING_SCENE_KEY) as GymBotTuning;
  }

  it('is discovered by the gym index glob', () => {
    const keys = discoverGymScenes(loadGymSceneModules()).map((entry) => entry.key);
    expect(keys).toContain(GYM_BOT_TUNING_SCENE_KEY);
  });

  it('builds a panel with one control per declared tunable', async () => {
    await bootTuning({ seed: 101 });

    const panel = document.getElementById(BOT_TUNING_PANEL_ID);
    expect(panel).not.toBeNull();

    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      expect(
        panel!.querySelector(`input[${BOT_TUNING_SLIDER_ATTR}="${field.key}"]`),
      ).not.toBeNull();
    }
    for (const toggle of BOT_TUNING_TOGGLES) {
      expect(
        panel!.querySelector(`input[${BOT_TUNING_TOGGLE_ATTR}="${toggle.key}"]`),
      ).not.toBeNull();
    }

    const select = document.getElementById(BOT_TUNING_CONFIG_SELECT_ID) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain('Default');
  });

  it('has the bot play the generated random level', async () => {
    const scene = await bootTuning({ seed: 4242 });
    booted!.game.loop.stop();

    expect(scene.getEnemies().length).toBeGreaterThan(0);
    const startX = scene.getShip()!.getMovementState().x;
    const startY = scene.getShip()!.getMovementState().y;

    let fired = false;
    for (let i = 0; i < 300; i += 1) {
      scene.tick(1 / 60);
      if (scene.getPlayerBullets().length > 0) fired = true;
    }

    const end = scene.getShip()!.getMovementState();
    const moved = Math.hypot(end.x - startX, end.y - startY) > 5;
    // The bot drives the ship through the shared seam and auto-fires.
    expect(moved || fired).toBe(true);
  });

  it('applies a slider change live and updates its readout', async () => {
    const scene = await bootTuning({ seed: 7 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    input.value = '900';
    input.dispatchEvent(new Event('input'));

    const output = document.querySelector<HTMLElement>(
      `output[${BOT_TUNING_SLIDER_VALUE_ATTR}="powerUpSeekRange"]`,
    )!;
    expect(output.textContent).toBe('900');
    // The scene keeps running after the live rebuild.
    expect(scene.getShip()).not.toBeNull();
    expect(() => scene.tick(1 / 60)).not.toThrow();
  });

  it('Save As persists a named configuration and Load restores it', async () => {
    await bootTuning({ seed: 9 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    input.value = '750';
    input.dispatchEvent(new Event('input'));

    const nameInput = document.getElementById(BOT_TUNING_SAVE_AS_INPUT_ID) as HTMLInputElement;
    nameInput.value = 'PowerUp-Rush';
    document
      .getElementById(BOT_TUNING_SAVE_AS_ID)!
      .dispatchEvent(new MouseEvent('click'));

    expect(listBotTuningNames()).toContain('PowerUp-Rush');
    const select = document.getElementById(BOT_TUNING_CONFIG_SELECT_ID) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toContain('PowerUp-Rush');

    // Change the slider, then load the saved config back.
    input.value = '100';
    input.dispatchEvent(new Event('input'));
    select.value = 'PowerUp-Rush';
    select.dispatchEvent(new Event('change'));

    expect(input.value).toBe('750');
  });
});
