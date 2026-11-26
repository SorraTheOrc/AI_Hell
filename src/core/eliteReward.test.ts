/**
 * Elite reward resolution and death-cue tests
 * (AH-0MWU666IS008JOR3; folded test child AH-0MWU65X6C007JBTL).
 *
 * These pin the reward contract independently of the scene:
 *
 * - the guaranteed drop flag is always set (AC1),
 * - the mineral bump is the authored 2–4 range interpolated with the shared
 *   level-scaling curve, so level 1 pays 2 and the campaign maximum pays 4
 *   (AC2),
 * - the death cue is the **distinct** baked boss-destruction asset, and it is
 *   gated on the shared SFX settings (mute / zero volume) (AC3).
 *
 * The scene-level integration (the reward actually spawns at the wreck and the
 * cue fires on an elite kill) lives in `src/scenes/PlayScene.elite.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setSfxSoundProvider } from '../audio/effects';
import { RecordingSfxProvider } from '../test/audioTestDouble';
import { DEFAULT_SETTINGS, saveSettings } from './settingsStore';
import { DEFAULT_RULES } from './rules';
import {
  ELITE_MINERAL_BUMP_MAX,
  ELITE_MINERAL_BUMP_MIN,
  eliteMineralBump,
  isEliteDeathCueEnabled,
  playEliteDeathCue,
  resolveEliteReward,
} from './eliteReward';

describe('elite mineral bump (AC2)', () => {
  it('pays the authored minimum at level 1 and the maximum at the campaign maximum', () => {
    expect(eliteMineralBump(1)).toBe(ELITE_MINERAL_BUMP_MIN);
    expect(eliteMineralBump(10)).toBe(ELITE_MINERAL_BUMP_MAX);
  });

  it('rises monotonically through the campaign and stays a whole number in range', () => {
    let previous = eliteMineralBump(1);
    for (let level = 1; level <= 10; level += 1) {
      const bump = eliteMineralBump(level);
      expect(Number.isInteger(bump)).toBe(true);
      expect(bump).toBeGreaterThanOrEqual(ELITE_MINERAL_BUMP_MIN);
      expect(bump).toBeLessThanOrEqual(ELITE_MINERAL_BUMP_MAX);
      expect(bump).toBeGreaterThanOrEqual(previous);
      previous = bump;
    }
    // The range is genuinely travelled, not collapsed to one value.
    expect(eliteMineralBump(10)).toBeGreaterThan(eliteMineralBump(1));
  });

  it('clamps out-of-range and non-finite levels through the shared curve', () => {
    expect(eliteMineralBump(0)).toBe(ELITE_MINERAL_BUMP_MIN);
    expect(eliteMineralBump(-5)).toBe(ELITE_MINERAL_BUMP_MIN);
    expect(eliteMineralBump(999)).toBe(ELITE_MINERAL_BUMP_MAX);
    expect(eliteMineralBump(Number.NaN)).toBe(ELITE_MINERAL_BUMP_MIN);
    expect(eliteMineralBump(Number.POSITIVE_INFINITY)).toBe(
      ELITE_MINERAL_BUMP_MAX,
    );
  });

  it('is deterministic for the same level (parent AC8)', () => {
    for (const level of [1, 3, 7, 10]) {
      expect(eliteMineralBump(level)).toBe(eliteMineralBump(level));
    }
  });
});

describe('elite reward resolution (AC1)', () => {
  it('always guarantees a shared-pool drop and carries the level-scaled bump', () => {
    for (const level of [1, 2, 5, 10]) {
      const reward = resolveEliteReward(level);
      expect(reward.guaranteedDrop).toBe(true);
      expect(reward.mineralBump).toBe(eliteMineralBump(level));
    }
  });

  it('honours a caller-supplied scaling span', () => {
    // A level-4 campaign max makes level 4 the far end of the same curve.
    expect(
      eliteMineralBump(4, { ...DEFAULT_RULES, levelScalingMaxLevel: 4 }),
    ).toBe(ELITE_MINERAL_BUMP_MAX);
  });
});

describe('elite death cue (AC3)', () => {
  let recording: RecordingSfxProvider;

  beforeEach(() => {
    localStorage.clear();
    recording = new RecordingSfxProvider();
    setSfxSoundProvider(recording);
  });

  afterEach(() => {
    setSfxSoundProvider(null);
    localStorage.clear();
  });

  it('dispatches the distinct baked elite cue, not the ordinary destruction cue', () => {
    expect(playEliteDeathCue()).toBe(true);
    expect(recording.plays).toHaveLength(1);
    // The elite alias resolves the heavier boss-destruction recipe (seed
    // 32203), never the ordinary enemy-destruction variants.
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-boss-destruction.32203.wav',
    );
  });

  it('is silent when the shared settings mute SFX or set volume to zero', () => {
    expect(isEliteDeathCueEnabled({ sfxMuted: true, sfxVolume: 1 })).toBe(false);
    expect(isEliteDeathCueEnabled({ sfxMuted: false, sfxVolume: 0 })).toBe(
      false,
    );
    expect(playEliteDeathCue({ sfxMuted: true, sfxVolume: 1 })).toBe(false);
    expect(playEliteDeathCue({ sfxMuted: false, sfxVolume: 0 })).toBe(false);
    expect(recording.plays).toHaveLength(0);
  });

  it('honours the persisted shared settings store', () => {
    saveSettings({ ...DEFAULT_SETTINGS, sfxMuted: true });
    expect(playEliteDeathCue()).toBe(false);
    expect(recording.plays).toHaveLength(0);

    saveSettings({ ...DEFAULT_SETTINGS, sfxMuted: false, sfxVolume: 0.5 });
    expect(isEliteDeathCueEnabled()).toBe(true);
    expect(playEliteDeathCue()).toBe(true);
    expect(recording.plays).toHaveLength(1);
  });
});
