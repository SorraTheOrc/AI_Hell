/**
 * Type declarations for the dependency-free `scripts/inspect-telemetry.mjs`
 * Node ESM module (AH-0MUY08Y9P005ER7A, AC5). The implementation is plain JS
 * so the inspector runs without a TypeScript loader; these declarations let
 * the TypeScript test suite type-check against it.
 */

export const INSPECT_SCHEMA_VERSION: number;
export const INSPECT_RECORD_KINDS: readonly string[];

export interface TelemetrySummary {
  recordCount: number;
  byKind: { run_header: number; tick: number; event: number };
  schemaVersions: number[];
  runs: { count: number; seeds: number[] };
  startedAt: number | null;
  builds: string[];
  ticks: { count: number; first: number | null; last: number | null };
  events: Record<string, number>;
  skippedLines?: number;
}

export function isInspectableRecord(value: unknown): boolean;
export function parseTelemetryJsonl(text: unknown): { records: object[]; skipped: number };
export function summariseTelemetry(records: object[]): TelemetrySummary;
export function formatSummary(summary: TelemetrySummary): string;
