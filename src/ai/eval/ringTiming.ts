/**
 * Headless ring-timing harness — measures a Hangar War ring's play time and
 * playstyle trade-off instead of guessing them
 * (AH-0MVUXCBQY001ESWT, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D —
 * § *Session shape* ("the **one-ring MVP targets 40–60 minutes** … **Ring 2 is
 * larger — 12 hexes** — so it lands at … **≈90–120 minutes**") and
 * § *Playstyles supported* ("the aggressive line is **faster but riskier** and
 * slow grinding is **safer but slower**").
 *
 * ## What is measured, what is modelled
 *
 * A deployment is "one hex, one level": the mini-boss ending
 * (AH-0MWBW1B1Z0059CC2) turns a deployment into exactly **one campaign
 * level**, played as the shipped **five-wave sortie** — the level's first
 * four regular waves plus its wave-5 mini-boss composition, truncated with
 * the same pure helper the game uses (`truncateCampaignForDeployment` /
 * `DEPLOYMENT_WAVE_COUNT` in `src/scenes/hangarWar/hangarDeployment.ts`,
 * never a hard-coded 5 or 10). This harness reproduces exactly that in the
 * headless arena — {@link runArena} in **per-level mode** at the hex's
 * aggression-selected level, playing the deployment's wave set from the
 * truncation seam {@link ArenaConfig.levelDefinition} — and measures each
 * deployment's **duration from the arena's `level_cleared` event tick**
 * (`level_cleared.tick × dt`): the deployment ends the moment the sortie
 * clears, never at the tick-loop's end. Nothing in the measurement is
 * invented: the aggression → level mapping is the shipped
 * `hexDifficultyProfile`, the wave set is the shipped level data through the
 * game's own truncation, and the difficulty comes from the shipped
 * `difficulty-curves.csv`.
 *
 * **The income view (AH-0MWCOWTOR00994NA) plays the shipped sortie.** The game
 * now ships a hex deployment as the aggression-selected level's **five-wave
 * sortie** (four regular waves plus the wave-5 mini-boss,
 * `truncateCampaignForDeployment` / `DEPLOYMENT_WAVE_COUNT`,
 * AH-0MWDCBVQ700579WS), so per-deployment income is measured with
 * {@link createOneLevelArenaDeploymentRunner} — the same flow through
 * {@link runArena}, with the single truncated level as the arena's campaign.
 * A captured sortie banks exactly **one core** plus the minerals held at its
 * mini-boss checkpoint (`src/core/hangarWar/captureCycle.ts` /
 * `src/core/hangarWar/salvageBanking.ts`), which the reporter derives as
 * {@link derivePerDeploymentIncome} and {@link deriveUnlockPace}. The duration
 * runner ({@link createArenaDeploymentRunner}) now plays the same one-level
 * deployment — this item's change (AH-0MWCOWSVN003X81A chain) re-pointed it
 * from the campaign slice to the per-level sortie — so both runners measure
 * one hex, one level, and the two chains share the income numbers rather than
 * forking a second harness.
 *
 * Around the measured deployments the harness models the parts of a real
 * session the arena cannot see, and states every one of them as an explicit
 * default:
 *
 * - **Between-sortie time** ({@link DEFAULT_BETWEEN_SORTIE_MINUTES}) — hangar
 *   shopping, salvage banking, the map and the defence report between runs.
 * - **Retries** ({@link DEFAULT_RETRIES_PER_LOSS}) — a deployment that ends
 *   before its level cleared (the player died) is a **loss**; the model
 *   charges one modelled retry per loss, because a real player replays rather
 *   than giving up. The retry **replays the same deployment**, so it costs
 *   that deployment's own **measured length** (`measuredMinutes ×
 *   retriesPerLoss`) — never a flat window.
 * - **Exposure** ({@link DEFAULT_RETAKE_CHANCE_PERCENT}) — the **rush** line
 *   pushes into the next ring with the current one only partly held, so every
 *   unheld hex is exposed to the frontier. Each exposed hex costs its expected
 *   re-capture work (`chance × (the line's measured mean deployment +
 *   between-sortie)`); the chance comes from the shipped frontier clock's
 *   attack chance (`DEFAULT_FRONTIER_TUNING.attackChancePercent`).
 *
 * ## The starting loadout (AH-0MW9QA2YC009PSF5)
 *
 * A real deployment does not launch from the campaign's bare state: the hangar
 * resolves a **loadout** first (`src/scenes/hangarWar/hangarDeployment.ts`) —
 * the active hull's run stats (starting lives, movement speed), the weapons the
 * fleet has selected and the permanent modifiers whose effect the deployment
 * path models. The harness measures each ring's deployments with the loadout a
 * player *owns at that point*, resolved from the shipped data
 * ({@link HANGAR_CATALOGUE}, `resolveHexGrant`, {@link hexRingDefinitionsFor})
 * rather than a hardcoded item list:
 *
 * - **Entering ring 1** — the starter kit: hull `hull-1` and no equipped
 *   weapons. The starter `spread` is owned but **not selected**, so the run
 *   starts with the bare cannon, exactly like a fresh fleet
 *   (AH-0MVZJ6V1J001DA9D).
 * - **Within a ring** — the line plays its hexes weakest-aggression first; a
 *   **captured** hex's grant is owned from the next deployment (weapons to the
 *   equipped set, hulls and upgrades through `resolveHexGrant`), so the later
 *   deployments of the same ring launch with it. A **lost** deployment grants
 *   nothing — the retry replays the same hex with the same loadout.
 * - **Entering ring *n*** — the starter kit plus every grant of the previous
 *   rings, earned in the same plan order (ring 2: the `ricochet`, `rapid` and
 *   `wave_laser` weapons, the `hull-2` hull, `hardened_plating`, and the
 *   effect-free `core-bank` modifier).
 * - **Equip convention (deterministic)** — every owned weapon is equipped
 *   (trimmed by the shipped `capDropIdsToSlotPool` six-slot cap), the
 *   **strongest owned hull** is active (most starting lives, then speed), and
 *   every owned `extra-lives` modifier is applied, capped at `MAX_LIVES`. A
 *   grant the catalogue does not itemise (`hull-3`, `rapid`, `core-bank`) is
 *   owned but contributes no run stats — the same "recorded but effect-free"
 *   rule the shipped capture cycle uses.
 *
 * The loadout is an **explicit model input** ({@link
 * RingTimingOptions.ownership}, default {@link ringEntryOwnership}) and reaches
 * the arena through {@link ArenaStartingLoadout}, so the seam is stated rather
 * than hidden. It changes the *starting* state only: the aggression model, the
 * deployment window and every retry/exposure allowance are unchanged.
 *
 * ## The two lines
 *
 * - **grind** — secure the ring before pushing: every hex, **weakest
 *   aggression first** (the single weapon hex is the ring's hardest, so it is
 *   taken last). Slower, but the ring is secured and the rear is never exposed.
 * - **rush** — take the **weapon hex first**, then push into the next ring with
 *   the rest of this ring unheld. Faster (one deployment in this ring), but the
 *   unheld hexes are exposed and the ring is not secured.
 *
 * Neither line dominates: the comparison reports minutes **and** losses,
 * forfeited salvage, secured-ness and exposure for both, so "faster but
 * riskier" is a measured claim rather than an assertion.
 *
 * ## Determinism
 *
 * Every draw is the arena's seeded stream and every model input is explicit, so
 * the same options (same seeds, same hexes, same allowances) produce an
 * identical report. The harness never reads the wall clock.
 *
 * ## Budgets
 *
 * {@link RING_TIMING_TARGETS} holds the design's windows (ring 1: 40–60 min,
 * ring 2: 90–120 min) and {@link RING_TIMING_TOLERANCE_PERCENT} the stated
 * tolerance: a measurement within `tolerancePercent` of the window's width
 * outside it still passes ({@link RingTimingBudgetVerdict}). The comparison
 * target is the **grind** line, because that is the line that actually secures
 * the ring; a rush segment is reported `not-applicable` for the budget.
 *
 * ## Fidelity boundary
 *
 * The arena's per-level run is the best headless proxy for a deployment, not
 * a human playtest (intake assumption A1 / Q4). It models the run's survival
 * (the five-wave sortie's kills, the enemy fire and the player's deaths)
 * but not a human's piloting, and it models the **one level only**: the
 * deployment ends on the wave-5 composition clear (`level_cleared`), and the
 * mini-boss encounter's own duration — the boss fight itself, still missing
 * from the arena's campaign simulation — is **not** modelled (the fidelity
 * gap the parent records). The per-level arena also ignores the wave
 * `shootEnabled` gate (its documented fidelity boundary), so even a level 1–3
 * sortie faces enemy fire in the headless run. A deployment's
 * **captured/lost** verdict is the `level_cleared` signal, and the modelled
 * retry allowance covers the player's persistence.
 *
 * The **one-level income runner** (AH-0MWCOWTOR00994NA) plays the same sortie
 * through the arena's **full-campaign** mode (one truncated level as the
 * campaign), which honours the wave `shootEnabled` gate and so models the
 * level 1–3 no-fire opening. It adds one boundary of its own: a sortie the bot
 * can neither wipe (no `level_cleared`/boss trigger) nor die within the 300 s
 * deployment window is recorded as a **loss** — the same tick-cap safety
 * bound, not a new rule. `captured` for that runner means the sortie's
 * mini-boss was wiped (the arena's `won` in full-campaign mode), so exactly one
 * core is banked per capture. Both runners play the game's own truncated wave
 * set and share the income fields.
 * The campaign segment is measured from each ring's **authored base
 * aggressions** (the numbers the map publishes); the frontier's between-sortie
 * rise is a separate risk mechanic (B3/B6), and {@link
 * RingTimingOptions.aggressionRisePerSortie} exists as an explicit sensitivity
 * knob (default `0`) rather than a hidden assumption.
 *
 * @module src/ai/eval/ringTiming
 */

