import { describe, expect, it } from 'vitest';

import {
  FORMATION_GLIDE_SECONDS,
  FormationGlide,
  type GlideTarget,
} from './formationGlide';

/** Minimal position-capable stub that records every set. */
class StubTarget implements GlideTarget {
  x = 0;
  y = 0;
  readonly positions: Array<{ x: number; y: number }> = [];

  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.positions.push({ x, y });
  }
}

describe('FormationGlide (shared re-anchor glide)', () => {
  it('is inactive until a glide begins and no-ops when updated empty', () => {
    const glide = new FormationGlide();
    expect(glide.active).toBe(false);
    expect(() => glide.update(0.1)).not.toThrow();
    expect(glide.active).toBe(false);
  });

  it('eases the entity over multiple frames and reaches the live target exactly on completion', () => {
    const glide = new FormationGlide();
    const target = new StubTarget();
    target.x = 100;
    target.y = 50;

    glide.begin([target]);
    expect(glide.active).toBe(true);

    // Frame 1: the positioning pass sets the live target at x=200; the glide
    // overrides to a point strictly between the from position and the target.
    target.x = 200;
    target.y = 50;
    glide.update(FORMATION_GLIDE_SECONDS / 2);
    expect(target.x).toBeGreaterThan(100);
    expect(target.x).toBeLessThan(200);
    expect(glide.active).toBe(true);

    // Remaining frames: eventually land exactly on the live target.
    target.x = 200;
    glide.update(FORMATION_GLIDE_SECONDS);
    expect(target.x).toBe(200);
    expect(target.y).toBe(50);
    expect(glide.active).toBe(false);
  });

  it('applies the residual to the live target each frame (drift is tracked, not snapshotted)', () => {
    const glide = new FormationGlide();
    const target = new StubTarget();
    target.x = 0;

    glide.begin([target]);

    let liveX = 0;
    for (let i = 0; i < 10; i++) {
      liveX += 10; // the formation drifts each frame
      target.x = liveX; // applyFormationPosition sets the live target
      glide.update(0.05);
    }

    // The landing matches the final drifted slot, not the first snapshot.
    expect(target.x).toBe(liveX);
    expect(glide.active).toBe(false);
  });

  it('is a no-op for entities whose applyFormationPosition does not move them', () => {
    const glide = new FormationGlide();
    const target = new StubTarget();
    target.x = 42;
    target.y = 24;

    glide.begin([target]);
    // The positioning pass leaves the entity where it was (e.g. an asteroid).
    glide.update(0.1);
    expect(target.x).toBe(42);
    expect(target.y).toBe(24);
  });

  it('clear() drops all active glides', () => {
    const glide = new FormationGlide();
    const target = new StubTarget();
    glide.begin([target]);
    expect(glide.active).toBe(true);
    glide.clear();
    expect(glide.active).toBe(false);
  });

  it('glides multiple entities independently', () => {
    const glide = new FormationGlide();
    const a = new StubTarget();
    const b = new StubTarget();
    a.x = 0;
    b.x = 0;

    glide.begin([a, b]);
    a.x = 100;
    b.x = 300;
    glide.update(0.05);

    // Both are strictly between their own from and live target.
    expect(a.x).toBeGreaterThan(0);
    expect(a.x).toBeLessThan(100);
    expect(b.x).toBeGreaterThan(0);
    expect(b.x).toBeLessThan(300);
  });
});
