/**
 * Shared collector-drone lifecycle pass — spawn, tick, payout and
 * destruction (parent AH-0MV9G113S009B37I, child AH-0MVBMPZS90038715).
 *
 * The visible Mystery UFO reward is a {@link MysteryUfoDrone}: a scaled-down
 * copy of the player ship that seeks the nearest mineral, vacuums minerals
 * whose centre enters its collector radius, flies home and pays the hold out.
 * Every scene that can spawn one runs the **same** helpers below, so the game
 * and the gyms cannot drift apart (gym↔game parity, AGENTS.md).
 *
 * Responsibilities owned here exactly once:
 *
 * - {@link spawnDrone} — the only way a drone enters a scene; it wires the
 *   drone's pay-in to the caller-supplied hold sink (voicing the reward
 *   fanfare exactly when the hold is credited) and starts the sortie-long
 *   Mystery UFO warble exactly once.
 * - {@link tickDrones} — the seek → collect → return → payout pass: pushes the
 *   live mineral field into each drone, tracks the live player as home, ticks
 *   motion and removes drones that have paid out (or been destroyed). It also
 *   releases the warble as soon as a drone's return leg begins (the seek and
 *   collect phases are the only ones the warble scores), so the loop never
 *   leaks past a terminal.
 * - {@link hitDrone} — the destruction contract: only **enemy** ordnance or an
 *   enemy body destroys a drone (the player's own fire passes through), a
 *   destroyed drone spills its held minerals **plus** a `2 × level` bonus at
 *   the crash site as collectable field deposits, and the terminal feedback
 *   lands exactly once — the warble stops, the explosion cue plays with a
 *   crash-site particle burst, and a mineral tinkle voices the spill.
 *
 * The module is deliberately scene-agnostic: it operates on the structural
 * drone/mineral/sink shapes so unit tests never need a real combat scene, and
 * `CombatCoreScene` wires the pass into the shared tick once for every scene.
 *
 * @module scenes/core/combatDrone
 */

import type Phaser from 'phaser';

import {
  playMineralTinkleSound,
  playMysteryUfoDestroySound,
  playMysteryUfoRewardSound,
  playMysteryUfoWarbleSound,
  stopMysteryUfoWarbleSound,
} from '../../audio/effects';
import { scatterMineralDrops } from '../../entities/Mineral';
import type { Mineral } from '../../entities/Mineral';
import {
  MYSTERY_UFO_DRONE_COLOR,
  MysteryUfoDrone,
  type MysteryUfoDroneConfig,
} from '../../entities/MysteryUfoDrone';
import { spawnExplosionParticles } from '../../vfx/explosionParticles';
import { recordDroneVfxSpawn } from '../../vfx/droneVfxCounts';

/** Default sortie lifetime (s) when the resolved stats are unavailable. */
export const DEFAULT_DRONE_LIFETIME_SECONDS = 5;

/** Default hold capacity (minerals) when the resolved stats are unavailable. */
export const DEFAULT_DRONE_CAPACITY = 10;

/** Default vacuum radius (px) when the resolved stats are unavailable. */
export const DEFAULT_DRONE_COLLECTOR_RADIUS = 20;

/** Extra minerals a destroyed drone spills per power-up level (`2 × level`). */
export const DRONE_DESTRUCTION_BONUS_PER_LEVEL = 2;

/**
 * The scene's hold mutator the drone pays its collected minerals into — the
 * same `addMinerals` seam every other mineral source uses. The game routes it
 * to the run hold, the gyms to their local hold.
 */
export interface DroneMineralSink {
  /** Adds `amount` minerals to the scene's hold. */
  addMinerals(amount: number): void;
}

/** A sink that drops payout minerals (safe default for drone-less scenes). */
export const NOOP_DRONE_MINERAL_SINK: DroneMineralSink = {
  addMinerals: () => {},
};

/** The drone configuration minus the pay-in, which {@link spawnDrone} owns. */
export type DroneSpawnConfig = Omit<MysteryUfoDroneConfig, 'onPayout'>;

/** One shared tick's inputs. */
export interface DroneTickContext {
  /** Frame delta in seconds. */
  dt: number;
  /** The scene's live mineral field (seek targets and vacuum candidates). */
  minerals: readonly Mineral[];
  /** The live player (the drone's return target), or null while absent. */
  player: { x: number; y: number } | null;
}

/** How a drone was hit. Only enemies can destroy it. */
export type DroneHitCause = 'enemy-bullet' | 'enemy-body' | 'player-bullet';

/**
 * Spawns a collector drone into `drones` and wires its pay-in to `sink`.
 *
 * This is the single spawn path for the reward: the drone's payout callback
 * is created here (not by callers), so the minerals it ferries reach the hold
 * exactly once and the same code runs in the game and every gym. It is also
 * the single start point for the sortie-long warble, which
 * {@link tickDrones}/{@link hitDrone} release on every terminal path.
 *
 * @param scene — scene that owns the drone's display object.
 * @param config — resolved level tuning (lifetime, capacity, collectorRadius)
 *   plus the spawn position (home defaults to the player each tick).
 * @param drones — the scene's drone list (mutated: the new drone is appended).
 * @param sink — the hold mutator the drone pays into.
 * @returns the spawned drone.
 */
export function spawnDrone(
  scene: Phaser.Scene,
  config: DroneSpawnConfig,
  drones: MysteryUfoDrone[],
  sink: DroneMineralSink,
): MysteryUfoDrone {
  const drone = new MysteryUfoDrone(scene, {
    ...config,
    onPayout: (minerals: number) => {
      if (minerals > 0) {
        sink.addMinerals(minerals);
        // Reward fanfare rides the pay-in itself, not the return-leg start,
        // so the payout moment is the thing the player hears. An empty
        // payout credits nothing and stays silent (documented assumption:
        // there is no reward to celebrate).
        playMysteryUfoRewardSound();
      }
    },
  });
  drones.push(drone);
  // Start the warble exactly once per sortie. The wrapper shares one looping
  // voice, so a re-entered spawn can never stack a second warble.
  playMysteryUfoWarbleSound();
  return drone;
}

