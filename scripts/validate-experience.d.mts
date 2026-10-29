/**
 * Type declarations for the dependency-free `scripts/validate-experience.mjs`
 * CLI shell (AH-0MV7WVHU0000U775). The implementation is plain JS so the CLI
 * runs under Node without a TypeScript loader; these declarations let the
 * TypeScript test suite type-check against it.
 */

/** Parsed CLI options. */
export interface ParsedValidateExperienceArgs {
  /** The measured balance report to validate (`--baseline` mode: unused). */
  reportFile: string | null;
  targetsFile: string;
  outputDir: string;
  json: boolean;
  /** Re-baseline mode: the bot batch report to derive the targets from. */
  baselineFile: string | null;
  targetsOut: string;
  targetsVersion: number | null;
  help: boolean;
}

export const DEFAULT_TARGETS_FILE: string;
export const DEFAULT_OUTPUT_DIR: string;
export const VALIDATION_JSON_ARTIFACT: string;
export const VALIDATION_MARKDOWN_ARTIFACT: string;
export const VALIDATE_EXPERIENCE_USAGE: string;

export function parseValidateExperienceArgs(
  argv?: string[],
): ParsedValidateExperienceArgs;
export function loadCore(): Promise<{
  server: { close(): Promise<void> };
  core: Record<string, unknown>;
}>;
export function validateExperience(
  options: ParsedValidateExperienceArgs,
  io?: { out: { write(text: string): void }; err: { write(text: string): void } },
  core?: Record<string, unknown> | null,
  root?: string,
): Promise<number>;
export function deriveTargets(
  options: ParsedValidateExperienceArgs,
  io?: { out: { write(text: string): void }; err: { write(text: string): void } },
  core?: Record<string, unknown> | null,
  root?: string,
): Promise<number>;
export function main(
  argv: string[],
  io?: { out: { write(text: string): void }; err: { write(text: string): void } },
  core?: Record<string, unknown> | null,
): Promise<number>;
