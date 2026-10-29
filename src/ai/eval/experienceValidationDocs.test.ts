/**
 * Docs guard for the periodic human-experience validation workflow
 * (AH-0MV7WVHU0000U775 AC5).
 *
 * The contract lives in `docs/EXPERIENCE_VALIDATION.md`: the targets artifact,
 * the tolerance rule, the command / flags / exit codes, the report shape, the
 * determinism story and the fidelity caveat. This guard fails if that document
 * is removed or weakened, and it pins the cross-links from the README,
 * `docs/BALANCING.md`, `docs/EVALUATION.md` and the GDD.
 *
 * The GDD assertion is a **consistency check between the narrative and the
 * machine-checkable standard**: every band in the committed artifact must
 * appear in GDD §2.7 (and in this workflow's own band table), so a re-baseline
 * that forgets to update the prose fails here instead of silently disagreeing.
 *
 * Like the sibling docs guards (`balancingDocs.test.ts`,
 * `evaluationDocs.test.ts`), this is a deliberate docs grep: it asserts the
 * canonical documentation text, not source behaviour.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { validateExperienceTargets } from './experienceTargets';

const DOC_PATH = path.resolve(process.cwd(), 'docs/EXPERIENCE_VALIDATION.md');
const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const BALANCING_PATH = path.resolve(process.cwd(), 'docs/BALANCING.md');
const EVALUATION_PATH = path.resolve(process.cwd(), 'docs/EVALUATION.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const PACKAGE_PATH = path.resolve(process.cwd(), 'package.json');
const TARGETS_PATH = path.resolve(process.cwd(), 'src/data/experience-targets.json');
const WORK_ITEM_ID = 'AH-0MV7WVHU0000U775';

/** The band table row text (`<centre> ± <tolerance>`, 2 dp) per metric. */
function bandRows(): string[] {
  const targets = validateExperienceTargets(
    JSON.parse(fs.readFileSync(TARGETS_PATH, 'utf8')),
  );
  return Object.values(targets.bands).map(
    (band) => `${band.centre.toFixed(2)} ± ${band.tolerance.toFixed(2)}`,
  );
}

describe('Human-experience validation is documented (AH-0MV7WVHU0000U775)', () => {
  it('the workflow document exists (AC5)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('covers the required sections', () => {
    for (const heading of [
      '## The intended-experience targets',
      '## Running the validation',
      '## Reading the report',
      '## Determinism and reproducibility',
      '## Scheduling (documented, not built)',
      '## Tuning the intended experience',
      '## Fidelity boundary and risks',
      '## Testing',
      '## Related work',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('documents the targets artifact, its versioning and the tolerance rule (AC1)', () => {
    for (const symbol of [
      'src/data/experience-targets.json',
      'targetsVersion',
      'schemaVersion',
      'toleranceRule',
      'max(2 × baseline stdDev, 10 % of |centre|, 0.5)',
    ]) {
      expect(doc).toContain(symbol);
    }
    // Every tracked metric is named, so the standard is fully described.
    for (const metric of [
      'survivalSeconds',
      'mineralsCollected',
      'upgradesSelected',
      'waveReached',
      'levelReached',
      'avoidableHits',
    ]) {
      expect(doc).toContain(metric);
    }
  });

  it('documents the command, flags, exit codes and artifacts (AC3)', () => {
    for (const symbol of [
      'npm run validate-experience --',
      '--targets',
      '--out',
      '--json',
      '--baseline',
      'experience-validation.json',
      'experience-validation.md',
    ]) {
      expect(doc).toContain(symbol);
    }
    // The drift gate and the invalid-input distinction are explicit.
    expect(doc).toMatch(/\|\s*`1`\s*\|\s*\*\*Drift\*\*/);
    expect(doc).toMatch(/`0`\s*\|\s*Every tracked metric/);
    expect(doc).toMatch(/`2`\s*\|\s*Usage error/);
  });

  it('documents the verdict vocabulary and the determinism guarantee (AC2/AC4)', () => {
    for (const verdict of ['in-band', 'above-band', 'below-band', 'missing']) {
      expect(doc).toContain(verdict);
    }
    expect(doc).toMatch(/byte-identical/);
    expect(doc).toMatch(/no wall\s+clock|no wall clock/);
    expect(doc).toMatch(/signed/);
  });

  it('documents the scheduling recipe without claiming built CI infrastructure', () => {
    expect(doc).toMatch(/cron/);
    expect(doc).toMatch(/no CI infrastructure|deliberately adds \*\*no CI infrastructure\*\*|not built/);
  });

  it('states the bot-baseline fidelity caveat and the drift prompt (risk mitigation)', () => {
    expect(doc).toMatch(/self-consistent/);
    expect(doc).toMatch(/prompt to investigate|prompt, not a verdict/);
    expect(doc).toMatch(/degenerate/);
    expect(doc).toMatch(/directional/);
  });

  it('references the work item and the related work', () => {
    expect(doc).toContain(WORK_ITEM_ID);
    expect(doc).toContain('AH-0MV7WVEWL005XEMN');
    expect(doc).toContain('docs/BALANCING.md');
    expect(doc).toContain('docs/EVALUATION.md');
  });

  it('ships the documented command as a package.json script (AC3)', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['validate-experience']).toBe(
      'node scripts/validate-experience.mjs',
    );
  });
});

describe('The intended experience is documented across the docs', () => {
  it('keeps the GDD narrative aligned with the committed bands (AC5)', () => {
    const gdd = fs.readFileSync(GDD_PATH, 'utf8');
    expect(gdd).toContain('### 2.7 Intended experience: measurable targets');
    expect(gdd).toContain('src/data/experience-targets.json');
    expect(gdd).toContain('docs/EXPERIENCE_VALIDATION.md');
    expect(gdd).toMatch(/npm run validate-experience/);
    for (const metric of [
      'survivalSeconds',
      'mineralsCollected',
      'upgradesSelected',
      'waveReached',
      'levelReached',
      'avoidableHits',
    ]) {
      expect(gdd).toContain(metric);
    }
    // The prose must quote the artifact's bands, so a re-baseline that skips
    // the GDD fails this guard instead of leaving the narrative stale.
    for (const row of bandRows()) {
      expect(gdd).toContain(row);
    }
  });

  it('keeps this workflow document aligned with the committed bands', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    for (const row of bandRows()) {
      expect(doc).toContain(row);
    }
  });

  it('is cross-linked from the README, BALANCING.md and EVALUATION.md', () => {
    expect(fs.readFileSync(README_PATH, 'utf8')).toContain(
      'docs/EXPERIENCE_VALIDATION.md',
    );
    expect(fs.readFileSync(BALANCING_PATH, 'utf8')).toContain(
      'docs/EXPERIENCE_VALIDATION.md',
    );
    expect(fs.readFileSync(EVALUATION_PATH, 'utf8')).toContain(
      'docs/EXPERIENCE_VALIDATION.md',
    );
  });
});
