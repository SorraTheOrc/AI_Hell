/**
 * Named bot-tuning configuration store (AH-0MV4D7LAD009XYR0).
 *
 * The bot-tuning gym (`GymBotTuning`) lets a designer edit the bot's
 * decision-making parameters live. This module persists those edits as
 * **named configurations** in a versioned JSON blob in
 * `window.localStorage` — the established browser-native pattern in this repo
 * (`src/core/rules.ts`, `src/core/Leaderboard.ts`).
 *
 * Why not the CSV config store? Ship/enemy configs are Git-tracked design
 * data written through the dev-server CSV plugin; bot-tuning presets are a
 * dev-tool convenience and must also work in a production/static build where
 * CSV writes are unavailable. localStorage keeps the gym self-contained and
 * introduces no CSV schema/plugin work. See the work-item Risks section.
 *
 * The store is corrupt-safe: malformed JSON, an unknown schema version, or an
 * invalid config list falls back to the built-in `Default` configuration. When
 * `localStorage` is unavailable (SSR, privacy mode) the store keeps working
 * in-memory for the session and simply does not persist.
 *
 * @module src/core/botTuningStore
 */

import {
  coerceTuningValues,
  defaultBotTuningValues,
  type BotTuningValues,
} from '../ai/tuningFields';

/** localStorage key holding the persisted tuning state. */
export const BOT_TUNING_STORAGE_KEY = 'ai-hell-bot-tuning';

/** Persisted schema version (bump on a breaking shape change). */
export const BOT_TUNING_SCHEMA_VERSION = 1;

/** Name of the built-in configuration that always exists. */
export const DEFAULT_BOT_TUNING_NAME = 'Default';

/** Maximum stored configuration-name length (after normalisation). */
export const MAX_BOT_TUNING_NAME_LENGTH = 40;

/** A named set of bot-tuning values. */
export interface BotTuningConfig {
  readonly name: string;
  readonly values: BotTuningValues;
}

/** The whole persisted state: the current selection plus every named config. */
export interface BotTuningState {
  readonly version: number;
  readonly current: string;
  readonly configs: readonly BotTuningConfig[];
}

// ── Internals ───────────────────────────────────────────────────────

/** Module-level cache so repeated panel reads do not re-parse localStorage. */
let cache: BotTuningState | null = null;

/**
 * Returns a usable Storage instance, or null when localStorage is unavailable
 * (SSR, privacy mode, or other contexts where it throws).
 */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Accessing window.localStorage can throw in restricted contexts; treat
    // storage as unavailable rather than crashing the gym.
    return null;
  }
}

/** A fresh state containing only the built-in `Default` configuration. */
function createDefaultState(): BotTuningState {
  return {
    version: BOT_TUNING_SCHEMA_VERSION,
    current: DEFAULT_BOT_TUNING_NAME,
    configs: [
      { name: DEFAULT_BOT_TUNING_NAME, values: defaultBotTuningValues() },
    ],
  };
}

/**
 * Parses a raw persisted blob into a valid state, falling back to the
 * defaults on any corruption. Never throws.
 */
function parseState(raw: string | null): BotTuningState {
  if (!raw) return createDefaultState();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== BOT_TUNING_SCHEMA_VERSION ||
      !Array.isArray((parsed as { configs?: unknown }).configs)
    ) {
      return createDefaultState();
    }
    const configs: BotTuningConfig[] = [];
    for (const entry of (parsed as { configs: unknown[] }).configs) {
      if (entry === null || typeof entry !== 'object') continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') continue;
      configs.push({ name, values: coerceTuningValues((entry as { values?: unknown }).values) });
    }
    if (configs.length === 0) return createDefaultState();
    const requested = (parsed as { current?: unknown }).current;
    const current =
      typeof requested === 'string' && configs.some((c) => c.name === requested)
        ? requested
        : configs[0].name;
    return { version: BOT_TUNING_SCHEMA_VERSION, current, configs };
  } catch {
    return createDefaultState();
  }
}

