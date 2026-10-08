/**
 * Docs guard for style matching (AH-0MUY08XXN003NV0I, AC5).
 *
 * The fit/train/evaluate contract lives in `docs/STYLE_MATCHING.md`: the quick
 * start, the feature and knob tables, the safety guarantees, the optional
 * cloning path and the evaluation report. This guard fails if that document —
 * or the key content the acceptance criteria require — is removed or weakened.
 *
 * Like the sibling docs guards (`botFrameworkDocs.test.ts`,
 * `evaluationDocs.test.ts`), this is a deliberate docs grep: it asserts the
 * canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/STYLE_MATCHING.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const WORK_ITEM_ID = 'AH-0MUY08XXN003NV0I';
const EPIC_ID = 'AH-0MUY089KR003F8S4';

describe('Style matching is documented (AH-0MUY08XXN003NV0I)', () => {
  it('the style-matching document exists (AC5)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('documents the pipeline and how to fit, train and evaluate (AC5)', () => {
    for (const heading of [
      '## Quick start',
      '## How it works',
      '## Feature extraction',
      '## Parameter fitting',
      '### Safety guarantees',
      '## Behaviour cloning (optional)',
      '## Evaluation',
      '## Reproducibility',
      '## References',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('names the public style-matching API (AC1–AC4)', () => {
    for (const symbol of [
      'extractStyleFeatures',
      'fitStyle',
      'enforceSafety',
      'trainImitationPolicy',
      'createImitationPolicy',
      'evaluateStyleMatch',
      'styleDistance',
      'StyleFeatures',
      'StyleMatchReport',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('names every extracted feature and the safety invariants (AC1/AC2)', () => {
    for (const feature of [
      'reaction latency',
      'key-hold distribution',
      'target preferences',
      'engagement distances',
      'risk appetite',
    ]) {
      expect(doc).toContain(feature);
    }
    expect(doc).toMatch(/never-suicide/);
    expect(doc).toMatch(/priority order/);
    expect(doc).toMatch(/survival band/);
  });

  it('explains the evaluation verdict and the cloning limitation (AC3/AC4)', () => {
    expect(doc).toContain('closer');
    expect(doc).toMatch(/regressed/);
    expect(doc).toMatch(/does not model|Limitation/);
    expect(doc).toMatch(/same seed|same-seed/);
  });

  it('references the work item and its parent epic', () => {
    expect(doc).toContain(WORK_ITEM_ID);
    expect(doc).toContain(EPIC_ID);
  });

  it('is cross-linked from the README', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toContain('docs/STYLE_MATCHING.md');
  });
});
