/**
 * Tests for the persisted telemetry consent store
 * (AH-0MUY08Y9P005ER7A, AC1/AC3).
 *
 * The store is the single auditable privacy artefact: default off/undecided,
 * an explicit decision persists across reloads, and corrupt/absent data never
 * accidentally grants consent.
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TELEMETRY_CONSENT,
  TELEMETRY_CONSENT_STORAGE_KEY,
  clearTelemetryConsent,
  loadTelemetryConsent,
  resolveTelemetryConsent,
  saveTelemetryConsent,
  setTelemetryConsent,
} from './telemetryConsentStore';

describe('telemetryConsentStore', () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to undecided and not granted (telemetry off)', () => {
    expect(loadTelemetryConsent()).toEqual(DEFAULT_TELEMETRY_CONSENT);
    expect(DEFAULT_TELEMETRY_CONSENT).toEqual({ granted: false, decided: false });
  });

  it('records an explicit grant and persists it across a reload', () => {
    const saved = setTelemetryConsent(true);

    expect(saved).toEqual({ granted: true, decided: true });
    expect(loadTelemetryConsent()).toEqual({ granted: true, decided: true });
  });

  it('records an explicit denial that persists', () => {
    setTelemetryConsent(false);

    const stored = loadTelemetryConsent();
    expect(stored.granted).toBe(false);
    expect(stored.decided).toBe(true);
  });

  it('treats corrupt or non-object JSON as the safe default', () => {
    window.localStorage.setItem(TELEMETRY_CONSENT_STORAGE_KEY, '{not json');
    expect(loadTelemetryConsent()).toEqual(DEFAULT_TELEMETRY_CONSENT);

    window.localStorage.setItem(TELEMETRY_CONSENT_STORAGE_KEY, '"a string"');
    expect(loadTelemetryConsent()).toEqual(DEFAULT_TELEMETRY_CONSENT);

    window.localStorage.setItem(
      TELEMETRY_CONSENT_STORAGE_KEY,
      JSON.stringify({ granted: 'yes', decided: 1 }),
    );
    expect(loadTelemetryConsent()).toEqual(DEFAULT_TELEMETRY_CONSENT);
  });

  it('coerces missing fields to the safe default', () => {
    expect(resolveTelemetryConsent({ granted: true })).toEqual({
      granted: true,
      decided: false,
    });
    expect(resolveTelemetryConsent(null)).toEqual(DEFAULT_TELEMETRY_CONSENT);
  });

  it('clears the decision so the player can be asked again', () => {
    setTelemetryConsent(true);
    clearTelemetryConsent();
    expect(loadTelemetryConsent()).toEqual(DEFAULT_TELEMETRY_CONSENT);
  });

  it('round-trips through an explicit save', () => {
    saveTelemetryConsent({ granted: true, decided: true });
    expect(loadTelemetryConsent()).toEqual({ granted: true, decided: true });
  });
});
