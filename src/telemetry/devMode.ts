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
 * Loads the dev-only telemetry uploader, or `undefined` when this build has
 * no dev upload path at all.
 *
 * Vite statically replaces `import.meta.env.DEV` in this literal position
 * (the branch becomes `if (true)`/`if (false)` before bundling), so in a
 * production build Rollup eliminates the dynamic import — the dev-only
 * `devUpload` module and its endpoint never reach the shipped bundle
 * (enforced by `scripts/check-bundle-hygiene.mjs` / F1 AC4). This helper is
 * deliberately the **only** dynamic-entry point into `devUpload`: keeping it
 * here, inside the gate module, is what lets the scan treat this module as
 * the single dev-flag decision point while still statically eliminating the
 * upload path in production.
 *
 * The runtime gate ({@link isDevTelemetryUploadEnabled}) still decides
 * whether an actual upload happens at run end; this loader only decides
 * whether the uploader exists in the build.
 *
 * @returns The uploader in a dev build; `undefined` in a production build.
 */
export async function loadDevTelemetryUploader(): Promise<DevTelemetryUploader | undefined> {
  // Statically replaced by Vite: `false` in a production build, `true` in dev.
  if (!import.meta.env.DEV) return undefined;
  const { uploadDevTelemetry } = await import('./devUpload');
  return uploadDevTelemetry;
}

/**
 * Reads the current run's telemetry buffer through the dev-gated page
 * accessor `window.__aiHellTelemetry`.
 *
 * The dev CLI tooling (`npm run record`, `npm run capture`,
 * `npm run verify-dev-telemetry`) runs in Node and needs the run the page just
 * recorded. Before AH-0MVIRYGD1000JVY3 it read the local JSONL sink out of
 * `localStorage`; telemetry no longer uses storage at all, so the same content
 * is exposed from the page's in-memory buffer instead.
 */
export interface DevTelemetryBuffer {
  /** The current run's NDJSON content; `null`/empty when nothing is buffered. */
  read(): string | null;
}

declare global {
  interface Window {
    /**
     * Dev-gated read access to the in-memory run telemetry buffer. Installed
     * by `PlayScene` through {@link installDevTelemetryBuffer}, never written
     * in a production bundle (the install path is statically eliminated).
     */
    __aiHellTelemetry?: DevTelemetryBuffer;
  }
}

/**
 * Installs `window.__aiHellTelemetry` in a dev build only, so Node-side dev
 * tooling can read the run's in-memory buffer.
 *
 * Uses the same static-elimination pattern as
 * {@link loadDevTelemetryUploader}: Vite replaces `import.meta.env.DEV` in the
 * literal position below, so in a production build the branch is constant and
 * Rollup removes the global write entirely — the shipped bundle contains no
 * `__aiHellTelemetry` marker (enforced by `scripts/check-bundle-hygiene.mjs`).
 * The runtime {@link isDevTelemetryBuild} check keeps the contradictory-env
 * fail-closed rule.
 *
 * @param read - Reads the current run's NDJSON content from the recorder.
 */
export function installDevTelemetryBuffer(read: () => string | null): void {
  // Statically replaced by Vite: `false` in a production build, `true` in dev.
  if (!import.meta.env.DEV) return;
  if (!isDevTelemetryBuild() || typeof window === 'undefined') return;
  window.__aiHellTelemetry = { read };
}

/** Removes the dev telemetry buffer accessor, if present (dev builds only). */
export function clearDevTelemetryBuffer(): void {
  // Statically replaced by Vite: `false` in a production build, `true` in dev.
  if (!import.meta.env.DEV) return;
  if (typeof window === 'undefined') return;
  delete window.__aiHellTelemetry;
}

/** The uploader call signature `PlayScene` needs (devMode keeps no devUpload refs). */
export type DevTelemetryUploader = (options: {
  /** Persisted settings slice carrying the share-telemetry flag. */
  readonly setting?: DevTelemetrySetting;
  /** Reads the current run's in-memory NDJSON buffer. */
  readonly readSink: () => string | null;
  /** Failure reporter; never thrown to the caller. */
  readonly onError?: (error: unknown) => void;
}) => Promise<boolean>;

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
