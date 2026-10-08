/**
 * Telemetry framework public surface (AH-0MUY08VJ9006BHJO).
 *
 * A versioned, consent-gated, pluggable telemetry pipeline that is a strict
 * no-op unless enabled. Consumers (the game instrumentation, dev recording
 * and production telemetry children) import from here:
 *
 * ```ts
 * import {
 *   createTelemetryRecorder,
 *   resolveBuildInfo,
 *   resolveTelemetryConfig,
 * } from '../telemetry';
 *
 * const config = resolveTelemetryConfig();          // disabled by default
 * const recorder = createTelemetryRecorder(config, {
 *   transport: productionTransport,                 // optional
 *   build: resolveBuildInfo(),
 * });
 * recorder.startRun({ runSeed });
 * recorder.recordTick(state, input);
 * recorder.recordEvent('enemy_killed', { archetype });
 * await recorder.flush();
 * ```
 *
 * @module src/telemetry
 */

export {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_RECORD_KINDS,
  isTelemetryRecord,
  type TelemetryJson,
  type TelemetryBuildInfo,
  type TelemetryRecord,
  type TelemetryRecordBase,
  type TelemetryRecordKind,
  type TelemetryRunHeaderRecord,
  type TelemetryTickRecord,
  type TelemetryEventRecord,
} from './schema';

export {
  TELEMETRY_REDACTED,
  TELEMETRY_REDACTED_EMAIL,
  isSensitiveTelemetryKey,
  sanitiseTelemetryValue,
} from './redact';

export {
  DEFAULT_TELEMETRY_BATCH_SIZE,
  DEFAULT_TELEMETRY_BUFFER_CAPACITY,
  DEFAULT_TELEMETRY_SAMPLE_RATE,
  applyUserConsent,
  parseBoolean,
  parseEndpoint,
  parsePositiveInt,
  parseSampleRate,
  parseSink,
  resolveBuildInfo,
  resolveTelemetryConfig,
  type TelemetryConfig,
  type TelemetryEnv,
  type TelemetrySinkKind,
} from './config';

export {
  isTelemetryConsentRequired,
  resolveEffectiveTelemetryConfig,
  shouldPromptForTelemetryConsent,
  type TelemetryConsentState,
} from './consent';

export {
  JsonlTelemetrySink,
  NoopTelemetrySink,
  RemoteTelemetrySink,
  TELEMETRY_JSONL_STORAGE_KEY,
  createLocalStorageLineWriter,
  createMemoryLineWriter,
  createTelemetrySink,
  type TelemetryLineWriter,
  type TelemetrySink,
  type TelemetrySinkDeps,
  type TelemetryTransport,
} from './sinks';

export {
  DEFAULT_BASE_DELAY_MS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_DELAY_MS,
  DEFAULT_TIMEOUT_MS,
  HttpTelemetryTransport,
  createHttpTransport,
  isRetryableStatus,
  type HttpTelemetryTransportOptions,
  type TelemetryFetch,
  type TelemetryFetchResponse,
  type TelemetryTransportStats,
  type TelemetryUploadBody,
} from './transport';

export {
  BufferedTelemetryRecorder,
  DEFAULT_TELEMETRY_BUILD,
  NoopTelemetryRecorder,
  createTelemetryRecorder,
  type BufferedTelemetryRecorderOptions,
  type TelemetryRecorder,
  type TelemetryRecorderOptions,
  type TelemetryRecorderStats,
  type TelemetryRunHeaderInput,
} from './recorder';
