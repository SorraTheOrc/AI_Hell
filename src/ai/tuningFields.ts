/**
 * Canonical field registry for the bot-tuning gym (AH-0MV4D7LAD009XYR0).
 *
 * The gym exposes one control per entry here, so this module is the single
 * source of the *designer-facing* tuning surface: it names each exposed
 * parameter, groups it, and declares the slider bounds. It is deliberately a
 * pure data module (no DOM, no Phaser) so it can be unit-tested in isolation
 * and reused by the store and the scene.
 *
 * The values it reads and writes are flat {@link BotTuningValues} maps keyed
 * by the parameter path — top-level keys (`mineralSeekRange`) and dotted
 * nested keys (`commitment.minCommitSeconds`, `world.horizon`). The
 * {@link toCompetentOverrides} / {@link toHumanOverrides} helpers reconstruct
 * the nested shapes `createCompetentBotBrain()` and `BotInputGovernor()`
 * expect.
 *
 * @module src/ai/tuningFields
 */

import {
  BOT_HUMAN_INPUT_TUNABLES,
  type BotHumanInputTunables,
} from './botHumanLike';
import {
  COMPETENT_BOT_TUNABLES,
  type CompetentBotTunables,
} from './framework/competent/tunables';
import { BOT_WORLD_TUNABLES } from './framework/worldModel';

/** Which tunable set a field belongs to. */
export type BotTuningGroup = 'competent' | 'human';

