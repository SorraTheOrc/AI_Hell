/**
 * Docs guard for the promo compile pipeline
 * (AH-0MVDV53RA0079F8N, parent AH-0MV9DB68T002IROX AC7).
 *
 * `npm run compile:promo` turns the captured footage into the promo,
 * showreel and highlight clips. Its inputs, outputs, `ffmpeg` prerequisite,
 * manifest formats and validation gates have to be discoverable from the
 * developer docs — otherwise the only description of the pipeline is the
 * script itself. This guard fails if that documentation is removed or
 * weakened, or if the documented contract drifts from the pipeline's own
 * configuration (targets, pace band, prerequisite commands).
 *
 * Like the sibling `actionIntensityDocs.test.ts` / `aoeDocs.test.ts`, this is
 * a deliberate docs grep: it asserts the canonical documentation text, not
 * source behaviour. The numbers are imported from the script rather than
 * hard-coded so a retune updates the pipeline and fails the doc, never
 * silently diverging.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DELIVERABLE_TARGETS,
  PACE_BAND,
  USAGE_TEXT,
} from '../scripts/compile-promo.mjs';

const CAPTURE_DOC_PATH = path.resolve(process.cwd(), 'docs/dev/gameplay-capture.md');
const INTENSITY_DOC_PATH = path.resolve(process.cwd(), 'docs/dev/action-intensity.md');
const PACKAGE_PATH = path.resolve(process.cwd(), 'package.json');

const captureDoc = fs.existsSync(CAPTURE_DOC_PATH)
  ? fs.readFileSync(CAPTURE_DOC_PATH, 'utf8')
  : '';
const intensityDoc = fs.existsSync(INTENSITY_DOC_PATH)
  ? fs.readFileSync(INTENSITY_DOC_PATH, 'utf8')
  : '';
const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8')) as {
  scripts: Record<string, string>;
};

describe('Promo compile pipeline is documented (AH-0MVDV53RA0079F8N)', () => {
  it('documents the compile command and its inputs/outputs (AC1)', () => {
    expect(captureDoc).toMatch(/## Compiling a promo package/);
    expect(captureDoc).toContain('npm run compile:promo');
    // The npm entry point the docs promise actually exists.
    expect(pkg.scripts['compile:promo']).toBe('node scripts/compile-promo.mjs --compile');
    // Inputs: the WebM + series + anchor triple.
    for (const artefact of ['.webm', '.action.jsonl', '.capture.json']) {
      expect(captureDoc).toContain(artefact);
    }
    // Outputs: the three deliverable types plus both manifests.
    for (const output of [
      'promo.webm',
      'showreel.webm',
      'highlight-01.webm',
      'compile-promo.plan.json',
      'compile-promo-report.json',
    ]) {
      expect(captureDoc).toContain(output);
    }
    // The help contract is documented and real.
    expect(USAGE_TEXT).toContain('Usage: node scripts/compile-promo.mjs');
    expect(captureDoc).toContain('--help');
  });

  it('documents ffmpeg as a host prerequisite with install guidance (AC2)', () => {
    expect(captureDoc).toMatch(/### Prerequisites/);
    expect(captureDoc).toContain('apt-get install ffmpeg');
    expect(captureDoc).toContain('brew install ffmpeg');
    expect(captureDoc).toContain('johnvansickle.com/ffmpeg');
    // Detection/error behaviour when ffmpeg is absent.
    expect(captureDoc).toContain('FFMPEG_BIN');
    expect(captureDoc).toContain('FFPROBE_BIN');
    expect(captureDoc).toMatch(/install hints/i);
    // The stale "there is no ffmpeg on PATH" claim must not come back.
    expect(captureDoc).not.toContain('There is **no `ffmpeg` on `PATH`**');
  });

  it('documents the selection and coverage manifest formats (AC3)', () => {
    expect(captureDoc).toMatch(/### Manifests/);
    expect(captureDoc).toContain('selection manifest');
    expect(captureDoc).toContain('coverage manifest');
    for (const field of [
      'runId',
      'webm',
      'series',
      'videoInMs',
      'videoOutMs',
      'intensity',
      'burstiness',
      'features',
      'uncoveredFeatures',
    ]) {
      expect(captureDoc).toContain(`\`${field}\``);
    }
    // An example is present, not just prose.
    expect(captureDoc).toMatch(/```json/);
  });

  it('documents the capture-side series and join anchor (AC4)', () => {
    expect(captureDoc).toMatch(/## Action-intensity export/);
    expect(captureDoc).toContain('capture-join-anchor');
    expect(intensityDoc).toContain('`<run-id>.capture.json`');
    // Both docs point at each other so neither side can drift alone.
    expect(captureDoc).toContain('docs/dev/action-intensity.md');
    expect(intensityDoc).toContain('docs/dev/gameplay-capture.md');
  });

  it('states the pace reference band with its calibration basis (AC5)', () => {
    expect(intensityDoc).toMatch(/### 7\.6 Pace reference band for the compiled promo/);
    expect(intensityDoc).toMatch(/Calibration basis/);
    expect(intensityDoc).toContain(`≥ ${PACE_BAND.minOpeningNonBlackRatio.toFixed(2)}`);
    expect(intensityDoc).toContain(`≥ ${PACE_BAND.minMeanIntensity.toFixed(2)}`);
    // The compile docs point at the band rather than restating numbers.
    expect(captureDoc).toContain('§7.6');
  });

  it('keeps the documented deliverable targets in step with the config (AC1)', () => {
    const promoMinutesSeconds = `${DELIVERABLE_TARGETS.promo.minMs / 1000}–${
      DELIVERABLE_TARGETS.promo.maxMs / 1000
    } s`;
    expect(captureDoc).toContain(promoMinutesSeconds);
    expect(captureDoc).toContain(`> ${DELIVERABLE_TARGETS.showreel.minMs / 60_000} min`);
    expect(captureDoc).toContain(`${DELIVERABLE_TARGETS.highlights.count} clips`);
  });

  it('documents the validation gates a compiled package must pass (AC1)', () => {
    expect(captureDoc).toMatch(/### Validation/);
    for (const gate of [
      'decodable',
      '960×540',
      'Opus',
      'non-trivial',
      'pace',
      'target sizing',
    ]) {
      expect(captureDoc.toLowerCase()).toContain(gate.toLowerCase());
    }
    expect(captureDoc).toContain('exits non-zero');
  });
});
