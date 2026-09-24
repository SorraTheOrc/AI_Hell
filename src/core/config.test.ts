import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_CONFIG,
  loadShipConfig,
  saveShipConfig,
  type ShipConfig,
} from './config';
import { resetConfigStore, seedConfigStore } from './configStore';

describe('ship configuration module', () => {
  beforeEach(() => {
    resetConfigStore();
    vi.unstubAllEnvs();
  });

  it('exposes default values matching the current hard-coded constants', () => {
    expect(DEFAULT_CONFIG.thrustAcceleration).toBe(300);
    expect(DEFAULT_CONFIG.maxSpeed).toBe(175);
    expect(DEFAULT_CONFIG.shipSize).toBe(20);
    expect(DEFAULT_CONFIG.thrustFlameLength).toBe(0.75);
    expect(DEFAULT_CONFIG.shipColor).toBe(0x00ffff);
    expect(DEFAULT_CONFIG.thrustFlameColor).toBe(0xff8c00);
    expect(DEFAULT_CONFIG.thrustFlameInnerColor).toBe(0xffff00);
    expect(DEFAULT_CONFIG.frictionDeceleration).toBe(100);
    expect(DEFAULT_CONFIG.controlScheme).toBe('asteroids');
    expect(DEFAULT_CONFIG.asteroidsRotationSpeed).toBe(3);
  });

  it('falls back to defaults before the boot loader has run', () => {
    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('loads the ship config from the CSV-backed registry', () => {
    const tuned: ShipConfig = { ...DEFAULT_CONFIG, maxSpeed: 260, shipSize: 30 };
    seedConfigStore([], tuned);

    expect(loadShipConfig()).toEqual(tuned);
    // Prove the value came from the registry, not the defaults.
    expect(loadShipConfig().maxSpeed).toBe(260);
  });

  it('returns copies so callers cannot mutate the registry', () => {
    seedConfigStore([], { ...DEFAULT_CONFIG, maxSpeed: 260 });
    const first = loadShipConfig();
    first.maxSpeed = 1;
    expect(loadShipConfig().maxSpeed).toBe(260);
  });

  it('saveShipConfig delegates to the store and reports unavailability in production', async () => {
    vi.stubEnv('DEV', false);
    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 999 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('saveShipConfig resolves to a status object in dev mode', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('DEV', true);

    const result = await saveShipConfig({ ...DEFAULT_CONFIG, maxSpeed: 250 });
    expect(result).toHaveProperty('ok');
    vi.unstubAllGlobals();
  });
});
