/**
 * Hangar-war deployment launch contract (AH-0MVUXC2DD003HN0I, part of
 * **Build Candidate D — Hangar War**).
 *
 * A hex deployment is a **normal run at that hex's aggression** (design of
 * record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *The capture cycle*).
 * This module turns the persistent hangar payload into the launch data the
 * shipped `PlayScene` consumes:
 *
 * - the **hangar-resolved loadout** — the active hull's run stats (starting
 *   lives, speed), its starting weapons and its permanent modifiers;
 * - the **hex-aggression-selected difficulty** — the target hex's aggression
 *   selects a campaign level, so the run uses the shipped difficulty curves
 *   (`src/data/difficulty-curves.csv` through the existing scaling modules)
 *   instead of introducing a second difficulty system (intake assumption A2);
 * - a deterministic **run seed** derived from the war's seed, so a deployment
 *   is reproducible and distinct per hex/aggression.
 *
 * Everything here is pure: no Phaser, no storage access, no run code. The
 * deployment is a *payload*; `PlayScene` remains the only run implementation
 * (gym↔game parity, `AGENTS.md`), and the arcade run keeps sending no
 * outer-loop payload at all.
 *
 * ## Checkpoint isolation
 *
 * The payload is tagged (`kind: 'hangar-war'`), never *checkpoint* data: a hex
 * deployment writes no arcade checkpoint and clears none, so Continue always
 * belongs to the shipped arcade run. `PlayScene` reads this module's
 * {@link readHangarWarDeployment} guard before applying anything, so a
 * malformed or absent payload degrades to the unchanged arcade run.
 *
 * @module src/scenes/hangarWar/hangarDeployment
 */

import { DEFAULT_LIVES, MAX_LIVES, MAX_LEVEL, MIN_LEVEL } from '../../core/GameState';
import type { ShipConfig } from '../../core/configTypes';
import {
  findHangarEntry,
  resolveActiveHull,
  resolveActiveLoadout,
} from '../../core/hangarWar/hangarEconomy';
import type { HangarWarPayload, HexState } from '../../core/hangarWar/types';
import { normaliseSeed } from '../../core/rng';
import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HangarEntry,
  type HullDefinition,
} from '../../data/hangarCatalogue';
import type { WeaponId } from '../../utils/weapons';

/** The launch-data tag a hangar-war deployment carries. */
export const HANGAR_WAR_DEPLOYMENT_KIND = 'hangar-war';

/**
 * Aggression used when the war has no hex to attack yet (a fresh hangar, or
 * the phase-A build where the ring model has not landed). Aggression `0`
 * maps to campaign level 1, i.e. the shipped opening difficulty.
 */
export const DEFAULT_DEPLOYMENT_AGGRESSION = 0;

/**
 * One hangar-war deployment, ready to hand to `PlayScene` as launch data.
 *
 * Plain data only (no class instance), because Phaser stores scene-start data
 * and reuses it across scene starts.
 */
export interface HangarWarDeployment {
  /** Tag identifying this launch data as a hex deployment. */
  readonly kind: typeof HANGAR_WAR_DEPLOYMENT_KIND;
  /** The hex being attacked, or `null` while the war has no ring yet. */
  readonly hexId: string | null;
  /** The target hex's aggression (the selected difficulty input). */
  readonly aggression: number;
  /** The campaign level the aggression selected (1–{@link MAX_LEVEL}). */
  readonly startLevel: number;
  /** Deterministic run seed derived from the war seed + target. */
  readonly seed: number;
  /** The hull the fleet deploys with (resolved from the hangar). */
  readonly hullId: string;
  /** Lives the hull + modifiers grant at run start (1–{@link MAX_LIVES}). */
  readonly startingLives: number;
  /** Movement-speed multiplier applied to the shared ship config. */
  readonly speedMultiplier: number;
  /** Shipped weapon ids the deployment starts armed with. */
  readonly startingWeapons: readonly WeaponId[];
  /** Permanent modifier ids applied to this deployment. */
  readonly modifiers: readonly string[];
}

