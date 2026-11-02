/**
 * Bundled bot-tuning baseline file tests (AH-0MV9LCWVI002TOK7 — subtask of
 * AH-0MV9GZD2C005IIU3).
 *
 * Verifies the Git-tracked `src/data/bot-tuning.json` baseline: it exists,
 * parses as valid JSON, matches the exported store shape
 * `{ version, current, configs }`, carries a `Default`-named entry with the
 * shipped tuning values, and round-trips through the Bot Tuning gym's Export
 * output (`serialiseBotTuningState()`) so the tune → Export → commit → build
 * refresh workflow preserves the shipped tuning.
 *
 * It also pins the **curated promo presets** added for the promo-video
 * catalogue (AH-0MVSDM5T1007KBB8): each preset is a sparse override map,
 * `coerceTuningValues` completes it deterministically, every preset differs
 * from `Default` in its documented tuning key, its values stay inside the
 * gym's slider bounds, and every `preset` a registered promo scenario names
 * actually exists in the bundled state.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CAPTURE_SCENARIOS } from '../../scripts/capture-scenarios.mjs';
import {
  BOT_TUNING_NUMERIC_FIELDS,
  BOT_TUNING_TOGGLES,
  coerceTuningValues,
  type BotTuningValues,
} from '../ai/tuningFields';
import {
  BOT_TUNING_SCHEMA_VERSION,
  DEFAULT_BOT_TUNING_NAME,
  resetBotTuningStore,
  serialiseBotTuningState,
} from '../core/botTuningStore';
import { parseBotTuningStateBlob } from '../core/botTuningSchema';

/**
 * The curated promo presets and their documented intent.
 *
 * `distinguishingKey` is the tuning key each preset was authored to move away
 * from `Default`; the tests use it as the objective proof that the preset is
 * meaningfully distinct (AC2) rather than a renamed copy of `Default`.
 */
const CURATED_PRESETS = [
  {
    name: 'aggressive-hunter',
    intent: 'Close-range hunter: picks fights sooner, seeks enemies across the whole screen.',
    distinguishingKey: 'enemySeekRange',
  },
  {
    name: 'cautious-collector',
    intent: 'Collection-first: long mineral/life/power-up reach, wider danger margin.',
    distinguishingKey: 'mineralSeekRange',
  },
  {
    name: 'evasive',
    intent: 'Survival-first: high avoid priority, wide threat radius, more retreat space.',
    distinguishingKey: 'dangerMargin',
  },
  {
    name: 'glass-cannon',
    intent: 'All-out offence: tight engagement range and low clearance weight.',
    distinguishingKey: 'engagementRange',
  },
  {
    name: 'relentless-hunter',
    intent: 'Promo hook: hunts across the screen with a wide threat bubble and retreat room.',
    distinguishingKey: 'enemyBase',
  },
  {
    name: 'barrage-dodger',
    intent: 'Promo crossfire: survival above all against a wide orbital threat bubble.',
    distinguishingKey: 'threatRadius',
  },
  {
    name: 'cordon-breaker',
    intent: 'Promo cordon: kites the player-targeting duo at long standoff range.',
    distinguishingKey: 'reverseRetreatRange',
  },
  {
    name: 'gauntlet-runner',
    intent: 'Promo finale: outlasts the every-showcase gauntlet between dense waves.',
    distinguishingKey: 'survivalBase',
  },
] as const;

function readBotTuningFile(): string {
  return readFileSync(resolve(__dirname, 'bot-tuning.json'), 'utf8');
}

/** The store's fresh-state serialisation (no localStorage interference). */
function freshExportBlob(): string {
  resetBotTuningStore();
  window.localStorage.clear();
  return serialiseBotTuningState();
}

type RawConfig = { name: string; values: unknown };

/** The configs as authored in the committed file (sparse overrides preserved). */
function rawConfigs(): RawConfig[] {
  return (JSON.parse(readBotTuningFile()) as { configs: RawConfig[] }).configs;
}

/** The `Default` values the store serves, fully coerced. */
function defaultValues(): BotTuningValues {
  const raw = rawConfigs().find((config) => config.name === DEFAULT_BOT_TUNING_NAME);
  if (raw === undefined) throw new Error('bundled baseline has no Default config');
  return coerceTuningValues(raw.values);
}

/** Coerced values of one authored preset. */
function coercedPreset(name: string): BotTuningValues {
  const raw = rawConfigs().find((config) => config.name === name);
  if (raw === undefined) throw new Error(`bundled baseline has no "${name}" preset`);
  return coerceTuningValues(raw.values);
}

