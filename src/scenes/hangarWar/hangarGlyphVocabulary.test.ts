/**
 * Deployment-selector matchup glyph parity
 * (AH-0MWL893J6006IFU9, **TEST-FIRST** — Phase 4 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC10).
 *
 * The loadout selector is where the player commits a life, so the glyph it
 * shows beside an owned weapon must be **the same glyph** the fight will show
 * when that weapon connects. This suite pins the selector's use of the one
 * published vocabulary (see `hexGlyphVocabulary.test.ts` for the vocabulary
 * and intel-panel contract) before AH-0MWL8965R008K588 wires it.
 *
 * ## Red-before / green-after
 *
 * The published vocabulary and the selector's per-row `matchupGlyph` do not
 * exist on pre-change HEAD, so every case is wrapped in Vitest's `it.fails`
 * (the repo's red-first convention). AH-0MWL8965R008K588 flips each `it.fails`
 * back to a plain `it` when it lands the glyphs; a leftover `it.fails` then
 * fails the suite.
 *
 * ## Pinned contract (AH-0MWL8965R008K588 must match exactly)
 *
 * - `MATCHUP_GLYPHS` / `matchupGlyphFor` in
 *   `src/core/hangarWar/hexMatchup.ts` are exactly as pinned in
 *   `hexGlyphVocabulary.test.ts`.
 * - `HangarWeaponOption.matchupGlyph: MatchupGlyph` — the shared vocabulary
 *   entry for the weapon's verdict against the **selected hex**, resolved by
 *   the combat rule (`resolveHexMatchup` over the hex's authored lookup), not
 *   by a selector-local rule. The rendered `label` contains that entry's
 *   `marker`.
 * - The selector's own marker constants (`HANGAR_STRONG_MARKER`,
 *   `HANGAR_WEAK_MARKER`) are the shared entries' markers — never a second
 *   literal pair that could drift.
 *
 * The neutral state carries its own glyph (pinned in the vocabulary suite), so
 * a neutral weapon row is marked too — "unmarked" would be indistinguishable
 * from "no data" for a player reading without colour.
 *
 * @module scenes/hangarWar/hangarGlyphVocabulary.test
 */

import { describe, expect, it } from 'vitest';

import {
  buildHangarScreenModel,
  HANGAR_STRONG_MARKER,
  HANGAR_WEAK_MARKER,
  type HangarWeaponOption,
} from './hangarScreen';
import { findHexRingDefinition } from '../../data/hexRingDefinitions';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import {
  buildAuthoredVerdictLookup,
  normaliseMatchupWeaponId,
  resolveHexMatchup,
} from '../../core/hangarWar/hexMatchup';
import * as hexMatchupModule from '../../core/hangarWar/hexMatchup';
import { createRingState } from '../../core/hangarWar/hexRing';
import { createDefaultPayload } from '../../core/hangarWar/hangarWarStore';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import type { HangarWarPayload } from '../../core/hangarWar/types';

const VERDICTS = ['effective', 'neutral', 'resisted'] as const;
type Verdict = (typeof VERDICTS)[number];

/** One state's glyph vocabulary entry (not yet published — see the header). */
interface MatchupGlyph {
  readonly glyph: string;
  readonly label: string;
  readonly marker: string;
}

/** The vocabulary surface `../../core/hangarWar/hexMatchup` must publish. */
interface GlyphVocabularyModule {
  MATCHUP_GLYPHS?: Readonly<Record<Verdict, MatchupGlyph>>;
  matchupGlyphFor?: (verdict: unknown) => MatchupGlyph;
}

/** `HangarWeaponOption` plus the not-yet-published glyph field. */
type WeaponOptionView = HangarWeaponOption & {
  readonly matchupGlyph?: MatchupGlyph;
};

const vocabulary = hexMatchupModule as unknown as typeof hexMatchupModule &
  GlyphVocabularyModule;

/** Fails with the missing export named when `MATCHUP_GLYPHS` is absent. */
function requireGlyphs(): Readonly<Record<Verdict, MatchupGlyph>> {
  const glyphs = vocabulary.MATCHUP_GLYPHS;
  if (glyphs === undefined) {
    throw new Error(
      'Missing MATCHUP_GLYPHS in src/core/hangarWar/hexMatchup.ts — the ' +
        'published matchup glyph vocabulary does not exist yet.',
    );
  }
  return glyphs;
}

/** A war whose fleet owns every hangar-catalogue weapon and a ring. */
function ownedPayload(): HangarWarPayload {
  const payload = createDefaultPayload(7);
  payload.ring = createRingState(1, HEX_RING_DEFINITIONS);
  payload.hangar.unlockedWeapons = [
    'spread',
    'wave_laser',
    'ricochet',
    'cluster',
  ];
  payload.hangar.activeLoadout = { startingWeapons: ['spread'], modifiers: [] };
  return payload;
}

