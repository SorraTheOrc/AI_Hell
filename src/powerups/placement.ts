/**
 * Pluggable power-up placement strategies (GDD §4.4).
 *
 * Separates *where* a drop is placed from *which* drop is chosen
 * (`PowerUpSpawner`) so scenes or difficulty tiers can swap either
 * independently. Engine-agnostic — no Phaser imports — so the strategies
 * are unit-testable in isolation with an injected RNG.
 *
 * Consumer: `GymFormationScene` positions every combat-gym power-up
 * drop through `PowerUpPlacement`, passing the live enemy bodies (with
 * their hit radii) and the player body.
 *
 * @module powerups/placement
 */

// ── Contracts ───────────────────────────────────────────────────────

/** A circular body (enemy or player) a drop must not overlap. */
export interface PlacementBody {
  /** World-space centre x (px). */
  x: number;
  /** World-space centre y (px). */
  y: number;
  /** Collision radius (px). */
  radius: number;
}

/** Everything a placement strategy needs to choose a drop position. */
export interface PlacementContext {
  /** Scene width (px). */
  width: number;
  /** Scene height (px). */
  height: number;
  /** Minimum distance to keep between the drop and the screen edge (px). */
  margin: number;
  /** Radius (px) of the drop being placed — used for the overlap checks. */
  dropRadius: number;
  /** Live enemy bodies the drop must not overlap. */
  enemies: readonly PlacementBody[];
  /** The player body the drop must not overlap. */
  player: PlacementBody;
}

/** A chosen drop position (px). */
export interface PlacementPoint {
  /** Centre x (px). */
  x: number;
  /** Centre y (px). */
  y: number;
}

/**
 * Contract for any power-up placement strategy. Callers invoke
 * `place(context)` to obtain the next drop position.
 */
export interface PowerUpPlacement {
  /** Chooses an in-bounds position that avoids the supplied bodies. */
  place(context: PlacementContext): PlacementPoint;
}

// ── RandomAvoidingPlacement ─────────────────────────────────────────

/**
 * Default number of random candidate positions tried before falling back
 * to the deterministic scan.
 */
export const DEFAULT_PLACEMENT_MAX_ATTEMPTS = 24;

/** Grid step (px) used by the deterministic fallback scan. */
export const FALLBACK_SCAN_STEP = 8;

/** Construction options for {@link RandomAvoidingPlacement}. */
export interface RandomAvoidingPlacementOptions {
  /** Injected RNG returning [0, 1) (default: `Math.random`). */
  rng?: () => number;
  /**
   * Maximum number of random candidates tried before the deterministic
   * fallback runs (default: {@link DEFAULT_PLACEMENT_MAX_ATTEMPTS}).
   */
  maxAttempts?: number;
}

/**
 * Returns the inclusive `[min, max]` coordinate range for one axis that
 * keeps the whole drop inside the margin. When the axis is too small to
 * fit the drop, both bounds collapse to the axis centre (deterministic).
 */
function axisBounds(size: number, margin: number, radius: number): [number, number] {
  const min = margin + radius;
  const max = size - margin - radius;
  if (max < min) {
    const mid = size / 2;
    return [mid, mid];
  }
  return [min, max];
}

/** Circle-vs-circle overlap: true when the two circles intersect. */
function overlaps(
  x: number,
  y: number,
  radius: number,
  body: PlacementBody,
): boolean {
  return Math.hypot(x - body.x, y - body.y) < radius + body.radius;
}

/** Whether a candidate drop position is clear of every body. */
function isClear(x: number, y: number, context: PlacementContext): boolean {
  for (const enemy of context.enemies) {
    if (overlaps(x, y, context.dropRadius, enemy)) return false;
  }
  return !overlaps(x, y, context.dropRadius, context.player);
}

/**
 * Deterministic fallback: scans the in-bounds area on a fixed grid
 * (top-to-bottom, left-to-right) and returns the first position clear of
 * every body, including the right/bottom edges. When no clear position
 * exists at all, returns the playable-area centre as a stable last resort.
 *
 * Fully deterministic — same context always yields the same point.
 */
