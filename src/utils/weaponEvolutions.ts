/**
 * Weapon evolutions — the authored pairing table and the one pure pairing
 * resolver (epic AH-0MWL7OWPF003E4TP, foundation child AH-0MWU7B2RO00194UF).
 *
 * ## What this module owns
 *
 * Two active weapon kinds can **fuse** into a named evolved weapon. The
 * relation between the kinds is cross-row (a pairing names *two* catalogue
 * ids), so it cannot be a column in `src/data/weapons.csv`. It lives here as
 * typed, declarative data instead:
 *
 * - {@link WEAPON_PAIRINGS} — the authored pairings (`ricochet` + `arc` →
 *   Chain Ricochet, `cluster` + `mortar` → Cluster Barrage, `spread` +
 *   `options` → Fan Escort).
 * - {@link EVOLVED_WEAPON_DEFINITIONS} — one definition per evolved weapon
 *   (display name, description, icon glyph, palette colour, cadence rungs and
 *   nominal subdivision).
 * - {@link resolveWeaponEvolution} — the **one** pure resolver every consumer
 *   reads: the live evolved id (or `null`), its `baseIds` and the `reason`
 *   (`owned` | `field` | `none`). No scene, gym or bot-decision module may
 *   derive its own answer (epic AC1, AC11).
 * - {@link validateWeaponEvolutionTable} — the validator that makes a typo
 *   loud. The shipped table is validated at module load and an invalid table
 *   throws, so a bad pairing can never ship silently (epic AC2).
 *
 * This child ships **data, the resolver and its tests only** — it has no
 * runtime firing effect. The field tier (timed overlap), the owned tier
 * (permanent persistence), feedback, the gym parity row and the cross-cutting
 * verification harness are sibling children.
 *
 * ## Two tiers, field ∈ owned ∈ none
 *
 * - **Owned tier** — both halves are permanently owned at level ≥
 *   {@link OWNED_EVOLUTION_MIN_LEVEL}. The evolution persists for the rest of
 *   the run; permanent levels are the snapshot `Player.getWeaponLevels()`
 *   already exposes (run hold-full grants and hangar buy-to-upgrade levels
 *   converge on it), so no new persisted state is added.
 * - **Field tier** — both halves are active in the timed/active weapon set
 *   (`Player.getActiveWeapons()`). The evolution lives only while the overlap
 *   does.
 *
 * The owned tier is resolved **before** the field tier: a permanently owned
 * pair is always active too, so checking the field overlap first would shadow
 * the stronger, persistent reason forever. When several pairings are live at
 * the same tier, the first in authored table order wins, so the answer is
 * deterministic for a given active set.
 *
 * ## Evolved ids are resolved output, not catalogue rows
 *
 * {@link EvolvedWeaponId} is deliberately **not** a {@link WeaponId}: an
 * evolved weapon is the output of a resolution, never a droppable or
 * level-upgradable catalogue row. `src/data/weapons.csv`,
 * `WEAPON_IDS`/`WeaponId` and the catalogue parity suite therefore stay
 * untouched (epic assumption, verified while implementing this child).
 *
 * ## Cadence stays on the shared lattice
 *
 * An evolved definition carries its cadence twice, deliberately:
 *
 * - {@link EvolvedWeaponDefinition.subdivisions} — the **nominal** shots per
 *   beat, mirroring the catalogue's `subdivisions` column;
 * - {@link EvolvedWeaponDefinition.ladder} — the authored
 *   `(minLevel, k, n, rotation)` rungs of the shared Euclidean rhythm.
 *
 * Every rung's `n` is a whole number of 16th notes and rung 0's onsets per
 * beat equal `subdivisions`, so the verifier that pins grid conformance
 * (AH-0MWU7BAA0009X1MN) can assert both sources agree without a second
 * arithmetic path. {@link resolveEvolvedWeaponPattern} resolves a level's
 * rung to the same `EuclideanPattern` shape `resolveWeaponPattern` returns,
 * so the shared fire path can consume it unchanged.
 *
 * Pure and deterministic: no RNG, no clock, no Phaser, no storage.
 *
 * @module src/utils/weaponEvolutions
 */

