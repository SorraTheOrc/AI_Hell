/**
 * Tests for behaviour cloning (AH-0MUY08XXN003NV0I, AC3 — the stretch path).
 *
 * The imitation policy is deliberately small: it turns each recorded tick into
 * a fixed-length observation feature vector and replays the nearest recorded
 * action. These pure tests pin the feature-vector contract, the training
 * determinism, and the nearest-neighbour replay.
 */

import { describe, expect, it } from 'vitest';

import type { BotSnapshot } from '../botSnapshot';
import {
  IMITATION_DATASET_VERSION,
  IMITATION_FEATURE_COUNT,
  createImitationPolicy,
  observationFeatures,
  trainImitationPolicy,
} from './imitation';
import { makeRun, makeTick, point } from './testFixtures';

/** Builds a minimal bot snapshot for policy inference. */
function snapshot(overrides: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    player: { x: 0, y: 0, vx: 0, vy: 0 },
    enemies: [],
    enemyBullets: [],
    playerBullets: [],
    drops: [],
    minerals: [],
    boss: null,
    aliveCount: 0,
    wave: null,
    runSeed: 5,
    ...overrides,
  };
}

describe('observationFeatures', () => {
  it('always returns a fixed-length vector', () => {
    expect(observationFeatures({ player: null, enemies: [], enemyBullets: [], minerals: [], drops: [] })).toHaveLength(
      IMITATION_FEATURE_COUNT,
    );
    const player = { x: 10, y: 20, vx: 1, vy: 0 };
    expect(
      observationFeatures({
        player,
        enemies: [],
        enemyBullets: [],
        minerals: [point(30, 20)],
        drops: [],
      }),
    ).toHaveLength(IMITATION_FEATURE_COUNT);
  });

  it('returns a zero vector when there is no player', () => {
    const vector = observationFeatures({
      player: null,
      enemies: [],
      enemyBullets: [],
      minerals: [point(100, 0)],
      drops: [],
    });
    expect(vector.every((value) => value === 0)).toBe(true);
  });

  it('encodes the nearest collectable, hostile and threat as relative offsets', () => {
    const player = { x: 0, y: 0, vx: 0, vy: 0 };
    const vector = observationFeatures({
      player,
      enemies: [{ x: 100, y: 0, alive: true }],
      enemyBullets: [point(10, 0), point(300, 0)],
      minerals: [point(40, 0)],
      drops: [point(20, 0)],
    });
    // Feature scale is 400 px, so x/400 for each of the four relative pairs.
    expect(vector[0]).toBeCloseTo(40 / 400, 6); // nearest mineral
    expect(vector[1]).toBeCloseTo(0, 6);
    expect(vector[2]).toBeCloseTo(20 / 400, 6); // nearest drop
    expect(vector[4]).toBeCloseTo(100 / 400, 6); // nearest enemy
    expect(vector[6]).toBeCloseTo(10 / 400, 6); // nearest incoming shot
  });

  it('ignores dead enemies when picking the nearest hostile', () => {
    const player = { x: 0, y: 0, vx: 0, vy: 0 };
    const vector = observationFeatures({
      player,
      enemies: [
        { x: 50, y: 0, alive: false },
        { x: 100, y: 0, alive: true },
      ],
      enemyBullets: [],
      minerals: [],
      drops: [],
    });
    expect(vector[4]).toBeCloseTo(100 / 400, 6);
  });
});

describe('trainImitationPolicy', () => {
  it('learns one sample per recorded player tick', () => {
    const run = makeRun([
      makeTick(0, { forward: true }, { player: { x: 0, y: 0, vx: 0, vy: 0, facing: 0 } }),
      makeTick(1, { forward: true }, { player: { x: 1, y: 0, vx: 0, vy: 0, facing: 0 } }),
    ]);
    const dataset = trainImitationPolicy(run);
    expect(dataset.version).toBe(IMITATION_DATASET_VERSION);
    expect(dataset.seed).toBe(5);
    expect(dataset.featureCount).toBe(IMITATION_FEATURE_COUNT);
    expect(dataset.samples).toHaveLength(2);
    expect(dataset.samples[0].features).toHaveLength(IMITATION_FEATURE_COUNT);
  });

  it('derives the heading from facing while thrusting', () => {
    const run = makeRun([
      makeTick(0, { forward: true }, { player: { x: 0, y: 0, vx: 0, vy: 0, facing: Math.PI / 2 } }),
    ]);
    const sample = trainImitationPolicy(run).samples[0];
    expect(sample.thrust).toBe(true);
    expect(sample.headingX).toBeCloseTo(0, 6);
    expect(sample.headingY).toBeCloseTo(1, 6);
  });

  it('uses the coasting direction when not thrusting', () => {
    const run = makeRun([
      makeTick(0, { forward: false }, { player: { x: 0, y: 0, vx: 3, vy: 4, facing: 0 } }),
    ]);
    const sample = trainImitationPolicy(run).samples[0];
    expect(sample.thrust).toBe(false);
    expect(sample.headingX).toBeCloseTo(0.6, 6);
    expect(sample.headingY).toBeCloseTo(0.8, 6);
  });

  it('is deterministic for the same recording', () => {
    const run = makeRun([
      makeTick(0, { forward: true }, { player: { x: 0, y: 0, vx: 1, vy: 0, facing: 0.5 } }),
      makeTick(1, { forward: false }, { player: { x: 2, y: 0, vx: 0.5, vy: 0, facing: 0.5 } }),
    ]);
    expect(trainImitationPolicy(run)).toEqual(trainImitationPolicy(run));
  });
});

describe('createImitationPolicy', () => {
  it('replays the nearest recorded action', () => {
    const mineral = [{ x: 100, y: 0, type: 'mineral' }];
    const run = makeRun([
      makeTick(0, { forward: true }, { player: { x: 0, y: 0, vx: 0, vy: 0, facing: 0 }, minerals: [point(100, 0)] }),
      makeTick(1, { forward: true }, { player: { x: 200, y: 0, vx: 0, vy: 0, facing: Math.PI }, minerals: [point(100, 0)] }),
    ]);
    const policy = createImitationPolicy(trainImitationPolicy(run));

    const nearStart = policy.decide(
      snapshot({ player: { x: 1, y: 0, vx: 0, vy: 0 }, minerals: mineral }),
      1 / 60,
    );
    expect(nearStart.thrust).toBe(true);
    expect(nearStart.dirX).toBeCloseTo(1, 6);

    const nearEnd = policy.decide(
      snapshot({ player: { x: 199, y: 0, vx: 0, vy: 0 }, minerals: mineral }),
      1 / 60,
    );
    expect(nearEnd.thrust).toBe(true);
    expect(nearEnd.dirX).toBeCloseTo(-1, 6);
  });

  it('falls back to idle when the dataset is empty', () => {
    const policy = createImitationPolicy(trainImitationPolicy(makeRun([])));
    const action = policy.decide(snapshot(), 1 / 60);
    expect(action.thrust).toBe(false);
    expect(action.dirX).toBe(0);
    expect(action.dirY).toBe(0);
  });
});