import { DEFAULT_LIVES, MAX_LIVES } from '../../core/GameState';
import { DEFAULT_FRONTIER_TUNING } from '../../core/hangarWar/hexDefence';
import { hexDifficultyProfile } from '../../core/hangarWar/hexDifficulty';
import { generateRing, type HexRingDefinition } from '../../core/hangarWar/hexRing';
import { resolveHexGrant } from '../../core/hangarWar/captureCycle';
import { hexRingDefinitionsFor } from '../../data/hexRingDefinitions';
import {
  CORE_MINERAL_EQUIVALENT,
  findHangarEntry,
} from '../../core/hangarWar/hangarEconomy';
import {
  HANGAR_CATALOGUE,
  STARTER_HULL_ID,
  type HangarEntry,
  type HangarPrice,
  type HullDefinition,
} from '../../data/hangarCatalogue';
import { capDropIdsToSlotPool } from '../../powerups/slots';
import type { WeaponId } from '../../utils/weapons';
import { truncateCampaignForDeployment } from '../../scenes/hangarWar/hangarDeployment';
import { getLevelDefinition, type LevelDefinition } from '../../waves/Formations';
import { buildArenaCampaign, campaignFromLevel, runArena } from './arena';
import { loadBalanceConfig } from './balanceConfig';
import { resolvePolicyFactory } from './policies';
import type { PolicyFactory } from './engine';
import {
  DEFAULT_BATCH_TICKS,
  type ArenaBalanceConfig,
  type TelemetryRecord,
} from './types';

/** The two playstyle lines the harness compares. */
export const RING_TIMING_STRATEGIES = Object.freeze([
  'grind',
  'rush',
] as const);

/** A playstyle line: `grind` secures the ring, `rush` pushes past it. */
export type RingTimingStrategy = (typeof RING_TIMING_STRATEGIES)[number];

/**
 * A deployment run's tick cap — the arena's safety bound. The run ends
 * earlier on the sortie's clear or the player's death; the cap only bounds a
 * stalled run. Retired as a *price*: a retry and a re-capture now cost the
 * measured deployment (see the module doc), never this window.
 */
export const RING_DEPLOYMENT_TICKS = DEFAULT_BATCH_TICKS;

/** Fixed simulation step (the arena default, ~60 fps). */
export const DEFAULT_RING_TIMING_DT = 1 / 60;

/**
 * Modelled between-sortie time in minutes: hangar shopping, salvage banking,
 * the map and the defence report between two runs.
 */
export const DEFAULT_BETWEEN_SORTIE_MINUTES = 2;

/** Modelled retries charged for one lost deployment (the player replays). */
export const DEFAULT_RETRIES_PER_LOSS = 1;

/**
 * Chance (percent) that an exposed (unheld) hex is retaken by the frontier
 * before the line comes back for it. Defaults to the shipped frontier clock's
 * attack chance, so the model uses the game's own risk number.
 */
export const DEFAULT_RETAKE_CHANCE_PERCENT =
  DEFAULT_FRONTIER_TUNING.attackChancePercent;

/** The design's play-time windows for a ring, in minutes. */
export interface RingTimingTarget {
  /** Fastest acceptable play time (minutes). */
  readonly minMinutes: number;
  /** Slowest acceptable play time (minutes). */
  readonly maxMinutes: number;
}

/**
 * The design's ring budgets (`docs/OUTER_LOOP_CANDIDATES.md` § Session shape):
 * the one-ring MVP is an evening's play at 40–60 minutes, and ring 2 (12 hexes)
 * lands at ≈90–120 minutes.
 *
 * Ring 2 was recalibrated from ≈70–100 to ≈90–120 after the wrap-aware bot
 * (AH-0MVMISF0Q00314LG): on the wrap-parity arena the competent bot survives
 * roughly 2–3 minutes per lost deployment instead of dying in under a minute,
 * so the measured grind rose from ≈91.6 minutes to the committed **116.4
 * minutes** (measured with the deployment loadout a ring-2 player actually
 * launches, AH-0MW9QA2YC009PSF5). The loss-dominated ring-2 retry allowance is
 * the same documented follow-up risk; only the deployment duration and the
 * modelled loadout changed.
 */
export const RING_TIMING_TARGETS: Readonly<Record<number, RingTimingTarget>> =
  Object.freeze({
    1: Object.freeze({ minMinutes: 40, maxMinutes: 60 }),
    2: Object.freeze({ minMinutes: 90, maxMinutes: 120 }),
  });

/**
 * The **stated tolerance** the budget assertion allows: a measurement within
 * this percentage of the window's width outside the window still passes. For
 * ring 1 (20-minute window) that is ±2 minutes; for ring 2 (30-minute window)
 * ±3 minutes.
 */
export const RING_TIMING_TOLERANCE_PERCENT = 10;

/** One weapon a deployment launches with. */
export interface RingLoadoutWeapon {
  /** The shipped weapon id (`src/utils/weapons.ts`). */
  readonly id: WeaponId;
  /**
   * The permanent-grant count the run starts with: `1` fires the weapon at its
   * base stats (one `Player.equipWeapon(id, true)`), each further grant raises
   * its upgrade index by one.
   */
  readonly ownedLevel: number;
}

/**
 * The fleet ownership the loadout model grows as hexes are captured.
 *
 * Plain data, in earned order: `hulls` / `weapons` / `modifiers` hold the ids
 * the fleet owns at that point in the ring's plan. The starter `spread` is
 * deliberately absent — it is owned but not selected (AH-0MVZJ6V1J001DA9D).
 */
export interface RingLoadoutOwnership {
  /** Owned hull ids, in earned order (the starter hull first). */
  readonly hulls: readonly string[];
  /** Selected (equipped) shipped weapon ids, in earned order. */
  readonly weapons: readonly string[];
  /** Owned modifier ids (including effect-free upgrades), in earned order. */
  readonly modifiers: readonly string[];
}

