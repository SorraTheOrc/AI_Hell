/**
 * Weapon-vs-boss display matchup — the pure verdict behind the pre-battle
 * config screen (AH-0MWMT4NJV001PX8Y, part of
 * AH-0MWMRWCY2001HWGR).
 *
 * Design of record: `docs/OUTER_LOOP_CANDIDATES.md` Candidate D § *Known-ahead
 * intel* — "the weapon that is **strong against the boss**" — and GDD §8.2
 * ("Boss and weapon strength are known ahead").
 *
 * ## The display rule, not the combat rule
 *
 * This module answers one question for the hangar screen: *is this weapon
 * strong, weak or neutral against the hex boss whose lists are shown beside
 * it?* It is **display only** (parent assumption A7): nothing here changes the
 * fight. The mechanical rule is AH-0MWL5376H001WJFZ's `resolveHexMatchup`
 * (`effective | neutral | resisted`); the two share the `strong`/`weak`
 * vocabulary and the alias normalisation below, but neither duplicates the
 * other's rule.
 *
 * The verdict is **player-centric** (parent assumption A2):
 *
 * - a weapon in the boss's `weaknesses` counters the boss → `strong`;
 * - a weapon in the boss's `strengths` is resisted by the boss → `weak`;
 * - everything else → `neutral`.
 *
 * **Tie-break:** when an authored list names the same weapon in both
 * `strengths` and `weaknesses`, the weakness/`strong` verdict wins — the
 * player is told to bring the weapon that counters the boss. Rejecting such an
 * overlap at authoring time is AH-0MWL5376H001WJFZ's job, not this rule's.
 *
 * ## One alias, never two tables
 *
 * Ring data spells the laser `waveLaser`; the catalogue spells it
 * `wave_laser`. Both the weapon id and every authored list entry are normalised
 * through the capture cycle's shared {@link resolveGrantAlias} (built on
 * `GRANT_ALIASES`), so a catalogue weapon and an authored list can never
 * disagree.
 *
 * ## Total and pure
 *
 * No Phaser, scene or DOM import; no mutation and no throwing. A missing
 * weapon (blank, `null`, `undefined`, non-string) or a missing/malformed hex
 * definition (unauthored hex, bad authored lists) resolves to `neutral`.
 */

import { resolveGrantAlias } from './captureCycle';
import type { HexRingDefinition } from './hexRing';

/** A weapon's display verdict against one boss. */
export type BossMatchup = 'strong' | 'weak' | 'neutral';

/** The authored lists the resolver reads (a full hex definition also fits). */
export type MatchupDefinition = Pick<
  HexRingDefinition,
  'strengths' | 'weaknesses'
>;

/**
 * The canonical catalogue id for an authored or catalogue weapon id.
 *
 * Aliases resolve through the shared {@link resolveGrantAlias}; an id with no
 * alias is already canonical and is returned trimmed. `null` for a blank,
 * missing or non-string id.
 */
function canonicalWeaponId(weaponId: unknown): string | null {
  if (typeof weaponId !== 'string') return null;
  const id = weaponId.trim();
  if (id === '') return null;
  return resolveGrantAlias(id)?.entryId ?? id;
}

/**
 * An authored boss list normalised to canonical catalogue ids.
 *
 * Tolerant by design: a missing or non-array list (an unauthored hex, a
 * corrupt save) becomes an empty list, and blank/non-string entries are
 * skipped, so the resolver can never throw on authored data.
 */
function canonicalList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const ids: string[] = [];
  for (const entry of list) {
    const id = canonicalWeaponId(entry);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/**
 * Resolves a weapon's display matchup against a hex's authored boss lists.
 *
 * @param weaponId — a catalogue weapon id (`wave_laser`) or the authored/ring
 *   spelling (`waveLaser`); `null`/`undefined`/unknown ids are neutral.
 * @param definition — the hex's authored definition, or `null`/`undefined` for
 *   an unauthored/unknown hex (neutral).
 * @returns `strong` when the boss is weak against the weapon, `weak` when it is
 *   strong against it, otherwise `neutral`. Weakness wins a both-lists overlap.
 */
export function resolveBossMatchup(
  weaponId: string | null | undefined,
  definition: MatchupDefinition | null | undefined,
): BossMatchup {
  const weapon = canonicalWeaponId(weaponId);
  if (weapon === null || definition === null || definition === undefined) {
    return 'neutral';
  }
  if (canonicalList(definition.weaknesses).includes(weapon)) return 'strong';
  if (canonicalList(definition.strengths).includes(weapon)) return 'weak';
  return 'neutral';
}
