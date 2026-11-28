/**
 * Hangar-war deployment launch contract (AH-0MVUXC2DD003HN0I, part of
 * **Build Candidate D — Hangar War**).
 *
 * A hex deployment is a **normal run at that hex's aggression** (design of
 * record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D, *The capture cycle*).
 * It plays **exactly one campaign level** — the level the hex's aggression
 * selects — and ends on that level's wave-5 **mini-boss** (GDD §8.2), which
 * resolves the capture; it is never a run to the campaign's final boss. This
 * module turns the persistent hangar payload into the launch data the shipped
 * `PlayScene` consumes:
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
 * ## The five-wave sortie (AH-0MWDCBVQ700579WS)
 *
 * A hex deployment does **not** play a level's full ten-wave campaign slice:
 * it plays the aggression-selected level's **first five waves** — four regular
 * waves, then the level's mini-boss on wave 5 — so taking a hex is a bounded
 * fight that still ends on the boss beat and grants the reward. The shipped
 * 10-wave arcade campaign (and its wave-10 mini-bosses) is untouched:
 * {@link truncateCampaignForDeployment} is a pure transform the scene applies
 * to the **resolved** campaign only when a deployment is active.
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
import { scaleShipConfigForHull } from '../../core/hangarWar/hullSpeed';
import { parseHangarWarPayload } from '../../core/hangarWar/hangarWarStore';
import type { LevelDefinition } from '../../waves/Formations';
import {
  findHangarEntry,
  hangarPermanentLevels,
  normalisePermanentLevels,
  ownedLevelBearingPowerUpLevels,
  resolveActiveHull,
  resolveActiveLoadout,
  type PermanentUpgradeLevels,
} from '../../core/hangarWar/hangarEconomy';
import type { HangarWarPayload, HexState } from '../../core/hangarWar/types';
import { deploymentAggressionFor, hexAggressionLevel } from '../../core/hangarWar/hexDifficulty';
import { capDropIdsToSlotPool } from '../../powerups/slots';
import {
  grantPermanentPowerUp,
  grantPermanentWeapon,
  type PermanentPowerUpRegistry,
} from '../../powerups/choiceReward';
import type { PowerUpId } from '../../powerups/types';
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
 * The number of waves a hex deployment plays per level (AH-0MWDCBVQ700579WS):
 * the level's first four regular waves, then the mini-boss on wave 5. A hex
 * sortie is a bounded five-wave fight that still ends on the boss beat and
 * grants the reward; the shipped 10-wave arcade campaign is unchanged.
 */
export const DEPLOYMENT_WAVE_COUNT = 5;

/**
 * Truncates a resolved campaign to the deployment's five-wave sortie: each
 * level keeps its first {@link DEPLOYMENT_WAVE_COUNT} waves and its final kept
 * wave becomes the level's mini-boss wave (`miniBoss: true`); a level with
 * fewer than five waves flags its last wave instead. Waves 1–4 keep their
 * authored content and never carry the `miniBoss` flag, so every level has
 * exactly one mini-boss encounter, deterministically.
 *
 * Pure and total: takes any resolved `LevelDefinition[]` (the static `LEVELS`
 * campaign or the sequenced `buildSequencedLevels` campaign alike), never
 * mutates the input, and changes battle **length only** — no group count,
 * shoot flag or difficulty value is touched. The arcade run never calls this
 * (there is no deployment), so its 10-wave mini-boss campaign is byte-for-byte
 * unchanged.
 *
 * @param campaign — the resolved campaign (never mutated).
 * @returns a fresh campaign truncated for a hex deployment.
 */
