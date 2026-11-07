/**
 * Docs guard for the dev streaming part protocol (AH-0MW6NNRJ0009FRTO, parent
 * AH-0MVJUAADW0033QBD).
 *
 * The user-facing contract of streaming lives in three documents:
 *
 * - `docs/TELEMETRY.md` — the part protocol (run key, cumulative offset,
 *   `final`), the loss bound, the offline/retry behaviour and the crashed-run
 *   partial.
 * - `docs/dev/gameplay-capture.md` — how streaming affects capture: the page
 *   buffer is never cleared mid-run, parts are staged off the `session-*.jsonl`
 *   glob and the upload cap still bounds the run-end final part.
 * - `docs/dev/recording-and-replay.md` — the recorder-adjacent view: streaming
 *   during the run, one evaluation per completed run and the crashed-run
 *   partial's inspection/evaluation semantics.
 *
 * Like the sibling docs guards (`devModeDocs.test.ts`,
 * `evaluationDocs.test.ts`) this is a deliberate docs grep: it asserts the
 * canonical documentation text, not runtime behaviour. The runtime contracts
 * are pinned by `devStream.test.ts`, `devStreamProtocol.test.ts` and
 * `../../vite/plugins/telemetryUploadPlugin.test.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const TELEMETRY_DOC = path.resolve(process.cwd(), 'docs/TELEMETRY.md');
const CAPTURE_DOC = path.resolve(process.cwd(), 'docs/dev/gameplay-capture.md');
const RECORDING_DOC = path.resolve(
  process.cwd(),
  'docs/dev/recording-and-replay.md',
);

/** The stale single-run-end-upload phrasings the streaming change retires. */
const STALE_PHRASES = [
  "POSTs the whole run's telemetry",
  'uploaded once at run end',
  'the whole run at run end',
];

function readDoc(docPath: string): string {
  return fs.existsSync(docPath) ? fs.readFileSync(docPath, 'utf8') : '';
}

describe('the streaming part protocol is documented', () => {
  const telemetryDoc = readDoc(TELEMETRY_DOC);
  const captureDoc = readDoc(CAPTURE_DOC);
  const recordingDoc = readDoc(RECORDING_DOC);

  it('all three documents exist', () => {
    expect(fs.existsSync(TELEMETRY_DOC)).toBe(true);
    expect(fs.existsSync(CAPTURE_DOC)).toBe(true);
    expect(fs.existsSync(RECORDING_DOC)).toBe(true);
  });

  it('TELEMETRY.md documents the part protocol and its wire shape', () => {
    expect(telemetryDoc).toMatch(
      /^### .*[Ss]treaming.*(part|upload)/m,
    );
    // Run key, cumulative offset and the final flag.
    expect(telemetryDoc).toContain('<startedAt>-<runSeed>');
    expect(telemetryDoc).toContain('x-telemetry-offset');
    expect(telemetryDoc).toContain('x-telemetry-final');
    expect(telemetryDoc).toMatch(/confirm(ed)?/);
    // Exactly-once: dedupe on a retried part and a rejected gap.
    expect(telemetryDoc).toMatch(/deduplicat/);
    expect(telemetryDoc).toContain('409');
    // The serialised part chain.
    expect(telemetryDoc).toMatch(/[Ss]erialised/);
  });

  it('TELEMETRY.md states the loss bound of an interrupted run', () => {
    expect(telemetryDoc).toMatch(/loss bound/i);
    expect(telemetryDoc).toContain('≤ 64 records');
    expect(telemetryDoc).toMatch(/ring buffer/);
    expect(telemetryDoc).toMatch(/~2\.5 s/);
  });

  it('TELEMETRY.md documents the offline/retry behaviour and the cap', () => {
    expect(telemetryDoc).toMatch(/[Oo]ffline and retry/);
    expect(telemetryDoc).toContain('DEFAULT_PART_MAX_ATTEMPTS');
    expect(telemetryDoc).toMatch(/backoff/);
    expect(telemetryDoc).toContain('8 MiB');
  });

  it('TELEMETRY.md documents parts staging and the crashed-run partial', () => {
    expect(telemetryDoc).toContain('recordings/parts/<runKey>.jsonl');
    expect(telemetryDoc).toMatch(/session-\*\.jsonl/);
    expect(telemetryDoc).toMatch(/not\W{0,10}auto-evaluated/);
    // The partial is valid NDJSON and usable by the existing CLI tooling.
    expect(telemetryDoc).toMatch(/valid NDJSON/);
    expect(telemetryDoc).toContain('telemetry:inspect');
    expect(telemetryDoc).toContain('scripts/evaluate.mjs');
  });

  it('gameplay-capture.md documents what streaming keeps for a capture', () => {
    expect(captureDoc).toContain('recordings/parts/<runKey>.jsonl');
    expect(captureDoc).toContain('window.__aiHellTelemetry');
    expect(captureDoc).toMatch(/never cleared/);
    expect(captureDoc).toMatch(/not auto-evaluated/);
    expect(captureDoc).toMatch(/session-\*\.jsonl/);
  });

  it('recording-and-replay.md documents streaming and the partial', () => {
    expect(recordingDoc).toMatch(/^### .*[Aa]utomatic.*(upload|evaluation)/m);
    expect(recordingDoc).toMatch(/final part/);
    expect(recordingDoc).toContain('recordings/parts/<runKey>.jsonl');
    expect(recordingDoc).toContain('eval-output/uploaded');
    expect(recordingDoc).toMatch(/not\W{0,10}auto-evaluated/);
    expect(recordingDoc).toContain('window.__aiHellTelemetry');
  });

  it('no document still describes a single whole-run upload at run end', () => {
    for (const [name, doc] of [
      ['docs/TELEMETRY.md', telemetryDoc],
      ['docs/dev/gameplay-capture.md', captureDoc],
      ['docs/dev/recording-and-replay.md', recordingDoc],
    ] as const) {
      for (const stale of STALE_PHRASES) {
        expect(doc, `${name} still says: ${stale}`).not.toContain(stale);
      }
    }
  });
});
