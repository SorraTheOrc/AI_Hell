/**
 * Type declarations for the dependency-free `scripts/build-audio.mjs`
 * Node ESM module (AH-0MUTYV8FU007X7JD). The implementation is plain JS
 * so it can run under the project's Node 20 CI without a TS loader; these
 * declarations let the TypeScript test suite type-check against it.
 */

export interface BuildManifest {
  version: number;
  description?: string;
  recipeDirectory: string;
  outputDirectory: string;
  checksumsFile: string;
  seedBlock?: string;
  defaultExistingRecipeSeed?: number;
  retiredCues: string[];
  controlCues: string[];
  cues: Array<{
    cue: string;
    recipe: string;
    delivery: 'existing-recipe' | 'baked' | 'runtime-shim';
    seeds: number[];
  }>;
}

export interface RenderJob {
  recipe: string;
  seed: number;
  file: string;
  assetPath: string;
  outputPath: string;
}

export interface ToneForgeCli {
  command: string;
  prefixArgs: string[];
  source: string;
}

export interface RenderOptions {
  cli: ToneForgeCli;
  manifest: BuildManifest;
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  spawn?: typeof import('node:child_process').spawnSync;
}

export interface VerifyResult {
  ok: boolean;
  errors: string[];
}

export interface ToneForgePin {
  version: number;
  description?: string;
  repository: string;
  revision: string;
  licence: string;
  licenceWorkItem?: string;
  cli: string;
  dependencySpecifier: string;
}

export interface PinCheckResult {
  ok: boolean;
  errors: string[];
  pin: ToneForgePin | undefined;
}

export const REPO_ROOT: string;
export const MANIFEST_PATH: string;

export function loadManifest(path?: string): BuildManifest;
export function pinPathFor(repoRoot?: string): string;
export function loadPin(path?: string): ToneForgePin;
export function verifyPinnedDependency(options?: {
  repoRoot?: string;
  pin?: ToneForgePin;
}): PinCheckResult;
export function resolvePinnedSiblingRevision(options?: {
  repoRoot?: string;
  spawn?: typeof import('node:child_process').spawnSync;
}): string | null;
export function planRenderJobs(manifest: BuildManifest): RenderJob[];
export function sha256(buffer: Buffer): string;
export function assetFsPath(repoRoot: string, assetPath: string): string;
export function resolveToneForge(options?: {
  repoRoot?: string;
  env?: NodeJS.ProcessEnv;
}): ToneForgeCli | null;
export function createToneForgeRenderer(
  options: RenderOptions,
): (job: RenderJob) => Buffer;
export function buildAssets(options: {
  manifest: BuildManifest;
  repoRoot?: string;
  manifestPath?: string;
  renderJob: (job: RenderJob) => Buffer;
  logger?: { log: (...args: unknown[]) => void };
}): { assets: Record<string, string>; jobs: RenderJob[]; checksums: string };
export function serializeChecksums(
  manifest: BuildManifest,
  assets: Record<string, string>,
  options?: { repoRoot?: string; manifestPath?: string },
): string;
export function verifyAssets(options: {
  manifest: BuildManifest;
  repoRoot?: string;
}): VerifyResult;
export function parseArgs(argv: string[]): {
  mode: 'auto' | 'verify' | 'render';
  manifestPath: string;
  repoRoot: string;
  help?: boolean;
};
export function main(
  argv?: string[],
  options?: { logger?: Console; env?: NodeJS.ProcessEnv },
): number;
