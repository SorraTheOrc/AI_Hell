/**
 * Shared power-up drop layer (parent AH-0MUII2FJ5007MDDA, register gap 4;
 * child AH-0MUII3CXX0023H24).
 *
 * The power-up drop behaviour — the default weighted spawner, the
 * grow → hold → shrink → despawn lifecycle, the overlap collection gate
 * (≥ 3 % scale + hull radius), the Magnet magnet pull and the per-type pickup
 * cues — was copy-pasted across five scenes with three behavioural drifts
 * (the Magnet magnet ran only in `PlayScene`/`GymPowerUpsUtility`, the per-type
 * cues only in `PlayScene`/`GymWeapons`/`GymPowerUpsUtility`). The pure
 * helpers below own each behaviour exactly once; the shared
 * `CombatCoreScene` wraps them as template methods so every scene consumes
 * the same code and enabled drops behave identically everywhere.
 *
 * The module is deliberately Phaser-scene-agnostic: it operates on the
 * structural drop shape (position + graphics + `PowerUp` lifecycle + the
 * unified drop id) that `PlayDrop`, `FormationSceneDrop`, `ActiveDrop`
 * (utility/weapons) and `CombatActiveDrop` all satisfy. Scene-specific
 * concerns — spawn *sources* (kill chance vs timer vs round-robin), placement
 * and cadence — stay in each scene (OQ6: keep distinct sources, share the
 * lifecycle/collection/magnet/notice/cues).
 *
 * @module scenes/core/dropLayer
 */

import {
  POWER_UP_DROP_SIZE,
  SHIP_SIZE,
} from '../../core/constants';
import {
  POWER_UP_WEIGHT_IDS,
  WEAPON_WEIGHT_IDS,
  type PowerUpWeights,
  type WeaponWeights,
} from '../../core/rules';
import {
  playDualPickupSound,
  playExtraLifeCollectSound,
  playMagnetCollectSound,
  playPowerUpCollectPopSound,
  playPowerUpCollectSound,
  playRapidPickupSound,
  playResetPickupSound,
  playSpeedBoostCollectSound,
  playSpreadPickupSound,
} from '../../audio/effects';
import { dropCollectRadius } from '../../powerups/icons';
import { applyMagnetAttraction } from '../../powerups/magnet';
import { PowerUpState } from '../../powerups/PowerUp';
import {
  WeightedRandomSpawner,
  type PowerUpSpawner,
} from '../../powerups/spawner';
import {
  SLOTS_FULL_EXEMPT_IDS,
  eligibleDropIds,
  firstExemptDropId,
  isWithinSlotPool,
  type PowerUpSlotState,
} from '../../powerups/slots';
import type { DropId } from '../../powerups/types';

/**
 * A drop source the shared six-slot gate can consult.
 *
 * Weighted spawners expose an eligibility filter (`setEligibleIds`) so the
 * gate filters **during sampling**; round-robin sources expose their cycle
 * (`getOrder`) so an ineligible candidate is skipped without ever looping
 * forever. A source may expose neither; the draw then bounds its skips.
 */
export interface SlotGatedDropSpawner<T extends string> extends PowerUpSpawner<T> {
  /** Weighted sources: restricts sampling to `ids` without touching weights. */
  setEligibleIds?(ids: Iterable<T> | null): void;
  /** Cycle sources: the ids one full pass visits (for bounded skipping). */
  getOrder?(): T[];
}

/**
 * Skips used when a generic source exposes neither a filter nor its cycle.
 * A round-robin cycle is at most the catalogue size, so 64 bounds any real
 * source well above one full pass while staying trivially cheap.
 */
const SLOT_GATE_DRAW_ATTEMPTS = 64;

/**
 * Structural contract the shared lifecycle/collection/magnet helpers read.
 * Every scene drop type (`PlayDrop`, `FormationSceneDrop`, `ActiveDrop`,
 * `CombatActiveDrop`) satisfies it. `graphics` is kept structural so the pure
 * helpers never need Phaser at runtime and unit tests can inject doubles.
 */
export interface DropLifecycleDrop {
  x: number;
  y: number;
  graphics: {
    setPosition(x: number, y: number): void;
    setScale(x: number, y?: number): void;
    destroy(): void;
  };
  powerUp: {
    advance(dt: number): void;
    readonly currentScale: number;
    readonly state: PowerUpState;
    canCollect(): boolean;
  };
  /** True once collected and playing its absorb VFX. */
  absorbing?: boolean;
}

