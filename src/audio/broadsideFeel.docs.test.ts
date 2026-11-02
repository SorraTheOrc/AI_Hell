/**
 * Broadside feel package — docs & two-sided pair guard (AH-0MVV0WNOX0078G9G).
 *
 * The Broadside fires a perpendicular teal `dart` pair and was shipped as
 * silent as the Shard Swarm. This guard pins the parts of its completed feel
 * package that are not observable through the scene seams:
 *
 * - both cues are baked manifest entries with their reserved seeds
 *   (32283 fire / 32284 impact) and are distinct recipes/assets from the
 *   Cannon's pair,
 * - the fire recipe contains **two distinct transient bursts inside one cue**
 *   — two gain-gated band-passed noise sweeps with a documented inter-onset
 *   interval inside the 35–50 ms design window — and the two sweeps run in
 *   **opposite directions** (one rising, one falling), the machine-checkable
 *   proxy for the "wide two-sided launch pair" read that distinguishes the
 *   Broadside from a second Cannon,
 * - the impact recipe is a short (≤ 0.12 s) teal dart tick,
 * - `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` carries **both** tables' rows,
 * - `audio/toneforge/README.md` reserves both seeds,
 * - the GDD §4.4 net-new-weapon note and §7.3 cue table record the fire and
 *   impact identity, and the README names the cues rather than leaving the
 *   weapon silhouette-only.
 *
 * Behavioural coverage lives in `effects.test.ts` (dispatch/assets),
 * `weapons.test.ts` (metadata/no-balance-change), `weaponLevels.test.ts`
 * (level survival), `CombatScene.test.ts` (impact seam) and
 * `CombatCoreScene.test.ts` (exactly one muzzle flash per shot input).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CUE_MANIFEST } from './cueManifest';
import * as effects from './effects';
import { WEAPON_CATALOGUE } from '../utils/weapons';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const FIRE_CUE = 'playBroadsideFireSound';
const IMPACT_CUE = 'playBroadsideImpactSound';
const FIRE_RECIPE = 'aihell-broadside-fire';
const IMPACT_RECIPE = 'aihell-broadside-impact';

/** The design's inter-onset window for the two-sided pair (seconds). */
const MIN_INTER_ONSET_S = 0.035;
const MAX_INTER_ONSET_S = 0.05;

/** Split a recipe into its top-level node blocks (two-space indented keys). */
function nodeBlocks(recipe: string): string[] {
  return recipe.split(/\n {2}(?=[a-zA-Z]\w*:)/);
}

/**
 * The onset time of every gain-gated transient: the last `set … value: 0`
 * gate at or before the rising `linearRamp` that opens the transient.
 *
 * This is a machine-checkable proxy for "two envelope/onset peaks inside one
 * cue": a block with no rising ramp (a static-gain tail) contributes nothing.
 */
function gainGateOnsets(recipe: string): number[] {
  const onsets: number[] = [];
  for (const block of nodeBlocks(recipe)) {
    if (!block.startsWith('g') || !block.includes('automation:')) continue;
    const gates = [...block.matchAll(/kind: set\n\s+time: ([\d.]+)\n\s+value: 0/g)].map(
      (match) => Number(match[1]),
    );
    const ramp = block.match(/kind: linearRamp\n\s+time: ([\d.]+)/);
    if (!ramp) continue;
    const rampTime = Number(ramp[1]);
    const before = gates.filter((time) => time <= rampTime);
    if (before.length === 0) continue;
    onsets.push(Math.max(...before));
  }
  return onsets.sort((a, b) => a - b);
}

/** Every band-pass sweep's start and end frequency, in node order. */
function bandpassSweeps(recipe: string): Array<{ from: number; to: number }> {
  const sweeps: Array<{ from: number; to: number }> = [];
  for (const block of nodeBlocks(recipe)) {
    if (!block.startsWith('f') || !block.includes('type: bandpass')) continue;
    const start = block.match(/kind: set\n\s+time: [\d.]+\n\s+value: ([\d.]+)/);
    const ramp = block.match(/kind: exponentialRamp\n\s+time: [\d.]+\n\s+value: ([\d.]+)/);
    if (!start || !ramp) continue;
    sweeps.push({ from: Number(start[1]), to: Number(ramp[1]) });
  }
  return sweeps;
}

/** The recipe's declared duration. */
function durationSeconds(recipe: string): number {
  const match = recipe.match(/^\s*duration: ([\d.]+)/m);
  if (!match) throw new Error('recipe has no duration');
  return Number(match[1]);
}

