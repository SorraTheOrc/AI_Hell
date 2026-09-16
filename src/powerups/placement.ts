/**
 * Pluggable power-up placement strategies (GDD §4.4).
 *
 * Separates *where* a drop is placed from *which* drop is chosen
 * (`PowerUpSpawner`) so scenes or difficulty tiers can swap either
 * independently. Engine-agnostic — no Phaser imports — so the strategies
 * are unit-testable in isolation with an injected RNG.
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
