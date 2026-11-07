/**
 * Scene-level tests for the GymRechargeTuning gym (AH-0MV82IAYG000WS8B).
 *
 * Covers the work item's acceptance criteria: gym discovery, the permanent
 * Phase Shift / Teleport grants, the two slider DOM contracts (ids, labels,
 * ranges, step, seconds output), live application to the recharge timers,
 * the rules persistence round-trip and `null` fallback, the two-group raider
 * spawn with shooting on, and the in-panel SHOOT toggle.
 *
 * Uses the shared game harness (Phaser headless via happy-dom) and drives the
 * scene deterministically; no rasterised canvas checks.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createReusableBoot } from '../../test/gameHarness';
import { DEFAULT_CONFIG } from '../../core/config';
import { seedConfigStore } from '../../core/configStore';
import { GAME_WIDTH } from '../../core/constants';
import {
  DEFAULT_RULES,
  RULES_SCHEMA_VERSION,
  RULES_STORAGE_KEY,
  loadRules,
  saveRules,
} from '../../core/rules';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import {
  PHASE_RECHARGE_SLIDER_ID,
  TELEPORT_RECHARGE_SLIDER_ID,
} from '../../utils/gymPowerUpControl';
import {
  GymRechargeTuning,
  RAIDER_GROUP_ORIGINS,
  RAIDER_GROUP_SIZE,
  RECHARGE_PANEL_ID,
  RECHARGE_SHOOT_ID,
} from './GymRechargeTuning';

/**
 * One Phaser game shell per file, rebooted into a fresh scene instance per
 * test (AH-0MVF6VZG9000AN6E).
 */
const reuse = createReusableBoot();
afterAll(() => reuse.dispose());

beforeEach(() => {
  window.localStorage.clear();
  // The scene's shared player step consumes the control-scheme config; seed
  // the four-directional scheme the gym tests drive (mirrors the other gyms).
  seedConfigStore([], { ...DEFAULT_CONFIG, controlScheme: 'fourDirectional' });
  document.getElementById(RECHARGE_PANEL_ID)?.remove();
});

async function bootTuning(): Promise<GymRechargeTuning> {
  const booted = await reuse.boot([GymRechargeTuning]);
  return booted!.scene as GymRechargeTuning;
}

/** Moves a range input and dispatches the same `input` event a drag fires. */
function setSlider(id: string, value: number): void {
  const input = document.querySelector<HTMLInputElement>(`#${id}`);
  expect(input, `slider #${id} missing`).not.toBeNull();
  input!.value = String(value);
  input!.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Discovery ──────────────────────────────────────────────────────

describe('GymRechargeTuning: discovery and boot', () => {
  it('is auto-discovered from the gym folder with the GymRechargeTuning key', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === 'GymRechargeTuning');
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('RechargeTuning');
  });

  it('boots as an active scene with the player at screen centre', async () => {
    const scene = await bootTuning();
    expect(scene.sys.isActive()).toBe(true);
    const player = scene.getPlayer();
    expect(player).toBeDefined();
    expect(player!.x).toBeCloseTo(GAME_WIDTH / 2);
  });
});

// ── Permanent grants ───────────────────────────────────────────────

describe('GymRechargeTuning: permanent Phase Shift + Teleport grants', () => {
  it('owns both abilities from the first frame without collecting a drop', async () => {
    const scene = await bootTuning();
    const registry = scene.getEffectsRegistry();

    expect(registry.isConsumableOwned('phase_shift')).toBe(true);
    // Phase Shift is a recharging pool: the grant banks a charge and completed
    // recharges fill the pool up to its regenerating ceiling of 3.
    expect(registry.phaseCharges()).toBeGreaterThanOrEqual(1);
    expect(
      registry.levelStore().consumableRegenCeiling('phase_shift'),
    ).toBe(3);
    expect(registry.isConsumableOwned('teleport')).toBe(true);
    // Teleport is single-use: its permanent grant leaves the warp ready.
    expect(registry.hasTeleport()).toBe(true);
  });

  it('starts each ability on its level-derived recharge time when no override is persisted', async () => {
    const scene = await bootTuning();
    const store = scene.getEffectsRegistry().levelStore();

    expect(store.rechargeTimeOverride('phase_shift')).toBeNull();
    expect(store.rechargeTimeOverride('teleport')).toBeNull();
    expect(store.phaseRechargeTime()).toBe(30);
    expect(store.teleportRechargeTime()).toBe(60);
  });
});

// ── Slider DOM ─────────────────────────────────────────────────────

