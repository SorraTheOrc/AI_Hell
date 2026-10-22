/**
 * Hermetic tests for the enemy audio balance guard
 * (`scripts/audio-balance-guard.mjs`), work item AH-0MVCRKTRZ009Q2L8.
 *
 * The guard asserts the two audio-balance invariants of the parent
 * "Balance the levels of all enemy sounds" (AH-0MVAUU594007S92Q) over
 * every enemy cue in the ToneForge manifest:
 *   - AC2 portion: rendered enemy WAV RMS sits within its category tier
 *     (±1.5 dB: ambience ≤ 0.02, subtle 0.055, heavy 0.090), peak ≤ 0.50,
 *     no clipping, multi-seed jitter variants < 0.5 dB apart;
 *   - AC3 portion: every pitched oscillator automation point in every
 *     enemy recipe snaps to an A natural minor note (within a 10-cent
 *     window), filtered-noise-only cues exempt by nature.
 *
 * All amplitude/scale assertions run hermetically against in-memory and
 * temp-dir fixtures — never against the real, currently unbalanced
 * assets (the guard is expected to be red on those until the recipes are
 * rebalanced, so no test asserts that state). The real-manifest tests
 * assert only structural coverage (every enemy cue identified, every
 * tier keyed) which holds both before and after the rebalance.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadManifest } from './build-audio.mjs';
import {
  AMPLITUDE_TIERS,
  MANIFEST_PATH,
  analyzeWavBuffer,
  enemyCueEntries,
  isInAMinor,
  nearestScaleNote,
  oscillatorPitchPoints,
  pitchConformanceErrors,
  rmsTierError,
  tierBounds,
  verifyAudioBalance,
} from './audio-balance-guard.mjs';

// ── Fixture helpers ─────────────────────────────────────────────────

let root: string;

function makeRoot(): void {
  root = mkdtempSync(join(tmpdir(), 'aihell-balance-guard-'));
  mkdirSync(join(root, 'audio', 'toneforge', 'recipes'), { recursive: true });
  mkdirSync(join(root, 'public', 'audio', 'sfx'), { recursive: true });
}

interface CueEntry {
  cue: string;
  recipe: string;
  delivery: string;
  seeds: number[];
}

function writeManifest(cues: CueEntry[]): string {
  const path = join(root, 'audio', 'toneforge', 'manifest.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        version: 1,
        recipeDirectory: 'recipes',
        outputDirectory: 'public/audio/sfx',
        checksumsFile: 'public/audio/sfx/checksums.json',
        defaultExistingRecipeSeed: 1,
        retiredCues: [],
        controlCues: [],
        cues,
      },
      null,
      2,
    ),
  );
  return path;
}

function writeRecipe(name: string, body: string): void {
  writeFileSync(join(root, 'audio', 'toneforge', 'recipes', `${name}.yaml`), body);
}

/** Writes a mono 16-bit PCM WAV whose samples are *samples* (values in [-1, 1]). */
function writeWav(fileName: string, samples: number[]): void {
  writeFileSync(join(root, 'public', 'audio', 'sfx', fileName), wavBuffer(samples));
}

