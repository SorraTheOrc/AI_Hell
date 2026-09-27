/**
 * Shared power-up drop layer (parent AH-0MUII2FJ5007MDDA, register gap 4;
 * child AH-0MUII3CXX0023H24).
 *
 * The power-up drop behaviour — the default weighted spawner, the
 * grow → hold → shrink → despawn lifecycle, the overlap collection gate
 * (≥ 3 % scale + hull radius), the P9 magnet pull, the P4 bomb notice and the
 * per-type pickup cues — was copy-pasted across five scenes with three
 * behavioural drifts (the P9 magnet ran only in `PlayScene`/`GymPowerUpsUtility`,
 * the P4 notice only in `PlayScene`/`GymPowerUpsCombat`, the per-type cues only
 * in `PlayScene`/`GymWeapons`/`GymPowerUpsUtility`). The pure helpers below own
 * each behaviour exactly once; the shared `CombatCoreScene` wraps them as
 * template methods so every scene consumes the same code and enabled drops
 * behave identically everywhere.
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
import type { DropId } from '../../powerups/types';

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
 * (power-up IDs P3–P9 plus the weapon drops) using the game-rules weights.
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
 * Applies the P9 magnet pull to every collectible drop within range, reusing
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
 * dedicated P5/P8/P9 cue, the dedicated weapon/Reset cue, or the generic
 * collect chime fallback for types without a dedicated cue (P3/P4/P6/P7).
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
      case 'P5':
        playSpeedBoostCollectSound();
        break;
      case 'P8':
        playExtraLifeCollectSound();
        break;
      case 'P9':
        playMagnetCollectSound();
        break;
      default:
        // P3 shield, P4 bomb, P6 phase, P7 teleport have no dedicated cue
        // in the audio module yet — generic chime fallback.
        playPowerUpCollectSound();
    }
  } catch {
    // Audio is best-effort in headless tests.
  }
}
