/**
 * Behaviour cloning from telemetry (AH-0MUY08XXN003NV0I, AC3 — the optional
 * stretch path).
 *
 * Where {@link fitStyle} tunes the structured bot's parameters, this module
 * learns a policy directly from `(state → input)` pairs recorded in a run.
 * It is deliberately small and deterministic: each recorded tick becomes a
 * feature vector (relative geometry to the nearest collectable, hostile and
 * incoming shot, plus the player's velocity) paired with the movement action
 * the player took, and the resulting policy is a 1-nearest-neighbour lookup
 * over those pairs.
 *
 * ## Action representation
 *
 * A recording stores the ship's **scheme** input (asteroids: forward / turn)
 * plus the ship's `facing`, so the clone learns the player's *movement
 * intent* — the heading the ship was aimed at while thrusting, or its
 * momentum heading while coasting — together with the forward-thrust flag.
 * Replaying that intent through the shipped human-like governor reproduces a
 * turn-then-thrust action on the same ship physics, so the clone is evaluated
 * head-to-head with the structured bot on the same seeds.
 *
 * > **Limitation.** This is a coarse clone: it does not model enemies'
 * > behaviours, holds no memory, and cannot exceed the coverage of the states
 * > it was trained on. Full-fidelity cloning is out of scope for the epic;
 * > this exists to satisfy the stretch path and to give the structured bot a
 * > same-seed baseline.
 *
 * @module src/ai/style/imitation
 */

import type { BotSnapshot } from '../botSnapshot';
import type { BotSteeringIntent } from '../botDecision';
import type { BotPolicy } from '../framework/botBrain';
import type { RecordingRun } from '../../../scripts/recording.mjs';

/** Version of the imitation dataset shape (bump on a breaking change). */
export const IMITATION_DATASET_VERSION = 1;

/** Reference distance (px) used to normalise relative feature vectors. */
export const IMITATION_FEATURE_SCALE_PX = 400;

/** The fixed length of a feature vector (8 relative + 2 velocity + 1 threat). */
export const IMITATION_FEATURE_COUNT = 11;

/** A structural view of an observation shared by the snapshot and a tick. */
interface Observation {
  readonly player: {
    readonly x: number;
    readonly y: number;
    readonly vx: number;
    readonly vy: number;
    readonly facing?: number;
  } | null;
  readonly enemies: readonly { readonly x: number; readonly y: number; readonly alive?: boolean }[];
  readonly enemyBullets: readonly { readonly x: number; readonly y: number }[];
  readonly minerals: readonly { readonly x: number; readonly y: number }[];
  readonly drops: readonly { readonly x: number; readonly y: number }[];
}

/** One learned `(features → action)` pair. */
export interface ImitationSample {
  /** The normalised observation features. */
  readonly features: readonly number[];
  /** Unit x of the recorded movement heading. */
  readonly headingX: number;
  /** Unit y of the recorded movement heading. */
  readonly headingY: number;
  /** Whether the player was thrusting. */
  readonly thrust: boolean;
}

/** A trained nearest-neighbour imitation dataset. */
export interface ImitationDataset {
  readonly version: number;
  /** The seed the recording was made on (informational). */
  readonly seed: number;
  /** The feature vector length (always {@link IMITATION_FEATURE_COUNT}). */
  readonly featureCount: number;
  /** The learned pairs, in recording order (order is the deterministic tie-break). */
  readonly samples: readonly ImitationSample[];
}

/** Options for {@link trainImitationPolicy}. */
export interface ImitationTrainingOptions {
  /** Skip samples whose action heading is undefined (default `false`). */
  readonly requireHeading?: boolean;
}

/** Clamps a value into `[-limit, limit]`. */
function clampSymmetric(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < -limit ? -limit : value > limit ? limit : value;
}

/** The nearest of `points` to `player`, or `null`. */
function nearest(
  points: readonly { readonly x: number; readonly y: number }[],
  player: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestDistance = Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    const d = Math.hypot(point.x - player.x, point.y - player.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = point;
    }
  }
  return best;
}

/** Appends a normalised relative vector from `player` to `target`. */
function pushRelative(
  out: number[],
  target: { readonly x: number; readonly y: number } | null,
  player: { readonly x: number; readonly y: number },
): void {
  if (!target) {
    out.push(0, 0);
    return;
  }
  out.push(
    clampSymmetric((target.x - player.x) / IMITATION_FEATURE_SCALE_PX, 2),
    clampSymmetric((target.y - player.y) / IMITATION_FEATURE_SCALE_PX, 2),
  );
}

/**
 * Builds the fixed-length feature vector for an observation. Used identically
 * for training (from a recorded tick's state) and inference (from a snapshot),
 * so the learned pairs and the live states share one coordinate system.
 */
