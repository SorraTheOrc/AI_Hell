/**
 * Bullet-shape identity helpers (AH-0MW0Q1GMK005HOF0).
 *
 * The roster guarantees — "every weapon has a unique bullet-shape family" —
 * are checked against a **canonical** shape name, because `'circle'` is the
 * legacy alias of `'disc'`: two weapons must not count as visually distinct
 * merely because one authors the alias.
 *
 * This module exists as a **leaf** (it imports only a type) so the runtime
 * catalogue guards in `src/utils/weaponCatalogue.ts` can be used from
 * Node-only tooling — the Vite config loader and the dev CSV write plugin
 * (`vite/plugins/configCsvPlugin.ts`) validate a save through those guards.
 * Importing `bulletVisuals.ts` there would pull in a Phaser-typed rendering
 * module, so the identity helper lives apart from the renderer.
 */

import type { BulletShape } from './weapons';

/**
 * Canonical shape name: the legacy `'circle'` name renders as a `disc`.
 * Used by the roster tests so `'circle'` and `'disc'` never count as two
 * distinct signatures.
 */
export function canonicalShape(shape: BulletShape): BulletShape {
  return shape === 'circle' ? 'disc' : shape;
}
