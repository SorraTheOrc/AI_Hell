/**
 * The hex matchup rule and the resisted-credit ledger
 * (AH-0MWL88JJM004ORZS, Phase 1 of 5 of AH-0MWL5376H001WJFZ).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D
 * ("the strategist … boss's strengths and weaknesses") and
 * `docs/Game Design Document.md` §8.2 ("Boss and weapon strength are known
 * ahead") — this module is what makes the authored `strengths`/`weaknesses`
 * lines **mechanically** load-bearing instead of inert display text.
 *
 * ## The rule, and where it lives
 *
 * Producer decisions Q1 = **A + B** and Q3 = **×2 / ×0.5**:
 *
 * - a weapon named in a hex's `weaknesses` **counters** the boss →
 *   `'effective'` (two hit points per connected shot, applied by the combat
 *   seam);
 * - a weapon named in a hex's `strengths` is **resisted** by the boss →
 *   `'resisted'` (one hit point per **two** connected shots, rounded by the
 *   ledger below);
 * - everything else, an unknown weapon id, and an unauthored hex →
 *   `'neutral'` (one hit point per shot).
 *
 * The verdict is **player-centric** and matches the shipped display rule
 * (`./weaponMatchup`), which stays display-only: this module owns the combat
 * decision, that one owns the label on the config screen.
 *
 * ## Purity and injectability (Q4 = a, parent AC2/AC14)
 *
 * `resolveHexMatchup` never scans the authored lists and never consults the
 * weapon catalogue: its **input is a verdict lookup for a weapon id**
 * ({@link WeaponVerdictLookup}). A type-derived table (approach C) can
 * therefore replace `./hexRing`'s authored lists later with no edit to the
 * combat seam. {@link buildAuthoredVerdictLookup} is only the adapter that
 * builds that lookup from a hex's authored lists today.
 *
 * No Phaser, scene or DOM import; no I/O, no `Math.random`, no throwing.
 *
 * ## One alias table
 *
 * The ring data spells the laser `waveLaser`; the catalogue spells it
 * `wave_laser`. Both spellings normalise through the shared
 * {@link resolveGrantAlias} (the capture cycle's `GRANT_ALIASES`), so there is
 * one authored-spelling table in the codebase, never two.
 *
 * @module src/core/hangarWar/hexMatchup
 */

import { resolveGrantAlias } from './grantAliases';

/** A weapon's mechanical verdict against one hex's boss. */
export type HexMatchupVerdict = 'effective' | 'neutral' | 'resisted';

/**
 * One verdict's published display vocabulary (AH-0MWL8965R008K588).
 *
 * The **one** vocabulary every surface draws: the hex detail panel's
 * `STRENGTHS:`/`WEAKNESSES:` lines, the deployment selector's weapon rows and
 * the in-run combat feedback all read these entries, so the pre-commitment
 * intel and the fight can never speak different languages. Each state pairs a
 * distinct **symbol** (shape, readable with colour vision deficiency) with a
 * short word (readable by a screen reader) — never colour alone.
 */
export interface MatchupGlyph {
  /** The single symbol the surfaces draw (e.g. `▲`). */
  readonly glyph: string;
  /** The short uppercase word that names the state (e.g. `EFFECTIVE`). */
  readonly label: string;
  /** The full drawn tag: exactly `` `${glyph} ${label}` ``. */
  readonly marker: string;
}

/**
 * The published verdict → glyph vocabulary (AH-0MWL8965R008K588).
 *
 * `neutral` carries its **own** glyph rather than a blank mark: "unmarked"
 * would be indistinguishable from "no data" for a player reading without
 * colour. The keys are exactly {@link HexMatchupVerdict}, so a verdict and its
 * glyph cannot drift apart.
 */
export const MATCHUP_GLYPHS: Readonly<
  Record<HexMatchupVerdict, MatchupGlyph>
