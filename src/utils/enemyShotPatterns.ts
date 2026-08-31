/**
 * Shot-pattern helpers for the enemy-config pipeline (AH-0MTFP7EIC004F1MN).
 *
 * The data-driven `EnemyConfig.shotPattern` enum is re-exported from
 * `src/core/enemyConfig.ts`; this module is the single source of truth
 * for validating/sanitizing raw pattern strings and for translating a
 * pattern + per-entity fire method into the bullet-collection behaviour
 * the gym scene consumes (no per-enemy scene subclasses required).
 */

import type { EnemyShotPattern } from '../core/enemyConfig';

export type { EnemyShotPattern };

/** Valid patterns (kept in sync with `EnemyConfig.shotPattern`). */
const VALID: Set<string> = new Set(['none', 'aimed', 'spread', 'radial', 'orbital', 'coordinated']);

/** Sanitizes an arbitrary pattern string to a valid EnemyShotPattern, defaulting to 'none'. */
export function sanitizeShotPattern(pattern: string): EnemyShotPattern {
  if (VALID.has(pattern)) return pattern as EnemyShotPattern;
  return 'none';
}

/** Returns true if `pattern` is a valid EnemyShotPattern. */
export function isValidShotPattern(pattern: string): boolean {
  return VALID.has(pattern);
}
