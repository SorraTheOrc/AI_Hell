/**
 * Shared Centipede chain model (classic-arcade archetype, AH-0MV01EJ92008ZZ86).
 *
 * A Centipede is a **linked chain of segments**: a lead segment weaves
 * laterally while descending, and every following segment trails the one
 * ahead at a fixed spacing. Destroying a middle segment splits the chain
 * into two independent sub-chains (the segments ahead and the segments
 * behind), each with its own lead that keeps weaving; destroying the lead or
 * the tail leaves a single shortened chain. The chain speeds up as segments
 * are destroyed — the classic cascade.
 *
 * This module is **pure** (no Phaser, no browser globals) so the movement,
 * edge handling, split and speed-up laws live once and are fully unit
 * testable. The `Centipede` entity (`src/entities/Centipede.ts`) is a thin
 * shell that reads segment positions from the chain, so the shipped game and
 * every gym run the *same* chain code.
 *
 * ## Geometry
 *
 * The lead of each sub-chain walks a triangle wave horizontally
 * (reversing at the left/right arena bounds) and descends at a fixed
 * vertical rate. Reaching the bottom edge wraps the lead back to the top
 * (classic Centipede re-entry). Following segments are placed a fixed
 * *arc-length* behind their lead along the recorded path, so the chain
 * reads as a continuous snake through every reversal.
 *
 * @module scenes/core/centipedeChain
 */

