/**
 * Docs guard for the project-local `perf-sweep` skill (AH-0MW5IUFGX00500XT).
 *
 * `.pi/skills/perf-sweep/SKILL.md` is the discoverability contract of the
 * enemy-count sweep: pi loads project skills from `.pi/skills/<name>/SKILL.md`
 * (docs/configuration.md — "Project skills and supporting files") and requires
 * a `name` and a non-empty `description` in the frontmatter
 * (docs/skills.md — "Malformed SKILL.md files and declared skills without
 * descriptions are not loaded"). Without a guard, a renamed directory, a
 * dropped frontmatter name or a deleted paragraph quietly breaks
 * "how many enemies can we hold" discovery — the parent epic's AC1.
 *
 * This is a deliberate docs guard like the sibling `*Docs.test.ts` files
 * (`performanceDocs.test.ts`, `gymParityDocs.test.ts`). It asserts only what
 * the acceptance criteria require:
 *
 * - the file exists at the discoverable path with valid frontmatter naming
 *   `perf-sweep` (AC1);
 * - the document states the sweep, the load definition, the 15 s minimum
 *   measurement window and the stop rule (parent AC1);
 * - every option it names is a real driver flag, checked against the driver's
 *   own `SWEEP_USAGE` (AC3 — no invented flag);
 * - it documents how to read the report, the provenance a published sweep must
 *   carry, and the "not a test run / not in the suite" constraint (AC4).
 *
 * It never re-implements the planner maths — the step list, loadout, mix and
 * stop rule are unit-tested in `src/perf/sweepPlan.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SWEEP_USAGE } from '../scripts/perf-sweep.mjs';

const ROOT = process.cwd();
const SKILL_PATH = path.resolve(ROOT, '.pi/skills/perf-sweep/SKILL.md');

/** The skill document, read from its discoverable location. */
function skillDoc(): string {
  return fs.readFileSync(SKILL_PATH, 'utf8');
}

/**
 * Parses the leading `---`-fenced frontmatter into a `{ key: value }` map.
 *
 * Returns an empty map when there is no frontmatter, so the assertions below
 * fail with a useful name/description message rather than a raw index error.
 */
function frontmatter(doc: string): Record<string, string> {
  const fence = /^---\n([\s\S]*?)\n---\n/.exec(doc);
  if (!fence) return {};
  const fields: Record<string, string> = {};
  for (const line of fence[1].split('\n')) {
    const match = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (match) fields[match[1]] = match[2];
  }
  return fields;
}

describe('perf-sweep skill (docs guard)', () => {
  it('exists at the discoverable project-skill path with valid frontmatter', () => {
    // The pi skill directory scan discovers `.pi/skills/<name>/SKILL.md`;
    // a missing file throws here and fails the guard.
    const doc = skillDoc();
    const fm = frontmatter(doc);
    expect(fm.name).toBe('perf-sweep');
    expect(fm.description?.trim().length).toBeGreaterThan(0);
  });

  it('states the sweep, the load definition, the 15 s window and the stop rule', () => {
    const doc = skillDoc();
    expect(doc).toMatch(/50-enemy steps/i);
    expect(doc).toMatch(/ceiling of 400|SWEEP_COUNT_CEILING|\b400\b/);
    expect(doc).toMatch(/at least 15 seconds|at least 15 s/i);
    expect(doc).toMatch(/warm-up/i);
    expect(doc).toMatch(/average FPS .*below 30|strictly below 30|below 30/i);
    expect(doc).toMatch(/last playable load/i);
  });

  it('documents every option it names as a real driver flag (no invented flag)', () => {
    const doc = skillDoc();
    const realFlags = new Set(
      [...SWEEP_USAGE.matchAll(/--[a-z0-9-]+/g)].map((m) => m[0]),
    );
    // Every flag the document's options table names must exist in the
    // driver's own usage text (the `--help` output the AC pins to).
    const docFlags = new Set(
      [...doc.matchAll(/`--[a-z0-9-]+/g)].map((m) => m[0].slice(1)),
    );
    for (const flag of docFlags) {
      expect(realFlags, `invented flag: ${flag}`).toContain(flag);
    }
    // The short help flag is part of the driver interface too.
    expect(doc).toMatch(/`-h`/);
  });

  it('documents how to read the report and the provenance for a published sweep', () => {
    const doc = skillDoc();
    expect(doc).toMatch(/npm run perf:sweep/);
    expect(doc).toMatch(/perf-output\/sweep-<ts>\.json/);
    expect(doc).toMatch(/Recorded:/);
    expect(doc).toMatch(/docs\/PERFORMANCE\.md/);
  });

  it('states the "not a test run / not in the suite" constraint', () => {
    const doc = skillDoc();
    // `[\s\S]` because the prose wraps across lines inside the bullet.
    expect(doc).toMatch(/not[\s\S]*a test run/i);
    expect(doc).toMatch(/not[\s\S]*vitest suite/i);
    expect(doc).toMatch(/not[\s\S]*test skill/i);
    expect(doc).toMatch(/measurement tool/i);
  });
});
