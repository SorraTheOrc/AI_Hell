import { describe, expect, it } from 'vitest';

import { keysToInput, KeyLike } from './input';
import { MovementInput } from './movement';

// ── Helpers ─────────────────────────────────────────────────────────

function key(down = false): KeyLike {
  return { isDown: down };
}

function cursors(up = false, down = false, left = false, right = false) {
  return { up: key(up), down: key(down), left: key(left), right: key(right) };
}

function wasd(W = false, A = false, S = false, D = false) {
  return { W: key(W), A: key(A), S: key(S), D: key(D) };
}

// ── keysToInput ─────────────────────────────────────────────────────

describe('keysToInput', () => {
  it('returns all-false input when no keys are held', () => {
    expect(keysToInput(cursors(), wasd())).toEqual({
      up: false, down: false, left: false, right: false,
    } satisfies MovementInput);
  });

  it('maps cursor arrows to input', () => {
    expect(keysToInput(cursors(true, false, false, true), wasd())).toEqual({
      up: true, down: false, left: false, right: true,
    } satisfies MovementInput);
  });

  it('maps WASD keys to input', () => {
    expect(keysToInput(cursors(), wasd(false, true, true, false))).toEqual({
      up: false, down: true, left: true, right: false,
    } satisfies MovementInput);
  });

  it('combines cursor and WASD on the same axis (either-held wins)', () => {
    expect(keysToInput(cursors(true), wasd(false, false, false, false))).toEqual({
      up: true, down: false, left: false, right: false,
    } satisfies MovementInput);
  });

  it('supports diagonals from cursor keys and WASD', () => {
    // Arrow Up + W + D → up+right diagonal
    const input = keysToInput(cursors(true, false, false, true), wasd(true, false, false, true));
    expect(input.up).toBe(true);
    expect(input.right).toBe(true);
    expect(input.down).toBe(false);
    expect(input.left).toBe(false);
  });

  it('handles undefined key groups gracefully (no keyboard input)', () => {
    expect(keysToInput(undefined, undefined)).toEqual({
      up: false, down: false, left: false, right: false,
    } satisfies MovementInput);
  });
});