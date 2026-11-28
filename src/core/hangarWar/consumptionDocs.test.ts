/**
 * Docs guard: a battle spends **ownership only** (AH-0MWWGH8K90071JEX, parent
 * AH-0MWW5RACR000UCKU).
 *
 * The flown ship is a one-battle consumable, but the consumed ids' bought
 * permanent level rows (`weaponLevels` / `powerUpLevels`) are deliberately
 * retained: the mineral investment survives a win or a loss and a normal-price
 * re-purchase restores the level. This guard fails if a player-facing surface
 * drifts back to the retired claim that a consumption removes those rows, and
 * it pins the retention wording on every surface that describes the rule.
 *
 * Like the sibling `src/powerUpLevelingDocs.test.ts` and
 * `src/buyToUpgradeDocs.test.ts`, this is a deliberate docs grep: it asserts
 * the canonical documentation (the AC), not runtime behaviour.
 * `CHANGELOG.md` is deliberately absent — the ship skill's release pipeline
 * owns it and keeps its historical entries.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const GDD = read('docs/Game Design Document.md');
const README = read('README.md');
const GYM_PARITY = read('docs/GYM_PARITY.md');
const OUTER_LOOP = read('docs/OUTER_LOOP_CANDIDATES.md');
const HANGAR_ECONOMY = read('src/core/hangarWar/hangarEconomy.ts');
const CAPTURE_CYCLE = read('src/core/hangarWar/captureCycle.ts');

/**
 * Every shipped surface that describes what a completed deployment spends, in
 * both the player-facing references and the code comments. `CHANGELOG.md` is
 * deliberately absent — the ship skill's release pipeline owns it and keeps its
 * historical entries.
 */
const CONSUMPTION_SURFACES: ReadonlyArray<[string, string]> = [
  ['docs/Game Design Document.md', GDD],
  ['README.md', README],
  ['docs/GYM_PARITY.md', GYM_PARITY],
  ['docs/OUTER_LOOP_CANDIDATES.md', OUTER_LOOP],
  ['src/core/hangarWar/hangarEconomy.ts', HANGAR_ECONOMY],
  ['src/core/hangarWar/captureCycle.ts', CAPTURE_CYCLE],
];

/**
 * The exact statements of the retired "consumption deletes the bought levels"
 * rule. A sentence may quote one only when it also states the retention rule
 * (the guard's `RETENTION_MARKERS`), which is how the surfaces record the fix.
 */
const RETIRED_CONSUMPTION_CLAIMS: ReadonlyArray<[string, RegExp]> = [
  [
    'a level-row deletion',
    /level rows?[^.]{0,40}\b(?:removed|spent|dropped|deleted|wiped)\b/i,
  ],
  [
    'a deletion stated before level rows',
    /\b(?:removed|spent|dropped|deleted|wiped)\b[^.]{0,40}\blevel rows?\b/i,
  ],
  [
    'a spend that reaches bought permanent levels',
    /\bspen(?:d|ds|t)\b[^.]{0,160}\bbought permanent levels?\b/i,
  ],
  [
    'bought permanent levels stated as spent',
    /\bbought permanent levels?\b[^.]{0,60}\b(?:are|is)\s+(?:spent|removed|dropped)\b/i,
  ],
  [
    'the consumed ids’ level fields removed',
    /(?:weaponLevels|powerUpLevels)[^.]{0,60}\b(?:are|is)\s+(?:spent|removed|dropped)\b/i,
  ],
  [
    'their bought permanent levels spent',
    /\btheir bought permanent levels?\b[^.]{0,80}\b(?:spent|removed|dropped)\b/i,
  ],
];

/** The retention rule any sentence quoting a retired claim must also state. */
const RETENTION_MARKERS =
  /ownership only|retain|surviv|\bnever\b|\bnot\b|\bkept\b|preserv/i;

/** Split a document into sentences (line wrapping is normalised away). */
const sentences = (text: string): string[] =>
  text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.trim().length > 0);

/** The doc comment that introduces `phrase` in a source file. */const docCommentFor = (source: string, phrase: string): string => {
  const at = source.indexOf(phrase);
  if (at < 0) return '';
  const start = source.lastIndexOf('/**', at);
  const end = source.indexOf('*/', at);
  if (start < 0 || end < 0) return '';
  return source.slice(start, end + 2);
};

