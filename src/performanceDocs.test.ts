/**
 * Docs guard for the performance budget, the harness usage and the recorded
 * results (AH-0MVXV0FUP006W8OR AC1–AC4).
 *
 * `docs/PERFORMANCE.md` is the single source of truth for "what frame time are
 * we aiming at, how is it measured, and what are the numbers" — it publishes
 * the harness (AH-0MVXV0DER009ER70), the 100-enemy stress gym
 * (AH-0MVXV0DT50028RF8), the baseline and profile (AH-0MVXV0E8000937U5), the
 * per-optimisation results and the final verification (AH-0MVXV6VOI006P7VG).
 * Without a guard the budget quietly becomes folklore again: a deleted section
 * or an unlabelled table is invisible to every other test.
 *
 * This is a deliberate docs grep, like the sibling `*Docs.test.ts` guards
 * (`weaponBalanceDocs.test.ts`, `aoeDocs.test.ts`, `gymParityDocs.test.ts`).
 * Every expected string is a statement the item's acceptance criteria require,
 * never a re-implementation of the measurement maths — the maths itself is
 * unit-tested in `scripts/perf-report.test.ts`, `scripts/perf-profile.test.ts`
 * and `src/core/perfProbe.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = process.cwd();
const PERF_PATH = path.resolve(ROOT, 'docs/PERFORMANCE.md');
const README_PATH = path.resolve(ROOT, 'README.md');
const GYM_PARITY_PATH = path.resolve(ROOT, 'docs/GYM_PARITY.md');
const PACKAGE_PATH = path.resolve(ROOT, 'package.json');

/** The published performance document. */
function perfDoc(): string {
  return fs.readFileSync(PERF_PATH, 'utf8');
}

/**
 * The body of a section: everything after `heading` up to the next heading of
 * the same or a higher level (so a `##` section keeps its `###` subsections),
 * ignoring `#` lines inside fenced code blocks (the harness examples carry
 * shell comments that would otherwise look like headings). Asserting inside
 * the section rather than anywhere in the file is what stops an unrelated
 * mention satisfying the guard.
 */
function sectionBody(doc: string, heading: string): string {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.startsWith(heading));
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const level = (/^#+/.exec(heading) ?? ['##'])[0].length;
  const body: string[] = [];
  let inFence = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence) {
      const next = /^(#+) /.exec(line);
      if (next && next[1].length <= level) break;
    }
    body.push(line);
  }
  return body.join('\n');
}

/**
 * The `Recorded:` provenance statement of a section, including its wrapped
 * continuation lines, or `''` when the section has none.
 */
function provenanceBlock(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /`Recorded:`/i.test(line));
  if (start < 0) return '';
  const block: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && (lines[i].trim() === '' || lines[i].startsWith('#'))) break;
    block.push(lines[i]);
  }
  return block.join('\n');
}

/** A markdown table row that starts with `prefix`, or `undefined`. */
function rowStartingWith(doc: string, prefix: string): string | undefined {
  return doc.split('\n').find((line) => line.startsWith(prefix));
}

/**
 * The provenance statement every measurement section must carry (AC2: "every
 * recorded number carries its commit hash, platform, throttle factor and
 * date"). Each entry names the facts that must appear in that section's
 * `Recorded:` line, so a failure reports exactly which fact went missing.
 */
interface RecordedSection {
  readonly heading: string;
  /** Regexes the section's `Recorded:` line must satisfy, in order. */
  readonly facts: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }>;
}

const COMMIT = { label: 'a commit hash', pattern: /commit\s+`[0-9a-f]{7,40}`/ };
const DATE = { label: 'a date', pattern: /\b\d{4}-\d{2}-\d{2}\b/ };

