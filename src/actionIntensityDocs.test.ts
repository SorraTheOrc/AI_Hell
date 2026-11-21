/**
 * Docs guard for the on-screen action-intensity decision
 * (AH-0MUZCSJXQ004TREN).
 *
 * The deliverable of this research/decision work item is a decision document
 * under `docs/dev/`, cross-linked from the player-facing README and the
 * telemetry reference. This guard fails if that document — or the key
 * content each acceptance criterion requires (approach comparison, refined
 * scoring model, output schema, telemetry integration and the sibling epic
 * reference) — is removed or weakened, so the recorded decision cannot
 * silently drift.
 *
 * Like the sibling `aoeDocs.test.ts` / `gymParityDocs.test.ts`, this is a
 * deliberate docs grep: it asserts the canonical documentation text (the
 * ACs), not source behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOC_PATH = path.resolve(process.cwd(), 'docs/dev/action-intensity.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const TELEMETRY_PATH = path.resolve(process.cwd(), 'docs/TELEMETRY.md');

const EPIC_ID = 'AH-0MUZMTTYH008KVS2';
const TELEMETRY_EPIC_ID = 'AH-0MUY089KR003F8S4';
const TELEMETRY_TICK_ID = 'AH-0MUY08VVQ007HSSH';

describe('Action-intensity decision is documented (AH-0MUZCSJXQ004TREN)', () => {
  it('the decision document exists under docs/dev (AC1)', () => {
    expect(fs.existsSync(DOC_PATH)).toBe(true);
  });

  const doc = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, 'utf8') : '';

  it('surveys prior art and compares at least three approaches (AC1)', () => {
    expect(doc).toMatch(/## 3\. Prior art/);
    expect(doc).toMatch(/## 4\. Alternative approaches compared/);
    for (const approach of [
      'Weighted on-screen object count',
      'Event-window intensity',
      'Player-stress model',
      'Hybrid layered metric',
    ]) {
      expect(doc).toContain(approach);
    }
  });

  it('defines the refined scoring model with weights and rationale (AC2)', () => {
    expect(doc).toMatch(/## 6\. Scoring model/);
    // Refined weights (player bullets halved; explosions dominate).
    expect(doc).toContain('**0.5**');
    expect(doc).toContain('20.0');
    // Aggregation / normalisation / smoothing are stated.
    expect(doc).toMatch(/intensity\(t\) = R\(t\)/);
    expect(doc).toMatch(/burstiness/);
  });

  it('specifies the recorded artefact schema (AC3)', () => {
    expect(doc).toMatch(/## 7\. Recorded artefact & schema/);
    for (const field of ['schemaVersion', 'runSeed', 'sampleRateHz', 'breakdown']) {
      expect(doc).toContain(field);
    }
    expect(doc).toMatch(/highlight/i);
  });

  it('states telemetry integration and dependency (AC4)', () => {
    expect(doc).toMatch(/## 8\. Telemetry integration/);
    expect(doc).toContain(TELEMETRY_EPIC_ID);
    expect(doc).toContain(TELEMETRY_TICK_ID);
    expect(doc).toMatch(/no-op/);
  });

  it('names the sibling implementation epic (AC5)', () => {
    expect(doc).toContain(EPIC_ID);
    expect(doc).toContain('discovered-from:AH-0MUZCSJXQ004TREN');
  });

  it('is cross-linked from the README and the telemetry reference (AC6)', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const telemetry = fs.readFileSync(TELEMETRY_PATH, 'utf8');
    expect(readme).toContain('docs/dev/action-intensity.md');
    expect(telemetry).toContain('actionIntensity');
  });
});
