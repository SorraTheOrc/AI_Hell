/**
 * Bot-tuning state schema and file-format contract (AH-0MVBJ0DUI009B6AM).
 *
 * The bot-tuning store (`botTuningStore.ts`), the dev-only write-back
 * middleware (`vite/plugins/botTuningPlugin.ts`) and the Bot Tuning gym all
 * work with one blob shape:
 *
 * ```json
 * { "version": 1, "current": "Default", "configs": [{ "name": "Default", "values": { … } }] }
 * ```
 *
 * The shape, the canonical serialisation and the committed file's byte
 * contract (`src/data/bot-tuning.json`: pretty-printed JSON plus a trailing
 * newline) live here **once**, so an exported blob, a persisted file and a
 * dev write-back can never drift apart.
 *
 * The module is deliberately pure — no DOM, no localStorage, no `?raw`
 * bundle imports — so the Vite config loader can import the plugin that uses
 * it without resolving Vite-only imports (compare `bundledConfig.ts`, which
 * the store imports dynamically for exactly that reason).
 *
 * @module src/core/botTuningSchema
 */

import {
  coerceTuningValues,
  defaultBotTuningValues,
  type BotTuningValues,
} from '../ai/tuningFields';

/** Persisted schema version (bump on a breaking shape change). */
export const BOT_TUNING_SCHEMA_VERSION = 1;

/** Name of the built-in configuration that always exists. */
export const DEFAULT_BOT_TUNING_NAME = 'Default';

/** Project-relative path of the Git-tracked bundled baseline. */
export const BOT_TUNING_FILE_PATH = 'src/data/bot-tuning.json';

/** Prefix under which the dev-only write-back middleware serves its endpoint. */
export const BOT_TUNING_API_PREFIX = '/api/bot-tuning/';

/** Dev-server endpoint the client PUTs the current state to. */
export const BOT_TUNING_WRITE_PATH = `${BOT_TUNING_API_PREFIX}${BOT_TUNING_FILE_PATH}`;

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

/** Tuning groups the schema accepts inside a configuration's `values`. */
const TUNING_GROUPS = ['competent', 'human'] as const;

/** A fresh state containing only the built-in `Default` configuration. */
export function createBuiltinDefaultBotTuningState(): BotTuningState {
  return {
    version: BOT_TUNING_SCHEMA_VERSION,
    current: DEFAULT_BOT_TUNING_NAME,
    configs: [
      { name: DEFAULT_BOT_TUNING_NAME, values: defaultBotTuningValues() },
    ],
  };
}

/**
 * Parses a raw blob into a valid state, or `null` when it is unusable.
 * Never throws.
 *
 * Corrupt-safe by design: individual unusable configuration entries are
 * skipped, non-scalar tuning values are dropped (via `coerceTuningValues`,
 * which also fills fields added since the blob was written), and a `current`
 * selection that names no stored configuration falls back to the first one.
 * A blob without a single usable configuration is rejected. The caller
 * applies the fallback chain (see `botTuningStore.loadBotTuningState`).
 */
export function parseBotTuningStateBlob(raw: string | null): BotTuningState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== BOT_TUNING_SCHEMA_VERSION ||
      !Array.isArray((parsed as { configs?: unknown }).configs)
    ) {
      return null;
    }
    const configs: BotTuningConfig[] = [];
    for (const entry of (parsed as { configs: unknown[] }).configs) {
      if (entry === null || typeof entry !== 'object') continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') continue;
      configs.push({ name, values: coerceTuningValues((entry as { values?: unknown }).values) });
    }
    if (configs.length === 0) return null;
    const requested = (parsed as { current?: unknown }).current;
    const current =
      typeof requested === 'string' && configs.some((c) => c.name === requested)
        ? requested
        : configs[0].name;
    return { version: BOT_TUNING_SCHEMA_VERSION, current, configs };
  } catch {
    return null;
  }
}

/** True when `raw` is a JSON-safe `{ competent, human }` scalar map pair. */
function isTuningValuesShape(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return false;
  for (const group of TUNING_GROUPS) {
    const incoming = (raw as Record<string, unknown>)[group];
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return false;
    }
    for (const value of Object.values(incoming as Record<string, unknown>)) {
      const scalar =
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!scalar) return false;
    }
  }
  return true;
}

/** Result of validating a blob destined for the committed baseline file. */
export type BotTuningStateValidation =
  | { readonly ok: true; readonly state: BotTuningState }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Strict validation for the dev write path: true when `raw` is a complete,
 * self-consistent state blob that can be written to the committed baseline.
 *
 * Unlike {@link parseBotTuningStateBlob} (which coerces and skips so a stale
 * localStorage blob keeps working), a write must reject anything it cannot
 * persist verbatim: unparseable JSON, an unsupported version, no
 * configurations, a configuration without a usable name or with non-scalar
 * values, or a `current` selection that names no stored configuration. The
 * middleware returns the human-readable `errors` to the caller and never
 * touches the file when validation fails.
 */
export function validateBotTuningStateBlob(
  raw: string | null,
): BotTuningStateValidation {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, errors: ['Bot-tuning blob is empty'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['Bot-tuning blob is not valid JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['Bot-tuning blob must be a JSON object'] };
  }

  const record = parsed as Record<string, unknown>;
  const errors: string[] = [];
  if (record.version !== BOT_TUNING_SCHEMA_VERSION) {
    errors.push(
      `Unsupported bot-tuning schema version: expected ${BOT_TUNING_SCHEMA_VERSION}, got ${JSON.stringify(record.version)}`,
    );
  }

  const names: string[] = [];
  if (!Array.isArray(record.configs)) {
    errors.push('Bot-tuning blob has no configs array');
  } else if (record.configs.length === 0) {
    errors.push('Bot-tuning blob contains no configurations');
  } else {
    record.configs.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object') {
        errors.push(`Configuration #${index} is not an object`);
        return;
      }
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== 'string' || name.trim() === '') {
        errors.push(`Configuration #${index} is missing a non-empty name`);
        return;
      }
      names.push(name);
      if (!isTuningValuesShape((entry as { values?: unknown }).values)) {
        errors.push(
          `Configuration "${name}" has invalid tuning values (expected scalar competent/human maps)`,
        );
      }
    });
  }

  if (errors.length === 0) {
    const current = record.current;
    if (typeof current !== 'string' || !names.includes(current)) {
      errors.push(
        `Current selection ${JSON.stringify(current)} is not one of the stored configurations`,
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const state = parseBotTuningStateBlob(raw);
  if (!state) return { ok: false, errors: ['Bot-tuning blob could not be parsed'] };
  return { ok: true, state };
}

/**
 * Canonical pretty-printed JSON for `state` (no trailing newline) — the
 * format the gym's **Export** download and `serialiseBotTuningState()` use.
 */
export function serialiseBotTuningStateBlob(state: BotTuningState): string {
  return JSON.stringify(state, null, 2);
}

/**
 * The committed file's exact bytes: the canonical blob plus a trailing
 * newline. `src/data/bot-tuning.test.ts` pins this format, and an atomic
 * write-back must preserve it so the file stays Git-committable and
 * byte-stable.
 */
export function serialiseBotTuningFile(state: BotTuningState): string {
  return `${serialiseBotTuningStateBlob(state)}\n`;
}
