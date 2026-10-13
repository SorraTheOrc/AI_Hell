/**
 * Game version metadata — the single source of truth for the build version
 * shown on the main menu (AH-0MUZM9053008YXOZ).
 *
 * The value is read from `package.json` at build time via
 * `resolveJsonModule` (enabled in `tsconfig.json`), so `npm run dev` and
 * `vite build` both surface the real released version with no environment
 * wiring. Vite tree-shakes the JSON import down to the `version` field, so
 * no other package metadata leaks into the browser bundle.
 *
 * @module src/core/version
 */

import { version } from '../../package.json';

/** Raw semantic version from `package.json` (e.g. `0.1.11`). */
export const APP_VERSION: string = version;

/** Display form of the game version, prefixed with `v` (e.g. `v0.1.11`). */
export const GAME_VERSION = `v${APP_VERSION}`;
