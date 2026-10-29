/**
 * Docs guard for the Orbital Strike power-up's identity
 * (parent AH-0MVRE6N08001TE4V, docs child AH-0MVS2T5N30031SL5, parent AC9).
 *
 * The strike's identity — the descending bolt and impact flash, the dedicated
 * `aihell-orbital-strike` cue, the retained (never silently wasted) bolt and
 * the HUD `next in Ns` countdown — must be documented where a designer or
 * maintainer looks for it: the GDD §4.4.3 power-up section, beside the
 * mechanics, following the "Thorn Field visibility + recharge" precedent.
 * The cue must also stay catalogued in `docs/AUDIO_TONEFORGE_CUE_MAPPING.md`
 * and consistent with the executable manifest and recipe it describes.
 *
 * Like the sibling `phaseShiftUnmistakable.docs.test.ts`, this is a deliberate
 * docs grep: the acceptance criterion *is* the canonical documentation text,
 * so a silently drifting GDD or cue catalogue is the failure mode being
 * guarded. To keep the guard honest, magnitudes are read out of the shipped
 * source files (and the cue's seed/duration out of the manifest and recipe)
 * rather than duplicated here — a retune that forgets the docs fails this
 * test instead of passing against a stale literal.
 *
 * Behaviour (the bolt composition, the retention and the countdown) is pinned
 * by `orbitalStrike.test.ts`, `orbitalStrikeRetention.test.ts` and
 * `HUD.test.ts`; this file only guards the documentation contract.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getCueAsset } from '../audio/cueManifest';
import { POWER_UP_LEVEL_SPECS } from '../powerups/powerUpLevels';
import {
  STRIKE_INTERVAL_BEATS_BASE,
  STRIKE_INTERVAL_BEATS_FLOOR,
} from '../core/constants';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const CUE_MAPPING_PATH = path.resolve(
  process.cwd(),
  'docs/AUDIO_TONEFORGE_CUE_MAPPING.md',
);
const VFX_SOURCE = path.resolve(process.cwd(), 'src/vfx/orbitalStrike.ts');
const RECIPES_DIR = path.resolve(process.cwd(), 'audio/toneforge/recipes');

const STRIKE_CUE = 'playOrbitalStrikeSound';
const STRIKE_RECIPE = 'aihell-orbital-strike';

/** §4.4.3 only — the rest of the GDD must not be able to satisfy these checks. */
function readSection443(): string {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const start = gdd.indexOf('#### 4.4.3 Power-Up Leveling');
  const end = gdd.indexOf('#### 4.4.4 ', start);
  expect(
    start,
    'GDD must contain the "#### 4.4.3 Power-Up Leveling" heading',
  ).toBeGreaterThanOrEqual(0);
  expect(end, 'GDD must contain the "#### 4.4.4 " heading after §4.4.3').toBeGreaterThan(
    start,
  );
  return gdd.slice(start, end);
}

/**
 * Reads an exported constant's literal value out of a source file.
 *
 * The docs guard must not carry its own copy of the magnitudes, so the value
 * is taken from the shipped declaration (`export const NAME = <value>`), with
 * any `as const` suffix and a type annotation stripped.
 */
function constantValue(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export const ${name}\\s*(?::[^=]+)?=\\s*([^;]+);`),
  );
  if (!match) throw new Error(`export const ${name} not found in source`);
  return match[1].trim().replace(/^['"]|['"]$/g, '').replace(/\s+as const$/, '');
}

/** Captures the value the docs state immediately after a backticked name. */
function documentedValues(section: string, name: string): string[] {
  const pattern = new RegExp('`' + name + '`\\s*([^\\s,;)]+)', 'g');
  const values: string[] = [];
  for (const match of section.matchAll(pattern)) {
    values.push(
      match[1]
        .trim()
        // Drop markdown/typographic decoration and unit suffixes so
        // "(14 px)" compares equal to `14`.
        .replace(/^[^0-9x-]+/, '')
        .replace(/\s*(px|ms|s|%)$/, ''),
    );
  }
  return values;
}

/** Asserts §4.4.3 documents `name` with the value the source actually ships. */
function expectDocumented(section: string, source: string, name: string): void {
  const expected = constantValue(source, name);
  expect(
    documentedValues(section, name),
    `GDD §4.4.3 must document \`${name}\` with its shipped value (${expected})`,
  ).toContain(expected);
}

/** The single cue-mapping table row describing the strike cue. */
function cueRow(mapping: string): string {
  const row = mapping
    .split('\n')
    .find((line) => line.startsWith(`| \`${STRIKE_CUE}\` |`));
  expect(
    row,
    `docs/AUDIO_TONEFORGE_CUE_MAPPING.md must carry a \`${STRIKE_CUE}\` row`,
  ).toBeDefined();
  return row!;
}

/** The single recipe-table row describing the strike recipe. */
function recipeRow(mapping: string): string {
  const row = mapping
    .split('\n')
    .find((line) => line.startsWith(`| \`${STRIKE_RECIPE}\` |`));
  expect(
    row,
    `docs/AUDIO_TONEFORGE_CUE_MAPPING.md must carry a \`${STRIKE_RECIPE}\` row`,
  ).toBeDefined();
  return row!;
}

/** The recipe's authored duration, read out of its ToneForge YAML. */
function recipeDuration(): string {
  const yaml = fs.readFileSync(
    path.join(RECIPES_DIR, `${STRIKE_RECIPE}.yaml`),
    'utf8',
  );
  const match = yaml.match(/^\s+duration:\s*([\d.]+)\s*$/m);
  if (!match) throw new Error(`${STRIKE_RECIPE}.yaml does not declare a duration`);
  return match[1];
}

