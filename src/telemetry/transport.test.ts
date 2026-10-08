/**
 * Tests for the production remote transport (AH-0MUY08Y9P005ER7A, AC2/AC4).
 *
 * The policy under test: batches are POSTed as a versioned envelope; only
 * transient failures are retried (with exponential backoff); permanent
 * failures and exhausted retries are dropped without throwing; and an
 * offline device never even attempts an upload. Everything (fetch, sleep,
 * randomness, connectivity) is injected, so no real timers or network are
 * used.
 */

import { describe, expect, it, vi } from 'vitest';

import type { TelemetryConfig } from './config';
import { createTelemetryRecorder } from './recorder';
import { TELEMETRY_SCHEMA_VERSION, type TelemetryRecord } from './schema';
import {
  DEFAULT_BASE_DELAY_MS,
  HttpTelemetryTransport,
  createHttpTransport,
  isRetryableStatus,
  type TelemetryFetch,
} from './transport';

const RECORD: TelemetryRecord = {
  kind: 'event',
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  tick: 1,
  event: 'run_start',
  payload: { v: 1 },
};

/** A fetch response helper. */
function response(status: number): { ok: boolean; status: number } {
  return { ok: status >= 200 && status < 300, status };
}

/** A queued fetch: each call resolves/rejects with the next step. */
function queueFetch(
  steps: Array<() => Promise<{ ok: boolean; status: number }>>,
): TelemetryFetch {
  let index = 0;
  return vi.fn(async () => {
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return step();
  });
}