describe('GymRechargeTuning: recharge slider DOM', () => {
  it('renders a .gym-panel with both recharge sliders', async () => {
    await bootTuning();
    const panel = document.getElementById(RECHARGE_PANEL_ID);
    expect(panel, 'recharge-gym-panel missing').not.toBeNull();
    expect(panel!.className).toContain('gym-panel');
  });

  it('exposes the Phase Shift slider with its label, range, step and seconds output', async () => {
    await bootTuning();
    const input = document.querySelector<HTMLInputElement>(
      `#${PHASE_RECHARGE_SLIDER_ID}`,
    );
    expect(input).not.toBeNull();
    expect(input!.type).toBe('range');
    expect(input!.min).toBe('1');
    expect(input!.max).toBe('60');
    expect(input!.step).toBe('0.5');
    // Seeded from the level-derived default while unset.
    expect(input!.value).toBe('30');

    const label = input!.closest('label');
    expect(label!.textContent).toContain('Phase Shift recharge');
    const output = label!.querySelector('output');
    expect(output!.textContent).toBe('30s');
  });

  it('exposes the Teleport slider with its label, range, step and seconds output', async () => {
    await bootTuning();
    const input = document.querySelector<HTMLInputElement>(
      `#${TELEPORT_RECHARGE_SLIDER_ID}`,
    );
    expect(input).not.toBeNull();
    expect(input!.type).toBe('range');
    expect(input!.min).toBe('1');
    expect(input!.max).toBe('120');
    expect(input!.step).toBe('0.5');
    expect(input!.value).toBe('60');

    const label = input!.closest('label');
    expect(label!.textContent).toContain('Teleport recharge');
    const output = label!.querySelector('output');
    expect(output!.textContent).toBe('60s');
  });

  it('updates the readout in seconds as the slider moves', async () => {
    await bootTuning();
    const input = document.querySelector<HTMLInputElement>(
      `#${PHASE_RECHARGE_SLIDER_ID}`,
    );
    setSlider(PHASE_RECHARGE_SLIDER_ID, 8);
    const output = input!.closest('label')!.querySelector('output');
    expect(output!.textContent).toBe('8s');
  });
});

// ── Live application to the recharge timers ───────────────────────

describe('GymRechargeTuning: slider changes apply to subsequently spent charges', () => {
  it('applies a new Phase Shift recharge time to the next spent charge', async () => {
    const scene = await bootTuning();
    const store = scene.getEffectsRegistry().levelStore();

    setSlider(PHASE_RECHARGE_SLIDER_ID, 8);
    expect(store.phaseRechargeTime()).toBe(8);
    expect(store.rechargeTimeOverride('phase_shift')).toBe(8);

    expect(store.consumeConsumableCharge('phase_shift')).toBe(true);
    const progress = store.consumableRechargeProgress('phase_shift');
    expect(progress).not.toBeNull();
    expect(progress!.total).toBe(8);
    expect(progress!.remaining).toBeCloseTo(8);
  });

  it('applies a new Teleport recharge time to the next spent warp', async () => {
    const scene = await bootTuning();
    const store = scene.getEffectsRegistry().levelStore();

    setSlider(TELEPORT_RECHARGE_SLIDER_ID, 12);
    expect(store.teleportRechargeTime()).toBe(12);

    expect(store.consumeTeleport()).toBe(true);
    expect(store.teleportRechargeRemaining()).toBe(12);
  });

  it('does not retro-fit an in-flight timer when the slider moves mid-recharge', async () => {
    const scene = await bootTuning();
    const store = scene.getEffectsRegistry().levelStore();

    setSlider(PHASE_RECHARGE_SLIDER_ID, 8);
    expect(store.consumeConsumableCharge('phase_shift')).toBe(true);
    // The wait captured at spend time is immutable.
    setSlider(PHASE_RECHARGE_SLIDER_ID, 20);
    expect(store.phaseRechargeTime()).toBe(20);
    expect(store.consumableRechargeProgress('phase_shift')!.total).toBe(8);
  });
});

// ── Persistence round-trip ────────────────────────────────────────

