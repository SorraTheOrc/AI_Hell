/**
 * Persisted telemetry consent state (AH-0MUY08Y9P005ER7A, AC1/AC3).
 *
 * Production telemetry is **opt-in**: nothing is recorded until the player
 * explicitly consents through the in-game prompt (or the Settings toggle).
 * The decision is persisted separately from the gameplay settings so a
 * "reset to defaults" of audio/controls never silently re-enables telemetry,
 * and so the consent record is a single, auditable privacy artefact.
 *
 * Mirrors the `settingsStore` pattern: typed record, defaults, corrupt-JSON
 * fallback and an SSR-safe storage guard. Two fields:
 *
 * - `granted` — the player's current choice (`false` until they opt in).
 * - `decided` — whether the player has been asked; the prompt only appears
 *   while this is `false`, so the question is asked once (and can always be
 *   changed later from Settings).
 */

import { type TelemetryConsentState } from '../telemetry/consent';

/** localStorage key holding the consent record. */
export const TELEMETRY_CONSENT_STORAGE_KEY = 'ai_hell_telemetry_consent';

/** The default consent state: undecided and not granted (telemetry off). */
export const DEFAULT_TELEMETRY_CONSENT: TelemetryConsentState = Object.freeze({
  granted: false,
  decided: false,
});

/** Returns a usable Storage, or `null` when unavailable (SSR/restricted). */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    // Accessing localStorage can throw in restricted contexts; treat it as
    // unavailable rather than crashing the game.
    return null;
  }
}

/**
 * Coerces an arbitrary decoded value into a valid {@link TelemetryConsentState}.
 * Missing/non-boolean fields fall back to the privacy-safe defaults.
 */
export function resolveTelemetryConsent(raw: unknown): TelemetryConsentState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_TELEMETRY_CONSENT };
  }
  const record = raw as Record<string, unknown>;
  return {
    granted: record.granted === true,
    decided: record.decided === true,
  };
}

/** Loads the persisted consent state, or the default when unset/corrupt. */
export function loadTelemetryConsent(): TelemetryConsentState {
  const store = storage();
  if (!store) return { ...DEFAULT_TELEMETRY_CONSENT };

  const raw = store.getItem(TELEMETRY_CONSENT_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_TELEMETRY_CONSENT };

  try {
    return resolveTelemetryConsent(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_TELEMETRY_CONSENT };
  }
}

/** Persists the consent state. No-op when storage is unavailable. */
export function saveTelemetryConsent(state: TelemetryConsentState): void {
  const store = storage();
  if (!store) return;
  store.setItem(
    TELEMETRY_CONSENT_STORAGE_KEY,
    JSON.stringify({ granted: state.granted, decided: state.decided }),
  );
}

/**
 * Records an explicit consent decision (the player opted in or out) and
 * persists it. Returns the stored state.
 */
export function setTelemetryConsent(granted: boolean): TelemetryConsentState {
  const state: TelemetryConsentState = { granted, decided: true };
  saveTelemetryConsent(state);
  return state;
}

/** Clears the stored decision, so the player is asked again (privacy reset). */
export function clearTelemetryConsent(): void {
  const store = storage();
  if (!store) return;
  store.removeItem(TELEMETRY_CONSENT_STORAGE_KEY);
}
