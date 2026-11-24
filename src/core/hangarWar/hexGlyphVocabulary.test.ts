/**
 * Pre-commitment readability vocabulary
 * (AH-0MWL893J6006IFU9, **TEST-FIRST** — Phase 4 of 5 of
 * AH-0MWL5376H001WJFZ; parent AC10).
 *
 * The map's known-ahead intel and the in-run feedback must speak **one
 * vocabulary**: a player who reads `▲ EFFECTIVE` beside a weapon before
 * committing a life must see the same glyph when that weapon connects. This
 * suite pins that vocabulary and the intel panel's use of it *before* the glyph
 * vocabulary and the panel changes land (the implementation item is
 * AH-0MWL8965R008K588).
 *
 * ## Red-before / green-after
 *
 * Every case below is authored red against pre-change HEAD: neither the
 * published vocabulary (below) nor the intel panel's per-weapon marks exist
 * yet, so the cases are wrapped in Vitest's `it.fails` — the repo's red-first
 * convention (`src/scenes/core/hexMatchupDamageSources.test.ts`,
 * `src/vfx/impactStateFeedback.test.ts`). AH-0MWL8965R008K588 **flips every
 * `it.fails` back to a plain `it`** once the vocabulary lands; a leftover
 * `it.fails` then fails the suite, so this is a real target rather than a
 * permanent exemption.
 *
 * The vocabulary is reached through a **non-literal typed view** of
 * `./hexMatchup` (the exports do not exist yet, and a static import of a
 * missing symbol would fail `tsc --noEmit` and therefore the build). The
 * helpers below fail with the missing export named, so the red run reports
 * *what* is absent.
 *
 * ## Pinned contract (AH-0MWL8965R008K588 must match exactly)
 *
 * `src/core/hangarWar/hexMatchup.ts` — Phaser-free, beside the verdict type:
 *
 * - `interface MatchupGlyph` with three fields:
 *   - `glyph` — the single symbol drawn in the intel panel, the loadout
 *     selector and the combat feedback (e.g. `▲`);
 *   - `label` — the short uppercase word (`EFFECTIVE`);
 *   - `marker` — exactly `` `${glyph} ${label}` `` (e.g. `▲ EFFECTIVE`), the
 *     full tag every surface draws.
 * - `MATCHUP_GLYPHS: Readonly<Record<HexMatchupVerdict, MatchupGlyph>>` — the
 *   **one** published vocabulary, keyed by the combat verdict:
 *   - `effective` → `▲ EFFECTIVE`;
 *   - `neutral` → its **own** glyph (never blank — a blank mark is not
 *     distinguishable without colour);
 *   - `resisted` → `▼ RESISTED`.
 * - `matchupGlyphFor(verdict)` — total: the entry for a known verdict, the
 *   `neutral` entry for anything unrecognised (`null`, `undefined`, a string
 *   that is not a verdict), so an unknown weapon or an unauthored hex always
 *   renders the neutral glyph rather than throwing.
 *
 * `src/core/hangarWar/hexIntel.ts` — the detail panel:
 *
 * - `HexIntel.matchups: readonly HexWeaponMatchupIntel[]` — one row per
 *   **authored** weapon (`strengths` ∪ `weaknesses`), each
 *   `{ weaponId, verdict, glyph }`, where:
 *   - `weaponId` is the **canonical catalogue id** (the same key the combat
 *     lookup uses — `waveLaser` → `wave_laser`);
 *   - `verdict` is exactly `resolveHexMatchup(weaponId, buildAuthoredVerdictLookup(strengths, weaknesses))`,
 *     so intel and combat cannot disagree;
 *   - `glyph` is `MATCHUP_GLYPHS[verdict]`.
 *   An unauthored hex publishes no rows (it has no authored weapons) — the
 *   list is empty, never invented.
 * - the `STRENGTHS:` / `WEAKNESSES:` lines of the panel mark **each** listed
 *   weapon with that weapon's glyph, so the panel shows the vocabulary it will
 *   show in combat.
 *
 * @module core/hangarWar/hexGlyphVocabulary.test
 */

