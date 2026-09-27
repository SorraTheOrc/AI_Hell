/**
 * Shared enemy-fire dispatcher — behaviour tests (AH-0MUII3BBW000XZ46).
 *
 * The dispatcher is the single archetype-key → `tryFire*` mapping used by
 * `PlayScene`, `GymEnemies` and `GymPowerUpsCombat`. Tests assert observable
 * behaviour: which entity method fires for each archetype, how single/array
 * results are normalised, and the unknown-key fallback — never a copy of the
 * production mapping table.
 */

import { afterEach, describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { DEFAULT_ENEMY_CONFIGS } from '../core/enemyConfig';
import { createEnemyFromConfig } from './enemyFactory';
import {
  DEFAULT_ENEMY_FIRE_METHOD,
  ENEMY_FIRE_METHODS,
  fireForEnemy,
} from './enemyFire';

class Harness extends Phaser.Scene {
  constructor() {
    super('Harness');
  }
}

interface FireSpy {
  calls: string[];
  tryFireAimedBullet(now: number): { tag: string };
  tryFireSpreadBurst(now: number): { tag: string }[];
  tryFireRadialBurst(now: number): { tag: string }[];
  tryFireRadialBullets(now: number): { tag: string }[];
  tryFireBurstBullet(now: number): { tag: string };
}

/** Spy entity that records which fire method ran and with which clock. */
function makeFireSpy(): FireSpy {
  return {
    calls: [],
    tryFireAimedBullet(now: number) {
      this.calls.push(`aimed:${now}`);
      return { tag: 'aimed' };
    },
    tryFireSpreadBurst(now: number) {
      this.calls.push(`spread:${now}`);
      return [{ tag: 'spread' }];
    },
    tryFireRadialBurst(now: number) {
      this.calls.push(`radialBurst:${now}`);
      return [{ tag: 'tank' }];
    },
    tryFireRadialBullets(now: number) {
      this.calls.push(`radial:${now}`);
      return [{ tag: 'phaser' }];
    },
    tryFireBurstBullet(now: number) {
      this.calls.push(`burst:${now}`);
      return { tag: 'swarm' };
    },
  };
}

describe('shared enemy-fire dispatcher — archetype mapping (AC1/AC3)', () => {
  it('dispatches each archetype to its own tryFire method, passing the clock', () => {
    const cases: Array<{ key: string; call: string; tag: string }> = [
      { key: 'scout', call: 'aimed:1234', tag: 'aimed' },
      { key: 'diver', call: 'spread:1234', tag: 'spread' },
      { key: 'tank', call: 'radialBurst:1234', tag: 'tank' },
      { key: 'phaser', call: 'radial:1234', tag: 'phaser' },
      { key: 'swarm', call: 'burst:1234', tag: 'swarm' },
    ];

    for (const { key, call, tag } of cases) {
      const entity = makeFireSpy();
      const result = fireForEnemy<{ tag: string }>(entity, key, 1234);
      // The mapped method ran exactly once, with the supplied clock ...
      expect(entity.calls, `${key} method`).toEqual([call]);
      // ... and its result is normalised to a bullet array.
      expect(result, `${key} bullets`).toHaveLength(1);
      expect(result[0].tag, `${key} tag`).toBe(tag);
    }
  });

  it('normalises both single bullets and arrays to an array', () => {
    const entity = makeFireSpy();
    // array-returning archetype
    expect(fireForEnemy(entity, 'diver', 1)).toHaveLength(1);
    // single-bullet archetype
    expect(fireForEnemy(entity, 'scout', 1)).toHaveLength(1);
  });

  it('covers every current archetype with an explicit mapping entry', () => {
    // Guards against a silently-removed mapping: every mapped key must fire
    // through the dispatcher (the map is the single seam a new archetype edits).
    for (const key of Object.keys(ENEMY_FIRE_METHODS)) {
      const entity = makeFireSpy();
      fireForEnemy(entity, key, 999);
      expect(entity.calls, `${key} must dispatch`).toHaveLength(1);
    }
    expect(Object.keys(ENEMY_FIRE_METHODS).sort()).toEqual(
      ['diver', 'phaser', 'scout', 'swarm', 'tank'],
    );
  });
});

describe('shared enemy-fire dispatcher — fallback and safety (AC3)', () => {
  it('falls back to the aimed shot for an unknown/custom key', () => {
    const entity = makeFireSpy();
    const result = fireForEnemy<{ tag: string }>(entity, 'harvester', 42);
    // The fallback resolves to the aimed-shot method ...
    expect(DEFAULT_ENEMY_FIRE_METHOD).toBe('tryFireAimedBullet');
    // ... and the spy records that the aimed method actually ran.
    expect(entity.calls).toEqual(['aimed:42']);
    expect(result).toEqual([{ tag: 'aimed' }]);
  });

  it('returns no bullets when the entity lacks the mapped fire method', () => {
    expect(fireForEnemy({}, 'diver', 10)).toEqual([]);
    expect(fireForEnemy(null, 'scout', 10)).toEqual([]);
  });

  it('leaves a silent method result as an empty array', () => {
    const entity = { tryFireAimedBullet: () => null };
    expect(fireForEnemy(entity, 'scout', 10)).toEqual([]);
  });
});

describe('shared enemy-fire dispatcher — real entity integration (AC4)', () => {
  let booted: BootedGame | null = null;
  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
  });

  it('fires a real Scout through the dispatcher, aimed at the live target', async () => {
    booted = await bootScene([Harness]);
    const scene = booted.scene;

    const scout = createEnemyFromConfig(
      scene,
      { ...DEFAULT_ENEMY_CONFIGS.scout, fireInterval: 1, shotProbability: 1 },
      100,
      100,
      { row: 0, col: 0 },
    ) as unknown as {
      shootEnabled: boolean;
      setAimTarget(x: number, y: number): void;
    };
    scout.shootEnabled = true;
    scout.setAimTarget(400, 100); // dead ahead (right)

    // First call starts the two-phase tell; the second (past the tell) fires.
    expect(fireForEnemy(scout, 'scout', 1_000)).toHaveLength(0);
    const bullets = fireForEnemy<{ vx: number; vy: number }>(scout, 'scout', 2_000);

    expect(bullets).toHaveLength(1);
    expect(bullets[0].vx).toBeGreaterThan(0);
    expect(Math.abs(bullets[0].vy)).toBeLessThan(Math.abs(bullets[0].vx));
  });
});
