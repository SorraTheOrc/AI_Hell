/**
 * AH-0MV4D7LAD009XYR0 — named bot-tuning configuration store.
 *
 * Covers the Save / Save As / Load contract the gym exposes, plus the
 * corrupt-safe, versioned persistence the work item requires.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultBotTuningValues, type BotTuningValues } from '../ai/tuningFields';
import {
  BOT_TUNING_SCHEMA_VERSION,
  BOT_TUNING_STORAGE_KEY,
  DEFAULT_BOT_TUNING_NAME,
  getBotTuningConfig,
  getCurrentBotTuningConfig,
  getCurrentBotTuningName,
  listBotTuningNames,
  normaliseBotTuningName,
  resetBotTuningStore,
  saveBotTuningAs,
  saveBotTuningCurrent,
  selectBotTuning,
  serialiseBotTuningState,
} from './botTuningStore';

/** Loads a fresh module instance so the store's cache is empty. */
async function loadFreshStore() {
  vi.resetModules();
  return await import('./botTuningStore');
}

/** A tuning value set with a distinctive marker field. */
function markedValues(marker: number): BotTuningValues {
  const values = defaultBotTuningValues();
  values.competent['mineralSeekRange'] = marker;
  return values;
}

describe('bot tuning store (AH-0MV4D7LAD009XYR0)', () => {
  beforeEach(() => {
    resetBotTuningStore();
    window.localStorage.clear();
  });

  it('starts with only the built-in Default configuration selected', () => {
    expect(listBotTuningNames()).toEqual([DEFAULT_BOT_TUNING_NAME]);
    expect(getCurrentBotTuningName()).toBe(DEFAULT_BOT_TUNING_NAME);
    expect(getCurrentBotTuningConfig().values.competent).toBeTypeOf('object');
  });

  it('Save overwrites the current configuration', () => {
    saveBotTuningCurrent(markedValues(321));
    expect(getBotTuningConfig(DEFAULT_BOT_TUNING_NAME)?.values.competent['mineralSeekRange']).toBe(321);
    // Still exactly one configuration: Save does not create a new one.
    expect(listBotTuningNames()).toEqual([DEFAULT_BOT_TUNING_NAME]);
  });

  it('Save As creates a named configuration and makes it current', () => {
    const created = saveBotTuningAs('Aggressive', markedValues(77));
    expect(created?.name).toBe('Aggressive');
    expect(listBotTuningNames()).toContain('Aggressive');
    expect(getCurrentBotTuningName()).toBe('Aggressive');
    expect(getCurrentBotTuningConfig().values.competent['mineralSeekRange']).toBe(77);
  });

  it('Load selects an existing configuration', () => {
    saveBotTuningAs('A', markedValues(1));
    saveBotTuningAs('B', markedValues(2));
    const loaded = selectBotTuning('A');
    expect(loaded?.name).toBe('A');
    expect(getCurrentBotTuningName()).toBe('A');
    expect(selectBotTuning('missing')).toBeNull();
    expect(getCurrentBotTuningName()).toBe('A');
  });

  it('normalises and rejects unusable names', () => {
    expect(normaliseBotTuningName('  spaced   out  ')).toBe('spaced out');
    expect(normaliseBotTuningName('   ')).toBeNull();
    expect(saveBotTuningAs('   ', markedValues(1))).toBeNull();
  });

  it('persists configurations across a fresh module load', async () => {
    saveBotTuningAs('Persisted', markedValues(555));
    const fresh = await loadFreshStore();
    expect(fresh.listBotTuningNames()).toContain('Persisted');
    expect(fresh.getCurrentBotTuningName()).toBe('Persisted');
    expect(
      fresh.getCurrentBotTuningConfig().values.competent['mineralSeekRange'],
    ).toBe(555);
  });

  it('falls back to Default when the persisted blob is corrupt', async () => {
    window.localStorage.setItem(BOT_TUNING_STORAGE_KEY, '{ this is not json');
    const fresh = await loadFreshStore();
    expect(fresh.getCurrentBotTuningName()).toBe(DEFAULT_BOT_TUNING_NAME);
    expect(fresh.listBotTuningNames()).toEqual([DEFAULT_BOT_TUNING_NAME]);
  });

  it('falls back to Default when the schema version is unknown', async () => {
    window.localStorage.setItem(
      BOT_TUNING_STORAGE_KEY,
      JSON.stringify({ version: BOT_TUNING_SCHEMA_VERSION + 99, current: 'X', configs: [] }),
    );
    const fresh = await loadFreshStore();
    expect(fresh.getCurrentBotTuningName()).toBe(DEFAULT_BOT_TUNING_NAME);
  });

  it('drops invalid entries and backfills missing fields on load', async () => {
    window.localStorage.setItem(
      BOT_TUNING_STORAGE_KEY,
      JSON.stringify({
        version: BOT_TUNING_SCHEMA_VERSION,
        current: 'Partial',
        configs: [
          { name: 'Partial', values: { competent: { mineralSeekRange: 12, bad: 'x' }, human: {} } },
          null,
          { name: '', values: {} },
        ],
      }),
    );
    const fresh = await loadFreshStore();
    expect(fresh.listBotTuningNames()).toEqual(['Partial']);
    const values = fresh.getBotTuningConfig('Partial')!.values;
    expect(values.competent['mineralSeekRange']).toBe(12);
    expect(values.competent['bad']).toBeUndefined();
    // Missing fields fall back to the shipped defaults.
    expect(values.competent['engagementRange']).toBe(
      defaultBotTuningValues().competent['engagementRange'],
    );
  });

  it('serialises the full state as a JSON blob the store can reload (AH-0MV6MFDYG001E6PL)', async () => {
    saveBotTuningAs('Recorder', markedValues(4321));
    saveBotTuningAs('Other', markedValues(7));
    selectBotTuning('Recorder');

    const blob = serialiseBotTuningState();
    expect(() => JSON.parse(blob)).not.toThrow();
    const parsed = JSON.parse(blob);
    expect(parsed.version).toBe(BOT_TUNING_SCHEMA_VERSION);
    expect(parsed.current).toBe('Recorder');
    expect(parsed.configs.map((c: { name: string }) => c.name)).toEqual(
      expect.arrayContaining([DEFAULT_BOT_TUNING_NAME, 'Recorder', 'Other']),
    );
    expect(
      parsed.configs.find((c: { name: string }) => c.name === 'Recorder').values.competent[
        'mineralSeekRange'
      ],
    ).toBe(4321);

    // Round-trip: a fresh store loading this exact blob (the path the
    // recording tools use to inject a config) reproduces the state.
    window.localStorage.setItem(BOT_TUNING_STORAGE_KEY, blob);
    const fresh = await loadFreshStore();
    expect(fresh.getCurrentBotTuningName()).toBe('Recorder');
    expect(fresh.getCurrentBotTuningConfig().values.competent['mineralSeekRange']).toBe(4321);
  });
});