/** What one deployment launches with (the resolved loadout). */
export interface RingDeploymentLoadout {
  /** The active hull's id (the strongest owned, itemised hull). */
  readonly hullId: string;
  /** Lives the run starts with (hull + `extra-lives` modifiers, ≤ `MAX_LIVES`). */
  readonly lives: number;
  /** Movement-speed multiplier applied to the shared ship config. */
  readonly speedMultiplier: number;
  /** Equipped weapons in fire order after the always-active cannon. */
  readonly weapons: readonly RingLoadoutWeapon[];
  /** Owned modifiers (run effect only for `extra-lives`). */
  readonly modifiers: readonly string[];
  /** Every owned hull id, including grants the catalogue does not itemise. */
  readonly ownedHulls: readonly string[];
}

/** One deployment the harness asks a runner to play. */
export interface RingDeploymentRequest {
  /** Run seed (drives the arena scenario and the bot's input cadence). */
  readonly seed: number;
  /** The target hex's authored id. */
  readonly hexId: string;
  /** The hex's aggression at deployment time. */
  readonly aggression: number;
  /** The campaign level that aggression selected (the run's start level). */
  readonly level: number;
  /** Maximum ticks the deployment run may simulate. */
  readonly ticks: number;
  /** Fixed simulation step, seconds. */
  readonly dt: number;
  /** The resolved balance config the run consumes. */
  readonly balance: ArenaBalanceConfig;
  /** The loadout the deployment launches with. */
  readonly loadout: RingDeploymentLoadout;
}

/** What one deployment's arena run reported. */
export interface RingDeploymentResult {
  /**
   * Measured deployment length, seconds: the `level_cleared` event's tick ×
   * `dt` when the sortie cleared, else the death's tick × `dt` (the run's
   * final tick when it stalled). Never the tick loop's `ticksSimulated`.
   */
  readonly seconds: number;
  /**
   * Whether the level's five-wave sortie cleared: `level_cleared` was
   * observed. A death before the clear, or a lingering asteroid shadow-hazard
   * after it, never changes the verdict.
   */
  readonly captured: boolean;
  /** Minerals collected during the run (the salvage it earned). */
  readonly minerals: number;
  /** Times the player was hit (the run's loss pressure). */
  readonly hits: number;
}

/** Plays one deployment. Injectable so the model is testable without the arena. */
export type RingDeploymentRunner = (
  request: RingDeploymentRequest,
) => RingDeploymentResult;

/** Options for {@link simulateRingTiming}. */
export interface RingTimingOptions {
  /** The ring to measure (1 = the six hexes around the hangar). */
  readonly ringIndex: number;
  /** The playstyle line to measure. */
  readonly strategy: RingTimingStrategy;
  /** Run seeds to measure (default `[1]`); the summary aggregates them. */
  readonly seeds?: readonly number[];
  /** Deployment run window in ticks (default {@link RING_DEPLOYMENT_TICKS}). */
  readonly deploymentTicks?: number;
  /** Fixed simulation step (default {@link DEFAULT_RING_TIMING_DT}). */
  readonly dt?: number;
  /** Modelled between-sortie minutes (default 2). */
  readonly betweenSortieMinutes?: number;
  /** Modelled retries per lost deployment (default 1). */
  readonly retriesPerLoss?: number;
  /** Chance an exposed hex is retaken, percent (default the frontier's 70). */
  readonly retakeChancePercent?: number;
  /**
   * Aggression added per sortie already played in this ring (default `0`).
   * A sensitivity knob for the frontier's growth: `0` measures the ring from
   * its authored base aggressions, exactly as the design's budget arithmetic
   * does; a positive value shows how the frontier's rise lengthens the ring.
   */
  readonly aggressionRisePerSortie?: number;
  /** Bot policy (default the shipped `competent` brain). */
  readonly policy?: PolicyFactory;
  /** Resolved balance config (default the shared config store). */
  readonly balance?: ArenaBalanceConfig;
  /** Hex definitions to measure (default the authored ring for `ringIndex`). */
  readonly hexes?: readonly HexRingDefinition[];
  /** Injectable deployment runner (default {@link createArenaDeploymentRunner}). */
  readonly runDeployment?: RingDeploymentRunner;
  /**
   * The fleet ownership the line starts the ring with (default
   * {@link ringEntryOwnership}: the starter kit plus every previous ring's
   * grants). An explicit model input, so a caller can measure a different
   * earned state without editing the authored data.
   */
  readonly ownership?: RingLoadoutOwnership;
  /** The unlock tree to resolve grants/run stats against (default shipped). */
  readonly catalogue?: readonly HangarEntry[];
}

/** One deployment as the line played it. */
export interface RingTimingDeployment {
  /** The target hex's authored id. */
  readonly hexId: string;
  /** The hex's aggression when the line deployed to it. */
  readonly aggression: number;
  /** The campaign level the aggression selected. */
  readonly level: number;
  /** Measured arena duration, seconds (the `level_cleared` tick × `dt`). */
  readonly seconds: number;
  /**
   * Whether the hex was taken. The one-level deployment runners count the
   * sortie's five-wave composition clearing: `level_cleared` for
   * {@link createArenaDeploymentRunner} (per-level mode), the arena's `won`
   * for {@link createOneLevelArenaDeploymentRunner} (full-campaign mode).
   */
  readonly captured: boolean;
  /** Minerals the run collected (banked only when captured). */
  readonly minerals: number;
  /** Times the player was hit during the run. */
  readonly hits: number;
  /** Modelled retries charged for this deployment (`0` when captured). */
  readonly retries: number;
  /**
   * Play time this deployment contributes, minutes: the measured length plus
   * `retries ×` the same measured length (a retry replays the deployment).
   */
  readonly minutes: number;
  /** The loadout this deployment launched with. */
  readonly loadout: RingDeploymentLoadout;
}

/** One seed's measurement of a ring for one strategy. */
export interface RingTimingRun {
  /** The run seed. */
  readonly seed: number;
  /** Deployments in the order the line played them. */
  readonly deployments: readonly RingTimingDeployment[];
  /** Sum of the measured arena durations, minutes. */
  readonly deploymentMinutes: number;
  /** Modelled between-sortie time, minutes. */
  readonly betweenSortieMinutes: number;
  /** Modelled retry time for lost deployments, minutes (the measured replay). */
  readonly retryMinutes: number;
  /** Modelled expected re-capture work for exposed hexes, minutes. */
  readonly retakeMinutes: number;
  /** Total modelled play time, minutes. */
  readonly totalMinutes: number;
  /** Deployments whose five-wave sortie cleared. */
  readonly captured: number;
  /** Deployments whose run ended before the clear (the line's losses). */
  readonly losses: number;
  /** Expected retakes of exposed hexes (a modelled count). */
  readonly expectedRetakes: number;
  /**
   * The line's expected losses: the failed first attempts plus the expected
   * retakes of its exposed hexes. A composite pressure metric — it is **not**
   * the playstyle risk discriminator, because a lost first attempt is retried
   * and a grind still ends with the ring secured. The discriminator is
   * exposure ({@link exposedHexes} / {@link expectedRetakes}) together with
   * whether the ring ends secured.
   */
  readonly expectedLosses: number;
  /** Hexes left unheld when the line pushed on (`0` for a grind). */
  readonly exposedHexes: number;
  /** Minerals banked by captured deployments. */
  readonly salvageBanked: number;
  /** Minerals forfeited by lost deployments. */
  readonly salvageForfeited: number;
  /**
   * Cores banked by captured deployments — one core per defeated mini-boss
   * checkpoint. A captured **one-level** deployment defeated exactly its one
   * mini-boss, so `salvageCores` equals `captured` for both one-level runners
   * ({@link createArenaDeploymentRunner}'s `level_cleared` and
   * {@link createOneLevelArenaDeploymentRunner}'s `won`).
   */
  readonly salvageCores: number;
  /** Whether the line captured every hex of the ring. */
  readonly ringSecured: boolean;
}

