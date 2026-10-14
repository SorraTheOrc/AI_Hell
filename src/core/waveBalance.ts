/**
 * Pure wave-balance rules (AH-0MV84TE7O006HI3R; parent AH-0MV29XQ0H009P9WP).
 *
 * A Phaser-free module pinning the wave-design balance rules R1–R3 as pure
 * functions over a wave's groups (resolved to behavioural classifications),
 * plus a pure audit validator that reuses the same functions (single source
 * of truth — parent Q1=c). The rules are the *contract* consumed by:
 *
 * - the runtime auto-sequencer hard-constraint enforcement (F3,
 *   `src/core/difficultySequencer.ts`),
 * - the classification-driven opening curation (F4,
 *   `src/waves/sequencedLevels.ts`),
 * - the campaign audit / gym-parity verification (F5),
 *
 * and the tests in `waveBalance.test.ts` (from F1, AH-0MV84T78T008AB3E).
 *
 * The module has no Phaser import and runs under Vitest, like
 * `enemyDifficulty.ts`. Classification resolves through
 * {@link classifyArchetype}, which reads {@link DEFAULT_ENEMY_CONFIGS} and
 * falls back to the documented defaults for unknown keys.
 *
 * @module waveBalance
 */

import { DEFAULT_ENEMY_CONFIGS } from './configDefaults';
import type {
  DifficultyGeneration,
  EnemyAttackClass,
  EnemyConfig,
  EnemyMovementClass,
  EnemyShotPattern,
} from './configTypes';

// ── Behavioural classification fixture ───────────────────────────────

/**
 * The two wave-design-facing classification axes of an archetype
 * (AH-0MV29NWI1007NKN7).
 */
export interface ArchetypeClassification {
  /** Coarse behavioural movement class. */
  movementClass: EnemyMovementClass;
  /** Ranged/special attack class; `contact` is contact-only. */
  attackClass: EnemyAttackClass;
}

/**
 * Documented default `movementClass` for unknown archetype keys — the
 * formation behaviours are the largest family (mirrors the CSV codec
 * default in `csv.ts`).
 */
export const DEFAULT_MOVEMENT_CLASS: EnemyMovementClass = 'formation';

/**
 * Derive the documented default `attackClass` from a shot pattern
 * (AH-0MV29NWI1007NKN7): a non-firing archetype (`none`) is contact-only,
 * every firing archetype defaults to `projectile`.
 */
export function deriveAttackClassFromShotPattern(
  pattern: EnemyShotPattern,
): EnemyAttackClass {
  return pattern === 'none' ? 'contact' : 'projectile';
}

/**
 * Classification fixture — resolve an archetype key to its behavioural
 * classification.
 *
 * Known keys are taken from the supplied config map (default
 * {@link DEFAULT_ENEMY_CONFIGS}); unknown keys fall back to the documented
 * defaults: `movementClass` `formation`, `attackClass` `projectile` (the
 * generic default archetype carries `shotPattern: 'aimed'`, which derives
 * to `projectile` via {@link deriveAttackClassFromShotPattern}).
 *
 * @param enemyKey — archetype key (config-store or seed key).
 * @param configs — config map to resolve against; defaults to the seed
 *   defaults so the fixture works without the CSV boot loader.
 */
export function classifyArchetype(
  enemyKey: string,
  configs: Readonly<Record<string, EnemyConfig>> = DEFAULT_ENEMY_CONFIGS,
): ArchetypeClassification {
  const config = configs[enemyKey];
  if (!config) {
    return {
      movementClass: DEFAULT_MOVEMENT_CLASS,
      attackClass: deriveAttackClassFromShotPattern('aimed'),
    };
  }
  return {
    movementClass: config.movementClass ?? DEFAULT_MOVEMENT_CLASS,
    attackClass:
      config.attackClass ??
      deriveAttackClassFromShotPattern(config.shotPattern),
  };
}

/**
 * A wave group reduced to exactly the classification axes the rules read.
 */
export interface ClassifiedGroup extends ArchetypeClassification {
  /** Enemy config key the group is spawned from. */
  enemyKey: string;
}

/**
 * Classify a single wave group key (see {@link classifyArchetype}).
 */
export function classifyGroup(
  enemyKey: string,
  configs: Readonly<Record<string, EnemyConfig>> = DEFAULT_ENEMY_CONFIGS,
): ClassifiedGroup {
  return { enemyKey, ...classifyArchetype(enemyKey, configs) };
}

/**
 * Classify a wave's groups from their archetype keys, preserving play order.
 */
export function classifyWaveGroups(
  groups: readonly { enemyKey: string }[],
  configs: Readonly<Record<string, EnemyConfig>> = DEFAULT_ENEMY_CONFIGS,
): ClassifiedGroup[] {
  return groups.map((group) => classifyGroup(group.enemyKey, configs));
}

// ── Named, tunable rule constants ─────────────────────────────────────

