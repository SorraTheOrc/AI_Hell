/**
 * Tests for the production consent policy (AH-0MUY08Y9P005ER7A, AC1/AC3).
 *
 * Two things are covered: the effective config once the player has decided
 * (their choice is authoritative), and when the in-game prompt is shown
 * (production remote telemetry, not yet decided).
 */

import { describe, expect, it } from 'vitest';

import {
  isTelemetryConsentRequired,
  resolveEffectiveTelemetryConfig,
  shouldPromptForTelemetryConsent,
  type TelemetryConsentState,
} from './consent';
import { resolveTelemetryConfig } from './config';

const UNDECIDED: TelemetryConsentState = { granted: false, decided: false };
const GRANTED: TelemetryConsentState = { granted: true, decided: true };
const DENIED: TelemetryConsentState = { granted: false, decided: true };

const PROD_REMOTE = {
  PROD: true,
  VITE_TELEMETRY_ENABLED: 'true',
  VITE_TELEMETRY_SINK: 'remote',
  VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example/ingest',
} as const;

describe('isTelemetryConsentRequired', () => {
  it('requires consent only for enabled production remote telemetry', () => {
    expect(isTelemetryConsentRequired(resolveTelemetryConfig(PROD_REMOTE))).toBe(true);
    expect(
      isTelemetryConsentRequired(
        resolveTelemetryConfig({ ...PROD_REMOTE, VITE_TELEMETRY_SINK: 'jsonl' }),
      ),
    ).toBe(false);
    expect(
      isTelemetryConsentRequired(resolveTelemetryConfig({ PROD: true })),
    ).toBe(false);
    expect(isTelemetryConsentRequired(resolveTelemetryConfig({}))).toBe(false);
  });
});

describe('shouldPromptForTelemetryConsent', () => {
  it('shows the prompt only while production consent is required and undecided', () => {
    const config = resolveTelemetryConfig(PROD_REMOTE);
    expect(shouldPromptForTelemetryConsent(config, UNDECIDED)).toBe(true);
    expect(shouldPromptForTelemetryConsent(config, GRANTED)).toBe(false);
    expect(shouldPromptForTelemetryConsent(config, DENIED)).toBe(false);
  });

  it('never prompts for a dev or disabled build', () => {
    const dev = resolveTelemetryConfig({ DEV: true, VITE_TELEMETRY_ENABLED: 'true' });
    const disabled = resolveTelemetryConfig({});
    expect(shouldPromptForTelemetryConsent(dev, UNDECIDED)).toBe(false);
    expect(shouldPromptForTelemetryConsent(disabled, UNDECIDED)).toBe(false);
  });
});

describe('resolveEffectiveTelemetryConfig', () => {
  it('keeps dev recording without consent (dev is consent-free)', () => {
    const env = { DEV: true, VITE_TELEMETRY_ENABLED: 'true' } as const;
    // Undecided: environment policy applies.
    expect(resolveEffectiveTelemetryConfig(env, UNDECIDED).recording).toBe(true);
    // Denied in dev: dev recording still needs no consent.
    expect(resolveEffectiveTelemetryConfig(env, DENIED).recording).toBe(true);
  });

  it('blocks production recording until the player grants consent', () => {
    expect(resolveEffectiveTelemetryConfig(PROD_REMOTE, UNDECIDED).recording).toBe(false);
    expect(resolveEffectiveTelemetryConfig(PROD_REMOTE, GRANTED).recording).toBe(true);
    expect(resolveEffectiveTelemetryConfig(PROD_REMOTE, DENIED).recording).toBe(false);
  });

  it("lets the player's opt-out override a build-time consent flag", () => {
    const env = { ...PROD_REMOTE, VITE_TELEMETRY_CONSENT: 'true' } as const;
    const base = resolveTelemetryConfig(env);
    expect(base.recording).toBe(true);

    const denied = resolveEffectiveTelemetryConfig(env, DENIED);
    expect(denied.consent).toBe(false);
    expect(denied.recording).toBe(false);
  });

  it('carries the endpoint and production flag through', () => {
    const config = resolveEffectiveTelemetryConfig(PROD_REMOTE, GRANTED);
    expect(config.production).toBe(true);
    expect(config.endpoint).toBe('https://telemetry.example/ingest');
  });
});
