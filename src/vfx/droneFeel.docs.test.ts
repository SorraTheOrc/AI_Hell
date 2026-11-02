/**
 * Mystery UFO feel package — docs & catalogue guard
 * (AH-0MVSAK3LT001HLRZ, parent AH-0MVI4J8R4002WTT6, AC2 + AC3).
 *
 * The saucer's feel layer shipped as code across five sibling slices; this
 * guard pins the documentation side so the cue catalogue, the GDD and the
 * executable audio manifest cannot drift apart:
 *
 * - every feel cue is a **baked** manifest entry with its reserved seed and
 *   recipe (`AC1` delivery form, `AC3` catalogue rows),
 * - the sortie-long warble keeps its `stopMysteryUfoWarbleSound` control
 *   companion registered in the manifest `controlCues`,
 * - `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` carries the four cue→recipe rows,
 * - GDD §7.3 names each cue and describes the warble / reward / destruction
 *   feedback, and the §4.4 Mystery UFO section describes the same SFX plus the
 *   four saucer VFX moments (launch poof, collect sparkle, return trail,
 *   running-light pulse),
 * - the shipped `effects.ts` wrappers exist for every cue.
 *
 * Like the sibling `shardSwarmFeel.docs.test.ts` / `orbitalStrike.docs.test.ts`
 * guards this is a deliberate docs grep: the acceptance criterion *is* the
 * documentation text, so a silently drifting GDD or cue catalogue is the
 * failure mode being guarded. Behaviour is pinned elsewhere — the warble
 * start/stop lifecycle and the terminal feedback in
 * `src/scenes/core/combatDrone.test.ts`, the cue dispatch in
 * `src/audio/effects.test.ts`, the no-`AudioContext` no-op contract in
 * `src/audio/effects.contract.test.ts` and the four VFX moments in
 * `src/vfx/droneVfxCounts.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { CONTROL_CUES, getCueAsset } from '../audio/cueManifest';
import * as effects from '../audio/effects';

const read = (relativePath: string): string =>
  fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');

/** The four feel cues, their recipe and reserved seed (see the manifest). */
const FEEL_CUES: ReadonlyArray<{
  readonly cue: string;
  readonly recipe: string;
  readonly seed: number;
}> = [
  {
    cue: 'playMysteryUfoWarbleSound',
    recipe: 'aihell-mystery-ufo-warble',
    seed: 32287,
  },
  {
    cue: 'playMysteryUfoRewardSound',
    recipe: 'aihell-mystery-ufo-reward',
    seed: 32288,
  },
  {
    cue: 'playMysteryUfoDestroySound',
    recipe: 'aihell-mystery-ufo-destroy',
    seed: 32289,
  },
  {
    cue: 'playMineralTinkleSound',
    recipe: 'aihell-mineral-tinkle',
    seed: 32290,
  },
];

/** The warble's start/stop control companion (continuous-cue lifecycle). */
const WARBLE_STOP_CUE = 'stopMysteryUfoWarbleSound';

/** Returns the GDD body between two headings (exclusive of both). */
function gddSection(startHeading: string, endHeading: string): string {
  const gdd = read('docs/Game Design Document.md');
  const start = gdd.indexOf(startHeading);
  const end = gdd.indexOf(endHeading, start + startHeading.length);
  expect(
    start,
    `GDD must contain the "${startHeading}" heading`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    end,
    `GDD must contain "${endHeading}" after "${startHeading}"`,
  ).toBeGreaterThan(start);
  return gdd.slice(start, end).replace(/\s+/g, ' ');
}

describe('Mystery UFO feel cues are baked ToneForge deliveries (AC3)', () => {
  it('maps each cue to its recipe, delivery and reserved seed', () => {
    for (const { cue, recipe, seed } of FEEL_CUES) {
      const entry = getCueAsset(cue);
      expect(entry, `${cue} must be in the manifest`).toBeDefined();
      expect(entry?.recipe).toBe(recipe);
      expect(entry?.delivery).toBe('baked');
      expect(entry?.seeds).toEqual([seed]);
    }
  });

  it('keeps the sortie-long warble controllable via its control companion', () => {
    expect(CONTROL_CUES).toContain(WARBLE_STOP_CUE);
    expect(getCueAsset(WARBLE_STOP_CUE)).toBeUndefined();
  });

  it('exports a playback wrapper for every cue plus the warble stop', () => {
    for (const { cue } of FEEL_CUES) {
      expect(
        typeof (effects as unknown as Record<string, unknown>)[cue],
        `${cue} must be exported from effects.ts`,
      ).toBe('function');
    }
    expect(
      typeof (effects as unknown as Record<string, unknown>)[WARBLE_STOP_CUE],
    ).toBe('function');
  });

  it('catalogues every cue→recipe row in the authoritative cue mapping', () => {
    const mapping = read('docs/AUDIO_TONEFORGE_CUE_MAPPING.md');
    for (const { cue, recipe } of FEEL_CUES) {
      expect(mapping, `cue mapping must name ${cue}`).toContain(cue);
      expect(mapping, `cue mapping must name ${recipe}`).toContain(recipe);
    }
    expect(mapping).toContain(WARBLE_STOP_CUE);
  });
});

describe('GDD documents the Mystery UFO feel layer (AC2)', () => {
  it('names every feel cue in §7.3 Audio Direction', () => {
    const audio = gddSection(
      '### 7.3 Audio Direction',
      '## 8. Future Scope',
    );
    for (const { cue } of FEEL_CUES) {
      expect(audio, `§7.3 must name ${cue}`).toContain(cue);
    }
    expect(audio).toContain(WARBLE_STOP_CUE);
  });

  it('describes the warble as a whole-sortie loop with start/stop control', () => {
    const audio = gddSection('### 7.3 Audio Direction', '## 8. Future Scope');
    expect(audio).toMatch(/warble/i);
    expect(audio).toMatch(/whole sortie|seek and collect/i);
    expect(audio).toMatch(/looping/i);
    expect(audio).toMatch(/stopMysteryUfoWarbleSound/);
  });

  it('describes the reward fanfare on the hold pay-in and the destruction feedback', () => {
    const audio = gddSection('### 7.3 Audio Direction', '## 8. Future Scope');
    expect(audio).toMatch(/reward fanfare/i);
    expect(audio).toMatch(/pay-in|payout/i);
    expect(audio).toMatch(/destruction explosion/i);
    expect(audio).toMatch(/particle/i);
    expect(audio).toMatch(/mineral tinkle/i);
  });

  it('describes the SFX and the four VFX moments in the §4.4 Mystery UFO section', () => {
    const section = gddSection('### 4.4 Power-Ups', '#### Loadout slots');
    expect(section).toMatch(/Mystery UFO/);
    expect(section).toMatch(/warble/i);
    expect(section).toMatch(/reward fanfare/i);
    expect(section).toMatch(/destruction/i);
    expect(section).toMatch(/tinkle/i);
    // The four saucer VFX moments, named where a designer looks for them.
    expect(section).toMatch(/launch poof/i);
    expect(section).toMatch(/collect sparkle/i);
    expect(section).toMatch(/return trail/i);
    expect(section).toMatch(/running-light/i);
    // Same code in the game and every gym.
    expect(section).toContain('src/scenes/core/combatDrone.ts');
    expect(section).toContain('MysteryUfoDrone');
  });
});