/** min/mean/max over a metric across the measured seeds. */
export interface RingTimingStats {
  /** Number of measured seeds. */
  readonly count: number;
  /** Arithmetic mean. */
  readonly mean: number;
  /** Smallest value. */
  readonly min: number;
  /** Largest value. */
  readonly max: number;
}

/** The budget verdict for one ring measurement. */
export interface RingTimingBudgetVerdict {
  /** False when the line does not secure the ring (a rush segment). */
  readonly applicable: boolean;
  /** The ring's design window, or `null` for an unauthored ring. */
  readonly target: RingTimingTarget | null;
  /** The stated tolerance, percent of the window's width. */
  readonly tolerancePercent: number;
  /** The stated tolerance, minutes. */
  readonly toleranceMinutes: number;
  /** The measured play time the verdict judges (the mean total), minutes. */
  readonly measuredMinutes: number;
  /** Whether the mean total is inside the design window. */
  readonly withinWindow: boolean;
  /** Whether the mean total is inside the window plus its stated tolerance. */
  readonly withinTolerance: boolean;
  /** The verdict: in-window, within-tolerance, missed, or not-applicable. */
  readonly verdict: 'in-window' | 'within-tolerance' | 'missed' | 'not-applicable';
}

/** Aggregated summary across the measured seeds. */
export interface RingTimingSummary {
  /** Total play time, minutes. */
  readonly totalMinutes: RingTimingStats;
  /** Measured deployment time, minutes. */
  readonly deploymentMinutes: RingTimingStats;
  /** Lost deployments (failed runs). */
  readonly losses: RingTimingStats;
  /** Expected losses (failed attempts plus expected retakes). */
  readonly expectedLosses: RingTimingStats;
  /** Banked salvage (minerals). */
  readonly salvageBanked: RingTimingStats;
  /** Banked mini-boss cores (one per captured deployment). */
  readonly salvageCores: RingTimingStats;
  /** Captured deployments. */
  readonly captured: RingTimingStats;
  /** Seeds whose line secured the ring. */
  readonly ringSecuredRuns: number;
}

/** The complete measurement of one ring for one strategy. */
export interface RingTimingReport {
  /** The measured ring. */
  readonly ringIndex: number;
  /** The measured playstyle line. */
  readonly strategy: RingTimingStrategy;
  /** The seeds measured (in input order). */
  readonly seeds: readonly number[];
  /** One measurement per seed. */
  readonly runs: readonly RingTimingRun[];
  /** Aggregated metrics across the seeds. */
  readonly summary: RingTimingSummary;
  /** The budget verdict for the mean total. */
  readonly budget: RingTimingBudgetVerdict;
  /** The loadout the line entered the ring with (before earning any grant). */
  readonly entryLoadout: RingDeploymentLoadout;
}

/** `value` when it is a finite positive number, else `fallback`. */
function positiveOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

/** `value` as a non-negative whole number; anything unusable is `0`. */
function nonNegativeOr(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const integer = Math.trunc(value as number);
  return integer < 0 ? 0 : integer;
}

/** `value` clamped to `[0, 100]`. */
function percentOr(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(100, Math.max(0, value as number));
}

/** min/mean/max for a metric series; all zeros for an empty series. */
function stats(values: readonly number[]): RingTimingStats {
  if (values.length === 0) return { count: 0, mean: 0, min: 0, max: 0 };
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    sum += value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { count: values.length, mean: sum / values.length, min, max };
}

/**
 * The authored hexes of `ringIndex` in the generator's clockwise geometry
 * order, or `[]` for a ring the MVP has not authored.
 */
export function ringTimingHexes(
  ringIndex: number,
): readonly HexRingDefinition[] {
  const definitions = hexRingDefinitionsFor(ringIndex);
  if (definitions.length === 0) return [];
  return generateRing(ringIndex, definitions).hexes;
}

/**
 * The deployments a line plays, and the hexes it leaves exposed.
 *
 * - `grind` plays **every** hex, weakest aggression first (ties by id), so the
 *   single weapon hex — the ring's hardest — is taken last and nothing is left
 *   exposed.
 * - `rush` plays the **weapon hex first** and then pushes into the next ring,
 *   so every other hex of this ring is left exposed (unheld). This is a real
 *   play sequence, not a model fiction: the captured weapon hex is ring 1's
 *   capstone, and holding it opens the next ring through
 *   `isRingOpenable`/`openNextRing` while the skipped hexes are carried
 *   (`AH-0MVXSHAS100010S0`).
 */
export function planRingDeployments(
  hexes: readonly HexRingDefinition[],
  strategy: RingTimingStrategy,
): { readonly played: readonly HexRingDefinition[]; readonly exposed: readonly HexRingDefinition[] } {
  if (hexes.length === 0) return { played: [], exposed: [] };
  if (strategy === 'rush') {
    const weapon =
      hexes.find((hex) => hex.weaponHex) ??
      [...hexes].sort(
        (a, b) => b.baseAggression - a.baseAggression || a.id.localeCompare(b.id),
      )[0];
    return {
      played: [weapon],
      exposed: hexes.filter((hex) => hex.id !== weapon.id),
    };
  }
  const played = [...hexes].sort(
    (a, b) => a.baseAggression - b.baseAggression || a.id.localeCompare(b.id),
  );
  return { played, exposed: [] };
}

/**
 * Appends `id` to `list` unless it is already owned (earned order, no dupes).
 */
function withOwnedId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? [...list] : [...list, id];
}

/**
 * The fleet ownership a line enters `ringIndex` with: the starter kit plus
 * every grant of the **previous** rings, earned in each ring's plan order
 * (weakest aggression first — the grind's order, the one that actually secures
 * the ring before pushing on).
 *
 * Ring 1 therefore starts bare (the starter hull, no equipped weapon: the
 * starter `spread` is owned but never auto-equipped, AH-0MVZJ6V1J001DA9D), and
 * ring 2 starts with ring 1's six grants. A ring the MVP has not authored
 * contributes nothing.
 *
 * @param ringIndex — the ring the line is about to play.
 * @param catalogue — the unlock tree to resolve grants against (default shipped).
 * @returns the ownership, in earned order (never a shared mutable object).
 */
export function ringEntryOwnership(
  ringIndex: number,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): RingLoadoutOwnership {
  let ownership: RingLoadoutOwnership = {
    hulls: [STARTER_HULL_ID],
    weapons: [],
    modifiers: [],
  };
  for (let ring = 1; ring < Math.max(1, Math.trunc(ringIndex)); ring += 1) {
    const hexes = ringTimingHexes(ring);
    for (const hex of planRingDeployments(hexes, 'grind').played) {
      ownership = withCapturedGrant(ownership, hex.grants, catalogue);
    }
  }
  return ownership;
}

/**
 * The ownership after **capturing** a hex that grants `grantId`: the grant
 * becomes owned for the deployments that follow (weapons join the equipped set,
 * hulls and upgrades their own sets, all through the shipped
 * `resolveHexGrant` — so `waveLaser` → `wave_laser`, `extra-life` →
 * `hardened_plating`, and an id the catalogue does not itemise is still
 * recorded, exactly as the capture cycle does).
 *
 * Total and idempotent: a blank/absent grant or a re-capture returns an
 * equivalent ownership, never an error, and the input is never mutated. A
 * **lost** deployment grants nothing, so the caller applies this only to a
 * capture.
 *
 * @param ownership — the ownership the line has earned so far (read only).
 * @param grantId — the captured hex's authored `grants` value.
 * @param catalogue — the unlock tree to resolve the grant against.
 * @returns the grown ownership.
 */
