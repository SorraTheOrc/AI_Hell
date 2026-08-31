/**
 * Power-up type definitions (GDD §4.4).
 *
 * Non-combat power-ups used in the GymPowerUps gym (AH-0MTC0QPS60005MNT):
 * - **P5 Speed Boost** — +50% movement speed for 10 s (timed)
 * - **P8 Extra Life** — +1 life immediately (start 3, cap 5)
 * - **P9 Magnet** — permanent stacking effect (cap 5)
 *
 * Weapon types (P1/P2) and combat-coupled types (P3/P4/P6/P7) are excluded
 * from this catalogue; they are added by their respective sibling work items.
 */

// ── Power-up IDs ─────────────────────────────────────────────────────

export type PowerUpId = 'P5' | 'P8' | 'P9';

// ── Power-up types ──────────────────────────────────────────────────

export enum PowerUpType {
  /** +50% movement speed for 10 s (timed effect). */
  SPEED_BOOST = 'speed_boost',
  /** +1 life immediately (start 3, cap 5). */
  EXTRA_LIFE = 'extra_life',
  /** Permanent magnet stacks attracting drops (cap 5). */
  MAGNET = 'magnet',
}

// ── Catalogue entry ─────────────────────────────────────────────────

export interface PowerUpEntry {
  /** Unique GDD identifier (e.g. "P5"). */
  id: PowerUpId;
  /** Human-readable display name. */
  name: string;
  /** Effect type determining behaviour. */
  type: PowerUpType;
  /** Duration in seconds for timed effects (undefined for permanent). */
  duration?: number;
  /** Maximum stack count for stackable effects (undefined for non-stackable). */
  maxStacks?: number;
  /** Initial life count when the life counter starts. */
  livesStart?: number;
  /** Maximum life count. */
  livesMax?: number;
}

// ── Power-up catalogue ──────────────────────────────────────────────

/**
 * The non-combat power-up catalogue: P5, P8, P9.
 *
 * Entries are ordered by ascending GDD ID so that the round-robin spawner
 * cycles through them in the correct order: P5 → P8 → P9.
 */
export const POWER_UP_CATALOGUE: Record<PowerUpId, PowerUpEntry> = {
  P5: {
    id: 'P5',
    name: 'Speed Boost',
    type: PowerUpType.SPEED_BOOST,
    duration: 10,
  },
  P8: {
    id: 'P8',
    name: 'Extra Life',
    type: PowerUpType.EXTRA_LIFE,
    livesStart: 3,
    livesMax: 5,
  },
  P9: {
    id: 'P9',
    name: 'Magnet',
    type: PowerUpType.MAGNET,
    maxStacks: 5,
  },
};

/**
 * Looks up a catalogue entry by ID.
 * @throws Error if the ID is not in the catalogue.
 */
export function getPowerUpById(id: PowerUpId): PowerUpEntry {
  const entry = POWER_UP_CATALOGUE[id];
  if (!entry) {
    throw new Error(`Unknown power-up: ${id}`);
  }
  return entry;
}