/**
 * R1 opening positions — the `dynamic` onboarding slots (waves 1–2 of
 * levels 1–2), consumed by the campaign builder
 * (`src/waves/sequencedLevels.ts`), the sequencer F3 guard and the validator
 * (single source of truth).
 */
export const OPENING_WAVE_POSITIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [1, 2],
  [2, 1],
  [2, 2],
];

/**
 * True when the (level, wave) pair is an R1 opening position.
 */
export function isOpeningWavePosition(level: number, wave: number): boolean {
  return OPENING_WAVE_POSITIONS.some(
    ([openingLevel, openingWave]) =>
      openingLevel === level && openingWave === wave,
  );
}

/**
 * R1 — the only `movementClass` values an opening wave may contain
 * (`formation`, `diver`). Chasers/patrollers/roamers are excluded.
 */
export const OPENING_MOVEMENT_CLASSES: readonly EnemyMovementClass[] = [
  'formation',
  'diver',
];

/**
 * R2 — the `movementClass` that must never fill a whole wave.
 */
export const CHASER_MOVEMENT_CLASS: EnemyMovementClass = 'chaser';

/**
 * R3 — `attackClass` values counted as ranged attackers.
 */
export const RANGED_ATTACK_CLASSES: readonly EnemyAttackClass[] = [
  'projectile',
  'beam',
  'area',
];

/**
 * R3 ranged-share cap (named tunable constant).
 *
 * A *firing* wave fails R3 when the fraction of its groups that are ranged
 * attackers (`attackClass ∈ RANGED_ATTACK_CLASSES`) reaches this cap. The
 * comparison is strict (`rangedShare < RANGED_SHARE_CAP`), so with the
 * default cap of `1` the rule is exactly "at least one effective-contact
 * group": an all-ranged wave fails, any wave with a single contact group
 * passes. Lowering the cap tightens the mix — e.g. `0.5` would force at
 * least half of the groups to be contact — which is why it is a named
 * tunable.
 */
export const RANGED_SHARE_CAP = 1;

// ── Rule results ──────────────────────────────────────────────────────

export type RuleId = 'R1' | 'R2' | 'R3';

/** Outcome of one rule check over one wave. */
export interface RuleResult {
  /** Rule identifier. */
  id: RuleId;
  /** True when the wave satisfies the rule. */
  pass: boolean;
  /** False when the rule does not apply to this wave (e.g. R1 on a non-opening wave). */
  applicable: boolean;
  /** Human-readable explanation of the outcome. */
  message: string;
}

// ── R1 — opening-wave purity ──────────────────────────────────────────

/**
 * R1 — opening-wave purity: every group of an opening wave must use a
 * `movementClass` in {@link OPENING_MOVEMENT_CLASSES}.
 *
 * `attackClass` is deliberately unconstrained: onboarding waves are no-fire
 * and their existing openers (scout/diver/swarm) are `projectile`-class.
 *
 * @param groups — the wave's groups, resolved to classifications.
 */
export function checkOpeningPurity(
  groups: readonly ClassifiedGroup[],
): RuleResult {
  const offenders = groups.filter(
    (group) => !OPENING_MOVEMENT_CLASSES.includes(group.movementClass),
  );
  if (offenders.length === 0) {
    return {
      id: 'R1',
      pass: true,
      applicable: true,
      message: `Opening wave contains only ${OPENING_MOVEMENT_CLASSES.join(' / ')} movement (${listKeys(groups)}).`,
    };
  }
  return {
    id: 'R1',
    pass: false,
    applicable: true,
    message: `Opening wave contains ${offenders[0].movementClass} movement in group '${offenders[0].enemyKey}' (allowed: ${OPENING_MOVEMENT_CLASSES.join(' / ')}).`,
  };
}

// ── R2 — no all-chaser wave ───────────────────────────────────────────

/**
 * R2 — no all-chaser wave: a wave may not be composed entirely of
 * `movementClass === 'chaser'` groups.
 *
 * @param groups — the wave's groups, resolved to classifications.
 */
export function checkNoAllChaser(
  groups: readonly ClassifiedGroup[],
): RuleResult {
  const chaserKeys = groups
    .filter((group) => group.movementClass === CHASER_MOVEMENT_CLASS)
    .map((group) => group.enemyKey);
  if (groups.length > 0 && chaserKeys.length === groups.length) {
    return {
      id: 'R2',
      pass: false,
      applicable: true,
      message: `Wave is composed entirely of ${CHASER_MOVEMENT_CLASS} groups (${chaserKeys.join(', ')}).`,
    };
  }
  return {
    id: 'R2',
    pass: true,
    applicable: groups.length > 0,
    message:
      groups.length === 0
        ? 'Wave has no groups — nothing to check.'
        : `Wave includes ${groups.length - chaserKeys.length} non-chaser group(s), so it is not all-chaser.`,
  };
}

// ── R3 — bounded ranged mix ───────────────────────────────────────────

