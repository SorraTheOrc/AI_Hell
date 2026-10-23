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
import { DELIVERABLE_TARGETS, PACE_BAND } from '../scripts/compile-promo.mjs';

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

  it('documents the promo pace reference band (AH-0MVDV50Z20071RF4 AC3)', () => {
    // The band is the auditable claim behind the promo's pace, so the document
    // must state it — and the numbers must match the editorial config the
    // pipeline actually enforces (no doc/code drift).
    expect(doc).toMatch(/### 7\.6 Pace reference band for the compiled promo/);
    expect(doc).toMatch(/Calibration basis/);
    for (const label of [
      'Opening non-black ratio (first 5 s)',
      'Overall non-black ratio',
      'Mean recorded intensity',
    ]) {
      expect(doc).toContain(label);
    }
    expect(doc).toContain(`≥ ${PACE_BAND.minOpeningNonBlackRatio.toFixed(2)}`);
    expect(doc).toContain(`≥ ${PACE_BAND.minNonBlackRatio.toFixed(2)}`);
    expect(doc).toContain(`≥ ${PACE_BAND.minMeanIntensity.toFixed(2)}`);
    expect(doc).toContain(`first \`${PACE_BAND.openingWindowMs / 1000} s\``);
    // The measurement is defined in terms of the shared black-frame floor and
    // the deliverable targets the report verifies (AC1).
    expect(doc).toContain('BLACK_FRAME_YAVG_FLOOR');
    expect(doc).toContain(`${DELIVERABLE_TARGETS.promo.minMs / 1000}–${DELIVERABLE_TARGETS.promo.maxMs / 1000} s`);
    expect(doc).toContain(`> ${DELIVERABLE_TARGETS.showreel.minMs / 60_000} min`);
  });

  it('is cross-linked from the README and the telemetry reference (AC6)', () => {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const telemetry = fs.readFileSync(TELEMETRY_PATH, 'utf8');
    expect(readme).toContain('docs/dev/action-intensity.md');
    expect(telemetry).toContain('actionIntensity');
  });
});
