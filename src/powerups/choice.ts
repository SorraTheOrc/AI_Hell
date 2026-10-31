/**
 * Pluggable power-up choice strategy (GDD §4.5, AH-0MUBVGI62004ED9Q).
 *
 * When the ship's hold fills, the game pauses and offers a small set of
 * power-ups to choose from. This module owns the *selection policy* — which
 * options are offered — behind a small `ChoiceStrategy` interface, so the
 * policy can be swapped (random, weighted, scripted, …) without changing the
 * choice scene or the PlayScene wiring.
 *
 * The default strategy draws `count` **distinct** entries at weighted random
 * from the candidate list — the base drop pool (every power-up and every
 * collectable weapon drop, i.e. the full catalogue minus the `reset` utility)
 * with each owned item's base entry replaced by its level-up offer (see
 * {@link buildChoiceCandidates}) — degrading gracefully (returning fewer
 * options) when the list cannot supply the requested count. Owned level-up
 * offers (`weapon-level`/`power-up-level`) carry a 1.35× weight
 * ({@link OWNED_UPGRADE_BONUS_WEIGHT}) while unowned base entries keep 1.0×,
 * so an owned upgrade appears 35% more often than it would under a uniform
 * draw (AH-0MUY47W62005FF74; retuned 1.1×→1.25× then 1.25×→1.35× by
 * AH-0MVCFB00Y004AQ2Z).
 *
 * @module src/powerups/choice
 */

import {
  POWER_UP_CATALOGUE,
  isWeaponDrop as isWeaponDropId,
  type DropId,
  type PowerUpId,
  type WeaponDropId,
} from './types';
import type { WeaponId } from '../utils/weapons';
import { summariseWeaponLevelChange } from '../utils/weaponLevels';
import { summarisePowerUpLevelChange } from './powerUpLevels';
import { getDropDescription } from './dropDescriptions';
import { isWithinSlotPool, resolveSlotState } from './slots';

// ── Pool ────────────────────────────────────────────────────────────

/**
 * Every drop the hold-full choice can offer: the **whole** drop catalogue —
 * all sixteen power-ups plus every collectable weapon drop — minus only the
 * `reset` utility drop, which is intentionally excluded because it removes
 * weapons rather than granting one.
 *
 * Kept catalogue-derived by the regression test in
 * `__tests__/choice.test.ts` (pool === catalogue − `reset`), so a newly
 * shipped power-up or weapon can never silently go missing from the choice
 * again (AH-0MVI4KTD8000FBJ7). There is deliberately **no** unlock-state
 * gating: every drop is a candidate in the game and in every gym, because
 * both consume this one pool (gym↔game parity, AH-0MUGZDTFX004RBD1).
 */
export const CHOICE_POOL: readonly DropId[] = [
  // Power-ups (Shield–Mineral Scoop, the classic trio, and the net-new
  // frenzy/chrono/thorns/salvage/strike).
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'extra_life',
  'magnet',
  'mineral_scoop',
  'smart_bomb',
  'force_field',
  'mystery_ufo',
  'frenzy',
  'chrono',
  'thorns',
  'salvage',
  'strike',
  // Collectable weapon drops (every weapon except the Reset utility).
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
];

// ── Option model ────────────────────────────────────────────────────

/**
 * The kind of option offered:
 * - `'powerup'` — a power-up grant (any catalogue power-up),
 * - `'weapon'` — a collectable weapon drop (grant \*or\* re-activate),
 * - `'weapon-level'` — a permanent level-up of a weapon the player already
 *   owns (parent AH-0MUPMPCB2009J54J),
 * - `'power-up-level'` — a permanent level-up of a power-up the player
 *   already owns (parent AH-0MUU2QJE2007JNR6).
 */
export type ChoiceOptionKind =
  | 'powerup'
  | 'weapon'
  | 'weapon-level'
  | 'power-up-level';

