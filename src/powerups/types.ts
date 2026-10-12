/**
 * Power-up type definitions (GDD §4.4).
 *
 * The classic-arcade power-ups (`power_pellet`, `smart_bomb`, `force_field`,
 * `mystery_ufo`) are the implemented power-up picks from the research
 * catalogue `docs/CLASSIC_POWERUP_WEAPON_RESEARCH.md` (epic
 * AH-0MV14SO0G0095IJ4), which records each concept's source game, adaptation,
 * catalogue seam and gym.
 *
 * - **Speed Boost** — +50% movement speed and +50% rate of fire for 10 s (timed)
 * - **Extra Life** — +1 life immediately (start 3, cap 5)
 * - **Magnet** — attracts nearby drops toward the ship; a 15 s
 *   refreshing field pickup or a permanent stacking upgrade (cap 5)
 * - **Mineral Scoop** — attracts minerals toward the ship; a 15 s
 *   refreshing field pickup or a permanent stacking upgrade (cap 5)
 * - **Shield** — 15 s bubble; absorbs a level-resolved number of hits
 *   (base 1, cap 3) before popping (timed)
 * - **Bomb** — ranged periodic enemy-bullet clear (no enemy damage); a
 *   field pickup is a single explosion, a hold-full reward pulses
 * - **Phase Shift** — charge-based automatic pass-through (parent
 *   AH-0MUIYX1EE008FVS8): collecting stores one auto-activation; the shared
 *   danger feed triggers a 1.5 s pass-through when 3+ hostile bodies/bullets
 *   close within 40 px; the hold-full reward makes activations unlimited.
 * - **Teleport** — stored stacks (FIFO), S/↓ to teleport to nearest safe spot, grants a 1.5 s Phase Shift on arrival
 * - **Power Pellet** — Pac-Man-inspired timed fright window: every live
 *   enemy flees the ship and suppresses fire; ramming a frightened enemy
 *   destroys it without damaging the ship (timed)
 * - **Smart Bomb** — Defender-inspired stored screen-wide pulse: a field
 *   pickup fires one screen-clearing blast (damages every enemy once and
 *   clears every enemy bullet); a hold-full reward makes the pulse repeat on
 *   a level-resolved interval (stored → permanent)
 * - **Force Field** — Gradius-inspired timed reflector (AH-0MV1BIX1W006XF95):
 *   while active an enemy bullet that meets the bubble is bounced back along
 *   its incoming direction as a player-owned bullet that damages enemies.
 *   A level-resolved reflect budget caps how many bullets one field returns
 *   before it stops reflecting; the bubble expires after its timed window.
 * - **Mystery UFO** — Space Invaders-inspired instant bounty
 *   (AH-0MV1BIXFO006Z1I7): collecting it immediately grants a level-resolved
 *   burst of minerals (into the ship's hold) and score, and levels the
 *   power-up so later pickups pay more. It has no timed window and stores no
 *   consumable state; deliberately rare (weight 3, rarer than the standard 4).
 *
 * Weapon types (P1/P2) remain in `src/utils/weapons.ts`.
 */

// ── Power-up IDs ─────────────────────────────────────────────────────

export type PowerUpId =
  | 'shield'
  | 'bomb'
  | 'speed_boost'
  | 'phase_shift'
  | 'teleport'
  | 'extra_life'
  | 'magnet'
  | 'mineral_scoop'
  | 'power_pellet'
  | 'smart_bomb'
  | 'force_field'
  | 'mystery_ufo';

/**
 * A weapon power-up ID that the game can spawn as a field drop
 * (spread, dual, rapid) plus the reset drop and the AOE family
 * (nova, mortar, arc). The permanent cannon is never spawned as a drop.
 */
export type WeaponDropId =
  | 'spread'
  | 'dual'
  | 'rapid'
  | 'wave_laser'
  | 'ricochet'
  | 'cluster'
  | 'options'
  | 'reset'
  | 'nova'
  | 'mortar'
  | 'arc';

/**
 * Every drop the combat gyms can spawn: all power-up IDs plus the
 * weapon drop IDs (spread, dual, rapid, reset).
 */
export type DropId = PowerUpId | WeaponDropId;

// ── Catalogue entry ─────────────────────────────────────────────────