export function withCapturedGrant(
  ownership: RingLoadoutOwnership,
  grantId: string,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): RingLoadoutOwnership {
  const grant = resolveHexGrant(grantId, catalogue);
  if (grant === null) {
    return {
      hulls: [...ownership.hulls],
      weapons: [...ownership.weapons],
      modifiers: [...ownership.modifiers],
    };
  }
  const next: RingLoadoutOwnership = {
    hulls: [...ownership.hulls],
    weapons: [...ownership.weapons],
    modifiers: [...ownership.modifiers],
  };
  if (grant.kind === 'weapon') {
    const weaponId = grant.weaponId ?? grant.entryId;
    return { ...next, weapons: withOwnedId(next.weapons, weaponId) };
  }
  if (grant.kind === 'hull') {
    return { ...next, hulls: withOwnedId(next.hulls, grant.entryId) };
  }
  return { ...next, modifiers: withOwnedId(next.modifiers, grant.entryId) };
}

/** The catalogue entry for `id` when it is an owned, itemised hull. */
function ownedHullDefinition(
  id: string,
  catalogue: readonly HangarEntry[],
): HullDefinition | null {
  const entry = findHangarEntry(id, catalogue);
  return entry !== null && entry.kind === 'hull' ? entry : null;
}

/**
 * The active hull: the **strongest owned, itemised hull** — most starting
 * lives first, then the faster hull, then catalogue order (deterministic).
 *
 * A hull grant the catalogue does not itemise yet (`hull-3`, from ring 2) is
 * owned but supplies no run stats, exactly as `rapid` / `core-bank` are
 * recorded as effect-free modifiers, so it cannot invent lives the deployment
 * path would not grant.
 */
function strongestOwnedHull(
  ownedHulls: readonly string[],
  catalogue: readonly HangarEntry[],
): HullDefinition | null {
  let best: HullDefinition | null = null;
  for (const id of ownedHulls) {
    const hull = ownedHullDefinition(id, catalogue);
    if (hull === null) continue;
    if (best === null) {
      best = hull;
      continue;
    }
    const lives = hull.runStats.startingLives - best.runStats.startingLives;
    const speed = hull.runStats.speedMultiplier - best.runStats.speedMultiplier;
    if (lives > 0 || (lives === 0 && speed > 0)) best = hull;
  }
  return best;
}

/**
 * Resolves the loadout a deployment launches with from the fleet's ownership —
 * the same resolution the shipped deployment path performs
 * (`src/scenes/hangarWar/hangarDeployment.ts`), so the harness and the game
 * agree on what a life, a weapon and a hull actually grant:
 *
 * - **hull** — the strongest owned, itemised hull (see {@link
 *   strongestOwnedHull}); the starter hull when nothing else is itemised.
 * - **lives** — the hull's `startingLives` plus every owned `extra-lives`
 *   modifier, capped at `MAX_LIVES` (the run's own cap).
 * - **speed** — the active hull's `speedMultiplier`, later applied to the
 *   shared ship config.
 * - **weapons** — every owned, selected weapon, trimmed by the shipped
 *   `capDropIdsToSlotPool` six-slot pool, each at one permanent grant (base
 *   stats).
 * - **modifiers** — every owned modifier id; only `extra-lives` has a modelled
 *   run effect (it is already in `lives`).
 *
 * @param ownership — the ownership to resolve (read only).
 * @param catalogue — the unlock tree to resolve against (default shipped).
 * @returns the loadout, as plain data.
 */
export function resolveDeploymentLoadout(
  ownership: RingLoadoutOwnership,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): RingDeploymentLoadout {
  const hull = strongestOwnedHull(ownership.hulls, catalogue);
  let lives = hull?.runStats.startingLives ?? DEFAULT_LIVES;
  for (const id of ownership.modifiers) {
    const entry = findHangarEntry(id, catalogue);
    if (entry !== null && entry.kind === 'modifier' && entry.effect.kind === 'extra-lives') {
      lives += entry.effect.lives;
    }
  }
  const weapons: RingLoadoutWeapon[] = [];
  for (const id of capDropIdsToSlotPool(ownership.weapons)) {
    if (weapons.some((weapon) => weapon.id === id)) continue;
    weapons.push({ id: id as WeaponId, ownedLevel: 1 });
  }
  return {
    hullId: hull?.id ?? ownership.hulls[0] ?? STARTER_HULL_ID,
    lives: Math.min(MAX_LIVES, Math.max(1, Math.trunc(lives))),
    speedMultiplier: hull?.runStats.speedMultiplier ?? 1,
    weapons,
    modifiers: [...ownership.modifiers],
    ownedHulls: [...ownership.hulls],
  };
}

/** Minerals collected in one arena run (its earned salvage). */
function mineralsCollected(records: readonly TelemetryRecord[]): number {
  let minerals = 0;
  for (const record of records) {
    if (record.kind === 'event' && record.event === 'mineral_collected') minerals += 1;
  }
  return minerals;
}

/** Times the player was hit in one arena run. */
function playerHits(records: readonly TelemetryRecord[]): number {
  let hits = 0;
  for (const record of records) {
    if (record.kind === 'event' && record.event === 'player_hit') hits += 1;
  }
  return hits;
}

/**
 * The tick the arena first observed `level_cleared`, or `null` when the run
 * ended before the sortie cleared (a death or the tick cap).
 */
function levelClearedTick(records: readonly TelemetryRecord[]): number | null {
  for (const record of records) {
    if (record.kind === 'event' && record.event === 'level_cleared') {
      return record.tick;
    }
  }
  return null;
}

/**
 * The deployment's measured length, seconds: the `level_cleared` event's tick
 * × `dt` when the sortie cleared; else the `player_death` event's tick × `dt`
 * when the player died before the clear; else the run's final tick (the
 * `run_end` record) × `dt` when the run stalled at the tick cap. Read from the
 * emitted events — never from `ticksSimulated` or `won`, which describe the
 * tick loop rather than the level (AH-0MWCQ4FWN009J9DM). A lingering asteroid
 * or hazard after the clear changes neither which event wins nor the length.
 */
function deploymentSeconds(records: readonly TelemetryRecord[], dt: number): number {
  for (const record of records) {
    if (record.kind === 'event' && record.event === 'level_cleared') {
      return record.tick * dt;
    }
  }
  for (const record of records) {
    if (record.kind === 'event' && record.event === 'player_death') {
      return record.tick * dt;
    }
  }
  for (const record of records) {
    if (record.kind === 'event' && record.event === 'run_end') {
      return record.tick * dt;
    }
  }
  return 0;
}

/**
 * The default deployment runner: the **real** headless arena playing the
 * shipped **one-level deployment** — the hex's aggression-selected level as
 * the **five-wave sortie** (its first four regular waves plus the wave-5
 * mini-boss composition, `truncateCampaignForDeployment`), in the arena's
 * per-level mode. The deployment's duration is the arena's `level_cleared`
 * event tick × `dt` — never the tick loop's length and never `won` — and a
 * cleared sortie is `captured`; a death before the clear is a loss measured
 * at the death's tick.
 *
 * Each level's truncated sortie is resolved once and cached for the lifetime
 * of the runner, so a ring's deployments share the shipped truncation rather
 * than rebuilding it per hex.
 *
 * @param options.policy — bot policy (default the shipped `competent` brain).
 * @returns a runner that plays one deployment and reports its measured run.
 */
