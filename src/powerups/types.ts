/**
 * Power-up type definitions (GDD §4.4).
 *
 * - **P5 Speed Boost** — +50% movement speed for 10 s (timed)
 * - **P8 Extra Life** — +1 life immediately (start 3, cap 5)
 * - **P9 Magnet** — permanent stacking effect (cap 5)
 * - **P3 Shield** — 15 s bubble, absorbs one hit (timed)
 * - **P4 Bomb** — instant clear of on-screen enemy bullets (no enemy damage)
 * - **P6 Phase Shift** — 3 s intangibility, pass-through enemies/bullets (timed)
 * - **P7 Teleport** — stored stacks (FIFO), Space to teleport to nearest safe spot, grants P6 on arrival
 *
 * Weapon types (P1/P2) remain in `src/utils/weapons.ts`.
 */

// ── Power-up IDs ─────────────────────────────────────────────────────

export type PowerUpId = 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'P9';

// ── Power-up types ──────────────────────────────────────────────────

export enum PowerUpType {
  /** Absorbs one hit for 15 s (timed, P3). */
  SHIELD = 'shield',
  /** Clears on-screen enemy bullets instantly (instant, P4). */
  BOMB = 'bomb',
  /** +50% movement speed for 10 s (timed). */
  SPEED_BOOST = 'speed_boost',
  /** 3 s intangibility, pass-through enemies/bullets (timed, P6). */
  PHASE_SHIFT = 'phase_shift',
  /** Stored teleport stacks, Space to consume (stored, P7). */
  TELEPORT = 'teleport',
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
 * Full power-up catalogue: P3–P9.
 *
 * Entries are ordered by ascending GDD ID so that round-robin spawners
 * cycle in GDD order. Non-combat gym uses a filtered subset; combat gym
 * cycles P3 → P4 → P6 → P7.
 */
export const POWER_UP_CATALOGUE: Record<PowerUpId, PowerUpEntry> = {
  P3: {
    id: 'P3',
    name: 'Shield',
    type: PowerUpType.SHIELD,
    duration: 15,
  },
  P4: {
    id: 'P4',
    name: 'Bomb',
    type: PowerUpType.BOMB,
  },
  P5: {
    id: 'P5',
    name: 'Speed Boost',
    type: PowerUpType.SPEED_BOOST,
    duration: 10,
  },
  P6: {
    id: 'P6',
    name: 'Phase Shift',
    type: PowerUpType.PHASE_SHIFT,
    duration: 3,
  },
  P7: {
    id: 'P7',
    name: 'Teleport',
    type: PowerUpType.TELEPORT,
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

/** Power-up IDs cycled by the combat gym round-robin spawner. */
export const COMBAT_POWER_UP_IDS: readonly PowerUpId[] = ['P3', 'P4', 'P6', 'P7'] as const;

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
