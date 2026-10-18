#!/usr/bin/env node
/**
 * Enemy audio balance guard (AH-0MVCRKTRZ009Q2L8).
 *
 * Asserts the two audio-balance invariants of "Balance the levels of all
 * enemy sounds" (AH-0MVAUU594007S92Q) over every enemy cue in the
 * ToneForge manifest, so a future recipe edit that regresses the balance
 * fails the verify path instead of shipping silently:
 *
 *   AC2 — category-relative amplitude tiers: every rendered enemy WAV has
 *   an RMS inside its documented category tier (±1.5 dB: ambience
 *   `dive-loop` ≤ 0.02, subtle one-shots target 0.055, heavy one-shots
 *   (incl. scout fire post-AC4, AH-0MVCRR2H2007VPDU) target 0.090, a peak
 *   ≤ 0.50 (no clipping), and the multi-seed jitter variants
 *   (`playDestructionSound`, `playDiverDestructionSound`) stay internally
 *   consistent (< 0.5 dB across variants).
 *
 *   AC3 — A natural minor scale conformance: every pitched oscillator
 *   automation point (static frequency, `set`/ramp start, ramp end,
 *   waypoints) in every enemy recipe snaps to the nearest A natural minor
 *   note (`A B C D E F G`, equal temperament, A4 = 440 Hz), within a
 *   10-cent window that tolerates note snapping while rejecting arbitrary
 *   off-scale frequencies. Filtered-noise-only cues are conformant by
 *   nature (no oscillators) and are not checked; the `Meta.parameters`
 *   Hz ranges of the multi-seed jitter recipes are validated at their
 *   declared min/max bounds (the "scale-degree variant" ranges).
 *
 * Enemy cues are identified from the manifest by the recipe's
 * `meta.tags` (enemy family tags: enemy, tank, swarm, phaser, scout,
 * diver, boss, bullet). Amplitude tiers are keyed by cue name and mirror
 * parent AC2; the guard cross-checks that every identified enemy cue has
 * a tier and every tier key exists in the manifest, so the table cannot
 * silently fall out of sync with the cue catalogue.
 *
 * Run as part of the manifest's verify path (`npm run build-audio:verify`
 * chains it after `scripts/build-audio.sh --verify`) and standalone via
 * `node scripts/audio-balance-guard.mjs`.
 *
 * The guard is expected to fail on the currently committed (unbalanced)
 * assets and to pass once the recipes are rebalanced (AC2/AC3/AC4 of the
 * parent item). It is deterministic — it only reads committed inputs
 * (manifest, recipe YAML, rendered WAV bytes) and computes exact
 * arithmetic — and fast (tens of microseconds of parsing per asset).
 *
 * js-yaml is used to parse recipes, matching the ToneForge CLI's own
 * loader (it is a declared dependency of `toneforge` and is hoisted to
 * the repository's `node_modules`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';

import { assetFsPath, loadManifest, planRenderJobs } from './build-audio.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (the directory that contains `package.json`). */
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Path to the canonical build manifest (single source of truth). */
export const MANIFEST_PATH = join(REPO_ROOT, 'audio', 'toneforge', 'manifest.json');

/** Amplitude-tier band width in dB (parent AC2's ±1.5 dB window). */
export const TIER_BAND_DB = 1.5;

/** Peak-amplitude ceiling every enemy cue must stay at or below (AC2). */
export const PEAK_CEILING = 0.5;

/**
 * Cent window for "on an A-minor note" (AC3). Snapping a recipe value to
 * the nearest scale note can leave a small rounding error (integer Hz
 * rounding at sub-bass frequencies is worth a few cents); 10 cents is
 * comfortably above that and far below the ~21+ cents deviations the
 * guard exists to catch.
 */
export const SCALE_CENTS_TOLERANCE = 10;

/** Multi-seed variant spread window in dB (AC2: < 0.5 dB across variants). */
export const VARIANT_SPREAD_DB = 0.5;

