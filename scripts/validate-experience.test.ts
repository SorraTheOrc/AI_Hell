/**
 * Shell tests for the periodic experience-validation CLI
 * (AH-0MV7WVHU0000U775 AC3/AC4).
 *
 * The CLI's filesystem work is exercised against **real temp-dir files**: the
 * versioned JSON report and Markdown summary are written, a drift result exits
 * non-zero, the same inputs yield byte-identical artifacts, and the
 * re-baseline mode derives a valid targets artifact. The pure core is injected
 * (`src/ai/eval/experienceTargets.ts`) so the shell never boots Vite — the SSR
 * loader is a thin, untested-here wrapper (mirroring `evaluate.mjs`'s
 * established pattern).
 *
 * @vitest-environment node
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as core from '../src/ai/eval/experienceTargets';
import {
  deriveTargets,
  main,
  parseValidateExperienceArgs,
  VALIDATION_JSON_ARTIFACT,
  VALIDATION_MARKDOWN_ARTIFACT,
  validateExperience,
  VALIDATE_EXPERIENCE_USAGE,
  type ParsedValidateExperienceArgs,
} from './validate-experience.mjs';

/** A silent io pair that records what the CLI printed. */
function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out: { write: (text: string) => out.push(text) },
    err: { write: (text: string) => err.push(text) },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

/** A distribution summary. */
function dist(mean: number, stdDev: number) {
  return { count: 10, mean, median: mean, min: mean - stdDev, max: mean + stdDev, stdDev };
}

/** A balance report whose aggregate matches the committed-style targets. */
function balanceReportJson(overrides: Record<string, unknown> = {}): string {
  const aggregate = {
    schemaVersion: 1,
    runs: 10,
    seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    mineralsCollected: dist(5, 1),
    powerUpsCollected: dist(1, 0.2),
    asteroidsDestroyed: dist(2, 0.5),
    avoidableHits: dist(1, 0.3),
    survivalSeconds: dist(30, 5),
    waveReached: dist(6, 2),
    levelReached: dist(1.2, 0.4),
    upgradesSelected: { spread: dist(1, 0.4), shield: dist(0.5, 0.2) },
    enemiesKilledByArchetype: { scout: dist(4, 1) },
    ...(overrides.aggregate as Record<string, unknown> | undefined),
  };
  return JSON.stringify({
    datasetVersion: 2,
    schemaVersion: 1,
    kind: 'balance',
    config: {
      policies: ['competent'],
      seeds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      ticks: 18_000,
      dt: 1 / 60,
      sampleEveryTicks: 1,
      campaign: true,
    },
    runs: [],
    aggregate,
  });
}

