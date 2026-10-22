/**
 * Project-membership guard for the unit/integration Vitest split
 * (child AH-0MVF6XV87001NSEJ, parent AH-0MVF3BESP005ZDAV).
 *
 * Asserts the *real* config partitions the suite exactly:
 *
 * - every `*.test.ts` under `src/`, `scripts/` and `vite/` is selected by
 *   exactly one project (no orphaned file silently skipped, no file run
 *   twice);
 * - each project's `include` list is exactly what `classifyTestFiles`
 *   computes, so the documented selection rule and the config cannot drift;
 * - the rule's semantics are pinned on representative files (a Phaser scene
 *   suite is integration, a pure helper suite is unit).
 *
 * This test itself classifies as `unit` (it needs no DOM), so it always runs
 * in the fast project.
 *
 * @module test/projectMembership
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import pkg from '../../package.json';
import config from '../../vitest.config';
import { E2E_SUFFIX, allTestFiles, classifyTestFiles } from '../../vitest.projects';

const ROOT = process.cwd();

type ProjectConfig = { test?: { name?: string; include?: string[] } };

function projectInclude(name: string): string[] {
  const projects = (config.test?.projects ?? []) as ProjectConfig[];
  const project = projects.find((p) => p.test?.name === name);
  if (!project?.test?.include) throw new Error(`project '${name}' has no include list`);
  return project.test.include;
}

/** Sorts and de-duplicates for comparison. */
function normalise(files: string[]): string[] {
  return [...new Set(files.map((f) => path.normalize(f)).sort())];
}

describe('unit/integration project membership (AH-0MVF6XV87001NSEJ)', () => {
  const classified = classifyTestFiles(ROOT);
  const all = allTestFiles(ROOT);

  it('selects every test file: no orphans, no duplicates', () => {
    const selected = [...classified.unit, ...classified.integration, ...classified.e2e];
    expect(normalise(selected)).toEqual(normalise(all));

    // Exactly one project each: the union is the whole suite (equality above)
    // and no file appears in two projects.
    const groups = [classified.unit, classified.integration, classified.e2e];
    for (let a = 0; a < groups.length; a += 1) {
      for (let b = a + 1; b < groups.length; b += 1) {
        const overlap = groups[a].filter((f) => groups[b].includes(f));
        expect(overlap).toEqual([]);
      }
    }
    expect(selected.length).toBe(all.length);
  });

  it('keeps gated e2e suites out of the audit-accepted full-suite projects', () => {
    for (const file of classified.e2e) {
      expect(file.endsWith(E2E_SUFFIX), file).toBe(true);
      expect(classified.unit, file).not.toContain(file);
      expect(classified.integration, file).not.toContain(file);
    }
    // The real-ffmpeg promo smoke is the gated suite this split was made for
    // (AH-0MVFSNO0G00035AP).
    expect(classified.e2e).toContain('scripts/compile-promo.e2e.test.ts');
    expect(classified.unit).not.toContain('scripts/compile-promo.e2e.test.ts');
    expect(classified.integration).not.toContain('scripts/compile-promo.e2e.test.ts');
  });

  it('has a non-empty fast project and a non-empty heavy project', () => {
    expect(classified.unit.length).toBeGreaterThan(0);
    expect(classified.integration.length).toBeGreaterThan(0);
    expect(classified.e2e.length).toBeGreaterThan(0);
  });

  it("the config's project includes match the classifier exactly", () => {
    expect(normalise(projectInclude('unit'))).toEqual(normalise(classified.unit));
    expect(normalise(projectInclude('integration'))).toEqual(normalise(classified.integration));
    expect(normalise(projectInclude('e2e'))).toEqual(normalise(classified.e2e));
  });

  it('classifies a Phaser-booting scene suite as integration', () => {
    expect(classified.integration).toContain('src/scenes/PlayScene.test.ts');
    // The harness guard boots Phaser itself and must therefore be integration.
    expect(classified.integration).toContain('src/test/deterministicBootGuard.test.ts');
  });

  it('classifies a pure helper suite as unit', () => {
    expect(classified.unit).toContain('src/utils/beat.test.ts');
    // This guard test needs no DOM/Phaser and must stay in the fast project.
    expect(classified.unit).toContain('src/test/projectMembership.test.ts');
  });

  it('gives the unit project no DOM setup and the integration project the DOM setup', () => {
    const projects = (config.test?.projects ?? []) as Array<{
      test?: { name?: string; environment?: string; setupFiles?: string[] };
    }>;
    const unit = projects.find((p) => p.test?.name === 'unit')!;
    const integration = projects.find((p) => p.test?.name === 'integration')!;
    const e2e = projects.find((p) => p.test?.name === 'e2e')!;
    expect(unit.test?.environment).toBe('node');
    expect(unit.test?.setupFiles).toBeUndefined();
    expect(integration.test?.environment).toBe('happy-dom');
    expect(integration.test?.setupFiles).toEqual(['src/test/setup.ts']);
    // Gated e2e suites run in Node (real subprocesses), with no DOM setup.
    expect(e2e.test?.environment).toBe('node');
    expect(e2e.test?.setupFiles).toBeUndefined();
  });

  it('the default suite entry points select unit + integration only (never e2e)', () => {
    // Vitest runs *every* project by default, so `npm test` must name the two
    // audit-relevant projects explicitly; otherwise the gated e2e suites leak
    // back into the full-suite run (observed while landing AH-0MVFSNO0G00035AP).
    const scripts = (pkg as { scripts?: Record<string, string> }).scripts ?? {};
    for (const name of ['test', 'test:coverage']) {
      const script = scripts[name] ?? '';
      expect(script, name).toContain('--project unit');
      expect(script, name).toContain('--project integration');
      expect(script, name).not.toContain('--project e2e');
    }
    expect(scripts['test:e2e']).toBe('vitest run --project e2e');
  });

  it('keeps every classified file existing on disk', () => {
    for (const file of all) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
