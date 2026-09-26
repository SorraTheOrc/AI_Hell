/**
 * Player-death juice parameter model — pure-logic contract (F1,
 * parent AH-0MUAYB4R3002ZIZY).
 *
 * This file is the test-first spec: `playerDeathJuice.ts` must satisfy
 * every acceptance criterion below. It exercises only the pure parameter
 * model (no Phaser import), so it runs headless with no rendering.
 */

import { describe, expect, it } from 'vitest';
import {
  PLAYER_DEATH_DEBRIS_COUNT,
  PLAYER_DEATH_DEBRIS_LIFESPAN_MS,
  PLAYER_DEATH_FLASH_ALPHA,
  PLAYER_DEATH_FLASH_COLOR,
  PLAYER_DEATH_FLASH_DURATION_MS,
  PLAYER_DEATH_PARTICLE_LIFESPAN_MS,
  PLAYER_DEATH_PARTICLE_SCALE,
  PLAYER_DEATH_SEVERITY_FATAL_DEBRIS_COUNT_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_FLASH_ALPHA_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_SHAKE_DURATION_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_SHAKE_INTENSITY_MULT,
  PLAYER_DEATH_SEVERITY_FATAL_SHOCKWAVE_RADIUS_MULT,
  PLAYER_DEATH_SHAKE_DURATION_MS,
  PLAYER_DEATH_SHAKE_INTENSITY,
  PLAYER_DEATH_SHOCKWAVE_DURATION_MS,
  PLAYER_DEATH_SHOCKWAVE_RADIUS,
  PLAYER_DEATH_ENABLE_DEBRIS,
  PLAYER_DEATH_ENABLE_FLASH,
  PLAYER_DEATH_ENABLE_SHAKE,
  PLAYER_DEATH_ENABLE_SHOCKWAVE,
  resolveJuiceParams,
  type PlayerDeathJuiceParams,
} from './playerDeathJuice';
import { SHIP_COLOR } from '../core/constants';

/** Every field that must be populated on a resolved parameter set. */
const REQUIRED_FIELDS: Array<keyof PlayerDeathJuiceParams> = [
  'shakeIntensity',
  'shakeDurationMs',
  'shakeEnabled',
  'flashAlpha',
  'flashDurationMs',
  'flashColor',
  'flashEnabled',
  'particleCount',
  'particleLifespanMs',
  'particleScale',
  'particlesEnabled',
  'debrisCount',
  'debrisLifespanMs',
  'debrisEnabled',
  'shockwaveRadius',
  'shockwaveDurationMs',
  'shockwaveEnabled',
  'soundEnabled',
];

