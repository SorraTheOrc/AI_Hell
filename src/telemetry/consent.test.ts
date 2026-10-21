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

/**
 * Dev collection-on-by-default (AH-0MVBMRIB800201KK, parent
 * AH-0MVBHRLY8004BGDN AC2/AC3): the (dev/prod) × (setting on/off) matrix,
 * proved through the composed resolution the game actually calls. The dev
 * collection flag is derived from the single dev gate
 * (`src/telemetry/devMode.ts`) — never re-implemented here.
 */
describe('resolveEffectiveTelemetryConfig — dev collection (AH-0MVBMRIB800201KK)', () => {
  const DEV_BUILD = { DEV: true } as const;
  const PROD_BUILD = { PROD: true } as const;
  const SHARE_ON = { shareTelemetryDev: true } as const;
  const SHARE_OFF = { shareTelemetryDev: false } as const;

  it('dev + setting on: records to the jsonl sink with no env vars at all', () => {
    const config = resolveEffectiveTelemetryConfig(DEV_BUILD, UNDECIDED, SHARE_ON);

    expect(config.devCollection).toBe(true);
    expect(config.recording).toBe(true);
    expect(config.enabled).toBe(false);
    expect(config.sink).toBe('jsonl');
  });

  it('dev + setting off: neither collects nor records', () => {
    const config = resolveEffectiveTelemetryConfig(DEV_BUILD, UNDECIDED, SHARE_OFF);

    expect(config.devCollection).toBe(false);
    expect(config.recording).toBe(false);
    expect(config.sink).toBe('none');
  });

  it('prod + setting on: the setting is inert and nothing records without consent', () => {
    const config = resolveEffectiveTelemetryConfig(PROD_BUILD, UNDECIDED, SHARE_ON);

    expect(config.devCollection).toBe(false);
    expect(config.production).toBe(true);
    expect(config.recording).toBe(false);
    expect(config.sink).toBe('none');
  });

  it('prod + setting off: unchanged (still disabled without env opt-in)', () => {
    const config = resolveEffectiveTelemetryConfig(PROD_BUILD, UNDECIDED, SHARE_OFF);

    expect(config.devCollection).toBe(false);
    expect(config.recording).toBe(false);
  });

  it('treats an omitted settings slice as "no dev collection"', () => {
    expect(resolveEffectiveTelemetryConfig(DEV_BUILD, UNDECIDED).recording).toBe(false);
    expect(resolveEffectiveTelemetryConfig(DEV_BUILD, UNDECIDED, {}).recording).toBe(false);
  });

  it('keeps the explicit dev env opt-in working when the setting is off', () => {
    const env = { DEV: true, VITE_TELEMETRY_ENABLED: 'true' } as const;
    const config = resolveEffectiveTelemetryConfig(env, UNDECIDED, SHARE_OFF);

    expect(config.devCollection).toBe(false);
    expect(config.recording).toBe(true);
    expect(config.sink).toBe('jsonl');
  });

  it('prod consent path unchanged (regression): setting on never bypasses consent', () => {
    const undecided = resolveEffectiveTelemetryConfig(PROD_REMOTE, UNDECIDED, SHARE_ON);
    const granted = resolveEffectiveTelemetryConfig(PROD_REMOTE, GRANTED, SHARE_ON);
    const denied = resolveEffectiveTelemetryConfig(PROD_REMOTE, DENIED, SHARE_ON);

    expect(undecided.recording).toBe(false);
    expect(granted.consent).toBe(true);
    expect(granted.recording).toBe(true);
    expect(granted.sink).toBe('remote');
    expect(granted.endpoint).toBe('https://telemetry.example/ingest');
    expect(denied.recording).toBe(false);
  });
});