export function observationFeatures(observation: Observation): number[] {
  const player = observation.player;
  const features: number[] = [];
  if (!player) {
    return new Array<number>(IMITATION_FEATURE_COUNT).fill(0);
  }

  const enemies = observation.enemies.filter((enemy) => enemy.alive !== false);
  pushRelative(features, nearest(observation.minerals, player), player);
  pushRelative(features, nearest(observation.drops, player), player);
  pushRelative(features, nearest(enemies, player), player);
  pushRelative(features, nearest(observation.enemyBullets, player), player);

  const maxSpeed = 175;
  features.push(clampSymmetric(player.vx / maxSpeed, 2));
  features.push(clampSymmetric(player.vy / maxSpeed, 2));

  const threatRadius = 55;
  const threats = observation.enemyBullets.filter(
    (bullet) =>
      Number.isFinite(bullet.x) &&
      Number.isFinite(bullet.y) &&
      Math.hypot(bullet.x - player.x, bullet.y - player.y) <= threatRadius,
  ).length;
  features.push(clampSymmetric(threats / 5, 1));

  return features;
}

/** Reads a finite number from an unknown record field, or `undefined`. */
function num(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Extracts a structural observation from an opaque recorded state. */
function observationFromState(state: unknown): Observation | null {
  if (typeof state !== 'object' || state === null) return null;
  const record = state as Record<string, unknown>;
  const playerRecord = record.player;
  if (typeof playerRecord !== 'object' || playerRecord === null) return null;
  const p = playerRecord as Record<string, unknown>;
  const x = num(p.x);
  const y = num(p.y);
  if (x === undefined || y === undefined) return null;
  return {
    player: {
      x,
      y,
      vx: num(p.vx) ?? 0,
      vy: num(p.vy) ?? 0,
      facing: num(p.facing),
    },
    enemies: Array.isArray(record.enemies) ? (record.enemies as Observation['enemies']) : [],
    enemyBullets: Array.isArray(record.enemyBullets)
      ? (record.enemyBullets as Observation['enemyBullets'])
      : [],
    minerals: Array.isArray(record.minerals)
      ? (record.minerals as Observation['minerals'])
      : [],
    drops: Array.isArray(record.drops) ? (record.drops as Observation['drops']) : [],
  };
}

/** A structural view of a snapshot as an observation (drop/enemy tolerant). */
function observationFromSnapshot(snapshot: BotSnapshot): Observation {
  return {
    player: snapshot.player,
    enemies: snapshot.enemies,
    enemyBullets: snapshot.enemyBullets,
    minerals: snapshot.minerals,
    drops: snapshot.drops,
  };
}

/**
 * Trains a nearest-neighbour imitation dataset from a recorded run (AC3).
 * Pure and deterministic: the same recording always yields the same dataset.
 */
export function trainImitationPolicy(
  run: RecordingRun,
  options: ImitationTrainingOptions = {},
): ImitationDataset {
  const samples: ImitationSample[] = [];
  for (const tick of run.ticks ?? []) {
    const observation = observationFromState(tick.state);
    if (!observation || !observation.player) continue;
    const input = tick.input as { forward?: unknown } | null | undefined;
    const thrust = input?.forward === true;

    let headingX: number;
    let headingY: number;
    if (thrust && Number.isFinite(observation.player.facing)) {
      headingX = Math.cos(observation.player.facing as number);
      headingY = Math.sin(observation.player.facing as number);
    } else {
      const speed = Math.hypot(observation.player.vx, observation.player.vy);
      if (speed > 1e-6) {
        headingX = observation.player.vx / speed;
        headingY = observation.player.vy / speed;
      } else if (Number.isFinite(observation.player.facing)) {
        headingX = Math.cos(observation.player.facing as number);
        headingY = Math.sin(observation.player.facing as number);
      } else if (options.requireHeading) {
        continue;
      } else {
        headingX = 0;
        headingY = 0;
      }
    }

    samples.push({
      features: observationFeatures(observation),
      headingX,
      headingY,
      thrust,
    });
  }
  return {
    version: IMITATION_DATASET_VERSION,
    seed: Number(run.runSeed) >>> 0,
    featureCount: IMITATION_FEATURE_COUNT,
    samples,
  };
}

/** Squared Euclidean distance between two equal-length vectors. */
function squaredDistance(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    total += delta * delta;
  }
  return total;
}

/** The index of the nearest sample (lowest index wins ties), or `-1`. */
function nearestSampleIndex(
  dataset: ImitationDataset,
  features: readonly number[],
): number {
  let best = -1;
  let bestDistance = Infinity;
  for (let i = 0; i < dataset.samples.length; i += 1) {
    const distance = squaredDistance(features, dataset.samples[i].features);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/**
 * Builds a deterministic {@link BotPolicy} that clones the recorded actions
 * (AC3). Each `decide` finds the recorded state nearest the live snapshot and
 * replays its movement intent.
 */
export function createImitationPolicy(dataset: ImitationDataset): BotPolicy {
  return {
    decide(snapshot: BotSnapshot): BotSteeringIntent {
      const index = nearestSampleIndex(dataset, observationFeatures(observationFromSnapshot(snapshot)));
      if (index < 0) {
        return {
          up: false, down: false, left: false, right: false,
          dirX: 0, dirY: 0, thrust: false, longTravel: false,
        };
      }
      const sample = dataset.samples[index];
      const epsilon = 1e-6;
      return {
        up: sample.headingY < -epsilon,
        down: sample.headingY > epsilon,
        left: sample.headingX < -epsilon,
        right: sample.headingX > epsilon,
        dirX: sample.headingX,
        dirY: sample.headingY,
        thrust: sample.thrust,
        longTravel: false,
      };
    },
  };
}