> = {
  effective: { glyph: '▲', label: 'EFFECTIVE', marker: '▲ EFFECTIVE' },
  neutral: { glyph: '●', label: 'NEUTRAL', marker: '● NEUTRAL' },
  resisted: { glyph: '▼', label: 'RESISTED', marker: '▼ RESISTED' },
};

/**
 * The glyph entry for a verdict — total, so an unknown input is neutral.
 *
 * A corrupt save, an older vocabulary value or a non-verdict never throws and
 * never renders blank: it resolves the neutral entry, mirroring
 * {@link resolveHexMatchup}'s totality.
 *
 * @param verdict — the verdict to render (any value).
 * @returns the published glyph entry for the verdict, or the neutral entry.
 */
export function matchupGlyphFor(verdict: unknown): MatchupGlyph {
  if (
    verdict === 'effective' ||
    verdict === 'neutral' ||
    verdict === 'resisted'
  ) {
    return MATCHUP_GLYPHS[verdict];
  }
  return MATCHUP_GLYPHS.neutral;
}

/**
 * The injectable verdict lookup: canonical weapon id → verdict.
 *
 * It is **data, not behaviour** (parent AC14): a caller may pass the authored
 * lists' adapter ({@link buildAuthoredVerdictLookup}), a synthetic table, or a
 * future damage-type table. The resolver trusts it alone.
 */
export type WeaponVerdictLookup = Readonly<Record<string, HexMatchupVerdict>>;

/**
 * The canonical catalogue id for an authored or catalogue weapon id.
 *
 * Aliases resolve through the shared {@link resolveGrantAlias} (`waveLaser` →
 * `wave_laser`); an id with no alias is already canonical and is returned
 * trimmed. `null` for a blank, missing or non-string id — total, never throws.
 *
 * Note this only normalises **spelling**: it does not check the weapon
 * catalogue. Load-time validation (`validateRingDefinitions`) is where an id
 * that names no catalogue weapon is rejected.
 *
 * @param weaponId — the authored or catalogue spelling of a weapon id.
 * @returns the canonical catalogue id, or `null` when there is none.
 */
export function normaliseMatchupWeaponId(weaponId: unknown): string | null {
  if (typeof weaponId !== 'string') return null;
  const id = weaponId.trim();
  if (id === '') return null;
  return resolveGrantAlias(id)?.entryId ?? id;
}

/**
 * Resolves one weapon's matchup verdict against a hex's boss.
 *
 * The **only** place the advantage/handicap is decided. Total: a `null`,
 * `undefined` or blank weapon id, a `null`/`undefined` lookup (an unauthored
 * hex) and an id the lookup does not name all resolve to `'neutral'`.
 *
 * @param weaponId — the weapon id the shot carries (authored or catalogue
 *   spelling; it is normalised before the lookup).
 * @param lookup — the injectable verdict lookup for the hex being fought.
 * @returns the verdict to apply at the hit seam.
 */
export function resolveHexMatchup(
  weaponId: string | null | undefined,
  lookup: WeaponVerdictLookup | null | undefined,
): HexMatchupVerdict {
  const weapon = normaliseMatchupWeaponId(weaponId);
  if (weapon === null || lookup === null || lookup === undefined) {
    return 'neutral';
  }
  return lookup[weapon] ?? 'neutral';
}

/**
 * Builds a hex's verdict lookup from its authored lists.
 *
 * Player-centric, mirroring {@link resolveHexMatchup}:
 *
 * - every `weaknesses` entry → `'effective'` (the boss is weak, so the weapon
 *   counters it);
 * - every `strengths` entry → `'resisted'` (the boss resists it).
 *
 * Every entry is normalised to its canonical catalogue id, so an authored
 * `waveLaser` and a catalogue `wave_laser` can never name different verdicts.
 *
 * **Tolerant by design:** a missing or non-array list (an unauthored hex, a
 * corrupt save) becomes nothing, and blank/non-string entries are skipped, so
 * the builder never throws on authored data. Rejecting bad authored data is
 * the load-time validator's job (`validateRingDefinitions`), not this
 * adapter's.
 *
 * @param strengths — the hex's authored `strengths`, if any.
 * @param weaknesses — the hex's authored `weaknesses`, if any.
 * @returns the verdict lookup for that hex (empty when nothing is authored).
 */
