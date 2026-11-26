/**
 * Docs guard for the player mineral pickup chime (AH-0MWNMRER0009385Y).
 *
 * The chime is only documented correctly if the prose an author edits names the
 * shipped cue, recipe, seed and tuning constants. This is a deliberate docs
 * grep (the `src/audio/*.docs.test.ts` precedent) so a later doc edit cannot
 * silently drop the entry or quote a retuned constant:
 *
 * - both `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` tables carry the cue/recipe row
 *   with the reserved seed, and the cue is filed as a **player** pickup cue
 *   (never an enemy cue);
 * - the baked recipe is tagged player/mineral/pickup with no enemy tag and its
 *   seed is the next free game seed;
 * - GDD §7.3 lists the quiet chime (≤ 0.2 peak, A-minor ladder, 1.5 s reset)
 *   and the mineral Collection material (§4.4.1) plus §4.5 record the audible
 *   pickup feedback;
 * - the README names the cue and the single shared dispatch;
 * - the values quoted in prose are the ones exported by
 *   `src/audio/mineralChime.ts` (not a stale copy).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CUE_MANIFEST } from './cueManifest';
import {
  MINERAL_CHIME_RESET_GAP_MS,
  MINERAL_CHIME_SEMITONES,
} from './mineralChime';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const CUE = 'playMineralCollectChimeSound';
const RECIPE = 'aihell-mineral-chime';

/** The reserved seed for the cue (next free game seed after 32291). */
const SEED = 32292;

/** The cue-mapping table row, or `undefined` when no row exists. */
function cueMappingRow(doc: string): string | undefined {
  return doc
    .split('\n')
    .find((line) => line.startsWith(`| \`${CUE}\``));
}

describe('mineral pickup chime documentation (AH-0MWNMRER0009385Y)', () => {
  it('is one dedicated baked cue with the reserved seed, not the UFO tinkle', () => {
    const entry = CUE_MANIFEST.find((candidate) => candidate.cue === CUE);
    const tinkle = CUE_MANIFEST.find(
      (candidate) => candidate.cue === 'playMineralTinkleSound',
    );

    expect(entry?.recipe).toBe(RECIPE);
    expect(entry?.delivery).toBe('baked');
    expect(entry?.seeds).toEqual([SEED]);
    // Sharing the spill cue would make a pickup indistinguishable from a spill.
    expect(entry?.recipe).not.toBe(tinkle?.recipe);
    expect(entry?.seeds).not.toEqual(tinkle?.seeds);
  });

  it('is filed as a player pickup cue in the recipe, never an enemy cue', () => {
    const recipe = read(`audio/toneforge/recipes/${RECIPE}.yaml`);
    const tags = recipe.match(/tags:\n((?:\s+- .+\n)+)/)?.[1] ?? '';
    expect(tags).toMatch(/- player/);
    expect(tags).toMatch(/- mineral/);
    expect(tags).toMatch(/- pickup/);
    expect(tags).not.toMatch(/- enemy/);
    // The enemy-balance catalogue analyses enemy cues only: a player cue must
    // never be filed there.
    expect(read('docs/AUDIO_ENEMY_BALANCE.md')).not.toContain(RECIPE);
  });

  it('records the cue in both AUDIO_TONEFORGE_CUE_MAPPING tables', () => {
    const doc = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');

    // Cue → recipe mapping table row (cue, character, trigger, seam, disp.,
    // recipe).
    const row = cueMappingRow(doc);
    expect(row, `no \`${CUE}\` row in the cue-to-recipe table`).toBeDefined();
    expect(row).toMatch(/mineral pickup/i);
    expect(row).toMatch(/player/i);
    expect(row).toContain(`\`${RECIPE}\``);
    expect(row).toMatch(/\| new \|/);
    expect(row).toMatch(/≤ 0\.2/);

    // New-recipes table row (recipe, cue, character, seed).
    expect(doc).toMatch(
      new RegExp(
        `\\| \`${RECIPE}\` \\| \`${CUE}\`[^\\n]*\\| ${SEED} \\|`,
      ),
    );
    // The seed block prose must not claim a maximum below the newest seed
    // (bumped to 32294 by the hex-matchup impact pair, AH-0MWL88YYO0053DWH).
    expect(doc).toMatch(/live game seeds now run to \*\*32294\*\*/);
  });

  it('GDD §7.3 lists the quiet chime with its ladder and reset gap', () => {
    const gdd = read('docs/Game Design Document.md');
    const catalog = gdd.slice(
      gdd.indexOf('#### SFX Event Catalog'),
      gdd.indexOf('#### SFX mix trim'),
    );
    const row = catalog
      .split('\n')
      .find((line) => /^\|.*Mineral pickup/.test(line));
    expect(row, 'no mineral pickup row in the §7.3 catalogue').toBeDefined();
    expect(row).toContain(`playMineralCollectChimeSound()`);
    expect(row).toContain(`\`${RECIPE}\``);
    expect(row).toMatch(/≤ 0\.2/);
    expect(row).toMatch(/A-minor/i);
    expect(row).toMatch(/one octave|octave cap/i);
    expect(row).toContain('MINERAL_CHIME_RESET_GAP_MS');
    expect(row).toMatch(/1\.5 s/);
    expect(row).toMatch(/game time/i);
  });

  it('GDD collection material records the audible pickup feedback', () => {
    const gdd = read('docs/Game Design Document.md');
    const section = gdd.slice(
      gdd.indexOf('#### 4.4.1 Minerals'),
      gdd.indexOf('#### 4.4.2'),
    );
    expect(section).not.toBe('');
    expect(section).toContain(`playMineralCollectChimeSound()`);
    expect(section).toContain(`\`${RECIPE}\``);
    expect(section).toContain('MINERAL_CHIME_SEMITONES');
    expect(section).toContain(
      `[${MINERAL_CHIME_SEMITONES.join(', ')}]`,
    );
    expect(section).toContain('MINERAL_CHIME_RESET_GAP_MS');
    expect(section).toContain(String(MINERAL_CHIME_RESET_GAP_MS));
    expect(section).toMatch(/game time/i);
    expect(section).toContain('aihell-mineral-tinkle');

    // §4.5 is the scoring/collection material named by the acceptance
    // criterion: the pickup awards no points but is audibly confirmed.
    const scoring = gdd.slice(
      gdd.indexOf('### 4.5 Scoring System'),
      gdd.indexOf('### 4.6'),
    );
    expect(scoring).toMatch(/mineral pickup/i);
    expect(scoring).toContain(`playMineralCollectChimeSound()`);
  });

  it('README names the cue, the recipe and the single shared dispatch', () => {
    const readme = read('README.md');
    expect(readme).toContain(CUE);
    expect(readme).toContain(RECIPE);
    // One shared dispatch in the combat core — gym↔game parity.
    expect(readme).toContain('noteMineralCollected');
    expect(readme).toContain('MINERAL_CHIME_RESET_GAP_MS');
  });

  it('quotes the shipped tuning constants exactly', () => {
    const gdd = read('docs/Game Design Document.md');
    const mapping = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');
    // The ladder and reset gap in prose are the exported values.
    expect(gdd).toContain(`[${MINERAL_CHIME_SEMITONES.join(', ')}]`);
    expect(gdd).toContain(String(MINERAL_CHIME_RESET_GAP_MS));
    expect(mapping).toContain(`[${MINERAL_CHIME_SEMITONES.join(', ')}]`);
    expect(mapping).toContain('MINERAL_CHIME_RESET_GAP_MS');
  });
});