export function truncateCampaignForDeployment(
  campaign: readonly LevelDefinition[],
): LevelDefinition[] {
  return campaign.map((level) => {
    const waves = level.waves.slice(0, DEPLOYMENT_WAVE_COUNT);
    const miniBossIndex = waves.length - 1;
    return {
      ...level,
      waves: waves.map((wave, index) =>
        index === miniBossIndex
          ? { ...wave, miniBoss: true }
          : { ...wave, miniBoss: false },
      ),
    };
  });
}

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
  /**
   * The **permanent weapon levels** the deployment grants at run start, one row
   * per carried weapon (row vocabulary of `Player.getWeaponLevels()`).
   *
   * A weapon the hangar never upgraded carries level `1` — the base level of a
   * first collection — so the rows describe exactly what the run is armed with
   * (AH-0MWI5AG1X0007XZH AC3). Weapons outside the loadout are absent: a level
   * for a weapon the run never carries has nothing to strengthen.
   */
  readonly weaponLevels: readonly {
    readonly id: WeaponId;
    readonly level: number;
  }[];
  /**
   * The **permanent power-up levels** the deployment grants at run start (the
   * `Player.getPowerUpLevels()` twin of {@link weaponLevels}).
   *
   * Only level-bearing kinds appear: a consumable's charge pool and the
   * field-pickup-only kind carry no permanent level (AC5) and are never granted
   * as one.
   */
  readonly powerUpLevels: readonly {
    readonly id: PowerUpId;
    readonly level: number;
  }[];
  /** Permanent modifier ids applied to this deployment. */
  readonly modifiers: readonly string[];
  /**
   * The war payload the deployment was launched from (AH-0MVUXCBBK004EJIP).
   *
   * Carried so the run's between-sortie resolution (the capture cycle and the
   * frontier tick) works on **exactly** the war the map showed — including a
   * payload injected by a test, a capture or the attract traversal, which the
   * versioned store never sees. Optional: a deployment without it falls back to
   * the stored payload, so launch data from an older build still runs.
   */
  readonly payload?: HangarWarPayload;
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
 * clamp at the campaign bounds, never throwing. Delegates to the ring model's
 * {@link hexAggressionLevel}, so the map, the ring and a deployment all select
 * a difficulty the same way (one mapping, no second difficulty system).
 *
 * @param aggression — the target hex's aggression.
 * @returns a 1-based campaign level in `[1, MAX_LEVEL]`.
 */