/** One option offered by the hold-full choice. */
export interface ChoiceOption {
  /** The drop id presented (power-up or weapon). */
  id: DropId;
  /** Human-readable display name. */
  name: string;
  /** Whether the option is a power-up, a weapon drop or a level-up. */
  kind: ChoiceOptionKind;
  /**
   * For `'weapon-level'`/`'power-up-level'` options: the level this option
   * grants (the current level + 1). Absent for power-up/weapon options.
   */
  level?: number;
  /**
   * Optional change summary describing what improves at this level
   * (e.g. `"+1 Projectiles, +15% Bullet size"`). Populated for
   * weapon-level, power-up-level and owned base-pool offers.
   */
  changeSummary?: string;
  /**
   * Optional one-line player-facing description of what the item does
   * (e.g. `"Adds a 3-bullet fan (−30°/0°/+30°)."`). Populated for **every**
   * option kind from the shared catalogue via {@link getDropDescription}, so
   * an unfamiliar offer is self-explanatory and the overlay copy can never
   * drift from the gym help (AH-0MV2N2591007UGPD · AC1/AC4).
   */
  description?: string;
  /**
   * Whether this option represents a brand-new item the player does
   * not yet own. Set for base-pool weapons and power-ups the player
   * has never collected.
   */
  isNew?: boolean;
}

/**
 * Player context for the choice pool. Used to offer weapon **and power-up**
 * level-ups that reflect the run's current levels (AC1/AC2/AC6).
 */
export interface ChoiceContext {
  /**
   * Weapons the player has collected this run (id → current level ≥ 1). Only
   * genuine weapon drops are considered; the cannon and the Reset utility are
   * ignored.
   */
  weaponLevels?: ReadonlyArray<{ id: WeaponId; level: number }>;
  /**
   * Power-ups the player has collected this run (id → current level ≥ 1).
   * Optional and backward compatible: when omitted, base-pool power-ups
   * carry no `isNew` badge and no level-up offers are emitted. Supplied by
   * the hold-full choice once the power-up level store is wired
   * (AH-0MUU2QJE2007JNR6 AC6).
   */
  powerUpLevels?: ReadonlyArray<{ id: PowerUpId; level: number }>;
  /**
   * Power-up kinds with an **active temporary (field-pickup) stack** this run.
   * A temporary stack occupies a six-slot slot while it lasts (parent
   * AH-0MVLIJT3M005HPHF, producer Q4a), so it is part of the pool occupancy
   * the gate reads. Optional and backward compatible: when omitted the gate
   * sees permanent holdings only.
   */
  tempPowerUpIds?: readonly PowerUpId[];
  /**
   * Weapon-drop kinds with an **active temporary (field-pickup) stack** this
   * run. The weapon half of {@link ChoiceContext.tempPowerUpIds}.
   */
  tempWeaponIds?: readonly WeaponId[];
}

/** Weapon drops that can be levelled up (everything except the Reset utility). */
const LEVELABLE_WEAPON_IDS: readonly WeaponDropId[] = [
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  // Net-new unlock-pool weapons are upgradable like every other weapon.
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
];

/** Display names for the collectable weapon drops. */
const WEAPON_NAMES: Record<WeaponDropId, string> = {
  spread: 'Spread Shot',
  dual: 'Dual Shot',
  rapid: 'Rapid Fire',
  wave_laser: 'Wave Laser',
  ricochet: 'Ricochet',
  cluster: 'Cluster Missile',
  options: 'Options',
  nova: 'Nova',
  mortar: 'Mortar',
  arc: 'Arc',
  reset: 'Reset',
  rear_guard: 'Rear Guard',
  broadside: 'Broadside',
  railgun: 'Railgun',
  shard_swarm: 'Shard Swarm',
  heavy_slug: 'Heavy Slug',
};

/**
 * Whether a drop id is a weapon drop — delegates to the canonical guard in
 * `powerups/types` so a newly added weapon can never be mistaken for a
 * power-up here (AH-0MVCRBNO6003E1CH).
 */
export function isWeaponDrop(id: DropId): id is WeaponDropId {
  return isWeaponDropId(id);
}

/**
 * Whether an option is a weapon option (a weapon drop or a weapon level-up).
 * Power-up and power-up-level options are not weapon options.
 */
export function isWeaponOption(option: ChoiceOption): boolean {
  return option.kind === 'weapon' || option.kind === 'weapon-level';
}

/** Builds the display descriptor for a drop id. */
export function toChoiceOption(id: DropId): ChoiceOption {
  // Item copy is resolved from the shared catalogues so the overlay and the
  // gym help can never diverge (AC4).
  const description = getDropDescription(id);
  if (isWeaponDrop(id)) {
    return { id, name: WEAPON_NAMES[id], kind: 'weapon', description };
  }
  return {
    id,
    name: POWER_UP_CATALOGUE[id as PowerUpId].name,
    kind: 'powerup',
    description,
  };
}

