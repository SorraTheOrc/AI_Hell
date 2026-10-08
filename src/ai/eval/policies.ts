/**
 * Built-in evaluation policies for the same-seed evaluation harness
 * (AH-0MUY08XLD009K4W4, AC2/AC3).
 *
 * The harness can A/B any two {@link PolicyFactory} values; this module maps
 * the shipped bot implementations to stable CLI names so an operator can
 * compare "the bot before" and "the bot after" a change without writing code:
 *
 * - `competent` — the structured competent brain with the legacy fallback.
 * - `competent-no-fallback` — the same brain with the fallback disabled (a
 *   config variant, useful for isolating behaviour).
 * - `legacy` — the original pure priority ladder.
 *
 * @module src/ai/eval/policies
 */

import { createCompetentBotBrain } from '../framework/competent';
import { createLegacyBotPolicy } from '../framework/legacyPolicy';
import type { PolicyFactory } from './engine';

/** The stable CLI names for the built-in policies. */
export const EVAL_POLICY_NAMES = Object.freeze([
  'competent',
  'competent-no-fallback',
  'legacy',
] as const);

/** A built-in policy name. */
export type EvalPolicyName = (typeof EVAL_POLICY_NAMES)[number];

/** Resolves a built-in policy name to its factory. */
export function resolvePolicyFactory(name: string): PolicyFactory {
  switch (name) {
    case 'competent':
      return { name, create: () => createCompetentBotBrain() };
    case 'competent-no-fallback':
      return { name, create: () => createCompetentBotBrain({ fallback: null }) };
    case 'legacy':
      return { name, create: () => createLegacyBotPolicy() };
    default:
      throw new Error(
        `unknown policy "${name}" (expected one of: ${EVAL_POLICY_NAMES.join(', ')})`,
      );
  }
}
