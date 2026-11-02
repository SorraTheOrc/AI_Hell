/**
 * Rear Guard feel package — docs & distinctness guard (AH-0MVV0WN96007TU9J).
 *
 * The Rear Guard shipped silent: no launch cue, no muzzle flash and only the
 * generic warm-white impact flash. This guard pins the documentation side of
 * its completed feel package and, above all, the acceptance criterion that the
 * cues are **audibly distinguishable from the Cannon's** so the backward shot
 * is identifiable by ear:
 *
 * - both cues are baked manifest entries with their reserved seeds
 *   (32281 fire / 32282 impact) and are distinct recipes/assets from the
 *   Cannon's pair,
 * - the fire recipe documents (comment + meta tags) and *asserts* a lower
 *   fundamental, a lower low-pass cutoff and no square click than the Cannon's
 *   — a machine-checkable proxy for "darker and more muffled"; the impact
 *   recipe is a distinct, shorter and softer recipe than the Cannon's,
 * - `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` carries **both** tables' rows,
 * - `audio/toneforge/README.md` reserves both seeds,
 * - the GDD §4.4 net-new-weapon note and §7.3 cue table record the fire and
 *   impact identity, and the README names the cues rather than leaving the
 *   weapon silhouette-only.
 *
 * Behavioural coverage lives in `effects.test.ts` (dispatch/assets),
 * `weapons.test.ts` (metadata/no-balance-change), `weaponLevels.test.ts`
 * (level survival), `CombatScene.test.ts` (impact seam) and
 * `CombatCoreScene.test.ts` (muzzle flash through the shared core).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CUE_MANIFEST } from './cueManifest';
import * as effects from './effects';
import { WEAPON_CATALOGUE } from '../utils/weapons';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const FIRE_CUE = 'playRearGuardFireSound';
const IMPACT_CUE = 'playRearGuardImpactSound';
const FIRE_RECIPE = 'aihell-rear-guard-fire';
const IMPACT_RECIPE = 'aihell-rear-guard-impact';

/**
 * The first oscillator's start frequency — the recipe's fundamental by
 * construction. Authored recipes list `type` then `frequency` under `params`,
 * so this reads the leading pitched voice without a YAML dependency.
 */
function leadingOscillatorHz(recipe: string): number {
  const match = recipe.match(
    /kind: oscillator\s*\n\s*params:\s*\n\s*type: [a-z]+\s*\n\s*frequency: ([\d.]+)/,
  );
  if (!match) throw new Error('recipe has no leading oscillator');
  return Number(match[1]);
}

/** Every low-pass cutoff declared by the recipe (empty when unfiltered). */
function lowpassCutoffsHz(recipe: string): number[] {
  return [...recipe.matchAll(/type: lowpass\s*\n\s*frequency: ([\d.]+)/g)].map(
    (match) => Number(match[1]),
  );
}

/** The recipe's declared duration. */
function durationSeconds(recipe: string): number {
  const match = recipe.match(/^\s*duration: ([\d.]+)/m);
  if (!match) throw new Error('recipe has no duration');
  return Number(match[1]);
}

/** The first gain stage's value — the leading voice's level (a softness proxy). */
function firstGainValue(recipe: string): number {
  const match = recipe.match(/^\s*gain: ([\d.]+)/m);
  if (!match) throw new Error('recipe has no gain stage');
  return Number(match[1]);
}

