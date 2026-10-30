/**
 * Shard Swarm feel package — docs & distinctness guard (AH-0MVV0WMTE0007NGS).
 *
 * The Shard Swarm shipped silent: no launch cue, no muzzle flash and only the
 * generic warm-white impact flash. This guard pins the documentation side of
 * its completed feel package so the cue catalogue and the player-facing docs
 * cannot drift from the code:
 *
 * - both cues are baked manifest entries with their reserved seeds (and are
 *   not aliases of the Cannon's cues — distinct recipes/seed pairs),
 * - the two recipes characterise themselves differently from the Cannon's
 *   blunt thump (bright/glassy/lime vs square/saw thump), so the audible
 *   identity is recorded where the recipe is authored,
 * - `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` carries **both** tables' rows,
 * - `audio/toneforge/README.md` reserves both seeds,
 * - the GDD §4.4 net-new-weapon note and §7.3 cue table record the fire and
 *   impact identity, and the README names the cues rather than leaving the
 *   weapon silhouette-only.
 *
 * Behavioural coverage lives in `effects.test.ts` (dispatch/assets),
 * `weapons.test.ts` (metadata), `weaponLevels.test.ts` (level survival),
 * `CombatScene.test.ts` (impact seam) and `CombatCoreScene.test.ts` (muzzle
 * flash through the shared core).
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CUE_MANIFEST } from './cueManifest';
import * as effects from './effects';
import { WEAPON_CATALOGUE } from '../utils/weapons';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

const FIRE_CUE = 'playShardSwarmFireSound';
const IMPACT_CUE = 'playShardSwarmImpactSound';
const FIRE_RECIPE = 'aihell-shard-swarm-fire';
const IMPACT_RECIPE = 'aihell-shard-swarm-impact';

describe('Shard Swarm feel package — audio catalogue', () => {
  it('bakes both cues with their reserved seeds', () => {
    const fire = CUE_MANIFEST.find((entry) => entry.cue === FIRE_CUE);
    const impact = CUE_MANIFEST.find((entry) => entry.cue === IMPACT_CUE);
    expect(fire?.recipe).toBe(FIRE_RECIPE);
    expect(fire?.delivery).toBe('baked');
    expect(fire?.seeds).toEqual([32279]);
    expect(impact?.recipe).toBe(IMPACT_RECIPE);
    expect(impact?.delivery).toBe('baked');
    expect(impact?.seeds).toEqual([32280]);
  });

  it('exports both cues and dispatches fire/impact through the shared seams', () => {
    expect(typeof effects.playShardSwarmFireSound).toBe('function');
    expect(typeof effects.playShardSwarmImpactSound).toBe('function');
    // The definition's impact metadata names the exported cue, and the cue
    // resolves through the shared registry (proven behaviourally in
    // `effects.test.ts`).
    expect(WEAPON_CATALOGUE.shard_swarm.impactFx?.cue).toBe(IMPACT_CUE);
  });

  it('is audibly distinct from the Cannon — different recipes, seeds and character', () => {
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

    // The authored recipes record the difference where a sound designer looks:
    // the Shard Swarm is bright/glassy/percussive, the Cannon is a blunt
    // square/saw thump.
    const fireRecipe = read(`audio/toneforge/recipes/${FIRE_RECIPE}.yaml`);
    const impactRecipe = read(`audio/toneforge/recipes/${IMPACT_RECIPE}.yaml`);
    const cannonFireRecipe = read('audio/toneforge/recipes/aihell-cannon-fire.yaml');
    const cannonImpactRecipe = read('audio/toneforge/recipes/aihell-cannon-impact.yaml');
    expect(fireRecipe).toContain('glassy');
    expect(fireRecipe).toContain('multi-shard');
    expect(impactRecipe).toContain('glassy');
    expect(impactRecipe).toContain('tink');
    expect(cannonFireRecipe).toContain('square');
    expect(cannonImpactRecipe).toContain('thump');
  });
});

describe('Shard Swarm feel package — documentation', () => {
  it('records both cues in both AUDIO_TONEFORGE_CUE_MAPPING tables', () => {
    const doc = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');
    // Cue → disposition table rows.
    expect(doc).toContain(`| \`${FIRE_CUE}\``);
    expect(doc).toContain(`| \`${IMPACT_CUE}\``);
    // Recipe → seed table rows, with the reserved seeds.
    expect(doc).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32279 \\|`),
    );
    expect(doc).toMatch(
      new RegExp(`\\| \`${IMPACT_RECIPE}\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32280 \\|`),
    );
  });

  it('reserves both seeds in the ToneForge README table', () => {
    const readme = read('audio/toneforge/README.md');
    expect(readme).toMatch(
      new RegExp(`\\| \`${FIRE_RECIPE}\\.yaml\` \\| \`${FIRE_CUE}\`[^\\n]*\\| 32279 \\|`),
    );
    expect(readme).toMatch(
      new RegExp(
        `\\| \`${IMPACT_RECIPE}\\.yaml\` \\| \`${IMPACT_CUE}\`[^\\n]*\\| 32280 \\|`,
      ),
    );
  });

  it('records the fire/impact identity in the GDD net-new-weapon note and §7.3', () => {
    const gdd = read('docs/Game Design Document.md');
    // §4.4 net-new-weapon audio note names both cues and both seeds.
    expect(gdd).toContain(FIRE_CUE);
    expect(gdd).toContain(IMPACT_CUE);
    expect(gdd).toContain('32279');
    expect(gdd).toContain('32280');
    // §7.3 cue table carries all three Shard Swarm rows (launch, fire, impact).
    expect(gdd).toContain('| Shard Swarm launch flash |');
    expect(gdd).toContain('| Shard Swarm fire |');
    expect(gdd).toContain('| Shard Swarm impact |');
  });

  it('names the Shard Swarm cues in the README weapon/audio note', () => {
    const readme = read('README.md');
    expect(readme).toContain(FIRE_CUE);
    expect(readme).toContain(IMPACT_CUE);
    expect(readme).toContain(FIRE_RECIPE);
    expect(readme).toContain(IMPACT_RECIPE);
  });
});
