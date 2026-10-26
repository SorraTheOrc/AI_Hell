/**
 * Docs guard for the streamed capture, caps and partial-output behaviour
 * (AH-0MVNT2BBV008C4HT, parent AH-0MVN06MS9007LRKE AC8).
 *
 * The deliverable of this docs item is `docs/dev/gameplay-capture.md`
 * (streaming write, caps, salvage, measured long-run budget) plus the
 * user-visible partial-output + `--diagnostics` notes in the README. The doc
 * publishes three numeric contracts that code also enforces — the chunk cap,
 * the page-retention/probe-prefix budget, and the node peak-RSS target — so
 * this guard imports the live constants (the sibling docs guards' pattern:
 * a code change fails the doc instead of silently diverging) and asserts the
 * partial-output salvage path stays documented in both files.
 *
 * It deliberately does NOT pin the host-measured soak numbers (411 MiB RSS
 * etc.): those are measurements with provenance recorded in the doc, not
 * code contracts, and re-pinning them here would only generate churn when a
 * future soak re-measures on different hardware.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
  MAX_CAPTURE_CHUNK_BYTES,
} from '../scripts/capture-run-lifecycle.mjs';

const DOC_PATH = path.resolve(process.cwd(), 'docs/dev/gameplay-capture.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');

const captureDoc = fs.existsSync(DOC_PATH)
  ? fs.readFileSync(DOC_PATH, 'utf8')
  : '';
const readme = fs.existsSync(README_PATH) ? fs.readFileSync(README_PATH, 'utf8') : '';

const miB = (bytes: number) => `${bytes / (1024 * 1024)} MiB`;

describe('Streamed capture behaviour is documented (AH-0MVNT2BBV008C4HT)', () => {
  it('documents the streaming-to-disk write and the .partial.webm salvage path (AC1)', () => {
    expect(captureDoc).toMatch(/### Streaming the recording to disk/);
    expect(captureDoc).toMatch(/### Failure and salvage of streamed bytes/);
    // The partial path and the rename-only-on-success contract.
    expect(captureDoc).toContain('<stem>.partial.webm');
    expect(captureDoc).toMatch(/renam/i);
    expect(captureDoc).toMatch(/never probed/);
  });

  it('publishes the live chunk cap and retention budget, not guessed numbers (AC1)', () => {
    // The doc must state the single-sourced constants in MiB form.
    for (const constant of [
      { value: MAX_CAPTURE_CHUNK_BYTES, label: /MAX_CAPTURE_CHUNK_BYTES/ },
      {
        value: CAPTURE_PROBE_PREFIX_BUDGET_BYTES,
        label: /CAPTURE_PROBE_PREFIX_BUDGET_BYTES/,
      },
    ]) {
      expect(captureDoc).toMatch(constant.label);
      expect(captureDoc).toContain(miB(constant.value));
    }
    // The reasoning is the point: these are overflow defences.
    expect(captureDoc).toMatch(/overflow defence/i);
  });

  it('documents the measured long-run memory budget with provenance (AC1)', () => {
    // The node peak-RSS target and the diagnostics-soak provenance.
    expect(captureDoc).toMatch(/peak RSS/);
    expect(captureDoc).toMatch(/512 MiB.*target|< 512 MiB/);
    expect(captureDoc).toMatch(/diagnostics soak|--diagnostics/);
  });

  it('documents the --diagnostics flag (AC1)', () => {
    expect(captureDoc).toMatch(/### Diagnostics \(`--diagnostics`\)/);
    expect(captureDoc).toContain('--diagnostics');
  });

  it('documents the user-visible partial output in the README (AC2)', () => {
    expect(readme).toContain('<stem>.partial.webm');
    expect(readme).toMatch(/salvage/i);
    expect(readme).toMatch(/exits\s+\*\*non-zero\*\*/);
    expect(readme).toContain('--diagnostics');
  });
});
