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
