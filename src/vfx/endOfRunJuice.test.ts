/**
 * Tests for the end-of-run juice parameter model
 * (parent AH-0MUTV7632000ZWCB, feature F1).
 */

import { describe, expect, it } from 'vitest';
import {
  resolveEndOfRunJuiceParams,
  type EndOfRunOutcome,
  ENDOFRUN_DEFAULT_OUTCOME,
  ENDOFRUN_ENABLE_VICTORY_FLASH,
  ENDOFRUN_ENABLE_VICTORY_PARTICLES,
  ENDOFRUN_ENABLE_VICTORY_RING,
  ENDOFRUN_ENABLE_DEFEAT_VIGNETTE,
  ENDOFRUN_ENABLE_DEFEAT_GLITCH,
  ENDOFRUN_ENABLE_DEFEAT_RING,
  ENDOFRUN_ENABLE_SOUND,
  ENDOFRUN_VICTORY_FLASH_ALPHA,
  ENDOFRUN_VICTORY_PARTICLE_COUNT,
  ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS,
  ENDOFRUN_VICTORY_PARTICLE_VELOCITY,
  ENDOFRUN_VICTORY_PARTICLE_SCALE,
  ENDOFRUN_VICTORY_RING_RADIUS,
  ENDOFRUN_DEFEAT_VIGNETTE_ALPHA,
  ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS,
  ENDOFRUN_DEFEAT_GLITCH_STEPS,
  ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS,
  ENDOFRUN_DEFEAT_GLITCH_ALPHA,
  ENDOFRUN_DEFEAT_RING_RADIUS,
  ENDOFRUN_VICTORY_COLOR,
  ENDOFRUN_VICTORY_GREEN,
  ENDOFRUN_VICTORY_SPARKLE,
  ENDOFRUN_DEFEAT_COLOR,
  ENDOFRUN_DEFEAT_RED,
  ENDOFRUN_DEFEAT_GRAY,
  ENDOFRUN_RING_DURATION_MS,
  ENDOFRUN_RING_START_SCALE,
  ENDOFRUN_RING_LINE_WIDTH,
} from './endOfRunJuice';

// ── Fixture helpers ──────────────────────────────────────────────────

/**
 * Resolves params for `outcome` and returns the result.
 * A thin wrapper so tests that exercise the outcome values stay readable.
 */
function paramsFor(outcome: string | null | undefined) {
  return resolveEndOfRunJuiceParams(outcome);
}

// ── Outcome coverage ────────────────────────────────────────────────