export function createArenaDeploymentRunner(options?: {
  readonly policy?: PolicyFactory;
}): RingDeploymentRunner {
  const policy = options?.policy ?? resolvePolicyFactory('competent');
  const sorties = new Map<number, LevelDefinition>();
  return (request) => {
    let sortie = sorties.get(request.level);
    if (sortie === undefined) {
      // The shipped five-wave sortie, truncated with the SAME pure helper the
      // game's deployment path uses (never a hard-coded 5 or 10): the level's
      // first four regular waves plus its fifth as the mini-boss wave.
      sortie = truncateCampaignForDeployment([
        getLevelDefinition(request.level)!,
      ])[0];
      sorties.set(request.level, sortie);
    }
    const result = runArena(policy.create(), {
      seed: request.seed,
      ticks: request.ticks,
      dt: request.dt,
      // Per-level mode at the hex's aggression-selected level...
      level: request.level,
      // ...playing the deployment's truncated wave set, so `level_cleared`
      // fires on the tick the fifth wave's composition clears (the deployment
      // seam, AH-0MWCQ4FWN009J9DM).
      levelDefinition: sortie,
      // Only the duration and the events matter, so one state sample per run
      // keeps the telemetry small and the harness fast.
      sampleEveryTicks: request.ticks,
      balance: request.balance,
      // The launch loadout the model resolved (AH-0MW9QA2YC009PSF5): the hull's
      // lives and speed plus the fleet's equipped weapons, so the run starts
      // from the state a real deployment starts from.
      startingLoadout: {
        lives: request.loadout.lives,
        speedMultiplier: request.loadout.speedMultiplier,
        weapons: request.loadout.weapons.map((weapon) => ({
          id: weapon.id,
          ownedLevel: weapon.ownedLevel,
        })),
      },
      build: { appVersion: 'ring-timing', commit: 'ring-timing' },
    });
    return {
      seconds: deploymentSeconds(result.records, request.dt),
      // A cleared sortie is captured; a death before the clear — or a stall at
      // the tick cap — is a loss. A lingering asteroid/hazard after the clear
      // changes neither the verdict nor the measured length.
      captured: levelClearedTick(result.records) !== null,
      minerals: mineralsCollected(result.records),
      hits: playerHits(result.records),
    };
  };
}

/**
 * The **one-level income runner** — plays the shipped five-wave sortie
 * (AH-0MWCOWTOR00994NA).
 *
 * The shipped hex deployment (AH-0MWDCBVQ700579WS) is the aggression-selected
 * level's **first five waves** — four regular waves plus the wave-5 mini-boss
 * (`truncateCampaignForDeployment` / {@link DEPLOYMENT_WAVE_COUNT}) — so this
 * runner plays exactly that: the same campaign the game truncates
 * ({@link buildArenaCampaign} through {@link campaignFromLevel}), truncated
 * with the game's own pure helper, and one level handed to {@link runArena}
 * in full-campaign mode via {@link ArenaConfig.campaignLevels}. Nothing in
 * `arena.ts` changes and {@link createArenaDeploymentRunner} (the campaign
 * slice) stays the shipped default — the ring-timing chain owns re-pointing
 * it (AH-0MWCOWSVN003X81A), and the chains share these income numbers.
 *
 * A sortie **captured** means its mini-boss was wiped: with a single level
 * as the campaign, the shared `WaveManager` fires `level_cleared` and the
 * boss trigger ends the run (`won`), so `captured === result.won` and the
 * banked minerals are exactly what the ship held at that checkpoint. A
 * sortie the bot neither wipes nor dies within the deployment window (the
 * tick-cap safety bound) counts as a loss — the same bound the pre-change
 * harness used.
 *
 * @param options.policy — bot policy (default the shipped `competent` brain).
 * @returns a runner that plays the five-wave sortie and reports its measured run.
 */
export function createOneLevelArenaDeploymentRunner(options?: {
  readonly policy?: PolicyFactory;
}): RingDeploymentRunner {
  const policy = options?.policy ?? resolvePolicyFactory('competent');
  // Campaigns are built once per seed and cached for the lifetime of the
  // runner (the same caching the slice runner uses); the sortie is truncated
  // **per request** from the request's level — a seed plays different sortie
  // levels across a ring (e.g. ring 2: levels 3–9), so the sortie can never
  // be cached by seed alone.
  const campaigns = new Map<number, readonly LevelDefinition[]>();
  return (request) => {
    let campaign = campaigns.get(request.seed);
    if (campaign === undefined) {
      campaign = buildArenaCampaign(request.seed, request.balance);
      campaigns.set(request.seed, campaign);
    }
    // The shipped sortie: the aggression-selected level's first five waves
    // (four regular + the wave-5 mini-boss), truncated with the game's own
    // pure helper (AH-0MWDCBVQ700579WS).
    const slice = truncateCampaignForDeployment(
      campaignFromLevel(campaign, request.level),
    );
    const sortie = slice[0] ?? null;
    // An empty campaign (impossible for the shipped data) reports a loss.
    if (sortie === null) {
      return { seconds: 0, captured: false, minerals: 0, hits: 0 };
    }
    const result = runArena(policy.create(), {
      seed: request.seed,
      ticks: request.ticks,
      dt: request.dt,
      campaign: true,
      campaignLevels: [sortie],
      // Only the duration and the events matter, so one state sample per run
      // keeps the telemetry small and the harness fast.
      sampleEveryTicks: request.ticks,
      balance: request.balance,
      // The launch loadout the model resolved (AH-0MW9QA2YC009PSF5).
      startingLoadout: {
        lives: request.loadout.lives,
        speedMultiplier: request.loadout.speedMultiplier,
        weapons: request.loadout.weapons.map((weapon) => ({
          id: weapon.id,
          ownedLevel: weapon.ownedLevel,
        })),
      },
      build: { appVersion: 'ring-timing', commit: 'ring-timing' },
    });
    return {
      seconds: result.ticksSimulated * request.dt,
      // The sortie is captured only when its mini-boss is wiped (the arena's
      // `won` after the final wave's clear triggers the boss). A window
      // survival without the clear is a loss, exactly as the game reads it.
      captured: result.won,
      minerals: mineralsCollected(result.records),
      hits: playerHits(result.records),
    };
  };
}

/**
 * Judges a measured total against the ring's design window and the stated
 * tolerance ({@link RING_TIMING_TOLERANCE_PERCENT}).
 *
 * The verdict is `not-applicable` when the line does not secure the ring (the
 * rush segment) or the ring has no authored target; otherwise `in-window`,
 * `within-tolerance` (inside the window widened by the stated tolerance), or
 * `missed`.
 *
 * @param ringIndex — the measured ring.
 * @param strategy — the measured line.
 * @param measuredMinutes — the measured play time (the mean total).
 * @param tolerancePercent — tolerance override (default the stated 10 %).
 * @returns the budget verdict.
 */
export function evaluateRingTimingBudget(
  ringIndex: number,
  strategy: RingTimingStrategy,
  measuredMinutes: number,
  tolerancePercent: number = RING_TIMING_TOLERANCE_PERCENT,
): RingTimingBudgetVerdict {
  const target = RING_TIMING_TARGETS[ringIndex] ?? null;
  const applicable = target !== null && strategy === 'grind';
  if (target === null) {
    return {
      applicable: false,
      target: null,
      tolerancePercent,
      toleranceMinutes: 0,
      measuredMinutes,
      withinWindow: false,
      withinTolerance: false,
      verdict: 'not-applicable',
    };
  }
  const toleranceMinutes =
    ((target.maxMinutes - target.minMinutes) * tolerancePercent) / 100;
  const withinWindow =
    measuredMinutes >= target.minMinutes && measuredMinutes <= target.maxMinutes;
  const withinTolerance =
    measuredMinutes >= target.minMinutes - toleranceMinutes &&
    measuredMinutes <= target.maxMinutes + toleranceMinutes;
  const verdict = !applicable
    ? 'not-applicable'
    : withinWindow
      ? 'in-window'
      : withinTolerance
        ? 'within-tolerance'
        : 'missed';
  return {
    applicable,
    target,
    tolerancePercent,
    toleranceMinutes,
    measuredMinutes,
    withinWindow,
    withinTolerance,
    verdict,
  };
}

