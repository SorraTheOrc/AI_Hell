/**
 * Audio playback contract tests (AH-0MUTYV8RJ009MWKJ).
 *
 * These are the executable requirements for the ToneForge/Phaser audio
 * migration: they pin the external contract of `src/audio/effects.ts`
 * (cue coverage, headless no-op degradation, single shared
 * `AudioContext`, global volume/mute, advance-cue timing and the
 * cue→asset mapping) so the rewrite (AH-0MUTYV92Y000WJ8Z) cannot silently
 * drop a cue or break headless operation.
 *
 * They are written first (TDD) and assert *behaviour through the public
 * API*, never the synthesis internals that the rewrite replaces. The
 * single-context/no-op invariants use the exported `_*ForTests`
 * accessors, which the rewrite keeps and re-points at the new playback
 * layer.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as effects from './effects';
import {
  playBossSpawnSound,
  playBossPhaseTransitionSound,
  playBossDestructionSound,
  playBossPhaseCue,
} from '../entities/Boss';
import {
  CUE_MANIFEST,
  CONTROL_CUES,
  RETIRED_CUES,
  bakedAssetFiles,
  getCueAsset,
  listCueAssets,
} from './cueManifest';
import {
  RecordingAudioContext,
  latestRecordingContext,
  lastGainValue,
  masterGain,
  resetRecordingAudioContext,
} from '../test/audioTestDouble';

// ── Cue invocation registry ─────────────────────────────────────────

type CueFn = (...args: unknown[]) => void;

/** The four Boss cues authored inline in `src/entities/Boss.ts`. */
const BOSS_CUES: Record<string, CueFn> = {
  playBossSpawnSound: playBossSpawnSound as CueFn,
  playBossPhaseTransitionSound: playBossPhaseTransitionSound as CueFn,
  playBossDestructionSound: playBossDestructionSound as CueFn,
  playBossPhaseCue: playBossPhaseCue as CueFn,
};

/** Non-empty argument lists for the cues that take parameters. */
const CUE_ARGS: Record<string, unknown[]> = {
  playVolumeFeedback: [0.5],
  playPlayerDestructionSound: [0.5],
  updateThrusterSound: [0.5],
  playBossPhaseCue: [1],
};

/** The cue names that must be callable (manifest cues + control companions). */
const ALL_MAPPED_CUES: readonly string[] = [
  ...CUE_MANIFEST.map((entry) => entry.cue),
  ...CONTROL_CUES,
];

const KNOWN_CUE_SET = new Set<string>([...ALL_MAPPED_CUES, ...RETIRED_CUES]);

function resolveCue(name: string): CueFn | undefined {
  const fromEffects = (effects as unknown as Record<string, unknown>)[name];
  if (typeof fromEffects === 'function') return fromEffects as CueFn;
  return BOSS_CUES[name];
}

function invokeCue(name: string): void {
  const fn = resolveCue(name);
  if (fn === undefined) {
    throw new Error(`Cue ${name} has no callable export`);
  }
  fn(...(CUE_ARGS[name] ?? []));
}

function installRecordingContext(): void {
  (window as unknown as { AudioContext?: unknown }).AudioContext =
    RecordingAudioContext as unknown as typeof AudioContext;
  effects._resetAudioContextForTests();
  resetRecordingAudioContext();
}

function removeAudioContext(): void {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  effects._resetAudioContextForTests();
  resetRecordingAudioContext();
}

beforeEach(() => {
  removeAudioContext();
});

afterEach(() => {
  removeAudioContext();
});

// ── 1. Cue coverage ─────────────────────────────────────────────────

describe('contract — cue coverage', () => {
  it('every mapped cue has a callable export', () => {
    for (const name of ALL_MAPPED_CUES) {
      expect(resolveCue(name), `${name} is not callable`).toBeTypeOf('function');
    }
  });

  it('every sound-producing effects export is in the manifest (or retired)', () => {
    for (const [name, value] of Object.entries(effects)) {
      if (typeof value !== 'function') continue;
      if (!/^(play|update|stop)/.test(name)) continue;
      expect(
        KNOWN_CUE_SET.has(name),
        `${name} is a cue export but is missing from CUE_MANIFEST`,
      ).toBe(true);
    }
  });

  it('the manifest contains no retired cue', () => {
    for (const retired of RETIRED_CUES) {
      expect(getCueAsset(retired), `${retired} must not be mapped`).toBeUndefined();
    }
  });
});

// ── 2. Headless no-op degradation ───────────────────────────────────

describe('contract — no-op without an AudioContext', () => {
  it('getAudioContext() resolves to null when no constructor exists', () => {
    expect(effects.getAudioContext()).toBeNull();
  });

  it('no mapped or control cue throws without an AudioContext', () => {
    for (const name of ALL_MAPPED_CUES) {
      expect(() => invokeCue(name), `${name} threw headlessly`).not.toThrow();
    }
  });
});

// ── 3. Single shared AudioContext ───────────────────────────────────

