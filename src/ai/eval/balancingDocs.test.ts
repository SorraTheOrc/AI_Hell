/**
 * Docs guard for the automated-balancing (batch evaluation) framework
 * (AH-0MV81Z2EJ006HD5T, epic AH-0MV1DLUZ8009OCJW AC6).
 *
 * The batch contract lives in `docs/BALANCING.md`: how to run a batch, the
 * CLI flags, the shared statistics schema and how to interpret the
 * distributions, the fidelity boundary and the reproducibility story. This
 * guard fails if that document — or the key content the acceptance criteria
 * require — is removed or weakened, and it pins the cross-links from
 * `docs/EVALUATION.md` and the README.
 *
 * Like the sibling docs guards (`evaluationDocs.test.ts`,
 * `actionIntensityDocs.test.ts`), this is a deliberate docs grep: it asserts
 * the canonical documentation text, not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/BALANCING.md');
const EVALUATION_PATH = path.resolve(process.cwd(), 'docs/EVALUATION.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const WORK_ITEM_ID = 'AH-0MV81Z2EJ006HD5T';
const EPIC_ID = 'AH-0MV1DLUZ8009OCJW';

describe('Automated balancing is documented (AH-0MV81Z2EJ006HD5T)', () => {
  it('the BALANCING.md document exists (epic AC6)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('covers the required sections (how to run, schema, boundary, reproducibility)', () => {
    for (const heading of [
      '## Quick start',
      '## Statistics schema',
      '## Interpreting a distribution',
      '## Config-driven simulation',
      '## Determinism and reproducibility',
      '## Fidelity boundary and limitations',
      '## Testing',
      '## Related work',
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it('documents how to run a batch and its CLI flags (epic AC2/AC6)', () => {
    for (const symbol of [
      'npm run evaluate -- --batch',
      '--games',
      '--policies',
      '--out',
      '--json',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('names the batch artifacts', () => {
    for (const artifact of [
      'balance-report.json',
      'balance-report.txt',
      'runs.jsonl',
    ]) {
      expect(doc).toContain(artifact);
    }
  });

  it('documents the versioned, shared statistics schema without weakening it', () => {
    for (const symbol of [
      'BALANCE_STATISTICS_SCHEMA_VERSION',
      'BalanceRunStats',
      'BalanceAggregate',
      'DistributionStats',
    ]) {
      expect(doc).toContain(symbol);
    }
    for (const field of [
      'schemaVersion',
      'mineralsCollected',
      'upgradesSelected',
      'enemiesKilledByArchetype',
      'asteroidsDestroyed',
      'powerUpsCollected',
      'avoidableHits',
      'survivalSeconds',
      'waveReached',
      'levelReached',
    ]) {
      expect(doc).toContain(field);
    }
  });

  it('documents the distribution interpretation (count, mean, median, min, max, stdDev)', () => {
    for (const stat of ['count', 'mean', 'median', 'min', 'max', 'stdDev']) {
      expect(doc).toContain(stat);
    }
    // Reading guidance, not just symbols.
    expect(doc).toMatch(/median/);
    expect(doc).toMatch(/variance|outliers|standard deviation/);
  });

  it('explains the reproducibility guarantee and the fidelity boundary', () => {
    expect(doc).toMatch(/byte-identical|byte-stable/);
    expect(doc).toMatch(/not Phaser|closed-loop headless/);
    expect(doc).toMatch(/seed/i);
  });

  it('references the work item and its parent epic', () => {
    expect(doc).toContain(WORK_ITEM_ID);
    expect(doc).toContain(EPIC_ID);
  });

  it('documents the human-play balance report (AH-0MV7WVEWL005XEMN)', () => {
    for (const symbol of [
      "'human'",
      'extractHumanBalanceStats',
      'balance-stats.json',
      'human-balance-report.json',
      'npm run record',
      '--human',
      'dev-tooling only',
    ]) {
      expect(doc).toContain(symbol);
    }
  });

  it('is cross-linked from the README and EVALUATION.md', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const evaluation = fs.readFileSync(EVALUATION_PATH, 'utf8');
    expect(readme).toContain('docs/BALANCING.md');
    expect(evaluation).toContain('BALANCING.md');
  });
});