/** Options for {@link buildHangarDeployment}. */
export interface BuildHangarDeploymentOptions {
  /**
   * The hex to attack. Omitted/`null` selects the weakest unheld hex of the
   * current ring (the attract bot's rule), or the war baseline when the ring
   * is empty.
   */
  readonly hexId?: string | null;
  /** The unlock tree to resolve against (defaults to the shipped catalogue). */
  readonly catalogue?: readonly HangarEntry[];
  /** Explicit run seed override (tests); defaults to a derived seed. */
  readonly seed?: number;
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** Clamps `value` to the inclusive integer range `[min, max]`. */
function clampInt(value: number, min: number, max: number): number {
  const integer = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.min(Math.max(integer, min), max);
}

/**
 * Maps a hex's aggression to the campaign level a deployment starts at.
 *
 * Aggression is the war's difficulty dial: `0` is the shipped opening level
 * (so a fresh war deploys against the level-1 curve, exactly as Play Game
 * does today) and each point of aggression advances one campaign level, up to
 * the campaign maximum. The selected level is what the shipped level-scaling
 * and difficulty-curve modules consume, so no second difficulty system is
 * introduced.
 *
 * Total: negative, fractional and non-finite values resolve to level 1 or
 * clamp at the campaign bounds, never throwing.
 *
 * @param aggression — the target hex's aggression.
 * @returns a 1-based campaign level in `[1, MAX_LEVEL]`.
 */
export function deploymentLevelForAggression(aggression: number): number {
  const points = toCount(aggression);
  return clampInt(MIN_LEVEL + points, MIN_LEVEL, MAX_LEVEL);
}

/**
 * Picks the hex a deployment attacks.
 *
 * An explicitly requested hex wins; otherwise the **weakest unheld hex** is
 * chosen (the epic's attract-mode rule — auto-pick the weakest hex), falling
 * back to the whole ring when every hex is held. A ring with no hexes yields
 * `null`, and the deployment uses the war baseline aggression.
 *
 * @param payload — the war payload (never mutated).
 * @param hexId — the explicitly requested hex id, if any.
 * @returns the target hex, or `null` when the ring is empty/unknown.
 */
export function selectDeploymentHex(
  payload: HangarWarPayload,
  hexId?: string | null,
): HexState | null {
  const hexes = payload.ring.hexes;
  if (hexId !== undefined && hexId !== null) {
    const requested = hexes.find((hex) => hex.id === hexId);
    if (requested) return requested;
  }
  const unheld = hexes.filter((hex) => !hex.held);
  const pool = unheld.length > 0 ? unheld : hexes;
  if (pool.length === 0) return null;
  return pool.reduce((weakest, hex) =>
    hex.aggression < weakest.aggression ? hex : weakest,
  );
}

/** The hull definition a deployment uses (falls back to the starter hull). */
function resolveHullDefinition(
  hullId: string,
  catalogue: readonly HangarEntry[],
): HullDefinition | null {
  for (const id of [hullId, STARTER_HULL_ID]) {
    const entry = findHangarEntry(id, catalogue);
    if (entry !== null && entry.kind === 'hull') return entry;
  }
  return null;
}

/**
 * The lives a deployment starts with: the hull's run stat plus every owned
 * `extra-lives` modifier, capped at the run's maximum lives.
 */
function resolveStartingLives(
  hull: HullDefinition | null,
  modifiers: readonly string[],
  catalogue: readonly HangarEntry[],
): number {
  let lives = hull?.runStats.startingLives ?? DEFAULT_LIVES;
  for (const id of modifiers) {
    const entry = findHangarEntry(id, catalogue);
    if (entry !== null && entry.kind === 'modifier' && entry.effect.kind === 'extra-lives') {
      lives += entry.effect.lives;
    }
  }
  return clampInt(lives, 1, MAX_LIVES);
}

/** The shipped weapon ids a hangar loadout resolves to. */
function resolveStartingWeapons(
  startingWeaponIds: readonly string[],
  catalogue: readonly HangarEntry[],
): WeaponId[] {
  const weapons: WeaponId[] = [];
  for (const id of startingWeaponIds) {
    const entry = findHangarEntry(id, catalogue);
    if (entry !== null && entry.kind === 'weapon' && !weapons.includes(entry.weaponId)) {
      weapons.push(entry.weaponId);
    }
  }
  return weapons;
}

/**
 * Builds the launch data for one hex deployment (pure).
 *
 * Resolution order follows the economy: the active hull/loadout come from
 * `resolveActiveHull`/`resolveActiveLoadout`, so corrupt saves can never
 * deploy an unowned ship or an empty loadout, and the aggression comes from
 * the target hex (see {@link selectDeploymentHex}).
 *
 * @param payload — the persistent war payload (never mutated).
 * @param options — target hex, catalogue and seed overrides.
 * @returns the deployment payload for `PlayScene`.
 */
export function buildHangarDeployment(
  payload: HangarWarPayload,
  options: BuildHangarDeploymentOptions = {},
): HangarWarDeployment {
  const catalogue = options.catalogue ?? HANGAR_CATALOGUE;
  const hex = selectDeploymentHex(payload, options.hexId);
  const aggression = toCount(hex?.aggression ?? DEFAULT_DEPLOYMENT_AGGRESSION);
  const startLevel = deploymentLevelForAggression(aggression);
  const hullId = resolveActiveHull(payload.hangar);
  const hull = resolveHullDefinition(hullId, catalogue);
  const loadout = resolveActiveLoadout(payload.hangar);
  const seed = normaliseSeed(
    options.seed
      ?? payload.seed + aggression * 104729 + payload.ring.ringIndex,
  );
  return {
    kind: HANGAR_WAR_DEPLOYMENT_KIND,
    hexId: hex?.id ?? null,
    aggression,
    startLevel,
    seed,
    hullId: hull?.id ?? STARTER_HULL_ID,
    startingLives: resolveStartingLives(hull, loadout.modifiers, catalogue),
    speedMultiplier: hull?.runStats.speedMultiplier ?? 1,
    startingWeapons: resolveStartingWeapons(loadout.startingWeapons, catalogue),
    modifiers: [...loadout.modifiers],
  };
}

/** A non-empty string array, else `[]` (defensive launch-data parsing). */
function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
}

