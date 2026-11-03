/**
 * Feature flags (AH-0MVZ0VGGQ0032KDP).
 *
 * The **Hangar War** outer loop's player-visible entry surfaces — the
 * main-menu control and the idle-attract Hangar War traversal — sit behind a
 * persisted feature flag. The flag was introduced **OFF by default** while the
 * feature did not work; the defect is now fixed and verified end to end
 * (AH-0MVZ4S9ZU004GXUM), so the flag is **ON by default** and the shipped
 * (production) build runs the Hangar War. Scenes stay registered either way.
 *
 * Two rules keep the flag safe to ship:
 *
 * 1. **One effective value, every build.** {@link resolveHangarWarEnabled} is
 *    the single resolver: it returns the persisted value, which defaults to
 *    ON. A production build therefore runs the Hangar War, and the flag acts
 *    as a kill switch rather than a build gate.
 * 2. **The enable surface is dev-only.** {@link setHangarWarEnabled} and
 *    {@link toggleHangarWarEnabled} are no-ops outside a dev build, so a
 *    shipped build always uses the default (ON) and no production UI can flip
 *    it. The decision to ship the feature ON is recorded on
 *    AH-0MVZ0VGGQ0032KDP.
 *
 * Persistence follows the `settingsStore` pattern: a typed record under one
 * `localStorage` key, merge-over-defaults on load, corrupt-JSON fallback and an
 * SSR-safe storage guard. Writes never throw (a full quota or disabled storage
 * must not break the menu's input handler).
 *
 * @module featureFlags
 */

/** The persisted feature-flag record. */
export interface FeatureFlagsRecord {
  /** Whether the Hangar War entry surfaces are enabled (dev builds only). */
  hangarWar: boolean;
}

/** The environment slice the dev gate reads (a subset of `import.meta.env`). */
export interface FeatureFlagEnv {
  /** True in a Vite dev build. */
  readonly DEV?: boolean;
  /** True in a Vite production build; a contradictory env fails closed. */
  readonly PROD?: boolean;
}

/** `localStorage` key holding the persisted feature flags. */
export const FEATURE_FLAGS_STORAGE_KEY = 'ai_hell_feature_flags';

/**
 * Built-in defaults.
 *
 * `hangarWar` is **ON**: the flow is verified end to end in the shipped game
 * (AH-0MVZ4S9ZU004GXUM), so the outer loop ships enabled. The flag is kept as
 * a kill switch — a persisted `false` disables the entry surfaces again.
 */
export const DEFAULT_FEATURE_FLAGS: Readonly<FeatureFlagsRecord> = {
  hangarWar: true,
};

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
 * True when this is a Vite **dev** build — the only build in which a feature
 * flag can be flipped from a UI ({@link setHangarWarEnabled}).
 *
 * Fails closed on a contradictory environment (both `DEV` and `PROD` true),
 * so an ambiguous build can never expose a developer-only control.
 *
 * @param env - The build environment, defaulting to `import.meta.env`.
 */
export function isDevBuild(env: FeatureFlagEnv = import.meta.env): boolean {
  return env.DEV === true && env.PROD !== true;
}

/**
 * Loads the persisted feature flags, or the defaults when nothing has been
 * saved (or the stored JSON is corrupt / not an object). A partial record is
 * merged over the defaults, and each value is coerced to a boolean so a
 * legacy or hand-edited record cannot leak a truthy string into a gate.
 */
export function loadFeatureFlags(): FeatureFlagsRecord {
  const store = storage();
  if (!store) return { ...DEFAULT_FEATURE_FLAGS };

  const raw = store.getItem(FEATURE_FLAGS_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_FEATURE_FLAGS };

  try {
    const parsed = JSON.parse(raw) as Partial<FeatureFlagsRecord> | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...DEFAULT_FEATURE_FLAGS };
    }
    return {
      hangarWar:
        typeof parsed.hangarWar === 'boolean'
          ? parsed.hangarWar
          : DEFAULT_FEATURE_FLAGS.hangarWar,
    };
  } catch {
    return { ...DEFAULT_FEATURE_FLAGS };
  }
}

/**
 * Persists the supplied flag record. No-op when storage is unavailable.
 *
 * Never throws: `localStorage.setItem` can throw `QuotaExceededError` or
 * `SecurityError`, and this is called from Phaser input handlers.
 */
export function saveFeatureFlags(flags: FeatureFlagsRecord): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(flags));
  } catch (error) {
    console.warn(
      '[featureFlags] Could not persist feature flags (storage full or unavailable); ' +
        'the change applies to this session only.',
      error,
    );
  }
}

/**
 * Resets every feature flag to its built-in default (`hangarWar` ON) and
 * persists it. No-op when storage is unavailable.
 */
export function resetFeatureFlags(): void {
  saveFeatureFlags({ ...DEFAULT_FEATURE_FLAGS });
}

/**
 * The effective Hangar War flag: the persisted value, which defaults to ON.
 *
 * This is the **single** resolver for the flag and it is build-agnostic on
 * purpose: the shipped (production) build runs the Hangar War because the
 * flow now works (AH-0MVZ4S9ZU004GXUM), and the persisted `false` is the kill
 * switch. Enabling or disabling it from a UI is still dev-only — see
 * {@link setHangarWarEnabled}.
 *
 * @param flags - The flag record, defaulting to the persisted one.
 */
export function resolveHangarWarEnabled(
  flags: FeatureFlagsRecord = loadFeatureFlags(),
): boolean {
  return flags.hangarWar === true;
}

/**
 * Enables or disables the Hangar War entry surfaces. **Dev builds only**: in
 * a production build nothing is stored, so the shipped default (ON) is what
 * players get and no production UI can flip the kill switch.
 *
 * @param enabled - The requested value.
 * @param env - The build environment, defaulting to `import.meta.env`.
 * @returns The resulting effective value (the unchanged shipped default when
 *   the write is refused outside a dev build).
 */
export function setHangarWarEnabled(
  enabled: boolean,
  env: FeatureFlagEnv = import.meta.env,
): boolean {
  if (!isDevBuild(env)) return resolveHangarWarEnabled();
  const next: FeatureFlagsRecord = { ...loadFeatureFlags(), hangarWar: enabled };
  saveFeatureFlags(next);
  return resolveHangarWarEnabled(next);
}

/**
 * Flips the Hangar War flag. **Dev builds only** (see
 * {@link setHangarWarEnabled}).
 *
 * @param env - The build environment, defaulting to `import.meta.env`.
 * @returns The resulting effective value.
 */
export function toggleHangarWarEnabled(env: FeatureFlagEnv = import.meta.env): boolean {
  return setHangarWarEnabled(!loadFeatureFlags().hangarWar, env);
}
