/**
 * The hex boss — the deployment's boss variant on the **shared** boss path
 * (AH-0MVUXCAW0001VUM6, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D — a run is
 * "a normal campaign slice … ending on the hex's boss", and Rule 2 says "a hex
 * boss demonstrates the hex's new weapon or power-up against the player".
 *
 * ## A variant, never a copy
 *
 * The hex boss is the shipped `Boss` (the run's final encounter) configured
 * from the hex, not a second boss implementation: every value this module
 * produces maps onto an existing, default-preserving `BossConfig` hook
 * (`bodyColor`, `desperationColor`, `hitPointsPerPhase`, `phaseCount`,
 * `demonstratedWeapon`). Rule 2 — "the boss wields it first" — is honoured by
 * {@link HexBossProfile.demonstration}: the boss **opens the encounter by
 * firing the granted weapon's volley**, with that weapon's fan offsets, bullet
 * colour and bullet shape resolved from the **shared** catalogue
 * ({@link hexBossDemonstration} reads `src/utils/weapons.ts`), while the body
 * keeps wearing the weapon's colour as a secondary tell. Later phases keep the
 * shipped patterns, and the grant itself is still resolved by the capture cycle
 * — the shipped configuration seam is used rather than forking the entity.
 *
 * ## What the hex contributes
 *
 * - **Identity** — the authored boss name (e.g. `maw-of-ashes`) is published
 *   for the HUD/telemetry, and a deterministic fallback colour keeps an
 *   unknown/unauthored hex readable.
 * - **Difficulty** — the hex's aggression resolves through the shipped
 *   `hexDifficulty` mapping (the campaign level the deployment starts at) and
 *   perturbs the boss hit pool with `hexBossHpMultiplier`, so aggression `0`
 *   is exactly the authored pool and no aggression can double it.
 * - **The demonstration** — the authored grant resolves to the shipped weapon
 *   it demonstrates; the capture cycle then records that grant in the hangar
 *   only when the boss is actually defeated (Rule 2).
 *
 * Pure and total: no Phaser, no storage, no scene. The gyms and the game read
 * the same profile (AGENTS.md gym↔game parity), and the scene maps it onto
 * `BossConfig` in one place.
 *
 * @module src/core/hangarWar/hexBoss
 */

import {
  hexDifficultyProfile,
  type HexDifficultyProfile,
} from './hexDifficulty';
import { resolveHexGrant, type HexGrant } from './captureCycle';
import type { HexRingDefinition } from './hexRing';
import { MAX_LEVEL } from '../GameState';
import {
  BULLET_COLORS,
  BULLET_SPEED,
  getWeaponById,
  type BulletShape,
  type WeaponId,
} from '../../utils/weapons';

/**
 * The number of attack/health phases a hex boss uses.
 *
 * The shipped `Boss`'s four telegraph → volley → attack phases are retained
 * unchanged; the hex tunes the encounter's identity and hit pool, never its
 * phase architecture. Exposed so tests and the scene agree on the value
 * without importing the Phaser entity.
 */
export const HEX_BOSS_PHASE_COUNT = 4;

/** The palette fallen back to when a hex demonstrates no weapon. */
const FALLBACK_BOSS_PALETTE: readonly number[] = Object.freeze([
  0xff4466,
  0xff8844,
  0xffcc44,
  0x88ff44,
  0x44ffcc,
  0x4488ff,
  0xaa44ff,
  0xff44cc,
]);

/** The minimum input a hex boss profile needs (a deployment has exactly this). */
export interface HexBossSource {
  /** Stable hex id (the persisted `HexState.id`). */
  readonly id: string;
  /** The hex's frontier aggression at deployment time. */
  readonly aggression: number;
}

/** Everything the run's boss encounter needs to know about the hex. */
export interface HexBossProfile {
  /** The hex being attacked. */
  readonly hexId: string;
  /** The authored boss name, or `null` when the hex is unauthored. */
  readonly bossName: string | null;
  /** The hex's normalised aggression. */
  readonly aggression: number;
  /** The campaign level the aggregation selects (the shipped difficulty). */
  readonly startLevel: number;
  /** Multiplier applied to the boss's authored hit pool (`[1, 2]`). */
  readonly hpMultiplier: number;
  /** Body colour — the demonstrated weapon's colour when there is one. */
  readonly bodyColor: number;
  /** Final-phase (desperation) body colour. */
  readonly desperationColor: number;
  /** The grant the boss demonstrates, or `null` when the hex grants nothing. */
  readonly grant: HexGrant | null;
  /** The demonstrated weapon's bullet colour, or `null` for a non-weapon grant. */
  readonly demonstratedColor: number | null;
  /**
   * The weapon volley the boss wields against the player (Rule 2), from the
   * shared weapon catalogue, or `null` when the hex grants no weapon.
   */
  readonly demonstration: HexBossDemonstration | null;
  /** Phase count for the shipped boss path (`HEX_BOSS_PHASE_COUNT`). */
  readonly phaseCount: number;
  /** The shipped difficulty profile behind the encounter (single source). */
  readonly difficulty: HexDifficultyProfile;
}

/** FNV-1a offset basis / prime (the repo's deterministic string mixing). */
const FNV_OFFSET_BASIS = 0x811c_9dc5;
const FNV_PRIME = 0x0100_0193;

