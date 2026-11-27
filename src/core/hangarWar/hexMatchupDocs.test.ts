/**
 * Matchup intel docs guard (AH-0MWL898RM009X9B8, parent AH-0MWL5376H001WJFZ;
 * AC13).
 *
 * The hex map's `STRENGTHS:`/`WEAKNESSES:` lines used to be inert display text
 * and the docs described the intel as a strategist affordance the build never
 * cashed. They are now **rules** (2 hit points per connected shot on a
 * weakness, 1 per two shots on a strength, never immune), so the design of
 * record must say so — and must stop implying the lists are advisory.
 *
 * This is a deliberate docs grep, in the style of the sibling docs-assertion
 * guards (`src/vfx/droneFeel.docs.test.ts`): the acceptance criterion *is* the
 * documentation text, so a silently drifting GDD or candidate doc is the
 * failure mode being guarded. The mechanic itself is pinned in behaviour —
 * `src/core/hangarWar/hexMatchup.test.ts`, `src/scenes/core/hexMatchupDamageSources.test.ts`,
 * `src/scenes/core/matchupImpactPresentation.test.ts` and
 * `src/scenes/gym/gymMatchupParity.test.ts` — and the published glyph
 * vocabulary in `src/core/hangarWar/hexGlyphVocabulary.test.ts`.
 *
 * @module core/hangarWar/hexMatchupDocs.test
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

/** The GDD's authored-intel section (§8.2 "Boss and weapon strength"). */
const GDD = () => read('docs/Game Design Document.md');

/** The candidate-option doc the design of record points at. */
const CANDIDATES = () => read('docs/OUTER_LOOP_CANDIDATES.md');

describe('hex matchup intel documentation (AH-0MWL898RM009X9B8)', () => {
  it('the GDD states what strengths and weaknesses DO, with the magnitudes', () => {
    const gdd = GDD();

    // The rule itself, with the chosen magnitudes.
    expect(gdd).toContain('2 hit points\nper connected shot');
    expect(gdd).toContain('1 hit point per\ntwo connected shots');
    expect(gdd).toContain('never immune');

    // And the pre-commitment vocabulary it shares with the fight.
    expect(gdd).toContain('▲ EFFECTIVE');
    expect(gdd).toContain('▼ RESISTED');
  });

  it('the GDD panel section publishes the same glyph vocabulary', () => {
    const gdd = GDD();
    // The hex detail panel's overview lines carry the combat glyph per weapon.
    expect(gdd).toContain('Each listed\nweapon also carries the **combat glyph**');
    expect(gdd).toContain('`▲ EFFECTIVE` on the `WEAKNESSES:` line');
    expect(gdd).toContain('`▼ RESISTED` on the `STRENGTHS:`');
  });

  it('the candidate doc describes the intel as mechanically load-bearing', () => {
    const candidates = CANDIDATES();
    expect(candidates).toContain('mechanically load-bearing');
    expect(candidates).toContain('2 hit points per connected');
    expect(candidates).toContain('1 per two shots');
  });

  it('neither doc still calls the authored lists advisory or inert', () => {
    for (const [name, text] of [
      ['docs/Game Design Document.md', GDD()],
      ['docs/OUTER_LOOP_CANDIDATES.md', CANDIDATES()],
    ] as const) {
      // The retired framing (the lists are labels with no runtime rule) must
      // not come back in the prescriptive text; the shipped rule is stated
      // instead. (Historical review addenda may quote the old gap.)
      expect(text, name).not.toMatch(
        /strengths? and weaknesses?[^.]{0,80}(advisory|inert|purely cosmetic)/i,
      );
    }
    // The GDD's own known-ahead intel bullet describes the rule, not a gap.
    const bullet = GDD()
      .split('\n- **')
      .find((entry) => entry.startsWith('Boss and weapon strength are known'));
    expect(bullet, 'the GDD intel bullet is missing').toBeDefined();
    expect(bullet!).not.toMatch(/advisory|inert|no runtime rule/i);
  });

  it('the balance doc records the re-measured ring-timing numbers', () => {
    const balancing = read('docs/BALANCING.md');
    expect(balancing).toContain('The matchup rule is in the measurement of record');
    // The matchup section's own figures are historical evidence (ring 1
    // re-measured 23.74 → 22.57 min when `hex-r1-1` dropped to aggression 1,
    // AH-0MWW28ET2002PNI8), and the doc records the superseding measurement
    // from the game-faithful kill-drop economy (AH-0MWT5CRJ600382MS). Both are
    // pinned so a stale doc quote of either state fails here.
    expect(balancing).toContain('22.57 min');
    expect(balancing).toContain('51.68 min');
    expect(balancing).toContain('27.85 min');
    expect(balancing).toContain('59.10 min');
    // The rebalance items that own the remaining window gap are named.
    expect(balancing).toContain('AH-0MWFDQ9EY004NO4X');
    expect(balancing).toContain('AH-0MWFDQCFV007BZE5');
  });
});