import {
  DEFAULT_BPM,
  SIXTEENTH_NOTE_SUBDIVISIONS,
  beatSubdivisionMs,
} from './beat';
import { WEAPON_IDS, type WeaponDefinition, type WeaponId } from './weapons';
import {
  resolveWeaponDefinition,
  type EuclideanPattern,
} from './weaponLevels';

// ── Evolved weapon ids and presentation ─────────────────────────────

/**
 * Unique evolved-weapon identifiers. These are **resolved output only** — see
 * the module header for why they are not part of {@link WeaponId}.
 */
export type EvolvedWeaponId =
  | 'chain_ricochet'
  | 'cluster_barrage'
  | 'fan_escort';

/** Every evolved weapon id, in authored definition order. */
export const EVOLVED_WEAPON_IDS: readonly EvolvedWeaponId[] = [
  'chain_ricochet',
  'cluster_barrage',
  'fan_escort',
];

/**
 * The icon **glyph** an evolved weapon draws, named semantically rather than
 * by id so the shared icon drawer (feedback child) maps one glyph to one
 * drawing routine. A badge pairs the glyph with the evolved weapon's name, so
 * fusion never reads through colour alone (epic AC7).
 */
export type EvolvedWeaponIcon = 'chain' | 'barrage' | 'fan';

// ── Authored pairing table ──────────────────────────────────────────

/**
 * One authored pairing: the two catalogue weapons that fuse, and the evolved
 * weapon they resolve to.
 *
 * `baseIds` is the single source of truth for which catalogue weapons a
 * pairing consumes. The resolver republishes it on every resolution so an
 * evolved weapon classifies as its **base** ids for hex matchup purposes
 * (epic AC11) — no consumer needs a second table.
 */
export interface WeaponPairing {
  /** The two catalogue weapon ids that must both be live (order-independent). */
  readonly baseIds: readonly [WeaponId, WeaponId];
  /** The evolved weapon the pair resolves to. */
  readonly evolvedId: EvolvedWeaponId;
}

/**
 * The shipped pairings. Three pilot pairings, each a balance-tested content
 * unit — the mechanism supports more, but every addition is authored and
 * validated here rather than generated combinatorially (epic constraint
 * "authored, not combinatorial").
 */
export const WEAPON_PAIRINGS: readonly WeaponPairing[] = [
  {
    // Bolts bank off walls *and* hop to a second nearby target on each bounce.
    baseIds: ['ricochet', 'arc'],
    evolvedId: 'chain_ricochet',
  },
  {
    // MIRV warheads leave short lingering blasts at their burst points.
    baseIds: ['cluster', 'mortar'],
    evolvedId: 'cluster_barrage',
  },
  {
    // The orbiting pods fire along the ship's heading instead of radially.
    baseIds: ['spread', 'options'],
    evolvedId: 'fan_escort',
  },
];

// ── Evolved definitions (name, presentation, cadence) ───────────────

/**
 * One authored rung of an evolved weapon's Euclidean cadence ladder.
 *
 * The shape matches a catalogue `weapon-levels.json` rung (`{ k, n, rotation }`)
 * with the addition of the level at which the rung becomes active, because an
 * evolved weapon's ladder is authored beside its definition rather than in
 * the per-catalogue ladder data (evolved ids are not catalogue rows).
 */
export interface EvolvedCadenceRung {
  /** First evolution level at which this rung is active (0 = base). */
  readonly minLevel: number;
  /** Onsets per tile (`1 <= k <= n`). */
  readonly k: number;
  /** Steps per tile — always a whole number of 16th notes. */
  readonly n: number;
  /** Phase shift in steps (`0 <= rotation < n`). */
  readonly rotation: number;
}

/**
 * The data half of an evolved weapon: what it is called, how it is drawn and
 * how fast it fires. Behaviour stays in the shared fire path; this shape
 * carries only data.
 */
export interface EvolvedWeaponDefinition {
  /** Unique evolved id (resolved output only). */
  readonly id: EvolvedWeaponId;
  /** Player-facing display name (HUD badge, gym help). */
  readonly name: string;
  /** One-line player-facing effect description. */
  readonly description: string;
  /** Semantic icon glyph drawn by the shared icon drawer. */
  readonly icon: EvolvedWeaponIcon;
  /** Palette colour (0xRRGGBB) for the badge icon and bullet tint. */
  readonly colour: number;
  /**
   * **Nominal** shots per beat — the same units as the catalogue's
   * `subdivisions` column. Must equal rung 0's density
   * (`k / n × 16th-notes-per-beat`), so the nominal and live cadence sources
   * agree by construction.
   */
  readonly subdivisions: number;
  /**
   * Authored Euclidean cadence ladder, in non-decreasing level order. Rung 0
   * is the base cadence (`minLevel: 0`).
   */
  readonly ladder: readonly EvolvedCadenceRung[];
}

