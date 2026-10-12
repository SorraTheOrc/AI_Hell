/**
 * Consent policy for production telemetry (AH-0MUY08Y9P005ER7A, AC1/AC3).
 *
 * The framework's {@link resolveTelemetryConfig} resolves the *environment*
 * policy (is telemetry enabled? is this a production build? is the consent
 * flag set?). This module layers the **player's persisted decision** on top:
 *
 * - while the player has not been asked (`decided === false`), the
 *   environment decision applies (so dev recording and operator overrides
 *   keep working);
 * - once the player has decided, their choice is authoritative — opting out
 *   always wins, even over a build-time consent flag.
 *
 * The prompt predicate is separate so the menu can ask once, only when
 * production telemetry is actually ready to record and the player has not
 * yet decided.
 *
 * @module src/telemetry/consent
 */

import {
  applyUserConsent,
  resolveTelemetryConfig,
  type TelemetryConfig,
  type TelemetryEnv,
} from './config';

/** The player's persisted telemetry-consent decision. */
export interface TelemetryConsentState {
  /** The player's current choice; `false` until they explicitly opt in. */
  readonly granted: boolean;
  /** Whether the player has been asked; the prompt only shows while `false`. */
  readonly decided: boolean;
}

/**
 * Whether this build needs an explicit player consent decision: telemetry is
 * enabled, this is a production build and records go to the remote sink.
 */
export function isTelemetryConsentRequired(config: TelemetryConfig): boolean {
  return config.enabled && config.production && config.sink === 'remote';
}

/**
 * Whether the in-game consent prompt should be shown: consent is required
 * and the player has not yet decided.
 */
export function shouldPromptForTelemetryConsent(
  config: TelemetryConfig,
  state: TelemetryConsentState,
): boolean {
  return isTelemetryConsentRequired(config) && !state.decided;
}

/**
 * Resolves the effective telemetry configuration: the environment config,
 * overridden by the player's persisted consent once they have decided.
 *
 * @param env - The environment slice, defaulting to `import.meta.env`.
 * @param state - The persisted consent state.
 */
export function resolveEffectiveTelemetryConfig(
  env: TelemetryEnv = import.meta.env,
  state: TelemetryConsentState,
): TelemetryConfig {
  const base = resolveTelemetryConfig(env);
  if (!state.decided) return base;
  return applyUserConsent(base, state.granted);
}
