/**
 * Unit tests for the ToneForge playback layer in `src/audio/effects.ts`
 * (AH-0MUTYV92Y000WJ8Z).
 *
 * The playback-contract suite (`effects.contract.test.ts`) pins the
 * headless/single-context/volume behaviour of the *Web Audio provider*. This
 * suite pins the **cue→asset dispatch** logic that sits on top of it: every
 * retained cue resolves to the asset recorded in the manifest, advance cues
 * schedule their fire cue at the cue end, multi-seed cues vary, the thruster
 * delegates to the runtime shim, and the retired cues are gone.
 *
 * A recording {@link SfxSoundProvider} is injected so the assertions observe
 * the cue layer's decisions (asset URL, delay, volume) without touching Web
 * Audio internals.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as effects from './effects';
import {
  CUE_MANIFEST,
  RETIRED_CUES,
  assetUrlFor,
  type CueManifestEntry,
} from './cueManifest';
import type { SfxPlayOptions, SfxSoundHandle, SfxSoundProvider } from './sfxPlayback';
import {
  RecordingAudioContext,
  resetRecordingAudioContext,
} from '../test/audioTestDouble';

// ── Recording provider ──────────────────────────────────────────────

interface RecordedPlay {
  url: string;
  options: SfxPlayOptions | undefined;
}

class RecordingProvider implements SfxSoundProvider {
  readonly plays: RecordedPlay[] = [];
  readonly volumes: number[] = [];
  readonly mutes: boolean[] = [];
  stops = 0;
  private context: AudioContext | null = null;

  getAudioContext(): AudioContext | null {
    return this.context;
  }

  useAudioContext(context: AudioContext | null): void {
    this.context = context;
  }

  play(url: string, options?: SfxPlayOptions): SfxSoundHandle {
    this.plays.push({ url, options });
    return { stop: () => (this.stops += 1) };
  }

  setVolume(value: number): void {
    this.volumes.push(value);
  }

  setMuted(muted: boolean): void {
    this.mutes.push(muted);
  }

  reset(): void {
    this.plays.length = 0;
    this.volumes.length = 0;
    this.mutes.length = 0;
    this.stops = 0;
    this.context = null;
  }
}

/** Non-empty argument lists for the cues that take parameters. */
const CUE_ARGS: Record<string, unknown[]> = {
  playVolumeFeedback: [0.5],
  playPlayerDestructionSound: [0.5],
  updateThrusterSound: [0.5],
  playBossPhaseCue: [1],
};

function invokeCue(name: string): void {
  const fn = (effects as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`${name} is not exported`);
  (fn as (...args: unknown[]) => void)(...(CUE_ARGS[name] ?? []));
}

/** The baked URL(s) a manifest entry may legitimately resolve to. */
function allowedUrls(entry: CueManifestEntry): string[] {
  return entry.seeds.length > 0
    ? entry.seeds.map((seed) => `audio/sfx/${entry.recipe}.${seed}.wav`)
    : [assetUrlFor(entry)];
}

let recording: RecordingProvider;

beforeEach(() => {
  recording = new RecordingProvider();
  effects.setSfxSoundProvider(recording);
});

afterEach(() => {
  effects._resetAudioContextForTests();
});

// ── 1. Cue → baked asset mapping ────────────────────────────────────