// ── Level-up option builder ─────────────────────────────────────────

/**
 * Builds the single level-up option for an owned item, offering
 * `level + 1`.
 *
 * This is the **one** code path that turns an owned permanent level into a
 * player-facing offer: the hold-full choice ({@link buildChoiceCandidates})
 * and the mini-boss reward ({@link buildOwnedLevelUpOptions}) both use
 * it, so the offered level, item description and change summary can never
 * drift between the two surfaces (gym↔game parity — AH-0MVL9P2SF009QFON AC3).
 *
 * Returns `undefined` when the id cannot be levelled as a drop: the
 * permanent cannon, the Reset utility, unknown power-ups, or a level below 1.
 *
 * @param id - The weapon drop or power-up id being upgraded.
 * @param level - The item's current permanent level (≥ 1).
 * @returns The `weapon-level`/`power-up-level` option, or `undefined`.
 */
export function buildLevelUpOption(
  id: DropId,
  level: number,
): ChoiceOption | undefined {
  if (!Number.isFinite(level) || level < 1) return undefined;

  if (isWeaponDrop(id)) {
    if (!LEVELABLE_WEAPON_IDS.includes(id)) return undefined;
    return {
      id,
      name: `${WEAPON_NAMES[id]} Lv.${level + 1}`,
      kind: 'weapon-level',
      level: level + 1,
      description: getDropDescription(id),
      changeSummary: summariseWeaponLevelChange(
        id as WeaponId,
        level,
        level + 1,
      ),
    };
  }

  if (!POWER_UP_CATALOGUE[id as PowerUpId]) return undefined;
  const powerUpId = id as PowerUpId;
  return {
    id: powerUpId,
    name: `${POWER_UP_CATALOGUE[powerUpId].name} Lv.${level + 1}`,
    kind: 'power-up-level',
    level: level + 1,
    description: getDropDescription(powerUpId),
    changeSummary: summarisePowerUpLevelChange(powerUpId, level, level + 1),
  };
}

/**
 * Builds the level-up offers for every owned permanent weapon and power-up
 * in `context` — weapons first, then power-ups, matching the order both
 * callers present.
 *
 * Shared by the hold-full choice and the mini-boss reward so both surfaces
 * offer exactly the same options (AH-0MVL9P2SF009QFON AC1/AC3).
 *
 * @param context - The run's owned weapon/power-up levels.
 * @returns One option per levellable owned item.
 */
export function buildOwnedLevelUpOptions(
  context?: ChoiceContext,
): ChoiceOption[] {
  const options: ChoiceOption[] = [];

  for (const { id, level } of context?.weaponLevels ?? []) {
    const option = buildLevelUpOption(id as DropId, level);
    // A weapon-level store must never produce a power-up option (or vice
    // versa) — keeps the two stores' entries independent.
    if (option?.kind === 'weapon-level') options.push(option);
  }

  for (const { id, level } of context?.powerUpLevels ?? []) {
    const option = buildLevelUpOption(id, level);
    if (option?.kind === 'power-up-level') options.push(option);
  }

  return options;
}

// ── Weighting ───────────────────────────────────────────────────────

/**
 * Weight multiplier applied to an owned level-up offer (`weapon-level` or
 * `power-up-level`) during candidate selection. Unowned base-pool entries keep
 * a weight of 1.0, so an owned upgrade is 1.35× as likely to be drawn as an
 * unowned item — a 35% bias toward continuing an existing build (retuned
 * from 1.1×/10% to 1.25×/25%, then to 1.35×/35% by AH-0MVCFB00Y004AQ2Z after
 * a producer audit asked for "another 10 points").
 *
 * Named and exported so the bias can be tuned without hunting for a magic
 * number (AH-0MUY47W62005FF74 AC4).
 */
export const OWNED_UPGRADE_BONUS_WEIGHT = 1.35;

/**
 * Selection weight for a candidate option (AH-0MUY47W62005FF74 AC1). Owned
 * level-up offers receive {@link OWNED_UPGRADE_BONUS_WEIGHT}; every other
 * (unowned base-pool) option retains a weight of 1.0.
 */
export function choiceCandidateWeight(option: ChoiceOption): number {
  return option.kind === 'weapon-level' || option.kind === 'power-up-level'
    ? OWNED_UPGRADE_BONUS_WEIGHT
    : 1;
}