/**
 * The shipped evolved definitions, in the order {@link EVOLVED_WEAPON_IDS}
 * declares.
 *
 * Cadences are authored as the two halves' level-0 rungs so a fusion never
 * raises damage instances per cadence tick: Chain Ricochet keeps Ricochet's
 * `0.5`-per-beat rhythm, Cluster Barrage keeps Cluster's `0.25`, and Fan
 * Escort keeps Spread/Options' `0.5` (epic AC5; the automated damage-parity
 * harness is AH-0MWU7BAA0009X1MN).
 */
export const EVOLVED_WEAPON_DEFINITIONS: readonly EvolvedWeaponDefinition[] = [
  {
    id: 'chain_ricochet',
    name: 'Chain Ricochet',
    description:
      'Banking pellets that hop to a second nearby target on every bounce.',
    icon: 'chain',
    // Mint green: a blend of Ricochet's neon green and the Arc's electric
    // purple, readable as "ricochet, but chained".
    colour: 0x77ff88,
    subdivisions: 0.5,
    ladder: [
      { minLevel: 0, k: 2, n: 16, rotation: 0 },
      { minLevel: 3, k: 2, n: 16, rotation: 1 },
      { minLevel: 6, k: 3, n: 16, rotation: 0 },
      { minLevel: 10, k: 4, n: 16, rotation: 0 },
    ],
  },
  {
    id: 'cluster_barrage',
    name: 'Cluster Barrage',
    description:
      'MIRV warheads that leave a short lingering blast at each burst point.',
    icon: 'barrage',
    // Deep hot orange: the Mortar's shell hue pulled toward the Cluster's
    // hot pink, distinct from both halves' icons.
    colour: 0xff7733,
    subdivisions: 0.25,
    ladder: [
      { minLevel: 0, k: 1, n: 16, rotation: 0 },
      { minLevel: 6, k: 2, n: 16, rotation: 0 },
    ],
  },
  {
    id: 'fan_escort',
    name: 'Fan Escort',
    description:
      'Orbiting pods that fire along the ship\'s heading instead of radially.',
    icon: 'fan',
    // Bright aquamarine: the Options pods' aquamarine sharpened toward the
    // Spread fan's warm hue without becoming either half's colour.
    colour: 0x33ffe0,
    subdivisions: 0.5,
    ladder: [
      { minLevel: 0, k: 2, n: 16, rotation: 0 },
      { minLevel: 4, k: 3, n: 16, rotation: 0 },
      { minLevel: 8, k: 4, n: 16, rotation: 0 },
    ],
  },
];

/**
 * Looks up an evolved definition by id.
 *
 * The shipped table is validated at module load, so a shipped id always
 * resolves; an unknown id is a programming error and throws loudly rather
 * than returning `undefined` into a rendering path.
 *
 * @throws Error when `evolvedId` is not an authored evolved weapon.
 */
export function getEvolvedWeaponDefinition(
  evolvedId: EvolvedWeaponId,
): EvolvedWeaponDefinition {
  const definition = EVOLVED_WEAPON_DEFINITIONS.find(
    (candidate) => candidate.id === evolvedId,
  );
  if (!definition) {
    throw new Error(`Unknown evolved weapon id: ${String(evolvedId)}`);
  }
  return definition;
}

// ── Resolver ────────────────────────────────────────────────────────

/** Why an evolved weapon is live, or `'none'` when nothing fuses. */
export type WeaponEvolutionReason = 'owned' | 'field' | 'none';

/**
 * Permanent level **both** halves must own for the owned tier. The permanent
 * ladder is `BASE_PERMANENT_LEVEL = 1` plus one per hold-full grant (or a
 * hangar buy-to-upgrade), so level 2 is "upgraded at least once" from either
 * ownership source.
 */
