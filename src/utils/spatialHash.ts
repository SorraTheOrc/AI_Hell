/**
 * Uniform-grid spatial hash — the shared broad phase for collision passes
 * (AH-0MVXV0EMF001WVQ1, parent AH-0MVWJQUN6009IS87).
 *
 * A broad phase does one job: turn an all-pairs test (`n × m` overlap checks)
 * into a per-query test against a handful of candidates, so collision cost
 * scales with the number of live objects rather than with the product of two
 * collections. The shared bullet-vs-bullet pass is the quadratic one: with
 * `n` player bullets and `m` enemy bullets it tested `n × m` pairs every
 * frame, which is `m`-fold redundant because each player bullet is compared
 * against every enemy bullet even though only a few are ever near it.
 *
 * The grid keys entries by the cell their **centre** falls in and is queried
 * with a radius that covers the caller's own extent. A query therefore
 * returns a **superset** of the entries that could overlap — every entry whose
 * centre is within `radius` of the query point is guaranteed to be in one of
 * the visited cells — and the caller keeps its exact narrow-phase test
 * (`_overlaps`). That is what makes the optimisation outcome-preserving: the
 * broad phase only ever removes pairs that cannot possibly overlap, so the
 * resolution order, first-hit selection and RNG consumption are unchanged.
 *
 * Determinism matters as much as speed here: `tick(dt)` is the deterministic
 * simulation step used by tests, bots and recorded replays, so a broad phase
 * that returned candidates in hash order would make collision resolution
 * depend on hash layout. `query()` therefore returns ascending insertion
 * order, reproducing the sequential scan it replaces.
 *
 * @module utils/spatialHash
 */

/**
 * Cell-index offset that keeps a packed cell key non-negative: a cell
 * coordinate of `-CELL_KEY_ORIGIN` or below lands on a key `<= 0`, and every
 * coordinate inside the range below maps to a distinct key.
 */
const CELL_KEY_ORIGIN = 1_000_000;

/** Row stride of the packed cell key (`2 × CELL_KEY_ORIGIN + 1`). */
const CELL_KEY_STRIDE = 2 * CELL_KEY_ORIGIN + 1;

/** Ascending numeric comparator (default `Array#sort` is lexicographic). */
function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * Uniform-grid broad phase over integer indices.
 *
 * Indices (rather than object references) let a caller keep its own array —
 * and therefore its own iteration order — as the source of truth while the
 * grid is only a candidate filter. Reusing one instance across frames is
 * cheap: {@link SpatialHash.clear} keeps the bucket arrays allocated.
 *
 * @example
 * ```ts
 * const grid = new SpatialHash(64);
 * for (let i = 0; i < bullets.length; i += 1) grid.insert(i, bullets[i].x, bullets[i].y);
 * const candidates: number[] = [];
 * for (const enemyBullet of enemyBullets) {
 *   grid.query(enemyBullet.x, enemyBullet.y, 8, candidates);
 *   // `candidates` holds ascending bullet indices; test them with the exact
 *   // overlap predicate and keep the existing first-hit rule.
 * }
 * ```
 */
export class SpatialHash {
  /** Side length (px) of one square cell. */
  readonly cellSize: number;

  private readonly buckets = new Map<number, number[]>();

  /**
   * @param cellSize — side length (px) of one square cell. Larger cells mean
   *   fewer map lookups per query but more candidates per cell. Must be a
   *   positive, finite number; a grid whose cell dwarfs the world degenerates
   *   to a single bucket, which is a full scan (the equivalence tests use that
   *   degenerate shape to compare against the pre-broad-phase nested loop).
   */
  constructor(cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) {
      throw new RangeError(
        `SpatialHash cellSize must be a positive finite number (got ${cellSize})`,
      );
    }
    this.cellSize = cellSize;
  }

  /** Number of occupied cells (diagnostics and tests). */
  get occupiedCells(): number {
    return this.buckets.size;
  }

  /** Drops every entry, keeping the allocated buckets for reuse. */
  clear(): void {
    this.buckets.clear();
  }

  /**
   * Adds `index` to the cell holding `(x, y)`.
   *
   * An entry's extent is **not** stored: the caller must query with a radius
   * that already covers its own radius plus the radius of the thing it is
   * testing against, which is the same radius its narrow-phase test uses.
   */
  insert(index: number, x: number, y: number): void {
    const key = cellKey(cellIndex(x, this.cellSize), cellIndex(y, this.cellSize));
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      this.buckets.set(key, [index]);
      return;
    }
    bucket.push(index);
  }

  /**
   * Collects the indices whose cells overlap the axis-aligned box
   * `(x ± radius, y ± radius)` into `out`, replacing its contents, and
   * returns how many candidates were collected.
   *
   * The result is a superset of the entries within `radius` (a square
   * neighbourhood of a circular query), in **ascending index order** so the
   * caller's sequential scan can be reproduced exactly. `out` is supplied by
   * the caller so the hot path allocates nothing per query.
   */
  query(x: number, y: number, radius: number, out: number[]): number {
    out.length = 0;
    const minColumn = cellIndex(x - radius, this.cellSize);
    const maxColumn = cellIndex(x + radius, this.cellSize);
    const minRow = cellIndex(y - radius, this.cellSize);
    const maxRow = cellIndex(y + radius, this.cellSize);

    for (let column = minColumn; column <= maxColumn; column += 1) {
      for (let row = minRow; row <= maxRow; row += 1) {
        const bucket = this.buckets.get(cellKey(column, row));
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i += 1) out.push(bucket[i]);
      }
    }

    if (out.length > 1) out.sort(ascending);
    return out.length;
  }
}

/** Cell coordinate holding `value` (floor, so negatives get their own cells). */
function cellIndex(value: number, cellSize: number): number {
  return Math.floor(value / cellSize);
}

/**
 * Packs a cell's column/row pair into a single numeric map key.
 *
 * Injective (and non-negative) for every cell coordinate the game can reach —
 * roughly ±1 000 000 cells, i.e. a ±64 000 000 px world at the default cell
 * size — so distinct cells never share a bucket. Beyond that range the packing
 * degrades gracefully to merging cells, which only adds candidates for the
 * narrow phase to reject; it can never lose a hit.
 */
function cellKey(column: number, row: number): number {
  return (column + CELL_KEY_ORIGIN) * CELL_KEY_STRIDE + (row + CELL_KEY_ORIGIN);
}
