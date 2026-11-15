/**
 * Parity property test for the derived/cached steering geometry
 * (AH-0MWGUN4P2003003P, child of AH-0MW2DC28M00161W6 · AC1).
 *
 * The optimisation precomputes, once per decision tick, the geometry that the
 * 17-bearing steering fan used to re-derive for every bearing: each hazard's
 * and each incoming shot's wrapped delta from the player and its distance. The
 * only acceptable outcome is **bit-identical** `DirectionSafety` (the `safe`
 * flag and the `clearance`) against the pre-change raw path, for every fan
 * bearing, with hazard prediction on and off.
 *
 * To make that a real property rather than a tautology, this suite carries an
 * independent **raw reference** (`rawEvaluateDirection`) — a faithful copy of
 * the pre-change per-bearing loop — and compares the production cached path
 * against it on a battery of late-game-shaped worlds (hundreds of hazards with
 * velocity estimates, live enemy fire, wrap seams), sampled by the real 17-way
 * fan.
 *
 * @module src/ai/framework/competent/steeringParity.test
 */

import { describe, expect, it } from 'vitest';

import { createSeededRng } from '../../../core/rng';
import { wrappedAxisDelta, type WrapWorld } from '../../../utils/wrapGeometry';
import { buildBotWorld } from '../worldModel';
import type { BotWorld } from '../worldModel';
import { enemy, makeSnapshot, bullet } from '../testFixtures';
import type { BotSnapshot } from '../../botSnapshot';
import {
  buildSteeringDerived,
  chooseSteeringDirection,
  evaluateDirection,
  type HazardExemption,
} from './steering';
import {
  COMPETENT_BOT_TUNABLES,
  resolveCompetentTunables,
  type CompetentBotTunables,
} from './tunables';

const T = COMPETENT_BOT_TUNABLES;
const EPS = 1e-6;

/** Pre-change closest-approach solve (a copy of the original private helper). */
function rawClosestApproach(
  px: number,
  py: number,
  pvx: number,
  pvy: number,
  qx: number,
  qy: number,
  qvx: number,
  qvy: number,
  horizon: number,
  world?: WrapWorld,
): { t: number; distance: number } {
  const rx = world ? wrappedAxisDelta(px, qx, world.width) : qx - px;
  const ry = world ? wrappedAxisDelta(py, qy, world.height) : qy - py;
  const rvx = qvx - pvx;
  const rvy = qvy - pvy;
  const denom = rvx * rvx + rvy * rvy;
  let t = 0;
  if (denom > EPS) {
    t = -(rx * rvx + ry * rvy) / denom;
    if (t < 0) t = 0;
    if (t > horizon) t = horizon;
  }
  const cx = rx + rvx * t;
  const cy = ry + rvy * t;
  return { t, distance: Math.hypot(cx, cy) };
}

function isExempt(
  hazard: { x: number; y: number; id?: number },
  exemptions?: readonly HazardExemption[],
): boolean {
  if (!exemptions || exemptions.length === 0) return false;
  return exemptions.some((exempt) =>
    hazard.id !== undefined && exempt.id !== undefined
      ? hazard.id === exempt.id
      : exempt.x === hazard.x && exempt.y === hazard.y,
  );
}

/**
 * The **raw** (pre-change) evaluator: identical arithmetic to the original
 * `evaluateDirection`, computing each entity's wrapped delta per bearing.
 */
