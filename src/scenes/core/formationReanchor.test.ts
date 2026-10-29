/**
 * Unit tests for the shared Diver re-anchor + glide controller
 * (D2, docs/GYM_PARITY.md).
 *
 * These pin the exact rule `PlayScene`, `GymFormationScene` and `GymLevel`
 * consume: consume pending requests (most recent wins), translate the anchor
 * so the requester's slot lands on its attack end, glide only the
 * re-anchor-capable entities, and reset cleanly.
 */

import { describe, expect, it } from 'vitest';

import type { FormationReanchorRequest } from '../../utils/formations';
import {
  FormationReanchorController,
  consumeFormationReanchor,
  type FormationReanchorCandidate,
} from './formationReanchor';

interface FakeEntity {
  x: number;
  y: number;
  setPosition(x: number, y: number): void;
  consumeFormationReanchor?(): FormationReanchorRequest | null;
}

function glideTarget(x = 0, y = 0): FakeEntity {
  return {
    x,
    y,
    setPosition(nextX: number, nextY: number) {
      this.x = nextX;
      this.y = nextY;
    },
  };
}

function diver(
  request: FormationReanchorRequest | null,
  x = 0,
  y = 0,
): FakeEntity {
  let pending = request;
  const entity = glideTarget(x, y);
  entity.consumeFormationReanchor = () => {
    const next = pending;
    pending = null;
    return next;
  };
  return entity;
}

function candidate(
  entity: FakeEntity,
  originX = 0,
  originY = 0,
  spacingX = 10,
  spacingY = 10,
): FormationReanchorCandidate {
  return {
    entity: entity as unknown as FormationReanchorCandidate['entity'],
    originX,
    originY,
    spacingX,
    spacingY,
  };
}

describe('consumeFormationReanchor', () => {
  it('returns null when no entity requests a re-anchor', () => {
    const results = consumeFormationReanchor(
      [candidate(glideTarget())],
      0,
      0,
    );
    expect(results).toBeNull();
  });

  it('lands the requesting entity’s slot on its attack end', () => {
    // Offset (1,0) at spacing (40,20) from origin (100,100) → slot (140,100).
    // The attack ends at (200,180), so the anchor must move by (+60,+80).
    const requester = diver({ offset: { row: 0, col: 1 }, x: 200, y: 180 });
    const delta = consumeFormationReanchor(
      [candidate(requester, 100, 100, 40, 20)],
      0,
      0,
    );

    expect(delta).toEqual({ dx: 60, dy: 80 });
  });

  it('includes the current anchor offset in the slot calculation', () => {
    const requester = diver({ offset: { row: 0, col: 0 }, x: 30, y: 40 });
    const delta = consumeFormationReanchor(
      [candidate(requester, 0, 0, 10, 10)],
      20,
      5,
    );

    // Slot is origin + anchor = (20,5); attack end (30,40) → (+10,+35).
    expect(delta).toEqual({ dx: 10, dy: 35 });
  });

  it('lets the most recent request win when Divers are desynchronised', () => {
    const early = diver({ offset: { row: 0, col: 0 }, x: 10, y: 10 });
    const late = diver({ offset: { row: 0, col: 1 }, x: 100, y: 100 });
    const delta = consumeFormationReanchor(
      [candidate(early, 0, 0, 10, 10), candidate(late, 0, 0, 10, 10)],
      0,
      0,
    );

    // Late requester: slot (10,0) → (100,100) = (+90,+100).
    expect(delta).toEqual({ dx: 90, dy: 100 });
  });

  it('consumes each request exactly once', () => {
    const requester = diver({ offset: { row: 0, col: 0 }, x: 5, y: 5 });
    const candidates = [candidate(requester)];

    expect(consumeFormationReanchor(candidates, 0, 0)).not.toBeNull();
    expect(consumeFormationReanchor(candidates, 0, 0)).toBeNull();
  });
});

describe('FormationReanchorController', () => {
  it('accumulates anchor deltas across separate re-anchors', () => {
    const controller = new FormationReanchorController();
    const first = diver({ offset: { row: 0, col: 0 }, x: 10, y: 0 });
    // With the anchor at 10, the slot is at (10,0); attack end (20,0)
    // adds +10 more, so the accumulated anchor is 20.
    const second = diver({ offset: { row: 0, col: 0 }, x: 20, y: 0 });

    expect(controller.apply([candidate(first)])).toBe(true);
    expect(controller.anchorX).toBe(10);
    expect(controller.apply([candidate(second)])).toBe(true);
    expect(controller.anchorX).toBe(20);
  });

  it('begins a glide for re-anchor-capable entities only', () => {
    const controller = new FormationReanchorController();
    const requester = diver({ offset: { row: 0, col: 0 }, x: 10, y: 0 });
    const otherDiver = diver(null, 20, 0);
    const scout = glideTarget(30, 0);

    expect(
      controller.apply([
        candidate(requester),
        candidate(otherDiver),
        candidate(scout),
      ]),
    ).toBe(true);

    expect(controller.isGliding).toBe(true);
    expect(controller.glideStates.size).toBe(2);
  });

  it('does nothing when no request is pending', () => {
    const controller = new FormationReanchorController();
    const scout = glideTarget();

    expect(controller.apply([candidate(scout)])).toBe(false);
    expect(controller.isGliding).toBe(false);
    expect(controller.anchorX).toBe(0);
    expect(controller.anchorY).toBe(0);
  });

  it('resets the anchor and clears an active glide', () => {
    const controller = new FormationReanchorController();
    const requester = diver({ offset: { row: 0, col: 1 }, x: 50, y: 50 });
    controller.apply([candidate(requester)]);

    expect(controller.isGliding).toBe(true);
    controller.reset();

    expect(controller.anchorX).toBe(0);
    expect(controller.anchorY).toBe(0);
    expect(controller.isGliding).toBe(false);
  });

  it('clearGlide keeps the anchor but drops the glide', () => {
    const controller = new FormationReanchorController();
    const requester = diver({ offset: { row: 0, col: 0 }, x: 25, y: 0 });
    controller.apply([candidate(requester)]);

    controller.clearGlide();

    expect(controller.anchorX).toBe(25);
    expect(controller.isGliding).toBe(false);
  });
});