/** Persists the state (best-effort; a missing storage is not an error). */
function persist(state: BotTuningState): void {
  try {
    storage()?.setItem(BOT_TUNING_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Quota exceeded / unavailable storage: keep the in-memory state.
  }
}

/**
 * Normalises a user-entered configuration name. Returns `null` when the name
 * is unusable (empty after trimming, or only whitespace).
 */
export function normaliseBotTuningName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  return trimmed.slice(0, MAX_BOT_TUNING_NAME_LENGTH);
}

// ── Public API ──────────────────────────────────────────────────────

/** Returns the current state, loading (and caching) it on first use. */
export function loadBotTuningState(): BotTuningState {
  if (cache === null) cache = parseState(storage()?.getItem(BOT_TUNING_STORAGE_KEY) ?? null);
  return cache;
}

/** Every stored configuration name, in stable insertion order. */
export function listBotTuningNames(): string[] {
  return loadBotTuningState().configs.map((config) => config.name);
}

/** Returns the named configuration, or `null` when it does not exist. */
export function getBotTuningConfig(name: string): BotTuningConfig | null {
  return loadBotTuningState().configs.find((config) => config.name === name) ?? null;
}

/** Returns the currently-selected configuration (never null). */
export function getCurrentBotTuningConfig(): BotTuningConfig {
  const state = loadBotTuningState();
  return state.configs.find((config) => config.name === state.current) ?? state.configs[0];
}

/** Name of the currently-selected configuration. */
export function getCurrentBotTuningName(): string {
  return getCurrentBotTuningConfig().name;
}

/**
 * Overwrites the **current** configuration with `values` ("Save"). Returns
 * the updated configuration.
 */
export function saveBotTuningCurrent(values: BotTuningValues): BotTuningConfig {
  const state = loadBotTuningState();
  const name = state.current;
  const updated: BotTuningConfig = { name, values: coerceTuningValues(values) };
  const configs = state.configs.map((config) => (config.name === name ? updated : config));
  cache = { version: BOT_TUNING_SCHEMA_VERSION, current: name, configs };
  persist(cache);
  return updated;
}

/**
 * Creates (or overwrites) a named configuration from `values` ("Save As…")
 * and makes it the current selection. Returns `null` when the name is
 * unusable.
 */
export function saveBotTuningAs(
  name: string,
  values: BotTuningValues,
): BotTuningConfig | null {
  const normalised = normaliseBotTuningName(name);
  if (normalised === null) return null;
  const state = loadBotTuningState();
  const updated: BotTuningConfig = { name: normalised, values: coerceTuningValues(values) };
  const exists = state.configs.some((config) => config.name === normalised);
  const configs = exists
    ? state.configs.map((config) => (config.name === normalised ? updated : config))
    : [...state.configs, updated];
  cache = { version: BOT_TUNING_SCHEMA_VERSION, current: normalised, configs };
  persist(cache);
  return updated;
}

/**
 * Selects an existing configuration ("Load"). Returns the selected config, or
 * `null` when no configuration has that name (the selection is left unchanged).
 */
export function selectBotTuning(name: string): BotTuningConfig | null {
  const state = loadBotTuningState();
  const config = state.configs.find((entry) => entry.name === name);
  if (!config) return null;
  cache = { version: BOT_TUNING_SCHEMA_VERSION, current: name, configs: state.configs };
  persist(cache);
  return config;
}

/**
 * Clears the cached state and removes the persisted blob. Used by tests and
 * by an explicit "reset" affordance.
 */
export function resetBotTuningStore(): void {
  cache = null;
  try {
    storage()?.removeItem(BOT_TUNING_STORAGE_KEY);
  } catch {
    // Ignore unavailable storage.
  }
}

/**
 * Serialises the full persisted state (every named config plus the current
 * selection) as pretty-printed JSON (AH-0MV6MFDYG001E6PL).
 *
 * This is the exact blob {@link parseState} accepts, so the export round-trips
 * through {@link window.localStorage} — the gym's **Export** action hands this
 * to the user, and the recording tools inject it into a fresh page before the
 * game boots so the demo plays the saved tuning.
 */
export function serialiseBotTuningState(): string {
  return JSON.stringify(loadBotTuningState(), null, 2);
}