/**
 * Enemy cues whose multi-seed assets are jitter variants of one another
 * (per-kill pitch variation) and must stay internally consistent in
 * amplitude (< VARIANT_SPREAD_DB) — the `aihell-enemy-destruction` and
 * `aihell-diver-destruction` recipe ranges (parent AC2).
 */
export const VARIANT_CONSISTENCY_CUES = new Set([
  'playDestructionSound',
  'playDiverDestructionSound',
]);

/**
 * Recipe tags identifying enemy-family cues. The tag list is the
 * programmatic source for "every enemy cue in the manifest".
 */
export const ENEMY_TAGS = new Set([
  'enemy',
  'tank',
  'swarm',
  'phaser',
  'scout',
  'diver',
  'boss',
  'bullet',
]);

/**
 * Enemy cues without an in-repo recipe to tag. Empty since AC4
 * (AH-0MVCRR2H2007VPDU) replaced the ToneForge-owned scout-fire asset
 * (`weapon-laser-zap`) with the in-repo `aihell-scout-fire` recipe
 * (tagged `scout`): every enemy cue now has an in-repo recipe to tag.
 */
export const ENEMY_CUE_EXTRAS = new Set();

/**
 * Amplitude tier per enemy cue, mirroring parent AC2:
 *   - ambience `dive-loop` is an at-or-below ceiling (mode `at-or-below`);
 *   - subtle one-shots (spawn, advance, light fires, dive-start,
 *     bullet-destruction) and heavy one-shots (destructions, tank-fire,
 *     boss-fire/hit/phase-cue/spawn, boss-phase-transition) are ±1.5 dB
 *     bands around the listed RMS target.
 * Keyed by cue name so the guard is robust to recipe renames.
 */
export const AMPLITUDE_TIERS = {
  // Ambience.
  playDiveSound: { targetRms: 0.02, mode: 'at-or-below' },
  // Subtle one-shots → target RMS 0.055.
  playSpawnSound: { targetRms: 0.055 },
  playTankAdvanceCue: { targetRms: 0.055 },
  playScoutAdvanceCue: { targetRms: 0.055 },
  playPhaserAdvanceCue: { targetRms: 0.055 },
  playPhaserFireSound: { targetRms: 0.055 },
  playDiverFireSound: { targetRms: 0.055 },
  playSwarmBurstSound: { targetRms: 0.055 },
  playDiverDiveStartSound: { targetRms: 0.055 },
  playBulletDestructionSound: { targetRms: 0.055 },
  // Heavy one-shots → target RMS 0.090.
  // Scout fire reclassified to Heavy under AC4 (AH-0MVCRR2H2007VPDU): the
  // near-clipping weapon-laser-zap replacement is gain-staged to 0.090.
  playScoutFireSound: { targetRms: 0.090 },
  playDestructionSound: { targetRms: 0.090 },
  playDiverDestructionSound: { targetRms: 0.090 },
  playBossDestructionSound: { targetRms: 0.090 },
  playTankFireSound: { targetRms: 0.090 },
  playBossFireSound: { targetRms: 0.090 },
  playBossHitSound: { targetRms: 0.090 },
  playBossPhaseCue: { targetRms: 0.090 },
  playBossSpawnSound: { targetRms: 0.090 },
  playBossPhaseTransitionSound: { targetRms: 0.090 },
};

/** A natural minor pitch classes (A B C D E F G) as MIDI pitch class. */
const A_MINOR_PITCH_CLASSES = new Set([9, 11, 0, 2, 4, 5, 7]);

// ── Amplitude analysis ──────────────────────────────────────────────

/**
 * Parses a RIFF/WAVE buffer (PCM 8/16-bit, mono or multi-channel) and
 * returns the RMS and peak amplitude of the audibly mixed samples
 * (channels averaged). Throws a descriptive error on anything else so a
 * guard can never silently skip an asset.
 */
