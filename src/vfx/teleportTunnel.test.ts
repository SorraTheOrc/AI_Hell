/**
 * Unit tests for the teleport tunnel VFX (parent AH-0MWW50H0B002U6XU, slice
 * AH-0MWWDJ3Q1000CAE3).
 *
 * Assert observable behaviour of the public API — the exported single-source
 * timeline, the deterministic plan, the pure progress/alpha model, the
 * per-layer toggles and the `update(dt)` / `isComplete()` / `destroy()`
 * lifecycle — rather than pixel output, mirroring `backgroundWarp.test.ts`.
 *
 * No wall-clock waits and no randomness: every step advances the effect with an
 * explicit `update(dt)` tick, which is the contract the shared teleport seam
 * consumes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import {
  TELEPORT_TUNNEL_COLLAPSE_START_SECONDS,
  TELEPORT_TUNNEL_DEPTH,
  TELEPORT_TUNNEL_DURATION_SECONDS,
  TELEPORT_TUNNEL_ENABLE_GLOW,
  TELEPORT_TUNNEL_ENABLE_RIBS,
  TELEPORT_TUNNEL_ENABLE_SWIRL,
  TELEPORT_TUNNEL_GROW_PHASE_SECONDS,
  TELEPORT_TUNNEL_GROW_START_SECONDS,
  TELEPORT_TUNNEL_MAX_SWIRLS,
  TELEPORT_TUNNEL_RADIUS,
  TELEPORT_TUNNEL_RIB_COUNT,
  TELEPORT_TUNNEL_SWIRL_COUNT,
  TELEPORT_TUNNEL_SWIRL_MAX_WIDTH,
  TELEPORT_TUNNEL_SWIRL_MIN_WIDTH,
  TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS,
  TELEPORT_TUNNEL_TRANSIT_START_SECONDS,
} from '../core/constants';
import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  TELEPORT_TUNNEL_COLLAPSE_DURATION,
  TELEPORT_TUNNEL_DURATION,
  TELEPORT_TUNNEL_GROW_DURATION,
  TELEPORT_TUNNEL_TRANSIT_DURATION,
  createTeleportTunnel,
  planTeleportTunnel,
  resolveTeleportTunnelLayers,
  teleportTunnelAlpha,
  teleportTunnelLengthProgress,
  teleportTunnelPhaseAt,
  type TeleportTunnel,
} from './teleportTunnel';

/** Minimal bootable scene for the tunnel VFX. */
class TunnelStubScene extends Phaser.Scene {
  constructor() {
    super({ key: 'TunnelStubScene' });
  }
}

let booted: BootedGame | null = null;

afterEach(() => {
  booted?.game.destroy(true);
  booted = null;
  document.body.innerHTML = '';
});

async function bootStub(): Promise<BootedGame> {
  booted = await bootScene([TunnelStubScene]);
  return booted;
}

/** Builds a tunnel handle over a standard 200 px horizontal jump. */
function buildTunnel(
  scene: Phaser.Scene,
  overrides: Partial<Parameters<typeof createTeleportTunnel>[1]> = {},
): TeleportTunnel {
  return createTeleportTunnel(scene, {
    startX: 100,
    startY: 100,
    endX: 300,
    endY: 100,
    ...overrides,
  });
}

// ── Timeline is a single source of truth ────────────────────────────

