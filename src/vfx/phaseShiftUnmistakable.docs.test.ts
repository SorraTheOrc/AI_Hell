/**
 * Docs guard for the unmistakable Phase Shift / wormhole-emergence treatment
 * (parent AH-0MVNTR89P0022JIU, docs child AH-0MVNTY1FB0052QDL).
 *
 * GDD §7.2 must be the single place a designer can retune or toggle the final
 * treatment from, so this test pins the section to the **real** tunables:
 *
 *  - the aggressive activation edge (flash + distortion burst + wider surge),
 *  - the soft sustained state (pulsing split + vignette bands + gentle filter),
 *  - the per-enemy outline/flicker and the wormhole ring/shockwave,
 *  - the distinctness decision (no camera shake, never death juice),
 *  - the WebGL-only camera filters and the overlay-only degradation path, and
 *  - the accessibility note (flicker cap, per-layer toggles, reduce-motion as a
 *    separate unbuilt idea).
 *
 * Like the sibling `endOfRunJuice.docs.test.ts`, this is a deliberate docs
 * grep: the acceptance criterion *is* the canonical documentation text, and a
 * silently drifting GDD is the failure mode being guarded. To keep the guard
 * honest the expected magnitudes are read out of the shipped source files
 * rather than duplicated here, so a code retune that forgets the docs fails
 * this test instead of passing against a stale literal.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const PHASE_SOURCE = path.resolve(process.cwd(), 'src/vfx/phaseShiftJuice.ts');
const FILTER_SOURCE = path.resolve(process.cwd(), 'src/vfx/cameraFilters.ts');
const WORMHOLE_SOURCE = path.resolve(process.cwd(), 'src/vfx/wormholeSpawn.ts');

/** §7.2 only — the rest of the GDD must not be able to satisfy these checks. */
function readSection72(): string {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const start = gdd.indexOf('### 7.2 Visual Style');
  const end = gdd.indexOf('### 7.3 ', start);
  expect(start, 'GDD must contain the "### 7.2 Visual Style" heading').toBeGreaterThanOrEqual(0);
  expect(end, 'GDD must contain the "### 7.3 " heading after §7.2').toBeGreaterThan(start);
  return gdd.slice(start, end);
}

/**
 * Reads an exported constant's literal value out of a source file.
 *
 * The docs guard must not carry its own copy of the magnitudes, so the value
 * is taken from the shipped declaration (`export const NAME = <value>`), with
 * any `as const` suffix and the type annotation stripped.
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
  const pattern = new RegExp('`' + name + '`\\s*(\\[[^\\]]*\\]|[^\\s,;)]+)', 'g');
  const values: string[] = [];
  for (const match of section.matchAll(pattern)) {
    const raw = match[1].trim();
    values.push(
      raw.startsWith('[')
        ? raw
        : raw
            // Drop markdown/typographic decoration and unit suffixes so
            // "±26 px" and "(240 ms)" compare equal to `26` / `240`.
            .replace(/^[^0-9x-]+/, '')
            .replace(/\s*(px|ms|s|%)$/, ''),
    );
  }
  return values;
}

/**
 * Asserts §7.2 documents `name` with the value the source actually ships.
 *
 * Exact string equality (not a substring match) means `0.45` cannot be
 * satisfied by a stale `0.4`, and a retuned constant with a stale doc fails.
 */
function expectDocumented(
  section: string,
  source: string,
  name: string,
): void {
  const expected = constantValue(source, name);
  const values = documentedValues(section, name);
  expect(
    values,
    `GDD §7.2 must document \`${name}\` with its shipped value (${expected})`,
  ).toContain(expected);
}

/** Asserts a toggle (and any other named export) is listed by name. */
function expectNamed(section: string, name: string): void {
  expect(section).toContain(`\`${name}\``);
}

