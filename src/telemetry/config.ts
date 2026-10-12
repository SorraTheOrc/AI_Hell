/**
 * Telemetry configuration and consent policy
 * (AH-0MUY08VJ9006BHJO, AC3).
 *
 * Telemetry is **disabled by default**. It is enabled explicitly through
 * Vite environment variables (`VITE_TELEMETRY_*`), and in a production build
 * it additionally requires the explicit **consent** flag — no production
 * recording happens without opt-in. Development recording needs no consent.
 *
 * Resolution is a pure function of an injected environment object (defaults
 * to `import.meta.env`), so every policy decision is unit-testable without a
 * real build.
 *
 * @module src/telemetry/config
 */

import { type TelemetryBuildInfo } from './schema';

/** Where records are delivered. */
export type TelemetrySinkKind = 'none' | 'jsonl' | 'remote';

/** The environment slice telemetry reads (a subset of `import.meta.env`). */
export interface TelemetryEnv {
  /** True in a Vite dev build. */
  readonly DEV?: boolean;
  /** True in a Vite production build. */
  readonly PROD?: boolean;
  /** `'1'`/`'true'`/`'yes'`/`'on'` enables telemetry. */
  readonly VITE_TELEMETRY_ENABLED?: string;
  /** `'1'`/`'true'`/`'yes'`/`'on'` records consent for production recording. */
  readonly VITE_TELEMETRY_CONSENT?: string;
  /** Sink selection: `'none'` | `'jsonl'` | `'remote'`. */
  readonly VITE_TELEMETRY_SINK?: string;
  /** Remote sink endpoint URL; absent disables the remote transport. */
  readonly VITE_TELEMETRY_ENDPOINT?: string;
  /** Fraction of ticks to record, `0`–`1` (default `1`). */
  readonly VITE_TELEMETRY_SAMPLE_RATE?: string;
  /** Ring-buffer capacity in records (default {@link DEFAULT_TELEMETRY_BUFFER_CAPACITY}). */
  readonly VITE_TELEMETRY_BUFFER_CAPACITY?: string;
  /** Records per flushed batch (default {@link DEFAULT_TELEMETRY_BATCH_SIZE}). */
  readonly VITE_TELEMETRY_BATCH_SIZE?: string;
  /** Build metadata for the run header. */
  readonly VITE_APP_VERSION?: string;
  readonly VITE_GIT_COMMIT?: string;
}

/** Resolved telemetry configuration. */
export interface TelemetryConfig {
  /** Whether telemetry was explicitly enabled via config/env. */
  readonly enabled: boolean;
  /** Whether the production consent flag is set. */
  readonly consent: boolean;
  /** The selected sink (before the enabled/consent gate is applied). */
  readonly sink: TelemetrySinkKind;
  /** Whether this is a production build (production requires consent). */
  readonly production: boolean;
  /** Remote sink endpoint URL, or `undefined` when none is configured. */
  readonly endpoint: string | undefined;
  /** Tick sampling rate, `0`–`1`. */
  readonly sampleRate: number;
  /** Ring-buffer capacity in records. */
  readonly bufferCapacity: number;
  /** Records per flushed batch. */
  readonly batchSize: number;
  /**
   * The effective gate: `true` only when telemetry is enabled **and** (it is
   * not a production build **or** consent was given). When `false` the
   * recorder is a strict no-op.
   */
  readonly recording: boolean;
}

/** Default ring-buffer capacity: bounded so recording can never grow without limit. */
export const DEFAULT_TELEMETRY_BUFFER_CAPACITY = 512;

/** Default records per batch flush. */
export const DEFAULT_TELEMETRY_BATCH_SIZE = 64;

/** Default sampling rate: record every tick. */
export const DEFAULT_TELEMETRY_SAMPLE_RATE = 1;

/**
 * Resolves telemetry configuration from the environment (AC3).
 *
 * @param env - The environment slice, defaulting to `import.meta.env`.
 * @returns The resolved, consent-gated configuration.
 */
export function resolveTelemetryConfig(
  env: TelemetryEnv = import.meta.env,
): TelemetryConfig {
  const enabled = parseBoolean(env.VITE_TELEMETRY_ENABLED);
  const consent = parseBoolean(env.VITE_TELEMETRY_CONSENT);
  const sink = parseSink(env.VITE_TELEMETRY_SINK);
  const endpoint = parseEndpoint(env.VITE_TELEMETRY_ENDPOINT);
  const sampleRate = parseSampleRate(env.VITE_TELEMETRY_SAMPLE_RATE);

  const bufferCapacity = parsePositiveInt(
    env.VITE_TELEMETRY_BUFFER_CAPACITY,
    DEFAULT_TELEMETRY_BUFFER_CAPACITY,
  );
  // A batch can never exceed the buffer, otherwise auto-flush would never fire.
  const batchSize = Math.min(
    parsePositiveInt(env.VITE_TELEMETRY_BATCH_SIZE, DEFAULT_TELEMETRY_BATCH_SIZE),
    bufferCapacity,
  );

  const isProduction = env.PROD === true;
  const recording = enabled && (!isProduction || consent);

  return {
    enabled,
    consent,
    sink: enabled ? sink : 'none',
    production: isProduction,
    endpoint: sink === 'remote' ? endpoint : undefined,
    sampleRate,
    bufferCapacity,
    batchSize,
    recording,
  };
}

/**
 * Applies the player's explicit consent decision to a resolved config
 * (AC1). The environment's consent flag is replaced by the player's choice
 * and the effective recording gate is recomputed, so opting out always
 * disables recording even in a consent-flagged production build.
 *
 * @param config - The environment-resolved configuration.
 * @param consent - The player's decision.
 * @returns A new configuration reflecting the decision.
 */
export function applyUserConsent(
  config: TelemetryConfig,
  consent: boolean,
): TelemetryConfig {
  return {
    ...config,
    consent,
    recording: config.enabled && (!config.production || consent),
  };
}

/**
 * Resolves the run header's build metadata from the environment.
 *
 * The instrumentation layer may override this with more precise values; the
 * defaults keep the run header complete even when no build variables are
 * wired.
 *
 * @param env - The environment slice, defaulting to `import.meta.env`.
 */
export function resolveBuildInfo(env: TelemetryEnv = import.meta.env): TelemetryBuildInfo {
  return {
    appVersion: nonEmpty(env.VITE_APP_VERSION) ?? '0.0.0-dev',
    commit: nonEmpty(env.VITE_GIT_COMMIT) ?? 'unknown',
  };
}

/** Parses a Vite boolean env var; anything unrecognised is `false`. */
export function parseBoolean(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return false;
  }
}

/** Parses a sink name; unknown values fall back to the local `'jsonl'` sink. */
export function parseSink(raw: string | undefined): TelemetrySinkKind {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'remote':
      return 'remote';
    case 'none':
    case 'noop':
    case 'off':
      return 'none';
    case 'jsonl':
    default:
      return 'jsonl';
  }
}

/**
 * Parses a remote endpoint. Returns `undefined` for an absent/blank value;
 * trims surrounding whitespace otherwise.
 */
export function parseEndpoint(raw: string | undefined): string | undefined {
  return nonEmpty(raw);
}

/** Parses a `0`–`1` sampling rate; invalid values fall back to `1`. */
export function parseSampleRate(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_TELEMETRY_SAMPLE_RATE;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_TELEMETRY_SAMPLE_RATE;
  return Math.min(1, Math.max(0, value));
}

/** Parses a positive integer env var, falling back when absent/invalid. */
export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) return fallback;
  return value;
}

/** Returns the trimmed string when non-empty, else `undefined`. */
function nonEmpty(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