describe('teleportTunnel — timeline is a single source of truth', () => {
  it('keeps the re-exported durations equal to the constants (no duplicated literals)', () => {
    expect(TELEPORT_TUNNEL_DURATION).toBe(TELEPORT_TUNNEL_DURATION_SECONDS);
    expect(TELEPORT_TUNNEL_GROW_DURATION).toBe(TELEPORT_TUNNEL_GROW_PHASE_SECONDS);
    expect(TELEPORT_TUNNEL_TRANSIT_DURATION).toBe(TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS);
    expect(TELEPORT_TUNNEL_COLLAPSE_DURATION).toBe(
      TELEPORT_TUNNEL_DURATION_SECONDS -
        TELEPORT_TUNNEL_GROW_PHASE_SECONDS -
        TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS,
    );
  });

  it('orders the three phases and sums to the total duration', () => {
    expect(TELEPORT_TUNNEL_GROW_START_SECONDS).toBe(0);
    expect(TELEPORT_TUNNEL_TRANSIT_START_SECONDS).toBeGreaterThan(
      TELEPORT_TUNNEL_GROW_START_SECONDS,
    );
    expect(TELEPORT_TUNNEL_COLLAPSE_START_SECONDS).toBeGreaterThan(
      TELEPORT_TUNNEL_TRANSIT_START_SECONDS,
    );
    expect(TELEPORT_TUNNEL_DURATION_SECONDS).toBeGreaterThan(
      TELEPORT_TUNNEL_COLLAPSE_START_SECONDS,
    );
    expect(
      TELEPORT_TUNNEL_GROW_PHASE_SECONDS +
        TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS +
        (TELEPORT_TUNNEL_DURATION_SECONDS -
          TELEPORT_TUNNEL_GROW_PHASE_SECONDS -
          TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS),
    ).toBeCloseTo(TELEPORT_TUNNEL_DURATION_SECONDS, 10);
  });

  it('fixes the grow phase at the producer-mandated ≈ 0.75 s', () => {
    expect(TELEPORT_TUNNEL_GROW_PHASE_SECONDS).toBeCloseTo(0.75, 10);
  });
});

// ── Phase model ─────────────────────────────────────────────────────

describe('teleportTunnelPhaseAt — phase boundaries', () => {
  it('resolves the grow phase before the transit start', () => {
    expect(teleportTunnelPhaseAt(0)).toBe('grow');
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_GROW_PHASE_SECONDS / 2)).toBe('grow');
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_TRANSIT_START_SECONDS - 1e-9)).toBe('grow');
  });

  it('assigns the transit boundary to transit (boundary belongs to the starting phase)', () => {
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_TRANSIT_START_SECONDS)).toBe('transit');
  });

  it('resolves the collapse boundary to collapse', () => {
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_COLLAPSE_START_SECONDS)).toBe('collapse');
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_DURATION_SECONDS - 1e-9)).toBe('collapse');
  });

  it('resolves complete at and beyond the total duration', () => {
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_DURATION_SECONDS)).toBe('complete');
    expect(teleportTunnelPhaseAt(TELEPORT_TUNNEL_DURATION_SECONDS + 5)).toBe('complete');
  });

  it('is total: negative and NaN inputs resolve to grow, never throwing', () => {
    expect(teleportTunnelPhaseAt(-1)).toBe('grow');
    expect(teleportTunnelPhaseAt(Number.NaN)).toBe('grow');
  });
});

// ── Pure progress / alpha model ─────────────────────────────────────

describe('teleportTunnelLengthProgress — grow → hold → collapse', () => {
  it('is zero at the start of grow and grows monotonically to full length', () => {
    expect(teleportTunnelLengthProgress(0)).toBe(0);
    let last = -1;
    for (let t = 0.01; t < TELEPORT_TUNNEL_TRANSIT_START_SECONDS; t += 0.01) {
      const p = teleportTunnelLengthProgress(t);
      expect(p).toBeGreaterThanOrEqual(last);
      last = p;
    }
    // By the end of grow the tunnel is essentially full length.
    expect(
      teleportTunnelLengthProgress(TELEPORT_TUNNEL_TRANSIT_START_SECONDS - 1e-6),
    ).toBeCloseTo(1, 2);
  });

  it('holds full length through the whole transit phase', () => {
    for (
      let t = TELEPORT_TUNNEL_TRANSIT_START_SECONDS;
      t < TELEPORT_TUNNEL_COLLAPSE_START_SECONDS;
      t += 0.02
    ) {
      expect(teleportTunnelLengthProgress(t)).toBe(1);
    }
  });

  it('contracts from full length to zero across collapse', () => {
    expect(
      teleportTunnelLengthProgress(TELEPORT_TUNNEL_COLLAPSE_START_SECONDS),
    ).toBeCloseTo(1, 5);
    expect(
      teleportTunnelLengthProgress(TELEPORT_TUNNEL_DURATION_SECONDS - 1e-9),
    ).toBeCloseTo(0, 5);
    expect(teleportTunnelLengthProgress(TELEPORT_TUNNEL_DURATION_SECONDS)).toBe(0);
  });

  it('is total: negative, NaN and beyond-duration inputs are safe', () => {
    expect(teleportTunnelLengthProgress(-1)).toBe(0);
    expect(teleportTunnelLengthProgress(Number.NaN)).toBe(0);
    expect(teleportTunnelLengthProgress(TELEPORT_TUNNEL_DURATION_SECONDS + 99)).toBe(0);
  });
});