describe('bot-tuning.json bundled baseline (AH-0MV9LCWVI002TOK7)', () => {
  it('exists and parses as valid JSON', () => {
    const raw = readBotTuningFile();
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('matches the exported store shape { version, current, configs }', () => {
    const parsed = JSON.parse(readBotTuningFile()) as {
      version: unknown;
      current: unknown;
      configs: unknown;
    };
    expect(parsed.version).toBe(BOT_TUNING_SCHEMA_VERSION);
    expect(parsed.current).toBe(DEFAULT_BOT_TUNING_NAME);
    expect(Array.isArray(parsed.configs)).toBe(true);
  });

  it('carries a Default-named entry with valid shipped tuning values', () => {
    const parsed = JSON.parse(readBotTuningFile()) as {
      configs: Array<{ name: string; values: unknown }>;
    };
    const def = parsed.configs.find((c) => c.name === DEFAULT_BOT_TUNING_NAME);
    expect(def).toBeDefined();
    // Deliberately NOT pinned to the factory defaults: the committed baseline
    // is meant to carry the *tuned* Bot definitions (AH-0MV9GZD2C005IIU3), and
    // pinning it here would reject the very Export → commit refresh workflow
    // AC4 requires. Assert instead that the values are a valid tuning map the
    // store accepts (coerceTuningValues is the store's validation surface).
    const groups = def!.values as Record<string, unknown>;
    expect(typeof groups['competent']).toBe('object');
    expect(typeof groups['human']).toBe('object');
    const coerced = coerceTuningValues(def!.values);
    expect(coerced.competent['mineralSeekRange']).toBeTypeOf('number');
    expect(coerced.human['skill']).toBeTypeOf('number');
  });

  it('round-trips through the store Export with identical coerced values', () => {
    // The committed file authors presets as sparse overrides, while the store
    // Export writes every configuration fully coerced; the two blobs must
    // still describe exactly the same tuning state.
    const exported = parseBotTuningStateBlob(freshExportBlob());
    const committed = parseBotTuningStateBlob(readBotTuningFile());
    expect(exported).not.toBeNull();
    expect(committed).not.toBeNull();
    expect(exported).toEqual(committed);
  });

  it('ends with a trailing newline', () => {
    expect(readBotTuningFile()).toMatch(/\n$/);
  });
});

describe('curated promo bot-tuning presets (AH-0MVSDM5T1007KBB8)', () => {
  it('ships Default plus at least four curated presets, all uniquely named and documented', () => {
    const names = rawConfigs().map((config) => config.name);
    expect(names).toContain(DEFAULT_BOT_TUNING_NAME);
    for (const preset of CURATED_PRESETS) expect(names).toContain(preset.name);
    expect(names.length).toBeGreaterThanOrEqual(CURATED_PRESETS.length + 1);
    expect(new Set(names).size).toBe(names.length);
    // Every shipped preset carries a documented one-liner here (and in
    // docs/BOT_FRAMEWORK.md), so an undocumented preset cannot slip in.
    const documented = new Set<string>(CURATED_PRESETS.map((preset) => preset.name));
    const shipped = names.filter((name) => name !== DEFAULT_BOT_TUNING_NAME);
    for (const name of shipped) {
      expect(documented.has(name), `preset "${name}" is not documented`).toBe(true);
    }
  });

  it('authors every preset as a sparse override map, not a copy of Default', () => {
    const fullKeyCount =
      BOT_TUNING_NUMERIC_FIELDS.length + BOT_TUNING_TOGGLES.length;
    for (const preset of CURATED_PRESETS) {
      const raw = rawConfigs().find((config) => config.name === preset.name)!;
      const groups = raw.values as Record<string, Record<string, unknown>>;
      const authoredKeys = Object.values(groups).reduce(
        (total, group) => total + Object.keys(group).length,
        0,
      );
      // Sparse by construction: only the keys that differ from Default are
      // authored, so the file stays small and readable. A dev-server
      // "Save to repo" rewrites every config fully coerced — re-sparsify the
      // presets (keep only the keys that differ from Default) before
      // committing so this authored-data contract holds.
      expect(authoredKeys).toBeGreaterThan(0);
      expect(authoredKeys).toBeLessThan(fullKeyCount);
      expect(coerceTuningValues(raw.values)).not.toEqual(defaultValues());
    }
  });

  it('coerces every preset deterministically to the complete tuning surface', () => {
    for (const preset of CURATED_PRESETS) {
      const first = coercedPreset(preset.name);
      const second = coerceTuningValues(
        rawConfigs().find((config) => config.name === preset.name)!.values,
      );
      expect(second).toEqual(first);
      for (const field of BOT_TUNING_NUMERIC_FIELDS) {
        expect(typeof first[field.group][field.key], `${preset.name}.${field.key}`).toBe(
          'number',
        );
      }
      for (const toggle of BOT_TUNING_TOGGLES) {
        expect(typeof first[toggle.group][toggle.key], `${preset.name}.${toggle.key}`).toBe(
          'boolean',
        );
      }
    }
  });

  it('differs from Default in its documented tuning key (and is not a duplicate)', () => {
    const defaults = defaultValues();
    for (const preset of CURATED_PRESETS) {
      const values = coercedPreset(preset.name);
      const field = BOT_TUNING_NUMERIC_FIELDS.find(
        (candidate) => candidate.key === preset.distinguishingKey,
      );
      expect(field, `${preset.name} names an undeclared tuning key`).toBeDefined();
      expect(
        values[field!.group][preset.distinguishingKey],
        `${preset.name} (${preset.intent}) should move ${preset.distinguishingKey} away from Default`,
      ).not.toBe(defaults[field!.group][preset.distinguishingKey]);
    }
  });

  it('keeps every preset value inside the gym slider bounds', () => {
    for (const preset of CURATED_PRESETS) {
      const values = coercedPreset(preset.name);
      for (const field of BOT_TUNING_NUMERIC_FIELDS) {
        const value = values[field.group][field.key];
        expect(typeof value).toBe('number');
        expect(value as number).toBeGreaterThanOrEqual(field.min);
        expect(value as number).toBeLessThanOrEqual(field.max);
      }
    }
  });

  it('defines every preset a registered promo scenario references (AC2)', () => {
    const names = new Set(rawConfigs().map((config) => config.name));
    const promoScenarios = CAPTURE_SCENARIOS.filter(
      (scenario) => scenario.kind === 'promo',
    );
    for (const scenario of promoScenarios) {
      expect(names.has(scenario.preset), `${scenario.name} -> ${scenario.preset}`).toBe(
        true,
      );
    }
    // Prove the lookup is a real gate rather than a vacuous loop while the
    // promo catalogue is still empty: an unknown preset name is rejected.
    expect(names.has('no-such-preset')).toBe(false);
  });
});
