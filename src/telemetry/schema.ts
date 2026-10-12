/**
 * Versioned telemetry record schema (AH-0MUY08VJ9006BHJO).
 *
 * Telemetry is a **framed, versioned** stream: every record carries the
 * `schemaVersion` it was written with, so a future consumer can migrate or
 * reject records it does not understand. Schema v1 has three record kinds:
 *
 * 1. **`run_header`** — written once at the start of a run. Carries the
 *    per-run RNG seed (AH-0MUY08V6W001SJJN), the schema version and the
 *    build metadata, so any tick/event can be tied back to a reproducible
 *    run and a shipped build.
 * 2. **`tick`** — per-tick gameplay state + player input, sampled according
 *    to the configured sample rate.
 * 3. **`event`** — a discrete gameplay event (kill, power-up, wave change),
 *    always recorded, tagged with the tick it occurred on.
 *
 * Payloads (`state`, `input`, `payload`) are intentionally opaque
 * {@link TelemetryJson} values: the concrete shape is owned by the
 * instrumentation layer (AH-0MUY08VVQ007HSSH) so this framework stays
 * decoupled from the game. The framework *does* enforce that whatever a
 * caller records is JSON-serialisable and PII-free before it reaches a sink
 * (see `redact.ts`).
 *
 * @module src/telemetry/schema
 */

/**
 * The telemetry schema version. Bump this whenever a record shape changes in
 * a backwards-incompatible way; consumers key migrations off it. It is
 * written onto **every** record, not just the run header.
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Every value the telemetry stream is allowed to contain. A recursive,
 * plain-JSON type: no `undefined`, functions, symbols, `bigint`, class
 * instances or cycles. The recorder sanitises payloads into this shape
 * before buffering them.
 */
export type TelemetryJson =
  | null
  | boolean
  | number
  | string
  | TelemetryJson[]
  | { [key: string]: TelemetryJson };

/** Build metadata recorded once per run in the run header. */
export interface TelemetryBuildInfo {
  /** Released app version, e.g. `0.1.10`. */
  readonly appVersion: string;
  /** Source commit the build was produced from, or `'unknown'`. */
  readonly commit: string;
}

/** Fields present on every telemetry record. */
export interface TelemetryRecordBase {
  /** The schema version this record was written with. */
  readonly schemaVersion: number;
}

/** Written once at the start of a run (AC1). */
export interface TelemetryRunHeaderRecord extends TelemetryRecordBase {
  readonly kind: 'run_header';
  /** Per-run RNG seed, so the run is reproducible. */
  readonly runSeed: number;
  /** Build the run was played on. */
  readonly build: TelemetryBuildInfo;
  /** Wall-clock start time, epoch milliseconds. */
  readonly startedAt: number;
}

/** Per-tick state + input (AC1). */
export interface TelemetryTickRecord extends TelemetryRecordBase {
  readonly kind: 'tick';
  /** Zero-based tick counter; advances even for sampled-out ticks. */
  readonly tick: number;
  /** Gameplay state at this tick. */
  readonly state: TelemetryJson;
  /** Player input at this tick. */
  readonly input: TelemetryJson;
}

/** A discrete gameplay event (AC1). */
export interface TelemetryEventRecord extends TelemetryRecordBase {
  readonly kind: 'event';
  /** The tick the event occurred on. */
  readonly tick: number;
  /** Event name, e.g. `'enemy_killed'`. */
  readonly event: string;
  /** Event-specific payload. */
  readonly payload: TelemetryJson;
}

/** Any schema-v1 telemetry record. */
export type TelemetryRecord =
  | TelemetryRunHeaderRecord
  | TelemetryTickRecord
  | TelemetryEventRecord;

/** Every discriminator `kind` in schema v1. */
export const TELEMETRY_RECORD_KINDS = ['run_header', 'tick', 'event'] as const;

/** A discriminator value from {@link TELEMETRY_RECORD_KINDS}. */
export type TelemetryRecordKind = (typeof TELEMETRY_RECORD_KINDS)[number];

/**
 * Runtime guard for a decoded telemetry record.
 *
 * Useful when reading JSONL back from a dev sink: the reader can skip
 * records written by an older/newer, incompatible schema instead of
 * crashing. Only the version and discriminator are checked — payloads stay
 * opaque, as they are owned by the instrumentation layer.
 *
 * @param value - A decoded JSON value.
 * @returns `true` when `value` is a schema-v1 telemetry record.
 */
export function isTelemetryRecord(value: unknown): value is TelemetryRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return false;
  if (typeof record.kind !== 'string') return false;
  switch (record.kind) {
    case 'run_header':
      return (
        typeof record.runSeed === 'number' &&
        typeof record.startedAt === 'number' &&
        isBuildInfo(record.build)
      );
    case 'tick':
      return typeof record.tick === 'number' && 'state' in record && 'input' in record;
    case 'event':
      return typeof record.tick === 'number' && typeof record.event === 'string';
    default:
      return false;
  }
}

/** True when `value` looks like {@link TelemetryBuildInfo}. */
function isBuildInfo(value: unknown): value is TelemetryBuildInfo {
  if (typeof value !== 'object' || value === null) return false;
  const build = value as Record<string, unknown>;
  return typeof build.appVersion === 'string' && typeof build.commit === 'string';
}
