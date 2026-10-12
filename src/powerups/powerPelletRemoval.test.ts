/**
 * Regression guard for the wholesale removal of the Power Pellet
 * (AH-0MV5CB6KO0079N08).
 *
 * The Pac-Man-inspired Power Pellet and the shared frightened-enemy status
 * layer it served were deleted completely rather than hidden. This test pins
 * the player-facing surfaces the item used to appear on — the catalogue, the
 * default drop weights and the hold-full choice pool — so it can never be
 * spawned or offered again. It also guards against over-removal: every other
 * shipped power-up must still be present.
 *
 * This is a behavioural absence test (public catalogues only), not a source
 * grep.
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_CATALOGUE, COMBAT_POWER_UP_IDS } from './types';
import { CHOICE_POOL } from './choice';
import { POWER_UP_LEVEL_IDS, POWER_UP_LEVEL_VARIABLES } from './powerUpLevels';
import {
  DEFAULT_RULES,
  POWER_UP_WEIGHT_IDS,
  defaultPowerUpWeights,
} from '../core/rules';

/** The shipped power-up ids that must survive the removal. */
const REMAINING_POWER_UP_IDS = [
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'smart_bomb',
  'force_field',
  'mystery_ufo',
] as const;

describe('Power Pellet removal — cannot be spawned or offered (AH-0MV5CB6KO0079N08)', () => {
  it('is absent from the power-up catalogue', () => {
    expect(Object.keys(POWER_UP_CATALOGUE)).not.toContain('power_pellet');
  });

  it('is absent from the default drop weight table', () => {
    expect(POWER_UP_WEIGHT_IDS).not.toContain('power_pellet' as never);
    expect(defaultPowerUpWeights()).not.toHaveProperty('power_pellet');
    expect(DEFAULT_RULES.powerUpWeights).not.toHaveProperty('power_pellet');
  });

  it('is absent from the hold-full choice pool', () => {
    expect(CHOICE_POOL).not.toContain('power_pellet' as never);
  });

  it('is absent from the combat round-robin and the level catalogue', () => {
    expect(COMBAT_POWER_UP_IDS).not.toContain('power_pellet' as never);
    expect(POWER_UP_LEVEL_IDS).not.toContain('power_pellet' as never);
  });

  it('removes the fright level variables with it', () => {
    expect(POWER_UP_LEVEL_VARIABLES).not.toContain(
      'frightenDuration' as never,
    );
    expect(POWER_UP_LEVEL_VARIABLES).not.toContain(
      'frightenSpeedMultiplier' as never,
    );
  });

  it('does not over-remove: every other shipped power-up remains', () => {
    for (const id of REMAINING_POWER_UP_IDS) {
      expect(POWER_UP_CATALOGUE).toHaveProperty(id);
      expect(POWER_UP_WEIGHT_IDS).toContain(id);
      expect(DEFAULT_RULES.powerUpWeights).toHaveProperty(id);
      expect(CHOICE_POOL).toContain(id);
      expect(POWER_UP_LEVEL_IDS).toContain(id);
    }
  });
});