export function deploymentLevelForAggression(aggression: number): number {
  return hexAggressionLevel(aggression, MAX_LEVEL);
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
 *
 * A modifier's other effects are deliberately **not** consumed here: a
 * `defence` modifier and owned `hull-upgrade` training both raise the fleet's
 * player strength (the hangar economy's `resolvePlayerStrength`) and a
 * `defence-skill` modifier trains the bot the capture cycle leaves in the hex —
 * none changes the run the player flies.
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
 * The carried weapons with their hangar-bought permanent level.
 *
 * A weapon the hangar never upgraded carries level `1` (the base level of a
 * first collection, the level the run starts at before any grant), so a
 * deployment always describes the exact permanent weapon levels the run starts
 * with (AH-0MWI5AG1X0007XZH AC3). A **bought** row is the absolute permanent
 * level and always exceeds the base: the economy's first purchase records
 * `2`, so the grant loop below raises the run's level by exactly one per
 * purchase (AH-0MWKV6F26008X1T3).
 */
function carriedWeaponLevels(
  startingWeapons: readonly WeaponId[],
  levels: PermanentUpgradeLevels,
): Array<{ id: WeaponId; level: number }> {
  const byId = new Map(levels.weapons.map((row) => [row.id as string, row.level]));
  return startingWeapons.map((id) => ({ id, level: byId.get(id) ?? 1 }));
}

/**
 * Builds the launch data for one hex deployment (pure).
 *
 * Resolution order follows the economy: the active hull/loadout come from
 * `resolveActiveHull`/`resolveActiveLoadout`, so corrupt saves can never
 * deploy an unowned ship or an unowned weapon, and the aggression comes from
 * the target hex **plus the ring's own capture-progress ramp** (see
 * {@link selectDeploymentHex} and {@link deploymentAggressionFor}): a fresh
 * ring deploys at its authored aggression, and every hex the player already
 * holds in that ring raises it, by up to `HEX_AGGRESSION_RAMP_PER_RING` across
 * the whole ring and bounded by the frontier ceiling
 * (AH-0MWFDQ9EY004NO4X). An empty loadout resolves
 * to `startingWeapons: []`: the run then starts with only the ship's permanent
 * cannon (AH-0MVZJ6V1J001DA9D).
 *
 * The hangar's bought **permanent levels** (AH-0MWI5AG1X0007XZH) travel with
 * the loadout: `weaponLevels` names one row per carried weapon (base `1` when
 * the hangar never upgraded it, the bought absolute level otherwise) and
 * `powerUpLevels` carries the **selected** level-bearing power-ups (the
 * `activeLoadout.powerUps` tri-state — absent installs every owned kind, `[]`
 * installs none, a list installs exactly those), so
 * {@link applyHangarWarDeployment} can grant exactly the levels the player
 * bought and chose to install.
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
  // The ring's progress ramp (AH-0MWFDQ9EY004NO4X): the target hex's authored
  // aggression plus one point per hex already held in the same ring. The rule
  // lives in the shared difficulty module, so the game and the ring-timing
  // harness resolve a deployment's aggression identically.
  const heldInRing = payload.ring.hexes.filter((entry) => entry.held).length;
  const aggression = deploymentAggressionFor(
    toCount(hex?.aggression ?? DEFAULT_DEPLOYMENT_AGGRESSION),
    heldInRing,
    payload.ring.hexes.length,
  );
  const startLevel = deploymentLevelForAggression(aggression);
  const hullId = resolveActiveHull(payload.hangar);
  const hull = resolveHullDefinition(hullId, catalogue);
  const loadout = resolveActiveLoadout(payload.hangar, catalogue);
  const startingWeapons = resolveStartingWeapons(loadout.startingWeapons, catalogue);
  const levels = hangarPermanentLevels(payload.hangar);
  // The selected power-ups are the deployment's grant list (tri-state: absent =
  // every owned level-bearing kind, `[]` = none, a list = exactly those). Each
  // selected id carries its permanent level (base `1` when never upgraded).
  const powerUpLevelsById = new Map(
    ownedLevelBearingPowerUpLevels(payload.hangar).map((row) => [
      row.id as string,
      row.level,
    ]),
  );
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
    startingWeapons,
    weaponLevels: carriedWeaponLevels(startingWeapons, levels),
    powerUpLevels: (loadout.powerUps ?? []).map((id) => ({
      id: id as PowerUpId,
      level: powerUpLevelsById.get(id) ?? 1,
    })),
    modifiers: [...loadout.modifiers],
    // A detached copy: the run resolves captures/ticks against this war, and a
    // caller must never see its own payload mutated by a deployment.
    payload: JSON.parse(JSON.stringify(payload)) as HangarWarPayload,
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
 * One stored level list as raw rows, or `[]` when the list is not a list.
 *
 * Only the row *shape* is read here; ids and levels stay unvalidated so the
 * shared economy normaliser is the one authority on which rows survive and how
 * a level is clamped (a `null` entry must never reach `row.level`).
 */
function toRawLevelRows(value: unknown): Array<{ id: unknown; level: unknown }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
    )
    .map((entry) => ({ id: entry.id, level: entry.level }));
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
 * The permanent-level rows are normalised through the shared economy
 * normaliser, so launch data can never grant a consumable/field-pickup-only or
 * out-of-range level even when it was produced by another build
 * (AH-0MWI5AG1X0007XZH AC3/AC5).
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
  const levels = normalisePermanentLevels({
    weapons: toRawLevelRows(raw.weaponLevels),
    powerUps: toRawLevelRows(raw.powerUpLevels),
  });
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
    weaponLevels: levels.weapons,
    powerUpLevels: levels.powerUps,
    modifiers: toStringList(raw.modifiers),
    // The carried war payload is parsed with the store's own defensive parser,
    // so a corrupt one degrades to "no payload" (the run then falls back to the
    // stored war) rather than rejecting an otherwise usable deployment.
    payload: parseHangarWarPayload(raw.payload) ?? undefined,
  };
}

/** The narrow player surface a deployment applies to (kept structural). */
export interface HangarWarDeploymentPlayer {
  /** Grants (`permanent`) a weapon through the shipped player seam. */
  equipWeapon(id: WeaponId, permanent?: boolean): void;
  /**
   * Grants (`permanent`) a power-up level through the player's own store.
   *
   * Optional: it is only the **no-registry** fallback (a pure caller that has
   * no HUD/effect seam). The shipped player always has it, and the game always
   * supplies a registry, so this is never a silent gap in play.
   */
  collectPowerUp?(id: PowerUpId, permanent?: boolean): number;
}

