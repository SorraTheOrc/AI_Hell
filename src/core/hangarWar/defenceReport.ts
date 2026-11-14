/**
 * Between-sortie defence report view model
 * (AH-0MVUXCBBK004EJIP, part of **Build Candidate D — Hangar War**).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § UI / scene
 * surface ("A **between-sortie defence report, rolled into the hex ring map**
 * (no separate screen): the map draws one **attack arrow per attack** on the
 * ring and a **left-hand attack panel** with that attack's numbers — which
 * hexes were attacked, which held, which fell, and what it would take to
 * retake them") and the failure mode it mitigates — *opaque defence*: "a hex
 * falls and the player cannot see why … show the numbers (defender rating vs.
 * attacking force)".
 *
 * ## A pure view, never a rule
 *
 * This module renders **only** what the frontier tick already decided. Its two
 * inputs are the resolver's per-tick record (`FrontierTickRecord` from
 * `./hexDefence`) and the stored payload (`HangarWarPayload`); every number in
 * a row is copied from the record, and the payload is consulted for two facts
 * the record does not carry: whether the hex is still held after the tick, and
 * the attacking neighbour's aggression (what the player can strike back at).
 * Nothing is resolved, re-derived, mutated or persisted here — the map's
 * rolled-in report, the gym and the attract traversal all read the same model,
 * so no gameplay rule can live in (or drift between) the scenes
 * (AGENTS.md gym↔game parity).
 *
 * ## What "what it would take to retake it" means
 *
 * The design's answerability rule is that an attack is always launched from an
 * **unheld neighbouring hex** (`attackingNeighbour` in `./hexDefence`), so a
 * fallen hex has exactly one answer: strike that neighbour, then leave a bot
 * strong enough to survive the same attack. Because a tie holds the line
 * (`margin === 0` is a hold), the required defender rating is the record's
 * `attackStrength` — not one more than it.
 *
 * ## Defending-bot skills
 *
 * A defending bot may carry special skills (AH-0MVWZYJ740037EZ1): flat rating
 * bonuses against one boss identity. The resolver applies them and publishes the
 * stored `defenderRating`, the `effectiveDefenderRating`, the summed
 * `skillBonusTotal` and the `appliedSkills`; this model copies all four into
 * every affected row and renders one extra `skill <names> +<bonus> vs <boss>
 * → bot <effective>` line, so a hold that *depended* on a matching skill is
 * distinguishable from an unmodified hold. A row with no skill applied carries
 * `skillLine: null` and is byte-for-byte what it was before skills existed.
 *
 * ## A quiet tick
 *
 * A secured ring (every hex held) has no unheld neighbour to attack from, so a
 * tick on it reports **no attacks**. That is a legitimate, non-stalling report
 * — the model publishes `quiet: true` and an explicit "no hex was attacked"
 * line rather than an empty screen the demo could stall on.
 *
 * ## The hangar assault
 *
 * When a ring's final hex is captured the frontier presses the hangar with a
 * massed assault (`resolveHangarAssault` in `./hexDefence`, AH-0MWEZZ5AQ000W3M8).
 * That resolver's record is handed to {@link buildDefenceReport} as
 * {@link BuildDefenceReportOptions.assault} and rendered here **verbatim** —
 * the report still derives no figure of its own. A repel publishes the ring-won
 * line; a fall publishes the full-campaign-reset announcement. With no assault
 * record the report is byte-for-byte the ordinary between-sortie report
 * (including the quiet `QUIET — no hex was attacked this tick` line).
 *
 * @module src/core/hangarWar/defenceReport
 */

import { areNeighbours, type AxialCoordinate } from './hexRing';
import type {
  AggressionDelta,
  AssaultOutcome,
  DefenceOutcome,
  FrontierTickRecord,
  HangarAssaultResolution,
  HexDefenceRecord,
} from './hexDefence';
import type { DefenceSkill, HangarWarPayload, HexState } from './types';

/** Title rendered with the map's rolled-in report (asserted by tests). */
export const DEFENCE_REPORT_TITLE = 'DEFENCE REPORT';

/** Row key of the continue action (retained on the model; the map needs none). */
export const DEFENCE_REPORT_CONTINUE_KEY = 'continue';

/** Label of the continue action (retained on the model; the map needs no control). */
export const DEFENCE_REPORT_CONTINUE_LABEL = '▶ CONTINUE TO THE MAP';

/** The line stating that nothing was simulated (the design's no-battle rule). */
export const DEFENCE_REPORT_NO_BATTLE_LINE =
  'Resolved from stored numbers — no battle was simulated.';

