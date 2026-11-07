/**
 * Hermetic tests for the dev streaming telemetry uploader
 * (AH-0MW6NI6BW003RJWH, parent AH-0MVJUAADW0033QBD).
 *
 * Every part send goes through an injected `fetch` and an injected buffer
 * reader, so the happy-path streaming contract is pinned without a network, a
 * dev server or a clock: one part per flush in flush order, a watermark that
 * only advances to the server-confirmed count, a final part that finalises
 * exactly once, the CDP-message cap, and a buffer that is never cleared.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  PART_FINAL_HEADER,
  PART_MARKER_HEADER,
  PART_OFFSET_HEADER,
  PART_RUN_KEY_HEADER,
  deriveRunKey,
} from './devStreamProtocol';
import { createDevTelemetryStreamer } from './devStream';
import type { DevUploadFetch, DevUploadFetchResponse } from './devUpload';

/** A schema-independent record line (the protocol never parses JSON). */
function record(index: number): string {
  return JSON.stringify({ kind: 'tick', tick: index, state: { index } });
}

/** One recorded part request. */
interface PartCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** The part's offset header, as a number. */
  readonly offset: number;
  /** Whether the part carried the final marker. */
  readonly final: boolean;
}

/** A buffer the streamer reads, mutated by the test like the real sink. */
class FakeBuffer {
  readonly lines: string[] = [];

  append(...indexes: number[]): void {
    for (const index of indexes) this.lines.push(record(index));
  }

  /** The buffer as NDJSON, exactly the shape `readBuffer()` returns. */
  read(): string {
    return this.lines.length === 0 ? '' : `${this.lines.join('\n')}\n`;
  }
}

/** Deterministic server stand-in: records parts and answers with a count. */
function createServer(
  respond: (call: PartCall) => DevUploadFetchResponse | Promise<DevUploadFetchResponse> = (
    call,
  ) => jsonResponse({ ok: true, confirmedCount: call.offset + countLines(call.body) }),
): { fetchImpl: DevUploadFetch; calls: PartCall[] } {
  const calls: PartCall[] = [];
  const fetchImpl: DevUploadFetch = async (url, init) => {
    const headers = { ...init.headers };
    const call: PartCall = {
      url,
      method: init.method,
      headers,
      body: init.body,
      offset: Number(headers[PART_OFFSET_HEADER]),
      final: headers[PART_FINAL_HEADER] === '1',
    };
    calls.push(call);
    return respond(call);
  };
  return { fetchImpl, calls };
}

/** A `fetch` response carrying a JSON payload. */
function jsonResponse(payload: unknown, status = 200): DevUploadFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

/** Records in an NDJSON body. */
function countLines(body: string): number {
  return body.split('\n').filter((line) => line.trim().length > 0).length;
}

/** Builds a streamer over a fake buffer with the gate open. */
function streamer(
  buffer: FakeBuffer,
  fetchImpl: DevUploadFetch,
  overrides: Partial<Parameters<typeof createDevTelemetryStreamer>[0]> = {},
) {
  return createDevTelemetryStreamer({
    startedAt: 1_700_000_000_000,
    runSeed: 7,
    readBuffer: () => buffer.read(),
    getSetting: () => ({ shareTelemetryDev: true }),
    env: { DEV: true },
    fetchImpl,
    maxMessageBytes: 1024 * 1024,
    ...overrides,
  });
}