describe('resolveJuiceParams — pure player-death parameter model (F1)', () => {
  it('returns a complete parameter set for both severities', () => {
    for (const severity of ['respawn', 'fatal'] as const) {
      const params = resolveJuiceParams(severity);
      for (const field of REQUIRED_FIELDS) {
        expect(params[field], `${severity}.${field}`).toBeDefined();
      }
    }
  });

  it('is deterministic — repeated calls return equal values', () => {
    expect(resolveJuiceParams('fatal')).toEqual(resolveJuiceParams('fatal'));
    expect(resolveJuiceParams('respawn')).toEqual(resolveJuiceParams('respawn'));
  });

  it('scales every asserted magnitude heavier for fatal than respawn', () => {
    const respawn = resolveJuiceParams('respawn');
    const fatal = resolveJuiceParams('fatal');

    expect(fatal.shakeIntensity).toBeGreaterThan(respawn.shakeIntensity);
    expect(fatal.shakeDurationMs).toBeGreaterThan(respawn.shakeDurationMs);
    expect(fatal.flashAlpha).toBeGreaterThan(respawn.flashAlpha);
    expect(fatal.debrisCount).toBeGreaterThan(respawn.debrisCount);
    expect(fatal.shockwaveRadius).toBeGreaterThan(respawn.shockwaveRadius);
  });

  it('applies the documented severity multipliers to the base constants', () => {
    const fatal = resolveJuiceParams('fatal');

    expect(fatal.shakeIntensity).toBeCloseTo(
      PLAYER_DEATH_SHAKE_INTENSITY * PLAYER_DEATH_SEVERITY_FATAL_SHAKE_INTENSITY_MULT,
      10,
    );
    expect(fatal.shakeDurationMs).toBe(
      PLAYER_DEATH_SHAKE_DURATION_MS * PLAYER_DEATH_SEVERITY_FATAL_SHAKE_DURATION_MULT,
    );
    expect(fatal.flashAlpha).toBeCloseTo(
      PLAYER_DEATH_FLASH_ALPHA * PLAYER_DEATH_SEVERITY_FATAL_FLASH_ALPHA_MULT,
      10,
    );
    expect(fatal.debrisCount).toBe(
      PLAYER_DEATH_DEBRIS_COUNT * PLAYER_DEATH_SEVERITY_FATAL_DEBRIS_COUNT_MULT,
    );
    expect(fatal.shockwaveRadius).toBe(
      PLAYER_DEATH_SHOCKWAVE_RADIUS * PLAYER_DEATH_SEVERITY_FATAL_SHOCKWAVE_RADIUS_MULT,
    );
  });

  it('returns the respawn set for unknown or invalid severity and never throws', () => {
    const respawn = resolveJuiceParams('respawn');
    expect(resolveJuiceParams('nope' as never)).toEqual(respawn);
    expect(resolveJuiceParams('' as never)).toEqual(respawn);
    expect(resolveJuiceParams(undefined as never)).toEqual(respawn);
    expect(resolveJuiceParams(null as never)).toEqual(respawn);
  });

  it('keeps the base tuning inside the intake-specified bounds', () => {
    // Intake assumptions: shake intensity ~0.008–0.02, duration ~250–400 ms,
    // flash duration ~120–200 ms.
    expect(PLAYER_DEATH_SHAKE_INTENSITY).toBeGreaterThanOrEqual(0.008);
    expect(PLAYER_DEATH_SHAKE_INTENSITY).toBeLessThanOrEqual(0.02);
    expect(PLAYER_DEATH_SHAKE_DURATION_MS).toBeGreaterThanOrEqual(250);
    expect(PLAYER_DEATH_SHAKE_DURATION_MS).toBeLessThanOrEqual(400);
    expect(PLAYER_DEATH_FLASH_DURATION_MS).toBeGreaterThanOrEqual(120);
    expect(PLAYER_DEATH_FLASH_DURATION_MS).toBeLessThanOrEqual(200);
  });

  it('centres flash and debris colours on SHIP_COLOR', () => {
    expect(PLAYER_DEATH_FLASH_COLOR).toBe(SHIP_COLOR);
    expect(resolveJuiceParams('respawn').flashColor).toBe(SHIP_COLOR);
    expect(resolveJuiceParams('fatal').flashColor).toBe(SHIP_COLOR);
  });

  it('carries particle overrides for the delegated particle burst', () => {
    const params = resolveJuiceParams('respawn');
    expect(params.particleLifespanMs).toBe(PLAYER_DEATH_PARTICLE_LIFESPAN_MS);
    expect(params.particleScale).toBe(PLAYER_DEATH_PARTICLE_SCALE);
    expect(params.particleCount).toBeGreaterThan(0);
  });

  it('exposes per-layer toggles that default to enabled', () => {
    expect(PLAYER_DEATH_ENABLE_SHAKE).toBe(true);
    expect(PLAYER_DEATH_ENABLE_FLASH).toBe(true);
    expect(PLAYER_DEATH_ENABLE_DEBRIS).toBe(true);
    expect(PLAYER_DEATH_ENABLE_SHOCKWAVE).toBe(true);

    const params = resolveJuiceParams('respawn');
    expect(params.shakeEnabled).toBe(PLAYER_DEATH_ENABLE_SHAKE);
    expect(params.flashEnabled).toBe(PLAYER_DEATH_ENABLE_FLASH);
    expect(params.debrisEnabled).toBe(PLAYER_DEATH_ENABLE_DEBRIS);
    expect(params.shockwaveEnabled).toBe(PLAYER_DEATH_ENABLE_SHOCKWAVE);
    expect(params.particlesEnabled).toBe(true);
    expect(params.soundEnabled).toBe(true);
  });

  it('keeps lengths finite positive numbers suitable for tweens', () => {
    const params = resolveJuiceParams('fatal');
    expect(params.debrisLifespanMs).toBe(PLAYER_DEATH_DEBRIS_LIFESPAN_MS);
    expect(params.shockwaveDurationMs).toBe(PLAYER_DEATH_SHOCKWAVE_DURATION_MS);
    for (const value of [params.shakeDurationMs, params.flashDurationMs, params.debrisLifespanMs, params.shockwaveDurationMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