import { describe, expect, it } from 'vitest';

import { MATCHUP_IMPACT_STATE_CUES } from '../../audio/effects';
import { HEX_RING_DEFINITIONS } from '../../data/hexRingDefinitions';
import {
  HEX_STRENGTHS_PANEL_TITLE,
  HEX_WEAKNESSES_PANEL_TITLE,
  buildHexIntel,
  type HexIntel,
} from './hexIntel';
import * as hexMatchupModule from './hexMatchup';
import {
  buildAuthoredVerdictLookup,
  normaliseMatchupWeaponId,
  resolveHexMatchup,
} from './hexMatchup';
import type { HexRingDefinition } from './hexRing';
import type { HexState } from './types';

/** The three verdicts, in the order the vocabulary must publish them. */
const VERDICTS = ['effective', 'neutral', 'resisted'] as const;
type Verdict = (typeof VERDICTS)[number];

/** One state's glyph vocabulary entry (not yet published — see the header). */
interface MatchupGlyph {
  /** The single symbol the surfaces draw. */
  readonly glyph: string;
  /** The short uppercase word that names the state. */
  readonly label: string;
  /** The full drawn tag: `<glyph> <label>`. */
  readonly marker: string;
}

/** The vocabulary surface `./hexMatchup` must publish (not yet present). */
interface GlyphVocabularyModule {
  MATCHUP_GLYPHS?: Readonly<Record<Verdict, MatchupGlyph>>;
  matchupGlyphFor?: (verdict: unknown) => MatchupGlyph;
}

/** The intel row `./hexIntel` must publish per authored weapon (not yet present). */
interface HexWeaponMatchupIntel {
  /** Canonical catalogue weapon id — the combat lookup's key. */
  readonly weaponId: string;
  /** The verdict the combat path will apply to this weapon. */
  readonly verdict: Verdict;
  /** The glyph the panel and the fighter will both show. */
  readonly glyph: MatchupGlyph;
}

/** `HexIntel` plus the not-yet-published per-weapon matchup rows. */
type HexIntelView = HexIntel & {
  readonly matchups?: readonly HexWeaponMatchupIntel[];
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
  for (const verdict of VERDICTS) {
    if (glyphs[verdict] === undefined) {
      throw new Error(
        `MATCHUP_GLYPHS publishes no "${verdict}" entry — every verdict ` +
          'needs a glyph, neutral included.',
      );
    }
  }
  return glyphs;
}

/** Fails with the missing export named when `matchupGlyphFor` is absent. */
function glyphFor(verdict: unknown): MatchupGlyph {
  const resolve = vocabulary.matchupGlyphFor;
  if (typeof resolve !== 'function') {
    throw new Error(
      'Missing matchupGlyphFor(verdict) in src/core/hangarWar/hexMatchup.ts — ' +
        'the total verdict→glyph resolver does not exist yet.',
    );
  }
  return resolve.call(vocabulary, verdict);
}

/** Fails with the missing export named when the intel rows are absent. */
function matchupsOf(intel: HexIntel): readonly HexWeaponMatchupIntel[] {
  const rows = (intel as HexIntelView).matchups;
  if (rows === undefined) {
    throw new Error(
      'Missing HexIntel.matchups in src/core/hangarWar/hexIntel.ts — the ' +
        'detail panel does not publish its per-weapon glyphs yet.',
    );
  }
  return rows;
}

/** The detail-panel line that starts with `title` (`STRENGTHS:` …). */
function titledLine(label: string, title: string): string {
  const line = label
    .split('\n')
    .find((candidate) => candidate.startsWith(`${title}:`));
  if (line === undefined) {
    throw new Error(`The detail panel has no "${title}:" line:\n${label}`);
  }
  return line;
}

/** A published (unheld, undefended) state for one authored hex. */
function stateFor(definition: HexRingDefinition): HexState {
  return {
    id: definition.id,
    q: definition.q,
    r: definition.r,
    held: false,
    aggression: definition.baseAggression,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
  };
}

/** The intel model for one **authored** hex. */
function authoredIntel(definition: HexRingDefinition): HexIntel {
  return buildHexIntel(stateFor(definition), definition);
}

