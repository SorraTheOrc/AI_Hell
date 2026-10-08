/**
 * Docs guard for the same-seed evaluation harness (AH-0MUY08XLD009K4W4, AC7).
 *
 * The harness contract lives in `docs/EVALUATION.md`: how to run it, what the
 * metrics mean, how to read the A/B confidence interval, the same-seed human
 * comparison, the optional side-by-side video and the reproducibility story.
 * This guard fails if that document — or the key content the acceptance
 * criteria require — is removed or weakened.
 *
 * Like the sibling docs guards (`botFrameworkDocs.test.ts`,
 * `actionIntensityDocs.test.ts`), this is a deliberate docs grep: it asserts
 * the canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/EVALUATION.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const WORK_ITEM_ID = 'AH-0MUY08XLD009K4W4';
const EPIC_ID = 'AH-0MUY089KR003F8S4';

describe('Same-seed evaluation harness is documented (AH-0MUY08XLD009K4W4)', () => {
  it('the evaluation document exists (AC7)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('documents how to run the harness and interpret the report (AC7)', () => {
    for (const heading of [
      '## Quick start',
      '## How it works',
      '## Metrics',
      '## A/B and confidence',
      '## Same-seed human comparison',
      '## Side-by-side video',
      '## Reproducibility',
      '## Fidelity boundary and limitations',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('names the commands, artifacts and metrics (AC1–AC5)', () => {
    for (const symbol of [
      'npm run evaluate',
      'report.json',
      'runs.jsonl',
      'ghost.svg',
      'side-by-side',
      '--baseline',
      '--candidate',
      '--human',
      'confidence interval',
      'Avoidable hits',
      'Minerals / min',
      'Survival time',
      'Input cadence',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('explains the reproducibility guarantee and the fidelity boundary', () => {
    expect(doc).toMatch(/byte-stable|byte-identical/);
    expect(doc).toMatch(/not Phaser|closed-loop headless model/);
    expect(doc).toMatch(/seed/i);
  });

  it('references the work item and its parent epic', () => {
    expect(doc).toContain(WORK_ITEM_ID);
    expect(doc).toContain(EPIC_ID);
  });

  it('is cross-linked from the README', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    expect(readme).toContain('docs/EVALUATION.md');
  });
});
