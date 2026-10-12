/**
 * Tests for telemetry configuration and the consent gate
 * (AH-0MUY08VJ9006BHJO, AC3).
 *
 * The policy under test: disabled by default, enabled only explicitly, and
 * production recording requires consent. Resolution is a pure function of an
 * injected environment, so each branch is exercised deterministically.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TELEMETRY_BATCH_SIZE,
  DEFAULT_TELEMETRY_BUFFER_CAPACITY,
  applyUserConsent,
  resolveBuildInfo,
  resolveTelemetryConfig,
} from './config';

describe('telemetry config — enable/consent policy', () => {
  it('is disabled by default', () => {
    const config = resolveTelemetryConfig({});

    expect(config.enabled).toBe(false);
    expect(config.recording).toBe(false);
    expect(config.sink).toBe('none');
    expect(config.sampleRate).toBe(1);
    expect(config.bufferCapacity).toBe(DEFAULT_TELEMETRY_BUFFER_CAPACITY);
    expect(config.batchSize).toBe(DEFAULT_TELEMETRY_BATCH_SIZE);
  });

  it('records in a dev build once explicitly enabled (no consent needed)', () => {
    const config = resolveTelemetryConfig({
      DEV: true,
      VITE_TELEMETRY_ENABLED: 'true',
    });

    expect(config.enabled).toBe(true);
    expect(config.consent).toBe(false);
    expect(config.recording).toBe(true);
    expect(config.sink).toBe('jsonl');
  });

  it('requires consent before recording in a production build', () => {
    const withoutConsent = resolveTelemetryConfig({
      PROD: true,
      VITE_TELEMETRY_ENABLED: '1',
    });
    const withConsent = resolveTelemetryConfig({
      PROD: true,
      VITE_TELEMETRY_ENABLED: '1',
      VITE_TELEMETRY_CONSENT: 'yes',
    });

    expect(withoutConsent.enabled).toBe(true);
    expect(withoutConsent.recording).toBe(false);
    expect(withConsent.consent).toBe(true);
    expect(withConsent.recording).toBe(true);
  });

  it('selects the configured sink', () => {
    expect(
      resolveTelemetryConfig({ VITE_TELEMETRY_ENABLED: 'on', VITE_TELEMETRY_SINK: 'remote' })
        .sink,
    ).toBe('remote');
    expect(
      resolveTelemetryConfig({ VITE_TELEMETRY_ENABLED: 'on', VITE_TELEMETRY_SINK: 'none' })
        .sink,
    ).toBe('none');
    // Unknown sink names fall back to the safe local sink.
    expect(
      resolveTelemetryConfig({ VITE_TELEMETRY_ENABLED: 'on', VITE_TELEMETRY_SINK: 'carrier-pigeon' })
        .sink,
    ).toBe('jsonl');
  });

  it('parses and clamps the sampling rate', () => {
    expect(resolveTelemetryConfig({ VITE_TELEMETRY_SAMPLE_RATE: '0.25' }).sampleRate).toBe(0.25);
    expect(resolveTelemetryConfig({ VITE_TELEMETRY_SAMPLE_RATE: '5' }).sampleRate).toBe(1);
    expect(resolveTelemetryConfig({ VITE_TELEMETRY_SAMPLE_RATE: '-2' }).sampleRate).toBe(0);
    expect(resolveTelemetryConfig({ VITE_TELEMETRY_SAMPLE_RATE: 'nonsense' }).sampleRate).toBe(1);
  });

  it('keeps the batch size within the ring-buffer capacity', () => {
    const config = resolveTelemetryConfig({
      VITE_TELEMETRY_BUFFER_CAPACITY: '8',
      VITE_TELEMETRY_BATCH_SIZE: '64',
    });

    expect(config.bufferCapacity).toBe(8);
    expect(config.batchSize).toBe(8);
  });

  it('exposes the production flag and the remote endpoint (AC2)', () => {
    const prod = resolveTelemetryConfig({
      PROD: true,
      VITE_TELEMETRY_ENABLED: 'on',
      VITE_TELEMETRY_SINK: 'remote',
      VITE_TELEMETRY_ENDPOINT: '  https://telemetry.example/ingest  ',
    });
    expect(prod.production).toBe(true);
    expect(prod.endpoint).toBe('https://telemetry.example/ingest');

    // A non-remote (or disabled) config never carries an endpoint.
    expect(
      resolveTelemetryConfig({
        VITE_TELEMETRY_ENABLED: 'on',
        VITE_TELEMETRY_SINK: 'jsonl',
        VITE_TELEMETRY_ENDPOINT: 'https://telemetry.example/ingest',
      }).endpoint,
    ).toBeUndefined();
    expect(resolveTelemetryConfig({}).endpoint).toBeUndefined();
  });
});

describe('applyUserConsent (AC1)', () => {
  it('recomputes the recording gate from the player decision in production', () => {
    const base = resolveTelemetryConfig({
      PROD: true,
      VITE_TELEMETRY_ENABLED: 'on',
      VITE_TELEMETRY_SINK: 'remote',
    });
    expect(base.recording).toBe(false);

    const granted = applyUserConsent(base, true);
    expect(granted.consent).toBe(true);
    expect(granted.recording).toBe(true);

    const denied = applyUserConsent(granted, false);
    expect(denied.consent).toBe(false);
    expect(denied.recording).toBe(false);
  });

  it('never enables recording for an unenabled config', () => {
    const disabled = resolveTelemetryConfig({ PROD: true });
    expect(applyUserConsent(disabled, true).recording).toBe(false);
  });
});

describe('telemetry build info', () => {
  it('defaults when no build variables are present', () => {
    expect(resolveBuildInfo({})).toEqual({ appVersion: '0.0.0-dev', commit: 'unknown' });
  });

  it('reads version and commit from the environment', () => {
    expect(
      resolveBuildInfo({ VITE_APP_VERSION: '0.1.10', VITE_GIT_COMMIT: 'abc1234' }),
    ).toEqual({ appVersion: '0.1.10', commit: 'abc1234' });
  });
});