export const OWNED_EVOLUTION_MIN_LEVEL = 2;

/** The active + permanently owned weapon sets the resolver reads. */
export interface WeaponEvolutionInput {
  /** Currently active weapon ids (`Player.getActiveWeapons()`). */
  readonly activeWeaponIds: readonly WeaponId[];
  /**
   * Permanently owned weapon levels (`Player.getWeaponLevels()`). Absent/
   * empty means nothing is permanently owned yet.
   */
  readonly permanentWeaponLevels?: ReadonlyArray<{
    readonly id: WeaponId;
    readonly level: number;
  }>;
}

/**
 * The resolver's answer: the live evolved weapon (or `null`), the catalogue
 * ids it classifies as (`baseIds`, empty when nothing fuses) and the reason.
 */
export interface WeaponEvolutionResolution {
  /** The live evolved id, or `null` when no pairing is live. */
  readonly evolvedId: EvolvedWeaponId | null;
  /**
   * The catalogue ids the live weapon classifies as for hex matchup purposes.
   * Empty when nothing fuses; a fused weapon always republishes its pairing's
   * **base** ids so it can never bypass a hex's authored strengths/weaknesses
   * (epic AC11).
   */
  readonly baseIds: readonly WeaponId[];
  /** Why the weapon is live: permanently owned pair, field overlap or none. */
  readonly reason: WeaponEvolutionReason;
}

/**
 * Resolves which evolved weapon (if any) is live for the given active/owned
 * weapon set — the **one** pure pairing resolver (epic AC1).
 *
 * Precedence:
 * 1. **Owned** — a pairing whose halves are both permanently owned at
 *    level ≥ {@link OWNED_EVOLUTION_MIN_LEVEL}. It survives expiry of a timed
 *    overlap, so it is reported even when a half is absent from the active
 *    list.
 * 2. **Field** — a pairing whose halves are both in `activeWeaponIds`.
 * 3. **None** — no pairing is live: `evolvedId` is `null` and `baseIds` is
 *    empty. With no pairing table (or an empty one) this is always the answer
 *    and no behaviour changes (epic AC2).
 *
 * When several pairings are live at the same tier, the first in authored
 * table order wins, so the answer is deterministic.
 *
 * Pure: no RNG, no clock, no input mutation. Unknown ids in `activeWeaponIds`
 * simply never match a pairing.
 *
 * @param input - Active weapon ids and the permanent weapon-level snapshot.
 * @param pairings - The pairing table to read (defaults to
 *   {@link WEAPON_PAIRINGS}; pass `[]` for a catalogue without pairing data).
 */
export function resolveWeaponEvolution(
  input: WeaponEvolutionInput,
  pairings: readonly WeaponPairing[] = WEAPON_PAIRINGS,
): WeaponEvolutionResolution {
  const active = new Set<WeaponId>(input.activeWeaponIds);
  const permanentLevels = new Map<WeaponId, number>();
  for (const { id, level } of input.permanentWeaponLevels ?? []) {
    if (Number.isFinite(level)) permanentLevels.set(id, level);
  }

  let fieldResolution: WeaponEvolutionResolution | null = null;

  for (const pairing of pairings) {
    const [firstBase, secondBase] = pairing.baseIds;

    // Owned tier first: a permanently owned pair is always active too, so the
    // owned reason must win or it could never be reported (module header).
    if (
      (permanentLevels.get(firstBase) ?? 0) >= OWNED_EVOLUTION_MIN_LEVEL &&
      (permanentLevels.get(secondBase) ?? 0) >= OWNED_EVOLUTION_MIN_LEVEL
    ) {
      return {
        evolvedId: pairing.evolvedId,
        baseIds: [...pairing.baseIds],
        reason: 'owned',
      };
    }

    if (
      fieldResolution === null &&
      active.has(firstBase) &&
      active.has(secondBase)
    ) {
      fieldResolution = {
        evolvedId: pairing.evolvedId,
        baseIds: [...pairing.baseIds],
        reason: 'field',
      };
    }
  }

  return (
    fieldResolution ?? { evolvedId: null, baseIds: [], reason: 'none' }
  );
}

// ── Evolved cadence ─────────────────────────────────────────────────