/** The id fields the shared pickup-cue dispatcher reads. */
export interface PickupCueDrop {
  dropId: DropId;
  weaponDropId?: string;
}

/**
 * Builds the default weighted-random drop spawner over the combined pool
 * (power-up IDs Shield–Mineral Scoop plus the weapon drops) using the game-rules weights.
 * The single implementation behind `PlayScene` and every gym.
 */
export function buildDefaultDropSpawner(
  powerUpWeights: PowerUpWeights,
  weaponWeights: WeaponWeights,
  rng: () => number,
): PowerUpSpawner<DropId> {
  const ids: DropId[] = [...POWER_UP_WEIGHT_IDS, ...WEAPON_WEIGHT_IDS];
  const spawner = new WeightedRandomSpawner<DropId>(ids, rng);
  for (const id of POWER_UP_WEIGHT_IDS) spawner.setWeight(id, powerUpWeights[id]);
  for (const id of WEAPON_WEIGHT_IDS) spawner.setWeight(id, weaponWeights[id]);
  return spawner;
}

/**
 * Draws the next drop id through the shared six-slot gate (parent
 * AH-0MVLIJT3M005HPHF): the one eligible-filtered draw path `PlayScene` and
 * every gym consume, so a full pool stops spawning new kinds everywhere at
 * once (gym↔game parity, AH-0MUGZDTFX004RBD1).
 *
 * - **Below the cap** every id is eligible, so the source's draw is returned
 *   untouched — the pre-cap sequence is byte-for-byte identical.
 * - **At/above the cap** only owned kinds plus catalogue entries flagged
 *   `availableWhenSlotsFull` may be returned. Weighted spawners are filtered
 *   during sampling (weights never zeroed or retuned); cycle sources skip
 *   ineligible candidates for at most one full pass.
 * - **Degradation:** a source that offers no eligible id (every candidate
 *   gated out) falls back to the first available-when-full catalogue entry
 *   deterministically — never a crash and never the all-zero-weight
 *   first-entry fallback.
 */
export function drawNextDrop<T extends string>(
  spawner: SlotGatedDropSpawner<T>,
  state: PowerUpSlotState,
): T {
  if (!state.isFull) {
    // Below the cap: clear any filter left by an earlier full-pool draw and
    // return the source's own next draw unchanged (identical distribution).
    spawner.setEligibleIds?.(null);
    return spawner.next();
  }

  if (spawner.setEligibleIds) {
    // Weighted source: restrict sampling to the eligible set. The drawn id is
    // eligible whenever the source overlaps the pool; an empty overlap falls
    // back to an exempt entry (the intersection check keeps a weighted
    // source's zero-weight fallback honest).
    //
    // The eligible set is built from the concrete `DropId` union regardless of
    // the spawner's generic `T` — callers only ever parameterise the seam with
    // drop ids (power-up/weapon), so the cast is a type-level widening only.
    spawner.setEligibleIds(eligibleDropIds(state) as unknown as Iterable<T>);
    const id = spawner.next();
    return isWithinSlotPool(id as DropId, state) ? id : (firstExemptDropId() as T);
  }

  // Cycle source (round-robin / injected): skip ineligible candidates for at
  // most one full pass, then degrade deterministically to an exempt entry the
  // source itself carries, or its leading id when it carries none (a
  // weapon-only gym has no exempt member, so it degrades to its own first
  // drop — always renderable, never a cross-family id).
  const cycle = spawner.getOrder?.() ?? [];
  const attempts = cycle.length > 0 ? cycle.length : SLOT_GATE_DRAW_ATTEMPTS;
  let exhaustedExempt: T | null = null;
  for (let i = 0; i < attempts; i++) {
    const id = spawner.next();
    if (isWithinSlotPool(id as DropId, state)) return id;
    if (exhaustedExempt === null && (SLOTS_FULL_EXEMPT_IDS as readonly string[]).includes(id)) {
      exhaustedExempt = id;
    }
  }
  return exhaustedExempt ?? cycle[0] ?? (firstExemptDropId() as T);
}

