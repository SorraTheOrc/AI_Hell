/**
 * Docs guard for the dev-mode auto-upload + automatic evaluation flow
 * (AH-0MVBHRLY8004BGDN, F7 AH-0MVBMRR4R004UOLH).
 *
 * The user-facing contract of the flow lives in two documents:
 *
 * - `docs/TELEMETRY.md` — the dev-mode gate, the setting, the upload endpoint,
 *   the stored recording and the automatic evaluation artifacts.
 * - `docs/dev/recording-and-replay.md` — the recorder-adjacent view: a stock
 *   `npm run dev` records and uploads at run end, and the dev server evaluates
 *   the recording automatically.
 *
 * Like the sibling docs guards (`evaluationDocs.test.ts`,
 * `weaponVisualRoster.docs.test.ts`) this is a deliberate docs grep: it
 * asserts the canonical documentation text, not runtime behaviour. The
 * runtime contracts are pinned by `devMode.test.ts`, `devUpload.test.ts` and
 * `../../vite/plugins/telemetryUploadPlugin.test.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const TELEMETRY_DOC = path.resolve(process.cwd(), 'docs/TELEMETRY.md');
const RECORDING_DOC = path.resolve(
  process.cwd(),
  'docs/dev/recording-and-replay.md',
);
const PARENT_ID = 'AH-0MVBHRLY8004BGDN';
const DOCS_CHILD_ID = 'AH-0MVBMRR4R004UOLH';

function readDoc(docPath: string): string {
  return fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
}

describe('dev-mode telemetry upload and automatic evaluation are documented', () => {
  const telemetryDoc = readDoc(TELEMETRY_DOC);
  const recordingDoc = readDoc(RECORDING_DOC);

  it('both documents exist', () => {
    expect(fs.existsSync(TELEMETRY_DOC)).toBe(true);
    expect(fs.existsSync(RECORDING_DOC)).toBe(true);
  });

  it('TELEMETRY.md describes the dev-mode upload flow end to end', () => {
    // A dedicated section carries the whole contract.
    expect(telemetryDoc).toMatch(
      /^## .*[Dd]ev-mode.*(upload|evaluation)/m,
    );
    expect(telemetryDoc).toContain('/api/telemetry/upload');
    expect(telemetryDoc).toContain('recordings/session-');
    expect(telemetryDoc).toContain('eval-output/uploaded');
    expect(telemetryDoc).toContain('human-balance-report.json');
    expect(telemetryDoc).toContain('evaluation.log');
  });

  it('TELEMETRY.md names the setting, the default and the dev gate', () => {
    expect(telemetryDoc).toContain('Share with dev server');
    expect(telemetryDoc).toContain('shareTelemetryDev');
    expect(telemetryDoc).toMatch(/default\s+\*{0,2}on\*{0,2}/i);
    expect(telemetryDoc).toContain('src/telemetry/devMode.ts');
    expect(telemetryDoc).toContain('isDevTelemetryUploadEnabled');
  });

  it('TELEMETRY.md states the production guarantee and the opt-out behaviour', () => {
    expect(telemetryDoc).toMatch(/apply: 'serve'|apply: \"serve\"/);
    expect(telemetryDoc).toMatch(/vite preview/);
    expect(telemetryDoc).toMatch(/neither collects nor uploads|no upload request/);
    expect(telemetryDoc).toMatch(/left\s+intact|left\s+unchanged/);
  });

  it('recording-and-replay.md documents the automatic upload at run end', () => {
    expect(recordingDoc).toMatch(/^### .*[Aa]utomatic.*(upload|evaluation)/m);
    expect(recordingDoc).toContain('/api/telemetry/upload');
    expect(recordingDoc).toContain('recordings/session-');
    expect(recordingDoc).toContain('eval-output/uploaded');
    expect(recordingDoc).toContain('human-balance-report.json');
    expect(recordingDoc).toContain('Share with dev server');
    expect(recordingDoc).toContain('../TELEMETRY.md');
  });

  it('both documents reference the parent feature and the docs slice', () => {
    for (const doc of [telemetryDoc, recordingDoc]) {
      expect(doc).toContain(PARENT_ID);
      expect(doc).toContain(DOCS_CHILD_ID);
    }
  });
});
