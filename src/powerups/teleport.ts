/**
 * Shared P7 Teleport safe-spot resolution (GDD §4.4).
 *
 * Extracted from `GymPowerUpsCombat` so the shared combat base
 * (`GymFormationScene`) and the standalone combat power-up gym resolve
 * teleport destinations through one implementation.
 *
 * Finds the nearest safe teleport destination along the heading ray.
 * Samples candidates along the ray plus a fallback grid; picks the
 * closest candidate whose disc (`safeRadius`) contains no enemy/bullet,
 * clamped to the screen bounds (`margin` inset). If no safe candidate
 * exists, returns the furthest ray point clamped on-screen (nearest
 * on-screen position along the heading, per GDD).
 *
 * Engine-agnostic — no Phaser imports.
 *
 * @module powerups/teleport
 */

import { SHIP_SIZE, TELEPORT_SAFE_RADIUS } from '../core/constants';

/** A circular body (enemy or bullet) the destination must avoid. */
export interface TeleportBody {
  /** World-space centre x (px). */
  x: number;
  /** World-space centre y (px). */
  y: number;
  /** Optional per-body hit radius; falls back to the strategy default. */
  radius?: number;
}

/** Tuning options for {@link findTeleportDestination}. */
export interface TeleportOptions {
  /** Clearance radius of the teleport destination (px). */
  safeRadius?: number;
  /** Default enemy hit radius when a body omits `radius` (px). */
  enemyHitRadius?: number;
  /** Default bullet hit radius when a body omits `radius` (px). */
  bulletHitRadius?: number;
  /** Minimum distance from the screen edge (px). */
  margin?: number;
}

/**
 * Finds the nearest safe teleport destination along the heading ray.
 *
 * @param fromX      - Current player x (px).
 * @param fromY      - Current player y (px).
 * @param headingRad - Player heading in radians.
 * @param enemies    - Live enemy bodies to avoid.
 * @param bullets    - Live enemy bullets to avoid.
 * @param width      - Scene width (px).
 * @param height     - Scene height (px).
 * @param options    - Optional radii / margin overrides.
 * @returns The chosen destination `{ x, y }`.
 */
export function findTeleportDestination(
  fromX: number,
  fromY: number,
  headingRad: number,
  enemies: ReadonlyArray<TeleportBody>,
  bullets: ReadonlyArray<TeleportBody>,
  width: number,
  height: number,
  options: TeleportOptions = {},
): { x: number; y: number } {
  const safeRadius = options.safeRadius ?? TELEPORT_SAFE_RADIUS;
  const enemyHitRadius = options.enemyHitRadius ?? 0;
  const bulletHitRadius = options.bulletHitRadius ?? 0;
  const margin = options.margin ?? SHIP_SIZE / 2 + 4;

  const ux = Math.cos(headingRad);
  const uy = Math.sin(headingRad);

  function isSafe(x: number, y: number): boolean {
    for (const e of enemies) {
      if (Math.hypot(e.x - x, e.y - y) < safeRadius + (e.radius ?? enemyHitRadius)) return false;
    }
    for (const b of bullets) {
      if (Math.hypot(b.x - x, b.y - y) < safeRadius + (b.radius ?? bulletHitRadius)) return false;
    }
    return true;
  }

  function clamp(x: number, y: number): { x: number; y: number } {
    return {
      x: Math.max(margin, Math.min(width - margin, x)),
      y: Math.max(margin, Math.min(height - margin, y)),
    };
  }

  // Candidates along the heading ray at increasing distances.
  const rayDistances = [80, 160, 240, 360, 480, 640];
  const candidates: Array<{ x: number; y: number; dist: number }> = [];

  for (const d of rayDistances) {
    const p = clamp(fromX + ux * d, fromY + uy * d);
    // Skip candidates that barely moved (heading into wall).
    if (Math.hypot(p.x - fromX, p.y - fromY) < 10) continue;
    candidates.push({ ...p, dist: d });
  }

  // Fallback grid candidates (screen quadrants) — ensure coverage when
  // the ray is blocked the whole way.
  const grid: Array<{ x: number; y: number }> = [
    { x: width * 0.25, y: height * 0.25 },
    { x: width * 0.75, y: height * 0.25 },
    { x: width * 0.25, y: height * 0.75 },
    { x: width * 0.75, y: height * 0.75 },
    { x: width * 0.5, y: height * 0.5 },
  ];
  for (const g of grid) {
    const d = Math.hypot(g.x - fromX, g.y - fromY);
    // Prefer ray direction: penalise grid points behind the heading.
    const dot = (g.x - fromX) * ux + (g.y - fromY) * uy;
    const penalty = dot < 0 ? 1000 : 0;
    candidates.push({ ...g, dist: d + penalty });
  }

  candidates.sort((a, b) => a.dist - b.dist);

  for (const c of candidates) {
    if (isSafe(c.x, c.y)) return { x: c.x, y: c.y };
  }

  // No safe spot — return the furthest ray point clamped on-screen
  // (nearest on-screen position along the heading, per GDD), which is
  // the last ray candidate.
  const lastRay = candidates.find(
    (c) => Math.abs(c.x - fromX) > 1 || Math.abs(c.y - fromY) > 1,
  );
  if (lastRay) {
    // Walk further along heading until hitting the margin, then clamp.
    const x = fromX + ux * 1000;
    const y = fromY + uy * 1000;
    return clamp(x, y);
  }
  return clamp(fromX + ux * 80, fromY + uy * 80);
}