export function analyzeWavBuffer(buffer) {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error('not a RIFF/WAVE file');
  }

  let fmt = null;
  let dataOffset = null;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    } else if (id === 'data' && dataOffset === null) {
      dataOffset = offset + 8;
      dataSize = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (fmt === null) throw new Error('no fmt chunk');
  if (dataOffset === null) throw new Error('no data chunk');
  if (fmt.audioFormat !== 1) {
    throw new Error(`unsupported WAV format (PCM required): audioFormat=${fmt.audioFormat}`);
  }
  if (fmt.bitsPerSample !== 8 && fmt.bitsPerSample !== 16) {
    throw new Error(`unsupported WAV bit depth: ${fmt.bitsPerSample}`);
  }
  const { channels } = fmt;
  const frames = Math.floor(dataSize / (fmt.bitsPerSample / 8)) / channels;
  if (frames < 1) throw new Error('empty audio data');

  let sumSquares = 0;
  let peak = 0;
  for (let i = 0; i < frames; i += 1) {
    let mixed = 0;
    for (let c = 0; c < channels; c += 1) {
      const byteOffset = dataOffset + (i * channels + c) * (fmt.bitsPerSample / 8);
      if (fmt.bitsPerSample === 16) {
        mixed += buffer.readInt16LE(byteOffset) / 32768;
      } else {
        mixed += (buffer.readUInt8(byteOffset) - 128) / 128;
      }
    }
    const sample = mixed / channels;
    sumSquares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
  }
  return {
    rms: Math.sqrt(sumSquares / frames),
    peak,
    channels,
    sampleRate: fmt.sampleRate,
    bitDepth: fmt.bitsPerSample,
    sampleCount: frames,
  };
}

/** The ±TIER_BAND_DB RMS window around a target (for the band modes). */
export function tierBounds(targetRms) {
  const factor = 10 ** (TIER_BAND_DB / 20);
  return { lower: targetRms / factor, upper: targetRms * factor };
}

/**
 * Returns a human-readable error string when *rms* violates *tier*, or
 * null when it conforms. `at-or-below` tiers (ambience) are ceilings with
 * no lower bound; every other tier is a ±TIER_BAND_DB band.
 */
export function rmsTierError(tier, rms) {
  if (tier.mode === 'at-or-below') {
    if (rms > tier.targetRms) {
      return `RMS ${rms.toFixed(4)} exceeds ambience ceiling ${tier.targetRms}`;
    }
    return null;
  }
  const { lower, upper } = tierBounds(tier.targetRms);
  if (rms < lower) {
    return `RMS ${rms.toFixed(4)} is below tier [${lower.toFixed(4)}, ${upper.toFixed(4)}] ` +
      `(target ${tier.targetRms} \u00b1${TIER_BAND_DB} dB)`;
  }
  if (rms > upper) {
    return `RMS ${rms.toFixed(4)} is above tier [${lower.toFixed(4)}, ${upper.toFixed(4)}] ` +
      `(target ${tier.targetRms} \u00b1${TIER_BAND_DB} dB)`;
  }
  return null;
}

// ── Scale conformance (A natural minor) ─────────────────────────────

/** MIDI note number (float) for a frequency, A4 = 440 Hz. */
export function midiForFreq(freq) {
  return 69 + 12 * Math.log2(freq / 440);
}

/**
 * The nearest A natural minor note to *freq*: `{ note, frequency,
 * centsOff }` where `note` is the MIDI number of the scale degree,
 * `frequency` the equal-temperament frequency of that scale note and
 * `centsOff` the absolute distance in cents from it. Scale pitch classes
 * are A B C D E F G (MIDI 9 11 0 2 4 5 7); a window of six semitones
 * around the float MIDI position is guaranteed to contain at least one
 * scale note.
 */