/**
 * R3 — bounded ranged mix (effective-attack semantics, producer Q1).
 *
 * A *firing* wave (`shootEnabled === true`) must not be composed entirely
 * of ranged attackers: the share of ranged groups must stay strictly below
 * {@link RANGED_SHARE_CAP}. A no-fire wave (`shootEnabled === false`) has
 * every group count as effective contact, so it always passes regardless of
 * `attackClass`.
 *
 * @param groups — the wave's groups, resolved to classifications.
 * @param shootEnabled — the wave's effective firing state.
 */
export function checkBoundedRangedMix(
  groups: readonly ClassifiedGroup[],
  shootEnabled: boolean,
): RuleResult {
  if (!shootEnabled) {
    return {
      id: 'R3',
      pass: true,
      applicable: groups.length > 0,
      message: 'No-fire wave — every group counts as effective contact, so R3 is satisfied by construction.',
    };
  }
  if (groups.length === 0) {
    return {
      id: 'R3',
      pass: true,
      applicable: false,
      message: 'Wave has no groups — nothing to check.',
    };
  }
  const ranged = groups.filter((group) =>
    RANGED_ATTACK_CLASSES.includes(group.attackClass),
  );
  const rangedShare = ranged.length / groups.length;
  if (rangedShare < RANGED_SHARE_CAP) {
    return {
      id: 'R3',
      pass: true,
      applicable: true,
      message: `Firing wave includes ${groups.length - ranged.length} effective-contact group(s), keeping the ranged share (${formatShare(rangedShare)}) below the cap (${RANGED_SHARE_CAP}).`,
    };
  }
  return {
    id: 'R3',
    pass: false,
    applicable: true,
    message: `Firing wave is composed entirely of ranged attackers — ${ranged.length} of ${groups.length} group(s) (${formatShare(rangedShare)}), reaching the ranged-share cap (${RANGED_SHARE_CAP}).`,
  };
}

// ── Audit validator ───────────────────────────────────────────────────

/**
 * A single wave for the validator, with enough context to apply the rules.
 */
export interface BalancedWave {
  /** Optional wave identifier (e.g. `"2:3"`) echoed into the report. */
  id?: string;
  /** The wave's groups, resolved to classifications. */
  groups: readonly ClassifiedGroup[];
  /**
   * Effective firing state. `false` ⇒ every group counts as effective
   * contact for R3 (producer Q1).
   */
  shootEnabled: boolean;
  /**
   * True when this wave sits at an R1 opening position (see
   * {@link isOpeningWavePosition}). R1 is only evaluated for opening waves.
   */
  isOpening?: boolean;
  /**
   * Generation mode. `fixed` waves are hand-authored and exempt from the
   * rules (producer Q3=a): the audit reports them as exempt rather than
   * checking them.
   */
  generation?: DifficultyGeneration;
}

/** Per-wave audit result: overall pass/fail plus one {@link RuleResult} per rule. */
export interface WaveRuleAudit {
  id?: string;
  pass: boolean;
  exempt: boolean;
  rules: readonly RuleResult[];
}

/** Aggregate audit result over a list of waves. */
export interface BalanceAudit {
  pass: boolean;
  waves: readonly WaveRuleAudit[];
}

/**
 * Audit a single wave against R1–R3, reusing the same rule functions as the
 * generator (single source of truth — parent Q1=c).
 *
 * - `fixed` waves are exempt (reported with `exempt: true`, no rules).
 * - R1 is evaluated only when `isOpening` is set.
 * - R2 and R3 are always evaluated for generated waves.
 */
export function auditWave(wave: BalancedWave): WaveRuleAudit {
  if (wave.generation === 'fixed') {
    return {
      id: wave.id,
      pass: true,
      exempt: true,
      rules: [],
    };
  }
  const rules: RuleResult[] = [
    wave.isOpening
      ? checkOpeningPurity(wave.groups)
      : {
          id: 'R1',
          pass: true,
          applicable: false,
          message: 'Not an opening wave — R1 does not apply.',
        },
    checkNoAllChaser(wave.groups),
    checkBoundedRangedMix(wave.groups, wave.shootEnabled),
  ];
  return {
    id: wave.id,
    pass: rules.every((rule) => rule.pass),
    exempt: false,
    rules,
  };
}

/**
 * Audit a list of waves against R1–R3. Returns the aggregate verdict plus
 * per-wave verdicts and per-rule human-readable messages.
 */
export function auditWaves(waves: readonly BalancedWave[]): BalanceAudit {
  const audited = waves.map(auditWave);
  return { pass: audited.every((wave) => wave.pass), waves: audited };
}

// ── Internal helpers ──────────────────────────────────────────────────

/** Join group keys for a human-readable message. */
function listKeys(groups: readonly ClassifiedGroup[]): string {
  const keys = groups.map((group) => group.enemyKey);
  return keys.length > 0 ? `'${keys.join("', '")}'` : '(none)';
}

/** Format a group share for messages (e.g. `0.5` → `50%`). */
function formatShare(share: number): string {
  return `${Math.round(share * 100)}%`;
}