/** Records the delays passed to the injected sleep. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function transport(
  fetchImpl: TelemetryFetch,
  overrides: Partial<ConstructorParameters<typeof HttpTelemetryTransport>[0]> = {},
): HttpTelemetryTransport {
  return new HttpTelemetryTransport({
    endpoint: 'https://telemetry.example/ingest',
    fetchImpl,
    random: () => 0,
    isOnline: () => true,
    sleep: async () => {},
    ...overrides,
  });
}

describe('isRetryableStatus', () => {
  it('retries timeouts, rate limits and 5xx, but not other 4xx', () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(425)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });
});

describe('HttpTelemetryTransport — upload (AC2)', () => {
  it('POSTs a versioned envelope to the configured endpoint', async () => {
    const fetchImpl = vi.fn(async () => response(204));
    const t = transport(fetchImpl as unknown as TelemetryFetch);

    await t.send([RECORD]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; body: string; headers: Record<string, string> }];
    expect(url).toBe('https://telemetry.example/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      records: [RECORD],
    });
    expect(t.stats).toMatchObject({ batches: 1, delivered: 1, dropped: 0, attempts: 1 });
  });

  it('does nothing for an empty batch', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const t = transport(fetchImpl as unknown as TelemetryFetch);

    await t.send([]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.stats.batches).toBe(0);
  });
});

describe('HttpTelemetryTransport — retry/backoff (AC2)', () => {
  it('retries a 5xx with exponential backoff, then delivers', async () => {
    const fetchImpl = queueFetch([
      async () => response(503),
      async () => response(500),
      async () => response(202),
    ]);
    const { sleep, delays } = recordingSleep();
    const t = transport(fetchImpl, { sleep, baseDelayMs: 100 });

    await t.send([RECORD]);

    expect(t.stats.delivered).toBe(1);
    expect(t.stats.attempts).toBe(3);
    expect(t.stats.retries).toBe(2);
    // deterministic jitter (random = 0): 100 * 2^0, then 100 * 2^1
    expect(delays).toEqual([100, 200]);
  });

  it('retries a network error and delivers on a later attempt', async () => {
    const fetchImpl = queueFetch([
      async () => {
        throw new Error('network down');
      },
      async () => response(200),
    ]);
    const { sleep, delays } = recordingSleep();
    const t = transport(fetchImpl, { sleep });

    await t.send([RECORD]);

    expect(t.stats.delivered).toBe(1);
    expect(t.stats.attempts).toBe(2);
    expect(delays).toHaveLength(1);
  });

  it('caps the backoff delay at maxDelayMs', async () => {
    const fetchImpl = queueFetch([async () => response(500)]);
    const { sleep, delays } = recordingSleep();
    const t = transport(fetchImpl, {
      sleep,
      baseDelayMs: 1_000,
      maxDelayMs: 1_500,
      maxAttempts: 4,
    });

    await t.send([RECORD]);

    // 1000, 2000→capped 1500, 4000→capped 1500
    expect(delays).toEqual([1_000, 1_500, 1_500]);
  });

  it('drops a batch after exhausting retries without throwing', async () => {
    const fetchImpl = queueFetch([async () => response(500)]);
    const { sleep } = recordingSleep();
    const t = transport(fetchImpl, { sleep, maxAttempts: 3 });

    await expect(t.send([RECORD])).resolves.toBeUndefined();

    expect(t.stats.attempts).toBe(3);
    expect(t.stats.retries).toBe(2);
    expect(t.stats.dropped).toBe(1);
    expect(t.stats.delivered).toBe(0);
  });

  it('does not retry a permanent 4xx and drops the batch', async () => {
    const fetchImpl = queueFetch([async () => response(400)]);
    const { sleep, delays } = recordingSleep();
    const t = transport(fetchImpl, { sleep });

    await t.send([RECORD]);

    expect(t.stats.attempts).toBe(1);
    expect(t.stats.rejected).toBe(1);
    expect(t.stats.dropped).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries a 429 rate limit', async () => {
    const fetchImpl = queueFetch([async () => response(429), async () => response(200)]);
    const { sleep } = recordingSleep();
    const t = transport(fetchImpl, { sleep });

    await t.send([RECORD]);

    expect(t.stats.attempts).toBe(2);
    expect(t.stats.delivered).toBe(1);
  });
});

describe('HttpTelemetryTransport — offline path (AC4)', () => {
  it('skips the upload entirely when offline and counts the drop', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const t = transport(fetchImpl as unknown as TelemetryFetch, { isOnline: () => false });

    await t.send([RECORD]);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(t.stats.skippedOffline).toBe(1);
    expect(t.stats.dropped).toBe(1);
    expect(t.stats.attempts).toBe(0);
  });
});

describe('createHttpTransport', () => {
  it('returns undefined when no endpoint is configured (sink stays a drop stub)', () => {
    expect(createHttpTransport(undefined)).toBeUndefined();
    expect(createHttpTransport('')).toBeUndefined();
  });

  it('returns a transport function that uploads to the endpoint', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const send = createHttpTransport('https://example.test/t', {
      fetchImpl: fetchImpl as unknown as TelemetryFetch,
    });

    expect(send).toBeTypeOf('function');
    await send!([RECORD]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('transport defaults', () => {
  it('exposes a sane default base delay', () => {
    expect(DEFAULT_BASE_DELAY_MS).toBeGreaterThan(0);
  });
});

describe('recorder → remote transport integration (AC2/AC6)', () => {
  it('assembles recorder records into one uploaded batch', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const config: TelemetryConfig = {
      enabled: true,
      consent: true,
      sink: 'remote',
      production: true,
      endpoint: 'https://telemetry.example/ingest',
      sampleRate: 1,
      bufferCapacity: 8,
      batchSize: 4,
      recording: true,
    };
    const recorder = createTelemetryRecorder(config, {
      transportOptions: {
        fetchImpl: fetchImpl as unknown as TelemetryFetch,
        random: () => 0,
        sleep: async () => {},
        isOnline: () => true,
      },
    });

    recorder.startRun({ runSeed: 9, startedAt: 0 });
    recorder.recordEvent('run_start');
    recorder.recordEvent('wave_start', { level: 1 });
    await recorder.flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init[1].body) as { schemaVersion: number; records: TelemetryRecord[] };
    expect(body.schemaVersion).toBe(TELEMETRY_SCHEMA_VERSION);
    expect(body.records.map((r) => r.kind)).toEqual(['run_header', 'event', 'event']);
  });

  it('keeps local/offline play a strict no-op (disabled path)', async () => {
    const fetchImpl = vi.fn(async () => response(200));
    const disabled: TelemetryConfig = {
      enabled: false,
      consent: false,
      sink: 'none',
      production: false,
      endpoint: undefined,
      sampleRate: 1,
      bufferCapacity: 8,
      batchSize: 4,
      recording: false,
    };
    const recorder = createTelemetryRecorder(disabled, {
      transportOptions: { fetchImpl: fetchImpl as unknown as TelemetryFetch },
    });

    recorder.startRun({ runSeed: 1 });
    recorder.recordTick({}, {});
    recorder.recordEvent('run_start');
    await recorder.flush();

    expect(recorder.enabled).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
