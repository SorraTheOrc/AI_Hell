/**
 * Per-wave elite spawn planning (AH-0MWU665DM00669U0).
 *
 * An elite is **not** a new entity: it is one ordinary, counted spawn whose
 * archetype already declares an `eliteBehaviour` in
 * `src/data/enemy-configs.csv` (see `src/core/eliteVocabulary.ts`, the
 * vocabulary/validation leaf delivered by AH-0MWU664T300140IL). Planning an
 * elite therefore **elevates one existing spawn** of the wave rather than
 * adding a body, so:
 *
 * - the wave's archetype *set* is unchanged (the campaign variety/signature
 *   audit cannot drift, parent AC8);
 * - the elite is registered as a counted wave enemy exactly like any other
 *   spawn of its group, so `WaveManager._enemiesAlive` gates the wave and the
 *   wave-timeout carry-over rule applies unchanged (parent AC3);
 * - the spawn keeps its formation position, so enabling elites never shifts
 *   the rest of the wave.
 *
 * ## Determinism contract (AC4)
 *
 * A wave's elite plan is drawn from **its own stream**, derived from the run
 * seed and the wave's cumulative zero-based `globalWaveIndex`
 * ({@link deriveEliteWaveSeed}). This module is the single place that index
 * and the draw order are defined. Within a wave's elite stream draws are
 * consumed in exactly this order:
 *
 * 1. **budget roll** — one draw, granted when `draw < chance`;
 * 2. **archetype** — one draw, an index into the wave's eligible archetypes
 *    (in wave-group order, de-duplicated);
 * 3. **slot** — one draw, an index among that archetype's planned spawns
 *    (skipped when it spawns exactly one enemy).
 *
 * Constraints that bound the draws:
 *
 * - **Level 1 is exempt** (AC3) and consumes nothing.
 * - **An authored elite** (`WaveDefinition.elite`) consumes no budget draw
 *   and always elevates the first spawn of its archetype.
 * - **A chance of `0`** (the shipped default) consumes nothing at all — no
 *   draw, no config resolution — so today's runs are byte-for-byte unchanged.
 *
 * Because each wave owns a derived stream, the plan is a pure function of
 * `(runSeed, globalWaveIndex, wave, chance)` and is independent of how many
 * draws the rest of the wave or run consumed. Same seed + same wave ⇒ same
 * elite, same position (AC4); the reward is a pure function of the elite's
 * archetype and level, delivered by AH-0MWU666IS008JOR3.
 *
 * Pure — no Phaser dependency, so it runs in the fast unit project.
 *
 * @module src/waves/eliteSpawn
 */

import { loadEnemyConfig } from '../core/enemyConfig';
import type { EnemyConfig } from '../core/configTypes';
import { isEliteBehaviour, isUncountedHazardKey } from '../core/eliteVocabulary';
import { normaliseSeed, createSeededRng } from '../core/rng';
import { formationSpawnCount } from '../utils/formations';
import type { WaveDefinition } from './Formations';

/**
 * Share of eligible waves the seeded budget grants an elite to.
 *
 * Ships **on** at the proposed **15 %**. It was authored/off (`0`) until the
 * same-seed bot batch cleared the experience-target bands (parent AC9); the
 * evidence and the enable decision are recorded in
 * `docs/BALANCING.md` (AH-0MWU667OG00287SY). The shipped campaign authors the
 * variant axis on its ordinary archetypes (`src/data/enemy-configs.csv`), so
 * this budget is what fields a seeded elite. Level 1 stays exempt regardless.
 */
export const ELITE_WAVE_CHANCE = 0.15;

/** The onboarding level that never spawns an elite (parent AC2, level 1). */
export const ELITE_EXEMPT_LEVEL = 1;

/**
 * Domain salt for the elite stream. Keeps the elite draws independent of
 * every other seeded stream (run gameplay, campaign building, bot choice),
 * mirroring the dedicated-stream pattern in `src/ai/eval/arena.ts`.
 */
export const ELITE_STREAM_SALT = 0x0e117e55;

/** How the wave's elite was chosen. */
export type EliteSpawnSource = 'authored' | 'budget';

/** The elite reserved by a wave's spawn plan. */
export interface EliteSpawnPlan {
  /** Archetype key elevated to elite; always one of the wave's groups. */
  readonly enemyKey: string;
  /**
   * Zero-based index among the spawn plan's entries for {@link enemyKey}
   * (group order, then formation slot order).
   */
  readonly slotIndex: number;
  /** Whether the wave authored the elite or the seeded budget granted it. */
  readonly source: EliteSpawnSource;
}

/** Inputs to {@link planEliteSpawn}. */
export interface EliteSpawnInput {
  /** 1-based campaign level of the wave (level 1 is exempt). */
  level: number;
  /**
   * Cumulative zero-based regular-wave index across the campaign — the
   * stream index this wave's elite draws are taken from.
   */
  globalWaveIndex: number;
  /** The run's seed. */
  runSeed: number;
  /** The wave being planned. */
  wave: WaveDefinition;
  /** Budget share; defaults to {@link ELITE_WAVE_CHANCE}. */
  chance?: number;
  /** Archetype resolver; defaults to the CSV-backed config store. */
  configFor?: (enemyKey: string) => EnemyConfig;
}