/** Arena bounds (px) the chain is kept inside. */
export interface CentipedeArena {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Construction options for one full chain. */
export interface CentipedeChainOptions {
  /** Lead segment x at spawn (px). */
  startX: number;
  /** Lead segment y at spawn (px). */
  startY: number;
  /** Movement bounds (px). */
  arena: CentipedeArena;
  /** Number of segments (the chain length). */
  segmentCount: number;
  /** Fixed arc-length between adjacent segments (px). */
  spacing: number;
  /** Horizontal weave speed of a full-strength chain (px/s). */
  lateralSpeed: number;
  /** Vertical descent speed of a full-strength chain (px/s). */
  descentSpeed: number;
  /** Initial horizontal direction: `1` right (default) or `-1` left. */
  initialDir?: 1 | -1;
}

/** One chain segment. Positions are written by {@link CentipedeChain.advance}. */
export interface CentipedeSegment {
  /** Stable id — equals the original chain index (0 = initial lead). */
  readonly id: number;
  /** Whether the segment is still alive. */
  alive: boolean;
  /** Current x position (px). */
  x: number;
  /** Current y position (px). */
  y: number;
}

/** A point on a sub-chain's recorded lead path (with cumulative distance). */
interface PathPoint {
  x: number;
  y: number;
  /** Cumulative arc length from the oldest retained point. */
  d: number;
}

/** One contiguous sub-chain: an ordered segment list (0 = its lead) + path. */
interface SubChain {
  segments: CentipedeSegment[];
  dir: 1 | -1;
  /** Horizontal distance travelled by this sub-chain's lead. */
  s: number;
  /** Lead x at `s = 0` (the triangle-wave origin). */
  originX: number;
  /** Lead y at `s = 0` (the descent origin). */
  originY: number;
  path: PathPoint[];
}

/**
 * Speed multiplier for a chain with `alive` of `initial` segments.
 *
 * Monotonically increasing as segments are destroyed: `1` at full strength,
 * approaching `2` for a lone survivor. Exposed so the speed-up law can be
 * pinned directly by a unit test and reused by any future consumer.
 */
export function centipedeSpeedMultiplier(alive: number, initial: number): number {
  if (alive <= 0 || initial <= 0) return 1;
  return 1 + (initial - alive) / initial;
}

/** Triangle wave: reflect `value` into `[min, max]` with period `2*(max-min)`. */
function triangle(value: number, min: number, max: number): number {
  const span = max - min;
  if (span <= 0) return min;
  const period = span * 2;
  let p = ((value - min) % period + period) % period;
  if (p > span) p = period - p;
  return min + p;
}

/** Point at arc length `target` along a path (clamped to the path ends). */
function pointAtDistance(path: PathPoint[], target: number): { x: number; y: number } {
  if (path.length === 0) return { x: 0, y: 0 };
  if (target <= path[0].d) return { x: path[0].x, y: path[0].y };
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1];
    const next = path[i];
    if (next.d >= target) {
      const span = next.d - prev.d;
      const t = span > 0 ? (target - prev.d) / span : 0;
      return {
        x: prev.x + (next.x - prev.x) * t,
        y: prev.y + (next.y - prev.y) * t,
      };
    }
  }
  const last = path[path.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * A segmented Centipede chain: weave + descent + edge handling, split on
 * segment death, and monotonic speed-up as the chain thins.
 */
export class CentipedeChain {
  /** Number of segments at spawn (the initial chain length). */
  readonly segmentCount: number;
  /** Fixed arc-length between adjacent segments (px). */
  readonly spacing: number;

  private readonly arena: CentipedeArena;
  private readonly lateralSpeed: number;
  private readonly descentSpeed: number;
  private readonly _segments: CentipedeSegment[];
  private _subChains: SubChain[];

  constructor(options: CentipedeChainOptions) {
    if (options.segmentCount <= 0) {
      throw new Error('CentipedeChain requires at least one segment');
    }
    this.segmentCount = options.segmentCount;
    this.spacing = options.spacing;
    this.arena = options.arena;
    this.lateralSpeed = Math.max(0, options.lateralSpeed);
    this.descentSpeed = Math.max(0, options.descentSpeed);

    const dir: 1 | -1 = options.initialDir ?? 1;
    this._segments = Array.from({ length: options.segmentCount }, (_, id) => ({
      id,
      alive: true,
      x: options.startX,
      y: options.startY,
    }));

    const lead: SubChain = {
      segments: this._segments.slice(),
      dir,
      s: 0,
      originX: options.startX,
      originY: options.startY,
      path: [],
    };
    this._seedHorizontal(lead, options.startX, options.startY);
    this._subChains = [lead];
    this._positionAll();
  }

  // ── Queries ──────────────────────────────────────────────────────

  /** Every segment, in original chain order (dead segments included). */
  get segments(): readonly CentipedeSegment[] {
    return this._segments;
  }

  /** The segment with the supplied id, or `undefined`. */
  segment(id: number): CentipedeSegment | undefined {
    return this._segments.find((s) => s.id === id);
  }

  /** Number of live segments. */
  aliveCount(): number {
    return this._segments.reduce((n, s) => n + (s.alive ? 1 : 0), 0);
  }

  /** Original index of the current lead (first live segment), or `-1`. */
  headIndex(): number {
    const head = this._segments.find((s) => s.alive);
    return head ? head.id : -1;
  }

  /** Current number of independent sub-chains (1 head, 2 after a middle split). */
  subChainCount(): number {
    return this._subChains.length;
  }

  /**
   * Live segments grouped into contiguous sub-chains by original index.
   * The `head`/`tail` split cases each yield one run; a middle-segment kill
   * yields two.
   */
  runs(): number[][] {
    const result: number[][] = [];
    let current: number[] = [];
    for (const seg of this._segments) {
      if (seg.alive) {
        current.push(seg.id);
      } else if (current.length > 0) {
        result.push(current);
        current = [];
      }
    }
    if (current.length > 0) result.push(current);
    return result;
  }

  /** Speed multiplier applied to the full-strength movement speeds. */
  speedMultiplier(): number {
    return centipedeSpeedMultiplier(this.aliveCount(), this.segmentCount);
  }

  // ── Movement ─────────────────────────────────────────────────────

  /**
   * Advances the chain (or the sub-chain headed by `segmentId`) by `dt`
   * seconds. Only the current head of a sub-chain advances it — every other
   * segment of that sub-chain is skipped — so a shared chain advances exactly
   * once per frame no matter how many segment entities call this.
   */
  tick(dt: number, segmentId: number): void {
    const sub = this._subChainFor(segmentId);
    if (!sub || sub.segments.length === 0) return;
    if (sub.segments[0].id !== segmentId) return;
    this._advanceSubChain(sub, dt);
  }

  /** Advances every sub-chain by `dt` seconds (used by direct unit tests). */
  advance(dt: number): void {
    for (const sub of this._subChains) {
      if (sub.segments.length === 0) continue;
      this._advanceSubChain(sub, dt);
    }
  }

  private _advanceSubChain(sub: SubChain, dt: number): void {
    const mult = this.speedMultiplier();
    let remaining = this.lateralSpeed * mult * Math.max(0, dt);
    const step = Math.max(1, this.spacing / 2);
    while (remaining > 1e-9) {
      const delta = Math.min(remaining, step);
      remaining -= delta;
      sub.s += delta;

      const x = this._leadX(sub);
      const y = sub.originY + this._descentRatio() * sub.s;
      if (y >= this.arena.maxY) {
        // Bottom edge: wrap the chain back to the top (classic re-entry).
        // Re-anchor the descent at the top so the recorded path does not
        // stretch across the screen, and re-seed the trail behind the lead.
        sub.originY = this.arena.minY;
        sub.s = 0;
        sub.originX = x;
        this._seedHorizontal(sub, x, this.arena.minY);
        continue;
      }
      this._appendPoint(sub, x, y);
    }
    this._positionSubChain(sub);
  }

  private _descentRatio(): number {
    if (this.lateralSpeed <= 0) return 0;
    return this.descentSpeed / this.lateralSpeed;
  }

  private _leadX(sub: SubChain): number {
    return triangle(
      sub.originX + sub.dir * sub.s,
      this.arena.minX,
      this.arena.maxX,
    );
  }

  // ── Split / destruction ──────────────────────────────────────────

  /**
   * Marks the segment destroyed and re-forms the chain:
   *
   * - **lead** → the next segment becomes the lead of the same sub-chain;
   * - **tail** → the segment is dropped, leaving one shortened sub-chain;
   * - **middle** → the chain splits into two independent sub-chains (the
   *   segments ahead and behind), each with its own lead and path.
   *
   * A no-op for an unknown or already-dead segment.
   */
  destroySegment(id: number): void {
    const seg = this.segment(id);
    if (!seg || !seg.alive) return;
    seg.alive = false;

    const sub = this._subChains.find((sc) => sc.segments.includes(seg));
    if (!sub) return;
    const index = sub.segments.indexOf(seg);

    if (index === 0) {
      // Lead destroyed: the next live segment leads the same sub-chain.
      sub.segments = sub.segments.slice(1);
      this._pruneEmpty();
      if (sub.segments.length > 0) {
        this._leadSubChain(sub, sub.segments[0]);
      }
    } else if (index === sub.segments.length - 1) {
      // Tail destroyed: simply drop it — the lead is unchanged.
      sub.segments = sub.segments.slice(0, -1);
    } else {
      // Middle destroyed: split into front and back independent sub-chains.
      const front = sub.segments.slice(0, index);
      const back = sub.segments.slice(index + 1);
      sub.segments = front;
      if (back.length > 0) {
        const newSub: SubChain = {
          segments: back,
          dir: sub.dir,
          s: 0,
          originX: back[0].x,
          originY: back[0].y,
          path: [],
        };
        this._leadSubChain(newSub, back[0]);
        this._subChains.push(newSub);
      }
    }
    this._positionAll();
  }

  /** Re-anchors a sub-chain so `head` leads a fresh straight-behind path. */
  private _leadSubChain(sub: SubChain, head: CentipedeSegment): void {
    sub.s = 0;
    sub.originX = head.x;
    sub.originY = head.y;
    sub.path = [];
    this._seedHorizontal(sub, head.x, head.y);
  }

  private _pruneEmpty(): void {
    this._subChains = this._subChains.filter((sc) => sc.segments.length > 0);
  }

  private _subChainFor(segmentId: number): SubChain | undefined {
    return this._subChains.find((sc) =>
      sc.segments.some((s) => s.id === segmentId),
    );
  }

  // ── Path helpers ─────────────────────────────────────────────────

  /** Seeds a straight horizontal trail of `segments.length` points behind `head`. */
  private _seedHorizontal(sub: SubChain, headX: number, headY: number): void {
    sub.path = [];
    const count = Math.max(1, sub.segments.length);
    for (let m = count - 1; m >= 0; m--) {
      const x = headX - sub.dir * m * this.spacing;
      const d = (count - 1 - m) * this.spacing;
      sub.path.push({ x, y: headY, d });
    }
  }

  private _appendPoint(sub: SubChain, x: number, y: number): void {
    const last = sub.path[sub.path.length - 1];
    const d = last ? last.d + Math.hypot(x - last.x, y - last.y) : 0;
    sub.path.push({ x, y, d });
    this._trim(sub);
  }

  /** Drops path points no longer needed by any segment trail (plus slack). */
  private _trim(sub: SubChain): void {
    const total = sub.path[sub.path.length - 1].d;
    const keep = (this.segmentCount + 3) * this.spacing;
    let first = 0;
    while (sub.path.length - first > 2 && sub.path[first + 1].d < total - keep) {
      first += 1;
    }
    if (first > 0) sub.path = sub.path.slice(first);
  }

  /** Writes every live segment's world position from its sub-chain path. */
  private _positionAll(): void {
    for (const sub of this._subChains) this._positionSubChain(sub);
  }

  private _positionSubChain(sub: SubChain): void {
    if (sub.path.length === 0) return;
    const total = sub.path[sub.path.length - 1].d;
    for (let j = 0; j < sub.segments.length; j++) {
      const point = pointAtDistance(sub.path, total - j * this.spacing);
      sub.segments[j].x = point.x;
      sub.segments[j].y = point.y;
    }
  }
}