function rawEvaluateDirection(
  dirX: number,
  dirY: number,
  world: BotWorld,
  t: CompetentBotTunables,
  exemptHazards?: readonly HazardExemption[],
): { safe: boolean; clearance: number } {
  const player = world.player;
  if (!player) return { safe: false, clearance: 0 };
  const px = player.x;
  const py = player.y;
  const speed =
    t.playerSpeed !== COMPETENT_BOT_TUNABLES.playerSpeed
      ? t.playerSpeed
      : player.thruster?.maxSpeed ?? t.playerSpeed;
  const pvx = dirX * speed;
  const pvy = dirY * speed;
  let clearance = t.clearanceCap;
  let safe = true;
  const torus: WrapWorld = { width: t.playfieldWidth, height: t.playfieldHeight };

  let wall = Number.POSITIVE_INFINITY;
  if (dirX < -EPS) wall = Math.min(wall, px / -dirX);
  if (dirX > EPS) wall = Math.min(wall, (t.playfieldWidth - px) / dirX);
  if (dirY < -EPS) wall = Math.min(wall, py / -dirY);
  if (dirY > EPS) wall = Math.min(wall, (t.playfieldHeight - py) / dirY);
  if (wall < clearance) clearance = wall;

  for (const hazard of world.hazards) {
    const hdx = wrappedAxisDelta(px, hazard.x, torus.width);
    const hdy = wrappedAxisDelta(py, hazard.y, torus.height);
    const d = Math.hypot(hdx, hdy);
    if (d < clearance) clearance = d;
    if (d < t.dangerMargin && hdx * dirX + hdy * dirY > 0) safe = false;
    const hvx = hazard.vx ?? 0;
    const hvy = hazard.vy ?? 0;
    if (
      t.hazardPredictionEnabled &&
      (hvx !== 0 || hvy !== 0) &&
      !isExempt(hazard, exemptHazards)
    ) {
      const ca = rawClosestApproach(
        px,
        py,
        pvx,
        pvy,
        hazard.x,
        hazard.y,
        hvx,
        hvy,
        t.hazardPredictionHorizon,
        torus,
      );
      if (ca.distance < clearance) clearance = ca.distance;
      if (ca.t > EPS && ca.distance < t.threatRadius) safe = false;
    }
  }

  for (const shot of world.incomingFire) {
    const sdx = wrappedAxisDelta(px, shot.source.x, torus.width);
    const sdy = wrappedAxisDelta(py, shot.source.y, torus.height);
    const d = Math.hypot(sdx, sdy);
    if (d < clearance) clearance = d;
    if (d < t.threatRadius && sdx * dirX + sdy * dirY > 0) safe = false;
    const ca = rawClosestApproach(
      px,
      py,
      pvx,
      pvy,
      shot.source.x,
      shot.source.y,
      shot.velocity.x,
      shot.velocity.y,
      t.firePredictionHorizon,
      torus,
    );
    if (ca.distance < clearance) clearance = ca.distance;
    if (ca.t > EPS && ca.distance < t.threatRadius) safe = false;
  }

  return {
    safe,
    clearance: Number.isFinite(clearance) ? clearance : t.clearanceCap,
  };
}

/** The raw fan reference: evaluate every bearing with the raw path. */
function rawFan(
  objective: { x: number; y: number } | null,
  world: BotWorld,
  t: CompetentBotTunables,
  exemptHazards?: readonly HazardExemption[],
): { x: number; y: number } {
  const player = world.player;
  if (!player) return { x: 0, y: 0 };
  const norm = (x: number, y: number) => {
    const len = Math.hypot(x, y);
    return !Number.isFinite(len) || len < EPS ? { x: 0, y: 0 } : { x: x / len, y: y / len };
  };
  const objectiveUnit = objective ? norm(objective.x, objective.y) : null;
  const baseAngle = objectiveUnit ? Math.atan2(objectiveUnit.y, objectiveUnit.x) : 0;
  let bestSafe: { dir: { x: number; y: number }; score: number } | null = null;
  let bestLeastBad: { dir: { x: number; y: number }; clearance: number; progress: number } | null =
    null;
  for (const offsetDeg of t.fanDegrees) {
    const angle = baseAngle + (offsetDeg * Math.PI) / 180;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const evaluation = rawEvaluateDirection(dir.x, dir.y, world, t, exemptHazards);
    const progress = objectiveUnit ? dir.x * objectiveUnit.x + dir.y * objectiveUnit.y : 0;
    if (evaluation.safe) {
      const clearanceScore = Math.min(evaluation.clearance, t.clearanceCap) / t.clearanceCap;
      const score = t.progressWeight * progress + t.clearanceWeight * clearanceScore;
      if (!bestSafe || score > bestSafe.score + EPS) bestSafe = { dir, score };
    } else if (
      !bestLeastBad ||
      evaluation.clearance > bestLeastBad.clearance + EPS ||
      (Math.abs(evaluation.clearance - bestLeastBad.clearance) <= EPS &&
        progress > bestLeastBad.progress + EPS)
    ) {
      bestLeastBad = { dir, clearance: evaluation.clearance, progress };
    }
  }
  if (bestSafe) return bestSafe.dir;
  if (bestLeastBad) return bestLeastBad.dir;
  return objectiveUnit ?? { x: 0, y: 0 };
}

/**
 * Builds a deterministic late-game-style snapshot: hundreds of hazards with
 * velocity estimates, live enemy fire, mixed with stationary hazards, and
 * hazards deliberately placed on a wrap seam.
 */
