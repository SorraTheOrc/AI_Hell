/**
 * Type declarations for the dependency-free scenario schema
 * (`scripts/capture-scenario-schema.mjs`, AH-0MVSDM4ED003C8ZC).
 *
 * The implementation is plain JS so bare Node (the capture CLI) and the Vite
 * game build can both import it; these declarations let
 * `scripts/capture-scenarios.d.mts`, `src/core/devScenario.ts` and the tests
 * consume the richer entry shape without `any` leaks.
 */

/** The entry kinds the enriched registry may declare. */
export type CaptureScenarioKind = 'boss' | 'defeat' | 'promo';

/** An editorial feature category a promo scenario may evidence. */
export type EditorialCategory = 'weapons' | 'pickups' | 'enemies' | 'boss';

/** Fields every registry entry declares. */
export interface CaptureScenarioBase {
  /** The `scenario` URL query value the resolver accepts. */
  readonly name: string;
  /** One line a maintainer can read to know what the scenario does. */
  readonly effect: string;
  /** Which resolver union member this entry produces. */
  readonly kind: CaptureScenarioKind;
}

/** A boss-jump scenario (`?scenario=boss[&bossHits=N]`). */
export interface CaptureBossScenario extends CaptureScenarioBase {
  readonly kind: 'boss';
}

/** A defeat-path scenario (clear the wave, end the run in defeat). */
export interface CaptureDefeatScenario extends CaptureScenarioBase {
  readonly kind: 'defeat';
}

/** A curated promo-video scenario: preset + wave level + categories. */
export interface CapturePromoScenario extends CaptureScenarioBase {
  readonly kind: 'promo';
  /** Bot-tuning preset name (a preset in `src/data/bot-tuning.json`). */
  readonly preset: string;
  /** Level reference into the promo wave module. */
  readonly promoLevel: string;
  /** Editorial categories this scenario evidences (at least one). */
  readonly categories: readonly EditorialCategory[];
  /** Optional deterministic run seed (uint32) for reproducible capture. */
  readonly seed?: number;
}

/** One registered dev scenario (a discriminated union on `kind`). */
export type CaptureScenario =
  | CaptureBossScenario
  | CaptureDefeatScenario
  | CapturePromoScenario;

/** The entry kinds the enriched registry may declare. */
export const CAPTURE_SCENARIO_KINDS: readonly CaptureScenarioKind[];

/** Editorial categories a promo entry may evidence (manifest order). */
export const EDITORIAL_CATEGORIES: readonly EditorialCategory[];

/** Whether `value` is one of the registry entry kinds. */
export function isCaptureScenarioKind(value: unknown): value is CaptureScenarioKind;

/** Whether `value` is one of the promo editorial categories. */
export function isEditorialCategory(value: unknown): value is EditorialCategory;

/**
 * Asserts the full enriched-entry contract, throwing with an actionable
 * message naming the entry and the offending field.
 */
export function assertCaptureScenarioEntry(entry: unknown, label?: string): void;

/** Validates one entry and returns a frozen (deeply-frozen categories) copy. */
export function freezeCaptureScenarioEntry(
  entry: unknown,
  label?: string,
): CaptureScenario;
