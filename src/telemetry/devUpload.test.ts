/**
 * Unit tests for the game-side dev telemetry uploader
 * (AH-0MVBMRK6X0069QDI, parent AH-0MVBHRLY8004BGDN).
 *
 * The uploader is the game half of the dev-mode auto-upload flow: at run end
 * it POSTs the local JSONL sink's accumulated content to the same-origin dev
 * server. These tests pin the whole contract without a network or a real
 * browser:
 *
 * - the dev gate composition (dev+on uploads; dev+off, prod+on, prod+off and
 *   a missing setting never touch `fetch`);
 * - the request shape (same-origin endpoint, `POST`, NDJSON content type, the
 *   in-memory buffer content verbatim as the body);
 * - every failure path (empty buffer, unreadable buffer, rejected fetch,
 *   non-2xx) resolves without throwing;
 * - the buffer content is left intact after a successful upload (the parent's
 *   no-clear-after-upload constraint) and nothing is ever read from
 *   `localStorage` (AH-0MVIRYGD1000JVY3, AC1).
 *
 * `fetch` and the buffer reader are injected seams, so no test needs a real
 * network call or real `localStorage`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES,
  DEV_TELEMETRY_UPLOAD_CONTENT_TYPE,
  DEV_TELEMETRY_UPLOAD_ENDPOINT,
  DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES,
  MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING,
  devUploadMessageBytes,
  resolveDevUploadMaxMessageBytes,
  uploadDevTelemetry,
  type DevUploadFetch,
  type DevUploadFetchResponse,
} from './devUpload';
import type { DevModeEnv, DevTelemetrySetting } from './devMode';

const DEV: DevModeEnv = { DEV: true };
const PROD: DevModeEnv = { DEV: false, PROD: true };
const ON: DevTelemetrySetting = { shareTelemetryDev: true };
const OFF: DevTelemetrySetting = { shareTelemetryDev: false };

/** A representative accumulated sink payload (NDJSON, trailing newline). */
const SINK_CONTENT = '{"kind":"run_header","runSeed":7}\n{"kind":"tick","tick":1}\n';

/** A `fetch` spy that records calls and resolves with `response`. */
function fetchSpy(
  response: DevUploadFetchResponse = { ok: true, status: 200 },
): ReturnType<typeof vi.fn<DevUploadFetch>> {
  return vi.fn<DevUploadFetch>(async () => response);
}

