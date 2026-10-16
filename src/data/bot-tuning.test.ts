/**
 * Bundled bot-tuning baseline file tests (AH-0MV9LCWVI002TOK7 — subtask of
 * AH-0MV9GZD2C005IIU3).
 *
 * Verifies the Git-tracked `src/data/bot-tuning.json` baseline: it exists,
 * parses as valid JSON, matches the exported store shape
 * `{ version, current, configs }`, carries a `Default`-named entry with the
 * shipped tuning values, and is byte-identical to the Bot Tuning gym's Export
 * output (`serialiseBotTuningState()`) so the tune → Export → commit → build
 * refresh workflow round-trips.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { coerceTuningValues } from '../ai/tuningFields';
import {
  BOT_TUNING_SCHEMA_VERSION,
  DEFAULT_BOT_TUNING_NAME,
  resetBotTuningStore,
  serialiseBotTuningState,
} from '../core/botTuningStore';

function readBotTuningFile(): string {
  return readFileSync(resolve(__dirname, 'bot-tuning.json'), 'utf8');
}

/** The store's fresh-state serialisation (no localStorage interference). */
function freshExportBlob(): string {
  resetBotTuningStore();
  window.localStorage.clear();
  return serialiseBotTuningState();
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

  it('is byte-identical to the store Export output on a fresh profile', () => {
    expect(readBotTuningFile()).toBe(freshExportBlob() + '\n');
  });

  it('ends with a trailing newline', () => {
    expect(readBotTuningFile()).toMatch(/\n$/);
  });
});