/**
 * Resolves the catalogue definition an evolved weapon fires through the shared
 * fire path.
 *
 * An evolved weapon is **resolved output, not a catalogue row**, so it borrows
 * the primary half's catalogue definition (its first {@link WeaponPairing.baseIds}
 * entry) for projectile visuals, lifetime, bounce and downstream behaviour, and
 * overrides the parts a fusion owns:
 *
 * - `name` / `description` / `bulletColor` come from the evolved definition;
 * - `offsets` is reduced to a **single forward shot**, so a fusion emits exactly
 *   one damage instance per onset (epic AC5 — the child-2 verification harness
 *   pins this) instead of multiplying both halves' volleys;
 * - `aoe` / `orbit` / `hitscan` are cleared: an evolved weapon is a travelling
 *   pattern, never the base's area effect, escort or beam;
 * - `fireRateMs` is the evolved rhythm's **average** onset interval, so the
 *   tick-based bot arena fires it at the fused cadence.
 *
 * `id` stays the primary base id on purpose: a shot's weapon identity is what
 * the hex-matchup classification reads, and an evolved weapon always classifies
 * as its **base** id(s) (epic AC11).
 *
 * Pure and deterministic. The shipped table is validated at module load, so a
 * shipped evolved id always resolves.
 *
 * @param evolvedId - The evolved weapon to resolve.
 * @param level - Evolution level used to resolve the primary half's stats
 *   (0 = base; negative/fractional values are clamped).
 * @param bpm - Tempo for the nominal cadence (default 80).
 * @throws Error when `evolvedId` is not an authored evolved weapon.
 */
export function resolveEvolvedWeaponDefinition(
  evolvedId: EvolvedWeaponId,
  level = 0,
  bpm: number = DEFAULT_BPM,
): WeaponDefinition {
  const definition = getEvolvedWeaponDefinition(evolvedId);
  const pairing = WEAPON_PAIRINGS.find(
    (candidate) => candidate.evolvedId === evolvedId,
  );
  if (!pairing) {
    // The table validator makes this unreachable for a shipped id.
    throw new Error(
      `Evolved weapon ${String(evolvedId)} has no authored pairing`,
    );
  }
  const primaryId = pairing.baseIds[0];
  const base = resolveWeaponDefinition(primaryId, level);
  const pattern = resolveEvolvedWeaponPattern(evolvedId, level, bpm);
  return {
    ...base,
    name: definition.name,
    description: definition.description,
    bulletColor: definition.colour,
    offsets: [0],
    sideOffsets: undefined,
    aoe: undefined,
    orbit: undefined,
    hitscan: undefined,
    fireRateMs: (pattern.stepMs * pattern.n) / pattern.k,
  };
}

/**
 * Resolves the Euclidean rhythm an evolved weapon plays at `level` — the
 * evolved counterpart of `resolveWeaponPattern`, returning the same
 * {@link EuclideanPattern} shape so the shared fire path consumes it
 * unchanged.
 *
 * The result is the last authored rung whose `minLevel` is at or below the
 * (clamped, whole-number) level. `stepMs` is the shared 16th-note step scaled
 * to `bpm`, so an evolved cadence can never drift off the beat grid
 * (epic AC6).
 *
 * Pure and deterministic: the same `(evolvedId, level, bpm)` always resolves
 * an equal pattern.
 *
 * @param evolvedId - The evolved weapon to resolve.
 * @param level - Evolution level (0 = base; negative/fractional values are
 *   clamped to a non-negative whole number).
 * @param bpm - Tempo in beats per minute (default 80).
 * @throws Error when `evolvedId` is not an authored evolved weapon.
 */
export function resolveEvolvedWeaponPattern(
  evolvedId: EvolvedWeaponId,
  level: number,
  bpm: number = DEFAULT_BPM,
): EuclideanPattern {
  const definition = getEvolvedWeaponDefinition(evolvedId);
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  let resolved = definition.ladder[0];
  for (const rung of definition.ladder) {
    if (rung.minLevel > safeLevel) break;
    resolved = rung;
  }
  return {
    k: resolved.k,
    n: resolved.n,
    rotation: resolved.rotation,
    stepMs: beatSubdivisionMs(SIXTEENTH_NOTE_SUBDIVISIONS, bpm),
  };
}

// ── Validation ──────────────────────────────────────────────────────

