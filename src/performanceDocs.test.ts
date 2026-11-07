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
 * The cells of one markdown table line, trimmed, with the leading and trailing
 * empty splits removed.
 */
function tableCells(line: string): string[] {
  return line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
}

/**
 * The numeric value of `rowPrefix` in the column named `column`, read from the
 * table that follows the table header starting with `headerPrefix`.
 *
 * Used where a guard must check a *measured* number against a *published* bar
 * (AH-0MW3KP1R90030QY9 AC3): the number is read from the document rather than
 * re-derived, so a re-run that publishes a row below the bar fails the guard.
 */
function numericCell(
  section: string,
  headerPrefix: string,
  column: string,
  rowPrefix: string,
): number {
  const lines = section.split('\n');
  const header = lines.find((line) => line.startsWith(headerPrefix));
  expect(header, `table header ${headerPrefix} is missing`).toBeDefined();
  const columnIndex = tableCells(header as string).indexOf(column);
  expect(columnIndex, `table has no "${column}" column`).toBeGreaterThanOrEqual(0);
  const row = lines.find((line) => line.startsWith(rowPrefix));
  expect(row, `table row ${rowPrefix} is missing`).toBeDefined();
  const cell = tableCells(row as string)[columnIndex];
  const value = Number.parseFloat(cell.replace(/[*`\s]/g, ''));
  expect(Number.isFinite(value), `row ${rowPrefix} has no numeric "${column}" (${cell})`).toBe(true);
  return value;
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
    heading: '### Hardware-WebGL mobile tier (4× CPU throttle)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the hardware backend', pattern: /NVIDIA/ }, { label: 'the throttle factor', pattern: /4×/ }],
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
  {
    heading: '## Hardware-GPU desktop baseline',
    facts: [COMMIT, DATE, { label: 'the platforms', pattern: /Chromium/ }, { label: 'the hardware backend', pattern: /NVIDIA/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### Before: one texture per rock, per-frame `Graphics` fallback (AH-0MW507VYG009SFR5)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the hardware backend', pattern: /NVIDIA/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    heading: '### After: shared silhouette palette, one texture atlas (AH-0MW508JS2004W3SR)',
    facts: [COMMIT, DATE, { label: 'the platform', pattern: /Chromium/ }, { label: 'the hardware backend', pattern: /NVIDIA/ }, { label: 'the throttle factor', pattern: /1×/ }],
  },
  {
    // The sweep section (AH-0MW5IUG0D004LX0E) documents the perf:sweep tool:
    // its provenance line names the commit/date the tooling describes, the
    // reference machine (headless Chromium, the default software WebGL
    // backend) and the default CPU throttle, per the file's Recorded: rule.
    heading: '## Enemy-count sweep',
    facts: [
      COMMIT,
      DATE,
      { label: 'the platform', pattern: /Chromium/ },
      { label: 'the webgl backend', pattern: /SwiftShader/ },
      { label: 'the throttle factor', pattern: /1×/ },
    ],
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
      'frameTimeMs.min',
      'frameTimeMs.p50',
      'frameTimeMs.p95',
      'frameTimeMs.max',
      'fps.effective',
      'fps.min',
      'fps.max',
      'fps.mean',
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

  it('publishes the hardware-WebGL mobile tier and states the AC5 verdict', () => {
    const doc = perfDoc();
    const mobile = sectionBody(doc, '### Hardware-WebGL mobile tier (4× CPU throttle)');

    // AC1: a 4×-throttled GymPerformance run on the real GPU, named not inferred.
    expect(mobile).toContain('webgl.kind: "hardware"');
    expect(mobile).toContain('ANGLE (NVIDIA, Vulkan 1.4.329');
    expect(mobile).toContain('NVIDIA GeForce RTX 3050 Ti');
    expect(mobile).toMatch(/--cpu-throttle 4/);
    expect(mobile).toMatch(/--seconds 60 --warmup 3/);
    expect(mobile).toContain('GymPerformance');

    // AC1: the in-band row's published Effective FPS clears the ≥ 30 FPS bar.
    expect(
      numericCell(mobile, '| Run |', 'Effective FPS', '| 1 (profiled, in band)'),
    ).toBeGreaterThanOrEqual(30);

    // AC2: the software-GL rows are retained as the host floor, not replaced.
    const software = sectionBody(doc, '### CPU-throttle sensitivity and the mobile tier');
    const floor = rowStartingWith(software, '| 4× (mobile tier)');
    expect(floor, 'the software-WebGL 4× mobile row was removed').toBeDefined();
    expect(floor).toContain('19.92');

    // AC3: the verdict is stated where a reader looks for it, and named.
    expect(mobile).toMatch(/Mobile-tier verdict: met/);
    expect(sectionBody(doc, '### Verdicts')).toContain('AH-0MW3KP1R90030QY9');
  });

  it('splits the mobile-tier verdict by backend and cross-references the hardware rows', () => {
    const doc = perfDoc();
    const verdicts = sectionBody(doc, '### Verdicts');

    // The mobile entry is item 3 of the verdict list. Take it up to the next
    // numbered item so an assertion cannot be satisfied by a sibling verdict.
    const lines = verdicts.split('\n');
    const start = lines.findIndex((line) => /^3\.\s+\*\*Mobile tier/.test(line));
    expect(start, 'the Verdicts mobile-tier entry (item 3) is missing').toBeGreaterThanOrEqual(0);
    const entryLines: string[] = [];
    for (let i = start; i < lines.length; i += 1) {
      if (i > start && /^\d+\.\s/.test(lines[i])) break;
      entryLines.push(lines[i]);
    }
    const mobile = entryLines.join('\n');

    // AC2: the verdict is split by backend — missed on the software rasteriser,
    // met on hardware WebGL — never an unqualified "target missed".
    expect(mobile).toMatch(/software rasteri[sz]er/i);
    expect(mobile).toMatch(/hardware WebGL/i);

    // AC2: the cross-reference sits in the lead of the entry, before the
    // follow-up paragraphs, so a reader who stops early still lands on the
    // hardware rows. (Left in a follow-up only, the verdict reads as unmet.)
    const lead = mobile.split('**Follow-up result')[0];
    expect(lead).toContain('[Hardware-WebGL mobile tier]');
    expect(lead).toContain('#hardware-webgl-mobile-tier-4-cpu-throttle');

    // The historical software measurement and its provenance are retained:
    // this is a relabel by backend, not a rewrite of recorded history.
    expect(mobile).toContain('24.21 FPS');
    expect(mobile).toContain('AH-0MW2IRYAH0055WCN');
    expect(mobile).toContain('AH-0MW3KP1R90030QY9');
  });

  it('states the hardware mobile tier\u2019s load sensitivity once, without an orphaned fragment', () => {
    const mobile = sectionBody(perfDoc(), '### Hardware-WebGL mobile tier (4× CPU throttle)');

    // The "pass is not a single lucky window" bullet carried a dangling
    // duplicate of its own closing sentence after an earlier edit; the
    // noise-floor reference belongs to that bullet exactly once.
    const duplicates = mobile.match(/load-sensitivity pattern the/g) ?? [];
    expect(duplicates.length, 'the mobile-tier load-sensitivity sentence is duplicated').toBe(1);
    expect(mobile).not.toMatch(/never approaches the ≥ 30 FPS floor/);
  });

  it('publishes the hardware-GPU desktop runs for both hosts', () => {
    const hardware = sectionBody(perfDoc(), '## Hardware-GPU desktop baseline');

    // AC1: a hardware backend, not inferred from --gpu (both hosts report the
    // same driver string, and webgl.kind is explicitly hardware).
    expect(hardware).toContain(`webgl.kind: "hardware"`);
    expect(hardware).toContain('NVIDIA GeForce RTX 3050 Ti');
    expect(hardware).toContain('ANGLE (NVIDIA, Vulkan 1.4.329');

    // AC2/AC3: a 60 s, 100-enemy GymPerformance run per host, with the frame
    // times stated against the ≥ 60 FPS / p95 ≤ 16.7 ms bar.
    for (const [host, runPrefix] of [
      ['Desktop browser', '| Desktop browser (Chromium 140.0.7339.186, hardware ANGLE-Vulkan) | 1 (profiled)'],
      ['Desktop Electron', '| Desktop Electron (45.2.3 / Chromium 156.0.8078.80, hardware ANGLE-Vulkan) | 1 (profiled)'],
    ] as ReadonlyArray<[string, string]>) {
      expect(hardware).toMatch(/--seconds 60 --warmup 3/);
      expect(hardware).toContain('GymPerformance');
      expect(hardware).toContain('Effective FPS');
      const row = hardware.split('\n').find((line) => line.startsWith(runPrefix));
      expect(row, `${host} hardware row is missing`).toBeDefined();
      expect(row).toContain('16.7');
    }
    expect(hardware).toMatch(/59\.\d\d|60\.00/);
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

describe('docs/PERFORMANCE.md — the enemy-count sweep (AH-0MW5IUG0D004LX0E)', () => {
  it('documents the sweep command, its options, the window and the load definition', () => {
    const sweep = sectionBody(perfDoc(), '## Enemy-count sweep');

    // The command and its entry point, so the documented tool stays concrete.
    expect(sweep).toContain('npm run perf:sweep');
    expect(sweep).toContain('node scripts/perf-sweep.mjs');

    // Every option the CLI documents appears in the section's options table.
    for (const option of [
      '--seed',
      '--aggression',
      '--seconds',
      '--warmup',
      '--ceiling',
      '--budget',
      '--cpu-throttle',
      '--scene',
      '--out',
      '--json',
    ]) {
      expect(sweep, `sweep options table is missing ${option}`).toContain(option);
    }

    // The 15-second minimum measurement window, warm-up excluded.
    expect(sweep).toMatch(/15 seconds/);
    expect(sweep).toMatch(/warm-up/i);

    // The load definition: a varying shoot/dive mix, a representative
    // non-maxed loadout and the as-played deterministic (seeded) mode.
    expect(sweep).toMatch(/shoot/i);
    expect(sweep).toMatch(/dive/i);
    expect(sweep).toMatch(/POWER_UP_SLOT_CAP/);
    expect(sweep).toMatch(/levels are not maxed/i);
    expect(sweep).toMatch(/seed/i);
  });

  it('states the stop rule and why the sweep and the fixed 100-enemy rows both exist', () => {
    const sweep = sectionBody(perfDoc(), '## Enemy-count sweep');

    // The stop rule: the first step below 30 average FPS is the failure
    // point, the previous step the last playable load; a ceiling/budget
    // bounds a clean sweep.
    expect(sweep).toMatch(/below\s+30/);
    expect(sweep).toMatch(/failure point/i);
    expect(sweep).toMatch(/last playable/i);
    expect(sweep).toMatch(/--ceiling/);
    expect(sweep).toMatch(/--budget/);

    // The sweep is distinguished from — not merged into — the fixed 100-enemy
    // rows: both exist and are not comparable.
    expect(sweep).toMatch(/100-enemy/);
    expect(sweep).toMatch(/not comparable/i);
  });

  it('is linked from the README harness section', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');

    // The harness section this guard already keys on, with a deep link to the
    // sweep section of the performance doc, so a reader of the README lands on
    // the new section.
    const harness = readme.slice(readme.indexOf('#### Frame-time performance measurement'));
    expect(harness.indexOf('#### Frame-time performance measurement')).toBeGreaterThanOrEqual(0);
    expect(harness).toContain('npm run perf:sweep');
    expect(harness).toContain('docs/PERFORMANCE.md#enemy-count-sweep');
  });
});