describe('teleportTunnelAlpha — fade in, hold, fade out', () => {
  it('is zero before the tunnel starts and after it completes', () => {
    expect(teleportTunnelAlpha(0)).toBe(0);
    expect(teleportTunnelAlpha(-1)).toBe(0);
    expect(teleportTunnelAlpha(Number.NaN)).toBe(0);
    expect(teleportTunnelAlpha(TELEPORT_TUNNEL_DURATION_SECONDS)).toBe(0);
    expect(teleportTunnelAlpha(TELEPORT_TUNNEL_DURATION_SECONDS + 1)).toBe(0);
  });

  it('holds full opacity through transit', () => {
    const mid =
      (TELEPORT_TUNNEL_TRANSIT_START_SECONDS +
        TELEPORT_TUNNEL_COLLAPSE_START_SECONDS) /
      2;
    expect(teleportTunnelAlpha(mid)).toBe(1);
  });

  it('fades to zero across collapse', () => {
    expect(
      teleportTunnelAlpha(TELEPORT_TUNNEL_COLLAPSE_START_SECONDS + 1e-6),
    ).toBeCloseTo(1, 2);
    expect(
      teleportTunnelAlpha(TELEPORT_TUNNEL_DURATION_SECONDS - 1e-6),
    ).toBeCloseTo(0, 2);
  });
});

// ── Deterministic plan ──────────────────────────────────────────────

describe('planTeleportTunnel — deterministic geometry', () => {
  it('derives length, heading and endpoints from the two positions', () => {
    const plan = planTeleportTunnel(0, 0, 300, 400);
    expect(plan.length).toBeCloseTo(500, 10);
    expect(plan.angle).toBeCloseTo(Math.atan2(400, 300), 10);
    expect(plan.startX).toBe(0);
    expect(plan.startY).toBe(0);
    expect(plan.endX).toBe(300);
    expect(plan.endY).toBe(400);
    expect(plan.radius).toBe(TELEPORT_TUNNEL_RADIUS);
    expect(plan.durationSeconds).toBe(TELEPORT_TUNNEL_DURATION_SECONDS);
  });

  it('produces byte-identical plans from the same endpoints (no Math.random)', () => {
    const a = planTeleportTunnel(100, 100, 300, 100);
    const b = planTeleportTunnel(100, 100, 300, 100);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.seed).toBe(b.seed);
  });

  it('produces different swirl geometry for different endpoints', () => {
    const a = planTeleportTunnel(100, 100, 300, 100);
    const b = planTeleportTunnel(100, 100, 100, 300);
    expect(a.seed).not.toBe(b.seed);
    expect(JSON.stringify(a.swirls)).not.toBe(JSON.stringify(b.swirls));
  });

  it('is order-sensitive: swapping start and destination changes the seed', () => {
    const a = planTeleportTunnel(100, 100, 300, 100);
    const b = planTeleportTunnel(300, 100, 100, 100);
    expect(a.seed).not.toBe(b.seed);
  });

  it('caps the swirl count and keeps every field within range', () => {
    const plan = planTeleportTunnel(0, 0, 500, 0);
    expect(plan.swirls.length).toBeLessThanOrEqual(TELEPORT_TUNNEL_MAX_SWIRLS);
    expect(plan.swirls.length).toBe(Math.min(TELEPORT_TUNNEL_SWIRL_COUNT, TELEPORT_TUNNEL_MAX_SWIRLS));
    expect(plan.ribCount).toBe(TELEPORT_TUNNEL_RIB_COUNT);
    for (const swirl of plan.swirls) {
      expect(swirl.phase).toBeGreaterThanOrEqual(0);
      expect(swirl.phase).toBeLessThan(Math.PI * 2);
      expect(swirl.radialOffset).toBeGreaterThanOrEqual(0);
      expect(swirl.radialOffset).toBeLessThanOrEqual(1);
      expect(swirl.width).toBeGreaterThanOrEqual(TELEPORT_TUNNEL_SWIRL_MIN_WIDTH);
      expect(swirl.width).toBeLessThanOrEqual(TELEPORT_TUNNEL_SWIRL_MAX_WIDTH);
    }
  });
});

