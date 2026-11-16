/**
 * Weapon-levels store — the client-side re-read seam for rhythm edits
 * (AH-0MW0WLZ9600693R9, parent AH-0MW0Q01VM004EPY7).
 *
 * `src/utils/weaponLevels.ts` builds the runtime `WEAPON_EUCLIDEAN_LADDERS`
 * once at module load from the bundled `src/data/weapon-levels.json`. That is
 * the right shape for the shipped game (production is read-only), but a
 * designer saving a new Euclidean rung from the tuning panel must hear it
 * **without reloading the page**. This module owns that seam:
 *
 * - it PUTs a single weapon's rung list to the dev-only plugin
 *   (`vite/plugins/weaponLevelsPlugin.ts`) and then **re-reads** the file,
 *   re-parsing it with the shared `parseWeaponLevels` so the runtime ladders
 *   (and therefore `resolveWeaponPattern` and the preview ship) follow the
 *   saved file;
 * - a re-read that fails after a successful write falls back to the
 *   validated in-memory commit, so the running scene still reflects what was
 *   saved;
 * - outside the dev server it is read-only and reports the reason, exactly
 *   like `weaponCatalogueStore.saveWeaponDefinition`.
 *
 * The store follows the `configStore` test-mode rule: under vitest
 * (`MODE === 'test'`) a save is registry-only, so no suite can ever write the
 * tracked data file. The dev write payload is still built by the same
 * `buildWeaponLevelsWriteBody`, which is what the tests pin.
 *
 * @module src/core/weaponLevelsStore
 */

import type { SaveResult } from './configStore';
import {
  WEAPON_LEVELS_WRITE_PATH,
  validateWeaponLevelsWriteBlob,
  type WeaponLadderRung,
} from './weaponLevelsSchema';
import {
  overrideWeaponLevelRungs,
  reloadWeaponLevels,
  resetWeaponLevelsToBundled,
} from '../utils/weaponLevels';
import type { WeaponId } from '../utils/weapons';

/** Reason reported when the rhythm write path is unavailable (non-dev builds). */
export const WEAPON_LEVELS_READ_ONLY_REASON =
  'Weapon rhythm writes are unavailable in production builds (read-only JSON).';

export { type WeaponLadderRung };

/** Result of a weapon-levels write attempt. */
export type WeaponLevelsSaveResult = SaveResult;

// ── Environment detection ───────────────────────────────────────────

/** True when running under the Vite dev server (the write endpoint exists). */
function isDev(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * True when running under vitest (`MODE === 'test'`). Saves are
 * registry-only in this mode: no fetch, no disk I/O (the same guard
 * `weaponCatalogueStore` uses to keep a suite from writing tracked data).
 */
function isTestMode(): boolean {
  return import.meta.env.MODE === 'test';
}

/** True when this build may persist rhythm edits (dev server only). */
export function isWeaponLevelsWritable(): boolean {
  return isDev();
}

// ── Payload + validation ────────────────────────────────────────────

/**
 * Builds the PUT body the plugin accepts for one weapon's full rung list.
 * The panel and its tests share this so the wire shape cannot drift.
 */
export function buildWeaponLevelsWriteBody(
  weaponId: WeaponId,
  rungs: readonly WeaponLadderRung[],
): string {
  return JSON.stringify({
    weaponId,
    rungs: rungs.map(({ k, n, rotation }) => ({ k, n, rotation })),
  });
}

/**
 * Client-side validation of a candidate rung list, using the same schema the
 * dev plugin enforces. Returns the diagnostics (weapon, rung index, field) or
 * an empty array when the list is writable.
 */
export function validateWeaponLevelRungs(
  weaponId: WeaponId,
  rungs: readonly WeaponLadderRung[],
): string[] {
  const result = validateWeaponLevelsWriteBlob(
    buildWeaponLevelsWriteBody(weaponId, rungs),
  );
  return result.ok ? [] : [...result.errors];
}

// ── Transport ───────────────────────────────────────────────────────

/** Reads the endpoint's rejection detail, falling back to the HTTP status. */
async function describeWriteFailure(res: Response): Promise<string> {
  try {
    const payload = (await res.json()) as { errors?: unknown; error?: unknown };
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      return payload.errors.map(String).join('; ');
    }
    if (typeof payload.error === 'string' && payload.error !== '') {
      return payload.error;
    }
  } catch {
    // Non-JSON error body: fall through to the status description.
  }
  return `Write failed with HTTP ${res.status}`;
}

/** Re-reads the committed file through the dev plugin and reloads the ladders. */
async function reReadWeaponLevels(): Promise<boolean> {
  try {
    const res = await fetch(WEAPON_LEVELS_WRITE_PATH);
    if (!res.ok) return false;
    reloadWeaponLevels(await res.text());
    return true;
  } catch {
    return false;
  }
}

// ── Write API ───────────────────────────────────────────────────────

/**
 * Persists one weapon's Euclidean rung list (the panel's **Save**).
 *
 * - non-dev builds report {@link WEAPON_LEVELS_READ_ONLY_REASON} and write
 *   nothing;
 * - test mode commits the validated rungs to the in-memory runtime ladders
 *   (no fetch, no disk I/O);
 * - the dev server PUTs the payload and **re-reads** the file, so the running
 *   scene plays the rhythm the designer just saved. A failed re-read keeps
 *   the validated in-memory commit.
 */
export async function saveWeaponLevels(
  weaponId: WeaponId,
  rungs: readonly WeaponLadderRung[],
): Promise<WeaponLevelsSaveResult> {
  const errors = validateWeaponLevelRungs(weaponId, rungs);
  if (errors.length > 0) return { ok: false, reason: errors.join('; ') };

  if (!isDev()) return { ok: false, reason: WEAPON_LEVELS_READ_ONLY_REASON };

  if (isTestMode()) {
    overrideWeaponLevelRungs(weaponId, rungs);
    return { ok: true };
  }

  try {
    const res = await fetch(WEAPON_LEVELS_WRITE_PATH, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: buildWeaponLevelsWriteBody(weaponId, rungs),
    });
    if (!res.ok) return { ok: false, reason: await describeWriteFailure(res) };

    if (!(await reReadWeaponLevels())) {
      // The write landed but the re-read failed: commit the validated rungs
      // in memory so the running scene still reflects what was saved.
      overrideWeaponLevelRungs(weaponId, rungs);
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Write failed',
    };
  }
}

/**
 * Seeds the store from a committed file text (tests and the dev boot). Not a
 * write path — it only refreshes the in-memory runtime ladders.
 */
export function seedWeaponLevelsStore(raw: string): void {
  reloadWeaponLevels(raw);
}

/** Restores the runtime ladders to the bundled committed baseline. */
export function resetWeaponLevelsStore(): void {
  resetWeaponLevelsToBundled();
}