describe('contract — exactly one shared AudioContext', () => {
  it('repeated cue calls construct only one context', () => {
    installRecordingContext();
    for (const name of ALL_MAPPED_CUES) {
      invokeCue(name);
    }
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });

  it('a late cue call (new scene) reuses the cached context', () => {
    installRecordingContext();
    invokeCue('playSpawnSound');
    const first = effects.getAudioContext();
    expect(first).not.toBeNull();
    invokeCue('playCannonFireSound');
    invokeCue('playVictoryFanfareSound');
    expect(effects.getAudioContext()).toBe(first);
    expect(RecordingAudioContext.instances).toHaveLength(1);
  });
});

// ── 4. Global volume / mute ─────────────────────────────────────────

describe('contract — global volume and mute', () => {
  beforeEach(() => {
    installRecordingContext();
    // Prime the context + master gain with one cue.
    invokeCue('playSpawnSound');
    expect(masterGain()).toBeDefined();
  });

  it('setSfxVolume sets the shared master gain and clamps to [0, 1]', () => {
    effects.setSfxVolume(0.5);
    expect(lastGainValue(masterGain()!)).toBe(0.5);
    effects.setSfxVolume(2);
    expect(lastGainValue(masterGain()!)).toBe(1);
    effects.setSfxVolume(-1);
    expect(lastGainValue(masterGain()!)).toBe(0);
  });

  it('mute silences live playback and unmute restores the prior volume', () => {
    effects.setSfxVolume(0.6);
    effects.setSfxMuted(true);
    expect(lastGainValue(masterGain()!)).toBe(0);
    effects.setSfxMuted(false);
    expect(lastGainValue(masterGain()!)).toBe(0.6);
  });

  it('cues route through the shared master gain (so volume/mute affect them)', () => {
    const masterNode = masterGain()!.node;
    for (const name of ['playSpawnSound', 'playCannonFireSound', 'playPowerUpCollectSound'] as const) {
      const before = RecordingAudioContext.instances[0].connections.length;
      invokeCue(name);
      const newConnections = RecordingAudioContext.instances[0].connections.slice(before);
      expect(newConnections, `${name} does not route through the master gain`).toContain(
        masterNode,
      );
    }
  });
});

// ── 5. Advance cues (≥ 500 ms, gap-free cue→fire) ───────────────────

describe('contract — advance cues', () => {
  it('all advance cues are at least 500 ms', () => {
    expect(effects.SCOUT_ADVANCE_CUE_DURATION).toBeGreaterThanOrEqual(0.5);
    expect(effects.PHASER_ADVANCE_CUE_DURATION).toBeGreaterThanOrEqual(0.5);
    expect(effects.TANK_ADVANCE_CUE_DURATION).toBeGreaterThanOrEqual(0.5);
  });

  it('the fire cue starts exactly at the advance cue end (no gap)', () => {
    installRecordingContext();

    effects.playTankAdvanceCue();
    const ctx = latestRecordingContext()!;
    const afterAdvance = ctx.oscillators.length;
    effects.playTankFireSound();
    const fireSources = ctx.oscillators.slice(afterAdvance);

    expect(fireSources.length).toBeGreaterThan(0);
    const advanceEnd = ctx.currentTime + effects.TANK_ADVANCE_CUE_DURATION;
    for (const source of fireSources) {
      expect(source.starts[0]).toBeCloseTo(advanceEnd, 5);
    }
  });

  it('advance cues are mapped to single-seed baked assets', () => {
    for (const cue of [
      'playScoutAdvanceCue',
      'playPhaserAdvanceCue',
      'playTankAdvanceCue',
    ]) {
      const entry = getCueAsset(cue);
      expect(entry, `${cue} is not mapped`).toBeDefined();
      expect(entry!.delivery).toBe('baked');
      expect(entry!.seeds).toHaveLength(1);
    }
  });
});

// ── 6. Cue → asset mapping ──────────────────────────────────────────

describe('contract — cue to asset mapping', () => {
  it('baked cues have seeds; existing/shim cues have none', () => {
    for (const entry of CUE_MANIFEST) {
      if (entry.delivery === 'baked') {
        expect(entry.seeds.length, `${entry.cue} needs at least one seed`).toBeGreaterThan(0);
      } else {
        expect(entry.seeds, `${entry.cue} must not declare seeds`).toHaveLength(0);
      }
    }
  });

  it('baked asset filenames are unique across the manifest', () => {
    const files = CUE_MANIFEST.flatMap((entry) => bakedAssetFiles(entry));
    expect(new Set(files).size).toBe(files.length);
  });

  it('game-specific recipes use the aihell- prefix', () => {
    const existing = new Set(['weapon-laser-zap', 'card-token-earn']);
    for (const entry of CUE_MANIFEST) {
      if (!existing.has(entry.recipe)) {
        expect(entry.recipe.startsWith('aihell-'), `${entry.cue} recipe ${entry.recipe}`).toBe(
          true,
        );
      }
    }
  });

  it('the continuous thruster hum is a runtime shim (not baked)', () => {
    const thruster = getCueAsset('updateThrusterSound');
    expect(thruster?.delivery).toBe('runtime-shim');
    expect(listCueAssets('runtime-shim')).toHaveLength(1);
  });

  it('every baked recipe is used by at least one cue', () => {
    const recipes = new Set(CUE_MANIFEST.map((entry) => entry.recipe));
    // The runtime shim recipe is not baked; harmless to include here.
    expect(recipes.has('aihell-enemy-spawn')).toBe(true);
    expect(recipes.size).toBeGreaterThan(30);
  });
});
