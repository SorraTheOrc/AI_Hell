/**
 * Docs guard for the bundled level backgrounds, their provenance and their
 * tuning (AH-0MVSEC4RS003KQGV; parent AH-0MVIB7PD50029ZY1, covers the
 * documentation half of parent AC6).
 *
 * Like the sibling `*Docs.test.ts` guards this is a deliberate docs grep: the
 * deliverable of this item *is* documentation (README credits, GDD §3.2/§7.1,
 * the enemy-guide §5.1 parity note), so the guard fails if that text is
 * removed or drifts from the code. It does not re-test background behaviour —
 * the mapping, layer, warp and gym-parity behaviour are covered by
 * `src/data/backgrounds.test.ts`, `src/scenes/core/backgroundLayer.test.ts`,
 * `src/vfx/backgroundWarp.test.ts` and
 * `src/scenes/gym/backgroundParity.test.ts`.
 *
 * The documented values are imported from the live modules (the sibling docs
 * guards' pattern), so a code change fails the doc instead of silently
 * diverging — exactly the drift this item exists to prevent.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BACKGROUND_DEPTH,
  BACKGROUND_DIM_ALPHA,
  BACKGROUND_DIM_DEPTH,
  GAME_BACKGROUND_COLOR,
  LEVEL_TRANSITION_SECONDS,
} from './core/constants';
import {
  BACKGROUND_TEXTURE_KEYS,
  LEVEL_BACKGROUND_MANIFEST,
} from './data/backgrounds';
import { WEAPON_UPGRADE_SPECS } from './utils/weaponLevels';

const README_PATH = path.resolve(process.cwd(), 'README.md');
const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const ENEMY_GUIDE_PATH = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);
const ATTRIBUTION_PATH = path.resolve(
  process.cwd(),
  'public/assets/backgrounds/ATTRIBUTION.md',
);

/** NASA media-usage guidance; the one URL every credits surface must share. */
const NASA_MEDIA_USAGE_URL =
  'https://www.nasa.gov/nasa-brand-center/images-and-media/';

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

/**
 * The body of a markdown section, from `heading` up to (not including) the
 * next heading of the same or a higher level.
 *
 * Asserting inside the named section rather than anywhere in the file stops an
 * unrelated mention from satisfying the guard, while a deeper heading (e.g. a
 * `####` subsection inside `### 3.2`) stays part of its parent section.
 */
function sectionOf(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start === -1) return '';
  const level = /^#+/.exec(heading)?.[0].length ?? 1;
  const rest = doc.slice(start + heading.length);
  const next = rest.search(new RegExp(`\\n#{1,${level}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

describe('Level background documentation (AH-0MVSEC4RS003KQGV)', () => {
  const readme = read(README_PATH);
  const gdd = read(GDD_PATH);
  const enemyGuide = read(ENEMY_GUIDE_PATH);
  const attribution = read(ATTRIBUTION_PATH);

  it('README has an assets/credits subsection covering licence, budgets and bundling (AC1)', () => {
    const credits = sectionOf(readme, '## Assets and credits');
    expect(credits).not.toBe('');

    // The bundled directory and the canonical credits file are linked.
    expect(credits).toContain('public/assets/backgrounds/');
    expect(credits).toMatch(
      /\[[^\]]*ATTRIBUTION\.md[^\]]*\]\(public\/assets\/backgrounds\/ATTRIBUTION\.md\)/,
    );

    // Licence position, shared verbatim with ATTRIBUTION.md and the GDD.
    expect(credits).toMatch(/NASA public domain/);
    expect(credits).toContain(NASA_MEDIA_USAGE_URL);

    // Compression/resolution policy.
    expect(credits).toContain('1920×1080');
    expect(credits).toContain('5 MB');

    // Bundled, never fetched at runtime.
    expect(credits).toMatch(/bundled/i);
    expect(credits).toMatch(/never fetched at runtime/i);
  });

  it('GDD §3.2 names every campaign level and its background mapping (AC2)', () => {
    const levelProgression = sectionOf(
      gdd,
      '### 3.2 Level Progression Overview',
    );
    expect(levelProgression).not.toBe('');

    // The manifest is the source of truth: every level the game plays must be
    // named together with its deterministic background key.
    expect(LEVEL_BACKGROUND_MANIFEST).toHaveLength(10);
    for (const entry of LEVEL_BACKGROUND_MANIFEST) {
      expect(levelProgression).toContain(entry.themeName);
      expect(levelProgression).toContain(entry.textureKey);
      expect(BACKGROUND_TEXTURE_KEYS).toContain(entry.textureKey);
    }
  });

  it('GDD §7.1 documents the backdrop, its dimming, non-interactivity and the warp timing (AC2)', () => {
    const palette = sectionOf(gdd, '### 7.1 Color Palette');
    expect(palette).not.toBe('');

    // Layer depths and the readability dim overlay, straight from the code.
    expect(palette).toContain(String(BACKGROUND_DEPTH));
    expect(palette).toContain(String(BACKGROUND_DIM_DEPTH));
    expect(palette).toContain(String(BACKGROUND_DIM_ALPHA));
    expect(palette).toMatch(/dim overlay/i);

    // The backdrop can never eat input.
    expect(palette).toMatch(/non-interactive/i);

    // The warp rides the existing level-change pause.
    expect(palette).toMatch(/hyperspace warp/i);
    expect(palette).toContain(String(LEVEL_TRANSITION_SECONDS));

    // Readability rule that keeps neon bullets legible over a photo. The
    // ceiling is read from the shipped spec so a bullet-size retune cannot
    // leave the aesthetic rule quoting a stale multiple
    // (AH-0MVWAVL6R001UI60).
    expect(palette).toContain(
      `${WEAPON_UPGRADE_SPECS.bulletSize.cap.toFixed(1)}×`,
    );

    // The stale near-black row is replaced by the actual fallback colour.
    expect(palette).not.toContain('#0a0a0a');
    expect(palette).toContain(GAME_BACKGROUND_COLOR);
    expect(palette).toContain('GAME_BACKGROUND_COLOR');
    expect(palette).toMatch(/fallback/i);

    // Credits cross-link, so the licence travels with the palette section.
    expect(palette).toMatch(/ATTRIBUTION\.md/);
  });

  it('enemy guide §5.1 records the shared background layer and the gym decision (AC3)', () => {
    const parity = sectionOf(enemyGuide, '### 5.1 Gym parity');
    expect(parity).not.toBe('');

    // Shared core code, named once.
    expect(parity).toContain('src/scenes/core/backgroundLayer.ts');
    expect(parity).toContain('createBackgroundLayer');
    expect(parity).toContain('CombatCoreScene');
    expect(parity).toContain('src/scenes/gym/core/gymBackground.ts');
    expect(parity).toContain('GYM_BACKGROUNDS_ENABLED');

    // The parity slice's decision: adopt the layer, pin level 1, no warp.
    expect(parity).toContain('AH-0MVSEC0J0004YNJC');
    expect(parity).toMatch(/level[- ]1/);
    expect(parity).toMatch(/never swaps or warps|no warp/i);
  });

  it('attribution, README and GDD agree on the licence and the NASA guidelines URL (AC5)', () => {
    for (const [surface, text] of [
      ['ATTRIBUTION.md', attribution],
      ['README.md', readme],
      ['Game Design Document.md', gdd],
    ] as const) {
      expect(text, `${surface} must name the licence`).toMatch(
        /NASA public domain/,
      );
      expect(text, `${surface} must cite the NASA guidelines`).toContain(
        NASA_MEDIA_USAGE_URL,
      );
    }
  });
});