describe('resolveEndOfRunJuiceParams', () => {
  it('returns victory parameters for "victory"', () => {
    const p = paramsFor('victory');
    expect(p.victoryFlashEnabled).toBe(true);
    expect(p.victoryParticleCount).toBeGreaterThan(0);
    expect(p.victoryRingRadius).toBeGreaterThan(0);
    expect(p.victoryParticlesEnabled).toBe(true);
    expect(p.victoryRingEnabled).toBe(true);
    expect(p.soundEnabled).toBe(true);
  });

  it('returns defeat parameters for "defeat"', () => {
    const p = paramsFor('defeat');
    expect(p.defeatVignetteEnabled).toBe(true);
    expect(p.defeatGlitchEnabled).toBe(true);
    expect(p.defeatRingEnabled).toBe(true);
    expect(p.defeatVignetteAlpha).toBeGreaterThan(0);
    expect(p.defeatGlitchSteps).toBeGreaterThan(0);
    expect(p.soundEnabled).toBe(true);
  });

  it('defaults to victory for unknown strings', () => {
    const p = paramsFor('unknown');
    expect(p.victoryParticlesEnabled).toBe(true);
    expect(p.victoryFlashEnabled).toBe(true);
  });

  it('defaults to victory for null', () => {
    const p = paramsFor(null);
    expect(p.victoryParticlesEnabled).toBe(true);
  });

  it('defaults to victory for undefined', () => {
    const p = paramsFor(undefined);
    expect(p.victoryParticlesEnabled).toBe(true);
  });

  it('defaults to victory for empty string', () => {
    const p = paramsFor('');
    expect(p.victoryParticlesEnabled).toBe(true);
  });

  // ── Victory palette colours ──────────────────────────────────────

  it('victory params carry the correct palette colours', () => {
    const p = paramsFor('victory');
    expect(p.victoryColor).toBe(ENDOFRUN_VICTORY_COLOR);
    expect(p.victoryGreen).toBe(ENDOFRUN_VICTORY_GREEN);
    expect(p.victorySparkle).toBe(ENDOFRUN_VICTORY_SPARKLE);
  });

  // ── Defeat palette colours ───────────────────────────────────────

  it('defeat params carry the correct palette colours', () => {
    const p = paramsFor('defeat');
    expect(p.defeatColor).toBe(ENDOFRUN_DEFEAT_COLOR);
    expect(p.defeatRed).toBe(ENDOFRUN_DEFEAT_RED);
    expect(p.defeatGray).toBe(ENDOFRUN_DEFEAT_GRAY);
  });

  // ── Tunable values are wired into params ─────────────────────────

  it('victory flash params reflect tunable constants', () => {
    const p = paramsFor('victory');
    expect(p.victoryFlashAlpha).toBe(ENDOFRUN_VICTORY_FLASH_ALPHA);
    expect(p.victoryFlashDurationMs).toBeGreaterThan(0);
    expect(p.victoryParticleCount).toBe(ENDOFRUN_VICTORY_PARTICLE_COUNT);
    expect(p.victoryParticleLifespanMs).toBe(ENDOFRUN_VICTORY_PARTICLE_LIFESPAN_MS);
    expect(p.victoryParticleVelocity).toBe(ENDOFRUN_VICTORY_PARTICLE_VELOCITY);
    expect(p.victoryParticleScale).toBe(ENDOFRUN_VICTORY_PARTICLE_SCALE);
    expect(p.victoryRingRadius).toBe(ENDOFRUN_VICTORY_RING_RADIUS);
  });

  it('defeat params reflect tunable constants', () => {
    const p = paramsFor('defeat');
    expect(p.defeatVignetteAlpha).toBe(ENDOFRUN_DEFEAT_VIGNETTE_ALPHA);
    expect(p.defeatVignetteDurationMs).toBe(ENDOFRUN_DEFEAT_VIGNETTE_DURATION_MS);
    expect(p.defeatGlitchSteps).toBe(ENDOFRUN_DEFEAT_GLITCH_STEPS);
    expect(p.defeatGlitchStepDurationMs).toBe(ENDOFRUN_DEFEAT_GLITCH_STEP_DURATION_MS);
    expect(p.defeatGlitchAlpha).toBe(ENDOFRUN_DEFEAT_GLITCH_ALPHA);
    expect(p.defeatRingRadius).toBe(ENDOFRUN_DEFEAT_RING_RADIUS);
  });

  // ── Shared ring params are identical for both outcomes ───────────

  it('ring shared params are the same for victory and defeat', () => {
    const v = paramsFor('victory');
    const d = paramsFor('defeat');
    expect(v.ringDurationMs).toBe(d.ringDurationMs);
    expect(v.ringStartScale).toBe(d.ringStartScale);
    expect(v.ringLineWidth).toBe(d.ringLineWidth);
  });

  // ── Per-layer toggles ────────────────────────────────────────────

  it('all toggles reflect their exported constants on victory', () => {
    const p = paramsFor('victory');
    expect(p.victoryFlashEnabled).toBe(ENDOFRUN_ENABLE_VICTORY_FLASH);
    expect(p.victoryParticlesEnabled).toBe(ENDOFRUN_ENABLE_VICTORY_PARTICLES);
    expect(p.victoryRingEnabled).toBe(ENDOFRUN_ENABLE_VICTORY_RING);
    expect(p.soundEnabled).toBe(ENDOFRUN_ENABLE_SOUND);
  });

  it('all toggles reflect their exported constants on defeat', () => {
    const p = paramsFor('defeat');
    expect(p.defeatVignetteEnabled).toBe(ENDOFRUN_ENABLE_DEFEAT_VIGNETTE);
    expect(p.defeatGlitchEnabled).toBe(ENDOFRUN_ENABLE_DEFEAT_GLITCH);
    expect(p.defeatRingEnabled).toBe(ENDOFRUN_ENABLE_DEFEAT_RING);
    expect(p.soundEnabled).toBe(ENDOFRUN_ENABLE_SOUND);
  });

  // ── Outcome distinctness ─────────────────────────────────────────

  it('victory and defeat return clearly distinct parameter sets', () => {
    const v = paramsFor('victory');
    const d = paramsFor('defeat');

    // Different primary colours
    expect(v.victoryColor).not.toBe(d.defeatColor);
    expect(v.victoryColor).not.toBe(d.defeatRed);

    // Different particle / ring radii
    expect(v.victoryRingRadius).not.toBe(d.defeatRingRadius);

    // Victory has flash enabled; defeat has vignette + glitch instead
    expect(v.victoryFlashAlpha).toBeGreaterThan(0);
    expect(d.defeatVignetteAlpha).toBeGreaterThan(0);
    expect(d.defeatGlitchSteps).toBeGreaterThan(0);

    // Victory uses bright colours; defeat uses dark/desaturated
    expect(v.victoryColor).not.toBe(d.defeatGray);
  });

  // ── Determinism ──────────────────────────────────────────────────

  it('is deterministic — same outcome always returns identical params', () => {
    const v1 = paramsFor('victory');
    const v2 = paramsFor('victory');
    expect(v1).toEqual(v2);

    const d1 = paramsFor('defeat');
    const d2 = paramsFor('defeat');
    expect(d1).toEqual(d2);
  });

  // ── Default outcome constant ─────────────────────────────────────

  it('ENDOFRUN_DEFAULT_OUTCOME is "victory"', () => {
    expect(ENDOFRUN_DEFAULT_OUTCOME).toBe('victory');
  });

  // ── Sound toggle ─────────────────────────────────────────────────

  it('sound toggle is present on both outcomes', () => {
    const v = paramsFor('victory');
    const d = paramsFor('defeat');
    expect(v.soundEnabled).toBe(d.soundEnabled);
    expect(v.soundEnabled).toBe(ENDOFRUN_ENABLE_SOUND);
  });
});
