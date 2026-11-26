/**
 * Baked-asset guard for the player mineral pickup chime
 * (AH-0MWNMRD6I002CCVT).
 *
 * The cue is a *player* cue, so `scripts/audio-balance-guard.mjs` deliberately
 * leaves it outside the enemy balance tiers (it has no `AMPLITUDE_TIERS` key
 * and no enemy-family tag). The documented player-cue ceiling is therefore
 * pinned here instead: the rendered 16-bit PCM asset must peak at or below
 * **0.20 linear** (GDD §7.3), so a dense mineral field can never push the
 * chime over the mix or mask an enemy-fire telegraph.
 *
 * Parsing follows the sibling reader pattern in
 * `scripts/audio-balance-guard.test.ts` (`analyzeWavBuffer`), so the peak is
 * measured from the committed baked asset — never a hand-written fixture.
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeWavBuffer } from '../../scripts/audio-balance-guard.mjs';
import { cueAssetUrl } from './cueManifest';

const root = process.cwd();

/** The documented player-cue peak ceiling (GDD §7.3). */
const PLAYER_CUE_PEAK_CEILING = 0.2;

describe('baked mineral pickup chime (AH-0MWNMRD6I002CCVT)', () => {
  it('resolves to its own dedicated baked asset', () => {
    expect(cueAssetUrl('playMineralCollectChimeSound')).toBe(
      'audio/sfx/aihell-mineral-chime.32292.wav',
    );
  });

  it('peaks at or below the 0.20 player-cue ceiling (GDD §7.3)', () => {
    const url = cueAssetUrl('playMineralCollectChimeSound');
    expect(url).toBeDefined();

    const buffer = readFileSync(join(root, 'public', url!));
    const { peak, bitDepth } = analyzeWavBuffer(buffer);

    // Confirm the reader measured what the AC describes: a 16-bit PCM peak.
    expect(bitDepth).toBe(16);
    // Non-silent (the bake actually produced a tone) but never above the
    // documented player-cue ceiling.
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(PLAYER_CUE_PEAK_CEILING);
  });
});