/** The verdict the combat rule applies to `weaponId` on `hexId`. */
function combatVerdict(weaponId: string, hexId: string): Verdict {
  const definition = findHexRingDefinition(hexId);
  if (definition === undefined) {
    throw new Error(`No authored definition for ${hexId}`);
  }
  return resolveHexMatchup(
    weaponId,
    buildAuthoredVerdictLookup(definition.strengths, definition.weaknesses),
  );
}

/** The selector's owned-weapon rows for a target hex. */
function weaponOptionsFor(hexId: string): WeaponOptionView[] {
  return buildHangarScreenModel(ownedPayload(), HANGAR_CATALOGUE, {
    targetHexId: hexId,
  }).weaponOptions as WeaponOptionView[];
}

describe('deployment-selector matchup glyphs (AH-0MWL893J6006IFU9)', () => {
  it.fails(
    'AC10 — every owned weapon row publishes the combat glyph for the selected hex',
    () => {
      const glyphs = requireGlyphs();
      // hex-r1-6 grants the Wave Laser: spread is a weakness (effective) while
      // wave_laser/ricochet/cluster are neutral — so the row set exercises two
      // of the three verdicts without leaving the selector.
      const options = weaponOptionsFor('hex-r1-6');
      expect(options.length).toBeGreaterThan(0);

      for (const option of options) {
        const weaponId = normaliseMatchupWeaponId(option.id);
        expect(weaponId, `${option.id} is not a usable weapon id`).not.toBeNull();
        const verdict = combatVerdict(weaponId!, 'hex-r1-6');
        const expected = glyphs[verdict];

        expect(
          option.matchupGlyph,
          `${option.id} does not publish the ${verdict} glyph`,
        ).toEqual(expected);
        expect(
          option.label,
          `${option.id} label does not draw ${expected.marker}`,
        ).toContain(expected.marker);

        // Never the wrong state's glyph on the row.
        for (const other of VERDICTS) {
          if (other === verdict) continue;
          expect(
            option.label,
            `${option.id} label draws the ${other} glyph`,
          ).not.toContain(glyphs[other].glyph);
        }
      }

      // The selector's own marker constants ARE the shared vocabulary.
      expect(HANGAR_STRONG_MARKER).toBe(glyphs.effective.marker);
      expect(HANGAR_WEAK_MARKER).toBe(glyphs.resisted.marker);
    },
  );

  it.fails(
    'AC10 — the same owned weapon flips glyph when the selected hex changes',
    () => {
      const glyphs = requireGlyphs();
      // `spread` is a weakness of hex-r1-6 (effective) and a strength of
      // hex-r1-2 (resisted): the glyph follows the selected hex, resolved by
      // the one shared rule.
      const onWeakness = weaponOptionsFor('hex-r1-6').find(
        (option) => option.id === 'spread',
      )!;
      const onStrength = weaponOptionsFor('hex-r1-2').find(
        (option) => option.id === 'spread',
      )!;
      const onNeutral = weaponOptionsFor('hex-r1-1').find(
        // hex-r1-1 authors cannon/dual strengths and nova/arc weaknesses.
        (option) => option.id === 'spread',
      )!;

      expect(combatVerdict('spread', 'hex-r1-6')).toBe('effective');
      expect(combatVerdict('spread', 'hex-r1-2')).toBe('resisted');
      expect(combatVerdict('spread', 'hex-r1-1')).toBe('neutral');

      expect(onWeakness.matchupGlyph).toEqual(glyphs.effective);
      expect(onStrength.matchupGlyph).toEqual(glyphs.resisted);
      expect(onNeutral.matchupGlyph).toEqual(glyphs.neutral);

      expect(onWeakness.label).toContain(glyphs.effective.marker);
      expect(onStrength.label).toContain(glyphs.resisted.marker);
      expect(onNeutral.label).toContain(glyphs.neutral.marker);
    },
  );

  it.fails(
    'AC10 — only weapon rows carry a glyph (hulls and modifiers stay unmarked)',
    () => {
      requireGlyphs();
      const model = buildHangarScreenModel(ownedPayload(), HANGAR_CATALOGUE, {
        targetHexId: 'hex-r1-6',
      });

      for (const hull of model.hullOptions) {
        expect(
          (hull as unknown as { matchupGlyph?: unknown }).matchupGlyph ?? null,
          `hull ${hull.id} carries a matchup glyph`,
        ).toBeNull();
      }
      for (const modifier of model.modifierOptions) {
        expect(
          (modifier as unknown as { matchupGlyph?: unknown }).matchupGlyph ??
            null,
          `modifier ${modifier.id} carries a matchup glyph`,
        ).toBeNull();
      }
    },
  );
});