/** Options that upload successfully unless a test overrides them. */
function uploading(fetchImpl: DevUploadFetch) {
  return {
    env: DEV,
    setting: ON,
    readSink: () => SINK_CONTENT,
    fetchImpl,
  } as const;
}

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('uploadDevTelemetry — dev gate composition', () => {
  it('uploads when the build is dev and the setting is on (dev+on)', async () => {
    const fetchImpl = fetchSpy();

    await expect(uploadDevTelemetry(uploading(fetchImpl))).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the setting is off (dev+off)', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({ env: DEV, setting: OFF, readSink: () => SINK_CONTENT, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing in a production build even with the setting on (prod+on)', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({ env: PROD, setting: ON, readSink: () => SINK_CONTENT, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does nothing in a production build with the setting off (prod+off)', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({ env: PROD, setting: OFF, readSink: () => SINK_CONTENT, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a missing setting as opted out', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({ env: DEV, readSink: () => SINK_CONTENT, fetchImpl }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('uploadDevTelemetry — request shape', () => {
  it('POSTs the sink content same-origin as NDJSON', async () => {
    const fetchImpl = fetchSpy();

    await uploadDevTelemetry(uploading(fetchImpl));

    expect(fetchImpl).toHaveBeenCalledWith(DEV_TELEMETRY_UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': DEV_TELEMETRY_UPLOAD_CONTENT_TYPE },
      body: SINK_CONTENT,
    });
    // Same-origin: the endpoint is a relative path, never an absolute URL.
    expect(DEV_TELEMETRY_UPLOAD_ENDPOINT.startsWith('/')).toBe(true);
    expect(DEV_TELEMETRY_UPLOAD_ENDPOINT).toBe('/api/telemetry/upload');
    expect(DEV_TELEMETRY_UPLOAD_CONTENT_TYPE).toBe('application/x-ndjson');
  });

  it('sends the body verbatim, including its trailing newline', async () => {
    const fetchImpl = fetchSpy();

    await uploadDevTelemetry(uploading(fetchImpl));

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.body).toBe(SINK_CONTENT);
    expect(init?.body.endsWith('\n')).toBe(true);
  });

  it('uses the injected endpoint when one is supplied', async () => {
    const fetchImpl = fetchSpy();

    await uploadDevTelemetry({ ...uploading(fetchImpl), endpoint: '/api/telemetry/upload?run=7' });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/telemetry/upload?run=7');
  });
});

describe('uploadDevTelemetry — failure paths never throw', () => {
  it('makes no request when the sink is empty (null)', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({ ...uploading(fetchImpl), readSink: () => null }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('makes no request when the sink holds only whitespace', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({ ...uploading(fetchImpl), readSink: () => '  \n\t' }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('swallows a rejected fetch and reports it', async () => {
    const onError = vi.fn();
    const failure = new Error('network down');
    const fetchImpl = vi.fn<DevUploadFetch>(async () => {
      throw failure;
    });

    await expect(uploadDevTelemetry({ ...uploading(fetchImpl), onError })).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('swallows a non-2xx response', async () => {
    const onError = vi.fn();
    const fetchImpl = fetchSpy({ ok: false, status: 422 });

    await expect(uploadDevTelemetry({ ...uploading(fetchImpl), onError })).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('swallows an unreadable sink (storage throwing)', async () => {
    const fetchImpl = fetchSpy();

    await expect(
      uploadDevTelemetry({
        ...uploading(fetchImpl),
        readSink: () => {
          throw new Error('storage disabled');
        },
      }),
    ).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('uploadDevTelemetry — injected seams', () => {
  it('reads the in-memory buffer through readSink and leaves it intact (AC1)', async () => {
    const fetchImpl = fetchSpy();
    // With no storage configured at all, the body can only come from memory.
    const readSink = vi.fn(() => SINK_CONTENT);

    await expect(
      uploadDevTelemetry({ env: DEV, setting: ON, readSink, fetchImpl }),
    ).resolves.toBe(true);

    expect(fetchImpl.mock.calls[0]?.[1].body).toBe(SINK_CONTENT);
    expect(readSink).toHaveBeenCalledTimes(1);
    // Parent constraint: nothing clears the buffer after upload; the dev
    // tooling reads the same run until the next one starts.
    expect(readSink()).toBe(SINK_CONTENT);
  });

  it('never reads or writes localStorage while uploading', async () => {
    const getItem = vi.fn(() => null);
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem, setItem, removeItem: vi.fn(), clear: vi.fn() });
    const fetchImpl = fetchSpy();

    await uploadDevTelemetry(uploading(fetchImpl));

    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('defaults to the global fetch when none is injected', async () => {
    const globalFetch = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', globalFetch);

    await expect(
      uploadDevTelemetry({ env: DEV, setting: ON, readSink: () => SINK_CONTENT }),
    ).resolves.toBe(true);
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Run-end upload size cap (AH-0MVNVGP55002G0KH).
 *
 * Playwright reports an upload's body as `request.postData` inside a single
 * `Network.requestWillBeSent` CDP message, so a long run's telemetry POST can
 * overflow the page→node pipe (V8's 512 MiB string cap) and kill the capture.
 * The uploader therefore refuses to POST a body above a documented, injectable
 * cap before the request exists — the only place where the bound can be
 * applied (the server's 16 MiB `413` arrives far too late).
 */
describe('uploadDevTelemetry — run-end upload size cap (AH-0MVNVGP55002G0KH)', () => {
  /**
   * The message an upload of `body` produces. Playwright embeds the body as the
   * escaped `postData` JSON string, so the cap is metered on the escaped size
   * (~2.4× on real NDJSON), never on the raw telemetry length.
   */
  const messageBytes = (body: string): number => devUploadMessageBytes(body);

  it('skips an over-cap payload instead of POSTing it', async () => {
    const fetchImpl = fetchSpy();
    const onSkip = vi.fn();
    const body = 'x'.repeat(64);

    await expect(
      uploadDevTelemetry({
        ...uploading(fetchImpl),
        readSink: () => body,
        maxMessageBytes: 32,
        onSkip,
      }),
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    // The raw body alone already exceeds the budget, so it is never escaped.
    expect(onSkip).toHaveBeenCalledWith({ bytes: 64, messageBytes: 64, maxMessageBytes: 32 });
  });

  it('meters the escaped message, so a body under the cap can still be skipped', async () => {
    const fetchImpl = fetchSpy();
    const onSkip = vi.fn();
    // 40 raw bytes, but the escaped message (quotes, escaping, envelope) is
    // what the CDP pipe carries, so a 64-byte budget cannot carry it.
    const body = '"quoted"'.repeat(5);

    await uploadDevTelemetry({
      ...uploading(fetchImpl),
      readSink: () => body,
      maxMessageBytes: 64,
      onSkip,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(messageBytes(body)).toBeGreaterThan(64);
    expect(onSkip).toHaveBeenCalledWith({
      bytes: 40,
      messageBytes: messageBytes(body),
      maxMessageBytes: 64,
    });
  });

  it('reports one actionable line by default when a payload is skipped', async () => {
    const fetchImpl = fetchSpy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await uploadDevTelemetry({
      ...uploading(fetchImpl),
      readSink: () => 'x'.repeat(64),
      maxMessageBytes: 32,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    // Names the size it refused, the cap, and the knob that raises it.
    expect(line).toContain('64');
    expect(line).toContain('32');
    expect(line).toContain('VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES');
  });

  it('uploads a payload whose message size equals the cap (inclusive bound)', async () => {
    const fetchImpl = fetchSpy();
    // `'x'` needs no escaping: JSON.stringify adds exactly the two quotes.
    // The metered message always carries the CDP envelope reserve, so the
    // budget must clear it for the boundary to be reachable at all.
    const budget = DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES + 512;
    const body = 'x'.repeat(
      budget - DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES - 2,
    );
    expect(messageBytes(body)).toBe(budget);

    await expect(
      uploadDevTelemetry({ ...uploading(fetchImpl), readSink: () => body, maxMessageBytes: budget }),
    ).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('applies the documented 8 MiB default cap with no override supplied', async () => {
    const fetchImpl = fetchSpy();
    const onSkip = vi.fn();
    // One byte over the default: exactly the boundary a long run crosses.
    const body = 'x'.repeat(DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES + 1);

    await expect(
      uploadDevTelemetry({ ...uploading(fetchImpl), readSink: () => body, onSkip }),
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({
      bytes: DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES + 1,
      messageBytes: DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES + 1,
      maxMessageBytes: DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES,
    });
  });

  it('honours an injected environment cap for the call (maxMessageBytes still wins)', async () => {
    const fetchImpl = fetchSpy();
    const onSkip = vi.fn();
    const capped = { ...DEV, VITE_TELEMETRY_MAX_UPLOAD_MESSAGE_BYTES: '1024' };

    await uploadDevTelemetry({
      env: capped,
      setting: ON,
      readSink: () => 'x'.repeat(2048),
      fetchImpl,
      onSkip,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({
      bytes: 2048,
      messageBytes: 2048,
      maxMessageBytes: 1024,
    });

    // An explicit option is authoritative over the environment. It must also
    // clear the CDP envelope reserve that is always added to the metered size.
    await uploadDevTelemetry({
      env: capped,
      setting: ON,
      readSink: () => 'x'.repeat(2048),
      fetchImpl,
      maxMessageBytes: DEV_UPLOAD_CDP_ENVELOPE_RESERVE_BYTES + 4096,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('resolves the cap from the environment, falling back and clamping', () => {
    expect(DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES).toBe(8 * 1024 * 1024);
    // The client cap must never exceed the server's documented 16 MiB bound.
    expect(MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING).toBe(16 * 1024 * 1024);
    expect(DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES).toBeLessThanOrEqual(
      MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING,
    );

    expect(resolveDevUploadMaxMessageBytes(undefined)).toBe(DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES);
    expect(resolveDevUploadMaxMessageBytes('1048576')).toBe(1_048_576);
    // Absent/invalid/non-positive values fall back to the documented default.
    for (const invalid of ['', '   ', 'lots', '0', '-5', '1.5', 'NaN']) {
      expect(resolveDevUploadMaxMessageBytes(invalid)).toBe(
        DEFAULT_MAX_DEV_UPLOAD_MESSAGE_BYTES,
      );
    }
    // A cap raised past the server bound is clamped, never honoured.
    expect(resolveDevUploadMaxMessageBytes(String(64 * 1024 * 1024))).toBe(
      MAX_DEV_UPLOAD_MESSAGE_BYTES_CEILING,
    );
  });

  it('counts UTF-8 bytes of the escaped body, so multibyte content cannot slip past', async () => {
    const fetchImpl = fetchSpy();
    const onSkip = vi.fn();
    // 10 chars, 30 UTF-8 bytes: over a 20-byte budget only when measured in bytes.
    const body = '\u2603'.repeat(10);

    await uploadDevTelemetry({
      ...uploading(fetchImpl),
      readSink: () => body,
      maxMessageBytes: 20,
      onSkip,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({ bytes: 30, messageBytes: 30, maxMessageBytes: 20 });
  });
});
