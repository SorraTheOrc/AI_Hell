/**
 * Unit tests for the single dev-only telemetry gate
 * (AH-0MVBMR0BG0005BBI, parent AH-0MVBHRLY8004BGDN).
 *
 * The gate decides whether dev-mode telemetry may be collected and uploaded,
 * and whether dev-only telemetry UI exists at all (`isDevTelemetryBuild`, used
 * by the Settings toggle). These tests pin the full truth table — dev+on,
 * dev+off, prod+on, prod+off, plus a missing/undefined setting and a
 * contradictory environment — for every exported predicate, and assert that
 * upload can never exceed collection. The gate is pure, so no build or browser
 * is needed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isDevTelemetryBuild,
  isDevTelemetryCollectionEnabled,
  isDevTelemetryUploadEnabled,
  loadDevTelemetryUploader,
  type DevModeEnv,
  type DevTelemetrySetting,
} from './devMode';
import {
  isDevTelemetryBuild as barrelBuild,
  isDevTelemetryCollectionEnabled as barrelCollection,
  isDevTelemetryUploadEnabled as barrelUpload,
} from './index';

const DEV_BUILD: DevModeEnv = { DEV: true };
const PROD_BUILD: DevModeEnv = { DEV: false, PROD: true };
const ON: DevTelemetrySetting = { shareTelemetryDev: true };
const OFF: DevTelemetrySetting = { shareTelemetryDev: false };

describe('isDevTelemetryBuild — dev-build predicate', () => {
  it('is true in a dev build', () => {
    expect(isDevTelemetryBuild(DEV_BUILD)).toBe(true);
  });

  it('is false in a production build', () => {
    expect(isDevTelemetryBuild(PROD_BUILD)).toBe(false);
  });

  it('is false for an empty environment', () => {
    expect(isDevTelemetryBuild({})).toBe(false);
  });

  it('fails closed on a contradictory environment (DEV and PROD both true)', () => {
    expect(isDevTelemetryBuild({ DEV: true, PROD: true })).toBe(false);
  });

  it('defaults its environment to import.meta.env (a dev build under test)', () => {
    expect(isDevTelemetryBuild(undefined)).toBe(
      import.meta.env.DEV === true && import.meta.env.PROD !== true,
    );
    expect(isDevTelemetryBuild()).toBe(true);
  });
});

describe('isDevTelemetryCollectionEnabled — truth table', () => {
  it('collects in a dev build with the setting on (dev+on)', () => {
    expect(isDevTelemetryCollectionEnabled(DEV_BUILD, ON)).toBe(true);
  });

  it('does not collect in a dev build with the setting off (dev+off)', () => {
    expect(isDevTelemetryCollectionEnabled(DEV_BUILD, OFF)).toBe(false);
  });

  it('does not collect in a production build even with the setting on (prod+on)', () => {
    expect(isDevTelemetryCollectionEnabled(PROD_BUILD, ON)).toBe(false);
  });

  it('does not collect in a production build with the setting off (prod+off)', () => {
    expect(isDevTelemetryCollectionEnabled(PROD_BUILD, OFF)).toBe(false);
  });

  it('treats a missing/undefined setting as opted out', () => {
    expect(isDevTelemetryCollectionEnabled(DEV_BUILD)).toBe(false);
    expect(isDevTelemetryCollectionEnabled(DEV_BUILD, undefined)).toBe(false);
    expect(isDevTelemetryCollectionEnabled(DEV_BUILD, {})).toBe(false);
  });

  it('treats an empty environment as not a dev build', () => {
    expect(isDevTelemetryCollectionEnabled({}, ON)).toBe(false);
  });

  it('fails closed on a contradictory environment (DEV and PROD both true)', () => {
    expect(isDevTelemetryCollectionEnabled({ DEV: true, PROD: true }, ON)).toBe(false);
  });

  it('defaults its environment to import.meta.env (a dev build under test)', () => {
    expect(isDevTelemetryCollectionEnabled(undefined, ON)).toBe(
      import.meta.env.DEV === true && import.meta.env.PROD !== true,
    );
    expect(isDevTelemetryCollectionEnabled(undefined, ON)).toBe(true);
  });
});

describe('isDevTelemetryUploadEnabled — truth table', () => {
  it('uploads in a dev build with the setting on (dev+on)', () => {
    expect(isDevTelemetryUploadEnabled(DEV_BUILD, ON)).toBe(true);
  });

  it('does not upload in a dev build with the setting off (dev+off)', () => {
    expect(isDevTelemetryUploadEnabled(DEV_BUILD, OFF)).toBe(false);
  });

  it('does not upload in a production build even with the setting on (prod+on)', () => {
    expect(isDevTelemetryUploadEnabled(PROD_BUILD, ON)).toBe(false);
  });

  it('does not upload in a production build with the setting off (prod+off)', () => {
    expect(isDevTelemetryUploadEnabled(PROD_BUILD, OFF)).toBe(false);
  });

  it('treats a missing/undefined setting as opted out', () => {
    expect(isDevTelemetryUploadEnabled(DEV_BUILD)).toBe(false);
    expect(isDevTelemetryUploadEnabled(DEV_BUILD, undefined)).toBe(false);
    expect(isDevTelemetryUploadEnabled(DEV_BUILD, {})).toBe(false);
  });

  it('never exceeds collection: every matrix entry matches the collection gate', () => {
    for (const env of [DEV_BUILD, PROD_BUILD, {}, { DEV: true, PROD: true }]) {
      for (const setting of [ON, OFF, {}, undefined]) {
        expect(isDevTelemetryUploadEnabled(env, setting)).toBe(
          isDevTelemetryCollectionEnabled(env, setting),
        );
      }
    }
  });
});

describe('dev-only telemetry gate — public surface', () => {
  it('exports the gate predicates from the telemetry barrel', () => {
    expect(barrelBuild(DEV_BUILD)).toBe(true);
    expect(barrelBuild(PROD_BUILD)).toBe(false);
    expect(barrelCollection(DEV_BUILD, ON)).toBe(true);
    expect(barrelCollection(PROD_BUILD, ON)).toBe(false);
    expect(barrelUpload(DEV_BUILD, ON)).toBe(true);
    expect(barrelUpload(PROD_BUILD, ON)).toBe(false);
  });
});

describe('loadDevTelemetryUploader — build-folded dev-only loader', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves to the uploader in a dev build', async () => {
    const uploader = await loadDevTelemetryUploader();

    expect(typeof uploader).toBe('function');
  });

  it('resolves to undefined in a production build (uploader never loaded)', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);

    await expect(loadDevTelemetryUploader()).resolves.toBeUndefined();
  });
});