/** Headline when the massed hangar assault was repelled (the ring is won). */
export const ASSAULT_REPELLED_HEADLINE =
  'RING WON — the massed hangar assault was repelled';

/** Consequence line of a repelled assault (the ring won, the next one opens). */
export const ASSAULT_REPELLED_CONSEQUENCE =
  'The ring is won — the next ring opens.';

/** Headline when the massed assault broke the hangar (the campaign is lost). */
export const ASSAULT_HANGAR_FALLS_HEADLINE =
  'HANGAR FALLS — the massed assault broke the hangar';

/** Consequence line of a failed assault: the full campaign reset. */
export const ASSAULT_HANGAR_FALLS_CONSEQUENCE =
  'FULL CAMPAIGN RESET — the hangar and its ring are wiped together.';

/**
 * What it would take to retake a hex that fell (or to hold one that stood).
 *
 * Every field comes from the tick's record or the stored payload; the note is
 * the one-line human reading of them.
 */
export interface DefenceRetakePlan {
  /** The unheld neighbouring hex the attack came from (the hex to strike). */
  readonly originHexId: string;
  /** That neighbour's axial coordinate (so the map can point at it). */
  readonly origin: AxialCoordinate;
  /** That neighbour's stored aggression after the tick. */
  readonly originAggression: number;
  /**
   * Defender rating needed to hold the hex against the same attack. A tie
   * holds, so this is the record's `attackStrength` (not one more).
   */
  readonly requiredDefenderRating: number;
  /** One-line reading of the plan (`strike … then hold with a bot rated ≥ …`). */
  readonly note: string;
}

/** One attacked hex, with every number the tick used and the retake plan. */
export interface DefenceReportRow {
  /** Row key (`defence:<hexId>`), unique within the report. */
  readonly key: string;
  /** The attacked hex. */
  readonly hexId: string;
  /** `held` when the defence stood, `fell` when the hex was retaken. */
  readonly outcome: DefenceOutcome;
  /** Whether the hex is still held after the tick (the payload's state). */
  readonly held: boolean;
  /** Attacking force before aggression/jitter (from the record). */
  readonly attackingForce: number;
  /** The hex's aggression that scaled the attack (from the record). */
  readonly aggression: number;
  /** Aggression multiplier applied, in percent (`100` = neutral). */
  readonly aggressionMultiplierPercent: number;
  /** Bounded seeded jitter applied, in percent (`0` = none). */
  readonly jitterPercent: number;
  /** The defending bot's stored rating (from the record). */
  readonly defenderRating: number;
  /**
   * The **effective** rating the comparison used
   * (`defenderRating + skillBonusTotal`, from the record).
   *
   * Published beside {@link defenderRating} so a hold that *depended* on a
   * matching skill is distinguishable from an unmodified hold
   * (AH-0MVWZYJ740037EZ1 AC2).
   */
  readonly effectiveDefenderRating: number;
  /** Summed flat bonus of the defender's matching skills (`0` = none applied). */
  readonly skillBonusTotal: number;
  /** The skills the resolver actually applied (matching, usable ones only). */
  readonly appliedSkills: readonly DefenceSkill[];
  /**
   * The attacker's type — the attacking neighbour's authored boss identity — or
   * `null` for an untyped attack (which resolves unmodified).
   */
  readonly attackerType: string | null;
  /**
   * The rendered skill line (`skill Maw-warded +5 vs maw-of-ashes → bot 7`), or
   * `null` when no skill applied — an unmodified row stays byte-identical.
   */
  readonly skillLine: string | null;
  /** The force actually faced, after aggression and jitter. */
  readonly attackStrength: number;
  /**
   * `effectiveDefenderRating − attackStrength` (negative exactly when the hex
   * fell).
   */
  readonly margin: number;
  /** Whether the attack was queued (`pending`) or opened by the tick. */
  readonly source: 'pending' | 'frontier';
  /** The unheld neighbour the attack came from. */
  readonly attackerOriginId: string;
  /** What the player can do about it (the answerability rule). */
  readonly retake: DefenceRetakePlan;
  /** The row's rendered text (every number, newline separated). */
  readonly label: string;
}

/**
 * The rendered hangar-assault section of a report.
 *
 * Every number is copied from the resolver's `HangarAssaultResolution`; the
 * report never recomputes the strength or the margin (it is a view, not a
 * rule). The lines are the legible consequence: a repel announces the ring won,
 * a fall announces the full campaign reset.
 */
