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
  BOT_TUNING_EXPORT_ID,
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
import {
  GYM_TOOLTIP_CLASS,
  GYM_TOOLTIP_VISIBLE_CLASS,
} from '../../utils/gymTooltip';
import { GYM_LEVEL_MINERAL_SEED_COUNT } from './GymLevel';
import { Diver } from '../../entities/Diver';
import { Harvester } from '../../entities/Harvester';
import type { LevelDefinition, WaveDefinition } from '../../waves/Formations';

/** A single-group, non-firing scout wave. */
function scoutWave(count: number): WaveDefinition {
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
      },
    ],
    shootEnabled: false,
  };
}

/** Wraps waves in a level definition. */
function makeLevel(name: string, waves: WaveDefinition[]): LevelDefinition {
  return { level: 1, name, waves };
}

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

  // ── AC11 — shared supply layer (producer-audit fix) ─────────────

  it('seeds the shared mineral field and exposes the live supplies to the bot snapshot', async () => {
    const scene = await bootTuning({ seed: 2024 });
    booted!.game.loop.stop();

    // The inherited `GymLevel` supply layer seeded the game's mineral field.
    expect(scene.getSeededMineralCount()).toBe(GYM_LEVEL_MINERAL_SEED_COUNT);
    expect(scene.getMinerals().length).toBeGreaterThan(0);

    // The bot snapshot sees the live minerals and drops, so its
    // `collect-mineral` / `collect-powerup` / `secure-life` goals can fire.
    const snapshot = scene.getBotSnapshot();
    expect(snapshot.minerals.length).toBeGreaterThan(0);
    expect(snapshot.drops.length).toBeGreaterThan(0);
  });

  it('carries the live ship thruster config into the bot snapshot (AH-0MV85WFWD0029DL7)', async () => {
    const scene = await bootTuning({ seed: 303 });
    booted!.game.loop.stop();

    const snapshot = scene.getBotSnapshot();
    // The gym's player satisfies the `BotPlayerSource` seam, so the snapshot
    // player carries the ship's effective thruster physics unchanged.
    expect(snapshot.player!.thruster).toEqual(
      scene.getShip()!.getThrusterConfig(),
    );
  });

  it('leaves minerals behind when an enemy is destroyed through the shared combat path', async () => {
    const scene = await bootTuning({
      seed: 5,
      level: makeLevel('Single', [scoutWave(1)]),
    });
    booted!.game.loop.stop();

    const enemies = scene.getEnemies();
    expect(enemies).toHaveLength(1);
    const before = new Set(scene.getMinerals());

    // Force the shared kill-drop rule to draw its additive bonus so the
    // non-asteroid enemy deterministically leaves one mineral; then kill it
    // through the shared collision path (a player bullet).
    scene.setSupplyRng(() => 0.99);
    scene.getShip()!.respawn(20, 20);
    scene.spawnPlayerBullet(enemies[0].x, enemies[0].y, 0, 0, 0x00ffff, 10);
    scene.tick(1 / 60);

    expect(scene.getEnemies().filter((enemy) => enemy.alive)).toHaveLength(0);
    const added = scene.getMinerals().filter((mineral) => !before.has(mineral));
    expect(added.length).toBeGreaterThanOrEqual(1);
  });

  it('spawns and collects a weapon drop through the shared drop layer', async () => {
    const scene = await bootTuning({ seed: 11 });
    booted!.game.loop.stop();

    const ship = scene.getShip()!;
    expect(ship.hasWeapon('rapid')).toBe(false);

    ship.respawn(300, 300);
    const drop = scene.spawnSupplyDrop('rapid', 300, 300);
    expect(scene.getDrops()).toContain(drop);

    scene.tick(1 / 60);
    // The shared `_collectDrop` path equipped the weapon.
    expect(ship.hasWeapon('rapid')).toBe(true);
  });

  it('collects a mineral into the shared hold', async () => {
    const scene = await bootTuning({ seed: 3 });
    booted!.game.loop.stop();

    const ship = scene.getShip()!;
    const mineral = scene.getMinerals()[0];
    const before = new Set(scene.getMinerals());

    ship.respawn(mineral.x, mineral.y);
    scene.tick(1 / 60);

    const after = scene.getMinerals();
    expect(after.length).toBeLessThan(before.size);
  });

  // ── Live-aim & mineral-seek regressions (AH-0MV5SDMMF008O55Q) ──────

  /**
   * Test-first reconciliation (AH-0MV5SDMMF008O55Q): these regressions were
   * written red-first under Vitest's `it.fails(...)` and the adoption item
   * AH-0MV5SDNI2008RWQ2 removed the expected-failure wrapper once `GymLevel`
   * adopted the shared live-targeting helper — they are now hard gates.
   */

  it('AH-0MV5SDMMF008O55Q — a Diver\'s aim target tracks the live player in bot-tuning gym', async () => {
    const scene = await bootTuning({
      seed: 42,
      level: makeLevel('Aim', [
        {
          groups: [
            {
              enemyKey: 'diver',
              formation: 'v',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 200,
              startY: 100,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });
    booted!.game.loop.stop();

    const diver = scene.getEnemies().find(
      (e): e is Diver => e instanceof Diver,
    );
    expect(diver, 'Diver not spawned').toBeDefined();

    const ship = scene.getShip()!;

    // The aim push runs at the start of `tick`, before the bot drives the
    // ship that frame, so capture the ship position first. The aim target
    // must equal the ship position at the moment of the push.
    const beforeX = ship.x;
    const beforeY = ship.y;

    // Advance one frame — this is where the live-aim push must fire.
    scene.tick(1 / 60);

    // After the push, the Diver\'s aimTarget equals the ship position at push
    // time, NOT the bottom-centre default.
    const aim = diver!.aimTarget;
    expect(aim.x).toBeCloseTo(beforeX, 5);
    expect(aim.y).toBeCloseTo(beforeY, 5);
  });

  it('AH-0MV5SDMMF008O55Q — a Harvester receives the live mineral field in bot-tuning gym', async () => {
    const scene = await bootTuning({
      seed: 123,
      level: makeLevel('Seek', [
        {
          groups: [
            {
              enemyKey: 'harvester',
              formation: 'v',
              count: 1,
              spacingX: 30,
              spacingY: 26,
              startX: 200,
              startY: 100,
            },
          ],
          shootEnabled: false,
        },
      ]),
    });
    booted!.game.loop.stop();

    const harvester = scene.getEnemies().find(
      (e): e is Harvester => e instanceof Harvester,
    );
    expect(harvester, 'Harvester not spawned').toBeDefined();

    const minerals = scene.getMinerals();
    expect(minerals.length, 'no minerals seeded').toBeGreaterThan(0);

    // Advance one frame — the mineral-seek push must fire.
    scene.tick(1 / 60);

    // The Harvester must have selected a live mineral as its target.
    expect(harvester!.seekTargetX).not.toBeNull();
    expect(harvester!.seekTargetY).not.toBeNull();
  });

  // ── Per-parameter tooltips (AH-0MV4XGXVL001GSB2) ────────────────

  // ── Config export (AH-0MV6MFDYG001E6PL) ──────────────────────────

  it('Export downloads the persisted store state as JSON (AH-0MV6MFDYG001E6PL)', async () => {
    await bootTuning({ seed: 42 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    input.value = '825';
    input.dispatchEvent(new Event('input'));
    const nameInput = document.getElementById(BOT_TUNING_SAVE_AS_INPUT_ID) as HTMLInputElement;
    nameInput.value = 'Exportable';
    document.getElementById(BOT_TUNING_SAVE_AS_ID)!.dispatchEvent(new MouseEvent('click'));

    // Capture the Blob the Export button hands to a download link.
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {});

    document
      .getElementById(BOT_TUNING_EXPORT_ID)!
      .dispatchEvent(new MouseEvent('click'));
    await tick();

    expect(clickSpy).toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalled();
    const blob = createSpy.mock.calls[0][0] as Blob;
    const parsed = JSON.parse(await blob.text());
    expect(parsed.current).toBe('Exportable');
    const exported = parsed.configs.find(
      (config: { name: string }) => config.name === 'Exportable',
    );
    expect(exported.values.competent['powerUpSeekRange']).toBe(825);
  });

  it('associates every slider and toggle with a tooltip holding its description', async () => {
    await bootTuning({ seed: 77 });

    const panel = document.getElementById(BOT_TUNING_PANEL_ID)!;
    for (const field of BOT_TUNING_NUMERIC_FIELDS) {
      const input = panel.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_SLIDER_ATTR}="${field.key}"]`,
      )!;
      assertTooltip(input, field.description, field.key);
    }
    for (const toggle of BOT_TUNING_TOGGLES) {
      const input = panel.querySelector<HTMLInputElement>(
        `input[${BOT_TUNING_TOGGLE_ATTR}="${toggle.key}"]`,
      )!;
      assertTooltip(input, toggle.description, toggle.key);
    }
  });

  it('reveals the tooltip on hover and keyboard focus, hidden by default', async () => {
    await bootTuning({ seed: 78 });

    const input = document.querySelector<HTMLInputElement>(
      `input[${BOT_TUNING_SLIDER_ATTR}="powerUpSeekRange"]`,
    )!;
    const tooltip = document.getElementById(input.getAttribute('aria-describedby')!)!;

    // Hidden until the designer hovers or focuses the control.
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);
    input.dispatchEvent(new Event('pointerenter'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(true);
    input.dispatchEvent(new Event('pointerleave'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);

    // Keyboard users get the same help without a mouse.
    input.dispatchEvent(new Event('focus'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(true);
    input.dispatchEvent(new Event('blur'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);
  });

  /**
   * Asserts `control` is wired to a `.gym-tooltip` via `aria-describedby`
   * and that the tooltip text is exactly the spec's description.
   */
  function assertTooltip(
    control: HTMLInputElement,
    expectedText: string,
    key: string,
  ): void {
    const describedBy = control.getAttribute('aria-describedby');
    expect(describedBy, `${key} aria-describedby`).toBeTruthy();
    const tooltip = document.getElementById(describedBy!);
    expect(tooltip, `${key} tooltip exists`).not.toBeNull();
    expect(tooltip!.classList.contains(GYM_TOOLTIP_CLASS), `${key} class`).toBe(true);
    expect(tooltip!.textContent, `${key} text`).toBe(expectedText);
  }
});
