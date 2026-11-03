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
 * A deployment is "a normal run at that hex's aggression"
 * (`src/scenes/hangarWar/hangarDeployment.ts`): the classic campaign started at
 * the hex's aggression-selected level and played to its end
 * (`PlayScene.beginGame(startLevel)`). This harness reproduces exactly that in
 * the headless arena — {@link runArena} in full-campaign mode over the campaign
 * **slice** from the hex's level — and sums each run's measured duration
 * (`ticksSimulated × dt`, the arena's per-run duration). Nothing in the
 * measurement is invented: the aggression → level mapping is the shipped
 * `hexDifficultyProfile`, the campaign is the shipped
 * {@link buildArenaCampaign}, and the difficulty comes from the shipped
 * `difficulty-curves.csv`.
 *
 * Around the measured deployments the harness models the parts of a real
 * session the arena cannot see, and states every one of them as an explicit
 * default:
 *
 * - **Between-sortie time** ({@link DEFAULT_BETWEEN_SORTIE_MINUTES}) — hangar
 *   shopping, salvage banking, the map and the defence report between runs.
 * - **Retries** ({@link DEFAULT_RETRIES_PER_LOSS}) — a run that ends before its
 *   deployment budget (the player died) is a **loss**; the model charges one
 *   modelled retry per loss, because a real player replays rather than giving
 *   up. The retry costs a full deployment ({@link DEFAULT_RETRY_MINUTES}).
 * - **Exposure** ({@link DEFAULT_RETAKE_CHANCE_PERCENT}) — the **rush** line
 *   pushes into the next ring with the current one only partly held, so every
 *   unheld hex is exposed to the frontier. Each exposed hex costs its expected
 *   re-capture work (`chance × (deployment + between-sortie)`); the chance
 *   comes from the shipped frontier clock's attack chance
 *   (`DEFAULT_FRONTIER_TUNING.attackChancePercent`).
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
 * The arena's campaign run is the best headless proxy for a deployment, not a
 * human playtest (intake assumption A1 / Q4). It models the run's survival but
 * not a human's piloting: the shipped competent bot survives the full
 * deployment window at campaign levels 1–3 (no enemy fire) and loses the run
 * early at level 4+, so a deployment's **captured/lost** verdict is that
 * signal, and the modelled retry allowance covers the player's persistence.
 * The campaign segment is measured from each ring's **authored base
 * aggressions** (the numbers the map publishes); the frontier's between-sortie
 * rise is a separate risk mechanic (B3/B6), and {@link
 * RingTimingOptions.aggressionRisePerSortie} exists as an explicit sensitivity
 * knob (default `0`) rather than a hidden assumption.
 *
 * @module src/ai/eval/ringTiming
 */

import { DEFAULT_FRONTIER_TUNING } from '../../core/hangarWar/hexDefence';
import { hexDifficultyProfile } from '../../core/hangarWar/hexDifficulty';
import { generateRing, type HexRingDefinition } from '../../core/hangarWar/hexRing';
import { hexRingDefinitionsFor } from '../../data/hexRingDefinitions';
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
 * Ticks in one deployment's run window — the design's ≈5-minute arcade run
 * (`DEFAULT_BATCH_TICKS` = 18 000 ticks = 300 s at 60 fps).
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
 * Minutes one modelled retry costs: a full deployment window (the run the
 * player replays after losing the first one).
 */
export const DEFAULT_RETRY_MINUTES =
  (RING_DEPLOYMENT_TICKS * DEFAULT_RING_TIMING_DT) / 60;

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
 * so the measured grind rose from ≈91.6 to ≈109 minutes. The loss-dominated
 * ring-2 retry allowance is the same documented follow-up risk; only the
 * deployment duration (the bot's longer survival) changed.
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
}

/** What one deployment's arena run reported. */
export interface RingDeploymentResult {
  /** Measured run duration, seconds (`ticksSimulated × dt`). */
  readonly seconds: number;
  /** Whether the run survived its deployment window (or won outright). */
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
  /** Minutes one modelled retry costs (default a full deployment). */
  readonly retryMinutes?: number;
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
}

/** One deployment as the line played it. */
export interface RingTimingDeployment {
  /** The target hex's authored id. */
  readonly hexId: string;
  /** The hex's aggression when the line deployed to it. */
  readonly aggression: number;
  /** The campaign level the aggression selected. */
  readonly level: number;
  /** Measured arena duration, seconds. */
  readonly seconds: number;
  /** Whether the run survived its deployment window (the hex was taken). */
  readonly captured: boolean;
  /** Minerals the run collected (banked only when captured). */
  readonly minerals: number;
  /** Times the player was hit during the run. */
  readonly hits: number;
  /** Modelled retries charged for this deployment (`0` when captured). */
  readonly retries: number;
  /** Play time this deployment contributes, minutes. */
  readonly minutes: number;
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
  /** Modelled retry time for lost deployments, minutes. */
  readonly retryMinutes: number;
  /** Modelled expected re-capture work for exposed hexes, minutes. */
  readonly retakeMinutes: number;
  /** Total modelled play time, minutes. */
  readonly totalMinutes: number;
  /** Deployments whose run survived its window. */
  readonly captured: number;
  /** Deployments whose run ended before its window (the line's losses). */
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
 * The default deployment runner: the **real** headless arena playing the
 * classic campaign slice from the hex's aggression-selected level.
 *
 * Campaigns are built once per seed and cached for the lifetime of the runner,
 * so a ring's deployments share the shipped build rather than rebuilding it per
 * hex.
 *
 * @param options.policy — bot policy (default the shipped `competent` brain).
 * @returns a runner that plays one deployment and reports its measured run.
 */
export function createArenaDeploymentRunner(options?: {
  readonly policy?: PolicyFactory;
}): RingDeploymentRunner {
  const policy = options?.policy ?? resolvePolicyFactory('competent');
  const campaigns = new Map<number, ReturnType<typeof buildArenaCampaign>>();
  return (request) => {
    let campaign = campaigns.get(request.seed);
    if (campaign === undefined) {
      campaign = buildArenaCampaign(request.seed, request.balance);
      campaigns.set(request.seed, campaign);
    }
    const result = runArena(policy.create(), {
      seed: request.seed,
      ticks: request.ticks,
      dt: request.dt,
      campaign: true,
      campaignLevels: campaignFromLevel(campaign, request.level),
      // Only the duration and the events matter, so one state sample per run
      // keeps the telemetry small and the harness fast.
      sampleEveryTicks: request.ticks,
      balance: request.balance,
      build: { appVersion: 'ring-timing', commit: 'ring-timing' },
    });
    return {
      seconds: result.ticksSimulated * request.dt,
      // A run that reaches its window is a normal deployment; a run the
      // campaign finished outright is captured too. An early end is a loss.
      captured: result.won || result.ticksSimulated >= request.ticks,
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
  const retryMinutes = nonNegativeOr(options.retryMinutes, DEFAULT_RETRY_MINUTES);
  const retakeChance =
    percentOr(options.retakeChancePercent, DEFAULT_RETAKE_CHANCE_PERCENT) / 100;
  const aggressionRisePerSortie = nonNegativeOr(
    options.aggressionRisePerSortie,
    0,
  );
  const budgetMinutes = (ticks * dt) / 60;
  const balance = options.balance ?? loadBalanceConfig();
  const hexes = options.hexes ?? ringTimingHexes(ringIndex);
  const { played, exposed } = planRingDeployments(hexes, strategy);
  const runDeployment =
    options.runDeployment ??
    createArenaDeploymentRunner({ policy: options.policy });

  const runs: RingTimingRun[] = [];
  for (const seed of seeds) {
    const deployments: RingTimingDeployment[] = [];
    let deploymentMinutes = 0;
    let retryTotal = 0;
    let captured = 0;
    let losses = 0;
    let salvageBanked = 0;
    let salvageForfeited = 0;

    played.forEach((hex, sortieIndex) => {
      const aggression = hex.baseAggression + aggressionRisePerSortie * sortieIndex;
      const level = hexDifficultyProfile(aggression).level;
      const result = runDeployment({
        seed,
        hexId: hex.id,
        aggression,
        level,
        ticks,
        dt,
        balance,
      });
      const measuredMinutes = result.seconds / 60;
      const retries = result.captured ? 0 : retriesPerLoss;
      const minutes = measuredMinutes + retries * retryMinutes;
      deploymentMinutes += measuredMinutes;
      retryTotal += retries * retryMinutes;
      if (result.captured) {
        captured += 1;
        salvageBanked += result.minerals;
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
      });
    });

    const betweenSortieTotal = played.length * betweenSortieMinutes;
    const expectedRetakes = exposed.length * retakeChance;
    // A re-capture is a full deployment plus the visit that follows it.
    const retakeMinutes =
      expectedRetakes * (budgetMinutes + betweenSortieMinutes);
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
      ringSecured,
    });
  }

  const summary: RingTimingSummary = {
    totalMinutes: stats(runs.map((run) => run.totalMinutes)),
    deploymentMinutes: stats(runs.map((run) => run.deploymentMinutes)),
    losses: stats(runs.map((run) => run.losses)),
    expectedLosses: stats(runs.map((run) => run.expectedLosses)),
    salvageBanked: stats(runs.map((run) => run.salvageBanked)),
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
  return lines.join('\n');
}