describe('cue → baked asset mapping', () => {
  it('every manifest cue plays its mapped baked asset', () => {
    for (const entry of CUE_MANIFEST) {
      if (entry.delivery === 'runtime-shim') continue;
      recording.plays.length = 0;
      invokeCue(entry.cue);
      expect(recording.plays.length, `${entry.cue} played nothing`).toBeGreaterThan(0);
      expect(allowedUrls(entry), `${entry.cue}`).toContain(recording.plays[0].url);
    }
  });

  it('a shared existing-recipe cue resolves to the sibling baked variant', () => {
    // playVolumeFeedback reuses the aihell-player-hull-breach recipe, which is
    // baked for playPlayerDestructionSound at seed 32120.
    effects.playVolumeFeedback(0.5);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-player-hull-breach.32120.wav');

    // A genuinely existing ToneForge recipe uses the default seed.
    effects.playPowerUpCollectSound();
    expect(recording.plays[1].url).toBe('audio/sfx/card-token-earn.1.wav');
    effects.playScoutFireSound();
    expect(recording.plays[2].url).toBe('audio/sfx/weapon-laser-zap.1.wav');
  });

  it('multi-seed cues vary across invocations', () => {
    const spy = vi
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.5)
      .mockReturnValueOnce(0.999);

    const urls = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      recording.plays.length = 0;
      effects.playDestructionSound();
      urls.add(recording.plays[0].url);
    }
    spy.mockRestore();

    expect(urls.size).toBe(3);
    for (const url of urls) {
      expect(allowedUrls(cueEntry('playDestructionSound'))).toContain(url);
    }
  });

  it('the Boss phase cue maps each phase to its own seeded variant', () => {
    const seeds = cueEntry('playBossPhaseCue').seeds;
    expect(seeds).toHaveLength(4);
    seeds.forEach((seed, i) => {
      recording.plays.length = 0;
      effects.playBossPhaseCue(i + 1);
      expect(recording.plays[0].url).toBe(
        `audio/sfx/aihell-boss-phase-cue.${seed}.wav`,
      );
    });
  });

  it('removed cues are no longer exported', () => {
    for (const name of [
      ...RETIRED_CUES,
      'blip',
      'explosionPitchFactor',
      'EXPLOSION_PITCH_JITTER',
    ]) {
      expect((effects as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });
});

function cueEntry(cue: string): CueManifestEntry {
  const entry = CUE_MANIFEST.find((e) => e.cue === cue);
  if (entry === undefined) throw new Error(`no manifest entry for ${cue}`);
  return entry;
}

// ── 2. Advance cues — gap-free cue → fire ───────────────────────────

describe('advance cues (parent AC8)', () => {
  it('every advance duration is at least 500 ms', () => {
    expect(effects.SCOUT_ADVANCE_CUE_DURATION).toBeGreaterThanOrEqual(0.5);
    expect(effects.PHASER_ADVANCE_CUE_DURATION).toBeGreaterThanOrEqual(0.5);
    expect(effects.TANK_ADVANCE_CUE_DURATION).toBeGreaterThanOrEqual(0.5);
  });

  const cases: Array<[string, string, number]> = [
    ['playTankAdvanceCue', 'playTankFireSound', effects.TANK_ADVANCE_CUE_DURATION],
    ['playPhaserAdvanceCue', 'playPhaserFireSound', effects.PHASER_ADVANCE_CUE_DURATION],
    ['playScoutAdvanceCue', 'playScoutFireSound', effects.SCOUT_ADVANCE_CUE_DURATION],
  ];

  it.each(cases)('%s → %s has no gap', (advance, fire, duration) => {
    invokeCue(advance);
    expect(recording.plays[0].options?.delay ?? 0).toBe(0);
    invokeCue(fire);
    expect(recording.plays[1].options?.delay).toBe(duration);
  });
});

// ── 3. Volume scaling + master delegation ───────────────────────────

describe('volume and mute', () => {
  it('playPlayerDestructionSound scales its playback volume', () => {
    effects.playPlayerDestructionSound(0.3);
    expect(recording.plays[0].options?.volume).toBe(0.3);
    effects.playPlayerDestructionSound();
    expect(recording.plays[1].options?.volume).toBe(1);
  });

  it('playVolumeFeedback forwards the selected volume', () => {
    effects.playVolumeFeedback(0.5);
    expect(recording.plays[0].options?.volume).toBe(0.5);
  });

  it('setSfxVolume and setSfxMuted delegate to the provider', () => {
    effects.setSfxVolume(0.4);
    effects.setSfxMuted(true);
    expect(recording.volumes).toEqual([0.4]);
    expect(recording.mutes).toEqual([true]);
  });
});

// ── 4. Dive-sound lifecycle ─────────────────────────────────────────

describe('sustained dive sound', () => {
  it('shares one voice and stops cleanly', () => {
    effects.playDiveSound();
    effects.playDiveSound();
    expect(recording.plays).toHaveLength(1);
    expect(effects._getDiverDiveSoundStateForTests()).not.toBeNull();

    effects.stopDiveSound();
    expect(recording.stops).toBe(1);
    expect(effects._getDiverDiveSoundStateForTests()).toBeNull();
  });

  it('stopDiveSound is a safe no-op when nothing plays', () => {
    expect(() => effects.stopDiveSound()).not.toThrow();
    expect(recording.stops).toBe(0);
  });
});

// ── 5. Thruster hum — runtime-shim delegation ───────────────────────

describe('thruster hum (runtime shim)', () => {
  beforeEach(() => {
    (window as unknown as { AudioContext?: unknown }).AudioContext =
      RecordingAudioContext as unknown as typeof AudioContext;
    effects._resetAudioContextForTests();
    resetRecordingAudioContext();
  });

  afterEach(() => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    effects._resetAudioContextForTests();
  });

  it('tracks the requested level and stops cleanly', () => {
    effects.updateThrusterSound(0.8);
    const hum = effects._getThrusterHumStateForTests();
    expect(hum).not.toBeNull();
    expect(hum!.currentGain).toBeCloseTo(
      0.8 * effects.THRUSTER_HUM_MAX_VOLUME,
      6,
    );

    effects.stopThrusterSound();
    expect(effects._getThrusterHumStateForTests()).toBeNull();
  });

  it('is a safe no-op without an AudioContext', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    effects._resetAudioContextForTests();

    expect(() => effects.updateThrusterSound(0.5)).not.toThrow();
    expect(() => effects.stopThrusterSound()).not.toThrow();
    expect(effects._getThrusterHumStateForTests()).toBeNull();
  });
});

// ── 6. Headless no-op (belt-and-suspenders with the contract suite) ─

describe('headless no-op', () => {
  it('every cue degrades safely without an AudioContext', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
    effects._resetAudioContextForTests();

    for (const entry of CUE_MANIFEST) {
      expect(() => invokeCue(entry.cue), entry.cue).not.toThrow();
    }
    expect(() => effects.stopDiveSound()).not.toThrow();
    expect(() => effects.stopThrusterSound()).not.toThrow();
    expect(() => effects.setSfxVolume(0.5)).not.toThrow();
    expect(() => effects.setSfxMuted(true)).not.toThrow();
    expect(effects.getAudioContext()).toBeNull();
  });
});
