/**
 * Settings persistence module (GDD §6.6 — `ai_hell_settings`).
 *
 * Typed settings record (SFX volume, SFX mute, key bindings) with
 * `loadSettings()`, `saveSettings()`, and `resetSettings()`. Mirrors the
 * `src/core/config.ts` pattern: defaults, merge-over-defaults, corrupt-JSON
 * fallback, SSR-safe storage guard. Every menu child reads/writes settings
 * through this module.
 *
 * @module settingsStore
 */

// ── Types ─────────────────────────────────────────────────────────────

/**
 * Named actions that the player can remap in SettingsScene.
 */
export type ActionName =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'layerDrop'
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
  layerDrop: 's', // intentional overlap: same as moveDown
  pauseToggle: 'Escape',
};

/** Built-in default settings. */
export const DEFAULT_SETTINGS: SettingsRecord = {
  sfxVolume: 1,
  sfxMuted: false,
  bindings: { ...DEFAULT_BINDINGS },
};

/** Ordered list of action names for iteration (e.g. SettingsScene lists). */
export const ACTION_NAMES: ActionName[] = [
  'moveUp',
  'moveDown',
  'moveLeft',
  'moveRight',
  'layerDrop',
  'pauseToggle',
];

/**
 * Binding pairs the shipped defaults intentionally share (GDD §5.1 / plan
 * decision: `S` is both move-down and layer-drop). These overlaps are not
 * treated as conflicts by `findConflict()`.
 */
const INTENTIONAL_OVERLAPS: ReadonlyArray<[ActionName, ActionName]> = [
  ['moveDown', 'layerDrop'],
];

/** Whether the given pair is one of the shipped defaults' intentional overlaps. */
function isIntentionalOverlap(a: ActionName, b: ActionName): boolean {
  return INTENTIONAL_OVERLAPS.some(
    ([x, y]) => (x === a && y === b) || (x === b && y === a),
  );
}

/**
 * Returns the first other action whose current binding shares `key` with
 * `action`, or `null` when the key is free. The intentional default overlap
 * (`S` shared by move-down and layer-drop) is never reported as a conflict.
 */
export function findConflict(
  bindings: Record<ActionName, string>,
  action: ActionName,
  key: string,
): ActionName | null {
  for (const other of ACTION_NAMES) {
    if (other === action) continue;
    if (bindings[other] !== key) continue;
    if (isIntentionalOverlap(action, other)) continue;
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
      bindings: { ...DEFAULT_BINDINGS, ...(parsed.bindings as Record<string, string> | undefined) },
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