export function nearestScaleNote(freq) {
  if (!(freq > 0) || !Number.isFinite(freq)) {
    // Invalid recipe frequencies (0, negative, NaN) are never conformant.
    return { note: -1, frequency: NaN, centsOff: Infinity };
  }
  const midi = midiForFreq(freq);
  const searchStart = Math.floor(midi) - 2;
  let bestNote = null;
  let bestCents = Infinity;
  for (let k = searchStart; k < searchStart + 6; k += 1) {
    const pc = ((k % 12) + 12) % 12;
    if (!A_MINOR_PITCH_CLASSES.has(pc)) continue;
    const scaleFreq = 440 * 2 ** ((k - 69) / 12);
    const cents = 1200 * Math.log2(freq / scaleFreq);
    if (Math.abs(cents) < bestCents) {
      bestCents = Math.abs(cents);
      bestNote = { note: k, frequency: scaleFreq };
    }
  }
  return { ...bestNote, centsOff: bestCents };
}

/** True when *freq* is within SCALE_CENTS_TOLERANCE of an A-minor note. */
export function isInAMinor(freq) {
  return nearestScaleNote(freq).centsOff <= SCALE_CENTS_TOLERANCE;
}

/**
 * Collects every pitched oscillator frequency point in a parsed recipe
 * (static `params.frequency` plus every `automation.frequency` segment
 * value — the start/end/waypoint frequencies). Filter and noise nodes are
 * deliberately excluded: filtered-noise-only cues are conformant by
 * nature (parent AC3).
 */
export function oscillatorPitchPoints(doc) {
  const points = [];
  for (const [id, node] of Object.entries(doc?.nodes ?? {})) {
    if (node?.kind !== 'oscillator') continue;
    if (typeof node.params?.frequency === 'number') {
      points.push({ node: id, source: 'static', value: node.params.frequency });
    }
    for (const segment of node.automation?.frequency ?? []) {
      if (segment && typeof segment.value === 'number') {
        points.push({ node: id, source: `${segment.kind}@${segment.time}`, value: segment.value });
      }
    }
  }
  return points;
}

/**
 * Scale-conformance errors for a parsed enemy recipe: every oscillator
 * pitch point, plus the declared Hz `meta.parameters` min/max bounds of
 * the multi-seed jitter ranges (the "scale-degree variant" ranges), must
 * land on an A natural minor note. Returns an array of human-readable
 * errors (empty when fully conformant).
 */
export function pitchConformanceErrors(doc, recipeName, { centsTolerance = SCALE_CENTS_TOLERANCE } = {}) {
  const errors = [];
  for (const point of oscillatorPitchPoints(doc)) {
    const nearest = nearestScaleNote(point.value);
    if (nearest.centsOff === Infinity) {
      errors.push(
        `${recipeName}: oscillator ${point.node} ${point.source} ${point.value} Hz is not a valid positive frequency`,
      );
    } else if (nearest.centsOff > centsTolerance) {
      errors.push(
        `${recipeName}: oscillator ${point.node} ${point.source} ${point.value} Hz is ` +
          `${nearest.centsOff.toFixed(1)} cents from the nearest A-minor note ` +
          `(${nearest.frequency.toFixed(2)} Hz, MIDI ${nearest.note})`,
      );
    }
  }
  for (const parameter of doc?.meta?.parameters ?? []) {
    if (parameter?.unit !== 'Hz') continue;
    for (const bound of ['min', 'max']) {
      const value = parameter[bound];
      if (typeof value !== 'number') continue;
      const nearest = nearestScaleNote(value);
      if (nearest.centsOff === Infinity) {
        errors.push(
          `${recipeName}: parameter ${parameter.name}.${bound} ${value} Hz is not a valid positive frequency`,
        );
      } else if (nearest.centsOff > centsTolerance) {
        errors.push(
          `${recipeName}: parameter ${parameter.name}.${bound} ${value} Hz is ` +
            `${nearest.centsOff.toFixed(1)} cents from the nearest A-minor note ` +
            `(${nearest.frequency.toFixed(2)} Hz) — scale-degree variant ranges must be A-minor`,
        );
      }
    }
  }
  return errors;
}

