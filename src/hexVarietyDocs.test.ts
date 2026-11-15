/**
 * Docs↔code consistency guard for the **hex variety** axes
 * (AH-0MWEW5QCR009NX0V, part of the post-MVP hex-variety epic
 * AH-0MVWZYQN8007SXIG).
 *
 * The three variety axes are shipped behaviour, so the documents of record must
 * describe them and must not drift from the code that implements them. This is
 * the automated check the docs item asks for: for each documented claim it
 * asserts the evidence **in the named section** of the named document, and that
 * the module the document points at actually exists on disk. A future edit that
 * deletes a shipped statement — or moves a module — fails here rather than
 * silently leaving the docs lying about the game.
 *
 * It deliberately asserts *evidence*, not prose: a claim is satisfied by the
 * identifiers the code and the docs genuinely share (`resolveHexGrant`,
 * `FORTRESS_CAPTURE_PASSES`, `src/scenes/core/hexPersonalityMechanics.ts`, …),
 * so wording can be improved without breaking the guard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** Reads a repo file as text (the docs are not imported as modules). */
function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * The text between `startHeading` and the next heading of the same depth.
 *
 * The local `doc` name (not the DOM global's spelling) keeps this file in the
 * fast `unit` project: the suite split classifies any test that touches a DOM
 * global as an integration test.
 */
function section(doc: string, startHeading: string): string {
  const start = doc.indexOf(startHeading);
  expect(start, `${startHeading} exists`).toBeGreaterThanOrEqual(0);
  const rest = doc.slice(start + startHeading.length);
  const next = rest.search(new RegExp(`\\n#{1,${startHeading.match(/^#+/)?.[0].length ?? 1}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

/** Each documented claim: where it lives, and the evidence it must contain. */
interface DocClaim {
  /** Human label naming the claim (used in the failure message). */
  readonly label: string;
  /** Document that must carry the claim. */
  readonly docPath: string;
  /** Section of that document (a heading line, matched exactly once). */
  readonly section: string;
  /** Evidence patterns the section must contain. */
  readonly evidence: readonly RegExp[];
}

const GDD = 'docs/Game Design Document.md';
const GYM_PARITY = 'docs/GYM_PARITY.md';
const OUTER_LOOP = 'docs/OUTER_LOOP_CANDIDATES.md';
const README = 'README.md';

const CLAIMS: readonly DocClaim[] = [
  {
    label: 'GDD §8.2 documents personalities, contracts and landmarks as authored data',
    docPath: GDD,
    section: '#### Hex variety: personalities, contracts and ring landmarks (post-MVP)',
    evidence: [
      /personality/,
      /contract/,
      /landmark/,
      /src\/scenes\/core\/hexPersonalityMechanics\.ts/,
      /FORTRESS_CAPTURE_PASSES/,
      /bankSalvage/,
      /known-ahead intel/,
    ],
  },
  {
    label: 'OUTER_LOOP Candidate D records hex variety as implemented',
    docPath: OUTER_LOOP,
    section: '- **Hex variety** — per-hex personalities, contracts and ring landmarks:',
    evidence: [/implemented/, /nebula/, /summoner/, /choice/],
  },
  {
    label: 'GYM_PARITY records the hex-map intel and capture resolution',
    docPath: GYM_PARITY,
    section: '| `GymHexWar` |',
    evidence: [
      /resolveHexCapture/,
      /personality/,
      /contract/,
      /landmark/,
    ],
  },
  {
    label: 'GYM_PARITY records the two personality mechanics through GymMiniBoss',
    docPath: GYM_PARITY,
    section: '| `GymMiniBoss` |',
    evidence: [
      /hexPersonalityMechanics\.ts/,
      /MiniBossConfig\.minions/,
      /nebula/,
      /summoner/,
    ],
  },
  {
    label: 'README names the hex-variety pass and where the mechanics live',
    docPath: README,
    section: '> **Outer loop — Candidate D chosen and shipped**',
    evidence: [/hex variety/, /hexPersonalityMechanics\.ts/, /ai_hell_hangar_war/],
  },
];

describe('hex-variety docs↔code consistency (AH-0MWEW5QCR009NX0V)', () => {
  it.each(CLAIMS)('$label', (claim) => {
    const text = section(readRepoFile(claim.docPath), claim.section);
    for (const pattern of claim.evidence) {
      expect(text, `${claim.docPath} ${claim.section} must contain ${pattern}`).toMatch(
        pattern,
      );
    }
  });

  it('names modules, constants and seams that exist in the shipped code', () => {
    // Every identifier the docs point at is real: a renamed module would fail
    // here instead of leaving the docs describing code that no longer exists.
    const files = [
      'src/scenes/core/hexPersonalityMechanics.ts',
      'src/core/hangarWar/hexRing.ts',
      'src/core/hangarWar/hexBoss.ts',
      'src/core/hangarWar/hexIntel.ts',
      'src/core/hangarWar/captureCycle.ts',
      'src/core/hangarWar/hangarWarStore.ts',
      'src/core/hangarWar/__fixtures__/ringFixtures.ts',
      'src/scenes/gym/GymHexWar.ts',
      'src/scenes/gym/GymMiniBoss.ts',
      'src/waves/miniBossDesigns.ts',
    ];
    for (const file of files) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} exists`).toBe(true);
    }

    const sharedCore = readRepoFile('src/scenes/core/hexPersonalityMechanics.ts');
    for (const symbol of [
      'HEX_PERSONALITY_MECHANIC_SET',
      'NEBULA_PROJECTILE_DRAG',
      'SUMMONER_REINFORCEMENTS',
    ]) {
      expect(sharedCore, `${symbol} is published`).toContain(symbol);
    }

    // The parity matrix's rows must cover every gym scene this epic touched.
    const parity = readRepoFile(GYM_PARITY);
    for (const gym of ['GymHexWar', 'GymMiniBoss', 'GymHangar', 'GymBoss']) {
      expect(parity, `${gym} has a parity row`).toContain(`| \`${gym}\` |`);
      expect(
        fs.existsSync(path.join(ROOT, 'src/scenes/gym', `${gym}.ts`)),
        `${gym}.ts exists`,
      ).toBe(true);
    }
  });
});
