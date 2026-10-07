/**
 * Type declarations for `scripts/capture-gameplay.mjs`
 * (AH-0MUX496IJ0041O3V). The browser/encode pipeline is exercised by
 * `npm run capture`; these declarations let the TypeScript test suite
 * type-check the pure argument/mode helpers without booting a browser.
 */

export interface CaptureOptions {
  durationMs: number;
  warmupMs: number;
  output: string | null;
  port: number;
  headed: boolean;
  keepServer: boolean;
  json: boolean;
  scripted: boolean;
  help?: boolean;
}

/** Which capture path the options select. */
export type CaptureMode = 'demo' | 'scripted';

export function parseCaptureArgs(argv?: string[]): CaptureOptions;
export function resolveCaptureMode(options?: { scripted?: boolean }): CaptureMode;
export function captureStartKeys(mode: CaptureMode): string[];
