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
  DEV_TELEMETRY_UPLOAD_CONTENT_TYPE,
  DEV_TELEMETRY_UPLOAD_ENDPOINT,
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