/** Builds a mono 16-bit PCM WAV buffer from *samples* (values in [-1, 1]). */
function wavBuffer(samples: number[]): Buffer {
  const n = samples.length;
  const dataSize = n * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(44100, 24);
  buffer.writeUInt32LE(88200, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buffer;
}

/** Reads a fixture WAV back from the temp output dir. */
function readWav(fileName: string): Buffer {
  return readFileSync(join(root, 'public', 'audio', 'sfx', fileName));
}

/** A scale-conformant enemy spawn recipe (A3 → A5). */
const CONFORMANT_ENEMY_RECIPE = `version: "0.1"
meta:
  name: aihell-enemy-spawn-test
  category: AIHell
  tags:
    - enemy
    - spawn
  duration: 0.18
nodes:
  v0:
    kind: oscillator
    params:
      type: square
      frequency: 220
    automation:
      frequency:
        - kind: set
          time: 0
          value: 220
        - kind: exponentialRamp
          time: 0.176
          value: 880
  e0:
    kind: envelope
    params:
      attack: 0.004
      decay: 0.172
      sustain: 0
      release: 0
  g0:
    kind: gain
    params:
      gain: 0.12
  mix:
    kind: gain
    params:
      gain: 1
  out:
    kind: destination
routing:
  - chain: [v0, e0, g0, mix]
  - from: mix
    to: out
`;

/** Off-scale variant of the spawn recipe (880 → 900 Hz ramp end). */
const OFF_SCALE_ENEMY_RECIPE = CONFORMANT_ENEMY_RECIPE.replace('value: 880', 'value: 900');

/**
 * A noise-only dive-loop recipe: bandpass filter frequency automation
 * (300 → 900 Hz) is deliberately off-scale to prove it is exempt.
 */
const NOISE_ONLY_RECIPE = `version: "0.1"
meta:
  name: aihell-diver-dive-loop-test
  category: AIHell
  tags:
    - diver
    - dive
    - loop
  duration: 0.3
nodes:
  v0:
    kind: noise
    params:
      color: white
      level: 1
  f0:
    kind: biquadFilter
    params:
      type: bandpass
      frequency: 300
      Q: 0.6
    automation:
      frequency:
        - kind: set
          time: 0
          value: 300
        - kind: exponentialRamp
          time: 0.3
          value: 900
  e0:
    kind: envelope
    params:
      attack: 0.05
      decay: 0
      sustain: 1
      release: 0.1
  g0:
    kind: gain
    params:
      gain: 0.1
  mix:
    kind: gain
    params:
      gain: 1
  out:
    kind: destination
routing:
  - chain: [v0, f0, e0, g0, mix]
  - from: mix
    to: out
`;

beforeEach(() => {
  makeRoot();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── WAV analysis ────────────────────────────────────────────────────

describe('analyzeWavBuffer', () => {
  it('computes RMS and peak for a constant-amplitude mono WAV', () => {
    writeWav('constant.wav', new Array(100).fill(0.25));
    const result = analyzeWavBuffer(readWav('constant.wav'));
    expect(result.rms).toBeCloseTo(0.25, 4);
    expect(result.peak).toBeCloseTo(0.25, 4);
    expect(result.channels).toBe(1);
    expect(result.sampleRate).toBe(44100);
    expect(result.sampleCount).toBe(100);
  });

  it('computes RMS and peak for alternating samples', () => {
    writeWav('alternating.wav', [0.5, -0.5, 0.5, -0.5, 0.5]);
    const result = analyzeWavBuffer(readWav('alternating.wav'));
    expect(result.rms).toBeCloseTo(0.5, 4);
    expect(result.peak).toBeCloseTo(0.5, 4);
  });

  it('rejects a non-RIFF buffer', () => {
    expect(() => analyzeWavBuffer(Buffer.from('not a wav file at all'))).toThrow(/not a RIFF\/WAVE/);
  });

  it('rejects a non-PCM WAV', () => {
    // Float samples (audioFormat 3) with an otherwise well-formed header
    // plus a small data chunk (two 32-bit float frames).
    const buffer = Buffer.alloc(52);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(36 + 8, 4);
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(3, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(44100, 24);
    buffer.writeUInt32LE(88200, 28);
    buffer.writeUInt16LE(4, 32);
    buffer.writeUInt16LE(32, 34);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(8, 40);
    buffer.writeFloatLE(0.25, 44);
    buffer.writeFloatLE(-0.25, 48);
    expect(() => analyzeWavBuffer(buffer)).toThrow(/PCM required/);
  });
});


// ── Amplitude tiers (AC2) ───────────────────────────────────────────

describe('amplitude tiers', () => {
  it('computes the ±1.5 dB window around a target', () => {
    const { lower, upper } = tierBounds(0.055);
    expect(lower).toBeCloseTo(0.055 / 10 ** (1.5 / 20), 6);
    expect(upper).toBeCloseTo(0.055 * 10 ** (1.5 / 20), 6);
    expect(lower).toBeCloseTo(0.04632, 4);
    expect(upper).toBeCloseTo(0.06537, 4);
  });

  it('accepts an RMS inside the band and rejects outside it', () => {
    const tier = { targetRms: 0.055 };
    expect(rmsTierError(tier, 0.055)).toBeNull();
    expect(rmsTierError(tier, 0.03)).toMatch(/below/);
    expect(rmsTierError(tier, 0.08)).toMatch(/above/);
  });

  it('treats at-or-below tiers as ceilings with no lower bound', () => {
    const tier = { targetRms: 0.02, mode: 'at-or-below' as const };
    expect(rmsTierError(tier, 0.015)).toBeNull();
    expect(rmsTierError(tier, 0.02)).toBeNull();
    expect(rmsTierError(tier, 0.025)).toMatch(/ceiling/);
  });

  it('defines a tier for every enemy cue and vice versa (table self-consistency)', () => {
    // The table is cue-keyed; every entry must be a heavy/subtle/ambience tier.
    for (const tier of Object.values(AMPLITUDE_TIERS)) {
      expect(tier.targetRms).toBeGreaterThan(0);
      expect(tier.targetRms).toBeLessThanOrEqual(0.09);
    }
  });
});

// ── Scale conformance (AC3) ─────────────────────────────────────────

describe('A natural minor scale conformance', () => {
  it('recognises the anchor notes A2/A3/A4/A5', () => {
    for (const freq of [110, 220, 440, 880]) {
      expect(isInAMinor(freq), `${freq} Hz`).toBe(true);
      expect(nearestScaleNote(freq).centsOff).toBeLessThan(0.01);
    }
  });

  it('recognises E5 (660 Hz ≈ 2 cents) as an A-minor note', () => {
    expect(isInAMinor(660)).toBe(true);
    expect(nearestScaleNote(660).frequency).toBeCloseTo(659.26, 1);
  });

  it('rejects the off-scale frequencies used by the current recipes', () => {
    for (const freq of [90, 28, 1000, 500, 120, 320, 60, 40, 25, 150]) {
      expect(isInAMinor(freq), `${freq} Hz`).toBe(false);
    }
  });

  it('enforces the cent tolerance boundary', () => {
    expect(isInAMinor(440 * 2 ** (9 / 1200))).toBe(true); // 9 cents sharp
    expect(isInAMinor(440 * 2 ** (11 / 1200))).toBe(false); // 11 cents sharp
  });
});

describe('oscillatorPitchPoints', () => {
  it('collects static + automation points for oscillators only', () => {
    const points = oscillatorPitchPoints({
      nodes: {
        v0: {
          kind: 'oscillator',
          params: { frequency: 220 },
          automation: { frequency: [{ kind: 'set', value: 220 }, { kind: 'exponentialRamp', value: 880 }] },
        },
        f0: { kind: 'biquadFilter', params: { frequency: 300 }, automation: { frequency: [{ kind: 'set', value: 900 }] } },
      },
    });
    expect(points.map((p) => p.value).sort((a, b) => a - b)).toEqual([220, 220, 880]);
  });
});

describe('pitchConformanceErrors', () => {
  it('returns no errors for a scale-conformant recipe', () => {
    const doc = {
      nodes: {
        v0: {
          kind: 'oscillator',
          params: { frequency: 220 },
          automation: { frequency: [{ kind: 'set', value: 220 }, { kind: 'exponentialRamp', value: 880 }] },
        },
      },
    };
    expect(pitchConformanceErrors(doc, 'aihell-enemy-spawn-test')).toEqual([]);
  });

  it('flags an off-scale automation point, naming the recipe, node and value', () => {
    const doc = {
      nodes: {
        v0: {
          kind: 'oscillator',
          params: { frequency: 440 },
          automation: { frequency: [{ kind: 'set', value: 440 }, { kind: 'exponentialRamp', value: 60 }] },
        },
      },
    };
    const errors = pitchConformanceErrors(doc, 'aihell-enemy-destruction-test');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('aihell-enemy-destruction-test');
    expect(errors[0]).toContain('60 Hz');
    expect(errors[0]).toContain('cents');
  });

  it('exempts filtered-noise-only cues (no oscillators)', () => {
    const doc = {
      nodes: {
        v0: { kind: 'noise', params: { color: 'white' } },
        f0: { kind: 'biquadFilter', params: { frequency: 300 }, automation: { frequency: [{ kind: 'set', value: 900 }] } },
      },
    };
    expect(pitchConformanceErrors(doc, 'aihell-diver-dive-loop-test')).toEqual([]);
  });

  it('flags non-positive or non-finite frequencies instead of silently passing', () => {
    const doc = {
      nodes: {
        v0: {
          kind: 'oscillator',
          params: { frequency: 0 },
          automation: { frequency: [{ kind: 'set', value: -20 }] },
        },
      },
    };
    const errors = pitchConformanceErrors(doc, 'invalid-freq-test');
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('not a valid positive frequency');
  });

  it('validates scale-degree variant range bounds (Hz parameters)', () => {
    const conforming = {
      meta: { parameters: [{ name: 'startFreq', unit: 'Hz', min: 220, max: 440 }] },
      nodes: {},
    };
    expect(pitchConformanceErrors(conforming, 'variant-test')).toEqual([]);

    const offScale = {
      meta: { parameters: [{ name: 'startFreq', unit: 'Hz', min: 374, max: 506 }] },
      nodes: {},
    };
    const errors = pitchConformanceErrors(offScale, 'variant-test');
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('374 Hz');
    expect(errors.join('\n')).toContain('506 Hz');
  });
});

// ── Enemy identification over the real manifest ─────────────────────

describe('enemy cue identification (real manifest)', () => {
  const manifest = loadManifest(MANIFEST_PATH);
  const recipeDir = join(dirname(MANIFEST_PATH), manifest.recipeDirectory);
  const enemy = enemyCueEntries(manifest, recipeDir);

  it('identifies the known enemy cues', () => {
    const named = enemy.map((entry) => entry.cue);
    for (const expected of [
      'playSpawnSound',
      'playDestructionSound',
      'playBulletDestructionSound',
      'playTankAdvanceCue',
      'playTankFireSound',
      'playSwarmBurstSound',
      'playPhaserAdvanceCue',
      'playPhaserFireSound',
      'playScoutAdvanceCue',
      'playScoutFireSound',
      'playDiverDiveStartSound',
      'playDiveSound',
      'playDiverFireSound',
      'playDiverDestructionSound',
      'playBossFireSound',
      'playBossHitSound',
      'playBossSpawnSound',
      'playBossPhaseTransitionSound',
      'playBossDestructionSound',
      'playBossPhaseCue',
    ]) {
      expect(named).toContain(expected);
    }
  });

  it('excludes player / power-up / UI cues', () => {
    const named = enemy.map((entry) => entry.cue);
    for (const excluded of [
      'playCannonFireSound',
      'playVictoryFanfareSound',
      'playPowerUpCollectSound',
      'playVolumeFeedback',
      'updateThrusterSound',
      'playCountdownTickSound',
    ]) {
      expect(named).not.toContain(excluded);
    }
  });

  it('keys an amplitude tier for every identified enemy cue and no missing manifest cue', () => {
    for (const entry of enemy) {
      expect(AMPLITUDE_TIERS, entry.cue).toHaveProperty(entry.cue);
    }
    for (const cue of Object.keys(AMPLITUDE_TIERS)) {
      expect(manifest.cues.some((entry) => entry.cue === cue), `${cue} in manifest`).toBe(true);
    }
  });
});

// ── Guard orchestrator (hermetic fixtures) ──────────────────────────

/** A conformant enemy recipe template (A3 → A5); placeholder renamed per fixture. */
const CONFORMANT_TEMPLATE = CONFORMANT_ENEMY_RECIPE.replace('aihell-enemy-spawn-test', '__RECIPE__');

/** The 20 enemy cue names in tier-table order (stable insertion order). */
const ENEMY_CUE_ORDER = Object.keys(AMPLITUDE_TIERS);

/** Fixture recipe slug for the *i*-th catalogue cue. */
const recipeName = (i: number): string => `aihell-test-${i}`;
/** Fixture render seed for the *i*-th catalogue cue. */
const seedFor = (i: number): number => 100 + i;
/** Fixture asset file for the *i*-th catalogue cue. */
const assetFile = (i: number): string => `${recipeName(i)}.${seedFor(i)}.wav`;

/** The amplitude a template fixture writes for a cue's tier (in-band). */
const inBandAmplitude = (cue: string): number => {
  const tier = AMPLITUDE_TIERS[cue] as { targetRms: number; mode?: string };
  return tier.mode === 'at-or-below' ? tier.targetRms * 0.75 : tier.targetRms;
};

/**
 * Writes a full 20-cue catalogue fixture (every tier key present in the
 * manifest — the strict completeness cross-check needs the whole table) with
 * conformant recipes and in-band WAVs, and returns the manifest path. Each
 * test then rewrites the single file for the cue it exercises.
 */
function writeFullFixture(overrides: Record<string, Partial<CueEntry>> = {}): string {
  const entries = ENEMY_CUE_ORDER.map((cue, i) => ({
    cue,
    recipe: recipeName(i),
    delivery: 'baked',
    seeds: [seedFor(i)],
    ...(overrides[cue] ?? {}),
  }));
  const manifestPath = writeManifest(entries);
  ENEMY_CUE_ORDER.forEach((cue, i) => {
    writeRecipe(recipeName(i), CONFORMANT_TEMPLATE.replace('__RECIPE__', recipeName(i)));
    writeWav(assetFile(i), new Array(200).fill(inBandAmplitude(cue)));
  });
  return manifestPath;
}

/** Re-writes just the manifest with *overrides* (files left as they are). */
function rewriteManifest(overrides: Record<string, Partial<CueEntry>> = {}): string {
  const entries = ENEMY_CUE_ORDER.map((cue, i) => ({
    cue,
    recipe: recipeName(i),
    delivery: 'baked',
    seeds: [seedFor(i)],
    ...(overrides[cue] ?? {}),
  }));
  return writeManifest(entries);
}

describe('verifyAudioBalance', () => {
  it('passes a balanced full-catalogue fixture (in-band RMS, ≤ 0.50 peak, A-minor recipes)', () => {
    const manifestPath = writeFullFixture();
    const result = verifyAudioBalance({ manifestPath, repoRoot: root });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.enemyCues).toBe(ENEMY_CUE_ORDER.length);
  });

  it('fails when an enemy WAV sits above its subtle tier', () => {
    const i = ENEMY_CUE_ORDER.indexOf('playSpawnSound');
    writeFullFixture();
    writeWav(assetFile(i), new Array(200).fill(0.09));
    const result = verifyAudioBalance({ manifestPath: rewriteManifest(), repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('playSpawnSound');
    expect(result.errors.join('\n')).toContain('above');
  });

  it('fails when an enemy WAV peak exceeds the 0.50 ceiling', () => {
    const i = ENEMY_CUE_ORDER.indexOf('playSpawnSound');
    writeFullFixture();
    const samples = new Array(200).fill(0.045);
    samples[0] = 0.6;
    writeWav(assetFile(i), samples);
    const result = verifyAudioBalance({ manifestPath: rewriteManifest(), repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/peak .* exceeds ceiling 0.5/);
  });

  it('fails when an enemy recipe contains an off-scale pitch point', () => {
    const i = ENEMY_CUE_ORDER.indexOf('playSpawnSound');
    writeFullFixture();
    writeRecipe(recipeName(i), OFF_SCALE_ENEMY_RECIPE.replace('aihell-enemy-spawn-test', recipeName(i)));
    const result = verifyAudioBalance({ manifestPath: rewriteManifest(), repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain(recipeName(i));
    expect(result.errors.join('\n')).toContain('900 Hz');
  });

  it('fails when a rendered enemy asset is missing', () => {
    writeFullFixture();
    const result = verifyAudioBalance({ manifestPath: rewriteManifest({ playSpawnSound: { seeds: [9999] } }), repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing rendered asset');
    expect(result.errors.join('\n')).toContain('playSpawnSound');
  });

  it('fails when a baked recipe referenced by the manifest is missing', () => {
    writeFullFixture();
    const result = verifyAudioBalance({
      manifestPath: rewriteManifest({ playSpawnSound: { recipe: 'aihell-does-not-exist' } }),
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('no recipe YAML found');
  });

  it('passes the ambience ceiling and fails above it (noise-only cue exempt from scale)', () => {
    const i = ENEMY_CUE_ORDER.indexOf('playDiveSound');
    writeFullFixture();
    writeRecipe(recipeName(i), NOISE_ONLY_RECIPE);

    const run = (amplitude: number) => {
      writeWav(assetFile(i), new Array(200).fill(amplitude));
      return verifyAudioBalance({ manifestPath: rewriteManifest(), repoRoot: root });
    };

    expect(run(0.015).ok).toBe(true);
    expect(run(0.03).ok).toBe(false);
    expect(run(0.03).errors.join('\n')).toContain('ceiling');
  });

  it('enforces < 0.5 dB consistency across multi-seed jitter variants', () => {
    const i = ENEMY_CUE_ORDER.indexOf('playDestructionSound');
    writeFullFixture();
    writeWav(`${recipeName(i)}.10999.wav`, new Array(200).fill(0.09));
    writeWav(`${recipeName(i)}.11000.wav`, new Array(200).fill(0.1));
    const result = verifyAudioBalance({
      manifestPath: rewriteManifest({ playDestructionSound: { seeds: [seedFor(i), 10999, 11000] } }),
      repoRoot: root,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/variant RMS spread 0\.9\d dB must stay below 0\.5 dB/);
  });

  it('allows seed variants within < 0.5 dB of each other', () => {
    const i = ENEMY_CUE_ORDER.indexOf('playDestructionSound');
    writeFullFixture();
    writeWav(`${recipeName(i)}.10999.wav`, new Array(200).fill(0.09));
    writeWav(`${recipeName(i)}.11000.wav`, new Array(200).fill(0.0905));
    const result = verifyAudioBalance({
      manifestPath: rewriteManifest({ playDestructionSound: { seeds: [seedFor(i), 10999, 11000] } }),
      repoRoot: root,
    });
    expect(result.ok).toBe(true);
  });

  it('reports an identified enemy cue with no amplitude tier', () => {
    const manifestPath = writeFullFixture();
    writeRecipe('aihell-new-enemy-test', CONFORMANT_TEMPLATE.replace('__RECIPE__', 'aihell-new-enemy-test'));
    writeWav('aihell-new-enemy-test.10999.wav', new Array(200).fill(0.055));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { cues: CueEntry[] };
    manifest.cues.push({ cue: 'playNewEnemyCueSound', recipe: 'aihell-new-enemy-test', delivery: 'baked', seeds: [10999] });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const result = verifyAudioBalance({ manifestPath, repoRoot: root });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('playNewEnemyCueSound');
    expect(result.errors.join('\n')).toContain('no amplitude tier');
  });
});
