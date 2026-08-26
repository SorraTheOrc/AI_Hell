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