/**
 * Derives the wave's dedicated elite-stream seed from the run seed and the
 * wave's cumulative index.
 *
 * The index is mixed in (rather than the stream being consumed sequentially)
 * so a wave's elite plan never depends on how many draws earlier waves made.
 * `globalWaveIndex` is clamped to a non-negative integer so a caller that
 * reports the sentinel `0` outside a playable wave still yields a stable
 * stream.
 */
export function deriveEliteWaveSeed(
  runSeed: number,
  globalWaveIndex: number,
): number {
  const index = Number.isFinite(globalWaveIndex)
    ? Math.max(0, Math.floor(globalWaveIndex))
    : 0;
  return normaliseSeed(
    normaliseSeed(runSeed) ^
      ELITE_STREAM_SALT ^
      Math.imul(index + 1, 0x9e3779b1),
  );
}

/** Picks a uniform index in `[0, count)` from `rng`, clamped for safety. */
function pickIndex(rng: () => number, count: number): number {
  if (count <= 1) return 0;
  const draw = rng();
  const index = Math.floor(draw * count);
  return Math.min(count - 1, Math.max(0, index));
}

/**
 * True when `enemyKey` may be elevated: it is one of the wave's groups, is a
 * counted archetype (never an uncounted hazard — parent AC3/AC6) and its
 * config declares a bounded elite behaviour.
 */
function isEliteEligible(
  enemyKey: string,
  wave: WaveDefinition,
  configFor: (enemyKey: string) => EnemyConfig,
): boolean {
  if (isUncountedHazardKey(enemyKey)) return false;
  if (!wave.groups.some((group) => group.enemyKey === enemyKey)) return false;
  return isEliteBehaviour(configFor(enemyKey).eliteBehaviour);
}

/**
 * The wave's eligible archetype keys in authored group order, de-duplicated.
 * Only archetypes that declare an elite behaviour can be elite, so the elite
 * always carries exactly one bounded extra behaviour.
 */
function eligibleArchetypes(
  wave: WaveDefinition,
  configFor: (enemyKey: string) => EnemyConfig,
): string[] {
  const keys: string[] = [];
  for (const group of wave.groups) {
    const key = group.enemyKey;
    if (keys.includes(key)) continue;
    if (!isEliteEligible(key, wave, configFor)) continue;
    keys.push(key);
  }
  return keys;
}

/** Number of planned spawns of `enemyKey` in the wave's spawn plan. */
function plannedSpawnCount(wave: WaveDefinition, enemyKey: string): number {
  return wave.groups.reduce(
    (total, group) =>
      group.enemyKey === enemyKey
        ? total + formationSpawnCount(group.formation, group.count)
        : total,
    0,
  );
}

/**
 * Resolves the wave's elite spawn plan, or `null` when the wave fields no
 * elite.
 *
 * Precedence (parent AC1): an **authored** elite wins; otherwise the seeded
 * **budget** may grant one. An authored key that is absent from the wave or
 * not elite-capable resolves to `null` — a bad authoring value never spawns a
 * broken elite. Level 1 ({@link ELITE_EXEMPT_LEVEL}) never plans an elite,
 * regardless of authorship or the budget roll (parent AC2).
 *
 * The seed is taken from {@link deriveEliteWaveSeed}; see the module doc for
 * the documented draw order.
 */
export function planEliteSpawn(input: EliteSpawnInput): EliteSpawnPlan | null {
  const { wave } = input;
  const chance = input.chance ?? ELITE_WAVE_CHANCE;
  const configFor = input.configFor ?? loadEnemyConfig;

  // Parent AC2/AC3: onboarding never fields an elite — before any draw.
  if (input.level === ELITE_EXEMPT_LEVEL) return null;

  const authored = wave.elite?.trim();
  if (authored) {
    if (!isEliteEligible(authored, wave, configFor)) return null;
    // Documented order: an authored elite spends no draw; the first spawn of
    // its archetype is the elite.
    return { enemyKey: authored, slotIndex: 0, source: 'authored' };
  }

  // The shipped default is off: consume nothing (no draw, no config lookup),
  // so an ordinary run is byte-for-byte unchanged.
  if (!(chance > 0)) return null;

  const eligible = eligibleArchetypes(wave, configFor);
  if (eligible.length === 0) return null;

  const rng = createSeededRng(
    deriveEliteWaveSeed(input.runSeed, input.globalWaveIndex),
  );

  // Draw 1 — budget roll. The wave authors no elite, so it is granted on the
  // configured share of eligible waves.
  if (rng() >= chance) return null;

  // Draw 2 — archetype.
  const enemyKey = eligible[pickIndex(rng, eligible.length)];

  // Draw 3 — slot (skipped for a single-spawn archetype).
  const slotCount = plannedSpawnCount(wave, enemyKey);
  const slotIndex = slotCount > 1 ? pickIndex(rng, slotCount) : 0;

  return { enemyKey, slotIndex, source: 'budget' };
}
