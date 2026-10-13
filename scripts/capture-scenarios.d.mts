/**
 * Type declarations for the dependency-free `scripts/capture-scenarios.mjs`
 * shared scenario registry (AH-0MV6JGE9R005YOL1). The implementation is plain
 * JS so bare Node (the capture CLI) and the Vite game build can both import
 * it; these declarations let `src/core/devScenario.ts`, the capture tooling
 * and the tests consume the registry without `any` leaks.
 */

/** One implemented dev capture scenario. */
export interface CaptureScenario {
  /** The `scenario` URL query value the resolver accepts. */
  readonly name: string;
  /** One line a maintainer can read to know what the scenario does. */
  readonly effect: string;
}

/**
 * The implemented dev capture scenarios, in listing/running order. Frozen
 * top-level array and frozen entries — the single source of truth.
 */
export const CAPTURE_SCENARIOS: readonly CaptureScenario[];

/** Whether `value` is a registered scenario name (trim + lowercase match). */
export function isRegisteredScenario(value: unknown): boolean;

/** Lists the registered scenarios as fresh copies (never the frozen originals). */
export function listCaptureScenarios(): CaptureScenario[];
