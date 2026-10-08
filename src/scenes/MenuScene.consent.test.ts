/**
 * Tests for the menu's production-telemetry consent gate
 * (AH-0MUY08Y9P005ER7A, AC1).
 *
 * The gate is a pure function of the build environment and the persisted
 * consent state, so every branch is exercised deterministically without a
 * real production build.
 */

import { describe, expect, it } from 'vitest';

import { shouldShowTelemetryConsentPrompt } from './MenuScene';

const PROD_REMOTE = {
  PROD: true,
  VITE_TELEMETRY_ENABLED: 'true',
  VITE_TELEMETRY_SINK: 'remote',
  VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example/ingest',
} as const;

describe('shouldShowTelemetryConsentPrompt (AH-0MUY08Y9P005ER7A)', () => {
  it('shows the prompt once for production remote telemetry', () => {
    expect(
      shouldShowTelemetryConsentPrompt(PROD_REMOTE, { granted: false, decided: false }),
    ).toBe(true);
  });

  it('does not prompt after the player has decided (either way)', () => {
    expect(
      shouldShowTelemetryConsentPrompt(PROD_REMOTE, { granted: true, decided: true }),
    ).toBe(false);
    expect(
      shouldShowTelemetryConsentPrompt(PROD_REMOTE, { granted: false, decided: true }),
    ).toBe(false);
  });

  it('does not prompt for dev, disabled or local-sink builds', () => {
    expect(
      shouldShowTelemetryConsentPrompt(
        { DEV: true, VITE_TELEMETRY_ENABLED: 'true' },
        { granted: false, decided: false },
      ),
    ).toBe(false);
    expect(
      shouldShowTelemetryConsentPrompt({}, { granted: false, decided: false }),
    ).toBe(false);
    expect(
      shouldShowTelemetryConsentPrompt(
        { ...PROD_REMOTE, VITE_TELEMETRY_SINK: 'jsonl' },
        { granted: false, decided: false },
      ),
    ).toBe(false);
  });
});
