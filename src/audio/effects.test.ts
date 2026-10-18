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
import {
  SIXTEENTH_NOTE_SUBDIVISIONS,
  beatSubdivisionMs,
  createBeatClock,
} from '../utils/beat';
import {
  RecordingAudioContext,
  RecordingSfxProvider,
  lastSourceFrequency,
  resetRecordingAudioContext,
} from '../test/audioTestDouble';

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

// The shared recording `SfxSoundProvider` double (records asset URL, delay,
// volume and loop; exposes the master volume/mute/stop lifecycle).
let recording: RecordingSfxProvider;

beforeEach(() => {
  recording = new RecordingSfxProvider();
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
  });

  it('playCountdownTickSound resolves to the baked countdown-tick asset (AH-0MV55OA93008OUL1)', () => {
    effects.playCountdownTickSound();
    expect(recording.plays).toHaveLength(1);
    // New recipe, single seed 32264 — resolves deterministically.
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-countdown-tick.32264.wav',
    );
  });

  it('playCannonImpactSound resolves to the baked cannon-impact asset (AH-0MV8228YW0050IXS)', () => {
    effects.playCannonImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-cannon-impact.32209.wav',
    );
  });

  it('playWeaponImpactCue dispatches a weapon’s baked impact cue (AH-0MV8228YW0050IXS)', () => {
    effects.playWeaponImpactCue('playCannonImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-cannon-impact.32209.wav',
    );
  });

  it('playWeaponImpactCue is a safe no-op for an unmapped cue name (impact flash still plays)', () => {
    expect(() => effects.playWeaponImpactCue('playNotARealCue')).not.toThrow();
    expect(recording.plays).toHaveLength(0);
  });

  it('playNovaImpactSound resolves to the baked nova-impact asset (AH-0MV822BPT002GF17)', () => {
    effects.playNovaImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-nova-impact.32273.wav',
    );
  });

  it('playMortarImpactSound resolves to the baked mortar-impact asset (AH-0MV822C250051OVN)', () => {
    effects.playMortarImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-mortar-impact.32274.wav',
    );
  });

  it('playArcImpactSound resolves to the baked arc-impact asset (AH-0MV822CE7004MQ14)', () => {
    effects.playArcImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-arc-impact.32275.wav',
    );
  });

  it('playWeaponImpactCue dispatches the arc impact cue (AH-0MV822CE7004MQ14)', () => {
    effects.playWeaponImpactCue('playArcImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-arc-impact.32275.wav',
    );
  });

  it('playSpreadImpactSound resolves to the baked spread-impact asset (AH-0MV8229B9009DQGA)', () => {
    effects.playSpreadImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-spread-impact.32218.wav',
    );
  });

  it('playWeaponImpactCue dispatches the spread impact cue (AH-0MV8229B9009DQGA)', () => {
    effects.playWeaponImpactCue('playSpreadImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-spread-impact.32218.wav',
    );
  });

  it('playDualImpactSound resolves to the baked dual-impact asset (AH-0MV8229NM009CZOA)', () => {
    effects.playDualImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-dual-impact.32265.wav',
    );
  });

  it('playWeaponImpactCue dispatches the dual impact cue (AH-0MV8229NM009CZOA)', () => {
    effects.playWeaponImpactCue('playDualImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-dual-impact.32265.wav',
    );
  });

  it('playRapidImpactSound resolves to the baked rapid-impact asset (AH-0MV822A03006UT2P)', () => {
    effects.playRapidImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-rapid-impact.32266.wav',
    );
  });

  it('playWeaponImpactCue dispatches the rapid impact cue (AH-0MV822A03006UT2P)', () => {
    effects.playWeaponImpactCue('playRapidImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-rapid-impact.32266.wav',
    );
  });

  it('playWaveLaserFireSound resolves to the baked wave-laser fire asset (AH-0MV822ACO007CEZF)', () => {
    effects.playWaveLaserFireSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-wave-laser-fire.32219.wav',
    );
  });

  it('playWaveLaserImpactSound resolves to the baked wave-laser impact asset (AH-0MV822ACO007CEZF)', () => {
    effects.playWaveLaserImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-wave-laser-impact.32231.wav',
    );
  });

  it('playWeaponImpactCue dispatches the wave-laser impact cue (AH-0MV822ACO007CEZF)', () => {
    effects.playWeaponImpactCue('playWaveLaserImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-wave-laser-impact.32231.wav',
    );
  });

  it('playClusterImpactSound resolves to the baked cluster-impact asset (AH-0MV822B1B0048UZT)', () => {
    effects.playClusterImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-cluster-impact.32270.wav',
    );
  });

  it('playWeaponImpactCue dispatches the cluster impact cue (AH-0MV822B1B0048UZT)', () => {
    effects.playWeaponImpactCue('playClusterImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-cluster-impact.32270.wav',
    );
  });

  it('playOptionsImpactSound resolves to the baked options-impact asset (AH-0MV822BDN008IYL6)', () => {
    effects.playOptionsImpactSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-options-impact.32272.wav',
    );
  });

  it('playWeaponImpactCue dispatches the options impact cue (AH-0MV822BDN008IYL6)', () => {
    effects.playWeaponImpactCue('playOptionsImpactSound');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe(
      'audio/sfx/aihell-options-impact.32272.wav',
    );
  });

  it('playCountdownTickSound rises in pitch with each beat (AH-0MV722WJS0075UTZ)', () => {
    // Count 3 (step 0) is the base rate, 2 and 1 rise above it.
    effects.playCountdownTickSound(0);
    effects.playCountdownTickSound(1);
    effects.playCountdownTickSound(2);
    expect(recording.plays.map((p) => p.rate)).toEqual([
      1,
      effects.countdownTickRate(1),
      effects.countdownTickRate(2),
    ]);
    // Strictly rising: base < +major third < +perfect fifth.
    expect(recording.plays[1].rate).toBeGreaterThan(recording.plays[0].rate);
    expect(recording.plays[2].rate).toBeGreaterThan(recording.plays[1].rate);
    // Same baked asset for every beat — only the rate (pitch) changes.
    for (const play of recording.plays) {
      expect(play.url).toBe('audio/sfx/aihell-countdown-tick.32264.wav');
    }
  });

  it('countdownTickRate clamps bad steps to the base / highest baked step', () => {
    expect(effects.countdownTickRate(0)).toBe(1);
    expect(effects.countdownTickRate(-1)).toBe(1);
    expect(effects.countdownTickRate(99)).toBe(effects.countdownTickRate(2));
    expect(effects.countdownTickRate(Number.NaN)).toBe(1);
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
    expect(recording.plays[0].delay).toBe(0);
    invokeCue(fire);
    expect(recording.plays[1].delay).toBe(duration);
  });
});

