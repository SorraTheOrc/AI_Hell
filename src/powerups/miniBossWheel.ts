/**
 * Mini-boss wheel mathematics and outcome application (parent
 * AH-0MVLISU03006WDOD; test-first pair AH-0MVSF5WXQ0035NW0 /
 * AH-0MVSF5YKS000J0VZ).
 *
 * Defeating a mini-boss spins a compact wheel with one wedge per **owned
 * permanent kind** (from the shared six-slot pool, so power-up kinds and
 * weapon drops are both represented) plus one **bonus** wedge. The wheel is
 * compact for legibility, but its payout follows a literal **100-slot**
 * distribution so the tension is real and the odds are exact:
 *
 * | Slots | Outcome | Effect |
 * |-------|---------|--------|
 * | 1     | bonus   | +1 level on **every** owned permanent kind |
 * | 5     | triple  | 3 distinct owned kinds, +1 level each |
 * | 10    | double  | 2 distinct owned kinds, +1 level each |
 * | 84    | single  | 1 owned kind, +1 level |
 *
 * Multi-upgrade slots pick **distinct** owned kinds where possible and repeat
 * a kind only when there are fewer owned kinds than picks — so a player with
 * one owned power-up landing a three-upgrade slot gains **+3 levels** on it.
 * Every spin therefore pays out; there is no skip or empty result (parent
 * AC3/AC4 "a mini-boss always pays out").
 *
 * ## One implementation for the game and every gym
 *
 * This module is the single owner of the distribution, the distinct-kind
 * selection rule and the reward application, so `PlayScene` and any gym
 * consume identical code (gym↔game parity, AH-0MUGZDTFX004RBD1). The overlay
 * scene never computes probabilities: it receives the resolved outcome from
 * {@link drawWheelOutcome} and only animates it (plan decision D1).
 *
 * ## Deterministic, injected RNG
 *
 * The module never draws a random number itself: the caller passes the 0–99
 * slot index it drew from the **run-seeded** RNG, so the same seed and the
 * same owned-kind snapshot always reproduce the same outcome (parent AC6).
 * There is no `Math.random()` and no wall-clock read here — a source
 * assertion in `__tests__/miniBossWheel.test.ts` pins that.
 *
 * ## Purity
 *
 * No Phaser import, no scene import, no input mutation: a pure function of
 * its arguments. Reward application goes through the shared
 * `applyMineralChoiceReward` seam, exactly like the hold-full choice, so a
 * spin runs the identical permanent-level machinery.
 *
 * ## No level-cap filtering
 *
 * Parity with `buildOwnedLevelUpOptions` (plan decision D2): the wheel offers
 * level-ups with no cap check, the run-scoped level stores are unbounded and
 * only the *derived* stat saturates, so a spin always raises a level and
 * always pays out.
 *
 * @module powerups/miniBossWheel
 */

import {
  buildLevelUpOption,
  toChoiceOption,
  type ChoiceOption,
} from './choice';
import {
  applyMineralChoiceReward,
  type MineralChoicePlayer,
} from './choiceReward';
import type { EffectsRegistry } from './effects';
import {
  POWER_UP_CATALOGUE,
  WEAPON_DROP_IDS,
  type DropId,
  type PowerUpId,
} from './types';

/** The wheel is resolved as a literal 100-slot distribution. */
export const MINI_BOSS_WHEEL_SLOT_COUNT = 100;

/** The four outcomes a slot can land, in slot-table order. */
export type MiniBossWheelOutcomeKind =
  | 'bonus'
  | 'triple'
  | 'double'
  | 'single';

/**
 * How many of the 100 slots resolve to each outcome — the single source of
 * truth for the wheel's odds (1 bonus / 5 triple / 10 double / 84 single).
 */
export const MINI_BOSS_WHEEL_DISTRIBUTION: Readonly<
  Record<MiniBossWheelOutcomeKind, number>
> = {
  bonus: 1,
  triple: 5,
  double: 10,
  single: 84,
};

/** Stable slot-table order: the bonus first, then the upgrade outcomes. */
const SLOT_ORDER: readonly MiniBossWheelOutcomeKind[] = [
  'bonus',
  'triple',
  'double',
  'single',
];