// ── Layer resolution ────────────────────────────────────────────────

describe('resolveTeleportTunnelLayers — exported toggles + per-call overrides', () => {
  it('defaults every layer to its exported toggle', () => {
    expect(resolveTeleportTunnelLayers()).toEqual({
      swirl: TELEPORT_TUNNEL_ENABLE_SWIRL,
      ribs: TELEPORT_TUNNEL_ENABLE_RIBS,
      glow: TELEPORT_TUNNEL_ENABLE_GLOW,
    });
  });

  it('honours per-call overrides on top of the defaults', () => {
    expect(
      resolveTeleportTunnelLayers({ enableSwirl: false, enableRibs: false, enableGlow: false }),
    ).toEqual({ swirl: false, ribs: false, glow: false });
  });
});

// ── Handle lifecycle ────────────────────────────────────────────────

describe('createTeleportTunnel — handle lifecycle', () => {
  it('builds one container at the start point, rotated to the heading, at tunnel depth', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene);
    expect(tunnel.container.x).toBe(100);
    expect(tunnel.container.y).toBe(100);
    expect(tunnel.container.rotation).toBeCloseTo(0, 10);
    expect(tunnel.container.depth).toBe(TELEPORT_TUNNEL_DEPTH);
    tunnel.destroy();
  });

  it('keeps every display object inside the single container', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene);
    // Children live under the container, not on the scene display list root.
    expect(tunnel.container.length).toBeGreaterThan(0);
    tunnel.destroy();
  });

  it('advances through grow → transit → collapse and reports completion', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene);
    expect(tunnel.phase).toBe('grow');

    tunnel.update(TELEPORT_TUNNEL_GROW_PHASE_SECONDS - 1e-6);
    expect(tunnel.phase).toBe('grow');
    expect(tunnel.lengthProgress).toBeGreaterThan(0.9);

    tunnel.update(TELEPORT_TUNNEL_TRANSIT_PHASE_SECONDS);
    expect(tunnel.phase).toBe('transit');
    expect(tunnel.lengthProgress).toBe(1);

    // Step into the collapse phase, then push past the end to guarantee completion
    // (the accumulated elapsed time lands just shy of the total, so clock the
    // final tick at the full duration to clamp deterministically).
    tunnel.update(TELEPORT_TUNNEL_COLLAPSE_DURATION * 0.5);
    expect(tunnel.phase).toBe('collapse');
    tunnel.update(TELEPORT_TUNNEL_DURATION);
    expect(tunnel.isComplete()).toBe(true);
    expect(tunnel.phase).toBe('complete');
  });

  it('ignores non-positive and non-finite deltas', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene);
    tunnel.update(0);
    tunnel.update(-1);
    tunnel.update(Number.NaN);
    expect(tunnel.elapsedSeconds).toBe(0);
    tunnel.destroy();
  });

  it('tears itself down exactly once on completion (idempotent destroy after)', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene);
    tunnel.update(TELEPORT_TUNNEL_DURATION_SECONDS + 1);
    expect(tunnel.isComplete()).toBe(true);
    expect(tunnel.container.active).toBe(false);
    // Further destroy() calls are safe no-ops.
    expect(() => tunnel.destroy()).not.toThrow();
    expect(() => tunnel.destroy()).not.toThrow();
  });

  it('tears down cleanly on an early destroy (scene shutdown mid-sequence)', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene);
    tunnel.update(0.1);
    expect(() => tunnel.destroy()).not.toThrow();
    expect(tunnel.container.active).toBe(false);
    // Destroy is idempotent.
    expect(() => tunnel.destroy()).not.toThrow();
  });

  it('honours per-call layer overrides (all layers disabled builds an empty shell)', async () => {
    const { scene } = await bootStub();
    const tunnel = buildTunnel(scene, {
      enableSwirl: false,
      enableRibs: false,
      enableGlow: false,
    });
    expect(tunnel.container.length).toBe(0);
    expect(() => tunnel.update(TELEPORT_TUNNEL_DURATION_SECONDS + 1)).not.toThrow();
    tunnel.destroy();
  });
});