// ── 3. Volume scaling + master delegation ───────────────────────────

describe('volume and mute', () => {
  it('playPlayerDestructionSound scales its playback volume', () => {
    effects.playPlayerDestructionSound(0.3);
    expect(recording.plays[0].volume).toBe(0.3);
    effects.playPlayerDestructionSound();
    expect(recording.plays[1].volume).toBe(1);
  });

  it('playVolumeFeedback forwards the selected volume', () => {
    effects.playVolumeFeedback(0.5);
    expect(recording.plays[0].volume).toBe(0.5);
  });

  it('setSfxVolume and setSfxMuted delegate to the provider', () => {
    effects.setSfxVolume(0.4);
    effects.setSfxMuted(true);
    expect(recording.volumes).toEqual([0.4]);
    expect(recording.mutes).toEqual([true]);
  });
});

// ── 3a. Tank/Scout fire-sequence volume (AH-0MV74ROYR009X8U3) ──────

describe('Tank/Scout fire-sequence volume (AH-0MV74ROYR009X8U3)', () => {
  it('TANK_SCOUT_FIRE_VOLUME_SCALE is a single named 0.5 tunable', () => {
    expect(effects.TANK_SCOUT_FIRE_VOLUME_SCALE).toBe(0.5);
  });

  it('playTankAdvanceCue plays the tank advance whine at half volume', () => {
    effects.playTankAdvanceCue();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-tank-advance.32140.wav');
    expect(recording.plays[0].volume).toBe(effects.TANK_SCOUT_FIRE_VOLUME_SCALE);
    // The no-gap advance cue is not delayed.
    expect(recording.plays[0].delay).toBe(0);
  });

  it('playTankFireSound plays the baked tank-fire asset at half volume', () => {
    effects.playTankFireSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-tank-fire.32141.wav');
    expect(recording.plays[0].volume).toBe(effects.TANK_SCOUT_FIRE_VOLUME_SCALE);
    // The advance-cue no-gap delay is preserved.
    expect(recording.plays[0].delay).toBe(effects.TANK_ADVANCE_CUE_DURATION);
  });

  it('playScoutAdvanceCue plays the scout advance blip at half volume', () => {
    effects.playScoutAdvanceCue();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-scout-advance.32180.wav');
    expect(recording.plays[0].volume).toBe(effects.TANK_SCOUT_FIRE_VOLUME_SCALE);
    // The no-gap advance cue is not delayed.
    expect(recording.plays[0].delay).toBe(0);
  });

  it('playScoutFireSound plays the baked scout laser asset at half volume', () => {
    effects.playScoutFireSound();
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-scout-fire.32181.wav');
    expect(recording.plays[0].volume).toBe(effects.TANK_SCOUT_FIRE_VOLUME_SCALE);
    // The advance-cue no-gap delay is preserved.
    expect(recording.plays[0].delay).toBe(effects.SCOUT_ADVANCE_CUE_DURATION);
  });
});