/** A pairing table + its definitions, as the validator sees them. */
export interface WeaponEvolutionTable {
  readonly pairings: readonly WeaponPairing[];
  readonly definitions: readonly EvolvedWeaponDefinition[];
}

/** The shipped table, exactly as it is validated at module load. */
export const WEAPON_EVOLUTION_TABLE: WeaponEvolutionTable = {
  pairings: WEAPON_PAIRINGS,
  definitions: EVOLVED_WEAPON_DEFINITIONS,
};

/** The validator's verdict: `valid` plus one message per problem found. */
export interface WeaponEvolutionValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Shipped catalogue ids, for pairing-id validation. */
const CATALOGUE_IDS: ReadonlySet<string> = new Set(WEAPON_IDS);

/** Shipped evolved ids, for definition-id validation. */
const EVOLVED_IDS: ReadonlySet<string> = new Set(EVOLVED_WEAPON_IDS);

/** Tolerance for comparing authored densities. */
const DENSITY_EPSILON = 1e-9;

/** True for a finite positive whole number. */
function isPositiveWhole(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/** Order-insensitive key for a base-id pair, so `[a, b]` and `[b, a]` collide. */
function pairingKey(baseIds: readonly [WeaponId, WeaponId]): string {
  return [...baseIds].sort().join('+');
}

/**
 * Validates a pairing table and its evolved definitions.
 *
 * The check is deliberately exhaustive enough that a **typo fails loudly**:
 *
 * - every base id is a real catalogue {@link WeaponId} (AC2);
 * - every `evolvedId` is one of {@link EVOLVED_WEAPON_IDS}, and every shipped
 *   evolved id is paired exactly once;
 * - a base pair appears at most once (order-independent);
 * - a definition's cadence ladder is well formed (`k`/`n` whole, `1 <= k <= n`,
 *   `0 <= rotation < n`, `minLevel` non-decreasing from 0) and stays on the
 *   shared 16th-note lattice (`n` a whole number of 16th notes);
 * - rung densities never decrease, and rung 0's density matches the nominal
 *   `subdivisions` (so the nominal and live cadence sources agree).
 *
 * Pure and tolerant: it reports problems, it never throws. The shipped table
 * is validated by {@link assertValidWeaponEvolutionTable} at module load, so
 * an invalid authored table throws — the loud failure AC2 requires.
 *
 * @param table - Pairings and definitions to validate (defaults to the
 *   shipped table; pass empty arrays for a catalogue without pairing data).
 */
export function validateWeaponEvolutionTable(
  table: WeaponEvolutionTable = WEAPON_EVOLUTION_TABLE,
): WeaponEvolutionValidation {
  const errors: string[] = [];
  const { pairings, definitions } = table;

  // Definitions first: pairings resolve against them.
  const definitionById = new Map<string, EvolvedWeaponDefinition>();
  for (const definition of definitions) {
    const label = `definition '${String(definition.id)}'`;
    if (!EVOLVED_IDS.has(definition.id)) {
      errors.push(`${label} is not a shipped evolved weapon id`);
    }
    if (definitionById.has(definition.id)) {
      errors.push(`${label} is declared more than once`);
    }
    definitionById.set(definition.id, definition);

    if (typeof definition.name !== 'string' || definition.name.trim() === '') {
      errors.push(`${label} has no display name`);
    }
    if (
      typeof definition.description !== 'string' ||
      definition.description.trim() === ''
    ) {
      errors.push(`${label} has no description`);
    }
    if (
      !Number.isInteger(definition.colour) ||
      definition.colour < 0 ||
      definition.colour > 0xffffff
    ) {
      errors.push(`${label} has an invalid palette colour`);
    }
    if (
      typeof definition.subdivisions !== 'number' ||
      !Number.isFinite(definition.subdivisions) ||
      definition.subdivisions <= 0
    ) {
      errors.push(`${label} has an invalid nominal subdivision`);
    }

    errors.push(...validateEvolvedLadder(definition));
  }

  const pairedEvolvedIds = new Set<string>();
  const pairingKeys = new Set<string>();

  for (const pairing of pairings) {
    const label = `pairing '${pairing.baseIds.join(' + ')}'`;
    if (pairing.baseIds.length !== 2) {
      errors.push(`${label} must name exactly two base ids`);
    }
    for (const baseId of pairing.baseIds) {
      if (!CATALOGUE_IDS.has(baseId)) {
        errors.push(`${label} names unknown weapon id '${String(baseId)}'`);
      }
    }
    if (pairing.baseIds[0] === pairing.baseIds[1]) {
      errors.push(`${label} pairs a weapon with itself`);
    }

    if (!definitionById.has(pairing.evolvedId)) {
      errors.push(
        `${label} resolves to '${String(pairing.evolvedId)}', which has no definition`,
      );
    }
    if (pairedEvolvedIds.has(pairing.evolvedId)) {
      errors.push(
        `${label} resolves to '${String(pairing.evolvedId)}', which is paired more than once`,
      );
    }
    pairedEvolvedIds.add(pairing.evolvedId);

    const key = pairingKey(pairing.baseIds);
    if (pairingKeys.has(key)) {
      errors.push(`${label} is declared more than once`);
    }
    pairingKeys.add(key);
  }

  for (const definition of definitions) {
    if (!pairedEvolvedIds.has(definition.id)) {
      errors.push(
        `definition '${String(definition.id)}' has no pairing to resolve it`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/** Validates one evolved definition's cadence ladder. */
function validateEvolvedLadder(
  definition: EvolvedWeaponDefinition,
): readonly string[] {
  const errors: string[] = [];
  const label = `definition '${String(definition.id)}'`;
  const ladder = definition.ladder;

  if (ladder.length === 0) {
    return [`${label} has an empty cadence ladder`];
  }
  if (ladder[0].minLevel !== 0) {
    errors.push(`${label} cadence rung 0 must start at minLevel 0`);
  }

  let previousMinLevel = -1;
  let previousDensity = -1;

  ladder.forEach((rung, index) => {
    const rungLabel = `${label} cadence rung ${index}`;
    if (!Number.isInteger(rung.minLevel) || rung.minLevel < 0) {
      errors.push(`${rungLabel} has an invalid minLevel`);
    } else if (rung.minLevel <= previousMinLevel) {
      errors.push(`${rungLabel} minLevel must increase along the ladder`);
    }
    if (Number.isInteger(rung.minLevel)) previousMinLevel = rung.minLevel;

    const shapeValid =
      isPositiveWhole(rung.n) &&
      isPositiveWhole(rung.k) &&
      rung.k <= rung.n &&
      Number.isInteger(rung.rotation) &&
      rung.rotation >= 0 &&
      rung.rotation < rung.n;
    if (!shapeValid) {
      errors.push(`${rungLabel} has an invalid (k, n, rotation) shape`);
      return;
    }

    if (rung.n % SIXTEENTH_NOTE_SUBDIVISIONS !== 0) {
      errors.push(
        `${rungLabel} does not land on the shared 16th-note lattice (n=${rung.n})`,
      );
    }

    const density = rung.k / rung.n;
    if (density < previousDensity) {
      errors.push(`${rungLabel} density must not decrease along the ladder`);
    }
    previousDensity = density;

    if (index === 0) {
      const nominalDensity = definition.subdivisions / SIXTEENTH_NOTE_SUBDIVISIONS;
      if (Math.abs(density - nominalDensity) > DENSITY_EPSILON) {
        errors.push(
          `${label} rung 0 density ${density} does not match its nominal subdivision ${definition.subdivisions}`,
        );
      }
    }
  });

  return errors;
}

/**
 * Throws when the shipped pairing table is invalid — the load-time loud
 * failure for an unknown/duplicated id or a malformed cadence (AC2).
 *
 * Exported so a boot-time self-check and the unit suite can assert the
 * shipped table without duplicating the error formatting.
 *
 * @throws Error listing every validation problem.
 */
export function assertValidWeaponEvolutionTable(
  table: WeaponEvolutionTable = WEAPON_EVOLUTION_TABLE,
): void {
  const { valid, errors } = validateWeaponEvolutionTable(table);
  if (!valid) {
    throw new Error(
      `Invalid weapon evolution table:\n${errors.map((error) => `- ${error}`).join('\n')}`,
    );
  }
}

// Fail loudly at load rather than silently shipping a pairing whose halves
// are not catalogue weapons. The table is static data, so this can only trip
// on a bad edit — never on player input.
assertValidWeaponEvolutionTable();
