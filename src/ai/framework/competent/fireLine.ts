/**
 * Shared **fire-line** predicate for the player's auto-fire
 * (AH-0MWPOET5A002IPTP · fire-discipline remediation).
 *
 * The shipped player auto-fires along its committed facing with no aim gate
 * (`CombatCoreScene._autoFire` → `player.tryFire`). For a human pilot that is
 * the intended "hold the trigger" feel, but a demo/attract bot that collects,
 * evades and repositions has its nose pointing away from every target for much
 * of a run and would otherwise keep firing into empty space — the producer's
 * "the bot will sometimes appear to be firing at nothing".
 *
 * {@link hasFireLine} is the one definition of "this shot has a target": a
 * live body lies **ahead of the muzzle**, inside the firing weapon's reach, and
 * close enough to the shot's ray that the body and the bullet would meet. The
 * scene applies it to gate the bot's auto-fire ({@link
 * import('../../../scenes/core/CombatCoreScene').CombatCoreScene.botFireAllowed})
 * and the headless evaluation arena applies the identical predicate to measure
 * and model the same gate, so the game, every gym and the harness cannot drift
 * apart.
 *
 * ## Fallbacks (never suppress on missing information)
 *
 * A non-finite or non-positive `weaponRange` means the caller has no reach
 * information, so the predicate reports `true` (fire). This keeps a snapshot,
 * scene or test that predates the range seam byte-for-byte unchanged rather
 * than silently silencing the weapon.
 *
 * The predicate is pure, allocation-free and wrap-aware: the same origin,
 * heading, reach and targets always produce the same answer, and a body across
 * a torus seam is judged on its shortest wrapped offset.
 *
 * @module src/ai/framework/competent/fireLine
 */

import { PLAYER_BULLET_RADIUS } from '../../../core/constants';
import { wrappedAxisDelta, type WrapWorld } from '../../../utils/wrapGeometry';

/**
 * Default allowance (px) added to a target's own hit radius when judging the
 * shot line. It is the shared player-bullet radius: a body a bullet would
 * actually clip counts as a target even though its centre is a few pixels off
 * the ray.
 */
export const BOT_FIRE_LINE_RADIUS_PX = PLAYER_BULLET_RADIUS;

/** A body the fire line can be judged against. */
export interface FireLineTarget {
  readonly x: number;
  readonly y: number;
  readonly alive: boolean;
  /** The body's collision radius (px), when exposed as data. */
  readonly radius?: number;
  /**
   * The body's collision radius (px), when exposed as a method — the shared
   * `CombatEnemyEntity` / `HitscanTarget` shape. Used only when `radius` is
   * absent, so a live scene can hand its entity list straight in with no
   * per-tick adapter allocation.
   */
  getHitRadius?(): number;
}

/** The geometry and reach a fire-line judgement needs. */
export interface FireLineInput {
  /** The ship's muzzle (its centre). */
  readonly origin: { readonly x: number; readonly y: number };
  /** The ship's committed facing (radians, 0 = +x). */
  readonly heading: number;
  /**
   * The firing weapon's effective reach (px). `0`/absent/negative means the
   * reach is unknown, and the predicate reports `true` (never suppress).
   */
  readonly weaponRange: number;
  /** The bodies that could be hit. */
  readonly targets: readonly FireLineTarget[];
  /** Optional torus; omitting it keeps the legacy raw geometry. */
  readonly world?: WrapWorld;
  /**
   * Extra allowance (px) beyond the target's hit radius. Defaults to
   * {@link BOT_FIRE_LINE_RADIUS_PX}; a caller modelling a wider projectile can
   * pass a larger value.
   */
  readonly lineRadiusPx?: number;
}

/**
 * Whether a shot fired from `origin` along `heading` has a live target inside
 * `weaponRange` on its line.
 *
 * @param input — the shot geometry, reach and candidate bodies.
 */
export function hasFireLine(input: FireLineInput): boolean {
  const range = input.weaponRange;
  // Missing reach information never silences the weapon (documented fallback).
  if (!(Number.isFinite(range) && range > 0)) return true;
  const ux = Math.cos(input.heading);
  const uy = Math.sin(input.heading);
  const lineRadius = input.lineRadiusPx ?? BOT_FIRE_LINE_RADIUS_PX;
  const world = input.world;
  for (const target of input.targets) {
    if (!target.alive) continue;
    const targetRadius =
      target.radius ?? target.getHitRadius?.() ?? 0;
    const dx = world
      ? wrappedAxisDelta(input.origin.x, target.x, world.width)
      : target.x - input.origin.x;
    const dy = world
      ? wrappedAxisDelta(input.origin.y, target.y, world.height)
      : target.y - input.origin.y;
    // Only bodies ahead of the muzzle can be the thing the shot is aimed at.
    const along = dx * ux + dy * uy;
    if (!(along > 0)) continue;
    // A body whose own radius overlaps the muzzle is point-blank.
    const distance = Math.hypot(dx, dy);
    if (distance > range + targetRadius) continue;
    const perpendicular = Math.abs(dx * uy - dy * ux);
    if (perpendicular <= targetRadius + lineRadius) return true;
  }
  return false;
}
