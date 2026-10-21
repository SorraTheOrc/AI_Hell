/**
 * The single dev-only telemetry gate (AH-0MVBMR0BG0005BBI, parent
 * AH-0MVBHRLY8004BGDN).
 *
 * Dev-mode telemetry (automatic collection plus the end-of-run upload to the
 * dev server) must be **unreachable** in a production build. Every caller
 * therefore routes its decision through this module, and this module decides
 * it in exactly one place:
 *
 * ```ts
 * import { isDevTelemetryUploadEnabled } from '../telemetry/devMode';
 *
 * if (!isDevTelemetryUploadEnabled(import.meta.env, settings)) return;
 * ```
 *
 * The gate is true only when the build is a Vite **dev** build
 * (`env.DEV === true`) **and** the player's "share telemetry with the dev
 * server" setting is on (`setting.shareTelemetryDev === true`). A contradictory
 * environment (both `DEV` and `PROD` true) fails closed. `import.meta.env.DEV`
 * is statically replaced by Vite, so in a production build the predicate is a
 * constant `false` and callers' bodies are dead-code-eliminated.
 *
 * Both exported predicates are pure functions of an injected environment and
 * settings slice (defaulting to `import.meta.env`), so the whole truth table
 * is unit-testable without a real build. No other module may re-implement the
 * decision — `src/telemetry/devModeEnforcement.test.ts` fails the suite if one
 * does.
 *
 * {@link isDevTelemetryBuild} is the only way other modules may ask "is this a
 * dev build?". Keeping that question here means the enforcement scan still
 * sees this module as the sole dev-flag decision point, even for dev-only UI
 * such as the Settings toggle.
 *
 * @module src/telemetry/devMode
 */

/** The environment slice the dev gate reads (a subset of `import.meta.env`). */
export interface DevModeEnv {
  /** True in a Vite dev build. */
  readonly DEV?: boolean;
  /** True in a Vite production build; a contradictory env fails closed. */
  readonly PROD?: boolean;
}

/** The settings slice the dev gate reads (a subset of `SettingsRecord`). */
export interface DevTelemetrySetting {
  /** Whether the player shares telemetry with the dev server. */
  readonly shareTelemetryDev?: boolean;
}

/**
 * True when this is a Vite **dev** build — the only build in which dev-mode
 * telemetry (and its Settings toggle) exists at all.
 *
 * Fails closed on a contradictory environment (both `DEV` and `PROD` true),
 * matching the collection/upload gate. Dev-only UI must use this predicate
 * rather than reading `import.meta.env.DEV` itself, so the gate module stays
 * the single dev-flag decision point (enforced by
 * `src/telemetry/devModeEnforcement.test.ts`).
 *
 * @param env - The build environment, defaulting to `import.meta.env`.
 */
export function isDevTelemetryBuild(env: DevModeEnv = import.meta.env): boolean {
  return env.DEV === true && env.PROD !== true;
}

/**
 * True when this dev build may **collect** telemetry by default.
 *
 * Requires an explicit opt-in setting: enabling dev collection is never
 * implicit. A missing/undefined setting is treated as off, so a caller that
 * forgets to pass settings collects nothing.
 *
 * @param env - The build environment, defaulting to `import.meta.env`.
 * @param setting - The player's settings slice (may be `undefined`).
 */
export function isDevTelemetryCollectionEnabled(
  env: DevModeEnv = import.meta.env,
  setting?: DevTelemetrySetting,
): boolean {
  return isDevTelemetryBuild(env) && setting?.shareTelemetryDev === true;
}

/**
 * True when this dev build may **upload** its telemetry to the dev server.
 *
 * Upload is a strict subset of collection: it delegates to
 * {@link isDevTelemetryCollectionEnabled}, so no build can upload what it was
 * not allowed to collect. This module stays the single decision point.
 *
 * @param env - The build environment, defaulting to `import.meta.env`.
 * @param setting - The player's settings slice (may be `undefined`).
 */
export function isDevTelemetryUploadEnabled(
  env: DevModeEnv = import.meta.env,
  setting?: DevTelemetrySetting,
): boolean {
  return isDevTelemetryCollectionEnabled(env, setting);
}