/** `value` as a non-negative whole number; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** FNV-1a hash of a string, normalised to 32 bits. */
function hashString(value: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Blends each RGB channel towards white; `amount` is clamped to `[0, 1]`. */
function lighten(color: number, amount: number): number {
  const ratio = Math.min(1, Math.max(0, amount));
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  const mix = (channel: number): number =>
    Math.round(channel + (0xff - channel) * ratio);
  return (mix(red) << 16) | (mix(green) << 8) | mix(blue);
}

/**
 * The weapon volley a hex boss wields against the player (Rule 2).
 *
 * Derived from the **shared** weapon catalogue (`src/utils/weapons.ts`), so a
 * granted weapon is demonstrated with its own fan pattern, bullet colour and
 * bullet identity — there is no second weapon table. `size` and `speed` are
 * published so the scene can hand the volley to the shipped boss bullet path.
 */
export interface HexBossDemonstration {
  /** The shipped weapon id the boss wields. */
  readonly weaponId: WeaponId;
  /** The weapon's display name (telemetry / debug). */
  readonly weaponName: string;
  /** Bullet colour (the weapon's own). */
  readonly color: number;
  /** Per-bullet relative radian offsets around the boss's downward heading. */
  readonly offsets: readonly number[];
  /** Bullet speed (px/s) — heavier weapons fly slower. */
  readonly speed: number;
  /** Bullet shape primitive. */
  readonly shape: BulletShape;
  /** Elongation for elongated shapes (the weapon's own, when it has one). */
  readonly length?: number;
  /** Bullet size multiplier (the weapon's own). */
  readonly size: number;
}

/** Bullet-size clamp used to derive the demonstration's speed (heavy = slow). */
const DEMONSTRATION_SIZE_RANGE = Object.freeze({ min: 0.5, max: 2 });

/**
 * Resolves the volley a hex boss wields for the weapon it grants.
 *
 * @param grant — the hex's resolved grant (from {@link resolveHexGrant}).
 * @returns the demonstration descriptor, or `null` when the hex grants a
 *   non-weapon entry (an upgrade/strength hex) or no entry at all.
 */
export function hexBossDemonstration(
  grant: HexGrant | null,
): HexBossDemonstration | null {
  const weaponId = grant?.weaponId ?? null;
  if (weaponId === null) return null;

  let weapon: ReturnType<typeof getWeaponById>;
  try {
    weapon = getWeaponById(weaponId);
  } catch {
    // An id outside the shipped catalogue demonstrates nothing rather than
    // throwing inside a deployment.
    return null;
  }

  const size = Math.min(
    DEMONSTRATION_SIZE_RANGE.max,
    Math.max(DEMONSTRATION_SIZE_RANGE.min, toPositive(weapon.bulletSize, 1)),
  );
  const demonstration: HexBossDemonstration = {
    weaponId,
    weaponName: weapon.name,
    color: weapon.bulletColor,
    offsets: [...weapon.offsets],
    speed: Math.round(BULLET_SPEED / size),
    shape: weapon.bulletShape,
    ...(weapon.bulletShapeLength === undefined
      ? {}
      : { length: weapon.bulletShapeLength }),
    size,
  };
  return demonstration;
}

/** `value` when it is a positive finite number, else `fallback`. */
function toPositive(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

/**
 * The body colour a hex boss demonstrates.
 *
 * The granted weapon's own bullet colour when the hex demonstrates a weapon
 * (Rule 2's visible cue); otherwise a deterministic palette colour keyed by the
 * authored boss name (or the hex id when unauthored), so the same hex always
 * looks the same across sessions and replays.
 *
 * @param definition — the authored hex definition, or `null`.
 * @param hexId — the hex id (fallback identity).
 * @returns the body colour.
 */
export function hexBossBodyColor(
  definition: HexRingDefinition | null | undefined,
  hexId: string,
): number {
  const grant = resolveHexGrant(definition?.grants);
  if (grant !== null && grant.weaponId !== null) {
    return BULLET_COLORS[grant.weaponId];
  }
  const key = definition?.boss ?? hexId;
  return FALLBACK_BOSS_PALETTE[hashString(key) % FALLBACK_BOSS_PALETTE.length];
}

/**
 * Builds the hex boss profile the deployment's boss encounter runs with.
 *
 * @param hex — the target hex (id + aggression at deployment time).
 * @param definition — the authored hex definition, or `null`/`undefined` when
 *   the hex is unknown (a total fallback: no grant, palette colour, the
 *   aggression-selected difficulty).
 * @param maxLevel — campaign maximum (defaults to the shipped `MAX_LEVEL`).
 * @returns the profile the scene maps onto `BossConfig`.
 */
export function buildHexBossProfile(
  hex: HexBossSource,
  definition: HexRingDefinition | null | undefined,
  maxLevel: number = MAX_LEVEL,
): HexBossProfile {
  const hexId = typeof hex?.id === 'string' && hex.id.trim() !== '' ? hex.id : 'hex-unknown';
  const difficulty = hexDifficultyProfile(toCount(hex?.aggression), maxLevel);
  const grant = resolveHexGrant(definition?.grants);
  const demonstratedColor =
    grant !== null && grant.weaponId !== null
      ? BULLET_COLORS[grant.weaponId]
      : null;
  const bodyColor = hexBossBodyColor(definition, hexId);

  return {
    hexId,
    bossName: definition?.boss ?? null,
    aggression: difficulty.aggression,
    startLevel: difficulty.level,
    hpMultiplier: difficulty.bossHpMultiplier,
    bodyColor,
    desperationColor: lighten(bodyColor, 0.45),
    grant,
    demonstratedColor,
    demonstration: hexBossDemonstration(grant),
    phaseCount: HEX_BOSS_PHASE_COUNT,
    difficulty,
  };
}
