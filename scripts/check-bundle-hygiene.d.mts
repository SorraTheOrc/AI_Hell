export interface BundleHygieneViolation {
  file: string;
  marker: string;
  label: string;
}

export interface BundleHygieneResult {
  ok: boolean;
  distDir: string;
  scanned: number;
  violations: BundleHygieneViolation[];
  reason?: string;
}

export const REPO_ROOT: string;
export const DEFAULT_DIST_DIR: string;
export const FORBIDDEN_MARKERS: ReadonlyArray<{ marker: string; label: string }>;

export function checkBundleHygiene(options?: { distDir?: string }): BundleHygieneResult;
export function parseArgs(argv: string[]): { distDir: string; help?: boolean };
export function main(argv?: string[], options?: { logger?: Console }): number;