function deterministicFallback(
  context: PlacementContext,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
): PlacementPoint {
  for (let y = minY; y <= maxY; y += FALLBACK_SCAN_STEP) {
    for (let x = minX; x <= maxX; x += FALLBACK_SCAN_STEP) {
      if (isClear(x, y, context)) return { x, y };
    }
  }
  // Sweep the right and bottom edges (the loop above may not land on them).
  for (let y = minY; y <= maxY; y += FALLBACK_SCAN_STEP) {
    if (isClear(maxX, y, context)) return { x: maxX, y };
  }
  for (let x = minX; x <= maxX; x += FALLBACK_SCAN_STEP) {
    if (isClear(x, maxY, context)) return { x, y: maxY };
  }
  if (isClear(maxX, maxY, context)) return { x: maxX, y: maxY };

  // No clear position exists — return the playable-area centre.
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

/**
 * Picks a random in-bounds position (inside the configured margin) that
 * does not overlap any live enemy body or the player. Tries up to
 * `maxAttempts` random candidates, then falls back to a deterministic
 * safe position.
 *
 * Proximity to the player is permitted — only an actual body overlap is
 * rejected.
 *
 * Usage:
 * ```ts
 * const placement = new RandomAvoidingPlacement({ rng: createSeededRng(1) });
 * const { x, y } = placement.place({
 *   width: 960, height: 540, margin: 20, dropRadius: 16,
 *   enemies: [...], player: { x, y, radius },
 * });
 * ```
 */
export class RandomAvoidingPlacement implements PowerUpPlacement {
  private readonly _rng: () => number;
  private readonly _maxAttempts: number;

  constructor(options: RandomAvoidingPlacementOptions = {}) {
    this._rng = options.rng ?? Math.random;
    const attempts = options.maxAttempts ?? DEFAULT_PLACEMENT_MAX_ATTEMPTS;
    this._maxAttempts = Math.max(1, Math.trunc(attempts));
  }

  place(context: PlacementContext): PlacementPoint {
    const [minX, maxX] = axisBounds(
      context.width,
      context.margin,
      context.dropRadius,
    );
    const [minY, maxY] = axisBounds(
      context.height,
      context.margin,
      context.dropRadius,
    );

    for (let attempt = 0; attempt < this._maxAttempts; attempt += 1) {
      const x = minX + this._rng() * (maxX - minX);
      const y = minY + this._rng() * (maxY - minY);
      if (isClear(x, y, context)) return { x, y };
    }

    return deterministicFallback(context, minX, maxX, minY, maxY);
  }
}

// ── Drop separation (AH-0MU7JTFM5000R4ME) ──────────────────────────

/** A live power-up drop the new spawn must keep clear of. */
export interface DropBody {
  /** World-space centre x (px). */
  x: number;
  /** World-space centre y (px). */
  y: number;
}

/** Ring-search radius increment used when nudging a drop (px). */
const NUDGE_RING_STEP = 12;

/** Number of directions probed on each ring-search radius. */
const NUDGE_DIRECTIONS = 12;

/** Maximum nudge radius searched before giving up (px). */
const NUDGE_MAX_RADIUS = 160;

/**
 * Returns a spawn position for a new drop that keeps at least
 * `minSeparation` px from every existing live drop body. The natural
 * point is returned unchanged when already clear; otherwise the point is
 * nudged outward on concentric rings until a separated in-bounds position
 * is found. Returns `null` when no such position exists — callers skip
 * the drop rather than violate the separation invariant.
 *
 * Pure — no Phaser dependency, so it is unit-testable in isolation.
 *
 * @param existing — live drop bodies to keep clear of.
 * @param x — natural spawn x (death position, px).
 * @param y — natural spawn y (death position, px).
 * @param minSeparation — minimum centre-to-centre distance (px).
 * @param width / @param height — playfield bounds (px).
 */
export function nudgeAwayFromDrops(
  existing: readonly DropBody[],
  x: number,
  y: number,
  minSeparation: number,
  width: number,
  height: number,
): { x: number; y: number } | null {
  if (existing.length === 0) return { x, y };

  const separated = (cx: number, cy: number): boolean =>
    existing.every((d) => Math.hypot(d.x - cx, d.y - cy) >= minSeparation);

  // Already far enough from every live drop — keep the natural point.
  if (separated(x, y)) return { x, y };

  // Nudge outward on concentric rings (deterministic direction order).
  for (let radius = minSeparation; radius <= NUDGE_MAX_RADIUS; radius += NUDGE_RING_STEP) {
    for (let i = 0; i < NUDGE_DIRECTIONS; i += 1) {
      const angle = (i / NUDGE_DIRECTIONS) * Math.PI * 2;
      const cx = x + Math.cos(angle) * radius;
      const cy = y + Math.sin(angle) * radius;
      if (cx < 0 || cx > width || cy < 0 || cy > height) continue;
      if (separated(cx, cy)) return { x: cx, y: cy };
    }
  }

  // No in-bounds separated position — the caller should skip this drop.
  return null;
}
