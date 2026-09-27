/**
 * Shared source-scan helpers for the repo-wide duplicate-body guard
 * (parent AH-0MUDCT7EU0061OSZ, child AH-0MUH5FD180063BU5).
 *
 * Extracted from `CombatScene.equivalence.test.ts` so the eight
 * shared-method guard and the legacy `_readInput` guard share one
 * matcher (AC3 — an extraction/sharing of the existing `definesMethod()`
 * helper rather than a new standalone script).
 *
 * @module test/duplicateBodyGuard
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * True when `source` **defines** a method named `method`.
 *
 * Definition lines only: `this._method(` call sites do not match because
 * the matcher requires the name to start the line (after optional
 * visibility/`override` modifiers) and be followed by `(`.
 */
export function definesMethod(source: string, method: string): boolean {
  const re = new RegExp(
    `^[ \\t]*(?:(?:private|protected|public)\\s+)?(?:override\\s+)?${method}\\s*\\(`,
    'm',
  );
  return re.test(source);
}

/**
 * True when `source` **defines** a top-level function named `name` (e.g.
 * `export function resolveMineralKillDrops(`).
 *
 * The matcher anchors the declaration to the start of a line so call sites
 * and imports do not count as definitions. An optional type-parameter clause
 * (`<T extends Foo>`) is accepted so generic shared helpers are matchable.
 */
export function definesFunction(source: string, name: string): boolean {
  const re = new RegExp(
    `^[ \\t]*(?:export\\s+)?(?:async\\s+)?function\\s+${name}(?:\\s*<[^>{}()]*>)?\\s*\\(`,
    'm',
  );
  return re.test(source);
}

/**
 * Recursively lists production (non-test) TypeScript files under `dir`.
 * Test files (`*.test.ts`) are excluded — they legitimately reference
 * the method names in assertions.
 */
export function collectProductionSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectProductionSourceFiles(full));
    } else if (
      entry.isFile() &&
      full.endsWith('.ts') &&
      !full.endsWith('.test.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}
