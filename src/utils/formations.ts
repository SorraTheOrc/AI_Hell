/**
 * Shared formation geometry helpers (GDD §4.1).
 *
 * Formation offset builders used by every enemy gym scene. Pure and
 * side-effect free — fully unit-testable without a running scene.
 *
 * A formation is described by per-enemy `FormationOffset` values: each
 * enemy sits at `(baseX + col * spacingX, baseY + row * spacingY)` where
 * `(baseX, baseY)` is the formation's moving base position. Builders
 * return offsets in the exact order enemies spawn (row-major, apex/front
 * first).
 */

/** Position of one enemy within its formation, relative to the base. */
export interface FormationOffset {
  /** Formation row — 0 is the front/apex. */
  row: number;
  /** Formation column — negative values hug the left wing. */
  col: number;
}

/**
 * Row stride between swarm cluster centres (in formation-slot units).
 * Used by the builder below and by GymSwarm to derive a member's cluster
 * index from its offset row.
 */
export const SWARM_CLUSTER_ROW_STRIDE = 1.4;

/**
 * Builds V-formation offsets for `count` scouts: row 0 has one scout
 * (the apex), row 1 two scouts, row 2 three — wing columns spread outward
 * symmetrically. Returns rows in ascending order (apex first).
 */
export function buildVFormationOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  if (count <= 0) return offsets;

  let remaining = count;
  let row = 0;
  while (remaining > 0) {
    const rowWidth = Math.min(remaining, row + 1);
    const startCol = -row;
    for (let col = 0; col < rowWidth; col++) {
      offsets.push({ row, col: startCol + col * 2 });
    }
    remaining -= rowWidth;
    row += 1;
  }
  return offsets;
}

/**
 * Builds a compact diamond/chevron formation for divers.
 * The formation is wider than tall, with a point at the top —
 * suggesting an attack vector (1, 2, 3, 2, 1… row pattern).
 */
export function buildDiverFormationOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  if (count <= 0) return offsets;

  const halfRows = Math.ceil(count / 2);
  let remaining = count;

  // Top half (including middle row if odd).
  for (let row = 0; row < halfRows && remaining > 0; row++) {
    const rowWidth = Math.min(remaining, row + 1);
    const startCol = -(rowWidth - 1) / 2;
    for (let col = 0; col < rowWidth; col++) {
      offsets.push({ row, col: startCol + col });
      remaining--;
    }
  }

  // Bottom half.
  for (let row = halfRows; row < halfRows + Math.floor(count / 2) && remaining > 0; row++) {
    const rowWidth = Math.min(remaining, halfRows - row + halfRows - 1);
    const clampedWidth = Math.min(rowWidth, halfRows);
    const startCol = -(clampedWidth - 1) / 2;
    for (let col = 0; col < clampedWidth; col++) {
      offsets.push({ row, col: startCol + col });
      remaining--;
    }
  }

  return offsets;
}

/**
 * Builds loose cluster offsets for swarms (E5, GDD §4.1).
 *
 * Members are divided into packs of 3–5 (GDD §4.1: "Clusters of 3–5
 * enemies move together"), each pack clustered around a local centre
 * (`centreRow = c * SWARM_CLUSTER_ROW_STRIDE`, `centreCol = c * 2`).
 * The offsets are deterministic and tight: intra-cluster column spread is
 * 0.6 slots, row spread ±0.5 slots — so each pack reads as one close group
 * that can slide past neighbouring packs. Returns offsets in spawn order
 * (cluster 0 members first).
 */
export function buildSwarmClusterOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  if (count <= 0) return offsets;

  // Packs of 3–5 → ~count/5 clusters, always at least one.
  const clusters = Math.min(count, Math.max(1, Math.ceil(count / 5)));
  const base = Math.floor(count / clusters);
  const extra = count % clusters;

  for (let c = 0; c < clusters; c++) {
    const size = base + (c < extra ? 1 : 0);
    const centreRow = c * SWARM_CLUSTER_ROW_STRIDE;
    const centreCol = c * 2;
    for (let m = 0; m < size; m++) {
      offsets.push({
        row: centreRow + (m % 2 === 0 ? 0.5 : -0.5),
        col: centreCol + (m - (size - 1) / 2) * 0.6,
      });
    }
  }
  return offsets;
}

/**
 * Builds a rectangular grid formation of tanks.
 * Returns offsets in row-major order (row 0 = front, col spreads outward).
 */
export function buildRectFormationOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  if (count <= 0) return offsets;

  // Use a compact grid: 3 columns × ceil(count/3) rows.
  const cols = 3;
  const rows = Math.ceil(count / cols);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (offsets.length < count) {
        offsets.push({ row, col: col - Math.floor(cols / 2) });
      }
    }
  }
  return offsets;
}

// ── Registry consumed by the enemy-config pipeline (AH-0MTFP7EIC004F1MN) ──

/** Extra formation used by the Phaser orbital path (phase columns). */
export function buildOrbitalPhaseOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  for (let i = 0; i < count; i++) offsets.push({ row: 0, col: i });
  return offsets;
}

/** Single-entity formation for the Boss. */
export function buildSingleOffset(_count: number): FormationOffset[] {
  return [{ row: 0, col: 0 }];
}

export type EnemyFormationKind = 'v' | 'diver' | 'rect' | 'swarm' | 'orbital' | 'single';

export const FORMATION_BUILDERS: Record<EnemyFormationKind, (count: number) => FormationOffset[]> = {
  v: buildVFormationOffsets,
  diver: buildDiverFormationOffsets,
  rect: buildRectFormationOffsets,
  swarm: buildSwarmClusterOffsets,
  orbital: buildOrbitalPhaseOffsets,
  single: buildSingleOffset,
};

/** Returns a builder for `kind`, falling back to `v` for unknown/invalid values. */
export function getFormationBuilder(kind: string): (count: number) => FormationOffset[] {
  if (kind in FORMATION_BUILDERS) return FORMATION_BUILDERS[kind as EnemyFormationKind];
  return buildVFormationOffsets;
}
