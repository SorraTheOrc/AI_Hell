/**
 * AH-0MV4D7LAD009XYR0 — named bot-tuning configuration store.
 *
 * Covers the Save / Save As / Load contract the gym exposes, plus the
 * corrupt-safe, versioned persistence the work item requires.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultBotTuningValues, type BotTuningValues } from '../ai/tuningFields';
import { bundledBotTuningJson } from './bundledConfig';
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
  type BotTuningState,
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

describe('bot tuning store — bundled baseline fallback (AH-0MV9GZD2C005IIU3)', () => {
  beforeEach(() => {
    resetBotTuningStore();
    window.localStorage.clear();
  });

  /** The Git-tracked bundled baseline parsed as a state (AC1 reference). */
  function bundledBaselineState(): BotTuningState {
    const parsed = JSON.parse(bundledBotTuningJson) as BotTuningState;
    return parsed;
  }

  it('AC1 — no storage seeds the bundled configuration set, not the lone factory Default', async () => {
    const fresh = await loadFreshStore();
    const baseline = bundledBaselineState();
    // The bundled set (not the 1-entry factory default) is what ships.
    expect(fresh.listBotTuningNames()).toEqual(baseline.configs.map((c) => c.name));
    expect(fresh.getCurrentBotTuningName()).toBe(baseline.current);
    // The currently-selected config carries the bundled values.
    const expected = baseline.configs.find((c) => c.name === baseline.current)!;
    expect(fresh.getCurrentBotTuningConfig().values).toEqual(expected.values);
  });

  it('AC2 — a saved localStorage selection wins locally over the bundled baseline', async () => {
    saveBotTuningAs('Local', markedValues(9090));
    selectBotTuning('Local');
    const fresh = await loadFreshStore();
    expect(fresh.getCurrentBotTuningName()).toBe('Local');
    expect(fresh.getCurrentBotTuningConfig().values.competent['mineralSeekRange']).toBe(9090);
    // Bundled names are still present underneath, but the local current wins.
    expect(fresh.listBotTuningNames()).toContain('Local');
  });

  it('AC3 — corrupt persisted blob falls back to the bundled baseline, never crashing', async () => {
    window.localStorage.setItem(BOT_TUNING_STORAGE_KEY, '{ this is not json');
    const fresh = await loadFreshStore();
    const baseline = bundledBaselineState();
    expect(fresh.listBotTuningNames()).toEqual(baseline.configs.map((c) => c.name));
    expect(fresh.getCurrentBotTuningName()).toBe(baseline.current);
  });

  it('AC3 — unknown schema version falls back to the bundled baseline', async () => {
    window.localStorage.setItem(
      BOT_TUNING_STORAGE_KEY,
      JSON.stringify({ version: BOT_TUNING_SCHEMA_VERSION + 99, current: 'X', configs: [] }),
    );
    const fresh = await loadFreshStore();
    expect(fresh.listBotTuningNames()).toEqual(
      bundledBaselineState().configs.map((c) => c.name),
    );
    expect(fresh.getCurrentBotTuningName()).toBe(bundledBaselineState().current);
  });

  it('AC4 — an unreadable bundled file falls back to the built-in Default without crashing', async () => {
    // Simulate a corrupted shipped baseline: mock the bundled JSON to garbage.
    vi.resetModules();
    vi.doMock('./bundledConfig', () => ({
      bundledBotTuningJson: '{ not valid json',
    }));
    try {
      const fresh = await import('./botTuningStore');
      expect(fresh.getCurrentBotTuningName()).toBe(DEFAULT_BOT_TUNING_NAME);
      expect(fresh.listBotTuningNames()).toEqual([DEFAULT_BOT_TUNING_NAME]);
      expect(fresh.getCurrentBotTuningConfig().values).toEqual(defaultBotTuningValues());
    } finally {
      vi.doUnmock('./bundledConfig');
    }
  });

  it('AC4 — a structurally-invalid bundled file (empty configs) falls back safely', async () => {
    vi.resetModules();
    vi.doMock('./bundledConfig', () => ({
      bundledBotTuningJson: JSON.stringify({
        version: BOT_TUNING_SCHEMA_VERSION,
        current: 'X',
        configs: [],
      }),
    }));
    try {
      const fresh = await import('./botTuningStore');
      expect(fresh.getCurrentBotTuningName()).toBe(DEFAULT_BOT_TUNING_NAME);
      expect(fresh.listBotTuningNames()).toEqual([DEFAULT_BOT_TUNING_NAME]);
    } finally {
      vi.doUnmock('./bundledConfig');
    }
  });

  it('AC5 — the Default-named entry in the bundled baseline is intact (not pinned to the factory defaults)', () => {
    const baseline = bundledBaselineState();
    const def = baseline.configs.find((c) => c.name === DEFAULT_BOT_TUNING_NAME);
    expect(def).toBeDefined();
    // Deliberately NOT pinned to `defaultBotTuningValues()`: the bundled file
    // is meant to carry the *tuned* Bot definitions (AH-0MV9GZD2C005IIU3), so
    // an Export → commit refresh must not break the suite. Config-name
    // reporting is unchanged: the current name is still 'Default'.
    expect(getCurrentBotTuningName()).toBe(DEFAULT_BOT_TUNING_NAME);
  });

  it('AC1 — a DISTINCTIVE bundled baseline is served verbatim (mechanism is content-agnostic)', async () => {
    // Guard against a silently-broken mechanism: because the committed file
    // currently equals the factory defaults, most baseline tests are
    // tautological (fresh state == defaults either way). Force the bundled
    // baseline to carry clearly *different* values and prove the store serves
    // exactly those — the shipped file is the fallback, not the built-in
    // `Default`.
    const distinctiveJson = JSON.stringify({
      version: BOT_TUNING_SCHEMA_VERSION,
      current: 'Tuned',
      configs: [
        { name: 'Tuned', values: { competent: { mineralSeekRange: 777 }, human: { skill: 0.5 } } },
      ],
    });
    vi.resetModules();
    vi.doMock('./bundledConfig', () => ({
      bundledBotTuningJson: distinctiveJson,
    }));
    try {
      const fresh = await import('./botTuningStore');
      expect(fresh.listBotTuningNames()).toEqual(['Tuned']);
      expect(fresh.getCurrentBotTuningName()).toBe('Tuned');
      expect(fresh.getCurrentBotTuningConfig().values.competent['mineralSeekRange']).toBe(777);
      expect(fresh.getCurrentBotTuningConfig().values.human['skill']).toBe(0.5);
      // Proves the bundled file itself was flown, not the built-in fallback,
      // which would have returned the default values.
      expect(fresh.getCurrentBotTuningConfig().values.competent['mineralSeekRange']).not.toBe(
        defaultBotTuningValues().competent['mineralSeekRange'],
      );
    } finally {
      vi.doUnmock('./bundledConfig');
    }
  });
});
