/**
 * Type declarations for the harness launch configuration
 * (`scripts/perf-launch.mjs`, AH-0MW2DB9VN006XB63).
 *
 * The module stays plain ESM so the harness runs with `node` without a
 * TypeScript loader; these declarations give its documented surface types for
 * the unit tests (`scripts/perf-launch.test.ts`).
 */

export const ELECTRON_ENTRY: string;

export function rendererSwitches(gpu?: boolean): string[];
export function buildBrowserLaunchArgs(options?: { gpu?: boolean }): string[];
export function buildElectronLaunchArgs(options?: {
  repoRoot?: string;
  entry?: string;
  headless?: boolean;
  gpu?: boolean;
}): string[];
export function buildElectronEnv(options?: {
  url?: string | null;
  headless?: boolean;
  gpu?: boolean;
  base?: NodeJS.ProcessEnv;
}): Record<string, string>;

export interface PerfRuntimeInfo {
  kind: 'browser' | 'electron';
  electronVersion: string | null;
  chromeVersion: string | null;
}

export function describeRuntime(versions?: {
  kind?: 'browser' | 'electron';
  electronVersion?: string | null;
  chromeVersion?: string | null;
}): PerfRuntimeInfo;