export interface AssaultReportSection {
  /** `repelled` (ring won) or `fell` (the hangar falls). */
  readonly outcome: AssaultOutcome;
  /** The held ring's summed stored defender ratings (from the record). */
  readonly defenderSum: number;
  /** The base massed force derived from the ring's stored numbers. */
  readonly attackerBase: number;
  /** The ring aggression that scaled the assault (from the record). */
  readonly aggression: number;
  /** Aggression multiplier applied, in percent (`100` = neutral). */
  readonly aggressionMultiplierPercent: number;
  /** Bounded seeded jitter applied, in percent (`0` = none). */
  readonly jitterPercent: number;
  /** The force actually faced, after aggression and jitter. */
  readonly attackStrength: number;
  /** `defenderSum − attackStrength` (negative exactly when the hangar fell). */
  readonly margin: number;
  /** `true` when the assault was repelled (the ring is won). */
  readonly ringWon: boolean;
  /** `true` when the hangar fell (the campaign resets). */
  readonly campaignReset: boolean;
  /** One-line outcome headline (`RING WON …` or `HANGAR FALLS …`). */
  readonly headline: string;
  /** The arithmetic that produced the outcome (every number). */
  readonly numbersLine: string;
  /** What the outcome means for the campaign (ring won / full reset). */
  readonly consequenceLine: string;
  /** The section's rendered text (headline, arithmetic, consequence). */
  readonly label: string;
}

/** The complete rendered state of the defence report (pure data). */
export interface DefenceReportModel {
  /** Screen title. */
  readonly title: string;
  /** The clock tick this report belongs to. */
  readonly tick: number;
  /** The player strength the tick distributed within (from the record). */
  readonly playerStrength: number;
  /** The ring's aggression budget the tick carried (from the record). */
  readonly aggressionBudget: number;
  /** The highest aggression regarded as beatable this tick (from the record). */
  readonly beatableCeiling: number;
  /** Per-hex aggression changes the tick applied (from the record). */
  readonly deltas: readonly AggressionDelta[];
  /** How many hexes rose in aggression this tick. */
  readonly rose: number;
  /** How many hexes fell in aggression this tick. */
  readonly fell: number;
  /** Tick line (`TICK 4 · AGG 26/26 · 3 rose, 2 fell`). */
  readonly tickLine: string;
  /** Outcome summary (`ATTACKED 2 · HELD 1 · FELL 1`, or the quiet line). */
  readonly summaryLine: string;
  /** True when the tick resolved no attack at all (a quiet, non-stalling tick). */
  readonly quiet: boolean;
  /** Every attacked hex, in the record's order (weakest margin last). */
  readonly rows: readonly DefenceReportRow[];
  /** How many hexes were attacked this tick. */
  readonly attackedCount: number;
  /** How many of them held. */
  readonly heldCount: number;
  /** How many of them fell. */
  readonly fellCount: number;
  /**
   * The resolved hangar assault this report follows, or `null` for an ordinary
   * between-sortie report (the quiet/no-assault case is unchanged).
   */
  readonly assault: AssaultReportSection | null;
  /** The assault section's rendered text, or `null` when there was none. */
  readonly assaultLine: string | null;
  /** `true` only when an assault was repelled (the ring is won by defence). */
  readonly ringWon: boolean;
  /** `true` only when the hangar fell (the campaign resets). */
  readonly campaignReset: boolean;
  /** The "nothing was simulated" line (the design's no-battle rule). */
  readonly noBattleLine: string;
  /**
   * The banked win-bonus announcement (`WIN BONUS BANKED: +N MINERALS`), or
   * `null` when this landing banked no bonus. Announced, never silently banked
   * (producer Q3 = (b)), so a win reads as real progress on the map.
   */
  readonly winBonusLine: string | null;
  /** The continue action's row key. */
  readonly continueKey: string;
  /** The continue action's rendered label. */
  readonly continueLabel: string;
  /** Keys of the rows that can be activated (exactly the continue action). */
  readonly focusOrder: readonly string[];
  /** The row focused by default (always the continue action). */
  readonly defaultFocusKey: string;
}