/**
 * The 100-slot table, derived from {@link MINI_BOSS_WHEEL_DISTRIBUTION} so
 * the counts and the per-index mapping can never drift apart. Slot `0` is the
 * single bonus slot.
 */
export const MINI_BOSS_WHEEL_SLOTS: readonly MiniBossWheelOutcomeKind[] =
  SLOT_ORDER.flatMap((kind) =>
    Array.from({ length: MINI_BOSS_WHEEL_DISTRIBUTION[kind] }, () => kind),
  );

/** The bonus wedge's id in the wheel's wedge list. */
export const MINI_BOSS_WHEEL_BONUS_ID = 'bonus';

/** One wedge on the wheel: an owned permanent kind, or the bonus wedge. */
export interface MiniBossWheelWedge {
  /** The owned kind this wedge grants, or {@link MINI_BOSS_WHEEL_BONUS_ID}. */
  readonly id: DropId | typeof MINI_BOSS_WHEEL_BONUS_ID;
  /** `'bonus'` for the bonus wedge, `'kind'` for an owned permanent kind. */
  readonly kind: 'bonus' | 'kind';
}

/** One kind the landed slot upgrades, and by how many levels. */
export interface MiniBossWheelGain {
  /** The owned permanent kind upgraded by this spin. */
  readonly id: DropId;
  /** Levels granted to `id` by this spin (≥ 1). */
  readonly levels: number;
}

/** A resolved spin: the landed slot kind and the concrete level gains. */
export interface MiniBossWheelOutcome {
  /** Which of the four slot outcomes the wheel landed on. */
  readonly slotKind: MiniBossWheelOutcomeKind;
  /** The level gains, one entry per distinct kind, in a stable order. */
  readonly gains: readonly MiniBossWheelGain[];
}

/** Stable catalogue orders used to sort the owned kinds deterministically. */
const WEAPON_ORDER: ReadonlyMap<string, number> = new Map(
  WEAPON_DROP_IDS.map((id, index) => [id, index]),
);
const POWER_UP_ORDER: ReadonlyMap<string, number> = new Map(
  (Object.keys(POWER_UP_CATALOGUE) as PowerUpId[]).map((id, index) => [
    id,
    index,
  ]),
);

/**
 * Whether `id` is a kind the wheel can grant a level to.
 *
 * Uses the shared level-up option builder so the wheel can only ever wheel
 * kinds a permanent level-up can be applied to: this excludes the permanent
 * `cannon` (never a drop), the `reset` utility (removes weapons, never
 * levelled) and any unknown id.
 */
function isWheelKind(id: DropId): boolean {
  return buildLevelUpOption(id, 1) !== undefined;
}

/**
 * The distinct wheel kinds of `ownedKinds` in the shared display order —
 * weapons first (catalogue order), then power-ups (catalogue order) — so the
 * wedge list and the resolved outcome are always derived from the same
 * snapshot and never reorder between renders.
 */
