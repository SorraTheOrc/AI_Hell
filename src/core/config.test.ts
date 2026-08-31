import { beforeEach, describe, expect, it } from 'vitest';

import {
  CONFIG_STORAGE_KEY,
  DEFAULT_CONFIG,
  loadShipConfig,
  saveShipConfig,
  type ShipConfig,
} from './config';

describe('ship configuration module', () => {
  beforeEach(() => {
    window.localStorage.clear();
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
    expect(DEFAULT_CONFIG.controlScheme).toBe('fourDirectional');
    expect(DEFAULT_CONFIG.asteroidsRotationSpeed).toBe(3);
  });

  it('falls back to defaults when nothing has been saved', () => {
    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('loads a previously saved config', () => {
    const custom: ShipConfig = {
      ...DEFAULT_CONFIG,
      maxSpeed: 175,
      thrustAcceleration: 300,
    };
    saveShipConfig(custom);

    expect(loadShipConfig()).toEqual(custom);
  });

  it('falls back to defaults when the stored JSON is corrupt', () => {
    window.localStorage.setItem(CONFIG_STORAGE_KEY, '{not valid json');

    expect(loadShipConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('round-trips a saved config exactly', () => {
    const custom: ShipConfig = {
      thrustAcceleration: 450,
      maxSpeed: 999,
      shipSize: 30,
      thrustFlameLength: 1.2,
      shipColor: 0x112233,
      thrustFlameColor: 0x445566,
      thrustFlameInnerColor: 0x778899,
      frictionDeceleration: 50,
      controlScheme: 'asteroids',
      asteroidsRotationSpeed: 4.5,
    };
    saveShipConfig(custom);

    const loaded = loadShipConfig();

    expect(loaded).toEqual(custom);
    // Prove the value came from storage, not from the defaults.
    expect(loaded.shipColor).toBe(0x112233);
  });

  it('merges scheme defaults over a pre-scheme (legacy) saved config', () => {
    // A config saved before the control-scheme feature has no scheme fields;
    // loading must fall back to the 4-directional defaults (AC4 compat).
    const legacy = {
      thrustAcceleration: 350,
      maxSpeed: 200,
      shipSize: 25,
      thrustFlameLength: 0.8,
      shipColor: 0x00ffff,
      thrustFlameColor: 0xff8c00,
      thrustFlameInnerColor: 0xffff00,
      frictionDeceleration: 80,
    };
    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(legacy));

    const loaded = loadShipConfig();
    expect(loaded.thrustAcceleration).toBe(350);
    expect(loaded.controlScheme).toBe('fourDirectional');
    expect(loaded.asteroidsRotationSpeed).toBe(3);
  });
});