/** A scalar numeric tunable exposed as a slider. */
export interface BotTuningFieldSpec {
  readonly group: BotTuningGroup;
  /** Flat key: a top-level name or a dotted nested path (`commitment.switchMargin`). */
  readonly key: string;
  /** Human-readable label shown above/beside the slider. */
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/** A boolean tunable exposed as a checkbox. */
export interface BotTuningToggleSpec {
  readonly group: BotTuningGroup;
  readonly key: string;
  readonly label: string;
}

/**
 * Flat tuning values: `competent` and `human` maps keyed by parameter path.
 * Values are plain numbers/booleans (JSON-serialisable).
 */
export interface BotTuningValues {
  competent: Record<string, number | boolean>;
  human: Record<string, number | boolean>;
}

// ── Field specs ─────────────────────────────────────────────────────

/** Numeric sliders, in panel order. */
export const BOT_TUNING_NUMERIC_FIELDS: readonly BotTuningFieldSpec[] = [
  // Priority / utility bands (what the bot values).
  { group: 'competent', key: 'survivalBase', label: 'survivalBase', min: 0, max: 40, step: 0.5 },
  { group: 'competent', key: 'survivalUrgencyPort', label: 'survivalUrgencyPort', min: 0, max: 20, step: 0.5 },
  { group: 'competent', key: 'lifeBase', label: 'lifeBase', min: 0, max: 20, step: 0.5 },
  { group: 'competent', key: 'mineralBase', label: 'mineralBase', min: 0, max: 20, step: 0.5 },
  { group: 'competent', key: 'powerUpBase', label: 'powerUpBase', min: 0, max: 20, step: 0.5 },
  { group: 'competent', key: 'enemyBase', label: 'enemyBase', min: 0, max: 20, step: 0.5 },
  { group: 'competent', key: 'asteroidBase', label: 'asteroidBase', min: 0, max: 20, step: 0.5 },
  { group: 'competent', key: 'repositionBase', label: 'repositionBase', min: 0, max: 5, step: 0.05 },
  { group: 'competent', key: 'prioritySpan', label: 'prioritySpan', min: 0, max: 3, step: 0.05 },
  { group: 'competent', key: 'enemyWavePressurePort', label: 'enemyWavePressurePort', min: 0, max: 5, step: 0.05 },

  // Seek ranges (px).
  { group: 'competent', key: 'lifeSeekRange', label: 'lifeSeekRange', min: 0, max: 1500, step: 25 },
  { group: 'competent', key: 'mineralSeekRange', label: 'mineralSeekRange', min: 0, max: 1500, step: 25 },
  { group: 'competent', key: 'powerUpSeekRange', label: 'powerUpSeekRange', min: 0, max: 1500, step: 25 },
  { group: 'competent', key: 'enemySeekRange', label: 'enemySeekRange', min: 0, max: 1500, step: 25 },
  { group: 'competent', key: 'asteroidSeekRange', label: 'asteroidSeekRange', min: 0, max: 1500, step: 25 },
  { group: 'competent', key: 'engagementRange', label: 'engagementRange', min: 0, max: 600, step: 5 },
  { group: 'competent', key: 'collectArrivalRadius', label: 'collectArrivalRadius', min: 1, max: 100, step: 1 },
  { group: 'competent', key: 'dangerMargin', label: 'dangerMargin', min: 0, max: 300, step: 5 },
  { group: 'competent', key: 'wallMargin', label: 'wallMargin', min: 0, max: 200, step: 5 },
  { group: 'competent', key: 'threatRadius', label: 'threatRadius', min: 0, max: 300, step: 5 },
  { group: 'competent', key: 'longTravelDistance', label: 'longTravelDistance', min: 0, max: 1000, step: 10 },
  { group: 'competent', key: 'repositionRadius', label: 'repositionRadius', min: 0, max: 600, step: 5 },

  // Motion / prediction.
  { group: 'competent', key: 'playerSpeed', label: 'playerSpeed', min: 0, max: 600, step: 5 },
  { group: 'competent', key: 'firePredictionHorizon', label: 'firePredictionHorizon', min: 0, max: 3, step: 0.05 },
  { group: 'competent', key: 'assumedBulletSpeed', label: 'assumedBulletSpeed', min: 0, max: 800, step: 10 },
  { group: 'competent', key: 'frictionDeceleration', label: 'frictionDeceleration', min: 0, max: 500, step: 5 },
  { group: 'competent', key: 'survivalUrgencyHorizon', label: 'survivalUrgencyHorizon', min: 0, max: 3, step: 0.05 },

  // Aim lead prediction (AH-0MV1DUSM2005HL98).
  { group: 'competent', key: 'aimLeadAlignSeconds', label: 'aimLeadAlignSeconds', min: 0, max: 2, step: 0.05 },
  { group: 'competent', key: 'aimLeadIterations', label: 'aimLeadIterations', min: 1, max: 8, step: 1 },

  // Reverse thruster.
  { group: 'competent', key: 'reverseImminentOvershootGap', label: 'reverseImminentOvershootGap', min: 0, max: 200, step: 2 },
  { group: 'competent', key: 'reverseRetreatRange', label: 'reverseRetreatRange', min: 0, max: 400, step: 5 },

  // Steering scoring.
  { group: 'competent', key: 'progressWeight', label: 'progressWeight', min: 0, max: 5, step: 0.05 },
  { group: 'competent', key: 'clearanceWeight', label: 'clearanceWeight', min: 0, max: 5, step: 0.05 },
  { group: 'competent', key: 'clearanceCap', label: 'clearanceCap', min: 0, max: 1500, step: 10 },

  // Commitment / hysteresis.
  { group: 'competent', key: 'commitment.minCommitSeconds', label: 'minCommitSeconds', min: 0, max: 3, step: 0.05 },
  { group: 'competent', key: 'commitment.switchMargin', label: 'switchMargin', min: 0, max: 3, step: 0.05 },
  { group: 'competent', key: 'commitment.challengerPersistenceSeconds', label: 'challengerPersistenceSeconds', min: 0, max: 3, step: 0.05 },

  // World-model overrides.
  { group: 'competent', key: 'world.horizon', label: 'world.horizon', min: 0, max: 3, step: 0.05 },
  { group: 'competent', key: 'world.threatRadius', label: 'world.threatRadius', min: 0, max: 300, step: 5 },
  { group: 'competent', key: 'world.assumedBulletSpeed', label: 'world.assumedBulletSpeed', min: 0, max: 800, step: 10 },

  // Human-like input cadence.
  { group: 'human', key: 'reactionTimeMs', label: 'reactionTimeMs', min: 0, max: 1000, step: 10 },
  { group: 'human', key: 'alignmentToleranceRad', label: 'alignmentToleranceRad', min: 0, max: 1, step: 0.01 },
  { group: 'human', key: 'skill', label: 'skill', min: 0, max: 1, step: 0.01 },
  { group: 'human', key: 'maxAimErrorRad', label: 'maxAimErrorRad', min: 0, max: 1.5, step: 0.01 },
  { group: 'human', key: 'thrustPressMinMs', label: 'thrustPressMinMs', min: 0, max: 1000, step: 5 },
  { group: 'human', key: 'thrustPressMaxMs', label: 'thrustPressMaxMs', min: 0, max: 1000, step: 5 },
  { group: 'human', key: 'thrustPressMaxMsLong', label: 'thrustPressMaxMsLong', min: 0, max: 1500, step: 5 },
  { group: 'human', key: 'thrustPressGentleMinPct', label: 'thrustPressGentleMinPct', min: 0, max: 0.5, step: 0.01 },
  { group: 'human', key: 'thrustPressGentleMaxPct', label: 'thrustPressGentleMaxPct', min: 0, max: 0.5, step: 0.01 },
  { group: 'human', key: 'reversePressMinMs', label: 'reversePressMinMs', min: 0, max: 1000, step: 5 },
  { group: 'human', key: 'reversePressMaxMs', label: 'reversePressMaxMs', min: 0, max: 1500, step: 5 },
  { group: 'human', key: 'reversePressGentleMinPct', label: 'reversePressGentleMinPct', min: 0, max: 0.5, step: 0.01 },
  { group: 'human', key: 'reversePressGentleMaxPct', label: 'reversePressGentleMaxPct', min: 0, max: 0.5, step: 0.01 },
];

/** Boolean toggles, in panel order. */
export const BOT_TUNING_TOGGLES: readonly BotTuningToggleSpec[] = [
  { group: 'competent', key: 'reverseBrakeEnabled', label: 'reverseBrakeEnabled' },
  { group: 'competent', key: 'aimLeadEnabled', label: 'aimLeadEnabled' },
  { group: 'human', key: 'allowDown', label: 'allowDown' },
];

// ── Defaults ────────────────────────────────────────────────────────

/** Reads a flat key (including dotted nested paths) from a value record. */
function readPath(
  source: Record<string, unknown>,
  key: string,
): unknown {
  if (!key.includes('.')) return source[key];
  const [head, ...rest] = key.split('.');
  let cursor: unknown = source[head];
  for (const part of rest) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

/** Writes a flat key (including dotted nested paths) into a value record. */
function writePath(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!key.includes('.')) {
    target[key] = value;
    return;
  }
  const parts = key.split('.');
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const next = cursor[part];
    if (next === null || typeof next !== 'object') {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * The committed default tuning, flattened to {@link BotTuningValues}.
 *
 * `commitment.*` reads from the competent tunables' own override (the value
 * `resolveCompetentTunables()` actually uses). `world.*` reads from
 * {@link BOT_WORLD_TUNABLES} because the competent tunables ship an empty
 * `world` override and fall back to the world-model defaults.
 */
export function defaultBotTuningValues(): BotTuningValues {
  const competent: Record<string, number | boolean> = {};
  const human: Record<string, number | boolean> = {};
  const competentSource = COMPETENT_BOT_TUNABLES as unknown as Record<string, unknown>;
  const humanSource = BOT_HUMAN_INPUT_TUNABLES as unknown as Record<string, unknown>;
  const worldSource = BOT_WORLD_TUNABLES as unknown as Record<string, unknown>;

  for (const field of BOT_TUNING_NUMERIC_FIELDS) {
    const target = field.group === 'competent' ? competent : human;
    const source = field.group === 'competent' ? competentSource : humanSource;
    let value = readPath(source, field.key);
    if (typeof value !== 'number' && field.key.startsWith('world.')) {
      value = readPath(worldSource, field.key.slice('world.'.length));
    }
    target[field.key] = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  for (const toggle of BOT_TUNING_TOGGLES) {
    const source = toggle.group === 'competent' ? competentSource : humanSource;
    const target = toggle.group === 'competent' ? competent : human;
    target[toggle.key] = Boolean(readPath(source, toggle.key));
  }

  return { competent, human };
}

// ── Read / write ────────────────────────────────────────────────────

/** Reads a numeric field's current value from flat values (0 when absent). */
export function readTuningNumber(
  values: BotTuningValues,
  field: BotTuningFieldSpec,
): number {
  const raw = values[field.group][field.key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/** Reads a toggle's current value from flat values (false when absent). */
export function readTuningBoolean(
  values: BotTuningValues,
  toggle: BotTuningToggleSpec,
): boolean {
  return values[toggle.group][toggle.key] === true;
}

/** Writes a numeric field into flat values (clamped to its declared bounds). */
export function writeTuningNumber(
  values: BotTuningValues,
  field: BotTuningFieldSpec,
  value: number,
): void {
  const clamped = Math.max(field.min, Math.min(field.max, value));
  values[field.group][field.key] = clamped;
}

/** Writes a toggle into flat values. */
export function writeTuningBoolean(
  values: BotTuningValues,
  toggle: BotTuningToggleSpec,
  value: boolean,
): void {
  values[toggle.group][toggle.key] = value;
}

// ── Overrides for the brain / governor ──────────────────────────────

/**
 * Reconstructs the nested `Partial<CompetentBotTunables>` the competent brain
 * consumes from flat values. `commitment.*` and `world.*` are nested under
 * their own objects; every other key is a top-level scalar/toggle.
 */
export function toCompetentOverrides(
  values: BotTuningValues,
): Partial<CompetentBotTunables> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values.competent)) {
    writePath(out, key, value);
  }
  return out as Partial<CompetentBotTunables>;
}

/** Reconstructs the flat `Partial<BotHumanInputTunables>` for the governor. */
export function toHumanOverrides(
  values: BotTuningValues,
): Partial<BotHumanInputTunables> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values.human)) {
    writePath(out, key, value);
  }
  return out as Partial<BotHumanInputTunables>;
}

// ── Validation / serialisation ──────────────────────────────────────

/** True when `value` is a JSON-safe tuning scalar. */
function isTuningScalar(value: unknown): value is number | boolean {
  return typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * Coerces an unknown record into a valid {@link BotTuningValues}, dropping
 * non-scalar entries. Missing fields are filled from the defaults so a config
 * saved by an older build keeps working after new sliders are added.
 */
export function coerceTuningValues(raw: unknown): BotTuningValues {
  const defaults = defaultBotTuningValues();
  if (raw === null || typeof raw !== 'object') return defaults;
  const record = raw as Record<string, unknown>;
  for (const group of ['competent', 'human'] as const) {
    const incoming = record[group];
    if (incoming === null || typeof incoming !== 'object') continue;
    for (const [key, value] of Object.entries(incoming as Record<string, unknown>)) {
      if (isTuningScalar(value)) defaults[group][key] = value;
    }
  }
  return defaults;
}