describe('GymRechargeTuning: slider values persist and are re-applied', () => {
  it('persists both overrides into the rules config as they move', async () => {
    await bootTuning();

    setSlider(PHASE_RECHARGE_SLIDER_ID, 8);
    setSlider(TELEPORT_RECHARGE_SLIDER_ID, 12.5);

    const rules = loadRules();
    expect(rules.phaseRechargeOverrideSeconds).toBe(8);
    expect(rules.teleportRechargeOverrideSeconds).toBe(12.5);
  });

  it('re-applies persisted overrides on the next scene create', async () => {
    saveRules({
      ...DEFAULT_RULES,
      phaseRechargeOverrideSeconds: 8,
      teleportRechargeOverrideSeconds: 12.5,
    });

    const scene = await bootTuning();
    const store = scene.getEffectsRegistry().levelStore();
    expect(store.rechargeTimeOverride('phase_shift')).toBe(8);
    expect(store.rechargeTimeOverride('teleport')).toBe(12.5);
    expect(store.phaseRechargeTime()).toBe(8);
    expect(store.teleportRechargeTime()).toBe(12.5);

    // Each slider is seeded from the persisted override, not the default.
    expect(
      document.querySelector<HTMLInputElement>(`#${PHASE_RECHARGE_SLIDER_ID}`)!
        .value,
    ).toBe('8');
    expect(
      document.querySelector<HTMLInputElement>(
        `#${TELEPORT_RECHARGE_SLIDER_ID}`,
      )!.value,
    ).toBe('12.5');
  });
});

// ── Null fallback ─────────────────────────────────────────────────

describe('GymRechargeTuning: null override fallback', () => {
  it('seeds both sliders from the level-derived default when the override is unset', async () => {
    const scene = await bootTuning();
    expect(
      document.querySelector<HTMLInputElement>(`#${PHASE_RECHARGE_SLIDER_ID}`)!
        .value,
    ).toBe('30');
    expect(
      document.querySelector<HTMLInputElement>(
        `#${TELEPORT_RECHARGE_SLIDER_ID}`,
      )!.value,
    ).toBe('60');
    expect(scene.getEffectsRegistry().levelStore().phaseRechargeTime()).toBe(30);
    expect(
      scene.getEffectsRegistry().levelStore().teleportRechargeTime(),
    ).toBe(60);
  });

  it('treats an explicit null (and a corrupt value) as level-derived', async () => {
    window.localStorage.setItem(
      RULES_STORAGE_KEY,
      JSON.stringify({
        version: RULES_SCHEMA_VERSION,
        phaseRechargeOverrideSeconds: null,
        teleportRechargeOverrideSeconds: 'not-a-number',
      }),
    );

    const scene = await bootTuning();
    const store = scene.getEffectsRegistry().levelStore();
    expect(store.rechargeTimeOverride('phase_shift')).toBeNull();
    expect(store.rechargeTimeOverride('teleport')).toBeNull();
    expect(store.phaseRechargeTime()).toBe(30);
    expect(store.teleportRechargeTime()).toBe(60);
    expect(
      document.querySelector<HTMLInputElement>(`#${PHASE_RECHARGE_SLIDER_ID}`)!
        .value,
    ).toBe('30');
  });
});

// ── Two-group raider spawn + shooting ─────────────────────────────

describe('GymRechargeTuning: two raider groups with shooting on', () => {
  it('spawns one group left and one group right of the player', async () => {
    const scene = await bootTuning();
    const raiders = scene.getRaiders();

    expect(RAIDER_GROUP_ORIGINS).toHaveLength(2);
    expect(raiders).toHaveLength(RAIDER_GROUP_SIZE * RAIDER_GROUP_ORIGINS.length);

    const left = raiders.filter((raider) => raider.x < GAME_WIDTH / 2);
    const right = raiders.filter((raider) => raider.x > GAME_WIDTH / 2);
    expect(left).toHaveLength(RAIDER_GROUP_SIZE);
    expect(right).toHaveLength(RAIDER_GROUP_SIZE);
  });

  it('enables aimed shooting by default on every raider', async () => {
    const scene = await bootTuning();
    expect(scene.shootingEnabled).toBe(true);
    for (const raider of scene.getRaiders()) {
      expect(raider.archetype).toBe('raider');
      expect(raider.shootEnabled).toBe(true);
      expect(raider.effectiveShotPattern).toBe('aimed');
    }
  });

  it('toggles shooting from the in-panel SHOOT control', async () => {
    const scene = await bootTuning();
    const shoot = document.getElementById(
      RECHARGE_SHOOT_ID,
    ) as HTMLButtonElement | null;
    expect(shoot).not.toBeNull();
    expect(shoot!.textContent).toBe('SHOOT: ON');

    shoot!.click();
    expect(scene.shootingEnabled).toBe(false);
    expect(shoot!.textContent).toBe('SHOOT: OFF');
    for (const raider of scene.getRaiders()) {
      expect(raider.shootEnabled).toBe(false);
    }

    shoot!.click();
    expect(scene.shootingEnabled).toBe(true);
    expect(shoot!.textContent).toBe('SHOOT: ON');
  });
});