/**
 * The narrow effect-registry surface a deployment grants through (kept
 * structural, so this module stays Phaser-free).
 *
 * Structurally satisfied by the scene's `EffectsRegistry`: registering the
 * grant is what makes the HUD render a weapon row, exactly as a hold-full
 * permanent reward does (AH-0MVSHI07B003BZIP).
 */
export interface HangarWarDeploymentRegistry {
  /** Registers (`permanent`) a weapon in the run's effect state. */
  applyWeapon(id: WeaponId, permanent?: boolean): boolean;
  /**
   * Registers (`permanent`) a power-up level in the run's effect state.
   *
   * Optional so a weapon-only harness (or launch data from a build without
   * power-up upgrades) stays valid; without it a deployment's power-up levels
   * are not granted, exactly as before this seam existed.
   */
  applyCollect?(id: PowerUpId, permanent?: boolean): void;
}

/** The seams a deployment is applied through (no scene internals leak out). */
export interface HangarWarDeploymentSeams {
  /** The run's player, or `null` when it has not spawned yet. */
  getPlayer(): HangarWarDeploymentPlayer | null;
  /** Sets the run's starting lives (the hull + modifier result). */
  setStartingLives?(lives: number): void;
  /**
   * The run's effect registry, or `null` when it has none.
   *
   * Optional: a pure caller (one that renders no HUD, e.g. the headless
   * harness) keeps today's player-only behaviour. When supplied, every
   * starting weapon is granted through the shared `grantPermanentWeapon`
   * seam, so the registry and the player can never drift apart and the HUD
   * upgrade list shows what the run actually deployed with.
   */
  getEffectsRegistry?(): HangarWarDeploymentRegistry | null;
}

/**
 * Scales the shared ship config by the deployment hull's speed multiplier.
 *
 * The hull's run stat is applied to the **base** tuning the ship flies with.
 * Because Speed Boost is weapons-only and no longer scales movement
 * (AH-0MWLU8A7P001O391), the hull stat is the ship's movement tuning for the
 * whole run: a slower hull stays slower regardless of any active power-up
 * instead of having its hull stat overwritten.
 *
 * The arithmetic itself is the shared {@link scaleShipConfigForHull} helper, so
 * the headless ring-timing harness applies a hull exactly as a shipped
 * deployment does (AH-0MW9QA2YC009PSF5).
 *
 * @param config — the shipped/selected ship config (never mutated).
 * @param deployment — the deployment supplying the hull multiplier.
 * @returns a fresh config with thrust and speed caps scaled.
 */
export function applyHullSpeedToShipConfig(
  config: ShipConfig,
  deployment: HangarWarDeployment,
): ShipConfig {
  return scaleShipConfigForHull(config, deployment.speedMultiplier);
}

/**
 * The combined weapon + power-up ids a deployment actually admits under the
 * shared six-slot cap, in grant order (weapons first, then power-ups).
 *
 * This is the **one** cap predicate the grant and the hangar screen both use:
 * `applyHangarWarDeployment` grants exactly these ids, and
 * `buildHangarPowerUpOptions` marks a row installed only when it appears here,
 * so the displayed loadout can never differ from the flown one (assumption A3,
 * AH-0MVVF0POV001JNKX).
 *
 * @param deployment — the deployment to trim (never mutated).
 * @returns the admitted ids in grant order.
 */
export function admittedDeploymentDropIds(
  deployment: HangarWarDeployment,
): string[] {
  return capDropIdsToSlotPool([
    ...deployment.startingWeapons,
    ...deployment.powerUpLevels.map((row) => row.id),
  ]);
}