export interface PowerUpEntry {
  /** Unique GDD identifier (e.g. "speed_boost"). */
  id: PowerUpId;
  /** Human-readable display name. */
  name: string;
  /**
   * One-line player-facing effect description (GDD §4.4). Rendered by the
   * gym help overlay so help copy cannot drift from the catalogue.
   */
  description: string;
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
 * Full power-up catalogue.
 *
 * Entries are ordered by ascending GDD ID so that round-robin spawners
 * cycle in GDD order. Non-combat gym uses a filtered subset; combat gym
 * cycles shield → bomb → phase_shift → teleport.
 */
export const POWER_UP_CATALOGUE: Record<PowerUpId, PowerUpEntry> = {
  shield: {
    id: 'shield',
    name: 'Shield',
    description: 'Absorbs one hit; a bubble protects the ship for 15 s.',
    duration: 15,
  },
  bomb: {
    id: 'bomb',
    name: 'Bomb',
    description:
      'Clears enemy bullets in a radius around the ship; a field pickup fires once, a hold-full reward pulses.',
  },
  speed_boost: {
    id: 'speed_boost',
    name: 'Speed Boost',
    description: '+50% movement speed and rate of fire for 10 s.',
    duration: 10,
  },
  phase_shift: {
    id: 'phase_shift',
    name: 'Phase Shift',
    description:
      'Stores one automatic phase; triggers a 1.5 s pass-through when 3+ threats close within 40 px. The hold-full reward makes it unlimited.',
    // Auto-activation length; mirrors PHASE_DURATION in src/core/constants.ts.
    duration: 1.5,
  },
  teleport: {
    id: 'teleport',
    name: 'Teleport',
    description: 'Stores a use; press S or ↓ to warp to the nearest safe spot and gain a 1.5 s Phase Shift on arrival.',
  },
  extra_life: {
    id: 'extra_life',
    name: 'Extra Life',
    description: '+1 life immediately (starts at 3, capped at 5).',
    livesStart: 3,
    livesMax: 5,
  },
  magnet: {
    id: 'magnet',
    name: 'Magnet',
    description:
      'Pulls nearby drops toward the ship — a 15 s pickup, or permanent stacking when chosen as a reward (cap 5).',
    duration: 15,
    maxStacks: 5,
  },
  mineral_scoop: {
    id: 'mineral_scoop',
    name: 'Mineral Scoop',
    description:
      'Pulls nearby minerals toward the ship — a 15 s pickup, or permanent stacking when chosen as a reward (cap 5).',
    duration: 15,
    maxStacks: 5,
  },
  power_pellet: {
    id: 'power_pellet',
    name: 'Power Pellet',
    description:
      'Frightens every enemy for a timed window: they flee the ship and stop firing, and ramming one destroys it.',
    // Base fright window (s); the level curve extends it (cap 14 s).
    duration: 6,
  },
  smart_bomb: {
    id: 'smart_bomb',
    name: 'Smart Bomb',
    description:
      'Fires a screen-wide pulse that damages every enemy once and clears every enemy bullet; a field pickup fires once, a hold-full reward pulses.',
  },
  force_field: {
    id: 'force_field',
    name: 'Force Field',
    description:
      'Reflects enemy bullets back at their source for 8 s; the field returns a limited number of shots before it stops reflecting.',
    // Base bubble window (s); the level curve extends it (cap 18 s).
    duration: 8,
  },
  mystery_ufo: {
    id: 'mystery_ufo',
    name: 'Mystery UFO',
    description:
      'A rare Space Invaders-inspired bonus: instantly grants a burst of minerals and score. Each pickup levels it up so the next bounty is larger.',
    // Instant, non-timed: no duration and no stored state; the reward is
    // granted on collection and the level advances (AH-0MV1BIXFO006Z1I7).
  },
};

/** Power-up IDs cycled by the combat gym round-robin spawner. */
export const COMBAT_POWER_UP_IDS: readonly PowerUpId[] = ['shield', 'bomb', 'phase_shift', 'teleport', 'power_pellet', 'smart_bomb', 'force_field'] as const;

/**
 * The Extra Life drop id (GDD §4.5). Single source shared by the hold-full
 * choice and the demo bot's life premium (AH-0MV03GXZQ00801T4 · AC3).
 */
export const EXTRA_LIFE_DROP_ID: PowerUpId = POWER_UP_CATALOGUE.extra_life.id;

/**
 * Weapon drop IDs the combat gyms can spawn alongside power-ups.
 * Reset returns the ship to the cannon.
 */
export const WEAPON_DROP_IDS: readonly WeaponDropId[] = [
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
