/**
 * Unit tests for the manifest-driven asset resolution added by the playback
 * rewrite (AH-0MUTYV92Y000WJ8Z): a shared `existing-recipe` cue resolves to
 * the asset baked for its sibling, and the preloader URL set is de-duplicated
 * and excludes runtime-shim cues.
 */

import { describe, expect, it } from 'vitest';

import {
  CUE_MANIFEST,
  allSfxAssetUrls,
  assetUrlFor,
  cueAssetUrl,
  getCueAsset,
} from './cueManifest';

describe('cueManifest — asset resolution', () => {
  it('resolves a shared existing-recipe cue to its sibling baked seed', () => {
    const entry = CUE_MANIFEST.find((e) => e.cue === 'playVolumeFeedback');
    expect(entry).toBeDefined();
    expect(assetUrlFor(entry!)).toBe(
      'audio/sfx/aihell-player-hull-breach.32120.wav',
    );
  });

  it('falls back to the default seed for a standalone existing recipe', () => {
    const entry = CUE_MANIFEST.find((e) => e.cue === 'playPowerUpCollectSound');
    expect(entry).toBeDefined();
    expect(assetUrlFor(entry!)).toBe('audio/sfx/card-token-earn.1.wav');
  });

  it('cueAssetUrl resolves baked cues and rejects runtime-shim cues', () => {
    expect(cueAssetUrl('playSpawnSound')).toBe(
      'audio/sfx/aihell-enemy-spawn.32101.wav',
    );
    expect(cueAssetUrl('updateThrusterSound')).toBeUndefined();
  });

  it('maps the dedicated boss-hit cue to the baked aihell-boss-hit recipe', () => {
    const entry = getCueAsset('playBossHitSound');
    expect(entry).toBeDefined();
    expect(entry!.recipe).toBe('aihell-boss-hit');
    expect(entry!.delivery).toBe('baked');
    expect(entry!.seeds).toEqual([32208]);
    expect(cueAssetUrl('playBossHitSound')).toBe(
      'audio/sfx/aihell-boss-hit.32208.wav',
    );
  });

  it('the preload set is de-duplicated and excludes runtime-shim assets', () => {
    const urls = allSfxAssetUrls();
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls.some((url) => url.includes('thruster'))).toBe(false);
    expect(urls).toContain('audio/sfx/aihell-player-hull-breach.32120.wav');
    expect(urls).toContain('audio/sfx/card-token-earn.1.wav');
    // Every baked manifest variant is present.
    for (const entry of CUE_MANIFEST) {
      for (const seed of entry.seeds) {
        expect(urls).toContain(`audio/sfx/${entry.recipe}.${seed}.wav`);
      }
    }
  });
});

// ── Dedicated Orbital Strike cue (AH-0MVS2SZBY004HJ2D) ───────────────
//
// TEST-FIRST (AH-0MVS2SW8V007ZBJQ, parent AC2): the cue-authoring sibling
// registers `playOrbitalStrikeSound` behind the new `aihell-orbital-strike`
// recipe. Pinned now so the strike cue cannot land as an ad-hoc synthesis or
// a clone of an existing recipe.

describe('cueManifest — dedicated orbital-strike cue (AH-0MVS2SZBY004HJ2D)', () => {
  it('maps playOrbitalStrikeSound to the new baked aihell-orbital-strike recipe', () => {
    const entry = getCueAsset('playOrbitalStrikeSound');
    expect(entry).toBeDefined();
    expect(entry!.recipe).toBe('aihell-orbital-strike');
    expect(entry!.delivery).toBe('baked');
    // A fresh seed from the game-specific reservation block (32100–32199 per
    // docs/AUDIO_TONEFORGE_CUE_MAPPING.md), so the strike cannot alias an
    // existing recipe's baked asset.
    expect(entry!.seeds).toHaveLength(1);
    const seed = entry!.seeds[0];
    expect(seed).toBeGreaterThanOrEqual(32100);
    expect(seed).toBeLessThanOrEqual(32199);
    expect(cueAssetUrl('playOrbitalStrikeSound')).toBe(
      `audio/sfx/aihell-orbital-strike.${seed}.wav`,
    );
    // The preloader actually fetches the baked strike asset.
    expect(allSfxAssetUrls()).toContain(`audio/sfx/aihell-orbital-strike.${seed}.wav`);
  });

  it('is structurally distinct from the AOE sister cues (different recipe, seed, asset)', () => {
    const strike = getCueAsset('playOrbitalStrikeSound');
    const nova = getCueAsset('playNovaImpactSound');
    const mortar = getCueAsset('playMortarDetonationSound');
    expect(strike).toBeDefined();
    expect(nova).toBeDefined();
    expect(mortar).toBeDefined();
    // Different recipe file, different baked seed, different asset URL — the
    // strike never aliases the Nova ring ping or the Mortar detonation wash.
    expect(strike!.recipe).not.toBe(nova!.recipe);
    expect(strike!.recipe).not.toBe(mortar!.recipe);
    const strikeSeed = strike!.seeds[0];
    expect(nova!.seeds).not.toContain(strikeSeed);
    expect(mortar!.seeds).not.toContain(strikeSeed);
    expect(cueAssetUrl('playOrbitalStrikeSound')).not.toBe(
      cueAssetUrl('playNovaImpactSound'),
    );
    expect(cueAssetUrl('playOrbitalStrikeSound')).not.toBe(
      cueAssetUrl('playMortarDetonationSound'),
    );
  });
});
