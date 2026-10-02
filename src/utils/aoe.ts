/**
 * Pure area-of-effect (AOE) targeting helpers (parent AH-0MUOOB3OR001V8CD).
 *
 * The AOE weapons resolve their effect through the shared combat core, which
 * reads an {@link import('./weapons').AoEDescriptor}. This module owns the
 * **pure** geometry: which live targets lie inside an effect area, and which
 * target is nearest to an origin (the basis for the Arc chain). Keeping the
 * maths here — separate from the Phaser scene — makes it unit-testable
 * without booting a scene, and guarantees the game and every gym select the
 * same targets for the same inputs.
 *
 * Distances are plain Euclidean (px). A target's hit radius is included in
 * the overlap test, so a large entity is caught when its edge intersects the
 * effect area even if its centre lies just outside.
 */

/** A positioned target the AOE geometry helpers can reason about. */
export interface AoEGeometryTarget {
  /** World x position (px). */
  x: number;
  /** World y position (px). */
  y: number;
  /**
   * Hit radius (px). When present, the target is inside the area when
   * `centreDistance <= radius + hitRadius`; a point target (no radius)
   * is inside when its centre is within the radius.
   */
  getHitRadius?(): number;
  /**
   * Live flag. When explicitly `false` the target is ignored (dead
   * entities never take AOE damage or chain); `undefined` is treated as
   * live so plain positional targets are supported.
   */
  alive?: boolean;
}

/** Returns the squared distance between (ax, ay) and (bx, by). */
export function distanceSquared(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * True when `target` (its centre plus its own hit radius, if any) lies
 * inside the effect area centred on (originX, originY) with the given
 * radius. Dead targets (`alive === false`) are never inside.
 */
export function isInAoEArea(
  originX: number,
  originY: number,
  radius: number,
  target: AoEGeometryTarget,
): boolean {
  if (target.alive === false) return false;
  const targetRadius = target.getHitRadius?.() ?? 0;
  const reach = radius + Math.max(0, targetRadius);
  return distanceSquared(originX, originY, target.x, target.y) <= reach * reach;
}

/**
 * Every live target inside the effect area, preserving the input order.
 *
 * @param originX - Effect origin x (px).
 * @param originY - Effect origin y (px).
 * @param radius - Effect radius (px).
 * @param targets - Candidate targets.
 * @returns The targets inside the area (a new array).
 */
export function selectAoETargets<T extends AoEGeometryTarget>(
  originX: number,
  originY: number,
  radius: number,
  targets: readonly T[],
): T[] {
  return targets.filter((target) =>
    isInAoEArea(originX, originY, radius, target),
  );
}

/**
 * The live target nearest to (originX, originY), or `null` when none are
 * live. Ties resolve to the earlier candidate, so selection is
 * deterministic — the basis for the Arc weapon's primary target.
 *
 * @param originX - Origin x (px).
 * @param originY - Origin y (px).
 * @param targets - Candidate targets.
 * @param exclude - Targets to ignore (e.g. already-chained enemies).
 */
export function findNearestTarget<T extends AoEGeometryTarget>(
  originX: number,
  originY: number,
  targets: readonly T[],
  exclude: ReadonlySet<T> = new Set<T>(),
): T | null {
  let nearest: T | null = null;
  let nearestDistance = Infinity;
  for (const target of targets) {
    if (target.alive === false || exclude.has(target)) continue;
    const distance = distanceSquared(originX, originY, target.x, target.y);
    if (distance < nearestDistance) {
      nearest = target;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/**
 * Chains from an origin through up to `maxLinks` nearest live targets,
 * each subsequent hop starting from the previous target and skipping
 * already-selected targets. Pure and order-deterministic, so the Arc
 * weapon's chain is identical in the game and the gyms.
 *
 * @param originX - Chain origin x (px).
 * @param originY - Chain origin y (px).
 * @param targets - Candidate targets.
 * @param maxLinks - Maximum number of targets to return (0 → empty).
 * @returns The chained targets in hop order.
 */
export function selectChainTargets<T extends AoEGeometryTarget>(
  originX: number,
  originY: number,
  targets: readonly T[],
  maxLinks: number,
): T[] {
  const chain: T[] = [];
  if (!Number.isFinite(maxLinks) || maxLinks <= 0) return chain;
  const chosen = new Set<T>();
  let fromX = originX;
  let fromY = originY;
  while (chain.length < maxLinks) {
    const next = findNearestTarget(fromX, fromY, targets, chosen);
    if (!next) break;
    chain.push(next);
    chosen.add(next);
    fromX = next.x;
    fromY = next.y;
  }
  return chain;
}
