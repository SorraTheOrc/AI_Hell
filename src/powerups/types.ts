/**
 * Power-up type definitions (GDD §4.4).
 *
 * The classic-arcade power-ups (`smart_bomb`, `force_field`, `mystery_ufo`)
 * are the implemented power-up picks from the research
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
 *   AH-0MUIYX1EE008FVS8): collecting grants level-derived auto-activation
 *   charges into a **finite recharging pool** (cap 3, level-derived recharge
 *   time); the shared danger feed triggers a 1.5 s pass-through when 3+
 *   hostile bodies/bullets close within 40 px; the hold-full reward adds
 *   exactly one charge to that pool — it is never an unlimited supply
 *   (AH-0MV82I7TX0009JMT).
 * - **Teleport** — stored stacks (FIFO) in a **finite recharging pool** (cap 3,
 *   level-derived recharge time); activates automatically when the ship is in
 *   danger — one stack is spent to warp to the nearest safe spot and grant a
 *   1.5 s Phase Shift on arrival
 * - **Smart Bomb** — Defender-inspired stored screen-wide pulse: a field
 *   pickup fires one screen-clearing blast (damages every enemy once and
 *   clears every enemy bullet); a hold-full reward makes the pulse repeat on
 *   a level-resolved interval (stored → permanent)
 * - **Force Field** — Gradius-inspired timed reflector (AH-0MV1BIX1W006XF95):
 *   while active an enemy bullet that meets the bubble is bounced back along
 *   its incoming direction as a player-owned bullet that damages enemies.
 *   A level-resolved reflect budget caps how many bullets one field returns
 *   before it stops reflecting; the bubble expires after its timed window.
 * - **Mystery UFO** — Space Invaders-inspired visible collector drone
 *   (AH-0MV1BIXFO006Z1I7 → AH-0MV9G113S009B37I): a field pickup spawns one
 *   small, code-drawn copy of the player ship that seeks the nearest mineral,
 *   vacuums those inside its collector radius, flies home and pays them into
 *   the hold. A full-hull (permanent) reward keeps a drone spawning on a
 *   level-resolved interval. Enemy fire or an enemy body destroys a drone
 *   (spilling its hold plus a 2 × level bonus); the player's own fire passes
 *   through. Deliberately rare (weight 3, rarer than the standard 4).
 *
 * All of the above are additionally **levelled** and split into a permanent
 * component (hold-full rewards only) and a temporary component (field
 * pickups). **Every field pickup is temporary (parent AH-0MVSTKGC3003OMAC).**
 * The temporary window (TTL) is a property of the item, never one global
 * constant: the timed kinds keep their level-resolved effect duration, and
 * every instant kind declares its own TTL as `temporaryWindow` below (Bomb /
 * Smart Bomb / Orbital Strike 10 s, Phase Shift / Teleport 15 s, Extra Life
 * 10 s, Mystery UFO 15 s). At the TTL the temporary level reverts to the
 * permanent level (or the item becomes unowned); consumables already granted
 * (lives, charges, teleports) are never clawed back. The former
 * AH-0MUX802450085VZZ *"Resolved decision 4"* exception — instant kinds had no
 * window at all — is **superseded** by AH-0MVSTKGC3003OMAC.
 *
 * ## Net-new power-ups
 *
 * The five net-new power-ups (epic AH-0MVCC8XSS007P01Z, AH-0MVCRC1Q0007JAV1)
 * extend the catalogue beyond the original 11:
 *
 * - **Frenzy** — timed damage amplification: every player bullet deals its
 *   level-resolved **bonus hits** to the first enemy it damages (base 1 extra
 *   hit → cap 3), so multi-hit enemies such as the Harvester (5 HP) fall
 *   faster while 1-HP regulars still die in one shot.
 * - **Chrono Field** — timed enemy-bullet slowdown: while active, enemy bullets
 *   advance at a fraction of their normal speed (the level-resolved slowness
 *   removes up to 75 % of the bullet speed), buying the player time to thread
 *   dense patterns.
 * - **Thorn Field** — timed ram counter: while active, ramming an enemy
 *   destroys it **without costing the player a hit** for a level-resolved
 *   number of rams.
 * - **Salvage** — timed mineral bounty: destroyed enemies drop the
 *   level-resolved bonus minerals at their death site.
 * - **Orbital Strike** — a periodic auto-targeting bolt (field pickup = one
 *   immediate strike, hold-full = repeating on a level-resolved interval) that
 *   damages the nearest live enemy.
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
  | 'smart_bomb'
  | 'force_field'
  | 'mystery_ufo'
  | 'frenzy'
  | 'chrono'
  | 'thorns'
  | 'salvage'
  | 'strike';

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
  | 'arc'
  // Net-new unlock-pool weapons (AH-0MVCRC52P001YIPW): valid drop ids so the
  // mini-boss reward can grant them, but never in the basic drop rotation.
  | 'rear_guard'
  | 'broadside'
  | 'railgun'
  | 'shard_swarm'
  | 'heavy_slug';

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
  /**
   * Field-pickup temporary-window TTL in **seconds** for a kind with no timed
   * effect of its own (parent AH-0MVSTKGC3003OMAC, Resolved decision 1;
   * AH-0MVUGI3Q4009MW6A).
   *
   * **Every** field pickup opens a temporary level component that reverts when
   * its window expires; no kind is exempt. Timed kinds leave this `undefined`:
   * their window is the level-resolved effect duration instead, and the single
   * `resolveTemporaryWindow` resolver in `./powerUpLevels` composes both cases
   * (a stray `temporaryWindow` can therefore never flatten a level-scaled
   * window). The declared instant-kind TTLs are Bomb 10 s, Smart Bomb 10 s,
   * Orbital Strike 10 s, Phase Shift 15 s, Teleport 15 s, Extra Life 10 s and
   * Mystery UFO 15 s.
   *
   * **Balance tuning:** the values are data, deliberately short so a temporary
   * level can never compound across a wave (10 s mirrors the established
   * weapon window; the defensive kinds mirror the shield-style 15 s window).
   * Retune them here — no code change is needed for a new window length.
   *
   * > The AH-0MUX802450085VZZ *"Resolved decision 4"* exception (instant kinds
   * > had no window at all) is **superseded** by AH-0MVSTKGC3003OMAC.
   */
  temporaryWindow?: number;
  /** Maximum stack count for stackable effects (undefined for non-stackable). */
  maxStacks?: number;
  /** Initial life count when the life counter starts. */
  livesStart?: number;
  /** Maximum life count. */
  livesMax?: number;
  /**
   * Whether this entry remains drawable/offerable once all
   * `POWER_UP_SLOT_CAP` permanent slots are occupied (parent
   * AH-0MVLIJT3M005HPHF, AC5).
   *
   * **Defaults to `false`** — an absent flag means the entry is gated out at
   * the cap, so a newly added catalogue entry is non-exempt unless it opts
   * in. The exemption is read from this data flag; there are no
   * `id === '…'` special cases anywhere.
   *
   * Extra Life and Mystery UFO are exempt today: neither creates a new
   * permanent effect kind that would need a seventh slot.
   */
  availableWhenSlotsFull?: boolean;
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
    description: 'Absorbs one hit behind a protective bubble around the ship.',
    duration: 15,
  },
  bomb: {
    id: 'bomb',
    name: 'Bomb',
    description:
      'Clears enemy bullets in a radius around the ship; a field pickup fires once, a hold-full reward pulses.',
    // Balance tuning: mirrors the established 10 s weapon window. The field
    // pickup's temporary level reverts after this window
    // (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 10,
  },
  speed_boost: {
    id: 'speed_boost',
    name: 'Speed Boost',
    description: '+50% movement speed and rate of fire.',
    duration: 10,
  },
  phase_shift: {
    id: 'phase_shift',
    name: 'Phase Shift',
    description:
      'Stores auto-activation charges (up to 3, recharging); triggers a 1.5 s pass-through when 3+ threats close within 40 px. The hold-full reward adds one charge to the pool.',
    // Auto-activation length; mirrors PHASE_DURATION in src/core/constants.ts.
    duration: 1.5,
    // Balance tuning: the defensive kinds use the shield-style 15 s window
    // for the temporary level a field pickup grants (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 15,
  },
  teleport: {
    id: 'teleport',
    name: 'Teleport',
    description:
      'Stores up to 3 uses; when the ship is in danger, one is spent automatically to warp to the nearest safe spot and grant a short Phase Shift on arrival. Teleporting can be disorienting — keep your wits about you.',
    // Balance tuning: defensive kind, so the temporary level uses the same
    // 15 s window as Phase Shift / Shield (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 15,
  },
  extra_life: {
    id: 'extra_life',
    name: 'Extra Life',
    description: '+1 life immediately (starts at 3, capped at 5).',
    livesStart: 3,
    livesMax: 5,
    // Balance tuning: the temporary level a field pickup grants reverts
    // after the 10 s weapon-style window (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 10,
    // Exempt: an extra life never opens a seventh permanent effect kind, so
    // it stays available once the six slots are full (Q3 answer (a)).
    availableWhenSlotsFull: true,
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
  smart_bomb: {
    id: 'smart_bomb',
    name: 'Smart Bomb',
    description:
      'Fires a screen-wide pulse that damages every enemy once and clears every enemy bullet; a field pickup fires once, a hold-full reward pulses.',
    // Balance tuning: 10 s weapon-style window for the temporary level a
    // field pickup grants (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 10,
  },
  force_field: {
    id: 'force_field',
    name: 'Force Field',
    description:
      'Reflects enemy bullets back at their source; the field returns a limited number of shots before it stops reflecting.',
    // Base bubble window (s); the level curve extends it (cap 18 s).
    duration: 8,
  },
  mystery_ufo: {
    id: 'mystery_ufo',
    name: 'Mystery UFO',
    description:
      'A rare Space Invaders-inspired collector drone: a small copy of your ' +
      'ship seeks out minerals, hoovers them up and brings them home. Each ' +
      'pickup levels it up, so the next drone flies longer and carries more.',
    // Not timed and no stored consumable state: a field pickup spawns exactly
    // one drone through the shared core pass, and a full-hull reward keeps a
    // drone respawning on the level-resolved interval (AH-0MV9G113S009B37I).
    // The collector-drone level axes (lifetime/capacity/radius/spawn
    // interval) resolve from the shared curve (AH-0MVBMPZ2C0008VAE).
    // Exempt: the producer explicitly included Mystery UFO in the
    // available-when-full set (Q3 answer (a)).
    availableWhenSlotsFull: true,
    // Balance tuning: 15 s spans a full 5–8 s drone sortie, so a field
    // pickup's temporary level survives the drone it grants before reverting
    // (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 15,
  },
  frenzy: {
    id: 'frenzy',
    name: 'Frenzy',
    description:
      'Hits twice as hard for a while: every bullet applies bonus damage hits, so multi-HP enemies fall faster.',
    duration: 8,
  },
  chrono: {
    id: 'chrono',
    name: 'Chrono Field',
    description:
      'Slows enemy bullets to a crawl while it lasts — more time to thread the gaps.',
    duration: 5,
  },
  thorns: {
    id: 'thorns',
    name: 'Thorn Field',
    description:
      'Ramming an enemy destroys it without costing a life, for a limited number of rams.',
    duration: 8,
  },
  salvage: {
    id: 'salvage',
    name: 'Salvage',
    description:
      'Destroyed enemies drop extra minerals at the wreck — a short mining frenzy.',
    duration: 10,
  },
  strike: {
    id: 'strike',
    name: 'Orbital Strike',
    description:
      'A lightning bolt strikes the nearest enemy. A pickup fires one; the permanent reward strikes on a level-resolved interval.',
    // A field pickup fires exactly one bolt — the bolt itself has no timed
    // effect, so this catalogue `duration` is only the generic drop guardrail
    // (the permanent cadence lives in `POWER_UP_LEVEL_SPECS.strike`, which is
    // a whole-beat cadence on the shared 80 BPM grid: 6.75 s → 2.25 s). The
    // field pickup's temporary *level* window is `temporaryWindow` below.
    duration: 30,
    // Balance tuning: 10 s weapon-style window for the temporary level a
    // field pickup grants — the `duration` above is *not* that window
    // (AH-0MVUGI3Q4009MW6A).
    temporaryWindow: 10,
  },
};

/**
 * Power-up IDs cycled by the combat gym round-robin spawner. The five
 * net-new combat-coupled power-ups (epic AH-0MVCRC1Q0007JAV1) are appended so
 * the gym exercises each: Frenzy (damage amp), Chrono Field (bullet slow),
 * Thorn Field (ram counter) and Orbital Strike (auto-targeting bolt).
 */
export const COMBAT_POWER_UP_IDS: readonly PowerUpId[] = [
  'shield',
  'bomb',
  'phase_shift',
  'teleport',
  'smart_bomb',
  'force_field',
  'frenzy',
  'chrono',
  'thorns',
  'strike',
] as const;

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
  // Net-new unlock-pool weapons (AH-0MVCRC52P001YIPW): valid weapon drops so
  // the reward pool can grant them; never in the basic rotation.
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
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
