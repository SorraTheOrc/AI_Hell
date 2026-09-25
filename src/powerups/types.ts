/**
 * Power-up type definitions (GDD §4.4).
 *
 * - **P5 Speed Boost** — +50% movement speed and +50% rate of fire for 10 s (timed)
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

/**
 * A weapon power-up ID that the game can spawn as a field drop
 * (spread, dual, rapid) plus the reset drop. The permanent cannon is
 * never spawned as a drop.
 */
export type WeaponDropId = 'spread' | 'dual' | 'rapid' | 'reset';

/**
 * Every drop the combat gyms can spawn: power-up IDs (P3–P9) plus the
 * weapon drop IDs (spread, dual, rapid, reset).
 */
export type DropId = PowerUpId | WeaponDropId;

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
  /**
   * One-line player-facing effect description (GDD §4.4). Rendered by the
   * gym help overlay so help copy cannot drift from the catalogue.
   */
  description: string;
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
    description: 'Absorbs one hit; a bubble protects the ship for 15 s.',
    type: PowerUpType.SHIELD,
    duration: 15,
  },
  P4: {
    id: 'P4',
    name: 'Bomb',
    description: 'Instantly clears every on-screen enemy bullet (no enemy damage).',
    type: PowerUpType.BOMB,
  },
  P5: {
    id: 'P5',
    name: 'Speed Boost',
    description: '+50% movement speed and rate of fire for 10 s.',
    type: PowerUpType.SPEED_BOOST,
    duration: 10,
  },
  P6: {
    id: 'P6',
    name: 'Phase Shift',
    description: '3 s of intangibility — pass through enemies and bullets.',
    type: PowerUpType.PHASE_SHIFT,
    duration: 3,
  },
  P7: {
    id: 'P7',
    name: 'Teleport',
    description: 'Stores a use; press S or ↓ to warp to the nearest safe spot and gain 3 s Phase Shift on arrival.',
    type: PowerUpType.TELEPORT,
  },
  P8: {
    id: 'P8',
    name: 'Extra Life',
    description: '+1 life immediately (starts at 3, capped at 5).',
    type: PowerUpType.EXTRA_LIFE,
    livesStart: 3,
    livesMax: 5,
  },
  P9: {
    id: 'P9',
    name: 'Magnet',
    description: 'Permanently pulls nearby drops toward the ship (stacks up to 5).',
    type: PowerUpType.MAGNET,
    maxStacks: 5,
  },
};

/** Power-up IDs cycled by the combat gym round-robin spawner. */
export const COMBAT_POWER_UP_IDS: readonly PowerUpId[] = ['P3', 'P4', 'P6', 'P7'] as const;

/**
 * Weapon drop IDs the combat gyms can spawn alongside power-ups.
 * Reset returns the ship to the cannon.
 */
export const WEAPON_DROP_IDS: readonly WeaponDropId[] = [
  'spread',
  'dual',
  'rapid',
  'reset',
] as const;

/** Determines whether a drop ID is a weapon drop. */
export function isWeaponDrop(id: DropId): id is WeaponDropId {
  return (WEAPON_DROP_IDS as readonly string[]).includes(id);
}

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