describe('matchup glyph vocabulary (AH-0MWL893J6006IFU9)', () => {
  // ── AC10 — shipped-data readability ─────────────────────────────
  // ────────────────────────────────────────────────────────────────

  it(
    'AC10 — every hex publishes the verdict and glyph each listed weapon will show in combat',
    () => {
      const glyphs = requireGlyphs();
      expect(HEX_RING_DEFINITIONS.length).toBeGreaterThan(0);

      for (const definition of HEX_RING_DEFINITIONS) {
        const intel = authoredIntel(definition);
        const rows = matchupsOf(intel);
        const lookup = buildAuthoredVerdictLookup(
          definition.strengths,
          definition.weaknesses,
        );
        const authored = [...definition.strengths, ...definition.weaknesses];

        // One row per authored weapon, never a re-derived or invented set.
        expect(rows).toHaveLength(authored.length);

        for (const authoredId of authored) {
          const weaponId = normaliseMatchupWeaponId(authoredId);
          expect(weaponId, `${definition.id} has an unusable id`).not.toBeNull();

          const row = rows.find((candidate) => candidate.weaponId === weaponId);
          expect(
            row,
            `${definition.id} publishes no matchup row for "${authoredId}"`,
          ).toBeDefined();

          // The panel's verdict is the combat rule's verdict — one vocabulary.
          const verdict = resolveHexMatchup(weaponId, lookup);
          expect(row!.verdict, `${definition.id}/${authoredId} verdict`).toBe(
            verdict,
          );
          // An authored entry always names a side, so it is never neutral.
          expect(['effective', 'resisted']).toContain(row!.verdict);
          expect(row!.glyph, `${definition.id}/${authoredId} glyph`).toEqual(
            glyphs[verdict],
          );
        }
      }
    },
  );

  it(
    'AC10 — the detail panel marks every listed weapon with its combat glyph',
    () => {
      const glyphs = requireGlyphs();

      for (const definition of HEX_RING_DEFINITIONS) {
        const { label } = authoredIntel(definition);
        const strengthsLine = titledLine(
          label,
          HEX_STRENGTHS_PANEL_TITLE,
        );
        const weaknessesLine = titledLine(
          label,
          HEX_WEAKNESSES_PANEL_TITLE,
        );

        // Every strength is resisted, every weakness is effective — the same
        // verdicts the combat path applies, drawn on the pre-commitment panel.
        for (const weapon of definition.strengths) {
          expect(
            strengthsLine,
            `${definition.id} strengths line names "${weapon}" but its ` +
              'resisted glyph is missing',
          ).toContain(weapon);
          expect(
            strengthsLine,
            `${definition.id} strengths line does not draw ${glyphs.resisted.marker}`,
          ).toContain(glyphs.resisted.glyph);
          expect(
            strengthsLine,
            `${definition.id} strengths line draws the effective glyph`,
          ).not.toContain(glyphs.effective.glyph);
        }
        for (const weapon of definition.weaknesses) {
          expect(
            weaknessesLine,
            `${definition.id} weaknesses line names "${weapon}" but its ` +
              'effective glyph is missing',
          ).toContain(weapon);
          expect(
            weaknessesLine,
            `${definition.id} weaknesses line does not draw ${glyphs.effective.marker}`,
          ).toContain(glyphs.effective.glyph);
          expect(
            weaknessesLine,
            `${definition.id} weaknesses line draws the resisted glyph`,
          ).not.toContain(glyphs.resisted.glyph);
        }

        // An authored hex never draws the neutral glyph on an authored list.
        expect(strengthsLine).not.toContain(glyphs.neutral.glyph);
        expect(weaknessesLine).not.toContain(glyphs.neutral.glyph);
      }
    },
  );

  // ── AC10 — distinguishable without colour ──────────────────────
  // ────────────────────────────────────────────────────────────────

  it(
    'AC10 — the three glyphs are distinct symbols, so the vocabulary survives colour-vision deficiency',
    () => {
      const glyphs = requireGlyphs();

      for (const verdict of VERDICTS) {
        const { glyph, label, marker } = glyphs[verdict];
        // A glyph is exactly one visible symbol — not an empty mark and not a
        // word (the word lives in `label`/`marker` for screen readers).
        expect(typeof glyph, `${verdict} glyph`).toBe('string');
        expect([...glyph], `${verdict} glyph "${glyph}" is not one symbol`).toHaveLength(
          1,
        );
        expect(glyph.trim(), `${verdict} glyph is blank`).not.toBe('');
        expect(label.length, `${verdict} label is blank`).toBeGreaterThan(0);
        // The marker is the one drawn tag the surfaces reuse.
        expect(marker, `${verdict} marker must be "<glyph> <label>"`).toBe(
          `${glyph} ${label}`,
        );
      }

      // Shape, not hue: three different symbols, not three colours of one.
      const distinct = new Set(VERDICTS.map((verdict) => glyphs[verdict].glyph));
      expect(distinct.size, 'the three states share a glyph').toBe(3);
    },
  );

  it(
    'AC10 — the vocabulary is keyed by the states the combat presentation already publishes',
    () => {
      const glyphs = requireGlyphs();

      // One key set, no fourth state and no state without a glyph.
      expect(Object.keys(glyphs).sort()).toEqual([...VERDICTS].sort());

      // The combat presentation's published state→cue mapping uses the same two
      // non-neutral keys, so a state can never exist in one vocabulary and not
      // the other (the mapping and the glyphs cannot drift apart).
      expect(Object.keys(MATCHUP_IMPACT_STATE_CUES).sort()).toEqual([
        'effective',
        'resisted',
      ]);
    },
  );

  // ── AC10 — the neutral fallback ────────────────────────────────
  // ────────────────────────────────────────────────────────────────

  it(
    'AC10 — an unknown weapon and an unauthored hex both resolve the neutral glyph',
    () => {
      const glyphs = requireGlyphs();
      const authoredLookup = buildAuthoredVerdictLookup(
        ['cannon'],
        ['spread'],
      );

      // Unknown weapon: the combat rule is total and neutral, and the glyph
      // follows the verdict rather than a second lookup.
      expect(resolveHexMatchup('definitely-not-a-weapon', authoredLookup)).toBe(
        'neutral',
      );
      expect(glyphFor('neutral')).toEqual(glyphs.neutral);

      // Unauthored hex: no lookup at all is neutral, and so is the glyph.
      expect(resolveHexMatchup('cannon', null)).toBe('neutral');
      expect(glyphFor('neutral')).toEqual(glyphs.neutral);

      // The resolver is total over unusable input too (a corrupt save, an
      // older vocabulary value), never throwing and never blank.
      for (const unusable of [null, undefined, 'not-a-verdict', 42, {}]) {
        expect(glyphFor(unusable), `glyph for ${String(unusable)}`).toEqual(
          glyphs.neutral,
        );
      }
    },
  );

  it(
    'AC10 — an unauthored hex publishes no matchup rows and draws no non-neutral glyph',
    () => {
      const glyphs = requireGlyphs();
      const intel = buildHexIntel(
        {
          id: 'hex-unwritten',
          q: 1,
          r: 0,
          held: false,
          aggression: 3,
          defender: null,
          bossDefeated: false,
          grantedWeapon: null,
        },
        undefined,
      );

      // Nothing authored ⇒ no invented rows, and the panel keeps its explicit
      // unknown fallback.
      expect(matchupsOf(intel)).toHaveLength(0);
      expect(intel.label).toContain(
        `${HEX_STRENGTHS_PANEL_TITLE}: unknown`,
      );
      expect(intel.label).toContain(
        `${HEX_WEAKNESSES_PANEL_TITLE}: unknown`,
      );

      // A weapon fired at that hex resolves neutral, so its glyph is neutral.
      expect(glyphFor(resolveHexMatchup('cannon', null))).toEqual(
        glyphs.neutral,
      );
      expect(intel.label).not.toContain(glyphs.effective.glyph);
      expect(intel.label).not.toContain(glyphs.resisted.glyph);
    },
  );
});
