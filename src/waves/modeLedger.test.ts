/**
 * Per-wave generation-mode ledger verification (AH-0MVSE7GWU0074H5I; parent
 * epic AH-0MVI5XXOU00954EA, producer Q3=c').
 *
 * The ledger published in the Game Design Document's default-campaign note
 * (§3.2) is generated from the shipped default curve and must stay in lockstep
 * with the config, the shipped CSV and the built campaign. These tests assert
 * that contract through the public config/campaign APIs and the generated
 * documentation block:
 *
 * - **AC1/AC2** — the ledger covers all 100 waves, uses all three modes, and
 *   matches both `defaultDifficultyCurves()` and the shipped
 *   `difficulty-curves.csv`; every recorded opening/mini-boss/showcase wave
 *   holds its curated mode, and no unlisted wave changes mode silently.
 * - **AC3** — every `dynamic` wave is a pure function of the seed, and the
 *   generated campaign passes R1–R4 across a multi-seed sweep.
 * - **AC4** — the no-conversion decision is recorded explicitly as a
 *   documented no-op and no filler wave is `dynamic`.
 * - **AC6** — every wave keeps `shootEnabled` correct for its level
 *   (levels 1–3 off, 4–10 on) for every seed.
 *
 * UK English throughout, per the project convention.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildModeLedger,
  countModes,
  extractModeLedgerBlock,
  renderModeLedgerBlock,
  SHOWCASE_WAVES,
} from './modeLedger';
import { buildSequencedLevels } from './sequencedLevels';
import { waveComposition } from './campaignVariety';
import type { LevelDefinition, WaveDefinition } from './Formations';
import {
  defaultDifficultyCurves,
  loadConfigs,
  loadDifficultyCurves,
} from '../core/configStore';
import {
  auditWaves,
  classifyWaveGroups,
  isOpeningWavePosition,
  OPENING_WAVE_POSITIONS,
  type BalancedWave,
} from '../core/waveBalance';
import { parseDifficultyCurves } from '../core/csv';
import type { DifficultyCurveRow } from '../core/configTypes';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const CSV_PATH = path.resolve(
  process.cwd(),
  'src/data/difficulty-curves.csv',
);

/** Seeds used for the determinism and rule-compliance sweep. */
const SEEDS = [0, 1, 2, 3, 5, 7, 42, 100, 255, 777, 999];

/** The default campaign for a seed, built through the public builder. */
function campaign(seed: number): LevelDefinition[] {
  return buildSequencedLevels(defaultDifficultyCurves(), undefined, { seed });
}

/** The ledger row key (`level:wave`). */
function keyOf(row: { level: number; wave: number }): string {
  return `${row.level}:${row.wave}`;
}

/** Sort config rows into campaign order. */
function campaignOrder(rows: readonly DifficultyCurveRow[]): DifficultyCurveRow[] {
  return [...rows].sort((a, b) => a.level - b.level || a.wave - b.wave);
}

/** The built wave for a ledger/config row. */
function builtWave(
  built: readonly LevelDefinition[],
  row: { level: number; wave: number },
): WaveDefinition {
  const level = built.find((candidate) => candidate.level === row.level);
  const wave = level?.waves[row.wave - 1];
  if (!wave) {
    throw new Error(`No built wave for L${row.level}W${row.wave}.`);
  }
  return wave;
}

/**
 * Audit the built campaign with the shared rule validator, mapping every
 * config row to its built wave (fixed waves are reported exempt by design).
 */
function auditCampaign(seed: number) {
  const rows = campaignOrder(defaultDifficultyCurves());
  const built = campaign(seed);
  const waves: BalancedWave[] = rows.map((row) => {
    const level = built.find((candidate) => candidate.level === row.level);
    const wave = builtWave(built, row);
    return {
      id: keyOf(row),
      groups: classifyWaveGroups(wave.groups),
      shootEnabled: wave.shootEnabled,
      isOpening: isOpeningWavePosition(row.level, row.wave),
      generation: row.generation ?? 'curve',
      ...(row.wave > 1 && level
        ? { previousComposition: waveComposition(level.waves[row.wave - 2]) }
        : {}),
    };
  });
  return auditWaves(waves);
}

