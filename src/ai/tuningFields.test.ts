/**
 * AH-0MV4D7LAD009XYR0 — bot-tuning field registry.
 *
 * The registry is the gym's designer-facing surface: every slider/toggle maps
 * to one entry here, and it must faithfully read the shipped defaults from the
 * competent tunables / human-input tunables (including the nested
 * `commitment.*` and `world.*` overrides) and reconstruct them for the brain.
 */

import { describe, expect, it } from 'vitest';

import {
  BOT_TUNING_NUMERIC_FIELDS,
  BOT_TUNING_TOGGLES,
  coerceTuningValues,
  defaultBotTuningValues,
  readTuningBoolean,
  readTuningNumber,
  toCompetentOverrides,
  toHumanOverrides,
  writeTuningBoolean,
  writeTuningNumber,
} from './tuningFields';
import { COMPETENT_BOT_TUNABLES } from './framework/competent/tunables';
import { BOT_HUMAN_INPUT_TUNABLES } from './botHumanLike';
import { BOT_WORLD_TUNABLES } from './framework/worldModel';

/** Looks a spec up by its flat key. */
function numericField(key: string) {
  const field = BOT_TUNING_NUMERIC_FIELDS.find((entry) => entry.key === key);
  if (!field) throw new Error(`missing numeric field ${key}`);
  return field;
}

describe('bot tuning fields (AH-0MV4D7LAD009XYR0)', () => {
  it('exposes at least one control per tunable group', () => {
    const competent = BOT_TUNING_NUMERIC_FIELDS.filter((f) => f.group === 'competent');
    const human = BOT_TUNING_NUMERIC_FIELDS.filter((f) => f.group === 'human');
    expect(competent.length).toBeGreaterThan(20);
    expect(human.length).toBeGreaterThan(5);
    expect(BOT_TUNING_TOGGLES.length).toBeGreaterThan(0);
  });

  it('seeds sliders from the shipped tunable defaults (including nested overrides)', () => {
    const values = defaultBotTuningValues();
    expect(readTuningNumber(values, numericField('mineralSeekRange'))).toBe(
      COMPETENT_BOT_TUNABLES.mineralSeekRange,
    );
    expect(readTuningNumber(values, numericField('engagementRange'))).toBe(
      COMPETENT_BOT_TUNABLES.engagementRange,
    );
    // Nested commitment override owned by the competent tunables.
    expect(readTuningNumber(values, numericField('commitment.minCommitSeconds'))).toBe(
      COMPETENT_BOT_TUNABLES.commitment.minCommitSeconds,
    );
    // Nested world override falls back to the world-model defaults.
    expect(readTuningNumber(values, numericField('world.horizon'))).toBe(
      BOT_WORLD_TUNABLES.horizon,
    );
    // Human-input cadence.
    expect(readTuningNumber(values, numericField('reactionTimeMs'))).toBe(
      BOT_HUMAN_INPUT_TUNABLES.reactionTimeMs,
    );
    expect(readTuningBoolean(values, BOT_TUNING_TOGGLES[0])).toBe(true);
  });

  it('round-trips writes, including nested and clamped values', () => {
    const values = defaultBotTuningValues();
    const field = numericField('commitment.switchMargin');
    writeTuningNumber(values, field, 1.25);
    expect(readTuningNumber(values, field)).toBe(1.25);
    // Out-of-range values clamp to the declared bounds.
    writeTuningNumber(values, field, 999);
    expect(readTuningNumber(values, field)).toBe(field.max);
    const toggle = BOT_TUNING_TOGGLES.find((t) => t.key === 'allowDown')!;
    writeTuningBoolean(values, toggle, true);
    expect(readTuningBoolean(values, toggle)).toBe(true);
  });

  it('reconstructs nested competent overrides for the brain', () => {
    const values = defaultBotTuningValues();
    values.competent['mineralSeekRange'] = 123;
    values.competent['commitment.switchMargin'] = 0.42;
    values.competent['world.horizon'] = 1.5;
    const overrides = toCompetentOverrides(values);
    expect(overrides.mineralSeekRange).toBe(123);
    expect(overrides.commitment?.switchMargin).toBe(0.42);
    expect(overrides.world?.horizon).toBe(1.5);
  });

  it('reconstructs flat human overrides for the governor', () => {
    const values = defaultBotTuningValues();
    values.human['reactionTimeMs'] = 500;
    const overrides = toHumanOverrides(values);
    expect(overrides.reactionTimeMs).toBe(500);
  });

  it('coerces partial/corrupt values onto the defaults', () => {
    const values = coerceTuningValues({
      competent: { mineralSeekRange: 250, bogus: 'nope', commitment: null },
      human: { reactionTimeMs: 999 },
    });
    expect(values.competent['mineralSeekRange']).toBe(250);
    expect(values.competent['bogus']).toBeUndefined();
    expect(values.human['reactionTimeMs']).toBe(999);
    // Missing fields keep their defaults.
    expect(values.competent['engagementRange']).toBe(COMPETENT_BOT_TUNABLES.engagementRange);
  });
});