// ── 3b. Shared player-weapon fire dispatcher (AH-0MV55O9R5005W6J0) ──

describe('playWeaponFireSound — shared player-fire path', () => {
  it('routes every active player weapon to its baked fire cue', () => {
    const cases: Array<[string, string]> = [
      ['cannon', 'playCannonFireSound'],
      ['spread', 'playSpreadFireSound'],
      ['dual', 'playDualFireSound'],
      ['rapid', 'playRapidFireSound'],
      ['nova', 'playNovaFireSound'],
      ['mortar', 'playMortarFireSound'],
      ['arc', 'playArcFireSound'],
      ['wave_laser', 'playWaveLaserFireSound'],
      ['ricochet', 'playRicochetFireSound'],
      ['cluster', 'playClusterFireSound'],
      ['options', 'playOptionsFireSound'],
    ];
    for (const [weaponId, cue] of cases) {
      recording.plays.length = 0;
      effects.playWeaponFireSound(weaponId as never);
      expect(recording.plays.length, `${weaponId} should play`).toBe(1);
      expect(recording.plays[0].url, `${weaponId}`).toBe(
        assetUrlFor(cueEntry(cue)),
      );
    }
  });

  it('passes the metronome reduced-volume option through to playback', () => {
    effects.playWeaponFireSound('cannon', { volume: 0.3 });
    expect(recording.plays[0].volume).toBe(0.3);
  });

  it('defaults to full volume when the overlay omits the option', () => {
    effects.playWeaponFireSound('cannon');
    expect(recording.plays[0].volume).toBe(1);
  });

  it('is a no-op for a weapon id without a baked fire cue', () => {
    // Every catalogue weapon now has a baked fire cue; an unknown id
    // degrades to a silent no-op (matches the per-weapon `_playShootCue`
    // switch behaviour).
    expect(() =>
      effects.playWeaponFireSound('not-a-catalogue-weapon' as never),
    ).not.toThrow();
    expect(recording.plays).toHaveLength(0);
  });

  it('plays the baked ricochet fire cue', () => {
    effects.playWeaponFireSound('ricochet');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-ricochet-fire.32267.wav');
  });

  it('plays the baked cluster-missile fire cue (AH-0MV822B1B0048UZT)', () => {
    effects.playWeaponFireSound('cluster');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-cluster-fire.32269.wav');
  });

  it('plays the baked options fire cue (AH-0MV822BDN008IYL6)', () => {
    effects.playWeaponFireSound('options');
    expect(recording.plays).toHaveLength(1);
    expect(recording.plays[0].url).toBe('audio/sfx/aihell-options-fire.32271.wav');
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

  it('forwards the shared beat clock so the hum pulses on the cannon grid', () => {
    const clock = createBeatClock();
    effects.setThrusterBeatClock(clock);
    clock.advance(
      beatSubdivisionMs(effects.THRUSTER_HUM_CANNON_SUBDIVISIONS) / 2,
    );

    effects.updateThrusterSound(1);
    const hum = effects._getThrusterHumStateForTests()!;
    expect(hum.currentGain).toBeCloseTo(
      effects.THRUSTER_HUM_MAX_VOLUME *
        (1 - effects.THRUSTER_HUM_AMPLITUDE_MODULATION_DEPTH),
      6,
    );

    // Detaching the clock restores the flat ceiling (no modulation).
    effects.setThrusterBeatClock(null);
    effects.updateThrusterSound(1);
    expect(hum.currentGain).toBeCloseTo(effects.THRUSTER_HUM_MAX_VOLUME, 6);
  });

  it('forwards the side profile (halved gain, one semitone up) through the seam', () => {
    effects.updateThrusterSound(0.8, 'side');
    const hum = effects._getThrusterHumStateForTests();
    expect(hum).not.toBeNull();
    expect(hum!.currentGain).toBeCloseTo(
      0.8 *
        effects.THRUSTER_HUM_MAX_VOLUME *
        effects.THRUSTER_HUM_SIDE_VOLUME_SCALE,
      6,
    );
    const ctx = RecordingAudioContext.instances[0];
    expect(lastSourceFrequency(ctx.oscillators[0])).toBeCloseTo(
      effects.THRUSTER_HUM_BASE_FREQ *
        (1 + 0.8 * 0.12) *
        effects.THRUSTER_HUM_SIDE_PITCH_SCALE,
      6,
    );
  });

  it('keeps the forward profile as the default for existing callers', () => {
    effects.updateThrusterSound(0.8);
    const hum = effects._getThrusterHumStateForTests();
    expect(hum!.currentGain).toBeCloseTo(
      0.8 * effects.THRUSTER_HUM_MAX_VOLUME,
      6,
    );
  });

  it('is a safe no-op without an AudioContext', () => {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    effects._resetAudioContextForTests();

    expect(() => effects.updateThrusterSound(0.5)).not.toThrow();
    expect(() => effects.stopThrusterSound()).not.toThrow();
    expect(effects._getThrusterHumStateForTests()).toBeNull();
  });
});

// ── 6. Beat-synchronised explosion accents (AC2–AC4, AC6) ─────────

describe('beat-synchronised explosion accents', () => {
  const SIXTEENTH_MS = beatSubdivisionMs(SIXTEENTH_NOTE_SUBDIVISIONS); // 187.5

  afterEach(() => {
    effects.setExplosionBeatClock(null);
  });

  it('schedules the enemy/Diver/player destruction cues on the next 16th note', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100); // 87.5 ms to the 187.5 ms tick

    effects.playDestructionSound();
    effects.playDiverDestructionSound();
    effects.playPlayerDestructionSound(0.5);

    expect(recording.plays).toHaveLength(3);
    for (const play of recording.plays) {
      expect(play.delay).toBeCloseTo((SIXTEENTH_MS - 100) / 1000, 6);
    }
    // Player destruction keeps its volume scaling alongside the delay.
    expect(recording.plays[2].volume).toBe(0.5);
  });

  it('fires immediately when the request is already on a tick', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(SIXTEENTH_MS);
    effects.playDestructionSound();
    expect(recording.plays[0].delay).toBe(0);
  });

  it('stacks several kills in one window onto the same tick (one accent)', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100);
    for (let i = 0; i < effects.EXPLOSION_PER_TICK_CAP; i += 1) {
      effects.playDestructionSound();
    }
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP);
    const delays = recording.plays.map((p) => p.delay);
    expect(new Set(delays).size).toBe(1);
    expect(delays[0]).toBeCloseTo((SIXTEENTH_MS - 100) / 1000, 6);
  });

  it('caps the per-tick accent so a mass kill cannot clip the mix', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100);
    for (let i = 0; i < effects.EXPLOSION_PER_TICK_CAP + 8; i += 1) {
      effects.playDestructionSound();
    }
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP);
  });

  it('opens a fresh accent window once the clock crosses the tick', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100);
    for (let i = 0; i < effects.EXPLOSION_PER_TICK_CAP; i += 1) {
      effects.playDestructionSound();
    }
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP);

    // Cross into the next 16th window: the cap resets.
    clock.advance(SIXTEENTH_MS - 100 + 1);
    effects.playDestructionSound();
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP + 1);
    expect(recording.plays[effects.EXPLOSION_PER_TICK_CAP].delay).toBeCloseTo(
      (2 * SIXTEENTH_MS - (SIXTEENTH_MS + 1)) / 1000,
      6,
    );
  });

  it('keeps weapon and interception cues immediate while a clock is registered', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100); // mid-window — the accent would be 87.5 ms

    effects.playMortarDetonationSound();
    effects.playNovaFireSound();
    effects.playMortarFireSound();
    effects.playArcFireSound();
    effects.playBulletDestructionSound();

    expect(recording.plays.length).toBeGreaterThan(0);
    for (const play of recording.plays) {
      expect(play.delay).toBe(0);
    }
  });

  it('re-derives the schedule after a scene restart (clock reset)', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100);
    for (let i = 0; i < effects.EXPLOSION_PER_TICK_CAP; i += 1) {
      effects.playDestructionSound();
    }
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP);

    // A run restart resets the grid to origin and re-registers the clock.
    clock.reset();
    effects.setExplosionBeatClock(clock);
    effects.playDestructionSound();

    // Back on the origin tick: immediate, with a fresh (not inherited) cap.
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP + 1);
    expect(recording.plays[effects.EXPLOSION_PER_TICK_CAP].delay).toBe(0);
  });

  it('does not queue audio into the future for a frozen clock', () => {
    const clock = createBeatClock();
    effects.setExplosionBeatClock(clock);
    clock.advance(100); // frozen mid-window; never advanced again
    for (let i = 0; i < effects.EXPLOSION_PER_TICK_CAP + 10; i += 1) {
      effects.playDestructionSound();
    }

    // Only the capped stack is queued, and every delay is bounded by one
    // 16th note so a paused scene leaks no open-ended scheduling.
    expect(recording.plays).toHaveLength(effects.EXPLOSION_PER_TICK_CAP);
    for (const play of recording.plays) {
      expect(play.delay).toBeGreaterThanOrEqual(0);
      expect(play.delay).toBeLessThanOrEqual(SIXTEENTH_MS / 1000);
    }
  });

  it('plays immediately when no beat clock is registered', () => {
    effects.setExplosionBeatClock(null);
    effects.playDestructionSound();
    expect(recording.plays[0].delay).toBe(0);
  });
});

// ── 7. Headless no-op (belt-and-suspenders with the contract suite) ─

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
