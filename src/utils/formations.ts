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
 * Offsets are 2D Gaussian-ish clusters around a few local centres rather
 * than a strict grid, so the swarm reads as several tight packs that can
 * slide past one another. Returns offsets in spawn order (cluster 0 first).
 */
export function buildSwarmClusterOffsets(count: number): FormationOffset[] {
  const offsets: FormationOffset[] = [];
  if (count <= 0) return offsets;

  const clusters = Math.max(1, Math.round(count / 4)); // 3–5 per pack
  let remaining = count;
  let spawn = 0;
  for (let c = 0; c < clusters && remaining > 0; c++) {
    const packSize = Math.min(remaining, Math.max(2, Math.round(count / clusters)));
    // Local centre of this cluster (each cluster drifts independently).
    const centreRow = c * 1.4;
    const centreCol = c * 1.8;
    for (let m = 0; m < packSize; m++) {
      // Squareish scatter around the centre (deterministic, seeded by index).
      const spread = m % 2 === 0 ? 0.7 : -0.7;
      const drift2 = Math.floor(m / 2) - Math.floor(packSize / 2);
      offsets.push({
        row: centreRow + Math.round(spread * 100) / 100,
        col: centreCol + Math.round(drift2 * 0.9 * 100) / 100,
      });
      remaining--;
      spawn++;
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