/** Optional overrides for {@link buildDefenceReport}. */
export interface BuildDefenceReportOptions {
  /** Screen title override (tests/captures). */
  readonly title?: string;
  /** Continue-label override (tests/captures). */
  readonly continueLabel?: string;
  /**
   * The resolved hangar assault this report follows (the capture gate's
   * `resolveHangarAssault` record). Omitted or `null` → the ordinary
   * between-sortie report, unchanged.
   */
  readonly assault?: HangarAssaultResolution | null;
  /**
   * The fixed mineral **win bonus** this landing banked, when it followed a
   * winning hangar deployment (parent AH-0MWEVNBMM000QFO2, producer Q3 = (b),
   * recorded 2026-11-13). Omitted, `0` or negative → no bonus line, which is
   * the ordinary between-sortie report and every lost deployment.
   *
   * The announcement is the *only* presentation of the win reward now: the
   * run-scoped mini-boss wheel is suppressed on the win path (Q1 = (c)) and the
   * bonus is banked into the persistent war instead (Q2 = (a), minerals only).
   */
  readonly winBonusMinerals?: number;
}

/** `value` as a non-negative integer; anything unusable collapses to `0`. */
function toCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? 0 : integer;
}

/** `value` as a finite number; anything unusable collapses to `0`. */
function toSignedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.trunc(value)
    : 0;
}

/** `margin` with an explicit `+` when positive (the report's sign convention). */
function signed(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}

/** The rendered jitter (`no jitter`, or `jitter +6%` / `jitter -4%`). */
function jitterLabel(percent: number): string {
  return percent === 0
    ? 'no jitter'
    : `jitter ${percent > 0 ? '+' : ''}${percent}%`;
}

/**
 * Builds the report's assault section from the resolver's record, copying every
 * figure verbatim (normalised only the way {@link toCount} is total — a corrupt
 * save can never throw inside a report).
 */
function buildAssaultSection(
  assault: HangarAssaultResolution,
): AssaultReportSection {
  const outcome: AssaultOutcome =
    assault?.outcome === 'fell' ? 'fell' : 'repelled';
  const defenderSum = toCount(assault?.defenderSum);
  const attackerBase = toCount(assault?.attackerBase);
  const aggression = toCount(assault?.aggression);
  const aggressionMultiplierPercent = toCount(assault?.aggressionMultiplierPercent);
  const jitterPercent = toSignedCount(assault?.jitterPercent);
  const attackStrength = toCount(assault?.attackStrength);
  const margin = toSignedCount(assault?.margin);
  const ringWon = outcome === 'repelled';
  const campaignReset = outcome === 'fell';
  const headline = ringWon
    ? ASSAULT_REPELLED_HEADLINE
    : ASSAULT_HANGAR_FALLS_HEADLINE;
  const consequenceLine = ringWon
    ? ASSAULT_REPELLED_CONSEQUENCE
    : ASSAULT_HANGAR_FALLS_CONSEQUENCE;
  const numbersLine =
    `defender sum ${defenderSum} vs massed ${attackerBase} × AGG ${aggression} `
    + `(${aggressionMultiplierPercent}%, ${jitterLabel(jitterPercent)}) `
    + `= ${attackStrength} · margin ${signed(margin)} · ${outcome.toUpperCase()}`;
  return {
    outcome,
    defenderSum,
    attackerBase,
    aggression,
    aggressionMultiplierPercent,
    jitterPercent,
    attackStrength,
    margin,
    ringWon,
    campaignReset,
    headline,
    numbersLine,
    consequenceLine,
    label: [headline, numbersLine, consequenceLine].join('\n'),
  };
}

/** The payload's hex with `id`, or `undefined`. */
function findHex(
  payload: HangarWarPayload,
  hexId: string,
): HexState | undefined {
  return payload.ring.hexes.find((hex) => hex.id === hexId);
}

/**
 * The retake plan for one resolved attack.
 *
 * The origin is the record's attacking neighbour; its aggression is read from
 * the payload (post-tick, so it matches what the map shows). A payload that no
 * longer carries the origin (a partial ring) still yields a plan: the record's
 * own aggression is used and the note simply omits the origin's aggression.
 */
function buildRetakePlan(
  payload: HangarWarPayload,
  record: HexDefenceRecord,
): DefenceRetakePlan {
  const originHex = findHex(payload, record.attackerOriginId);
  const originAggression = toCount(originHex?.aggression);
  const requiredDefenderRating = toCount(record.attackStrength);
  const origin: AxialCoordinate = {
    q: record.attackerOrigin.q,
    r: record.attackerOrigin.r,
  };
  const strike = originHex
    ? `strike ${record.attackerOriginId} (AGG ${originAggression})`
    : `strike ${record.attackerOriginId}`;
  const note =
    record.outcome === 'fell'
      ? `${strike} to stop the pressure, then hold with a bot rated ≥ ${requiredDefenderRating}`
      : `held — a bot rated ≥ ${requiredDefenderRating} would hold it again`;
  return {
    originHexId: record.attackerOriginId,
    origin,
    originAggression,
    requiredDefenderRating,
    note,
  };
}