/**
 * Applies a deployment to play state through existing shared seams: the
 * hull's starting lives, the carried weapons and the hangar's bought
 * **permanent levels**.
 *
 * When the scene supplies an effect registry, every grant goes through the
 * **one shared permanent-grant seam** (`grantPermanentWeapon` /
 * `grantPermanentPowerUp`), the same helpers the hold-full reward and the
 * checkpoint-resume replay use, so the HUD upgrade list, the player's
 * run-scoped levels and the effect state can never drift apart
 * (AH-0MWCFKHWD002RKX9, precedent AH-0MVSHI07B003BZIP). Without a registry
 * seam the grant stays player-only (today's behaviour for pure callers), so no
 * caller breaks. The hull's speed scales the ship config at spawn
 * ({@link applyHullSpeedToShipConfig}). Total: a scene without a player still
 * applies the lives.
 *
 * **Permanent levels (AH-0MWI5AG1X0007XZH AC3).** A carried weapon is granted
 * its `weaponLevels` row (base `1`, higher when the hangar sold an upgrade) and
 * every `powerUpLevels` row is granted, each by applying the permanent-grant
 * seam once per level — the same way a run earns a level. So
 * `Player.getWeaponLevels()` / `getPowerUpLevels()` read the bought levels and
 * the victory-time capture snapshot (which reads those accessors) carries them
 * onto the defending bot with **no capture-side change**. Only permanent grants
 * are made: no temporary/timed stack is ever opened, so
 * `getTempWeaponIds()`/`getTempPowerUpIds()` stay empty.
 *
 * **The six-slot cap holds here too (AH-0MVVF0POV001JNKX).** A hangar loadout
 * may contain more owned weapons than the run can hold, so the combined list
 * (weapons then power-ups) is trimmed through the shared
 * `capDropIdsToSlotPool` predicate before granting: a deployment can never
 * start a run above `POWER_UP_SLOT_CAP` distinct counted kinds, however many
 * weapons and upgraded power-ups the fleet owns (parent AH-0MVLIJT3M005HPHF).
 *
 * @param seams — the scene's player, lives and (optional) effect-registry
 *   seams.
 * @param deployment — the deployment to apply.
 */
export function applyHangarWarDeployment(
  seams: HangarWarDeploymentSeams,
  deployment: HangarWarDeployment,
): void {
  seams.setStartingLives?.(deployment.startingLives);
  const player = seams.getPlayer();
  // Lives apply first, and a scene with no player still applies them; the
  // grants follow only once the player exists.
  if (!player) return;
  const registry = seams.getEffectsRegistry?.() ?? null;
  // The power-up half of the seam is optional, so bind it once and hand the
  // shared grant helper a structural registry (no concrete scene type leaks
  // into this Phaser-free module).
  const powerUpRegistry: PermanentPowerUpRegistry | null = registry?.applyCollect
    ? { applyCollect: registry.applyCollect.bind(registry) }
    : null;

  const weaponLevels = new Map<string, number>(
    deployment.weaponLevels.map((row) => [row.id, row.level]),
  );
  const carried = new Set<string>(deployment.startingWeapons);
  const powerUpLevels = new Map<string, number>(
    deployment.powerUpLevels.map((row) => [row.id, row.level]),
  );

  // One cap for the whole pre-grant list: the six slots are shared between
  // weapon and power-up kinds, so a deployment can never start a run over the
  // cap. Weapons come first, preserving today's trimming order. The hangar
  // screen reads the same helper, so display equals grant.
  const admitted = admittedDeploymentDropIds(deployment);

  for (const id of admitted) {
    if (carried.has(id)) {
      const level = weaponLevels.get(id) ?? 1;
      for (let step = 0; step < level; step += 1) {
        if (registry) {
          // One permanent-grant seam: the registry supplies the HUD row and the
          // player raises the run-scoped level (AH-0MWCFKHWD002RKX9).
          grantPermanentWeapon(id as WeaponId, registry, player);
        } else {
          // No registry seam (pure caller / older launch data): today's
          // player-only grant, so the function stays total.
          player.equipWeapon(id as WeaponId, true);
        }
      }
      continue;
    }
    const level = powerUpLevels.get(id) ?? 0;
    if (level < 1) continue;
    for (let step = 0; step < level; step += 1) {
      if (powerUpRegistry) {
        grantPermanentPowerUp(id as PowerUpId, powerUpRegistry);
      } else {
        // No effect seam: the player's own store still records the permanent
        // level (the shipped player always exposes it).
        player.collectPowerUp?.(id as PowerUpId, true);
      }
    }
  }
}