describe('GDD §7.2 documents the unmistakable Phase Shift treatment', () => {
  const section = readSection72();
  const phase = fs.readFileSync(PHASE_SOURCE, 'utf8');
  const filters = fs.readFileSync(FILTER_SOURCE, 'utf8');
  const wormhole = fs.readFileSync(WORMHOLE_SOURCE, 'utf8');

  it('names the shared modules and the single advance point for game and gyms', () => {
    expect(section).toContain('src/vfx/phaseShiftJuice.ts');
    expect(section).toContain('src/vfx/cameraFilters.ts');
    expect(section).toContain('src/vfx/wormholeSpawn.ts');
    expect(section).toContain('CombatCoreScene._updatePhaseShiftJuice');
    expect(section).toContain('updateSpawnEmergence');
    expect(section).toContain('spawnWormholeOpen');
    // Game + gym consumers, so the parity contract is documented.
    expect(section).toContain('PlayScene');
    expect(section).toContain('GymFormationScene');
    expect(section).toContain('GymPowerUpsCombat');
    expect(section).toContain('GymLevel');
    expect(section).toContain('wormholeEffects');
  });

  it('documents the aggressive activation edge with its real tunables', () => {
    // The three structural layers fired on the rising edge.
    expect(section).toMatch(/activation edge/i);
    expect(section).toMatch(/phase flash/i);
    expect(section).toMatch(/distortion burst/i);
    expect(section).toMatch(/surge/i);

    for (const name of [
      'PHASE_SHIFT_FLASH_COLOR',
      'PHASE_SHIFT_FLASH_ALPHA',
      'PHASE_SHIFT_FLASH_DURATION_MS',
      'PHASE_SHIFT_BURST_ALPHA',
      'PHASE_SHIFT_BURST_OFFSET',
      'PHASE_SHIFT_BURST_DURATION_MS',
    ]) {
      expectDocumented(section, phase, name);
    }
    expectDocumented(section, filters, 'PHASE_FILTER_BURST_DURATION_MS');
  });

  it('documents the soft sustained state with its real tunables', () => {
    for (const name of [
      'PHASE_SHIFT_DIM_COLOR',
      'PHASE_SHIFT_DIM_ALPHA',
      'PHASE_SHIFT_SPLIT_COLOR_CYAN',
      'PHASE_SHIFT_SPLIT_COLOR_RED',
      'PHASE_SHIFT_SPLIT_ALPHA',
      'PHASE_SHIFT_SPLIT_OFFSET',
      'PHASE_SHIFT_OSCILLATION_AMPLITUDE',
      'PHASE_SHIFT_OSCILLATION_PERIOD',
      'PHASE_SHIFT_FLICKER_HZ',
      'PHASE_SHIFT_FLICKER_DEPTH',
      'PHASE_SHIFT_COLOUR_PULSE_RANGE',
      'PHASE_SHIFT_VIGNETTE_COLOR',
      'PHASE_SHIFT_VIGNETTE_ALPHA',
      'PHASE_SHIFT_VIGNETTE_BANDS',
      'PHASE_SHIFT_VIGNETTE_BAND_WIDTH',
      'PHASE_SHIFT_OVERLAY_DEPTH',
    ]) {
      expectDocumented(section, phase, name);
    }
    expectDocumented(section, filters, 'PHASE_FILTER_SUSTAINED_BARREL_AMOUNT');
    expectDocumented(section, filters, 'PHASE_FILTER_BARREL_NEUTRAL_AMOUNT');
    // Sustained layers are described as the *soft* half of the treatment.
    expect(section).toMatch(/sustained/i);
    expect(section).toMatch(/vignette/i);
  });

  it('lists every player per-layer toggle', () => {
    for (const name of [
      'PHASE_SHIFT_ENABLE_DIM',
      'PHASE_SHIFT_ENABLE_SPLIT',
      'PHASE_SHIFT_ENABLE_BURST',
      'PHASE_SHIFT_ENABLE_SHIMMER',
      'PHASE_SHIFT_ENABLE_FLASH',
      'PHASE_SHIFT_ENABLE_VIGNETTE',
      'PHASE_SHIFT_ENABLE_DISTORTION',
      'PHASE_SHIFT_ENABLE_SUSTAINED_FILTER',
    ]) {
      expectNamed(section, name);
    }
  });

  it('documents the per-enemy outline/flicker tunables and toggles', () => {
    for (const name of [
      'ENEMY_SHIMMER_BURST_DURATION_MS',
      'ENEMY_SHIMMER_BURST_ALPHA_BOOST',
      'ENEMY_SHIMMER_BURST_SCALE_BOOST',
      'ENEMY_SHIMMER_FLICKER_HZ',
      'ENEMY_SHIMMER_ALPHA_MIN',
      'ENEMY_SHIMMER_ALPHA_MAX',
      'ENEMY_SHIMMER_SCALE_AMOUNT',
      'ENEMY_SHIMMER_COLOUR_PULSE_RANGE',
      'ENEMY_SHIMMER_COLOUR_PULSE_PERIOD',
      'ENEMY_SHIMMER_OUTLINE_RADIUS',
      'ENEMY_SHIMMER_OUTLINE_LINE_WIDTH',
      'ENEMY_SHIMMER_OUTLINE_COLOR',
      'ENEMY_SHIMMER_OUTLINE_PULSE_HZ',
      'ENEMY_SHIMMER_OUTLINE_ALPHA_MIN',
      'ENEMY_SHIMMER_OUTLINE_ALPHA_MAX',
    ]) {
      expectDocumented(section, wormhole, name);
    }
    for (const name of [
      'ENEMY_SHIMMER_ENABLE_BURST',
      'ENEMY_SHIMMER_ENABLE_SHIMMER',
      'ENEMY_SHIMMER_ENABLE_COLOUR_PULSE',
      'ENEMY_SHIMMER_ENABLE_OUTLINE',
    ]) {
      expectNamed(section, name);
    }
    // Per-entity only: no screen-wide overlay on the emergence path.
    expect(section).toMatch(/per-entity/i);
    expect(section).toMatch(/no screen-wide overlay/i);
  });

  it('documents the wormhole ring and one-shot open shockwave tunables', () => {
    for (const name of [
      'WORMHOLE_RING_COLOR',
      'WORMHOLE_RING_RADIUS',
      'WORMHOLE_RING_LINE_WIDTH',
      'WORMHOLE_RING_GLOW_ALPHA',
      'WORMHOLE_RING_PULSE_RANGE',
      'WORMHOLE_RING_PULSE_DURATION_MS',
      'WORMHOLE_SHOCKWAVE_COLOR',
      'WORMHOLE_SHOCKWAVE_RADIUS',
      'WORMHOLE_SHOCKWAVE_LINE_WIDTH',
      'WORMHOLE_SHOCKWAVE_ALPHA',
      'WORMHOLE_SHOCKWAVE_DURATION_MS',
      'WORMHOLE_SHOCKWAVE_SCALE_RANGE',
    ]) {
      expectDocumented(section, wormhole, name);
    }
    for (const name of ['WORMHOLE_RING_ENABLE', 'WORMHOLE_SHOCKWAVE_ENABLE']) {
      expectNamed(section, name);
    }
    // One-shot (not looping) and torn down with the wormhole container.
    expect(section).toMatch(/one-shot/i);
    expect(section).toMatch(/repeat: 0/);
  });

  it('documents why there is no camera shake and how it stays distinct from death juice', () => {
    expect(section).toMatch(/no camera shake/i);
    expect(section).toMatch(/camera\.shake/);
    expect(section).toMatch(/player-death juice/i);
    // The phase flash palette must never be the death flash colour.
    expect(section).toContain('PLAYER_DEATH_FLASH_COLOR');
    expectDocumented(section, phase, 'PHASE_SHIFT_FLASH_COLOR');
  });

  it('documents the WebGL-only filters and the overlay-only degradation path', () => {
    expect(section).toMatch(/WebGL/);
    expect(section).toContain('supportsCameraFilters');
    expect(section).toMatch(/overlay-only/);
    expect(section).toMatch(/without throwing/);
    expect(section).toMatch(/degrad/i);
    // Exact teardown: only this driver's controllers are removed.
    expect(section).toContain('clear()');
    expect(section).toContain('SHUTDOWN');
  });

  it('carries the accessibility note and flags reduce-motion as a separate, unbuilt idea', () => {
    expect(section).toMatch(/capped at 3 Hz/i);
    expect(section).toContain('ENEMY_SHIMMER_FLICKER_HZ');
    expect(section).toMatch(/per-layer toggle|own `PHASE_SHIFT_ENABLE_\*` toggle|toggle/i);
    expect(section).toMatch(/reduce-motion/i);
    expect(section).toMatch(/not-yet-built/i);
    expect(section).toMatch(/no in-game toggle exists today/i);
  });

  it('no longer carries the pre-upgrade "subtle" magnitudes', () => {
    // These exact stale pairings were removed by the unmistakable upgrade;
    // they must not creep back in beside the correct values.
    expect(section).not.toContain('`WORMHOLE_RING_RADIUS` 52');
    expect(section).not.toContain('`WORMHOLE_RING_LINE_WIDTH` 3 px');
    expect(section).not.toContain('`WORMHOLE_RING_GLOW_ALPHA` 0.45');
    expect(section).not.toContain('`ENEMY_SHIMMER_BURST_ALPHA_BOOST` 0.15');
    expect(section).not.toContain('`ENEMY_SHIMMER_BURST_SCALE_BOOST` 0.06');
    expect(section).not.toMatch(/subtle glow\/pulse ring/);
  });
});
