import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { fireForEnemy } from './enemyFire';
import {
  computeCapturePull,
  isPointInsideCaptureBeam,
} from '../scenes/core/captureBeam';
import {
  Capturer,
  CapturerState,
  CAPTURER_COLOR,
  CAPTURER_SIZE,
  CAPTURER_BEAM_DURATION_MS,
  CAPTURER_PULL_STRENGTH,
  CAPTURER_HOLD_FORMATION_SECONDS,
  CAPTURER_APPROACH_SECONDS,
  CAPTURER_WITHDRAW_SECONDS,
} from './Capturer';

/** Minimal scene that only constructs Capturer entities. */
class HarnessScene extends Phaser.Scene {
  constructor() {
    super('CapturerHarnessScene');
  }
}

/**
 * Galaga capturer entity tests (AH-0MV01EFII008298D).
 *
 * Pin the break-away → descent → beam → withdraw state machine, the
 * `getCaptureBeam`/`notifyPlayerCaptured` seams the shared capture core
 * consumes, and the non-firing, non-colliding contract.
 */
describe('Capturer entity — Galaga tractor-beam archetype', () => {
  let booted: BootedGame | null = null;
  const BASE_X = 400;
  const BASE_Y = 300;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.clearAllMocks();
  });

  function makeCapturer(
    overrides: Partial<ConstructorParameters<typeof Capturer>[1]> = {},
  ): Capturer {
    const scene = booted!.scene;
    return new Capturer(scene, {
      x: BASE_X,
      y: BASE_Y,
      formationOffset: { row: 0, col: 0 },
      ...overrides,
    });
  }

  /** Advances the entity through its own positioning seam `steps` times. */
  function advance(capturer: Capturer, dt: number, steps: number): void {
    for (let i = 0; i < steps; i++) {
      capturer.applyFormationPosition(BASE_X, BASE_Y, dt, 0, 0);
    }
  }

  /** Drives the capturer from FORMATION to the BEAM state. */
  function driveToBeam(capturer: Capturer): void {
    // FORMATION → APPROACH (hold elapses).
    advance(capturer, CAPTURER_HOLD_FORMATION_SECONDS, 1);
    expect(capturer.behaviourState).toBe(CapturerState.APPROACH);
    // APPROACH → BEAM (approach elapses).
    advance(capturer, CAPTURER_APPROACH_SECONDS, 1);
    expect(capturer.behaviourState).toBe(CapturerState.BEAM);
  }

  it('starts alive in FORMATION with the capturer identity', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer();

    expect(capturer.alive).toBe(true);
    expect(capturer.archetype).toBe('capturer');
    expect(capturer.behaviourState).toBe(CapturerState.FORMATION);
    expect(capturer.effectiveColor).toBe(CAPTURER_COLOR);
    expect(capturer.effectiveSize).toBe(CAPTURER_SIZE);
    expect(capturer.getCaptureBeam()).toBeNull();
  });

  it('breaks away after holding formation, descends to the player’s row, then beams', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer({ beamDuration: 1000 });
    capturer.setAimTarget(600, 500);

    // Before the hold elapses it is still in formation and has no beam.
    advance(capturer, CAPTURER_HOLD_FORMATION_SECONDS * 0.5, 1);
    expect(capturer.behaviourState).toBe(CapturerState.FORMATION);
    expect(capturer.getCaptureBeam()).toBeNull();

    driveToBeam(capturer);

    // The capturer has descended to just above the player's row (x matches;
    // y is CAPTURER_HOVER_GAP above the aim target).
    expect(capturer.x).toBeCloseTo(600, 5);
    expect(capturer.y).toBeCloseTo(400, 5);

    const beam = capturer.getCaptureBeam();
    expect(beam).not.toBeNull();
    expect(beam!.active).toBe(true);
    expect(beam!.durationMs).toBe(1000);
    expect(beam!.pullStrength).toBe(CAPTURER_PULL_STRENGTH);
    // The player, just below the capturer, is inside the corridor.
    expect(isPointInsideCaptureBeam(beam!, 600, 500)).toBe(true);
    // ... and the beam applies a bounded pull toward the capturer.
    const pull = computeCapturePull(beam!, 600, 500);
    const magnitude = Math.hypot(pull.vx, pull.vy);
    expect(magnitude).toBeGreaterThan(0);
    expect(magnitude).toBeLessThanOrEqual(CAPTURER_PULL_STRENGTH + 1e-9);
  });

  it('expires the beam, withdraws and re-forms', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer({ beamDuration: 1000 });
    capturer.setAimTarget(600, 500);
    driveToBeam(capturer);

    // Advance just under the beam duration — still beaming.
    advance(capturer, 0.5, 1);
    expect(capturer.behaviourState).toBe(CapturerState.BEAM);
    expect(capturer.getCaptureBeam()!.active).toBe(true);

    // Cross the duration — the beam expires and the capturer withdraws.
    advance(capturer, 0.5, 1);
    expect(capturer.behaviourState).toBe(CapturerState.WITHDRAW);
    expect(capturer.getCaptureBeam()).toBeNull();

    // Withdraw completes and it rejoins formation at its slot.
    advance(capturer, CAPTURER_WITHDRAW_SECONDS, 1);
    expect(capturer.behaviourState).toBe(CapturerState.FORMATION);
    expect(capturer.x).toBeCloseTo(BASE_X, 5);
    expect(capturer.y).toBeCloseTo(BASE_Y, 5);
  });

  it('cuts the beam short and withdraws when the shared core reports a capture', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer({ beamDuration: 1000 });
    capturer.setAimTarget(600, 500);
    driveToBeam(capturer);

    // The core normally calls this only while the beam is active.
    capturer.notifyPlayerCaptured();
    advance(capturer, 0.016, 1);
    expect(capturer.behaviourState).toBe(CapturerState.WITHDRAW);
    expect(capturer.getCaptureBeam()).toBeNull();
  });

  it('ignores notifyPlayerCaptured when it is not beaming (idempotent)', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer();
    capturer.notifyPlayerCaptured();
    expect(capturer.behaviourState).toBe(CapturerState.FORMATION);
  });

  it('never fires — the shared dispatcher resolves it to the explicit non-firing entry', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer();
    expect(fireForEnemy(capturer, 'capturer', 10_000)).toEqual([]);
  });

  it('exposes no beam once destroyed', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer({ beamDuration: 1000 });
    capturer.setAimTarget(600, 500);
    driveToBeam(capturer);
    expect(capturer.getCaptureBeam()).not.toBeNull();

    capturer.destroySelf();
    expect(capturer.alive).toBe(false);
    expect(capturer.getCaptureBeam()).toBeNull();
  });

  it('resolves the default beam duration and pull strength when unconfigured', async () => {
    booted = await bootScene([HarnessScene]);
    const capturer = makeCapturer();
    expect(capturer.beamDuration).toBe(CAPTURER_BEAM_DURATION_MS);
    expect(capturer.pullStrength).toBe(CAPTURER_PULL_STRENGTH);
  });
});
