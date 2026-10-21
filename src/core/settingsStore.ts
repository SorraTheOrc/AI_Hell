/**
 * Settings persistence module (GDD §6.6 — `ai_hell_settings`).
 *
 * Typed settings record (SFX volume, SFX mute, key bindings, dev telemetry
 * sharing) with `loadSettings()`, `saveSettings()`, and `resetSettings()`.
 * Mirrors the `src/core/config.ts` pattern: defaults, merge-over-defaults,
 * corrupt-JSON fallback, SSR-safe storage guard. Every menu child reads/writes
 * settings through this module.
 *
 * @module settingsStore
 */

// ── Types ─────────────────────────────────────────────────────────────

import type { ControlScheme } from './configTypes';

/**
 * Named actions that the player can remap in SettingsScene.
 */
export type ActionName =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'pauseToggle';

/**
 * Serializable settings record persisted under `ai_hell_settings`.
 */
export interface SettingsRecord {
  /** SFX master volume: `0` (silent) → `1` (full). */
  sfxVolume: number;
  /** When `true`, all SFX output is silenced; volume is preserved. */
  sfxMuted: boolean;
  /** Maps each `ActionName` to its current key label (Phaser key string). */
  bindings: Record<ActionName, string>;
  /**
   * Whether the player shares run telemetry with the dev server
   * (`AH-0MVBMQZR50069QV3`, parent `AH-0MVBHRLY8004BGDN`). Defaults to
   * `true`; the value is **inert** outside a dev build — the decision is
   * made by the single dev gate in `src/telemetry/devMode.ts`.
   */
  shareTelemetryDev: boolean;
  /**
   * Per-player ship control scheme (`AH-0MVI7LRCJ006Q8SA`).
   *
   * This is the player's personal override for the designer-owned
   * `src/data/ship-config.csv` `controlScheme`; settings never write the CSV.
   * Resolve the value the game actually uses through
   * `resolvePlayerControlScheme()` in `src/core/playerScheme.ts` (precedence:
   * this setting → ship config → built-in default).
   */
  controlScheme: ControlScheme;
}

/** localStorage key (matches GDD §6.6). */
export const SETTINGS_STORAGE_KEY = 'ai_hell_settings';

// ── Defaults ──────────────────────────────────────────────────────────

/** Built-in default key bindings — current game hard-coded layout. */
export const DEFAULT_BINDINGS: Record<ActionName, string> = {
  moveUp: 'w',
  moveDown: 's',
  moveLeft: 'a',
  moveRight: 'd',
  pauseToggle: 'Escape',
};

/** Built-in default settings. */
export const DEFAULT_SETTINGS: SettingsRecord = {
  sfxVolume: 1,
  sfxMuted: false,
  bindings: { ...DEFAULT_BINDINGS },
  // Dev-mode telemetry sharing is on by default: a stock `npm run dev`
  // collects and uploads at run end unless the player opts out. The value is
  // inert in a production build (see `src/telemetry/devMode.ts`).
  shareTelemetryDev: true,
  // Today's shipped behaviour (AH-0MUFE1N36007X48T) is the per-player
  // default too, so an untouched settings record changes nothing.
  controlScheme: 'asteroids',
};

/**
 * Ordered list of selectable control schemes, derived from the `ControlScheme`
 * union so a future scheme becomes selectable in Settings without new UI
 * wiring (`AH-0MVI7LRCJ006Q8SA` AC1). The order is the Left/Right cycling
 * order in `SettingsScene`.
 */
export const CONTROL_SCHEMES: readonly ControlScheme[] = ['asteroids', 'fourDirectional'];

/**
 * Type guard: whether `value` is a member of {@link CONTROL_SCHEMES}.
 * Legacy/corrupt records can hold anything, so callers validate rather than
 * trust the stored JSON.
 */
export function isControlScheme(value: unknown): value is ControlScheme {
  return (
    typeof value === 'string' && (CONTROL_SCHEMES as readonly string[]).includes(value)
  );
}