describe('bot rotation skills knobs (AH-0MV1DUSM2005HL98 AC4)', () => {
  it('exposes the skill and aim-lead controls with shipped defaults', () => {
    const values = defaultBotTuningValues();
    expect(readTuningNumber(values, numericField('skill'))).toBe(
      BOT_HUMAN_INPUT_TUNABLES.skill,
    );
    expect(readTuningNumber(values, numericField('maxAimErrorRad'))).toBe(
      BOT_HUMAN_INPUT_TUNABLES.maxAimErrorRad,
    );
    expect(readTuningNumber(values, numericField('aimLeadAlignSeconds'))).toBe(
      COMPETENT_BOT_TUNABLES.aimLeadAlignSeconds,
    );
    expect(readTuningNumber(values, numericField('aimLeadIterations'))).toBe(
      COMPETENT_BOT_TUNABLES.aimLeadIterations,
    );
    const toggle = BOT_TUNING_TOGGLES.find((t) => t.key === 'aimLeadEnabled');
    expect(toggle).toBeDefined();
    expect(readTuningBoolean(values, toggle!)).toBe(true);
  });

  it('round-trips the new knobs into the brain and governor overrides', () => {
    const values = defaultBotTuningValues();
    values.competent['aimLeadEnabled'] = false;
    values.competent['aimLeadIterations'] = 5;
    values.human['skill'] = 0.25;
    values.human['maxAimErrorRad'] = 0.6;

    const competent = toCompetentOverrides(values);
    expect(competent.aimLeadEnabled).toBe(false);
    expect(competent.aimLeadIterations).toBe(5);
    const human = toHumanOverrides(values);
    expect(human.skill).toBe(0.25);
    expect(human.maxAimErrorRad).toBe(0.6);
  });

  it('keeps the new sliders inside sensible declared bounds', () => {
    // A designer must be able to dial skill to 0 and 1, and the aim error cap
    // must be able to reach zero (no error) and a meaningful maximum.
    const skill = numericField('skill');
    expect(skill.min).toBe(0);
    expect(skill.max).toBe(1);
    const maxError = numericField('maxAimErrorRad');
    expect(maxError.min).toBe(0);
    expect(maxError.max).toBeGreaterThan(0);
    const iterations = numericField('aimLeadIterations');
    expect(iterations.min).toBeGreaterThanOrEqual(1);
  });
});

describe('bot tuning tooltip descriptions (AH-0MV4XGXVL001GSB2)', () => {
  it('gives every declared numeric field a non-empty description', () => {
    const missing = BOT_TUNING_NUMERIC_FIELDS.filter(
      (field) =>
        typeof field.description !== 'string' ||
        field.description.trim().length === 0,
    ).map((field) => field.key);
    expect(missing).toEqual([]);
  });

  it('gives every declared toggle a non-empty description', () => {
    const missing = BOT_TUNING_TOGGLES.filter(
      (toggle) =>
        typeof toggle.description !== 'string' ||
        toggle.description.trim().length === 0,
    ).map((toggle) => toggle.key);
    expect(missing).toEqual([]);
  });
});
