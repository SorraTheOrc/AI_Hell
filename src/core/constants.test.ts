import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from './config';
import {
  GAME_BACKGROUND_COLOR,
  GAME_HEIGHT,
  GAME_WIDTH,
  MAX_SPEED,
  SHIP_COLOR,
  SHIP_SIZE,
  THRUST_ACCELERATION,
  THRUST_FLAME_COLOR,
  THRUST_FLAME_INNER_COLOR,
  THRUST_FLAME_LENGTH,
} from './constants';

describe('core game constants (GDD §6.4 scaffold)', () => {
  it('declares a 16:9 canvas resolution', () => {
    // The GDD fixes no resolution; the scaffold baseline is 16:9 (960x540).
    expect(GAME_WIDTH / GAME_HEIGHT).toBeCloseTo(16 / 9, 5);
  });

  it('declares positive, renderable dimensions', () => {
    expect(GAME_WIDTH).toBeGreaterThan(0);
    expect(GAME_HEIGHT).toBeGreaterThan(0);
  });

  it('declares a background colour in Phaser hex format', () => {
    expect(GAME_BACKGROUND_COLOR).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('re-exports ship tuning constants from the config module', () => {
    expect(THRUST_ACCELERATION).toBe(DEFAULT_CONFIG.thrustAcceleration);
    expect(MAX_SPEED).toBe(DEFAULT_CONFIG.maxSpeed);
    expect(SHIP_SIZE).toBe(DEFAULT_CONFIG.shipSize);
    expect(THRUST_FLAME_LENGTH).toBe(DEFAULT_CONFIG.thrustFlameLength);
    expect(SHIP_COLOR).toBe(DEFAULT_CONFIG.shipColor);
    expect(THRUST_FLAME_COLOR).toBe(DEFAULT_CONFIG.thrustFlameColor);
    expect(THRUST_FLAME_INNER_COLOR).toBe(DEFAULT_CONFIG.thrustFlameInnerColor);
  });
});