// ── Enemy cue identification ────────────────────────────────────────

/** The recipe YAML tags for *recipeName*, or `[]` when it has no in-repo file. */
export function recipeTags(recipeDir, recipeName) {
  const path = join(recipeDir, `${recipeName}.yaml`);
  if (!existsSync(path)) return [];
  const doc = yaml.load(readFileSync(path, 'utf8'));
  return Array.isArray(doc?.meta?.tags) ? doc.meta.tags : [];
}

/**
 * The enemy cue entries of the manifest: every entry whose recipe is
 * tagged with an enemy-family tag (baked, in-repo recipes) plus every
 * explicit non-baked enemy cue (playScoutFireSound).
 */
export function enemyCueEntries(manifest, recipeDir) {
  return manifest.cues.filter(
    (entry) =>
      ENEMY_CUE_EXTRAS.has(entry.cue) ||
      recipeTags(recipeDir, entry.recipe).some((tag) => ENEMY_TAGS.has(tag)),
  );
}

// ── Guard —──────────────────────────────────────────────────────────

/**
 * Loads and parses an in-repo ToneForge recipe YAML, failing closed when
 * the file is missing so a manifest↔recipe drift is never silent.
 */
export function loadRecipe(recipeDir, recipeName) {
  const path = join(recipeDir, `${recipeName}.yaml`);
  if (!existsSync(path)) {
    throw new Error(`manifest references baked recipe ${recipeName} but no recipe YAML found: ${path}`);
  }
  return yaml.load(readFileSync(path, 'utf8'));
}

/**
 * Runs the full enemy balance guard over the committed manifest, recipes
 * and rendered WAV assets. Returns `{ ok, errors, enemyCues }`.
 *
 * Hard failures (all reported as `errors`): a manifest that references a
 * missing baked recipe, an enemy cue with no amplitude tier (or a tier
 * key with no manifest cue), a missing/unreadable rendered asset, a WAV
 * outside its tier or above the peak ceiling, a multi-seed jitter cue
 * whose variant amplitude spread violates the < 0.5 dB window, or an
 * oscillator pitch point / scale-degree range bound off the A-minor
 * scale.
 */