describe('Broadside feel package — audio catalogue', () => {
  it('bakes both cues with their reserved seeds', () => {
    const fire = CUE_MANIFEST.find((entry) => entry.cue === FIRE_CUE);
    const impact = CUE_MANIFEST.find((entry) => entry.cue === IMPACT_CUE);
    expect(fire?.recipe).toBe(FIRE_RECIPE);
    expect(fire?.delivery).toBe('baked');
    expect(fire?.seeds).toEqual([32283]);
    expect(impact?.recipe).toBe(IMPACT_RECIPE);
    expect(impact?.delivery).toBe('baked');
    expect(impact?.seeds).toEqual([32284]);
  });

  it('exports both cues and dispatches fire/impact through the shared seams', () => {
    expect(typeof effects.playBroadsideFireSound).toBe('function');
    expect(typeof effects.playBroadsideImpactSound).toBe('function');
    // The definition's impact metadata names the exported cue, and the cue
    // resolves through the shared registry (proven behaviourally in
    // `effects.test.ts`).
    expect(WEAPON_CATALOGUE.broadside.impactFx?.cue).toBe(IMPACT_CUE);
  });

  it('is a different asset from the Cannon — no second forward thump', () => {
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
    // The Cannon's identity is a single square-oscillator thump; the
    // Broadside must not reuse that character.
    expect(fireRecipe).not.toContain('type: square');
    expect(read('audio/toneforge/recipes/aihell-cannon-fire.yaml')).toContain(
      'type: square',
    );
  });

  it('renders two distinct transient bursts inside one cue, 35–50 ms apart', () => {
    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    const onsets = gainGateOnsets(fireRecipe);
    // Exactly two onsets: the left dart and the right dart. A single onset
    // would be a second Cannon; three or more would no longer read as a pair.
    expect(onsets).toHaveLength(2);

    const interOnset = onsets[1] - onsets[0];
    expect(interOnset).toBeGreaterThanOrEqual(MIN_INTER_ONSET_S);
    expect(interOnset).toBeLessThanOrEqual(MAX_INTER_ONSET_S);
    // The authored recipe documents the same interval so a sound designer sees
    // the intent next to the values (and the design window is explicit).
    expect(fireRecipe).toContain('inter-onset-40ms');
    expect(fireRecipe).toContain('35–50 ms');
  });

  it('sweeps the two bursts in opposite directions — the left/right pair read', () => {
    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    const sweeps = bandpassSweeps(fireRecipe);
    // One sweep per transient, and they must move in opposite directions:
    // a rising sweep then a falling sweep is what makes the pair audible as a
    // two-sided gesture rather than a repeat of the same swish.
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0].to).toBeGreaterThan(sweeps[0].from);
    expect(sweeps[1].to).toBeLessThan(sweeps[1].from);
    // The sweeps cross the same band in opposite directions (900 ↔ 3200 Hz),
    // so the two sides are mirror images rather than two different sounds.
    expect(sweeps[0].from).toBeCloseTo(sweeps[1].to, 5);
    expect(sweeps[0].to).toBeCloseTo(sweeps[1].from, 5);
  });

  it('keeps the impact a short teal dart tick at or under 0.12 s', () => {
    const impactRecipe = read(`audio/toneforge/recipes/${IMPACT_RECIPE}.yaml`);
    expect(durationSeconds(impactRecipe)).toBeGreaterThan(0);
    expect(durationSeconds(impactRecipe)).toBeLessThanOrEqual(0.12);
    // A glassy teal identity rather than the Cannon's square crack.
    expect(impactRecipe).toContain('type: triangle');
    expect(impactRecipe).not.toContain('type: square');
  });
});

describe('Broadside feel package — documentation', () => {
  it('records both cues in both AUDIO_TONEFORGE_CUE_MAPPING tables', () => {
    const doc = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');
    // Cue → disposition table rows.
    expect(doc).toContain(`| \`${FIRE_CUE}\``);
    expect(doc).toContain(`| \`${IMPACT_CUE}\``);
    // Recipe → seed table rows, with the reserved seeds.
    expect(doc).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32283 \\|`),
    );
    expect(doc).toMatch(
      new RegExp(`\\| \`${IMPACT_RECIPE}\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32284 \\|`),
    );
  });

  it('reserves both seeds in the ToneForge README table', () => {
    const readme = read('audio/toneforge/README.md');
    expect(readme).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\\.yaml\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32283 \\|`),
    );
    expect(readme).toMatch(
      new RegExp(
        `\\| \`${IMPACT_RECIPE}\\.yaml\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32284 \\|`,
      ),
    );
  });

  it('records the fire/impact identity in the GDD net-new-weapon note and §7.3', () => {
    const gdd = read('docs/Game Design Document.md');
    // §4.4 net-new-weapon audio note names both cues and both seeds.
    expect(gdd).toContain(FIRE_CUE);
    expect(gdd).toContain(IMPACT_CUE);
    expect(gdd).toContain('32283');
    expect(gdd).toContain('32284');
    // §7.3 cue table carries all three Broadside rows (launch, fire, impact).
    expect(gdd).toContain('| Broadside launch flash |');
    expect(gdd).toContain('| Broadside fire |');
    expect(gdd).toContain('| Broadside impact |');
  });

  it('names the Broadside cues in the README weapon/audio note', () => {
    const readme = read('README.md');
    expect(readme).toContain(FIRE_CUE);
    expect(readme).toContain(IMPACT_CUE);
    expect(readme).toContain(FIRE_RECIPE);
    expect(readme).toContain(IMPACT_RECIPE);
  });
});
