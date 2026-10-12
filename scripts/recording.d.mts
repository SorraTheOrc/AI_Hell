/**
 * Type declarations for the dependency-free `scripts/recording.mjs` Node ESM
 * module (AH-0MUY08W7Y004GATZ). The implementation is plain JS so the CLI
 * tools run without a TypeScript loader; these declarations let the
 * TypeScript test suite type-check against it.
 */

export const RECORDING_DATASET_VERSION: number;
export const SUPPORTED_TELEMETRY_SCHEMA_VERSIONS: readonly number[];
export const RECORDING_RECORD_KINDS: readonly ('run_header' | 'tick' | 'event')[];
export const DEFAULT_TICK_SECONDS: number;

export interface Vec2 {
  x: number;
  y: number;
}

export interface RecordingBuild {
  appVersion: string;
  commit: string;
}

export interface RecordingTick {
  tick: number;
  state: unknown;
  input: unknown;
}

export interface RecordingEvent {
  tick: number;
  event: string;
  payload: unknown;
}

export interface RecordingRun {
  index: number;
  runSeed: number;
  build: RecordingBuild;
  startedAt: number | null;
  ticks: RecordingTick[];
  events: RecordingEvent[];
}

export interface RecordingParseResult {
  datasetVersion: number;
  runs: RecordingRun[];
  schemaVersions: number[];
  recordCount: number;
  skippedLines: number;
  unsupportedLines: number;
  unattributedLines: number;
}

export interface ReplayFrame {
  index: number;
  tick: number;
  elapsedSeconds: number;
  state: unknown;
  input: unknown;
  position: Vec2 | null;
}

export interface RecordingStepper {
  readonly total: number;
  readonly index: number;
  readonly done: boolean;
  readonly dtSeconds: number;
  current(): ReplayFrame | null;
  step(): ReplayFrame | null;
  seek(tick: number): ReplayFrame | null;
  reset(): void;
  frames(): ReplayFrame[];
}

export interface GhostSide {
  position: Vec2 | null;
  input: unknown;
}

export interface GhostFrame {
  index: number;
  tick: number;
  elapsedSeconds: number;
  human: GhostSide;
  bot: GhostSide;
  inputMatch: boolean;
  positionDelta: number | null;
}

export interface GhostOverlayStats {
  frames: number;
  inputMatchCount: number;
  inputMatchRate: number;
  positionSamples: number;
  meanPositionDelta: number;
  maxPositionDelta: number;
}

export interface GhostOverlay {
  runSeed: number;
  dtSeconds: number;
  frames: GhostFrame[];
  stats: GhostOverlayStats;
}

export interface GhostSvgOptions {
  width?: number;
  height?: number;
  padding?: number;
  humanColour?: string;
  botColour?: string;
  background?: string;
  title?: string;
}

export function isSupportedRecordingRecord(value: unknown): boolean;
export function parseRecording(text: unknown): RecordingParseResult;
export function inputChannels(input: unknown): {
  scheme: 'asteroids' | 'fourDirectional' | null;
  channels: Record<string, boolean>;
};
export function inputSignature(input: unknown): string;
export function tickPosition(state: unknown): Vec2 | null;
export function distance(a: Vec2 | null | undefined, b: Vec2 | null | undefined): number;
export function createRecordingStepper(
  run: RecordingRun,
  options?: { dtSeconds?: number },
): RecordingStepper;
export function buildGhostOverlay(
  humanRun: RecordingRun,
  botRun: RecordingRun,
  options?: { dtSeconds?: number },
): GhostOverlay;
export function renderGhostSvg(overlay: GhostOverlay, options?: GhostSvgOptions): string;
