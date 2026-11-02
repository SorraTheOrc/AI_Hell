/**
 * Heavy Slug feel package — docs & heaviest/not-a-Mortar guard
 * (AH-0MVV0WO4M001KEDG).
 *
 * The Heavy Slug is the catalogue's heaviest round — one huge, slow, deep-red
 * `heavy-shell` per shot. It shipped silhouette-only, like the other
 * unlock-pool weapons. This guard pins the parts of its completed feel package
 * that are not observable through the scene seams:
 *
 * - both cues are baked manifest entries with their reserved seeds
 *   (32285 fire / 32286 impact) and are distinct recipes/assets from the
 *   Mortar's pair (no aliasing of the detonation boom or the dry impact crack),
 * - the fire recipe is the **heaviest single-shot** cue — a low 60–130 Hz
 *   fundamental, a metallic clank transient and the longest decay of the
 *   packaged weapons (≈ 0.24–0.30 s) — with the documented **assertion proxy**
 *   being its lowest oscillator start frequency, compared against the Cannon's
 *   and the Mortar's fire cues,
 * - the fire recipe documents its deliberate contrast with
 *   `aihell-mortar-detonation` (metallic clank + shorter sustain),
 * - the impact recipe is a dull red thud with debris noise at or under 0.16 s,
 *   distinct from `aihell-mortar-impact`'s bright dry crack,
 * - `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` carries **both** tables' rows,
 * - `audio/toneforge/README.md` reserves both seeds,
 * - the GDD §4.4 net-new-weapon note and §7.3 cue table record the launch,
 *   fire and impact identity, and the README names the cues rather than
 *   leaving the weapon silhouette-only.
 *
 * Behavioural coverage lives in `effects.test.ts` (dispatch/assets),
 * `weapons.test.ts` (metadata/no-balance-change + catalogue-largest radius),
 * `weaponLevels.test.ts` (level survival), `CombatScene.test.ts` (impact seam)
 * and `CombatCoreScene.test.ts` (exactly one muzzle flash per shot input).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CUE_MANIFEST } from './cueManifest';
import * as effects from './effects';
import { WEAPON_CATALOGUE } from '../utils/weapons';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const FIRE_CUE = 'playHeavySlugFireSound';
const IMPACT_CUE = 'playHeavySlugImpactSound';
const FIRE_RECIPE = 'aihell-heavy-slug-fire';
const IMPACT_RECIPE = 'aihell-heavy-slug-impact';

/**
 * The declared duration of a recipe (seconds). Used as the proxy for the
 * "longest decay of the packaged weapons" (fire) and the ≤ 0.16 s impact
 * ceiling.
 */
function durationSeconds(recipe: string): number {
  const match = recipe.match(/^\s*duration: ([\d.]+)/m);
  if (!match) throw new Error('recipe has no duration');
  return Number(match[1]);
}

/**
 * Every oscillator node's **start frequency** in a recipe, via its
 * `params.frequency` (which is the `kind: set … value:` automation start for
 * every oscillator in the catalogue). This is the documented, machine-checkable
 * proxy for the shot's **fundamental**: the lowest start frequency across the
 * recipe is the deepest body tone the cue carries.
 */
function oscillatorStartFrequencies(recipe: string): number[] {
  const starts: number[] = [];
  // Match oscillator node blocks: `kind: oscillator` then `frequency: <n>`.
  const blockRe = /kind: oscillator[\s\S]*?frequency: ([\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(recipe)) !== null) {
    starts.push(Number(match[1]));
  }
  return starts;
}

/** The recipe's lowest fundamental (start frequency) — the documented proxy. */
function lowestFundamental(recipe: string): number {
  const starts = oscillatorStartFrequencies(recipe);
  if (starts.length === 0) throw new Error('recipe has no oscillator');
  return Math.min(...starts);
}