describe('GDD §4.4.3 documents the Orbital Strike power-up identity (AC9)', () => {
  const section = readSection443();
  const vfx = fs.readFileSync(VFX_SOURCE, 'utf8');

  it('names the shared VFX module, the strike seam and the game + gym consumers', () => {
    expect(section).toContain('src/vfx/orbitalStrike.ts');
    expect(section).toContain('spawnOrbitalStrike');
    expect(section).toContain('CombatCoreScene._updateOrbitalStrike');
    // The retention seam (never silently wasted) and the HUD projection.
    expect(section).toContain('src/powerups/effects.ts');
    expect(section).toContain('strikeNextBoltSeconds');
    // Gym↔game parity: the same code in the game and every gym.
    expect(section).toContain('PlayScene');
    expect(section).toMatch(/gym/);
  });

  it('documents the descending bolt and impact flash with the shipped tunables', () => {
    expect(section).toMatch(/descending bolt/i);
    expect(section).toMatch(/impact flash/i);
    expect(section).toMatch(/shock ring/i);
    // Distinctness is stated structurally, not as a recolour of the ring.
    expect(section).toMatch(/geometric, not chromatic/i);
    expect(section).toContain('spawnNovaRing');

    for (const name of [
      'ORBITAL_STRIKE_BOLT_WIDTH',
      'ORBITAL_STRIKE_DURATION',
    ]) {
      expectDocumented(section, vfx, name);
    }
  });

  it('documents the dedicated cue, its recipe and where it fires', () => {
    expect(section).toContain(`\`${STRIKE_CUE}\``);
    expect(section).toContain(`\`${STRIKE_RECIPE}\``);
    // The cue is owned by the VFX module and fires on impact, not at spawn.
    expect(section).toMatch(/at the bolt.s impact/i);
    // And it is a baked asset, not an ad-hoc synthesis.
    expect(section).toMatch(/baked/i);
  });

  it('documents the retained bolt and the one-bolt cap', () => {
    expect(section).toMatch(/never spent silently|not spent silently/i);
    expect(section).toMatch(/retained/i);
    // No live enemy / no live player are the two retention conditions.
    expect(section).toMatch(/no live enemy/i);
    expect(section).toMatch(/no live player/i);
    // At most one bolt — a gap cannot bank a volley.
    expect(section).toMatch(/at most \*\*one\*\* bolt|at most one bolt/i);
    expect(section).toContain('updateStrike');
    expect(section).toContain('resolveStrike');
  });

  it('documents the permanent strike HUD countdown', () => {
    expect(section).toMatch(/next in Ns/);
    expect(section).toMatch(/countdown/i);
  });

  it('documents the beat-aligned ~7 s cadence with the shipped level spec', () => {
    // The producer's rejection (2026-10-29) asked for a ~7 s first-grant
    // cadence on the audio system's BPM grid, so the docs must state the
    // shipped values (read from the level spec, never duplicated here) and
    // the beat-grid rationale that produced them.
    const intervalSpec = POWER_UP_LEVEL_SPECS.strike.find(
      (s) => s.variable === 'strikeInterval',
    )!;
    expect(section).toContain(`${intervalSpec.base} s`);
    expect(section).toContain(`${intervalSpec.cap} s`);
    expect(section).toContain(`${STRIKE_INTERVAL_BEATS_BASE} beats`);
    expect(section).toContain(`${STRIKE_INTERVAL_BEATS_FLOOR} beats`);
    expect(section).toMatch(/80 BPM/);
    // First grant is within half a beat of the requested 7 s.
    expect(Math.abs(intervalSpec.base - 7)).toBeLessThanOrEqual(0.375);
  });

  it('records the hazard as non-regressed rather than changed', () => {
    expect(section).toContain('src/entities/OrbitalStrike.ts');
    expect(section).toMatch(/non-regression|untouched/i);
    // The hazard keeps its borrowed cue; the power-up has its own.
    expect(section).toContain('playScoutAdvanceCue');
  });
});

describe('cue catalogue documents the strike cue without drifting (AC9)', () => {
  const mapping = fs.readFileSync(CUE_MAPPING_PATH, 'utf8');

  it('maps the cue to its own baked recipe with the manifested seed', () => {
    const entry = getCueAsset(STRIKE_CUE);
    expect(entry, `manifest must register ${STRIKE_CUE}`).toBeDefined();
    expect(entry!.recipe).toBe(STRIKE_RECIPE);
    expect(entry!.delivery).toBe('baked');

    const cue = cueRow(mapping);
    expect(cue).toContain(`\`${STRIKE_RECIPE}\``);
    expect(cue).toMatch(/Orbital Strike power-up/);
    // The row names the shipped consumer path, not a planned one.
    expect(cue).toContain('AH-0MVS2T0VQ00973W5');

    const recipe = recipeRow(mapping);
    for (const seed of entry!.seeds) {
      expect(recipe).toContain(String(seed));
    }
  });

  it('states the authored recipe duration and its two-act structure', () => {
    const duration = recipeDuration();
    expect(cueRow(mapping)).toContain(`${duration} s`);
    expect(recipeRow(mapping)).toContain(`${duration} s`);
    expect(recipeRow(mapping)).toMatch(/two-act/i);
    // The impact cue is not an alias of the neighbouring AOE cues.
    expect(cueRow(mapping)).toMatch(/distinct|dedicated|signature/i);
  });
});