export function orderedOwnedKinds(ownedKinds: Iterable<DropId>): DropId[] {
  const unique = new Set<DropId>();
  for (const id of ownedKinds) {
    if (isWheelKind(id)) unique.add(id);
  }
  return [...unique].sort((a, b) => {
    const aWeapon = WEAPON_ORDER.get(a);
    const bWeapon = WEAPON_ORDER.get(b);
    if (aWeapon !== undefined && bWeapon !== undefined) return aWeapon - bWeapon;
    if (aWeapon !== undefined) return -1;
    if (bWeapon !== undefined) return 1;
    return (
      (POWER_UP_ORDER.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (POWER_UP_ORDER.get(b) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

/**
 * Builds the wheel's wedge list: one wedge per owned permanent kind (weapons
 * first, then power-ups) followed by the single bonus wedge.
 *
 * The launcher passes the owned ids from the shared six-slot accounting
 * (`resolveSlotState(...).ownedIds`), so the wedge list and the resolved
 * outcome can never see a different pool.
 *
 * @param ownedKinds — The run's owned permanent kinds.
 * @returns The wedges in stable order, bonus last.
 */
export function buildWheelWedges(
  ownedKinds: Iterable<DropId>,
): MiniBossWheelWedge[] {
  const wedges: MiniBossWheelWedge[] = orderedOwnedKinds(ownedKinds).map(
    (id) => ({ id, kind: 'kind' as const }),
  );
  wedges.push({ id: MINI_BOSS_WHEEL_BONUS_ID, kind: 'bonus' });
  return wedges;
}

/**
 * Resolves the outcome for a 0–99 slot index (the caller draws that index
 * from the run-seeded RNG).
 *
 * - `bonus` → +1 level on every owned permanent kind;
 * - `triple`/`double`/`single` → that many upgrade picks, choosing distinct
 *   owned kinds where possible and repeating a kind only when there are fewer
 *   owned kinds than picks.
 *
 * The picks are a deterministic rotation of the stable owned-kind list, so
 * the same slot index and snapshot always produce the same gains and no
 * hidden RNG state is involved.
 *
 * @param slotIndex — The landed slot, `0`–`99`.
 * @param ownedKinds — The run's owned permanent kinds.
 * @returns The resolved level gains for that slot.
 * @throws RangeError when `slotIndex` is not an integer in `0`–`99`.
 */
export function drawWheelOutcome(
  slotIndex: number,
  ownedKinds: Iterable<DropId>,
): MiniBossWheelOutcome {
  const slotKind = wheelSlotKind(slotIndex);
  const owned = orderedOwnedKinds(ownedKinds);

  if (slotKind === 'bonus') {
    return {
      slotKind,
      gains: owned.map((id) => ({ id, levels: 1 })),
    };
  }

  const picks =
    slotKind === 'triple' ? 3 : slotKind === 'double' ? 2 : 1;
  if (owned.length === 0) {
    // The launcher never spins with an empty pool (it falls back to the
    // hold-full choice), but a stray call must still be total and harmless.
    return { slotKind, gains: [] };
  }

  const start = slotIndex % owned.length;
  const levels = new Map<DropId, number>();
  for (let pick = 0; pick < picks; pick += 1) {
    const id = owned[(start + pick) % owned.length];
    levels.set(id, (levels.get(id) ?? 0) + 1);
  }

  return {
    slotKind,
    gains: [...levels].map(([id, count]) => ({ id, levels: count })),
  };
}

/**
 * Maps a 0–99 slot index to its outcome kind.
 *
 * @throws RangeError when `slotIndex` is not an integer in `0`–`99`.
 */
export function wheelSlotKind(slotIndex: number): MiniBossWheelOutcomeKind {
  if (
    !Number.isInteger(slotIndex) ||
    slotIndex < 0 ||
    slotIndex >= MINI_BOSS_WHEEL_SLOT_COUNT
  ) {
    throw new RangeError(
      `Mini-boss wheel slot index must be an integer in 0–${
        MINI_BOSS_WHEEL_SLOT_COUNT - 1
      }, received ${slotIndex}`,
    );
  }
  return MINI_BOSS_WHEEL_SLOTS[slotIndex];
}

/** The shared level-up option the wheel applies for one gained level. */
function wheelGainOption(id: DropId): ChoiceOption {
  return buildLevelUpOption(id, 1) ?? toChoiceOption(id);
}

/**
 * Applies a resolved outcome exactly once: every gained level is one
 * permanent grant through the shared `applyMineralChoiceReward` seam (the
 * same path the hold-full choice uses), so the wheel runs the identical
 * permanent-level machinery in the game and in every gym.
 *
 * The launcher calls this exactly once per spin, after the wheel stops.
 *
 * @param outcome — The resolved spin from {@link drawWheelOutcome}.
 * @param effectsRegistry — The scene's effect registry.
 * @param player — The ship, or null when no player exists.
 */
export function applyWheelOutcome(
  outcome: MiniBossWheelOutcome,
  effectsRegistry: EffectsRegistry,
  player: MineralChoicePlayer | null,
): void {
  for (const gain of outcome.gains) {
    const option = wheelGainOption(gain.id);
    for (let level = 0; level < gain.levels; level += 1) {
      applyMineralChoiceReward(option, effectsRegistry, player);
    }
  }
}