/** Writes a targets + report fixture pair into a temp root. */
function fixtureRoot(): {
  root: string;
  reportPath: string;
  targetsPath: string;
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'experience-'));
  const reportPath = join(root, 'balance-report.json');
  writeFileSync(reportPath, balanceReportJson());
  const targets = core.deriveExperienceTargets(
    JSON.parse(balanceReportJson()).aggregate,
    {
      kind: 'bot-baseline',
      policy: 'competent',
      games: 10,
      ticks: 18_000,
      campaign: true,
      level: null,
      sampleEveryTicks: 1,
      seeds: { count: 10, first: 1, last: 10 },
    },
  );
  const targetsPath = join(root, 'experience-targets.json');
  writeFileSync(targetsPath, `${core.serialiseExperienceTargets(targets)}\n`);
  return { root, reportPath, targetsPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Parses args and fills in fixture paths for a validate run. */
function validateOptions(
  root: string,
  reportPath: string,
  targetsPath: string,
  extra: string[] = [],
): ParsedValidateExperienceArgs {
  return parseValidateExperienceArgs([
    reportPath,
    '--targets',
    targetsPath,
    '--out',
    join(root, 'out'),
    ...extra,
  ]);
}

describe('parseValidateExperienceArgs', () => {
  it('applies documented defaults', () => {
    const options = parseValidateExperienceArgs([]);
    expect(options).toMatchObject({
      reportFile: null,
      targetsFile: 'src/data/experience-targets.json',
      outputDir: 'experience-out',
      json: false,
      baselineFile: null,
      targetsOut: 'src/data/experience-targets.json',
      targetsVersion: null,
      help: false,
    });
  });

  it('parses the report positional and the flags', () => {
    const options = parseValidateExperienceArgs([
      'balance-report.json',
      '--targets',
      't.json',
      '--out',
      'out',
      '--json',
    ]);
    expect(options.reportFile).toBe('balance-report.json');
    expect(options.targetsFile).toBe('t.json');
    expect(options.outputDir).toBe('out');
    expect(options.json).toBe(true);
  });

  it('parses the re-baseline mode flags', () => {
    const options = parseValidateExperienceArgs([
      '--baseline',
      'baseline.json',
      '--targets-out',
      'src/data/experience-targets.json',
      '--targets-version',
      '3',
    ]);
    expect(options.baselineFile).toBe('baseline.json');
    expect(options.targetsOut).toBe('src/data/experience-targets.json');
    expect(options.targetsVersion).toBe(3);
  });

  it('rejects an unknown flag, a missing value and two report paths', () => {
    expect(() => parseValidateExperienceArgs(['--nope'])).toThrow(/Unknown argument/);
    expect(() => parseValidateExperienceArgs(['--targets'])).toThrow(/Missing value/);
    expect(() =>
      parseValidateExperienceArgs(['a.json', 'b.json']),
    ).toThrow(/at most one balance report/);
  });
});

describe('validateExperience (AC3/AC4)', () => {
  it('writes both artifacts and exits 0 when every metric is in band', async () => {
    const fixture = fixtureRoot();
    try {
      const io = recordingIo();
      const code = await validateExperience(
        validateOptions(fixture.root, fixture.reportPath, fixture.targetsPath),
        io,
        core,
        fixture.root,
      );
      expect(code).toBe(0);
      const json = JSON.parse(
        readFileSync(join(fixture.root, 'out', VALIDATION_JSON_ARTIFACT), 'utf8'),
      );
      expect(json.kind).toBe('experience-validation');
      expect(json.verdict).toBe('pass');
      expect(json.passed).toBe(true);
      expect(json.source.label).toBe('bot:competent');
      expect(json.metrics).toHaveLength(core.EXPERIENCE_TRACKED_METRICS.length);
      const markdown = readFileSync(
        join(fixture.root, 'out', VALIDATION_MARKDOWN_ARTIFACT),
        'utf8',
      );
      expect(markdown).toContain('**PASS**');
      expect(io.stdout()).toContain(markdown.trim());
      expect(io.stdout()).toContain('Wrote 2 artifact(s)');
      expect(io.stderr()).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  it('exits non-zero and names the drifted metric when a metric is out of band', async () => {
    const fixture = fixtureRoot();
    try {
      writeFileSync(
        fixture.reportPath,
        balanceReportJson({ aggregate: { survivalSeconds: dist(1, 0.2) } }),
      );
      const io = recordingIo();
      const code = await validateExperience(
        validateOptions(fixture.root, fixture.reportPath, fixture.targetsPath),
        io,
        core,
        fixture.root,
      );
      expect(code).toBe(1);
      expect(io.stdout()).toContain('Drift detected: survivalSeconds');
      const json = JSON.parse(
        readFileSync(join(fixture.root, 'out', VALIDATION_JSON_ARTIFACT), 'utf8'),
      );
      expect(json.verdict).toBe('drift');
      expect(json.driftedMetrics).toEqual(['survivalSeconds']);
    } finally {
      fixture.cleanup();
    }
  });

  it('prints the JSON report with --json while still writing both artifacts', async () => {
    const fixture = fixtureRoot();
    try {
      const io = recordingIo();
      const code = await validateExperience(
        validateOptions(fixture.root, fixture.reportPath, fixture.targetsPath, ['--json']),
        io,
        core,
        fixture.root,
      );
      expect(code).toBe(0);
      expect(io.stdout()).toContain('"kind":"experience-validation"');
      expect(io.stdout()).not.toContain('# Experience validation');
    } finally {
      fixture.cleanup();
    }
  });

  it('is byte-identical across runs for the same inputs (AC4)', async () => {
    const fixture = fixtureRoot();
    try {
      const first = join(fixture.root, 'first');
      const second = join(fixture.root, 'second');
      const options = (outDir: string) =>
        parseValidateExperienceArgs([
          fixture.reportPath,
          '--targets',
          fixture.targetsPath,
          '--out',
          outDir,
        ]);
      expect(
        await validateExperience(options(first), recordingIo(), core, fixture.root),
      ).toBe(0);
      expect(
        await validateExperience(options(second), recordingIo(), core, fixture.root),
      ).toBe(0);
      for (const name of [VALIDATION_JSON_ARTIFACT, VALIDATION_MARKDOWN_ARTIFACT]) {
        expect(readFileSync(join(first, name), 'utf8')).toBe(
          readFileSync(join(second, name), 'utf8'),
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a non-balance report and a malformed targets file with exit 2', async () => {
    const fixture = fixtureRoot();
    try {
      writeFileSync(fixture.reportPath, JSON.stringify({ kind: 'evaluation' }));
      const io = recordingIo();
      expect(
        await validateExperience(
          validateOptions(fixture.root, fixture.reportPath, fixture.targetsPath),
          io,
          core,
          fixture.root,
        ),
      ).toBe(2);
      expect(io.stderr()).toMatch(/kind: 'balance'/);

      writeFileSync(fixture.reportPath, balanceReportJson());
      writeFileSync(fixture.targetsPath, JSON.stringify({ kind: 'nope' }));
      const second = recordingIo();
      expect(
        await validateExperience(
          validateOptions(fixture.root, fixture.reportPath, fixture.targetsPath),
          second,
          core,
          fixture.root,
        ),
      ).toBe(2);
      expect(second.stderr()).toMatch(/experience-targets/);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects invalid JSON with an actionable message', async () => {
    const fixture = fixtureRoot();
    try {
      writeFileSync(fixture.reportPath, '{ not json');
      const io = recordingIo();
      expect(
        await validateExperience(
          validateOptions(fixture.root, fixture.reportPath, fixture.targetsPath),
          io,
          core,
          fixture.root,
        ),
      ).toBe(2);
      expect(io.stderr()).toMatch(/not valid JSON/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('deriveTargets (re-baseline workflow)', () => {
  it('derives a valid targets artifact whose bands come from the bot baseline', async () => {
    const fixture = fixtureRoot();
    try {
      const out = join(fixture.root, 'derived-targets.json');
      const io = recordingIo();
      const code = await deriveTargets(
        parseValidateExperienceArgs([
          '--baseline',
          fixture.reportPath,
          '--targets-out',
          out,
          '--targets-version',
          '1',
        ]),
        io,
        core,
        fixture.root,
      );
      expect(code).toBe(0);
      const targets = core.validateExperienceTargets(
        JSON.parse(readFileSync(out, 'utf8')),
      );
      expect(targets.targetsVersion).toBe(1);
      expect(targets.source).toMatchObject({
        kind: 'bot-baseline',
        policy: 'competent',
        games: 10,
        ticks: 18_000,
        campaign: true,
        level: null,
        sampleEveryTicks: 1,
        seeds: { count: 10, first: 1, last: 10 },
      });
      expect(targets.bands.survivalSeconds.centre).toBe(30);
      expect(io.stdout()).toContain('Derived targets v1');
    } finally {
      fixture.cleanup();
    }
  });

  it('refuses to derive the standard from a human report', async () => {
    const fixture = fixtureRoot();
    try {
      const human = JSON.parse(fsRead(fixture.reportPath));
      human.config.policies = ['human'];
      writeFileSync(fixture.reportPath, JSON.stringify(human));
      const io = recordingIo();
      const code = await deriveTargets(
        parseValidateExperienceArgs([
          '--baseline',
          fixture.reportPath,
          '--targets-out',
          join(fixture.root, 'targets.json'),
        ]),
        io,
        core,
        fixture.root,
      );
      expect(code).toBe(2);
      expect(io.stderr()).toMatch(/requires a bot batch report/);
    } finally {
      fixture.cleanup();
    }
  });

  it('bumps the version when re-baselining over an existing artifact', async () => {
    const fixture = fixtureRoot();
    try {
      const targets = JSON.parse(fsRead(fixture.targetsPath));
      expect(targets.targetsVersion).toBe(1);
      const io = recordingIo();
      const code = await deriveTargets(
        parseValidateExperienceArgs([
          '--baseline',
          fixture.reportPath,
          '--targets-out',
          fixture.targetsPath,
        ]),
        io,
        core,
        fixture.root,
      );
      expect(code).toBe(0);
      const rebased = core.validateExperienceTargets(
        JSON.parse(fsRead(fixture.targetsPath)),
      );
      expect(rebased.targetsVersion).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('is byte-stable for the same baseline and version (AC4)', async () => {
    const fixture = fixtureRoot();
    try {
      const first = join(fixture.root, 'a.json');
      const second = join(fixture.root, 'b.json');
      const args = (out: string) =>
        parseValidateExperienceArgs([
          '--baseline',
          fixture.reportPath,
          '--targets-out',
          out,
          '--targets-version',
          '1',
        ]);
      expect(await deriveTargets(args(first), recordingIo(), core, fixture.root)).toBe(0);
      expect(await deriveTargets(args(second), recordingIo(), core, fixture.root)).toBe(0);
      expect(fsRead(first)).toBe(fsRead(second));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('main', () => {
  it('prints the usage text for --help', async () => {
    const io = recordingIo();
    expect(await main(['--help'], io, core)).toBe(0);
    expect(io.stdout()).toBe(VALIDATE_EXPERIENCE_USAGE);
  });

  it('fails with usage when no report path is given', async () => {
    const io = recordingIo();
    expect(await main([], io, core)).toBe(2);
    expect(io.stderr()).toContain('Missing balance report path');
    expect(io.stderr()).toContain('Usage:');
  });

  it('returns usage errors from argument parsing', async () => {
    const io = recordingIo();
    expect(await main(['--bogus'], io, core)).toBe(2);
    expect(io.stderr()).toMatch(/Unknown argument/);
  });
});

/** Reads a file as UTF-8 (tiny helper keeping the assertions readable). */
function fsRead(path: string): string {
  return readFileSync(path, 'utf8');
}
