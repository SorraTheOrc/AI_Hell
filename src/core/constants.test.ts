import { describe, expect, it } from 'vitest';

import { GAME_BACKGROUND_COLOR, GAME_HEIGHT, GAME_WIDTH } from './constants';

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
});