/**
 * Resolves the persisted control scheme, falling back to the default when the
 * stored value is missing, non-string, blank or outside the union (AC2).
 */
export function resolveControlScheme(stored: unknown): ControlScheme {
  return isControlScheme(stored) ? stored : DEFAULT_SETTINGS.controlScheme;
}

/** Ordered list of action names for iteration (e.g. SettingsScene lists). */
export const ACTION_NAMES: ActionName[] = [
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
  'pauseToggle',
];

/**
 * Returns a complete, valid binding map. Missing entries, non-string values
 * and blank strings fall back to `DEFAULT_BINDINGS` (AC3).
 */
export function resolveBindings(
  stored?: Partial<Record<ActionName, string>>,
): Record<ActionName, string> {
  const resolved: Record<ActionName, string> = { ...DEFAULT_BINDINGS };
  if (!stored) return resolved;
  for (const action of ACTION_NAMES) {
    const value = stored[action];
    if (typeof value === 'string' && value.trim() !== '') {
      resolved[action] = value;
    }
  }
  return resolved;
}

/**
 * Resolves a single action's binding, falling back to its default when the
 * stored value is missing, non-string or blank.
 */
export function keyFor(
  bindings: Record<ActionName, string> | Partial<Record<ActionName, string>> | undefined,
  action: ActionName,
): string {
  const value = bindings?.[action];
  return typeof value === 'string' && value.trim() !== ''
    ? value
    : DEFAULT_BINDINGS[action];
}

/**
 * Returns the first other action whose current binding shares `key` with
 * `action`, or `null` when the key is free.
 */
export function findConflict(
  bindings: Record<ActionName, string>,
  action: ActionName,
  key: string,
): ActionName | null {
  for (const other of ACTION_NAMES) {
    if (other === action) continue;
    if (bindings[other] !== key) continue;
    return other;
  }
  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Returns a usable Storage instance, or `null` when localStorage is
 * unavailable (SSR, privacy mode, or other contexts where it throws).
 */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Accessing window.localStorage can throw in restricted contexts;
    // treat storage as unavailable rather than crashing the game.
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Loads the persisted settings, or the defaults when nothing has been
 * saved (or the stored JSON is corrupt). A partial stored record is
 * merged over the defaults so the result is always complete and valid.
 */
export function loadSettings(): SettingsRecord {
  const store = storage();
  if (!store) return { ...DEFAULT_SETTINGS };

  const raw = store.getItem(SETTINGS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };

  try {
    const parsed = JSON.parse(raw) as Partial<SettingsRecord>;
    // Guard: parsed value must be a plain object; fall back to defaults
    // if it is a string, number, array, etc.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_SETTINGS };
    }
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      bindings: resolveBindings(parsed.bindings as Partial<Record<ActionName, string>> | undefined),
      // Explicit coercion (AC of AH-0MVBMQZR50069QV3): a legacy record
      // without the field, or a stored non-boolean, resolves to the
      // default (on) rather than leaking `undefined`/a truthy string.
      shareTelemetryDev:
        typeof parsed.shareTelemetryDev === 'boolean'
          ? parsed.shareTelemetryDev
          : DEFAULT_SETTINGS.shareTelemetryDev,
      // Explicit coercion (AC2 of AH-0MVI7LRCJ006Q8SA): a legacy record
      // without the field, a stored non-string, a blank string or a value
      // outside the union resolves to the default rather than leaking an
      // unvalidated value into the movement model.
      controlScheme: resolveControlScheme(parsed.controlScheme),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persists the supplied settings to `localStorage` under the key
 * `ai_hell_settings`. No-op when storage is unavailable.
 */
export function saveSettings(values: SettingsRecord): void {
  const store = storage();
  if (!store) return;
  store.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(values));
}

/**
 * Resets settings to the built-in defaults and persists them.
 * No-op when storage is unavailable.
 */
export function resetSettings(): void {
  saveSettings({ ...DEFAULT_SETTINGS });
}