describe('Rear Guard feel package — audio catalogue', () => {
  it('bakes both cues with their reserved seeds', () => {
    const fire = CUE_MANIFEST.find((entry) => entry.cue === FIRE_CUE);
    const impact = CUE_MANIFEST.find((entry) => entry.cue === IMPACT_CUE);
    expect(fire?.recipe).toBe(FIRE_RECIPE);
    expect(fire?.delivery).toBe('baked');
    expect(fire?.seeds).toEqual([32281]);
    expect(impact?.recipe).toBe(IMPACT_RECIPE);
    expect(impact?.delivery).toBe('baked');
    expect(impact?.seeds).toEqual([32282]);
  });

  it('exports both cues and dispatches fire/impact through the shared seams', () => {
    expect(typeof effects.playRearGuardFireSound).toBe('function');
    expect(typeof effects.playRearGuardImpactSound).toBe('function');
    // The definition's impact metadata names the exported cue, and the cue
    // resolves through the shared registry (proven behaviourally in
    // `effects.test.ts`).
    expect(WEAPON_CATALOGUE.rear_guard.impactFx?.cue).toBe(IMPACT_CUE);
  });

  it('is audibly distinct from the Cannon — darker, more muffled and not a square click', () => {
    const fire = CUE_MANIFEST.find((entry) => entry.cue === FIRE_CUE)!;
    const impact = CUE_MANIFEST.find((entry) => entry.cue === IMPACT_CUE)!;
    const cannonFire = CUE_MANIFEST.find(
      (entry) => entry.cue === 'playCannonFireSound',
    )!;
    const cannonImpact = CUE_MANIFEST.find(
      (entry) => entry.cue === 'playCannonImpactSound',
    )!;
    expect(fire.recipe).not.toBe(cannonFire.recipe);
    expect(impact.recipe).not.toBe(cannonImpact.recipe);
    expect(fire.seeds).not.toEqual(cannonFire.seeds);
    expect(impact.seeds).not.toEqual(cannonImpact.seeds);

    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    const impactRecipe = read(`audio/toneforge/recipes/${IMPACT_RECIPE}.yaml`);
    const cannonFireRecipe = read('audio/toneforge/recipes/aihell-cannon-fire.yaml');
    const cannonImpactRecipe = read('audio/toneforge/recipes/aihell-cannon-impact.yaml');

    // A lower fundamental than the Cannon's 800 Hz square.
    const cannonFundamental = leadingOscillatorHz(cannonFireRecipe);
    expect(cannonFundamental).toBe(800);
    expect(leadingOscillatorHz(fireRecipe)).toBeLessThan(cannonFundamental);

    // A lower low-pass cutoff than the Cannon's. The Cannon recipe is
    // unfiltered, so its 800 Hz fundamental is its brightest partial; any
    // cutoff below that is necessarily darker, and the Rear Guard is
    // explicitly low-passed.
    const rearCutoffs = lowpassCutoffsHz(fireRecipe);
    expect(rearCutoffs.length).toBeGreaterThan(0);
    expect(Math.min(...rearCutoffs)).toBeLessThan(cannonFundamental);
    expect(lowpassCutoffsHz(cannonFireRecipe)).toHaveLength(0);

    // No bright square click anywhere in the Rear Guard pair; the Cannon's
    // pair is built around square oscillators.
    expect(fireRecipe).not.toContain('type: square');
    expect(impactRecipe).not.toContain('type: square');
    expect(cannonFireRecipe).toContain('type: square');
    expect(cannonImpactRecipe).toContain('type: square');

    // Slightly longer decay than the Cannon's 0.08 s snap.
    expect(durationSeconds(fireRecipe)).toBeGreaterThan(
      durationSeconds(cannonFireRecipe),
    );

    // "Softer" is proxied by the leading voice's level: the Rear Guard's body
    // gain is half the Cannon's (both recipes then share the same 0.9 mix).
    expect(durationSeconds(impactRecipe)).toBeLessThanOrEqual(0.14);
    expect(durationSeconds(impactRecipe)).toBeLessThan(
      durationSeconds(cannonImpactRecipe),
    );
    expect(firstGainValue(impactRecipe)).toBeLessThan(
      firstGainValue(cannonImpactRecipe),
    );
  });

  it('documents the rearward/muffled character in the fire recipe comment and meta tags', () => {
    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    // The authored comment explains *why* the cue is darker; a sound designer
    // editing the recipe sees the intent next to the values.
    expect(fireRecipe).toContain('lower than the Cannon');
    expect(fireRecipe).toContain('low-pass');
    // Machine-readable intent for catalogue searches.
    expect(fireRecipe).toContain('- rearward');
    expect(fireRecipe).toContain('- muted');
    expect(fireRecipe).toContain('- darker-than-cannon');
    expect(fireRecipe).toContain('- no-square-click');
  });
});

describe('Rear Guard feel package — documentation', () => {
  it('records both cues in both AUDIO_TONEFORGE_CUE_MAPPING tables', () => {
    const doc = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');
    // Cue → disposition table rows.
    expect(doc).toContain(`| \`${FIRE_CUE}\``);
    expect(doc).toContain(`| \`${IMPACT_CUE}\``);
    // Recipe → seed table rows, with the reserved seeds.
    expect(doc).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32281 \\|`),
    );
    expect(doc).toMatch(
      new RegExp(`\\| \`${IMPACT_RECIPE}\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32282 \\|`),
    );
  });

  it('reserves both seeds in the ToneForge README table', () => {
    const readme = read('audio/toneforge/README.md');
    expect(readme).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\\.yaml\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32281 \\|`),
    );
    expect(readme).toMatch(
      new RegExp(
        `\\| \`${IMPACT_RECIPE}\\.yaml\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32282 \\|`,
      ),
    );
  });

  it('records the fire/impact identity in the GDD net-new-weapon note and §7.3', () => {
    const gdd = read('docs/Game Design Document.md');
    // §4.4 net-new-weapon audio note names both cues and both seeds.
    expect(gdd).toContain(FIRE_CUE);
    expect(gdd).toContain(IMPACT_CUE);
    expect(gdd).toContain('32281');
    expect(gdd).toContain('32282');
    // §7.3 cue table carries all three Rear Guard rows (launch, fire, impact).
    expect(gdd).toContain('| Rear Guard launch flash |');
    expect(gdd).toContain('| Rear Guard fire |');
    expect(gdd).toContain('| Rear Guard impact |');
  });

  it('names the Rear Guard cues in the README weapon/audio note', () => {
    const readme = read('README.md');
    expect(readme).toContain(FIRE_CUE);
    expect(readme).toContain(IMPACT_CUE);
    expect(readme).toContain(FIRE_RECIPE);
    expect(readme).toContain(IMPACT_RECIPE);
  });
});
