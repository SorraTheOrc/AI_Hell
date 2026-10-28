/**
 * Unit tests for the shared wormhole-transit destination seam
 * (AH-0MVRMHQC9003VDNN).
 *
 * `resolveSpawnTransitTarget` is the single definition of the rule every
 * spawn site runs: **autonomous-mover exemption → orbital live slot →
 * grid-slot/offset fallback**. It is pure — no Phaser, no scene state, no
 * mutation — so this file asserts it directly. The cross-scene behaviour that
 * consumes it is covered by the scene suites and the red-before parity tests
 * (`src/scenes/gym/spawnParity.test.ts`).
 *
 * @module scenes/core/spawnTransit (AH-0MVRMHQC9003VDNN)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  resolveSpawnTransitTarget,
  type SpawnTransitEntity,
  type SpawnTransitInput,
} from './spawnTransit';

const BASE = { x: 100, y: 50 } as const;
const OFFSET = { row: 1, col: -2 } as const;
const SPACING_X = 30;
const SPACING_Y = 40;

/** The grid-slot fallback for {@link BASE}/{@link OFFSET}: base + offset × spacing. */
const GRID_SLOT = {
  x: BASE.x + OFFSET.col * SPACING_X,
  y: BASE.y + OFFSET.row * SPACING_Y,
} as const;

/** A plain entity with no optional capabilities. */
const plainEntity = (): SpawnTransitEntity => ({});

/** Builds a transit request, defaulting every field the resolver reads. */
function request(
  entity: SpawnTransitEntity,
  overrides: Partial<Omit<SpawnTransitInput, 'entity'>> = {},
): SpawnTransitInput {
  return {
    entity,
    transit: true,
    base: BASE,
    offset: OFFSET,
    spacingX: SPACING_X,
    spacingY: SPACING_Y,
    ...overrides,
  };
}

describe('resolveSpawnTransitTarget — the shared transit-destination rule', () => {
  it('exempts an autonomous mover from transit even when it exposes an orbital slot', () => {
    // The Raider-style autonomous entity drives its own position; a
    // destination would fight its motion, so the rule reports "spawn in
    // place" before it ever looks at the orbital seam.
    const formationSlot = vi.fn(() => ({ x: 1, y: 2 }));
    const entity: SpawnTransitEntity = {
      autonomousPositioning: true,
      formationSlot,
    };

    expect(resolveSpawnTransitTarget(request(entity))).toBeUndefined();
    expect(formationSlot).not.toHaveBeenCalled();
  });

  it('resolves a non-orbital entity to the grid slot from base + offset × spacing', () => {
    expect(resolveSpawnTransitTarget(request(plainEntity()))).toEqual(GRID_SLOT);
  });

  it('resolves an orbital entity to its live formationSlot(), not the grid slot', () => {
    const orbitalSlot = { x: 260.5, y: -70.25 };
    const formationSlot = vi.fn(() => orbitalSlot);
    const entity: SpawnTransitEntity = { formationSlot };

    const target = resolveSpawnTransitTarget(request(entity));

    expect(target).toEqual(orbitalSlot);
    // Prove the assertion distinguishes the branches: the orbital slot is
    // deliberately nowhere near the grid slot.
    expect(target).not.toEqual(GRID_SLOT);
  });

  it('passes the supplied base to formationSlot() and binds the entity as this', () => {
    const formationSlot = vi.fn(function (
      this: SpawnTransitEntity,
      _baseX: number,
      _baseY: number,
    ) {
      return { x: this === entity ? 1 : 0, y: this === entity ? 1 : 0 };
    });
    const entity: SpawnTransitEntity = { formationSlot };

    const target = resolveSpawnTransitTarget(request(entity));

    expect(formationSlot).toHaveBeenCalledWith(BASE.x, BASE.y);
    expect(target).toEqual({ x: 1, y: 1 });
  });

  it('re-resolves the live slot on every call so a moving orbit is tracked', () => {
    let phase = 0;
    const entity: SpawnTransitEntity = {
      formationSlot: () => {
        phase += 1;
        return { x: BASE.x + phase * 10, y: BASE.y };
      },
    };

    const first = resolveSpawnTransitTarget(request(entity));
    const second = resolveSpawnTransitTarget(request(entity));

    expect(first).toEqual({ x: BASE.x + 10, y: BASE.y });
    expect(second).toEqual({ x: BASE.x + 20, y: BASE.y });
    expect(second).not.toEqual(first);
  });

  it('reports no transit for an in-place spawn (no wormhole origin)', () => {
    // Boss minions are not part of the wave's wormhole entry: the site passes
    // `transit: false`, and the resolver's "spawn in place" answer must win
    // over both the orbital and the grid branches.
    const formationSlot = vi.fn(() => ({ x: 1, y: 2 }));

    expect(
      resolveSpawnTransitTarget(
        request({ formationSlot }, { transit: false }),
      ),
    ).toBeUndefined();
    expect(
      resolveSpawnTransitTarget(request(plainEntity(), { transit: false })),
    ).toBeUndefined();
    expect(formationSlot).not.toHaveBeenCalled();
  });

  it('treats the base as caller-owned: the march base and the drift base resolve identically', () => {
    // The scene owns *which* base is current (marchState when the wave is a
    // march block, the drift base otherwise); the rule only applies the
    // offset relative to whatever base it is given.
    const marchBase = { x: 240, y: 90 };
    const driftBase = { x: 240, y: 90 };
    const plain = plainEntity();

    const marchTarget = resolveSpawnTransitTarget(
      request(plain, { base: marchBase }),
    )!;
    expect(marchTarget).toEqual({
      x: marchBase.x + OFFSET.col * SPACING_X,
      y: marchBase.y + OFFSET.row * SPACING_Y,
    });
    expect(
      resolveSpawnTransitTarget(request(plain, { base: driftBase })),
    ).toEqual(marchTarget);

    // ...and tracking a moving base moves the destination by the same delta
    // (the scene's per-frame march/drift motion is followed).
    const movedBase = { x: marchBase.x + 20, y: marchBase.y + 14 };
    const moved = resolveSpawnTransitTarget(
      request(plain, { base: movedBase }),
    )!;
    expect(moved.x - marchTarget.x).toBe(20);
    expect(moved.y - marchTarget.y).toBe(14);
  });

  it('places a zero offset exactly on the base', () => {
    expect(
      resolveSpawnTransitTarget(
        request(plainEntity(), { offset: { row: 0, col: 0 } }),
      ),
    ).toEqual({ x: BASE.x, y: BASE.y });
  });

  it('never mutates the entity it reads', () => {
    const formationSlot = vi.fn(() => ({ x: 7, y: 8 }));
    const entity: SpawnTransitEntity = {
      autonomousPositioning: false,
      formationSlot,
    };
    const snapshot = { ...entity, formationSlot };

    resolveSpawnTransitTarget(request(entity));
    resolveSpawnTransitTarget(request(entity, { transit: false }));

    expect(entity).toEqual(snapshot);
    expect(Object.keys(entity).sort()).toEqual(
      Object.keys(snapshot).sort(),
    );
  });
});
