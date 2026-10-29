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
 * invalid config list falls back to the **Git-tracked bundled baseline**
 * (`src/data/bot-tuning.json`, shipped via `src/core/bundledConfig.ts`)
 * so distributed builds and fresh machines fly the tuned Bot definitions
 * instead of the generic factory defaults (AH-0MV9GZD2C005IIU3). When the
 * bundled file is itself unreadable/invalid, the store falls back to the
 * built-in `Default` configuration. A user's saved `localStorage` selection
 * always wins locally — precedence is `localStorage` → bundled baseline →
 * built-in `Default`. When `localStorage` is unavailable (SSR, privacy mode)
 * the store keeps working in-memory for the session and simply does not
 * persist.
 *
 * @module src/core/botTuningStore
 */

import {
  coerceTuningValues,
  type BotTuningValues,
} from '../ai/tuningFields';
import { bundledBotTuningJson } from './bundledConfig';
import type { SaveResult } from './configStore';
import {
  BOT_TUNING_SCHEMA_VERSION,
  BOT_TUNING_WRITE_PATH,
  createBuiltinDefaultBotTuningState,
  parseBotTuningStateBlob,
  serialiseBotTuningStateBlob,
  type BotTuningConfig,
  type BotTuningState,
} from './botTuningSchema';

// The persisted shape lives in `botTuningSchema` so the store, the gym and the
// dev-only write-back middleware share one definition (AH-0MVBJ0DUI009B6AM).
// Re-exported here because this module is the store's public entry point.
export {
  BOT_TUNING_FILE_PATH,
  BOT_TUNING_SCHEMA_VERSION,
  BOT_TUNING_WRITE_PATH,
  DEFAULT_BOT_TUNING_NAME,
  type BotTuningConfig,
  type BotTuningState,
} from './botTuningSchema';

/** localStorage key holding the persisted tuning state. */
export const BOT_TUNING_STORAGE_KEY = 'ai-hell-bot-tuning';

/** Maximum stored configuration-name length (after normalisation). */
export const MAX_BOT_TUNING_NAME_LENGTH = 40;

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

/**
 * The shipped baseline state: the Git-tracked `bot-tuning.json` bundled into
 * every build (AH-0MV9GZD2C005IIU3), parsed through the same corrupt-safe
 * validation as user storage. Falls back to the built-in `Default` when the
 * bundled file is unreadable/invalid, so an unreadable bundle never crashes
 * or degrades demo behaviour.
 */
function createDefaultState(): BotTuningState {
  return parseBotTuningStateBlob(bundledBotTuningJson) ??
    createBuiltinDefaultBotTuningState();
}

/**
 * Parses a raw persisted blob into a valid state, falling back to the
 * bundled baseline (then the built-in `Default`) on any corruption. Never
 * throws.
 */
function parseState(raw: string | null): BotTuningState {
  return parseBotTuningStateBlob(raw) ?? createDefaultState();
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
 * game boots so the demo plays the saved tuning. The committed baseline file
 * carries the same bytes plus a trailing newline
 * (`serialiseBotTuningFile`, see `botTuningSchema`).
 */
export function serialiseBotTuningState(): string {
  return serialiseBotTuningStateBlob(loadBotTuningState());
}

// ── Dev write-back ──────────────────────────────────────────────────

/** True when running under the Vite dev server (write-back available). */
function isDev(): boolean {
  return import.meta.env.DEV === true;
}

/** Reason reported when the write path is unavailable (non-dev builds). */
const BOT_TUNING_WRITE_UNAVAILABLE =
  'Bot-tuning writes are unavailable in production builds (read-only baseline).';

/** Reads the middleware's rejection detail, falling back to the HTTP status. */
async function describeWriteFailure(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { errors?: unknown };
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      return payload.errors.map(String).join('; ');
    }
  } catch {
    // Non-JSON error body: fall through to the status description.
  }
  return `Write failed with HTTP ${res.status}`;
}

/**
 * Persists the current tuning state to the Git-tracked baseline
 * `src/data/bot-tuning.json` through the dev-only Vite middleware
 * (AH-0MVBJ0DUI009B6AM).
 *
 * This is the gym's **Save to repo** action: it writes exactly the bytes the
 * **Export** button produces (plus the file's trailing newline) so the next
 * build and every fresh browser fly the tuned baseline without the manual
 * Export → overwrite → commit dance. It is an *explicit* action — never a
 * background sync on every slider move.
 *
 * Outside the dev server (a production/static build) there is no write path
 * at all: the function reports unavailability instead of touching anything,
 * mirroring `saveShipConfig` / `saveEnemyConfig` in `configStore`.
 */
export async function saveBotTuningToRepo(): Promise<SaveResult> {
  if (!isDev()) return { ok: false, reason: BOT_TUNING_WRITE_UNAVAILABLE };
  try {
    const res = await fetch(BOT_TUNING_WRITE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serialiseBotTuningState(),
    });
    if (!res.ok) return { ok: false, reason: await describeWriteFailure(res) };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Write failed',
    };
  }
}
