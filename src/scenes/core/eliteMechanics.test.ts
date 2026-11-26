/**
 * Unit tests for the shared elite (anomaly) mechanics
 * (AH-0MWU665XK000ZT4S; folded test child AH-0MWU65WM9007W19X).
 *
 * Pins the three bounded behaviours at their shared decision points — the one
 * place the game and every gym consume — and the neutral-default regression: a
 * blank `eliteBehaviour` yields zero extra children, zero extra field hits,
 * the archetype's own health and zero death burst.
 *
 * The end-to-end seam walk (children spawned and wave-counted, burst bullets
 * through the scene's enemy-bullet list, reinforced bubble) lives in
 * `src/scenes/PlayScene.elite.test.ts`; the repo-wide duplicate-body guard is
 * updated in `CombatScene.equivalence.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { enemyForceFieldHits } from '../../core/enemyForceField';
import {
  ELITE_BEHAVIOURS,
  type EliteBehaviour,
} from '../../core/eliteVocabulary';
import {
  ELITE_MECHANIC_SET,
  ELITE_REINFORCED_FIELD_BONUS,
  ELITE_SPLITTER_CHILD_COUNT,
  ELITE_SPLITTER_CHILD_OFFSET_PX,
  ELITE_VOLATILE_BURST_COUNT,
  ELITE_VOLATILE_BURST_LIFETIME,
  ELITE_VOLATILE_BURST_SPEED,
  applyEliteDeathBehaviour,
  eliteBonusHealth,
  eliteForceFieldHits,
  eliteMechanicsFor,
  eliteSplitChildCount,
  eliteSplitChildOffset,
  eliteVolatileBurstShots,
  type EliteDeathHost,
} from './eliteMechanics';

/** A force-field curve that is shielded from level 2 and grows to 4 hits. */
const CURVE = {
  forceFieldStartLevel: 2,
  forceFieldStartHits: 1,
  forceFieldMaxHits: 4,
} as const;

/** A recorded host that logs every spawn the dispatcher asks for. */
function recordingHost(): {
  host: EliteDeathHost;
  children: ReturnType<typeof eliteSplitChildOffset>[];
  bullets: { index: number; vx: number; vy: number }[];
} {
  const children: ReturnType<typeof eliteSplitChildOffset>[] = [];
  const bullets: { index: number; vx: number; vy: number }[] = [];
  return {
    children,
    bullets,
    host: {
      spawnSplitChild: (offset) => children.push(offset),
      spawnVolatileBullet: (shot) =>
        bullets.push({ index: shot.index, vx: shot.vx, vy: shot.vy }),
    },
  };
}

describe('eliteMechanics — bounded vocabulary', () => {
  it('publishes exactly the validated elite vocabulary, frozen', () => {
    expect(ELITE_MECHANIC_SET).toEqual(ELITE_BEHAVIOURS);
    expect(Object.isFrozen(ELITE_MECHANIC_SET)).toBe(true);
  });

  it.each<EliteBehaviour>(['splitter', 'reinforced', 'volatile'])(
    'publishes one descriptor per behaviour: %s',
    (behaviour) => {
      const mechanics = eliteMechanicsFor(behaviour);
      expect(mechanics).toHaveLength(1);
      expect(mechanics[0].id).toBe(behaviour);
      expect(mechanics[0].summary.length).toBeGreaterThan(0);
      expect(mechanics[0].magnitude).toBeGreaterThan(0);
    },
  );

  it('NEUTRAL DEFAULT — a blank/absent behaviour publishes no mechanic', () => {
    expect(eliteMechanicsFor(undefined)).toEqual([]);
    expect(eliteMechanicsFor(null)).toEqual([]);
  });
});

describe('eliteMechanics — splitter children', () => {
  it('decides exactly two children for a splitter, none otherwise', () => {
    expect(ELITE_SPLITTER_CHILD_COUNT).toBe(2);
    expect(eliteSplitChildCount('splitter')).toBe(ELITE_SPLITTER_CHILD_COUNT);
    expect(eliteSplitChildCount('reinforced')).toBe(0);
    expect(eliteSplitChildCount('volatile')).toBe(0);
    expect(eliteSplitChildCount(undefined)).toBe(0);
  });

  it('places the children in a deterministic mirrored fan around the wreck', () => {
    expect(eliteSplitChildOffset(0)).toEqual({
      x: -ELITE_SPLITTER_CHILD_OFFSET_PX,
      y: 0,
    });
    expect(eliteSplitChildOffset(1)).toEqual({
      x: ELITE_SPLITTER_CHILD_OFFSET_PX,
      y: 0,
    });
    // Deterministic (same input, same result) and total for junk input.
    expect(eliteSplitChildOffset(0)).toEqual(eliteSplitChildOffset(0));
    expect(eliteSplitChildOffset(Number.NaN)).toEqual(
      eliteSplitChildOffset(0),
    );
  });
});

