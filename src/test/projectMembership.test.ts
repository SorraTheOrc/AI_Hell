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

import config from '../../vitest.config';
import { allTestFiles, classifyTestFiles } from '../../vitest.projects';

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
    const selected = [...classified.unit, ...classified.integration];
    expect(normalise(selected)).toEqual(normalise(all));

    // Exactly one project each — the intersection is empty and the union is
    // the whole suite (implied by the equality above plus this check).
    const overlap = classified.unit.filter((f) => classified.integration.includes(f));
    expect(overlap).toEqual([]);
    expect(selected.length).toBe(all.length);
  });

  it('has a non-empty fast project and a non-empty heavy project', () => {
    expect(classified.unit.length).toBeGreaterThan(0);
    expect(classified.integration.length).toBeGreaterThan(0);
  });

  it("the config's project includes match the classifier exactly", () => {
    expect(normalise(projectInclude('unit'))).toEqual(normalise(classified.unit));
    expect(normalise(projectInclude('integration'))).toEqual(normalise(classified.integration));
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
    expect(unit.test?.environment).toBe('node');
    expect(unit.test?.setupFiles).toBeUndefined();
    expect(integration.test?.environment).toBe('happy-dom');
    expect(integration.test?.setupFiles).toEqual(['src/test/setup.ts']);
  });

  it('keeps every classified file existing on disk', () => {
    for (const file of all) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
    }
  });
});