/**
 * The rendered skill line for a defence that a trained bot's bonus decided.
 *
 * Names the skills applied, their summed bonus and the attacker type they match,
 * and the effective rating they produced — so the player can read *why* a bot the
 * stored numbers alone would have lost a hex actually held it.
 *
 * @param appliedSkills — the skills the resolver applied (in stored order).
 * @param bonus — their summed flat bonus.
 * @param attackerType — the attacking boss identity they matched.
 * @param effectiveRating — the rating the comparison actually used.
 * @returns the rendered line, or `null` when no skill applied.
 */
function skillLine(
  appliedSkills: readonly DefenceSkill[],
  bonus: number,
  attackerType: string | null,
  effectiveRating: number,
): string | null {
  if (appliedSkills.length === 0 || bonus <= 0) return null;
  const names = appliedSkills.map((skill) => skill.name).join(' + ');
  const versus = attackerType === null ? '' : ` vs ${attackerType}`;
  return `skill ${names} +${bonus}${versus} → bot ${effectiveRating}`;
}

/** The rendered text of one attacked hex (every number the tick used). */
function rowLabel(
  record: HexDefenceRecord,
  held: boolean,
  retake: DefenceRetakePlan,
): string {
  const outcome = record.outcome === 'held' ? 'HELD' : 'FELL';
  const state = held ? '' : ' · LOST';
  const source = record.source === 'pending' ? 'queued' : 'frontier';
  const jitter =
    record.jitterPercent === 0
      ? 'no jitter'
      : `jitter ${record.jitterPercent > 0 ? '+' : ''}${record.jitterPercent}%`;
  const skills = skillLine(
    record.appliedSkills,
    record.skillBonusTotal,
    record.attackerType,
    record.effectiveDefenderRating,
  );
  return [
    `${record.hexId} — ${outcome}${state}`,
    `atk ${record.attackingForce} × AGG ${record.aggression} `
      + `(${record.aggressionMultiplierPercent}%, ${jitter}) `
      + `= ${record.attackStrength} vs bot ${record.defenderRating}`,
    ...(skills === null ? [] : [skills]),
    `margin ${record.margin > 0 ? '+' : ''}${record.margin} · ${source} attack`,
    `retake: ${retake.note}`,
  ].join('\n');
}

/**
 * Builds the between-sortie defence report from the tick's record and the
 * stored payload.
 *
 * The record is the sole source of the resolved numbers; the payload supplies
 * the post-tick held state and the attacking neighbour's aggression. The model
 * is total: a missing/partial record yields a quiet report rather than
 * throwing, so a direct scene boot (or a corrupt save) never stalls the demo.
 *
 * @param payload — the stored war payload after the tick (never mutated).
 * @param record — the frontier tick's record (never mutated).
 * @param options — title/continue-label overrides.
 * @returns the complete report model.
 */