/**
 * Measures one ring for one playstyle line.
 *
 * For every hex the line plays, the deployment's aggression is the hex's
 * authored base aggression plus {@link RingTimingOptions.aggressionRisePerSortie}
 * times the number of sorties already played in the ring (default `0`). The
 * aggression resolves through the shipped `hexDifficultyProfile`, the runner
 * plays the deployment, and the measured duration is summed. Losses add one
 * modelled retry each; the line's between-sortie time and (for a rush) its
 * exposed-hex re-capture work are added; the total is judged against the ring's
 * budget.
 *
 * @param options — the ring, the line, the seeds and the model allowances.
 * @returns the report (deterministic for the same options).
 */
export function simulateRingTiming(
  options: RingTimingOptions,
): RingTimingReport {
  const ringIndex = options.ringIndex;
  const strategy = options.strategy;
  const seeds =
    options.seeds && options.seeds.length > 0 ? [...options.seeds] : [1];
  const ticks = Math.max(1, nonNegativeOr(options.deploymentTicks, RING_DEPLOYMENT_TICKS));
  const dt = positiveOr(options.dt, DEFAULT_RING_TIMING_DT);
  const betweenSortieMinutes = nonNegativeOr(
    options.betweenSortieMinutes,
    DEFAULT_BETWEEN_SORTIE_MINUTES,
  );
  const retriesPerLoss = nonNegativeOr(
    options.retriesPerLoss,
    DEFAULT_RETRIES_PER_LOSS,
  );
  const retakeChance =
    percentOr(options.retakeChancePercent, DEFAULT_RETAKE_CHANCE_PERCENT) / 100;
  const aggressionRisePerSortie = nonNegativeOr(
    options.aggressionRisePerSortie,
    0,
  );
  const balance = options.balance ?? loadBalanceConfig();
  const hexes = options.hexes ?? ringTimingHexes(ringIndex);
  const { played, exposed } = planRingDeployments(hexes, strategy);
  const runDeployment =
    options.runDeployment ??
    createArenaDeploymentRunner({ policy: options.policy });
  // The loadout the line enters the ring with, and the ownership it grows as
  // its deployments capture hexes (AH-0MW9QA2YC009PSF5).
  const catalogue = options.catalogue ?? HANGAR_CATALOGUE;
  const entryOwnership =
    options.ownership ?? ringEntryOwnership(ringIndex, catalogue);
  const entryLoadout = resolveDeploymentLoadout(entryOwnership, catalogue);

  const runs: RingTimingRun[] = [];
  for (const seed of seeds) {
    // Every seed is a fresh war: the ring is earned again from the entry state.
    let ownership = entryOwnership;
    const deployments: RingTimingDeployment[] = [];
    let deploymentMinutes = 0;
    let retryTotal = 0;
    let captured = 0;
    let losses = 0;
    let salvageBanked = 0;
    let salvageForfeited = 0;
    let salvageCores = 0;

    played.forEach((hex, sortieIndex) => {
      const aggression = hex.baseAggression + aggressionRisePerSortie * sortieIndex;
      const level = hexDifficultyProfile(aggression).level;
      // Resolved once per deployment (never per tick): the loadout the player
      // owns at this point in the ring's plan.
      const loadout = resolveDeploymentLoadout(ownership, catalogue);
      const result = runDeployment({
        seed,
        hexId: hex.id,
        aggression,
        level,
        ticks,
        dt,
        balance,
        loadout,
      });
      const measuredMinutes = result.seconds / 60;
      const retries = result.captured ? 0 : retriesPerLoss;
      // A retry replays the SAME deployment, so it costs that deployment's own
      // measured length × `retriesPerLoss` — never the retired flat window.
      const minutes = measuredMinutes + retries * measuredMinutes;
      deploymentMinutes += measuredMinutes;
      retryTotal += retries * measuredMinutes;
      if (result.captured) {
        captured += 1;
        salvageBanked += result.minerals;
        // One core per defeated mini-boss: a captured one-level deployment
        // defeated exactly its one mini-boss (AH-0MWCOWTOR00994NA).
        salvageCores += 1;
        // A capture earns the hex's grant for the deployments that follow it;
        // a loss replays the same hex with the same loadout.
        ownership = withCapturedGrant(ownership, hex.grants, catalogue);
      } else {
        losses += 1;
        salvageForfeited += result.minerals;
      }
      deployments.push({
        hexId: hex.id,
        aggression,
        level,
        seconds: result.seconds,
        captured: result.captured,
        minerals: result.minerals,
        hits: result.hits,
        retries,
        minutes,
        loadout,
      });
    });

    const betweenSortieTotal = played.length * betweenSortieMinutes;
    const expectedRetakes = exposed.length * retakeChance;
    // A re-capture is the line's measured mean deployment (one sortie, at the
    // length the line actually measures) plus the visit that follows it
    // (producer ruling Q4 = a) — never the retired 18 000-tick window.
    const meanDeploymentMinutes =
      played.length > 0 ? deploymentMinutes / played.length : 0;
    const retakeMinutes =
      expectedRetakes * (meanDeploymentMinutes + betweenSortieMinutes);
    // The grind line plays every hex of the ring, so it secures it (a lost
    // first attempt is retried, which is why the ring is still secured). The
    // rush line pushes past the ring, so it never secures it.
    const ringSecured = exposed.length === 0 && played.length === hexes.length;

    runs.push({
      seed,
      deployments,
      deploymentMinutes,
      betweenSortieMinutes: betweenSortieTotal,
      retryMinutes: retryTotal,
      retakeMinutes,
      totalMinutes:
        deploymentMinutes + betweenSortieTotal + retryTotal + retakeMinutes,
      captured,
      losses,
      expectedRetakes,
      expectedLosses: losses + expectedRetakes,
      exposedHexes: exposed.length,
      salvageBanked,
      salvageForfeited,
      salvageCores,
      ringSecured,
    });
  }

  const summary: RingTimingSummary = {
    totalMinutes: stats(runs.map((run) => run.totalMinutes)),
    deploymentMinutes: stats(runs.map((run) => run.deploymentMinutes)),
    losses: stats(runs.map((run) => run.losses)),
    expectedLosses: stats(runs.map((run) => run.expectedLosses)),
    salvageBanked: stats(runs.map((run) => run.salvageBanked)),
    salvageCores: stats(runs.map((run) => run.salvageCores)),
    captured: stats(runs.map((run) => run.captured)),
    ringSecuredRuns: runs.filter((run) => run.ringSecured).length,
  };

  return {
    ringIndex,
    strategy,
    seeds,
    runs,
    summary,
    budget: evaluateRingTimingBudget(
      ringIndex,
      strategy,
      summary.totalMinutes.mean,
    ),
    entryLoadout,
  };
}