export function buildAuthoredVerdictLookup(
  strengths: readonly string[] | null | undefined,
  weaknesses: readonly string[] | null | undefined,
): WeaponVerdictLookup {
  const lookup: Record<string, HexMatchupVerdict> = {};
  for (const entry of canonicalEntries(strengths)) {
    lookup[entry] = 'resisted';
  }
  // Weakness wins a both-lists overlap, exactly as the display rule does; the
  // validator rejects such an overlap at load, so this is only a tie-break.
  for (const entry of canonicalEntries(weaknesses)) {
    lookup[entry] = 'effective';
  }
  return lookup;
}

/** The canonical ids of an authored list, skipping anything unusable. */
function canonicalEntries(list: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = normaliseMatchupWeaponId(entry);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/**
 * The resisted-credit ledger (Q3's ×0.5 rounding rule).
 *
 * The resisted rate is "one hit point per **two** connected shots", so the
 * ledger remembers the odd, unpaired shot and pays the credit to the second of
 * each pair. It is **deterministic and pure of RNG**: no new random
 * consumption, so seeded runs keep replaying identically. It performs no I/O.
 *
 * Credit is keyed **per target and per weapon**, so two weapons (or two
 * targets) never share a pair — a weapon's unpaired shot can never pay out on
 * a different weapon's next hit, and a fresh target always starts a fresh
 * pair. The state is bounded by (live targets × the weapons that hit them):
 * {@link forgetTarget} drops a target's rows when it dies, so a long run does
 * not accumulate dead-target rows.
 */
export interface MatchupLedger {
  /**
   * Per target, the set of weapons holding an **unpaired** resisted shot.
   *
   * Owned by this module; callers treat the ledger as an opaque handle and go
   * through {@link creditResistedHit}/{@link forgetTarget}.
   */
  readonly pending: Map<string, Set<string>>;
}

/** Creates a fresh, empty ledger (one per deployment/run). */
export function createMatchupLedger(): MatchupLedger {
  return { pending: new Map() };
}

/**
 * Records one connected **resisted** shot and returns the hit points to apply.
 *
 * @param ledger — the run's ledger (see {@link createMatchupLedger}).
 * @param targetId — the target the shot connected with.
 * @param weaponId — the weapon the shot came from (normalised before keying,
 *   so `waveLaser` and `wave_laser` share one pair rather than two).
 * @returns `1` on the **second** of each pair of connected shots (the credit),
 *   `0` on the first (and for a blank/unusable weapon id, which is neutral).
 */
export function creditResistedHit(
  ledger: MatchupLedger,
  targetId: string,
  weaponId: string,
): 0 | 1 {
  const weapon = normaliseMatchupWeaponId(weaponId);
  if (weapon === null) return 0;
  const pending = ledger.pending.get(targetId);
  if (pending?.has(weapon)) {
    pending.delete(weapon);
    // A target with nothing left pending carries no rows, so the ledger stays
    // bounded however many shots a long fight lands.
    if (pending.size === 0) ledger.pending.delete(targetId);
    return 1;
  }
  if (pending === undefined) {
    ledger.pending.set(targetId, new Set([weapon]));
  } else {
    pending.add(weapon);
  }
  return 0;
}

/**
 * Drops every weapon's credit for a target.
 *
 * Called when a target dies, so a respawned or recycled entity id starts a
 * fresh pair instead of inheriting a half-pair from its predecessor.
 *
 * @param ledger — the run's ledger.
 * @param targetId — the target that died (absent ids are a no-op).
 */
export function forgetTarget(ledger: MatchupLedger, targetId: string): void {
  ledger.pending.delete(targetId);
}
