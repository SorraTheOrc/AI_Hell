/**
 * Graphics command-buffer probe for beam VFX tests (AH-0MWJ8JUEF006XBLB).
 *
 * The beam modules draw with a code-drawn `Graphics` (no textures, no sprite
 * pixels), so their contract is asserted by reading Phaser's command buffer —
 * the shared pattern the beam suites already used. These helpers keep the
 * opcode parsing in one place so the anchored seam, both beam weapons and the
 * scene-level tests all read the drawn geometry the same way.
 *
 * @module test/vfxProbe
 */

import type Phaser from 'phaser';
import { expect } from 'vitest';

/** Phaser `Graphics` command opcodes (the subset the beam modules use). */
export const Cmd = {
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
  LINE_TO: 4,
  MOVE_TO: 5,
  FILL_PATH: 8,
  STROKE_PATH: 9,
} as const;

/** Parameter count following each opcode (0 for path terminators). */
export const CmdWidths: Record<number, number> = {
  [Cmd.BEGIN_PATH]: 0,
  [Cmd.CLOSE_PATH]: 0,
  [Cmd.LINE_TO]: 2,
  [Cmd.MOVE_TO]: 2,
  [Cmd.FILL_PATH]: 0,
  [Cmd.STROKE_PATH]: 0,
};

/** Counts occurrences of a command opcode in a Graphics command buffer. */
export function countOps(buf: number[], target: number): number {
  let count = 0;
  for (let i = 0; i < buf.length; i += 1 + (CmdWidths[buf[i]] ?? 0)) {
    if (buf[i] === target) count += 1;
  }
  return count;
}

/** One stroked run of a beam polyline. */
export interface ProbedSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * The stroked segments of a beam's **outer** pass. A beam column is drawn as
 * two identical passes (the coloured column plus its hot core), so only the
 * first half of the parsed runs is returned.
 */
export function outerSegments(
  beam: Phaser.GameObjects.Graphics,
): ProbedSegment[] {
  const buf = beam.commandBuffer as number[];
  const segments: ProbedSegment[] = [];
  let current: ProbedSegment | null = null;
  for (let i = 0; i < buf.length; i += 1 + (CmdWidths[buf[i]] ?? 0)) {
    const op = buf[i];
    if (op === Cmd.MOVE_TO) {
      current = { x1: buf[i + 1], y1: buf[i + 2], x2: NaN, y2: NaN };
    } else if (op === Cmd.LINE_TO && current) {
      current.x2 = buf[i + 1];
      current.y2 = buf[i + 2];
      segments.push(current);
      current = null;
    }
  }
  return segments.slice(0, segments.length / 2);
}

/** The beam's drawn source point (the first stroked run's start). */
export function drawnSource(beam: Phaser.GameObjects.Graphics): {
  x: number;
  y: number;
} {
  const first = outerSegments(beam)[0];
  return { x: first.x1, y: first.y1 };
}

/** The beam's drawn far end (the last stroked run's end). */
export function drawnDestination(beam: Phaser.GameObjects.Graphics): {
  x: number;
  y: number;
} {
  const segments = outerSegments(beam);
  const last = segments[segments.length - 1];
  return { x: last.x2, y: last.y2 };
}

/**
 * Asserts a probed beam point equals `expected` to 6 decimal places. The drawn
 * coordinates pass through `Math.cos`/`Math.sin`, so exact equality would be a
 * spurious 1e-15 apart.
 */
export function expectPoint(
  actual: { x: number; y: number },
  expected: { x: number; y: number },
): void {
  expect(actual.x).toBeCloseTo(expected.x, 6);
  expect(actual.y).toBeCloseTo(expected.y, 6);
}