/** `value` formatted to one decimal place. */
function oneDecimal(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

/**
 * Renders a report as the harness's operator-facing text (the CLI prints this;
 * `--json` prints the report itself).
 *
 * @param report — the measured report.
 * @returns one line per metric, in a stable order.
 */
export function formatRingTimingReport(report: RingTimingReport): string {
  const { summary, budget } = report;
  const seedRange =
    report.seeds.length === 1
      ? `seed ${report.seeds[0]}`
      : `seeds ${report.seeds.join(', ')}`;
  const lines = [
    `Ring ${report.ringIndex} · ${report.strategy} · ${seedRange}`,
    `  deployments        ${oneDecimal(summary.captured.mean)} captured, ${oneDecimal(summary.losses.mean)} lost`,
    `  measured runs      ${oneDecimal(summary.deploymentMinutes.mean)} min`,
    `  between sorties    ${oneDecimal(report.runs[0]?.betweenSortieMinutes ?? 0)} min`,
    `  retries            ${oneDecimal(report.runs[0]?.retryMinutes ?? 0)} min`,
    `  exposed re-capture ${oneDecimal(report.runs[0]?.retakeMinutes ?? 0)} min (${oneDecimal(report.runs[0]?.expectedRetakes ?? 0)} expected retakes)`,
    `  total              ${oneDecimal(summary.totalMinutes.mean)} min (min ${oneDecimal(summary.totalMinutes.min)}, max ${oneDecimal(summary.totalMinutes.max)})`,
    `  banked salvage     ${oneDecimal(summary.salvageBanked.mean)} minerals`,
    `  ring secured       ${summary.ringSecuredRuns}/${report.runs.length} runs`,
  ];
  if (budget.target === null) {
    lines.push('  budget             no authored target for this ring');
  } else {
    lines.push(
      `  budget             ${budget.target.minMinutes}–${budget.target.maxMinutes} min ±${oneDecimal(budget.toleranceMinutes)} (${budget.tolerancePercent}%) · ${budget.verdict}`,
    );
  }
  lines.push(`  banked cores       ${oneDecimal(summary.salvageCores.mean)} cores`);
  return lines.join('\n');
}

/**
 * Per-deployment income for one measured ring+line
 * (AH-0MWCOWTOR00994NA, the re-baselined economy view).
 *
 * A captured deployment banks exactly **one core** plus the minerals held at
 * its mini-boss checkpoint, and a loss banks nothing — so per-deployment
 * income is the arithmetical mean over every deployment the line played
 * (losses count as zero), and the checkpoint figure is the mean over captured
 * deployments only.
 */
export interface PerDeploymentIncome {
  /** Deployments the line played (across the aggregated seeds). */
  readonly deployments: number;
  /** Deployments whose sortie was captured (mini-boss defeated). */
  readonly captured: number;
  /** Captured / deployments. */
  readonly captureRate: number;
  /** Mean minerals banked per deployment (losses bank 0). */
  readonly mineralsPerDeployment: number;
  /** Mean cores banked per deployment (losses bank 0). */
  readonly coresPerDeployment: number;
  /** Mean minerals held at the mini-boss checkpoint (captured only). */
  readonly mineralsPerCapturedDeployment: number;
  /** Exactly one core per captured deployment. */
  readonly coresPerCapturedDeployment: number;
  /**
   * Per-deployment income in mineral-equivalent terms (each core weights
   * {@link CORE_MINERAL_EQUIVALENT} minerals). A comparison aid only — the
   * unlock tree spends **both** currencies, never this blend.
   */
  readonly mineralEquivalentPerDeployment: number;
}

/**
 * Derives the per-deployment income of a measured report from the salvage
 * the deployments actually banked (never hand-edited numbers).
 *
 * @param report — one measured ring+line report.
 * @returns the income view (all-zero when nothing was captured).
 */
export function derivePerDeploymentIncome(
  report: RingTimingReport,
): PerDeploymentIncome {
  let deployments = 0;
  let captured = 0;
  let minerals = 0;
  let cores = 0;
  for (const run of report.runs) {
    deployments += run.deployments.length;
    captured += run.captured;
    minerals += run.salvageBanked;
    cores += run.salvageCores;
  }
  const captureRate = deployments > 0 ? captured / deployments : 0;
  return {
    deployments,
    captured,
    captureRate,
    mineralsPerDeployment: deployments > 0 ? minerals / deployments : 0,
    coresPerDeployment: deployments > 0 ? cores / deployments : 0,
    mineralsPerCapturedDeployment: captured > 0 ? minerals / captured : 0,
    coresPerCapturedDeployment: captured > 0 ? cores / captured : 1,
    mineralEquivalentPerDeployment:
      (deployments > 0 ? minerals / deployments : 0) +
      (deployments > 0 ? cores / deployments : 0) * CORE_MINERAL_EQUIVALENT,
  };
}

/**
 * The unlock pace for one catalogue entry: deployments needed to afford it
 * from the measured per-deployment income.
 *
 * A purchase needs **both** currencies at once (`canBuy`/`buy` in
 * `hangarEconomy.ts`), so the pace is the slower of the two currency bounds —
 * never their sum and never a mineral-only rate. `Infinity` when the line
 * banks none of a currency.
 */
export interface UnlockPaceEntry {
  /** The catalogue entry id. */
  readonly id: string;
  /** Display name (for the report's readability). */
  readonly name: string;
  /** The entry kind (`hull` / `weapon` / `modifier`). */
  readonly kind: HangarEntry['kind'];
  /** The two-currency price. */
  readonly price: HangarPrice;
  /** Lowest ring at which the entry may be bought. */
  readonly minRing: number;
  /** Deployments the mineral share of the price takes. */
  readonly mineralBoundDeployments: number;
  /** Deployments the core share of the price takes. */
  readonly coreBoundDeployments: number;
  /** The slower currency bound — the deployments to afford the entry. */
  readonly deploymentsToAfford: number;
}

/**
 * Derives the unlock pace for every buyable rings-1–2 catalogue entry
 * (AH-0MWCOWTOR00994NA, AC2) from the measured per-deployment income.
 *
 * Starter entries (free, owned by definition) are not priced, so they are
 * excluded. `deploymentsToAfford` is rounded **up**: a player needs whole
 * deployments, and the first one that clears a currency's remaining balance
 * banks the surplus for the next entry.
 *
 * @param income — the measured per-deployment income of the line used.
 * @param catalogue — the unlock tree (default shipped).
 * @returns one entry per buyable catalogue entry, in catalogue order.
 */
export function deriveUnlockPace(
  income: PerDeploymentIncome,
  catalogue: readonly HangarEntry[] = HANGAR_CATALOGUE,
): UnlockPaceEntry[] {
  const pace: UnlockPaceEntry[] = [];
  for (const entry of catalogue) {
    if (entry.starter) continue;
    const price = entry.price;
    const mineralBound =
      income.mineralsPerDeployment > 0
        ? Math.ceil(price.minerals / income.mineralsPerDeployment)
        : Number.POSITIVE_INFINITY;
    const coreBound =
      income.coresPerDeployment > 0
        ? Math.ceil(price.cores / income.coresPerDeployment)
        : Number.POSITIVE_INFINITY;
    pace.push({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      price,
      minRing: entry.minRing,
      mineralBoundDeployments: mineralBound,
      coreBoundDeployments: coreBound,
      deploymentsToAfford: Math.max(mineralBound, coreBound),
    });
  }
  return pace;
}

/**
 * Renders the per-deployment income + unlock-pace view of a report — the
 * operator-facing text of the one-level income measurement (the CLI prints
 * this; `--json` prints the underlying report).
 *
 * @param report — the measured report (typically from the one-level runner).
 * @returns the income + unlock-pace text, one line per metric.
 */
export function formatIncomeReport(report: RingTimingReport): string {
  const income = derivePerDeploymentIncome(report);
  const pace = deriveUnlockPace(income);
  const lines = [
    `Ring ${report.ringIndex} · ${report.strategy} · per-deployment income (seeds ${report.seeds.join(', ')})`,
    `  deployments        ${income.deployments} (${income.captured} captured, ${oneDecimal(income.captureRate * 100)}%)`,
    `  minerals banked    ${oneDecimal(income.mineralsPerDeployment)} per deployment (${oneDecimal(income.mineralsPerCapturedDeployment)} at the mini-boss checkpoint per captured)`,
    `  cores banked       ${oneDecimal(income.coresPerDeployment)} per deployment (${oneDecimal(income.coresPerCapturedDeployment)} per captured)`,
    `  mineral-eq income  ${oneDecimal(income.mineralEquivalentPerDeployment)} per deployment (1 core = ${CORE_MINERAL_EQUIVALENT} minerals, comparison only)`,
    '  unlock pace',
  ];
  for (const entry of pace) {
    const deployments =
      Number.isFinite(entry.deploymentsToAfford)
        ? `${entry.deploymentsToAfford} deployments`
        : 'never (line banks no salvage)';
    lines.push(
      `    ${entry.id.padEnd(18)} ${entry.price.minerals}/${entry.price.cores} → ${deployments}`,
    );
  }
  return lines.join('\n');
}