const RECORDED_SECTIONS: ReadonlyArray<RecordedSection> = [
  {
    heading: '### Desktop tier (headless Chromium, software WebGL)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### Host-load sensitivity (why the load is recorded)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### CPU-throttle sensitivity and the mobile tier',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factors', pattern: /4×/ }],
  },
  {
    heading: '### Electron baseline (software GPU-process rasteriser)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Electron/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### PlayScene late game (supplementary)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### Final numbers (100 enemies, 60 s)',
    facts: [COMMIT, DATE, { label: 'the platforms', pattern: /Electron/ }, { label: 'the throttle factors', pattern: /4×/ }],
  },
  {
    heading: '### Per-frame HUD rows (AH-0MVXV0FFJ0066EC8)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### Cached bullet textures (AH-0MW2DAY2L004QSKF)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### Baked enemy body textures (AH-0MW2IRYAH0055WCN)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /4×/ }],
  },
  {
    heading: '### Collision broad phase (AH-0MVXV0EMF001WVQ1)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Node|vitest/ }, { label: 'the throttle applicability', pattern: /throttle (not applicable|n\/a)/i }],
  },
  {
    heading: '### Per-frame allocations (AH-0MVXV0F0Y004NENT)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
];

describe('docs/PERFORMANCE.md — performance budget', () => {
  it('states the desktop and mobile frame-time budget', () => {
    const budget = sectionBody(perfDoc(), '## Budget');

    expect(budget).toMatch(/60 FPS/);
    expect(budget).toMatch(/16\.7 ms/);
    expect(budget).toMatch(/Electron/);
    expect(budget).toMatch(/Desktop browser/);
    expect(budget).toMatch(/≥\s*30 FPS/);
    expect(budget).toMatch(/≥\s*4×/);
    expect(budget).toMatch(/Mobile browser/);
  });

  it('states that the budget is only falsifiable against a reference machine', () => {
    const budget = sectionBody(perfDoc(), '## Budget');
    const reference = sectionBody(perfDoc(), '## Reference machine');

    // The budget points a reader at the machine definition...
    expect(budget).toMatch(/reference machine/i);
    // ...and the definition names every fact a reproduction needs.
    for (const [label, pattern] of [
      ['the CPU', /AMD Ryzen 7 4800H|CPU \|/],
      ['the memory', /Memory \| 30 GB/],
      ['the OS', /Linux/],
      ['the browser', /Chromium/],
      ['the WebGL backend', /webgl/i],
      ['the renderer string', /SwiftShader/],
      ['the Electron version', /electron 45\.2\.2/i],
      ['the Node version', /v22\./],
    ] as ReadonlyArray<[string, RegExp]>) {
      expect(reference, `reference machine is missing ${label}`).toMatch(pattern);
    }
  });
});

describe('docs/PERFORMANCE.md — harness usage', () => {
  it('documents the harness command, its options and the reported fields', () => {
    const usage = sectionBody(perfDoc(), '## Measuring a run');

    expect(usage).toContain('npm run perf:measure');
    expect(usage).toContain('node scripts/measure-performance.mjs');

    for (const option of [
      '--scene',
      '--host',
      '--seconds',
      '--warmup',
      '--cpu-throttle',
      '--out',
      '--compare',
      '--profile',
      '--setup',
      '--json',
    ]) {
      expect(usage, `harness options table is missing ${option}`).toContain(option);
    }

    for (const field of [
      'frameTimeMs.p50',
      'frameTimeMs.p95',
      'frameTimeMs.max',
      'fps.effective',
      'longFrames.over33Ms',
      'longFrames.over50Ms',
      'counts.peak',
      'activeSceneKeys',
    ]) {
      expect(usage, `report-field table is missing ${field}`).toContain(field);
    }
  });

  it('keeps the documented harness entry point in step with package.json', () => {
    const doc = perfDoc();
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts: Record<string, string>;
    };

    const measure = pkg.scripts['perf:measure'];
    expect(measure, 'package.json no longer defines perf:measure').toBeDefined();
    // The document quotes the script body verbatim, so the two cannot drift.
    expect(doc).toContain(measure);
    // ...and the script it names really exists.
    const scriptPath = measure.replace(/^node\s+/, '').trim();
    expect(fs.existsSync(path.resolve(ROOT, scriptPath)), `${scriptPath} is missing`).toBe(true);

    // The Electron entry point is documented too, and is the same script.
    const electron = pkg.scripts['perf:measure:electron'];
    expect(electron, 'package.json no longer defines perf:measure:electron').toBeDefined();
    expect(electron).toContain('--host electron');
    expect(doc).toContain('npm run perf:measure:electron');
  });

  it('documents how two runs are compared and what counts as noise', () => {
    const comparing = sectionBody(perfDoc(), '## Comparing two runs');
    const noise = sectionBody(perfDoc(), '## Noise floor');

    expect(comparing).toContain('--compare');
    expect(comparing).toMatch(/20\s*%/);
    expect(comparing).toMatch(/p95/);
    expect(noise).toMatch(/p50/);
    expect(noise).toMatch(/p95/);
    expect(noise).toMatch(/load/i);
  });
});