describe('Heavy Slug feel package — audio catalogue', () => {
  it('bakes both cues with their reserved seeds', () => {
    const fire = CUE_MANIFEST.find((entry) => entry.cue === FIRE_CUE);
    const impact = CUE_MANIFEST.find((entry) => entry.cue === IMPACT_CUE);
    expect(fire?.recipe).toBe(FIRE_RECIPE);
    expect(fire?.delivery).toBe('baked');
    expect(fire?.seeds).toEqual([32285]);
    expect(impact?.recipe).toBe(IMPACT_RECIPE);
    expect(impact?.delivery).toBe('baked');
    expect(impact?.seeds).toEqual([32286]);
  });

  it('exports both cues and dispatches fire/impact through the shared seams', () => {
    expect(typeof effects.playHeavySlugFireSound).toBe('function');
    expect(typeof effects.playHeavySlugImpactSound).toBe('function');
    // The definition's impact metadata names the exported cue, and the cue
    // resolves through the shared registry (proven behaviourally in
    // `effects.test.ts`).
    expect(WEAPON_CATALOGUE.heavy_slug.impactFx?.cue).toBe(IMPACT_CUE);
  });

  it('is a different asset from the Mortar — no detonation/impact aliasing', () => {
    const fire = CUE_MANIFEST.find((entry) => entry.cue === FIRE_CUE)!;
    const impact = CUE_MANIFEST.find((entry) => entry.cue === IMPACT_CUE)!;
    const mortarDetonation = CUE_MANIFEST.find(
      (entry) => entry.cue === 'playMortarDetonationSound',
    )!;
    const mortarImpact = CUE_MANIFEST.find(
      (entry) => entry.cue === 'playMortarImpactSound',
    )!;
    expect(fire.recipe).not.toBe(mortarDetonation.recipe);
    expect(impact.recipe).not.toBe(mortarImpact.recipe);
    expect(fire.seeds).not.toEqual(mortarDetonation.seeds);
    expect(impact.seeds).not.toEqual(mortarImpact.seeds);

    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    const detonationRecipe = read(
      'audio/toneforge/recipes/aihell-mortar-detonation.yaml',
    );
    // The heavy launch differentiates itself with a **metallic clank**
    // transient the detonation lacks: a square oscillator in the fire recipe,
    // and none in the detonation wash.
    expect(fireRecipe).toContain('type: square');
    expect(detonationRecipe).not.toContain('type: square');
    // …and a **shorter sustain** than the 0.32 s detonation boom.
    expect(durationSeconds(fireRecipe)).toBeLessThan(
      durationSeconds(detonationRecipe),
    );
    // Both differentiators are documented next to the values so the contrast
    // cannot drift out of the recipe.
    expect(fireRecipe).toContain('metallic clank');
    expect(fireRecipe).toContain('shorter sustain');
    expect(fireRecipe).toContain('aihell-mortar-detonation');
  });

  it('is the heaviest, lowest-pitched shot — the longest decay of the packaged weapons', () => {
    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    // The brief's 0.24–0.30 s decay window: the longest of the packaged
    // weapons (Cannon 0.08 / Railgun 0.20 / Shard Swarm 0.15 / Rear Guard
    // 0.14 / Broadside 0.16).
    const fireDuration = durationSeconds(fireRecipe);
    expect(fireDuration).toBeGreaterThanOrEqual(0.24);
    expect(fireDuration).toBeLessThanOrEqual(0.3);

    // Documented assertion proxy: the lowest oscillator start frequency is
    // the deepest fundamental in the cue. It must sit in the brief's
    // ≈ 60–130 Hz band and be lower than both the Cannon's and the Mortar's
    // fire cues it is compared against.
    const fundamental = lowestFundamental(fireRecipe);
    expect(fundamental).toBeGreaterThanOrEqual(60);
    expect(fundamental).toBeLessThanOrEqual(130);
    expect(fundamental).toBeLessThan(
      lowestFundamental(read('audio/toneforge/recipes/aihell-cannon-fire.yaml')),
    );
    expect(fundamental).toBeLessThan(
      lowestFundamental(read('audio/toneforge/recipes/aihell-mortar-fire.yaml')),
    );
    // The band is called out in the recipe so a sound designer sees the intent.
    expect(fireRecipe).toContain('60–130 Hz');
  });

  it('keeps the impact a dull red thud with debris at or under 0.16 s', () => {
    const impactRecipe = read(`audio/toneforge/recipes/${IMPACT_RECIPE}.yaml`);
    const impactDuration = durationSeconds(impactRecipe);
    expect(impactDuration).toBeGreaterThan(0);
    expect(impactDuration).toBeLessThanOrEqual(0.16);
    // Dull and low — far below the Mortar impact's bright 900 Hz dry crack.
    expect(lowestFundamental(impactRecipe)).toBeLessThan(
      lowestFundamental(read('audio/toneforge/recipes/aihell-mortar-impact.yaml')),
    );
    // A thud with debris noise, not a second shell crack: no square edge, and
    // the contrast with `aihell-mortar-impact` is documented in the recipe.
    expect(impactRecipe).not.toContain('type: square');
    expect(impactRecipe).toContain('kind: noise');
    expect(impactRecipe).toContain('aihell-mortar-impact');
    expect(impactRecipe).toContain('dull');
  });
});

describe('Heavy Slug feel package — documentation', () => {
  it('records both cues in both AUDIO_TONEFORGE_CUE_MAPPING tables', () => {
    const doc = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');
    // Cue → disposition table rows.
    expect(doc).toContain(`| \`${FIRE_CUE}\``);
    expect(doc).toContain(`| \`${IMPACT_CUE}\``);
    // Recipe → seed table rows, with the reserved seeds.
    expect(doc).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32285 \\|`),
    );
    expect(doc).toMatch(
      new RegExp(`\\| \`${IMPACT_RECIPE}\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32286 \\|`),
    );
  });

  it('reserves both seeds in the ToneForge README table', () => {
    const readme = read('audio/toneforge/README.md');
    expect(readme).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\\.yaml\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32285 \\|`),
    );
    expect(readme).toMatch(
      new RegExp(
        `\\| \`${IMPACT_RECIPE}\\.yaml\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32286 \\|`,
      ),
    );
  });

  it('records the launch/fire/impact identity in the GDD net-new-weapon note and §7.3', () => {
    const gdd = read('docs/Game Design Document.md');
    // §4.4 net-new-weapon audio note names both cues and both seeds.
    expect(gdd).toContain(FIRE_CUE);
    expect(gdd).toContain(IMPACT_CUE);
    expect(gdd).toContain('32285');
    expect(gdd).toContain('32286');
    // §7.3 cue table carries all three Heavy Slug rows (launch, fire, impact).
    expect(gdd).toContain('| Heavy Slug launch flash |');
    expect(gdd).toContain('| Heavy Slug fire |');
    expect(gdd).toContain('| Heavy Slug impact |');
  });

  it('names the Heavy Slug cues in the README weapon/audio note', () => {
    const readme = read('README.md');
    expect(readme).toContain(FIRE_CUE);
    expect(readme).toContain(IMPACT_CUE);
    expect(readme).toContain(FIRE_RECIPE);
    expect(readme).toContain(IMPACT_RECIPE);
  });
});