describe('dev stream — happy-path part streaming (AC1)', () => {
  it('sends one part per flush, in flush order, carrying only the new records', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl);

    buffer.append(1, 2, 3);
    stream.push(buffer.read());
    await stream.whenIdle();

    buffer.append(4, 5);
    stream.push(record(5));
    await stream.whenIdle();

    expect(server.calls).toHaveLength(2);
    expect(server.calls.map((call) => call.offset)).toEqual([0, 3]);
    expect(server.calls.map((call) => countLines(call.body))).toEqual([3, 2]);
    expect(server.calls[0]!.body).toBe(`${record(1)}\n${record(2)}\n${record(3)}\n`);
    expect(server.calls[1]!.body).toBe(`${record(4)}\n${record(5)}\n`);
    // Every part is marked, keyed and posted to the dev upload endpoint.
    for (const call of server.calls) {
      expect(call.url).toBe('/api/telemetry/upload');
      expect(call.method).toBe('POST');
      expect(call.headers[PART_MARKER_HEADER]).toBe('1');
      expect(call.headers[PART_RUN_KEY_HEADER]).toBe(stream.runKey);
      expect(call.final).toBe(false);
    }
    expect(stream.confirmedCount).toBe(5);
    expect(stream.sentParts).toBe(2);
  });

  it('derives its run key from the run header start time and seed', () => {
    const server = createServer();
    const stream = streamer(new FakeBuffer(), server.fetchImpl);

    expect(stream.runKey).toBe(deriveRunKey(1_700_000_000_000, 7));
  });

  it('streams everything already buffered when it subscribes late', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    // The first batches were flushed before the (async) dev loader resolved.
    buffer.append(1, 2, 3);
    const stream = streamer(buffer, server.fetchImpl);

    stream.push(record(3));
    await stream.whenIdle();

    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]!.offset).toBe(0);
    expect(countLines(server.calls[0]!.body)).toBe(3);
  });

  it('does not send an empty mid-run part', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl);

    stream.push(record(1));
    await stream.whenIdle();

    expect(server.calls).toEqual([]);
  });

  it('serialises parts so a slow response cannot reorder them', async () => {
    const buffer = new FakeBuffer();
    const release: Array<() => void> = [];
    const server = createServer((call) => {
      // The first part only answers once the test releases it.
      if (call.offset !== 0) {
        return jsonResponse({ ok: true, confirmedCount: call.offset + countLines(call.body) });
      }
      return new Promise<DevUploadFetchResponse>((resolve) => {
        release.push(() =>
          resolve(
            jsonResponse({ ok: true, confirmedCount: call.offset + countLines(call.body) }),
          ),
        );
      });
    });
    const stream = streamer(buffer, server.fetchImpl);

    buffer.append(1);
    stream.push(record(1));
    // Let the first part start (and block on the server) before the next batch
    // is flushed, so both parts have distinct content.
    await Promise.resolve();
    expect(server.calls).toHaveLength(1);

    buffer.append(2);
    stream.push(record(2));
    await Promise.resolve();
    // Nothing may overtake the in-flight first part.
    expect(server.calls).toHaveLength(1);

    release.shift()!();
    await stream.whenIdle();

    expect(server.calls.map((call) => call.offset)).toEqual([0, 1]);
    expect(countLines(server.calls[0]!.body)).toBe(1);
    expect(countLines(server.calls[1]!.body)).toBe(1);
  });
});

describe('dev stream — server-authoritative watermark (AC1)', () => {
  it('advances only to the cumulative count the server reports', async () => {
    const buffer = new FakeBuffer();
    // The server confirms fewer records than the part carried (the tail of the
    // body was dropped), so the client must not assume the larger count.
    const server = createServer(() => jsonResponse({ ok: true, confirmedCount: 1 }));
    const stream = streamer(buffer, server.fetchImpl);

    buffer.append(1, 2, 3);
    stream.push(buffer.read());
    await stream.whenIdle();

    expect(stream.confirmedCount).toBe(1);

    stream.push(record(3));
    await stream.whenIdle();

    expect(server.calls.map((call) => call.offset)).toEqual([0, 1]);
    expect(countLines(server.calls[1]!.body)).toBe(2);
  });

  it('leaves the watermark untouched when a part is rejected and retries it', async () => {
    const buffer = new FakeBuffer();
    const onError = vi.fn();
    const server = createServer(() => jsonResponse({ ok: false, errors: ['nope'] }, 500));
    const stream = streamer(buffer, server.fetchImpl, { onError });

    buffer.append(1, 2);
    stream.push(buffer.read());
    await stream.whenIdle();

    expect(stream.confirmedCount).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    // The records stay pending in memory and are re-sent from the same offset.
    buffer.append(3);
    stream.push(record(3));
    await stream.whenIdle();

    expect(server.calls.map((call) => call.offset)).toEqual([0, 0]);
    expect(countLines(server.calls[1]!.body)).toBe(3);
  });

  it('adopts the server count when a part is refused as a gap', async () => {
    const buffer = new FakeBuffer();
    const server = createServer((call) =>
      call.offset === 0
        ? jsonResponse(
            { ok: false, errors: ['gap'], confirmedCount: 2 },
            409,
          )
        : jsonResponse({ ok: true, confirmedCount: call.offset + countLines(call.body) }),
    );
    const stream = streamer(buffer, server.fetchImpl, { onError: () => {} });

    buffer.append(1, 2, 3);
    stream.push(buffer.read());
    await stream.whenIdle();

    expect(stream.confirmedCount).toBe(2);

    stream.push(record(3));
    await stream.whenIdle();

    expect(server.calls.map((call) => call.offset)).toEqual([0, 2]);
    expect(countLines(server.calls[1]!.body)).toBe(1);
  });
});