describe('docs/PERFORMANCE.md — recorded numbers', () => {
  it('publishes the baseline table every optimisation must beat', () => {
    const baseline = sectionBody(perfDoc(), '## Baseline (100 enemies, 60 s)');

    expect(baseline).toMatch(/GymPerformance/);
    expect(baseline).toMatch(/100 late-game enemies|100 enemies/);
    expect(baseline).toContain('p50 (ms)');
    expect(baseline).toContain('p95 (ms)');
    expect(baseline).toContain('Effective FPS');
    expect(baseline).toContain('Frames > 33 ms');

    // At least the three reproducible desktop runs, plus the mobile tier.
    const rows = baseline.split('\n').filter((line) => /^\| \d/.test(line));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(baseline).toMatch(/mobile tier/i);
  });

  it('publishes the results table with per-optimisation before/after numbers', () => {
    const results = sectionBody(perfDoc(), '## Final target verification (AH-0MVXV6VOI006P7VG)');
    const attribution = sectionBody(
      perfDoc(),
      '### Per-child attribution, next to the final numbers',
    );

    // The end-to-end table covers every platform the budget names.
    expect(results).toContain('p50 (ms)');
    expect(results).toContain('p95 (ms)');
    expect(results).toContain('Effective FPS');
    expect(rowStartingWith(results, '| Desktop browser')).toBeDefined();
    expect(rowStartingWith(results, '| Desktop Electron')).toBeDefined();
    expect(rowStartingWith(results, '| Mobile tier')).toBeDefined();

    // The attribution table names each optimisation child, the commit its
    // after-number describes, and the measured before → after.
    const header = attribution.split('\n').find((line) => line.trim().startsWith('| Work item'));
    expect(header, 'per-child attribution table is missing').toBeDefined();
    expect(header).toContain('Commit');
    expect(header).toContain('Measured before');

    for (const [id, commit] of [
      ['AH-0MVXV0FFJ0066EC8', '5a6905b7'],
      ['AH-0MW2DAY2L004QSKF', 'ba4e5360'],
      ['AH-0MVXV0EMF001WVQ1', '40f6dce4'],
      ['AH-0MVXV0F0Y004NENT', 'd2878b60'],
      ['AH-0MW2DB9VN006XB63', '03f11377'],
      ['AH-0MVXV6VOI006P7VG', 'd2878b60'],
    ] as ReadonlyArray<[string, string]>) {
      const row = rowStartingWith(attribution, `| ${id} `) ?? rowStartingWith(attribution, `| **${id}**`);
      expect(row, `per-child attribution is missing ${id}`).toBeDefined();
      expect(row, `${id} row is missing its commit`).toContain(commit);
    }
  });

  it('records the commit, date, platform and throttle for every measurement section', () => {
    const doc = perfDoc();

    for (const section of RECORDED_SECTIONS) {
      const body = sectionBody(doc, section.heading);
      const recorded = provenanceBlock(body);
      expect(recorded, `${section.heading} has no \`Recorded:\` provenance line`).not.toBe('');
      for (const fact of section.facts) {
        expect(recorded, `${section.heading} does not record ${fact.label}`).toMatch(fact.pattern);
      }
    }
  });

  it('explains the provenance rule and names this guard', () => {
    const provenance = sectionBody(perfDoc(), '## How every number is recorded');

    expect(provenance).toMatch(/Recorded:/);
    expect(provenance).toMatch(/commit/i);
    expect(provenance).toMatch(/throttle/i);
    expect(provenance).toMatch(/date/i);
    expect(provenance).toContain('src/performanceDocs.test.ts');
  });
});

describe('docs/PERFORMANCE.md — discoverability', () => {
  it('is linked from the README', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const links = readme.match(/\]\(\.\/docs\/PERFORMANCE\.md[^)]*\)/g) ?? [];

    expect(links.length, 'README does not link to docs/PERFORMANCE.md').toBeGreaterThan(0);
    // Including a deep link, so a reader can land on the budget itself.
    expect(links.some((link) => link.includes('#'))).toBe(true);
    // The harness section of the README is where the link belongs.
    expect(readme).toContain('npm run perf:measure');
  });

  it('is linked from the stress-gym row of the gym-parity matrix', () => {
    const parity = fs.readFileSync(GYM_PARITY_PATH, 'utf8');
    const row = parity
      .split('\n')
      .find((line) => line.startsWith('| `GymPerformance`'));

    expect(row, 'docs/GYM_PARITY.md has no GymPerformance row').toBeDefined();
    expect(row, 'the stress-gym row does not link docs/PERFORMANCE.md').toMatch(
      /\]\(\.?\/?PERFORMANCE\.md[^)]*\)/,
    );
  });
});
