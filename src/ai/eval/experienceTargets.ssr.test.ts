/**
 * SSR-load smoke test for the experience-validation core
 * (AH-0MV7WVHU0000U775 AC1/AC3).
 *
 * `scripts/validate-experience.mjs` loads the TS core through Vite's SSR
 * module loader (the same mechanism `scripts/evaluate.mjs` uses). This boots
 * that environment and proves three things a unit test cannot:
 *
 * 1. the module graph (`experienceTargets.ts` → `report.ts` → `metrics.ts`)
 *    loads under SSR with no Node-only imports;
 * 2. the **committed** targets artifact validates through the same code path;
 * 3. the comparator reaches the expected verdict against the recorded baseline
 *    aggregate shape and against a drifted one.
 *
 * The Vite boot is trimmed to what SSR loading needs (no dep optimizer, no
 * watcher) and happens in `beforeAll`, mirroring
 * `balanceConfig.ssr.test.ts`.
 *
 * @vitest-environment node
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';

import type {
  BalanceAggregate,
  ExperienceTargets,
  ExperienceValidationReport,
} from './index';

vi.setConfig({ testTimeout: 30000, hookTimeout: 180000 });

/** The slice of the core surface this smoke test needs. */
interface ExperienceCore {
  validateExperienceTargets(raw: unknown): ExperienceTargets;
  compareExperience(
    aggregate: BalanceAggregate,
    targets: ExperienceTargets,
  ): { passed: boolean; driftedMetrics: readonly string[] };
  readBalanceReportInput(raw: unknown): { kind: 'balance' };
  buildExperienceValidationReport(options: {
    report: { kind: 'balance' };
    targets: ExperienceTargets;
  }): ExperienceValidationReport;
  serialiseExperienceValidationReport(report: ExperienceValidationReport): string;
}

const TARGETS_PATH = path.resolve(process.cwd(), 'src/data/experience-targets.json');

let server: ViteDevServer | undefined;
let core: ExperienceCore | undefined;

beforeAll(async () => {
  server = await createServer({
    server: { middlewareMode: true, watch: null, hmr: false },
    appType: 'custom',
    logLevel: 'silent',
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  core = (await server.ssrLoadModule(
    '/src/ai/eval/experienceTargets.ts',
  )) as ExperienceCore;
});

afterAll(async () => {
  await server?.close();
});

/** Builds an aggregate matching the committed bands (the green case). */
function inBandAggregate(targets: ExperienceTargets): BalanceAggregate {
  const at = (centre: number) => ({
    count: 100,
    mean: centre,
    median: centre,
    min: centre,
    max: centre,
    stdDev: 0,
  });
  return {
    schemaVersion: 1,
    runs: 100,
    seeds: Array.from({ length: 100 }, (_, index) => index + 1),
    mineralsCollected: at(targets.bands.mineralsCollected.centre),
    powerUpsCollected: at(10),
    asteroidsDestroyed: at(12),
    avoidableHits: at(targets.bands.avoidableHits.centre),
    survivalSeconds: at(targets.bands.survivalSeconds.centre),
    waveReached: at(targets.bands.waveReached.centre),
    levelReached: at(targets.bands.levelReached.centre),
    upgradesSelected: {
      spread: at(targets.bands.upgradesSelected.centre),
    },
    enemiesKilledByArchetype: {},
  };
}

describe('experience-targets core under Vite SSR (CLI load path)', () => {
  it('validates the committed artifact through the SSR-loaded module', () => {
    expect(core).toBeDefined();
    if (!core) throw new Error('SSR boot failed in beforeAll');
    const targets = core.validateExperienceTargets(
      JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')),
    );
    expect(targets.kind).toBe('experience-targets');
    expect(targets.source.kind).toBe('bot-baseline');
    expect(targets.targetsVersion).toBeGreaterThanOrEqual(1);
  });

  it('passes an in-band aggregate and reports drift for an out-of-band one', () => {
    if (!core) throw new Error('SSR boot failed in beforeAll');
    const targets = core.validateExperienceTargets(
      JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')),
    );
    const inBand = core.compareExperience(inBandAggregate(targets), targets);
    expect(inBand.passed).toBe(true);
    expect(inBand.driftedMetrics).toEqual([]);

    const drifted = inBandAggregate(targets);
    const comparison = core.compareExperience(
      {
        ...drifted,
        // One hit per run is outside the baseline-derived 0 ± 0.5 band.
        avoidableHits: { ...drifted.avoidableHits, mean: 1, median: 1 },
      },
      targets,
    );
    expect(comparison.passed).toBe(false);
    expect(comparison.driftedMetrics).toEqual(['avoidableHits']);
  });

  it('serialises a validation report deterministically through the SSR core', () => {
    if (!core) throw new Error('SSR boot failed in beforeAll');
    const targets = core.validateExperienceTargets(
      JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')),
    );
    const report = core.readBalanceReportInput({
      kind: 'balance',
      schemaVersion: 1,
      datasetVersion: 2,
      config: { policies: ['human'] },
      aggregate: inBandAggregate(targets),
    });
    const first = core.serialiseExperienceValidationReport(
      core.buildExperienceValidationReport({ report, targets }),
    );
    const second = core.serialiseExperienceValidationReport(
      core.buildExperienceValidationReport({ report, targets }),
    );
    expect(first).toBe(second);
    const parsed = JSON.parse(first) as ExperienceValidationReport;
    expect(parsed.source.label).toBe('human');
    expect(parsed.verdict).toBe('pass');
  });
});