/** GDD step 5 of the hex-capture sequence (up to the loss paragraph). */
const gddSpendTheFlownShipStep = (): string => {
  const start = /^5\.\s+\*\*Spend the flown ship/m.exec(GDD);
  if (!start || start.index === undefined) return '';
  const rest = GDD.slice(start.index);
  const end = /^A lost deployment is the mirror image/m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).replace(/\s+/g, ' ');
};

/** The buy-to-upgrade subsection of §8.2 (heading plus body, up to the next `####`). */
const gddBuyToUpgradeSection = (): string => {
  const heading = /^####\s+Buying permanent levels[^\n]*$/m.exec(GDD);
  if (!heading || heading.index === undefined) return '';
  const rest = GDD.slice(heading.index);
  const next = /\n####\s/.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).replace(/\s+/g, ' ');
};

describe('the design of record says a battle spends ownership only (AH-0MWWGH8K90071JEX)', () => {
  it('GDD step 5 states the retention rule: ownership only, levels survive, a re-purchase restores them', () => {
    const step = gddSpendTheFlownShipStep();
    expect(step.trim().length).toBeGreaterThan(200);
    expect(step).toMatch(/ownership only/i);
    // The bought permanent rows survive both outcomes …
    expect(step).toMatch(/survives? a win or a loss|win or a loss/i);
    expect(step).toMatch(/bought permanent|bought levels/i);
    expect(step).toMatch(/retain/i);
    // … and a normal-price re-purchase brings the level back.
    expect(step).toMatch(/re-purchas|re-buy|repurchase/i);
    expect(step).toMatch(/restores? (?:it|the retained level)|retained level/i);
  });

  it('GDD § Buying permanent levels records the ladder as a one-off investment that survives a lost sortie', () => {
    const section = gddBuyToUpgradeSection();
    expect(section.trim().length).toBeGreaterThan(200);
    expect(section).toMatch(/one-off investment/i);
    expect(section).toMatch(/ownership only/i);
    expect(section).toMatch(/survives? a \*?\*?lost\*?\*? sortie|survives? (?:a )?los(?:s|t)/i);
    expect(section).toMatch(/weapon itself is spent/i);
  });

  it('the consumeDeployedShip doc comment states the retention rule', () => {
    const comment = docCommentFor(
      HANGAR_ECONOMY,
      'Spends the exact ship a deployment flew',
    );
    expect(comment.trim().length).toBeGreaterThan(200);
    expect(comment).toMatch(/ownership only/i);
    expect(comment).toMatch(/retained|surviv/i);
    expect(comment).toMatch(/weaponLevels/);
    expect(comment).toMatch(/powerUpLevels/);
    expect(comment).toMatch(/re-buy|re-purchas|repurchase/i);
  });

  it('the captureCycle module comment states the retention rule', () => {
    const comment = docCommentFor(
      CAPTURE_CYCLE,
      'The flown ship is a one-battle consumable',
    );
    expect(comment.trim().length).toBeGreaterThan(200);
    expect(comment).toMatch(/ownership only/i);
    expect(comment).toMatch(/retained|surviv/i);
    expect(comment).toMatch(/weaponLevels/);
    expect(comment).toMatch(/powerUpLevels/);
  });
});

describe('every consumption surface states the ownership-only rule', () => {
  it.each(CONSUMPTION_SURFACES)(
    '%s states that a battle spends ownership only',
    (_name, source) => {
      expect(source).toMatch(/ownership only/i);
    },
  );
});

describe('no consumption surface still claims a spent ship deletes bought levels', () => {
  it.each(CONSUMPTION_SURFACES)(
    '%s carries no unqualified level-deletion claim',
    (_name, source) => {
      const stale: string[] = [];
      for (const sentence of sentences(source)) {
        for (const [label, pattern] of RETIRED_CONSUMPTION_CLAIMS) {
          if (!pattern.test(sentence)) continue;
          // A sentence that also states the retention rule is the documented
          // contrast, not the retired claim.
          if (RETENTION_MARKERS.test(sentence)) continue;
          stale.push(`${label}: ${sentence.slice(0, 160)}`);
        }
      }
      expect(stale).toEqual([]);
    },
  );
});