// ── Strategy ────────────────────────────────────────────────────────

/**
 * Pluggable selection policy for the hold-full choice. Implementations must
 * return at most `count` distinct options; the default random strategy is
 * {@link randomChoiceStrategy}.
 */
export interface ChoiceStrategy {
  /**
   * Chooses the options to offer.
   *
   * @param count — maximum number of options to offer.
   * @param rng — random-number generator (defaults to `Math.random`);
   *   injected by tests for determinism.
   * @param context — optional player context (owned weapon levels) so the
   *   pool can include weapon level-up offers.
   */
  choose(
    count: number,
    rng?: () => number,
    context?: ChoiceContext,
  ): ChoiceOption[];
}

/**
 * Builds the candidate option list: the base pool (with owned items
 * suppressed) plus a **level-up** offer for every weapon/power-up the player
 * owns (AC1/AC2/AC4). An owned item is therefore offered **once**, as its
 * correctly-labelled levelled offer; an unowned item is offered once, as a
 * **New** base entry. When the player owns nothing the list is exactly the
 * base pool (AC5).
 *
 * De-duplication lives here and only here, so the game (`PlayScene`) and every
 * gym that opens the hold-full choice share one implementation and can never
 * offer a base entry alongside its level-up counterpart for the same id
 * (AH-0MUVRACE9001WVT2 AC3).
 *
 * ## Six-slot gate (parent AH-0MVLIJT3M005HPHF AC4)
 *
 * Once the run's shared pool is full — counted over permanent grants **and**
 * active temporary stacks ({@link resolveSlotState} over the same context) —
 * base entries that would add a kind **not currently in the slots** are gated
 * out via {@link isWithinSlotPool}. The producer's answer (2026-10-27, Q6a
 * with the Q4 note) is explicit: *"if a hold-full is offered while all slots
 * are full then only offer items that are currently in the slots"*, so a
 * surviving base entry is either a kind held only temporarily (taking it makes
 * it permanent — it already owns its slot) or one flagged
 * `availableWhenSlotsFull` (which never occupies a slot, Q7a). Permanently
 * owned kinds are suppressed above and return as level-up offers, so the
 * candidate list degrades gracefully instead of emptying. The gate lives
 * **only** here: the mini-boss reward inherits it through
 * `buildOwnedLevelUpOptions`, and no scene or `unlocks.ts` re-derives it. Below
 * the cap `isWithinSlotPool` is unconditionally true, so the candidate list
 * (eligible set and weights) is unchanged.
 *
 * Populates optional display metadata (AH-0MUU1GOAU007RFVR):
 * - `changeSummary` for owned/levelled items, derived from the shared
 *   level maths.
 * - `isNew` for surviving base-pool items the player does not yet own.
 */
