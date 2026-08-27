/**
 * Ship configuration module (GDD §2.2 Newtonian-drift model).
 *
 * Single source of truth for ship tuning values. Values are persisted as a
 * JSON blob in the browser's localStorage (browser-native, GDD §6.3 web
 * distribution model), so tuning adjustments made via the gym scene's
 * sliders survive page reloads. Falls back to built-in defaults whenever
 * no saved config exists or the stored JSON is corrupt.
 *
 * NOTE: `constants.ts` re-exports the default values from here so existing
 * importers keep working unchanged.
 */

export interface ShipConfig {
  /** Acceleration applied each second a thrust direction is held (px/s²). */
  thrustAcceleration: number;
  /** Absolute speed cap to prevent unbounded acceleration (px/s). */
  maxSpeed: number;
  /** Ship size used for visual rendering and physics bounds (px). */
  shipSize: number;
  /** Thrust flame length multiplier relative to ship size. */
  thrustFlameLength: number;
  /** Ship colour — neon cyan per the GDD art direction. */
  shipColor: number;
  /** Thrust flame colour — hot orange/yellow. */
  thrustFlameColor: number;
  /** Inner flame colour — bright yellow. */
  thrustFlameInnerColor: number;
  /** Linear deceleration rate (px/s²) when no direction keys are held; 0 = zero friction. */
  frictionDeceleration: number;
}

/** Built-in defaults — the current hard-coded tuning values. */
export const DEFAULT_CONFIG: ShipConfig = {
  thrustAcceleration: 300,
  maxSpeed: 175,
  shipSize: 20,
  thrustFlameLength: 0.75,
  shipColor: 0x00ffff,
  thrustFlameColor: 0xff8c00,
  thrustFlameInnerColor: 0xffff00,
  frictionDeceleration: 100,
};

/** localStorage key under which the ship config JSON is persisted. */
export const CONFIG_STORAGE_KEY = 'ai-hell-ship-config';

/**
 * Returns a usable Storage instance, or null when localStorage is
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

/**
 * Loads the persisted ship config, or the defaults when nothing has been
 * saved (or the stored JSON is corrupt). A partial stored config is merged
 * over the defaults so the result is always complete and valid.
 */
export function loadShipConfig(): ShipConfig {
  const store = storage();
  if (!store) return { ...DEFAULT_CONFIG };

  const raw = store.getItem(CONFIG_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_CONFIG };

  try {
    const parsed = JSON.parse(raw) as Partial<ShipConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Persists the supplied values to the config storage as JSON.
 * No-op when storage is unavailable.
 */
export function saveShipConfig(values: ShipConfig): void {
  const store = storage();
  if (!store) return;
  store.setItem(CONFIG_STORAGE_KEY, JSON.stringify(values));
}