describe('per-wave generation-mode ledger (AH-0MVSE7GWU0074H5I)', () => {
  const ledger = buildModeLedger();

  beforeAll(async () => {
    // Load the shipped CSV into the registry so `loadDifficultyCurves()`
    // reflects the file, not the computed fallback.
    await loadConfigs();
  });

  it('covers every one of the 100 waves exactly once (AC1/AC2)', () => {
    expect(ledger).toHaveLength(100);
    expect(new Set(ledger.map(keyOf)).size).toBe(100);

    for (let level = 1; level <= 10; level++) {
      const waves = ledger
        .filter((row) => row.level === level)
        .map((row) => row.wave);
      expect(waves).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    for (const row of ledger) {
      expect(row.levelName.length, keyOf(row)).toBeGreaterThan(0);
      expect(row.reason.length, keyOf(row)).toBeGreaterThan(0);
    }
  });

  it('derives every mode from the shipped default config (AC2)', () => {
    const config = new Map(
      campaignOrder(defaultDifficultyCurves()).map((row) => [
        keyOf(row),
        row.generation ?? 'curve',
      ]),
    );
    expect(config.size).toBe(100);

    for (const row of ledger) {
      expect(row.mode, keyOf(row)).toBe(config.get(keyOf(row)));
    }

    expect(countModes(ledger)).toEqual({
      dynamic: 5,
      curve: 10,
      fixed: 85,
    });
    for (const mode of ['curve', 'fixed', 'dynamic'] as const) {
      expect(ledger.some((row) => row.mode === mode), mode).toBe(true);
    }
  });

  it('matches the shipped difficulty-curves.csv exactly (AC2)', () => {
    const csv = parseDifficultyCurves(fs.readFileSync(CSV_PATH, 'utf8'));
    expect(csv).toHaveLength(100);

    const csvByKey = new Map(campaignOrder(csv).map((row) => [keyOf(row), row]));
    for (const row of ledger) {
      const shipped = csvByKey.get(keyOf(row));
      expect(shipped, keyOf(row)).toBeDefined();
      expect(row.mode, keyOf(row)).toBe(shipped!.generation ?? 'curve');
      expect(row.levelName, keyOf(row)).toBe(shipped!.levelName);
    }

    // The registry view (what the game loads at boot) agrees with the file.
    const registry = new Map(
      campaignOrder(loadDifficultyCurves()).map((row) => [
        keyOf(row),
        row.generation ?? 'curve',
      ]),
    );
    for (const row of ledger) {
      expect(registry.get(keyOf(row)), keyOf(row)).toBe(row.mode);
    }
  });

  it('pins every recorded opening, mini-boss and showcase wave to its curated mode (AC2)', () => {
    const byKey = new Map(ledger.map((row) => [keyOf(row), row]));

    for (const [level, wave] of OPENING_WAVE_POSITIONS) {
      const row = byKey.get(`${level}:${wave}`);
      expect(row, `L${level}W${wave}`).toBeDefined();
      expect(row!.role, `L${level}W${wave}`).toBe('opening');
      expect(row!.mode, `L${level}W${wave}`).toBe('dynamic');
    }

    const miniBosses = ledger.filter((row) => row.role === 'mini-boss');
    expect(miniBosses).toHaveLength(10);
    for (const row of miniBosses) {
      expect(row.wave, keyOf(row)).toBe(10);
      expect(row.mode, keyOf(row)).toBe('fixed');
      expect(
        (builtWave(campaign(0), row) as WaveDefinition & { miniBoss?: boolean })
          .miniBoss,
        keyOf(row),
      ).toBe(true);
    }

    const showcases = ledger.filter((row) => row.role === 'showcase');
    expect(new Set(showcases.map(keyOf))).toEqual(
      new Set(Object.keys(SHOWCASE_WAVES)),
    );
    for (const row of showcases) {
      expect(row.mode, keyOf(row)).toBe('fixed');
    }
  });

  it('records the filler-conversion decision as an explicit documented no-op (AC4)', () => {
    const gdd = fs.readFileSync(GDD_PATH, 'utf8');
    const block = extractModeLedgerBlock(gdd);
    expect(block).not.toBeNull();
    expect(block).toContain('Filler conversion decision (documented no-op)');
    expect(block).toContain('No filler wave is');

    for (const row of ledger.filter((candidate) => candidate.role === 'filler')) {
      expect(row.mode, keyOf(row)).toBe('fixed');
    }
  });

  it('publishes exactly the generated ledger block in the GDD (AC1/AC2/AC5)', () => {
    const gdd = fs.readFileSync(GDD_PATH, 'utf8');
    const block = extractModeLedgerBlock(gdd);
    expect(block).not.toBeNull();
    expect(block).toBe(renderModeLedgerBlock(ledger));
    expect(gdd).toContain('#### Default-campaign generation-mode ledger');
    expect(gdd).toContain('npm run generate:mode-ledger');

    // The CSV header links the ledger and states the final mix (AC5).
    const csv = fs.readFileSync(CSV_PATH, 'utf8');
    expect(csv).toContain('mode ledger');
    expect(csv).toContain('5 `dynamic`');
    expect(csv).toContain('10 `curve`');
    expect(csv).toContain('85 `fixed`');
  });

  it('reproduces each seed exactly and keeps every dynamic wave a pure function of it (AC3)', () => {
    const dynamicRows = ledger.filter((row) => row.mode === 'dynamic');
    expect(dynamicRows).toHaveLength(5);

    for (const seed of SEEDS) {
      expect(campaign(seed), `seed ${seed}`).toEqual(campaign(seed));
    }

    // Fixed and curve waves are seed-independent; only the ledger's dynamic
    // positions may differ across seeds.
    const base = campaign(0);
    for (const seed of SEEDS) {
      const built = campaign(seed);
      for (const row of ledger) {
        if (row.mode === 'dynamic') continue;
        expect(
          JSON.stringify(builtWave(built, row)),
          `seed ${seed} ${keyOf(row)} (${row.mode})`,
        ).toBe(JSON.stringify(builtWave(base, row)));
      }
    }

    // Different seeds may differ — and in the shipped campaign they do.
    const patterns = new Set(
      SEEDS.map((seed) =>
        dynamicRows
          .map((row) => waveComposition(builtWave(campaign(seed), row)))
          .join('|'),
      ),
    );
    expect(patterns.size).toBeGreaterThan(1);
  });

  it('keeps the generated campaign R1–R4 compliant across the multi-seed sweep (AC3)', () => {
    for (const seed of SEEDS) {
      const audit = auditCampaign(seed);
      const failures = audit.waves
        .filter((wave) => !wave.pass)
        .map(
          (wave) =>
            `${wave.id}: ${wave.rules.map((rule) => rule.message).join(' ')}`,
        );
      expect(audit.pass, `seed ${seed}: ${failures.join(' | ')}`).toBe(true);

      for (const row of ledger) {
        if (row.mode === 'fixed') continue;
        const verdict = audit.waves.find((wave) => wave.id === keyOf(row));
        expect(verdict, `seed ${seed} ${keyOf(row)}`).toBeDefined();
        expect(verdict!.exempt, `seed ${seed} ${keyOf(row)}`).toBe(false);
      }
    }
  });

  it('keeps shootEnabled correct for every level and seed (AC6)', () => {
    for (const seed of SEEDS) {
      const built = campaign(seed);
      for (const row of ledger) {
        expect(
          builtWave(built, row).shootEnabled,
          `seed ${seed} ${keyOf(row)} (level ${row.level})`,
        ).toBe(row.level >= 4);
      }
    }
  });
});