/**
 * Reads launch data passed to `PlayScene`, returning `null` unless it is a
 * usable hangar-war deployment.
 *
 * Defensive and total, like every persisted/launch-data parser in the repo:
 * a missing tag, a non-integer `startLevel` or a non-finite seed means the
 * caller is not (or not usefully) deploying, so the scene runs the shipped
 * arcade path unchanged. Usable values are normalised (clamped level/lives,
 * positive speed multiplier) rather than trusted blindly.
 *
 * @param value — the raw `hangarWar` scene-start value.
 * @returns the normalised deployment, or `null` for the arcade run.
 */
export function readHangarWarDeployment(
  value: unknown,
): HangarWarDeployment | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== HANGAR_WAR_DEPLOYMENT_KIND) return null;
  if (typeof raw.startLevel !== 'number' || !Number.isFinite(raw.startLevel)) {
    return null;
  }
  const speed =
    typeof raw.speedMultiplier === 'number'
    && Number.isFinite(raw.speedMultiplier)
    && raw.speedMultiplier > 0
      ? raw.speedMultiplier
      : 1;
  return {
    kind: HANGAR_WAR_DEPLOYMENT_KIND,
    hexId: typeof raw.hexId === 'string' ? raw.hexId : null,
    aggression: toCount(raw.aggression),
    startLevel: clampInt(raw.startLevel, MIN_LEVEL, MAX_LEVEL),
    seed: normaliseSeed(
      typeof raw.seed === 'number' ? raw.seed : 0,
    ),
    hullId: typeof raw.hullId === 'string' && raw.hullId.length > 0
      ? raw.hullId
      : STARTER_HULL_ID,
    startingLives: clampInt(
      typeof raw.startingLives === 'number' ? raw.startingLives : DEFAULT_LIVES,
      1,
      MAX_LIVES,
    ),
    speedMultiplier: speed,
    startingWeapons: toStringList(raw.startingWeapons) as WeaponId[],
    modifiers: toStringList(raw.modifiers),
  };
}

/** The narrow player surface a deployment applies to (kept structural). */
export interface HangarWarDeploymentPlayer {
  /** Grants (`permanent`) a weapon through the shipped player seam. */
  equipWeapon(id: WeaponId, permanent?: boolean): void;
}

/** The seams a deployment is applied through (no scene internals leak out). */
export interface HangarWarDeploymentSeams {
  /** The run's player, or `null` when it has not spawned yet. */
  getPlayer(): HangarWarDeploymentPlayer | null;
  /** Sets the run's starting lives (the hull + modifier result). */
  setStartingLives?(lives: number): void;
}

/**
 * Scales the shared ship config by the deployment hull's speed multiplier.
 *
 * The hull's run stat is applied to the **base** tuning the shared speed-boost
 * seam multiplies about (`Player.setSpeedMultiplier` composes on top of it
 * every frame from the effects registry), so a slower hull stays slower with
 * and without a Speed Boost instead of having its hull stat overwritten.
 *
 * @param config — the shipped/selected ship config (never mutated).
 * @param deployment — the deployment supplying the hull multiplier.
 * @returns a fresh config with thrust and speed caps scaled.
 */
export function applyHullSpeedToShipConfig(
  config: ShipConfig,
  deployment: HangarWarDeployment,
): ShipConfig {
  const multiplier = deployment.speedMultiplier;
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier === 1) {
    return { ...config };
  }
  return {
    ...config,
    thrustAcceleration: config.thrustAcceleration * multiplier,
    maxSpeed: config.maxSpeed * multiplier,
    asteroidsReverseThrustAcceleration:
      config.asteroidsReverseThrustAcceleration * multiplier,
    asteroidsReverseMaxSpeed: config.asteroidsReverseMaxSpeed * multiplier,
  };
}

/**
 * Applies a deployment to play state through existing shared seams: the
 * hull's starting lives and its starting weapons (the same
 * `Player.equipWeapon` seam the capture setup and live play use, so no loadout
 * logic is duplicated). The hull's speed scales the ship config at spawn
 * ({@link applyHullSpeedToShipConfig}). Total: a scene without a player still
 * applies the lives.
 *
 * @param seams — the scene's player and lives seams.
 * @param deployment — the deployment to apply.
 */
export function applyHangarWarDeployment(
  seams: HangarWarDeploymentSeams,
  deployment: HangarWarDeployment,
): void {
  seams.setStartingLives?.(deployment.startingLives);
  const player = seams.getPlayer();
  if (!player) return;
  for (const weaponId of deployment.startingWeapons) {
    player.equipWeapon(weaponId, true);
  }
}