export function buildChoiceCandidates(
  pool: readonly DropId[],
  context?: ChoiceContext,
): ChoiceOption[] {
  // Ownership lookups (run-scoped level ≥ 1) drive both the New badge and the
  // suppression of the base-pool entry for an owned id. `getWeaponLevels()` /
  // `getPowerUpLevels()` only ever return level ≥ 1 entries, but filtering
  // here keeps the semantics explicit and robust to hand-built contexts.
  const ownedWeapons = new Set(
    (context?.weaponLevels ?? [])
      .filter((wl) => wl.level >= 1)
      .map((wl) => wl.id),
  );
  const ownedPowerUps = new Set(
    (context?.powerUpLevels ?? [])
      .filter((pl) => pl.level >= 1)
      .map((pl) => pl.id),
  );
  // Ownership is only known when the context supplies it; when omitted we
  // must not badge a power-up as New (backward compatible).
  const powerUpOwnershipKnown = context?.powerUpLevels !== undefined;

  // Shared-pool occupancy, derived from the same context through the single
  // slot helper (no second counter, no scene-local re-derivation). Temporary
  // stacks count while they last (producer Q4a).
  const slotState = resolveSlotState(
    context?.powerUpLevels ?? [],
    context?.weaponLevels ?? [],
    context?.tempPowerUpIds ?? [],
    context?.tempWeaponIds ?? [],
  );

  const candidates: ChoiceOption[] = [];
  for (const dropId of new Set(pool)) {
    const option = toChoiceOption(dropId);
    // Suppress the base-pool entry for an owned item: it is offered once, as
    // its level-up offer (appended below), never twice (AC1/AC2).
    if (option.kind === 'weapon' && ownedWeapons.has(dropId as WeaponId)) {
      continue;
    }
    if (
      option.kind === 'powerup' &&
      powerUpOwnershipKnown &&
      ownedPowerUps.has(dropId as PowerUpId)
    ) {
      continue;
    }
    // Six-slot gate (parent AC4): once the shared pool is full, a base entry
    // that is neither held (permanently or temporarily) nor
    // `availableWhenSlotsFull` would add a kind outside the slots, so it is not
    // offered — the producer's instruction is to offer only items currently in
    // the slots. Owned kinds already dropped out above and return as level-up
    // offers below; temporarily held kinds survive as a permanent pick (they
    // already occupy their slot) and the flagged entries survive here. Below
    // the cap this predicate is inert.
    if (slotState.isFull && !isWithinSlotPool(dropId, slotState)) {
      continue;
    }
    // Every surviving base entry is unowned, so it carries the New badge
    // whenever ownership is known (weapons always; power-ups only when the
    // context supplies `powerUpLevels`).
    if (option.kind === 'weapon') option.isNew = true;
    if (option.kind === 'powerup' && powerUpOwnershipKnown) option.isNew = true;
    candidates.push(option);
  }

  // Owned permanent levels become level-up offers through the single shared
  // builder, so the hold-full choice and the mini-boss reward cannot drift
  // (AH-0MVL9P2SF009QFON AC3).
  candidates.push(...buildOwnedLevelUpOptions(context));
  return candidates;
}

/**
 * Draws `count` **distinct** candidates by weighted sampling without
 * replacement: each draw picks an option with probability proportional to its
 * {@link choiceCandidateWeight}, then removes it so no option can be offered
 * twice. Living here (and only here) keeps the 1.35× owned-upgrade bias in the
 * strategy layer rather than in {@link buildChoiceCandidates} (AC2).
 */
function drawWeightedWithoutReplacement(
  candidates: readonly ChoiceOption[],
  count: number,
  rng: () => number,
): ChoiceOption[] {
  const remaining = candidates.map((option) => ({
    option,
    weight: choiceCandidateWeight(option),
  }));
  const picked: ChoiceOption[] = [];
  const n = Math.max(0, Math.min(Math.floor(count), remaining.length));
  for (let i = 0; i < n; i++) {
    const total = remaining.reduce((sum, entry) => sum + entry.weight, 0);
    let threshold = rng() * total;
    let index = 0;
    // Advance past each entry's slice of the [0, total) range; the last entry
    // is the fallback (guards against rng() returning exactly 1).
    while (index < remaining.length - 1 && threshold >= remaining[index].weight) {
      threshold -= remaining[index].weight;
      index++;
    }
    picked.push(remaining[index].option);
    remaining.splice(index, 1);
  }
  return picked;
}

/**
 * Creates a strategy that draws `count` distinct options at **weighted**
 * random from `pool` — owned `weapon-level`/`power-up-level` offers carry a
 * {@link OWNED_UPGRADE_BONUS_WEIGHT} (1.35×) bias, unowned base entries 1.0× —
 * with each owned item's base-pool entry suppressed and its level-up offer
 * appended (see {@link buildChoiceCandidates}). When the candidate list holds
 * fewer than `count` entries, all of them are returned (graceful
 * degradation).
 */
export function createRandomChoiceStrategy(
  pool: readonly DropId[] = CHOICE_POOL,
): ChoiceStrategy {
  return {
    choose(
      count: number,
      rng: () => number = Math.random,
      context?: ChoiceContext,
    ): ChoiceOption[] {
      const candidates = buildChoiceCandidates(pool, context);
      return drawWeightedWithoutReplacement(candidates, count, rng);
    },
  };
}

/** Default strategy: three distinct options across the full drop pool. */
export const randomChoiceStrategy: ChoiceStrategy = createRandomChoiceStrategy();

/**
 * Convenience helper: choose options using a strategy. Defaults to three
 * options from {@link randomChoiceStrategy}.
 */
export function chooseOptions(
  count = 3,
  strategy: ChoiceStrategy = randomChoiceStrategy,
  rng: () => number = Math.random,
  context?: ChoiceContext,
): ChoiceOption[] {
  return strategy.choose(count, rng, context);
}