export function verifyAudioBalance({
  manifestPath = MANIFEST_PATH,
  repoRoot = REPO_ROOT,
  logger,
} = {}) {
  const errors = [];
  const manifest = loadManifest(manifestPath);
  const recipeDir = join(dirname(manifestPath), manifest.recipeDirectory);
  const jobs = planRenderJobs(manifest);

  // Fail closed on manifest↔recipe drift before any balance judgement.
  for (const entry of manifest.cues) {
    if (entry.delivery !== 'baked') continue;
    try {
      loadRecipe(recipeDir, entry.recipe);
    } catch (error) {
      errors.push(error.message);
    }
  }

  const enemy = enemyCueEntries(manifest, recipeDir);
  if (enemy.length === 0) {
    errors.push('no enemy cues identified in the manifest — cannot guard the balance');
  }

  // Cross-checks so the cue-keyed tier table cannot silently fall out of
  // sync with the manifest / tag-driven identification.
  for (const cue of Object.keys(AMPLITUDE_TIERS)) {
    if (!manifest.cues.some((entry) => entry.cue === cue)) {
      errors.push(`amplitude tier defined for ${cue} but no such cue in the manifest`);
    }
  }
  for (const entry of enemy) {
    if (!(entry.cue in AMPLITUDE_TIERS)) {
      errors.push(`enemy cue ${entry.cue} (recipe ${entry.recipe}) has no amplitude tier — add it to AMPLITUDE_TIERS`);
    }
  }

  const assetsByRecipe = new Map();
  for (const job of jobs) {
    const list = assetsByRecipe.get(job.recipe) ?? [];
    list.push({ ...job, absPath: assetFsPath(repoRoot, job.assetPath) });
    assetsByRecipe.set(job.recipe, list);
  }

  for (const entry of enemy) {
    const tier = AMPLITUDE_TIERS[entry.cue];
    if (!tier) continue; // already reported by the cross-check above

    // ── AC2: amplitude tiers over the rendered assets ──
    const assets = assetsByRecipe.get(entry.recipe) ?? [];
    if (assets.length === 0) {
      errors.push(`no rendered asset planned for enemy cue ${entry.cue} (recipe ${entry.recipe})`);
      continue;
    }
    const analyses = [];
    for (const asset of assets) {
      let analysis;
      try {
        analysis = analyzeWavBuffer(readFileSync(asset.absPath));
      } catch (error) {
        if (error.code === 'ENOENT') {
          errors.push(`missing rendered asset for enemy cue ${entry.cue}: ${asset.assetPath}`);
        } else {
          errors.push(`cannot analyse ${asset.assetPath} for cue ${entry.cue}: ${error.message}`);
        }
        continue;
      }
      analyses.push(analysis);
      const rmsError = rmsTierError(tier, analysis.rms);
      if (rmsError) {
        errors.push(`${entry.cue} (${asset.assetPath}): ${rmsError}`);
      }
      if (analysis.peak > PEAK_CEILING) {
        errors.push(
          `${entry.cue} (${asset.assetPath}): peak ${analysis.peak.toFixed(4)} exceeds ceiling ${PEAK_CEILING}`,
        );
      }
    }

    // AC2: multi-seed jitter variants internally consistent (< 0.5 dB).
    if (VARIANT_CONSISTENCY_CUES.has(entry.cue)) {
      const rmsValues = analyses.map((analysis) => analysis.rms).filter((value) => value > 0);
      if (rmsValues.length > 1) {
        const spreadDb = 20 * Math.log10(Math.max(...rmsValues) / Math.min(...rmsValues));
        if (spreadDb >= VARIANT_SPREAD_DB) {
          errors.push(
            `${entry.cue}: seed variant RMS spread ${spreadDb.toFixed(2)} dB must stay below ${VARIANT_SPREAD_DB} dB`,
          );
        }
      }
    }

    // ── AC3: A-minor scale conformance over the in-repo recipe ──
    if (entry.delivery === 'baked') {
      let doc;
      try {
        doc = loadRecipe(recipeDir, entry.recipe);
      } catch (error) {
        errors.push(error.message); // already reported above; keep going
        continue;
      }
      errors.push(...pitchConformanceErrors(doc, entry.recipe));
    }
  }

  const result = { ok: errors.length === 0, errors, enemyCues: enemy.length };
  logger?.log?.(`enemy balance guard: ${enemy.length} enemy cues checked`);
  return result;
}

const USAGE = `Usage: node scripts/audio-balance-guard.mjs [--manifest <path>] [--repo-root <path>]

Asserts the enemy audio balance invariants (AC2 amplitude tiers + AC3
A-minor scale conformance) over every enemy cue in the ToneForge manifest.

  --manifest   path to the build manifest (default audio/toneforge/manifest.json)
  --repo-root  repository root containing public/audio/sfx (default: repo root)
  --help       show this help

Run as part of "npm run build-audio:verify".
`;

/** CLI entry point. Returns a process exit code. */
export function main(argv = process.argv.slice(2), { logger = console } = {}) {
  const args = { manifestPath: MANIFEST_PATH, repoRoot: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--manifest') args.manifestPath = resolve(argv[++i]);
    else if (arg === '--repo-root') args.repoRoot = resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      logger.log(USAGE);
      return 0;
    } else {
      logger.error(`Unknown argument: ${arg}`);
      logger.error(USAGE);
      return 2;
    }
  }
  const result = verifyAudioBalance({ logger });
  if (!result.ok) {
    logger.error('Enemy audio balance guard failed:');
    for (const error of result.errors) logger.error(`  - ${error}`);
    return 1;
  }
  logger.log(`Enemy audio balance guard OK (${result.enemyCues} enemy cues checked).`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = main();
}
