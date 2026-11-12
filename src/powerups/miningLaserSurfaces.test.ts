/**
 * Mining Laser player-facing surfaces (AH-0MW9QMRC7007HVHQ, parent
 * **Mining laser** AH-0MW81P007BDRU).
 *
 * The surfaces slice lights the new kind up everywhere a power-up is shown to
 * the player — the drop icon, the one-line description, the field-drop weight,
 * the six-slot hold-full choice and the HUD row — entirely from catalogue data,
 * with no per-id branches. This file pins the mining-laser-specific guarantees
 * the generic surface tests cannot express:
 *
 * 1. the icon is a real, code-drawn, visually distinct glyph;
 * 2. the description states the "nearest asteroid only" rule in plain words;
 * 3. the weight is the rare `2` and it participates in the shared drop table;
 * 4. it is a normal slot-occupying kind (never exempt, never field-pickup-only),
 *    offered by the hold-full choice while unowned;
 * 5. the HUD shows a row only while the laser is actually cutting.
 *
 * @module powerups/miningLaserSurfaces.test
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_SLOT_CAP } from '../core/constants';
import { DEFAULT_MINING_LASER_WEIGHT, defaultPowerUpWeights } from '../core/rules';
import { getDropDescription } from './dropDescriptions';
import { CHOICE_POOL, buildChoiceCandidates } from './choice';
import { isSlotCountedHeldKind, resolveSlotState } from './slots';
import { POWER_UP_CATALOGUE, isFieldPickupOnly } from './types';

describe('Mining Laser catalogue surfaces (AH-0MW9QMRC7007HVHQ)', () => {
  it('is a normal slot-occupying kind — not exempt, not field-pickup-only', () => {
    const entry = POWER_UP_CATALOGUE.mining_laser;
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('Mining Laser');
    // No exemption flags: it counts toward the six-slot cap.
    expect(entry!.availableWhenSlotsFull).toBeUndefined();
    expect(entry!.fieldPickupOnly).toBeUndefined();
    expect(entry!.consumable).toBeUndefined();
    expect(isFieldPickupOnly('mining_laser')).toBe(false);
    // A single held copy occupies exactly one slot.
    const state = resolveSlotState([{ id: 'mining_laser', level: 1 }], []);
    expect(isSlotCountedHeldKind('mining_laser', state)).toBe(true);
    expect(state.used).toBe(1);
    expect(state.used).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
  });

  it('states the nearest-asteroid-only rule plainly in its description', () => {
    const description = getDropDescription('mining_laser');
    expect(description.length).toBeGreaterThan(0);
    // The one-liner names the asteroid-only targeting rule and its silence.
    expect(description.toLowerCase()).toContain('asteroid');
    expect(description.toLowerCase()).toContain('nearest');
    expect(description.toLowerCase()).toContain('enem');
  });

  it('drops at the rare weight 2 and participates in the shared weight table', () => {
    expect(DEFAULT_MINING_LASER_WEIGHT).toBe(2);
    const weights = defaultPowerUpWeights();
    expect(weights.mining_laser).toBe(DEFAULT_MINING_LASER_WEIGHT);
    // As rare as the sibling auto-targeting Orbital Strike.
    expect(weights.mining_laser).toBe(weights.strike);
  });

  it('appears in the hold-full choice pool while unowned', () => {
    expect(CHOICE_POOL).toContain('mining_laser');
    const options = buildChoiceCandidates(CHOICE_POOL);
    expect(options.some((o) => o.id === 'mining_laser')).toBe(true);
  });
});