describe('dev stream — run end finalisation (AC1)', () => {
  it('sends the remaining records as one final part and stops', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl);

    buffer.append(1, 2);
    stream.push(buffer.read());
    await stream.whenIdle();
    buffer.append(3);
    // The run's remaining tail is flushed at run end, then finalised.
    stream.push(record(3));

    const finalised = await stream.finalise();

    expect(finalised).toBe(true);
    expect(stream.finalised).toBe(true);
    expect(server.calls).toHaveLength(3);
    const finalCall = server.calls[2]!;
    expect(finalCall.final).toBe(true);
    // The pushed tail went out as an ordinary part (offset 2, one record); by
    // the final part everything is confirmed, so it only finalises.
    expect(server.calls[1]!.offset).toBe(2);
    expect(countLines(server.calls[1]!.body)).toBe(1);
    expect(finalCall.offset).toBe(3);
    expect(countLines(finalCall.body)).toBe(0);
    expect(stream.confirmedCount).toBe(3);

    // A second finalise is idempotent: no extra request.
    await expect(stream.finalise()).resolves.toBe(true);
    expect(server.calls).toHaveLength(3);
  });

  it('finalises with an empty part when everything is already confirmed', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl);

    buffer.append(1, 2);
    stream.push(buffer.read());
    await stream.whenIdle();

    await stream.finalise();

    expect(server.calls.map((call) => call.final)).toEqual([false, true]);
    expect(server.calls[1]!.body).toBe('');
    expect(server.calls[1]!.offset).toBe(2);
  });

  it('does not finalise a run that recorded nothing', async () => {
    const server = createServer();
    const onError = vi.fn();
    const stream = streamer(new FakeBuffer(), server.fetchImpl, { onError });

    // Nothing was ever buffered (recording disabled for the run), so there is
    // nothing to store — and no error to report either.
    await expect(stream.finalise()).resolves.toBe(false);

    expect(server.calls).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports failure and leaves the run unfinalised when the final part fails', async () => {
    const buffer = new FakeBuffer();
    const server = createServer(() => jsonResponse({ ok: false, errors: ['down'] }, 500));
    const stream = streamer(buffer, server.fetchImpl, { onError: () => {} });

    buffer.append(1);
    const finalised = await stream.finalise();

    expect(finalised).toBe(false);
    expect(stream.finalised).toBe(false);
    // The whole buffer is still pending, so a later retry can still deliver it.
    expect(stream.confirmedCount).toBe(0);
  });
});

describe('dev stream — bounded bodies (AC4)', () => {
  it('skips an over-cap part with one actionable line and keeps the watermark', async () => {
    const buffer = new FakeBuffer();
    const onSkip = vi.fn();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl, {
      onSkip,
      maxMessageBytes: 200,
    });

    buffer.append(1, 2, 3, 4, 5);
    stream.push(buffer.read());
    const finalised = await stream.finalise();

    expect(server.calls).toEqual([]);
    expect(stream.confirmedCount).toBe(0);
    expect(finalised).toBe(false);
    expect(onSkip).toHaveBeenCalled();
    const skip = onSkip.mock.calls[0]![0] as { maxMessageBytes: number };
    expect(skip.maxMessageBytes).toBe(200);
  });

  it('keeps a part small enough by construction when each part is one batch', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    // A realistic cap: one 64-record batch is orders of magnitude under it.
    const stream = streamer(buffer, server.fetchImpl, { maxMessageBytes: 8 * 1024 * 1024 });

    buffer.append(...Array.from({ length: 64 }, (_, index) => index));
    stream.push(buffer.read());
    await stream.whenIdle();

    expect(server.calls).toHaveLength(1);
    expect(countLines(server.calls[0]!.body)).toBe(64);
  });
});

describe('dev stream — the buffer is never cleared (AC2)', () => {
  it('leaves the page buffer intact through streaming and finalisation', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl);

    buffer.append(1, 2);
    stream.push(buffer.read());
    buffer.append(3);
    await stream.finalise();

    // Every record is still readable: the CLI tooling and the run-end
    // whole-file fallback depend on it.
    expect(buffer.lines).toEqual([record(1), record(2), record(3)]);
    expect(buffer.read()).toBe(`${record(1)}\n${record(2)}\n${record(3)}\n`);
  });
});

describe('dev stream — dev-only containment (AC5)', () => {
  it('sends nothing when the share setting is off', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    let shareTelemetryDev = false;
    const stream = streamer(buffer, server.fetchImpl, {
      getSetting: () => ({ shareTelemetryDev }),
    });

    buffer.append(1, 2);
    stream.push(buffer.read());
    await expect(stream.finalise()).resolves.toBe(false);

    expect(server.calls).toEqual([]);
    expect(stream.confirmedCount).toBe(0);

    // Turning the setting on mid-run lets the run be delivered at run end.
    shareTelemetryDev = true;
    await expect(stream.finalise()).resolves.toBe(true);
    expect(server.calls).toHaveLength(1);
    expect(countLines(server.calls[0]!.body)).toBe(2);
  });

  it('sends nothing in a production build', async () => {
    const buffer = new FakeBuffer();
    const server = createServer();
    const stream = streamer(buffer, server.fetchImpl, {
      env: { PROD: true },
    });

    buffer.append(1);
    stream.push(buffer.read());
    await expect(stream.finalise()).resolves.toBe(false);

    expect(server.calls).toEqual([]);
  });
});
