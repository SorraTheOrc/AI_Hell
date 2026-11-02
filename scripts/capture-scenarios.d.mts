/**
 * Type declarations for the dependency-free `scripts/capture-scenarios.mjs`
 * shared scenario registry (AH-0MV6JGE9R005YOL1). The implementation is plain
 * JS so bare Node (the capture CLI) and the Vite game build can both import
 * it; these declarations let `src/core/devScenario.ts`, the capture tooling
 * and the tests consume the registry without `any` leaks.
 *
 * The entry shapes themselves are declared (and validated at runtime) by
 * `scripts/capture-scenario-schema.mjs` (AH-0MVSDM4ED003C8ZC), so the richer
 * `kind: 'promo'` metadata has exactly one definition; this module re-exports
 * them for the consumers that only know about the registry.
 */

import type { CaptureScenario } from './capture-scenario-schema.mjs';

export type {
  CaptureBossScenario,
  CaptureDefeatScenario,
  CapturePromoScenario,
  CaptureScenario,
  CaptureScenarioKind,
  EditorialCategory,
} from './capture-scenario-schema.mjs';

/**
 * The implemented dev capture scenarios, in listing/running order. Frozen
 * top-level array and frozen entries — the single source of truth.
 */
export const CAPTURE_SCENARIOS: readonly CaptureScenario[];

/** Whether `value` is a registered scenario name (trim + lowercase match). */
export function isRegisteredScenario(value: unknown): boolean;

/** Lists the registered scenarios as fresh copies (never the frozen originals). */
export function listCaptureScenarios(): CaptureScenario[];
