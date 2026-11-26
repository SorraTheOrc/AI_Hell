/**
 * The one authored-spelling alias table (AH-0MWL88JJM004ORZS).
 *
 * The ring data uses the design's spelling (`waveLaser`, `extra-life`); the
 * hangar catalogue uses its own ids (`wave_laser`, `hardened_plating`). They
 * name the same entry, so this table keeps one entry from appearing twice in
 * the fleet and lets any consumer compare an authored spelling with a
 * catalogue id.
 *
 * It lives in its **own leaf module** so the shared table can be read from
 * either side of the hangar-war graph without an import cycle: the capture
 * cycle (which resolves a grant) and the hex matchup rule (which resolves an
 * authored `strengths`/`weaknesses` entry) both read it from here.
 * `captureCycle.ts` re-exports {@link resolveGrantAlias} and {@link GrantAlias}
 * unchanged, so existing imports keep working — there is **one** table, never
 * a second copy.
 *
 * No Phaser, scene or DOM import; the module is data plus one total lookup.
 *
 * @module src/core/hangarWar/grantAliases
 */

import type { HangarEntryKind } from '../../data/hangarCatalogue';
import type { WeaponId } from '../../utils/weapons';

/** One authored-grant alias: the shared canonical entry and its weapon. */
export interface GrantAlias {
  /** The shipped hangar catalogue id the authored spelling names. */
  readonly entryId: string;
  /** Which owned set the entry belongs to. */
  readonly kind: HangarEntryKind;
  /** The shipped weapon id, when the entry is a weapon. */
  readonly weaponId?: WeaponId;
}

/** Authored grant ids that are aliases of a shipped hangar catalogue entry. */
export const GRANT_ALIASES: Readonly<Record<string, GrantAlias>> = Object.freeze({
  waveLaser: Object.freeze({
    entryId: 'wave_laser',
    kind: 'weapon' as const,
    weaponId: 'wave_laser' as const,
  }),
  'extra-life': Object.freeze({
    entryId: 'hardened_plating',
    kind: 'modifier' as const,
  }),
});

/** A trimmed, non-empty string, or `null`. */
function toId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return id === '' ? null : id;
}

/**
 * The shared authored-spelling lookup, built on {@link GRANT_ALIASES}.
 *
 * This is the **one** alias table in the codebase: the capture cycle resolves
 * a grant through it here, the hex matchup rule normalises an authored
 * `strengths`/`weaknesses` entry through it, and the weapon-vs-boss display
 * matchup (`./weaponMatchup`) reads it too — never a second ad-hoc table.
 *
 * Total: a blank/non-string id, or an id with no alias, resolves to `null`;
 * the caller keeps the id unchanged in that case.
 *
 * @param id — the authored (or catalogue) spelling, e.g. `waveLaser`.
 * @returns the aliased canonical entry, or `null` when there is no alias.
 */
export function resolveGrantAlias(id: unknown): GrantAlias | null {
  const key = toId(id);
  if (key === null) return null;
  return GRANT_ALIASES[key] ?? null;
}