describe('eliteMechanics — reinforced force field', () => {
  const LEVELS = [1, 2, 3, 5, 10];

  it('adds exactly one hit on top of the shipped enemyForceFieldHits curve', () => {
    for (const level of LEVELS) {
      const base = enemyForceFieldHits(level, CURVE);
      expect(eliteForceFieldHits('reinforced', level, CURVE)).toBe(
        base + ELITE_REINFORCED_FIELD_BONUS,
      );
    }
  });

  it('NEUTRAL DEFAULT — every other behaviour resolves the identical curve', () => {
    for (const level of LEVELS) {
      const base = enemyForceFieldHits(level, CURVE);
      expect(eliteForceFieldHits(undefined, level, CURVE)).toBe(base);
      expect(eliteForceFieldHits(null, level, CURVE)).toBe(base);
      expect(eliteForceFieldHits('splitter', level, CURVE)).toBe(base);
      expect(eliteForceFieldHits('volatile', level, CURVE)).toBe(base);
    }
  });
});

describe('eliteMechanics — authored bonus hit points', () => {
  it('adds the authored bonus to the archetype health', () => {
    expect(eliteBonusHealth(1, 1)).toBe(2);
    expect(eliteBonusHealth(3, 3)).toBe(6);
  });

  it('NEUTRAL DEFAULT — a blank bonus leaves the archetype health untouched', () => {
    expect(eliteBonusHealth(1, undefined)).toBe(1);
    expect(eliteBonusHealth(2, null)).toBe(2);
    expect(eliteBonusHealth(2, Number.NaN)).toBe(2);
  });

  it('keeps the application bounded even for an out-of-range value', () => {
    // Load-time validation owns rejection; the spawn application never
    // fabricates an unbounded pool from a value that reached it another way.
    expect(eliteBonusHealth(1, 99)).toBe(4);
    expect(eliteBonusHealth(1, 0)).toBe(2);
  });
});

describe('eliteMechanics — volatile death burst', () => {
  it('publishes a short, bounded, radial fan of shots', () => {
    const shots = eliteVolatileBurstShots('volatile');
    expect(shots).toHaveLength(ELITE_VOLATILE_BURST_COUNT);
    expect(ELITE_VOLATILE_BURST_LIFETIME).toBeLessThan(1.5);

    // Every shot flies at the same speed, in a distinct direction.
    const angles = new Set<number>();
    for (const shot of shots) {
      expect(Math.hypot(shot.vx, shot.vy)).toBeCloseTo(
        ELITE_VOLATILE_BURST_SPEED,
        6,
      );
      const angle = Math.atan2(shot.vy, shot.vx);
      angles.add(angle);
    }
    expect(angles.size).toBe(ELITE_VOLATILE_BURST_COUNT);
  });

  it('NEUTRAL DEFAULT — no other behaviour fires a death burst', () => {
    expect(eliteVolatileBurstShots(undefined)).toEqual([]);
    expect(eliteVolatileBurstShots('splitter')).toEqual([]);
    expect(eliteVolatileBurstShots('reinforced')).toEqual([]);
  });
});

describe('eliteMechanics — per-death dispatch', () => {
  it('asks the host for two splitter children and nothing else', () => {
    const { host, children, bullets } = recordingHost();
    const outcome = applyEliteDeathBehaviour('splitter', host);
    expect(outcome).toEqual({ children: ELITE_SPLITTER_CHILD_COUNT, bullets: 0 });
    expect(children).toEqual([
      { x: -ELITE_SPLITTER_CHILD_OFFSET_PX, y: 0 },
      { x: ELITE_SPLITTER_CHILD_OFFSET_PX, y: 0 },
    ]);
    expect(bullets).toEqual([]);
  });

  it('asks the host for the full volatile fan and no children', () => {
    const { host, children, bullets } = recordingHost();
    const outcome = applyEliteDeathBehaviour('volatile', host);
    expect(outcome).toEqual({ children: 0, bullets: ELITE_VOLATILE_BURST_COUNT });
    expect(children).toEqual([]);
    expect(bullets.map((shot) => shot.index)).toEqual(
      Array.from({ length: ELITE_VOLATILE_BURST_COUNT }, (_, i) => i),
    );
  });

  it('reinforced does nothing on death (its effect is applied at spawn)', () => {
    const { host, children, bullets } = recordingHost();
    expect(applyEliteDeathBehaviour('reinforced', host)).toEqual({
      children: 0,
      bullets: 0,
    });
    expect(children).toEqual([]);
    expect(bullets).toEqual([]);
  });

  it('NEUTRAL DEFAULT — a blank behaviour spawns nothing at all', () => {
    const { host } = recordingHost();
    const spawnChild = vi.spyOn(host, 'spawnSplitChild');
    const spawnBullet = vi.spyOn(host, 'spawnVolatileBullet');
    expect(applyEliteDeathBehaviour(undefined, host)).toEqual({
      children: 0,
      bullets: 0,
    });
    expect(applyEliteDeathBehaviour(null, host)).toEqual({
      children: 0,
      bullets: 0,
    });
    expect(spawnChild).not.toHaveBeenCalled();
    expect(spawnBullet).not.toHaveBeenCalled();
  });
});