/**
 * Advances every drop's grow → hold → shrink → despawn lifecycle by `dt` and
 * syncs its Graphics scale. Fully despawned drops have their Graphics
 * destroyed and are removed; absorbing drops are owned by their absorb
 * animation and are skipped. Returns the kept drops (a new array).
 *
 * `onDespawn` (optional) runs exactly once for an uncollected drop that fades
 * away — the seam `GymWeapons` uses for its despawn cue. The game and the
 * other gyms omit it.
 */
export function advanceDropLifecycles<T extends DropLifecycleDrop>(
  drops: T[],
  dt: number,
  onDespawn?: (drop: T) => void,
): T[] {
  const kept: T[] = [];
  for (const drop of drops) {
    // An absorbing drop is owned by its animation — never re-process it.
    if (drop.absorbing) continue;
    drop.powerUp.advance(dt);
    drop.graphics.setScale(drop.powerUp.currentScale);
    if (drop.powerUp.state === PowerUpState.DESPAWNED) {
      onDespawn?.(drop);
      drop.graphics.destroy();
    } else {
      kept.push(drop);
    }
  }
  return kept;
}

/**
 * Collects every collectible drop whose current radius overlaps the player's
 * hull: the gate is `canCollect()` (≥ 3 % scale) plus hull-touches-bubble
 * (`dropCollectRadius(dropSize, scale)`). Calling `onCollect` removes the drop
 * from the returned array; the caller decides what collection applies.
 *
 * A null player leaves the drops untouched.
 */
export function collectOverlappingDrops<T extends DropLifecycleDrop>(
  drops: T[],
  player: { x: number; y: number } | null,
  onCollect: (drop: T) => void,
  dropSize: number = POWER_UP_DROP_SIZE,
): T[] {
  if (!player) return drops;
  const hull = SHIP_SIZE / 2;
  const kept: T[] = [];
  for (const drop of drops) {
    if (drop.absorbing || !drop.powerUp.canCollect()) {
      kept.push(drop);
      continue;
    }
    const radius = dropCollectRadius(dropSize, drop.powerUp.currentScale);
    if (Math.hypot(player.x - drop.x, player.y - drop.y) <= hull + radius) {
      onCollect(drop);
    } else {
      kept.push(drop);
    }
  }
  return kept;
}

/**
 * Applies the Magnet magnet pull to every collectible drop within range, reusing
 * the shared `applyMagnetAttraction` (range/speed defined in exactly one
 * place). No-op when no stacks are active.
 */
export function applyDropMagnet<T extends DropLifecycleDrop>(
  drops: T[],
  player: { x: number; y: number; size?: number } | null,
  stacks: number,
  dt: number,
): void {
  if (!player || stacks <= 0) return;
  applyMagnetAttraction(drops, player, stacks, dt);
}

/**
 * Plays the per-type pickup cue for a collected drop. One shared dispatcher so
 * every scene plays the same cue: a generic pop on every pickup, then the
 * dedicated Speed Boost/Extra Life/Magnet cue, the dedicated weapon/Reset cue, or the generic
 * collect chime fallback for types without a dedicated cue (Shield/Bomb/Phase Shift/Teleport).
 * Safe no-op without an AudioContext (headless tests).
 */
export function playDropPickupCue(drop: PickupCueDrop): void {
  try {
    // Generic collection pop — immediate tactile feedback on every pickup
    // (AH-0MUBYXR280018HST); plays alongside the per-type cue below.
    playPowerUpCollectPopSound();
    if (drop.weaponDropId) {
      switch (drop.weaponDropId) {
        case 'reset':
          playResetPickupSound();
          break;
        case 'spread':
          playSpreadPickupSound();
          break;
        case 'dual':
          playDualPickupSound();
          break;
        case 'rapid':
          playRapidPickupSound();
          break;
        default:
          playPowerUpCollectSound();
      }
      return;
    }
    switch (drop.dropId) {
      case 'speed_boost':
        playSpeedBoostCollectSound();
        break;
      case 'extra_life':
        playExtraLifeCollectSound();
        break;
      case 'magnet':
        playMagnetCollectSound();
        break;
      case 'mineral_scoop':
        // Mineral Scoop reuses the magnet field-hum cue (optional polish to
        // add a dedicated cue later).
        playMagnetCollectSound();
        break;
      default:
        // Shield shield, Bomb bomb, Phase Shift phase, Teleport teleport have no dedicated cue
        // in the audio module yet — generic chime fallback.
        playPowerUpCollectSound();
    }
  } catch {
    // Audio is best-effort in headless tests.
  }
}