function seededSnapshot(seed: number): BotSnapshot {
  const rng = createSeededRng(seed);
  const WIDTH = 960;
  const HEIGHT = 540;
  const archetypes = ['scout', 'diver', 'tank', 'phaser', 'asteroid'];
  const enemies = Array.from({ length: 260 }, (_, id) => {
    const moving = rng() < 0.7;
    const base = enemy(rng() * WIDTH, rng() * HEIGHT, archetypes[Math.floor(rng() * archetypes.length)]);
    return {
      ...base,
      id,
      ...(moving
        ? { vx: (rng() - 0.5) * 300, vy: (rng() - 0.5) * 300 }
        : {}),
    };
  });
  // A hazard hugging each seam, to exercise the wrapped-delta path.
  enemies.push({ ...enemy(0.5, 270, 'scout'), id: 900, vx: 120, vy: 0 });
  enemies.push({ ...enemy(959.5, 270, 'scout'), id: 901, vx: -120, vy: 0 });
  enemies.push({ ...enemy(480, 0.5, 'scout'), id: 902, vx: 0, vy: 90 });
  const enemyBullets = Array.from({ length: 45 }, () =>
    bullet(rng() * WIDTH, rng() * HEIGHT, (rng() - 0.5) * 400, (rng() - 0.5) * 400),
  );
  return makeSnapshot({
    player: { x: 480, y: 270, vx: 12, vy: -8 },
    enemies,
    enemyBullets,
    runSeed: seed,
  });
}

/** A battery of seeds — several distinct late-game worlds. */
const SEEDS = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66];

describe('derived steering geometry parity (AH-0MWGUN4P2003003P · AC1)', () => {
  for (const seed of SEEDS) {
    it(`is bit-identical for every fan bearing on seeded world 0x${seed.toString(16)} (prediction on)`, () => {
      const snapshot = seededSnapshot(seed);
      const world = buildBotWorld(snapshot);
      const derived = buildSteeringDerived(world, T);
      for (const offsetDeg of T.fanDegrees) {
        const angle = (offsetDeg * Math.PI) / 180;
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const cached = evaluateDirection(dirX, dirY, world, T, undefined, derived);
        const raw = rawEvaluateDirection(dirX, dirY, world, T);
        expect(cached).toEqual(raw);
      }
    });

    it(`is bit-identical for every fan bearing on seeded world 0x${seed.toString(16)} (prediction off)`, () => {
      const snapshot = seededSnapshot(seed);
      const world = buildBotWorld(snapshot);
      const tOff = resolveCompetentTunables({ hazardPredictionEnabled: false });
      const derived = buildSteeringDerived(world, tOff);
      for (const offsetDeg of T.fanDegrees) {
        const angle = (offsetDeg * Math.PI) / 180;
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        const cached = evaluateDirection(dirX, dirY, world, tOff, undefined, derived);
        const raw = rawEvaluateDirection(dirX, dirY, world, tOff);
        expect(cached).toEqual(raw);
      }
    });
  }

  it('is bit-identical with predictive exemptions applied', () => {
    const snapshot = seededSnapshot(0x11);
    const world = buildBotWorld(snapshot);
    const derived = buildSteeringDerived(world, T);
    const exemptions: HazardExemption[] = world.hazards
      .slice(0, 12)
      .map((hazard) => ({ x: hazard.x, y: hazard.y, id: hazard.id }));
    for (const offsetDeg of T.fanDegrees) {
      const angle = (offsetDeg * Math.PI) / 180;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      expect(evaluateDirection(dirX, dirY, world, T, exemptions, derived)).toEqual(
        rawEvaluateDirection(dirX, dirY, world, T, exemptions),
      );
    }
  });

  it('chooses the identical bearing through the cached fan and the raw fan', () => {
    for (const seed of SEEDS) {
      const snapshot = seededSnapshot(seed);
      const world = buildBotWorld(snapshot);
      const objective = { x: Math.cos(seed) * 100, y: Math.sin(seed) * 100 };
      const cached = chooseSteeringDirection(objective, world, T);
      const raw = rawFan(objective, world, T);
      expect(cached).toEqual(raw);
    }
  });

  it('recomputes the geometry inline (bit-identical) when no derived data is supplied', () => {
    const snapshot = seededSnapshot(0x77);
    const world = buildBotWorld(snapshot);
    for (const offsetDeg of T.fanDegrees) {
      const angle = (offsetDeg * Math.PI) / 180;
      const dirX = Math.cos(angle);
      const dirY = Math.sin(angle);
      // Single-call path (no `derived`) must match the raw reference exactly.
      expect(evaluateDirection(dirX, dirY, world, T)).toEqual(
        rawEvaluateDirection(dirX, dirY, world, T),
      );
    }
  });
});