export function buildDefenceReport(
  payload: HangarWarPayload,
  record: FrontierTickRecord,
  options: BuildDefenceReportOptions = {},
): DefenceReportModel {
  const attacks = Array.isArray(record?.attacks) ? record.attacks : [];
  // The banked win bonus (producer Q3 = (b)): announced on the report model
  // itself so every renderer shows the same line and no surface re-derives it.
  // A non-positive amount carries no line — the ordinary report and every lost
  // deployment.
  const winBonus = toCount(options.winBonusMinerals ?? 0);
  const winBonusLine =
    winBonus > 0 ? `WIN BONUS BANKED: +${winBonus} MINERALS` : null;

  const rows: DefenceReportRow[] = attacks.map((attack) => {
    const hex = findHex(payload, attack.hexId);
    const held = hex?.held === true;
    const retake = buildRetakePlan(payload, attack);
    const defenderRating = toCount(attack.defenderRating);
    const appliedSkills = Array.isArray(attack.appliedSkills)
      ? [...attack.appliedSkills]
      : [];
    const skillBonusTotal = toCount(attack.skillBonusTotal);
    const effectiveDefenderRating =
      typeof attack.effectiveDefenderRating === 'number' &&
      Number.isFinite(attack.effectiveDefenderRating)
        ? toCount(attack.effectiveDefenderRating)
        : defenderRating + skillBonusTotal;
    const attackerType =
      typeof attack.attackerType === 'string' && attack.attackerType !== ''
        ? attack.attackerType
        : null;
    return {
      key: `defence:${attack.hexId}`,
      hexId: attack.hexId,
      outcome: attack.outcome,
      held,
      attackingForce: toCount(attack.attackingForce),
      aggression: toCount(attack.aggression),
      aggressionMultiplierPercent: toCount(attack.aggressionMultiplierPercent),
      jitterPercent:
        typeof attack.jitterPercent === 'number'
        && Number.isFinite(attack.jitterPercent)
          ? attack.jitterPercent
          : 0,
      defenderRating,
      effectiveDefenderRating,
      skillBonusTotal,
      appliedSkills,
      attackerType,
      skillLine: skillLine(
        appliedSkills,
        skillBonusTotal,
        attackerType,
        effectiveDefenderRating,
      ),
      attackStrength: toCount(attack.attackStrength),
      margin:
        typeof attack.margin === 'number' && Number.isFinite(attack.margin)
          ? attack.margin
          : 0,
      source: attack.source === 'pending' ? 'pending' : 'frontier',
      attackerOriginId: attack.attackerOriginId,
      retake,
      label: rowLabel(attack, held, retake),
    };
  });

  const heldCount = rows.filter((row) => row.outcome === 'held').length;
  const fellCount = rows.filter((row) => row.outcome === 'fell').length;
  const quiet = rows.length === 0;
  const tick = toCount(record?.tick);
  const playerStrength = toCount(record?.playerStrength);
  const aggressionBudget = toCount(record?.aggressionBudget);
  const beatableCeiling = toCount(record?.beatableCeiling);
  const deltas = record?.deltas ?? [];
  const rose = toCount(record?.rose);
  const fell = toCount(record?.fell);
  const assault = options.assault ? buildAssaultSection(options.assault) : null;

  return {
    title: options.title ?? DEFENCE_REPORT_TITLE,
    tick,
    playerStrength,
    aggressionBudget,
    beatableCeiling,
    deltas,
    rose,
    fell,
    tickLine: `TICK ${tick} · AGG ${aggressionBudget}/${aggressionBudget} · ${rose} rose, ${fell} fell`,
    summaryLine: quiet
      ? 'QUIET — no hex was attacked this tick'
      : `ATTACKED ${rows.length} · HELD ${heldCount} · FELL ${fellCount}`,
    quiet,
    rows,
    attackedCount: rows.length,
    heldCount,
    fellCount,
    assault,
    assaultLine: assault?.label ?? null,
    ringWon: assault?.ringWon ?? false,
    campaignReset: assault?.campaignReset ?? false,
    noBattleLine: DEFENCE_REPORT_NO_BATTLE_LINE,
    winBonusLine,
    continueKey: DEFENCE_REPORT_CONTINUE_KEY,
    continueLabel: options.continueLabel ?? DEFENCE_REPORT_CONTINUE_LABEL,
    focusOrder: [DEFENCE_REPORT_CONTINUE_KEY],
    defaultFocusKey: DEFENCE_REPORT_CONTINUE_KEY,
  };
}

/**
 * The unheld neighbour a retake should strike first, or `null` when none.
 *
 * A convenience over {@link buildDefenceReport} for the attract traversal: the
 * first fallen row's origin is the hex that keeps the pressure on. Pure and
 * total — an empty/quiet report has nothing to strike.
 *
 * @param model — a built report model.
 * @returns the hex id to deploy at, or `null` when no hex fell.
 */
export function retakeTargetHex(model: DefenceReportModel): string | null {
  const fallen = model.rows.find((row) => row.outcome === 'fell');
  return fallen ? fallen.attackerOriginId : null;
}

/**
 * Whether the report's origin hex is still a valid, unheld neighbour of the
 * attacked hex — the invariant the answerability rule promises.
 *
 * Exposed so tests (and a future scene hint) can assert the report never
 * points at a hex the player cannot deploy at.
 *
 * @param payload — the payload the report was built from.
 * @param row — one report row.
 * @returns true when the row's retake target is an unheld neighbour.
 */
export function retakeTargetIsAnswerable(
  payload: HangarWarPayload,
  row: DefenceReportRow,
): boolean {
  const attacked = findHex(payload, row.hexId);
  const origin = findHex(payload, row.retake.originHexId);
  if (!attacked || !origin) return false;
  return !origin.held && areNeighbours(attacked, origin);
}