/**
 * Runs one shared drone tick: feeds every live drone the scene's mineral
 * field and the ship's current position, advances its lifecycle, and drops
 * drones that have paid out (or been destroyed) from the list.
 *
 * The returned array is a **new** list — callers reassign their drone field
 * (the same contract as `advanceDropLifecycles`). Removed drones have their
 * display objects destroyed; their minerals were paid on payout or spilled by
 * {@link hitDrone} on destruction, so nothing is lost by the removal.
 *
 * Feeding the field every tick is what makes a drone seek the nearest live
 * mineral (and clear its target and hold station on an empty field).
 *
 * The pass also owns the warble's non-destruction terminals: the moment a
 * drone's phase transitions out of seek/collect into `return`, and whenever a
 * drone is removed dead (paid out, or destroyed on an earlier step), the
 * looping voice is released. Destruction while still collecting is stopped by
 * {@link hitDrone}. Every path is therefore covered, and repeated ticks can
 * never double-start or mismatch the loop.
 *
 * @param drones — the scene's current drones.
 * @param ctx — live mineral field, player position and frame delta.
 * @returns the drones still active after this tick.
 */
export function tickDrones(
  drones: readonly MysteryUfoDrone[],
  ctx: DroneTickContext,
): MysteryUfoDrone[] {
  const kept: MysteryUfoDrone[] = [];
  for (const drone of drones) {
    if (!drone.alive) {
      // Paid out or destroyed on a previous step — remove the display object
      // and make sure no warble outlives it.
      stopMysteryUfoWarbleSound();
      drone.destroy();
      continue;
    }
    drone.setSeekTargets(ctx.minerals);
    if (ctx.player) drone.setHomeTarget(ctx.player.x, ctx.player.y);
    const previousState = drone.droneState;
    drone.updatePosition(ctx.dt);
    // Return-leg begin is the first terminal: the warble only scores the
    // seek and collect phases, so release it on the phase transition.
    const beganReturn =
      previousState !== 'return' && drone.droneState === 'return';
    if (beganReturn || !drone.alive) stopMysteryUfoWarbleSound();
    if (drone.alive) {
      kept.push(drone);
    } else {
      drone.destroy();
    }
  }
  return kept;
}

/**
 * Minerals a destroyed drone spills at its crash site: everything it was
 * carrying **plus** the `2 × level` destruction bonus (never negative).
 *
 * @param heldMinerals — minerals in the drone's hold when it was destroyed.
 * @param level — the Mystery UFO power-up level.
 */
export function destroyedDroneDropCount(
  heldMinerals: number,
  level: number,
): number {
  return heldMinerals + DRONE_DESTRUCTION_BONUS_PER_LEVEL * Math.max(0, level);
}

/**
 * Applies a hit to a drone and, when it destroys the drone, delivers the
 * terminal feedback — releases the sortie warble, plays the explosion cue,
 * spawns the crash-site particle burst, then scatters the spill as
 * collectable minerals with a mineral tinkle in sync — all exactly once.
 *
 * Only `'enemy-bullet'` and `'enemy-body'` can destroy a drone; a
 * `'player-bullet'` hit is a no-op (the player's own fire passes through) and
 * returns no drops. Repeated hits after destruction are no-ops, so a drone
 * can never spill (or voice its destruction) twice.
 *
 * The tinkle is voiced only when the spill actually drops minerals: it reads
 * the scattered resources, so an empty spill (level 0, empty hold) is silent
 * beyond the explosion. The explosion cue itself always fires — the saucer's
 * destruction is the event, the minerals are the consequence.
 *
 * @param scene — scene that owns the new mineral display objects.
 * @param drone — the drone that was hit.
 * @param cause — what hit it (enemy bullet, enemy body, or player fire).
 * @param level — the Mystery UFO power-up level (destruction bonus source).
 * @param rng — random-number generator (injected by tests for determinism).
 * @returns the collectable minerals dropped at the crash site (empty unless
 *   this hit destroyed the drone).
 */
export function hitDrone(
  scene: Phaser.Scene,
  drone: MysteryUfoDrone,
  cause: DroneHitCause,
  level: number,
  rng: () => number = Math.random,
): Mineral[] {
  const destroyed =
    cause === 'enemy-bullet'
      ? drone.onEnemyBullet()
      : cause === 'enemy-body'
        ? drone.onEnemyBody()
        : drone.onPlayerBullet();
  if (!destroyed) return [];
  // Destruction is a terminal: release the warble before the crash feedback
  // so it lands on a silent, non-leaking loop.
  stopMysteryUfoWarbleSound();
  playMysteryUfoDestroySound();
  // Crash-site burst: the shared explosion VFX at the drone's last position,
  // scaled from the saucer's own size and coloured from its hull. Counted in
  // the shared saucer VFX registry so the feel tests observe it.
  spawnExplosionParticles(
    scene,
    drone.x,
    drone.y,
    MYSTERY_UFO_DRONE_COLOR,
    drone.effectiveSize,
  );
  recordDroneVfxSpawn('destruction');
  const drops = scatterMineralDrops(
    scene,
    drone.x,
    drone.y,
    destroyedDroneDropCount(drone.heldMinerals, level),
    rng,
  );
  // Voice the spill with the drops themselves (never a tinkle for nothing).
  if (drops.length > 0) playMineralTinkleSound();
  return drops;
}
