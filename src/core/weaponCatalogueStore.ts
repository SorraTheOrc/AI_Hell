/**
 * Weapon-catalogue store — the client-side re-read seam for the tuning panel
 * (AH-0MW0Q1HMH0037RNC, parent AH-0MW0Q01VM004EPY7).
 *
 * `src/utils/weapons.ts` builds `WEAPON_CATALOGUE` once at module load from
 * the bundled CSVs. That is the right shape for the shipped game (the CSV is
 * the source of truth and production is read-only), but a designer saving
 * from the tuning panel must see the change **without reloading the page**.
 * This module owns that seam:
 *
 * - it keeps a `persisted` snapshot of the catalogue as last read from (or
 *   written to) `src/data/weapons.csv`;
 * - it mutates the exported `WEAPON_CATALOGUE` object in place, so every
 *   existing consumer (`getWeaponById`, `resolveWeaponDefinition`, `Player`,
 *   the shared combat core) reads the new definition on the next shot;
 * - it writes through the dev-only CSV plugin (`vite/plugins/configCsvPlugin`)
 *   and then **re-reads** both weapon files, re-parsing them with the same
 *   codec and runtime invariants the game uses;
 * - outside the dev server it is read-only and reports unavailability, exactly
 *   like `configStore.saveEnemyConfig`.
 *
 * The store follows the `configStore` test-mode rule: under vitest
 * (`MODE === 'test'`) a save is registry-only, so no suite can ever write a
 * tracked CSV. The dev write payload is still built by the same
 * `serializeWeaponCatalogue` function, which is what the tests pin.
 *
 * @module src/core/weaponCatalogueStore
 */

import {
  WEAPON_COLUMN_ORDER,
  WEAPON_PATTERN_COLUMN_ORDER,
  parseWeaponCatalogue,
  serializeWeaponCatalogue,
} from './csv';
import {
  DEFAULT_WEAPON_CATALOGUE,
  WEAPON_CATALOGUE,
  WEAPON_IDS,
  type WeaponDefinition,
  type WeaponId,
} from '../utils/weapons';
import {
  applyWeaponCatalogueGuards,
  validateWeaponCatalogue,
} from '../utils/weaponCatalogue';

/** Project-relative path of the weapon-catalogue CSV. */
export const WEAPONS_CSV_PATH = 'src/data/weapons.csv';

/** Project-relative path of the long-format weapon shot-pattern CSV. */
export const WEAPON_PATTERNS_CSV_PATH = 'src/data/weapon-patterns.csv';

/** Dev-server CSV endpoint prefix (mirrors `configStore.CSV_API_PREFIX`). */
export const CSV_API_PREFIX = '/api/csv/';

/** Reason reported when the write path is unavailable (non-dev builds). */
export const WEAPON_CATALOGUE_READ_ONLY_REASON =
  'Weapon writes are unavailable in production builds (read-only CSV).';

/** Result of a weapon-catalogue write attempt. */
export interface WeaponSaveResult {
  /** True when the write succeeded (or was persisted in-memory in test mode). */
  ok: boolean;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
  /** Ids the endpoint wrote, when it reported them. */
  weaponIds?: readonly string[];
  /** Non-blocking endpoint warnings (e.g. roster advisories). */
  warnings?: readonly string[];
}

/** Columns that make up the weapon CSV header (re-exported for the panel). */
export const WEAPON_CSV_COLUMNS = WEAPON_COLUMN_ORDER;
/** Columns that make up the weapon-pattern CSV header. */
export const WEAPON_PATTERN_CSV_COLUMNS = WEAPON_PATTERN_COLUMN_ORDER;

// ── Environment detection ───────────────────────────────────────────

/** True when running under the Vite dev server (the write endpoint exists). */
function isDev(): boolean {
  return import.meta.env.DEV === true;
}

/**
 * True when running under vitest (`MODE === 'test'`). Saves are
 * registry-only in this mode: no fetch, no disk I/O (the same guard
 * `configStore` uses to keep a suite from writing a tracked CSV).
 */
function isTestMode(): boolean {
  return import.meta.env.MODE === 'test';
}

/** True when this build may persist weapon edits (dev server only). */
export function isWeaponCatalogueWritable(): boolean {
  return isDev();
}

// ── Snapshot helpers ────────────────────────────────────────────────

/**
 * Deep-enough copy of a definition: the nested descriptors are copied so a
 * live preview edit can never mutate the persisted snapshot through aliasing.
 */
export function cloneWeaponDefinition(
  definition: WeaponDefinition,
): WeaponDefinition {
  return {
    ...definition,
    offsets: [...definition.offsets],
    ...(definition.sideOffsets !== undefined
      ? { sideOffsets: [...definition.sideOffsets] }
      : {}),
    ...(definition.aoe !== undefined ? { aoe: { ...definition.aoe } } : {}),
    ...(definition.orbit !== undefined ? { orbit: { ...definition.orbit } } : {}),
    ...(definition.hitscan !== undefined
      ? { hitscan: { ...definition.hitscan } }
      : {}),
    ...(definition.muzzleFlash !== undefined
      ? { muzzleFlash: { ...definition.muzzleFlash } }
      : {}),
    ...(definition.impactFx !== undefined
      ? { impactFx: { ...definition.impactFx } }
      : {}),
  };
}

/** Copies a whole catalogue. */
function cloneCatalogue(
  catalogue: Readonly<Record<WeaponId, WeaponDefinition>>,
): Record<WeaponId, WeaponDefinition> {
  const copy = {} as Record<WeaponId, WeaponDefinition>;
  for (const id of WEAPON_IDS) {
    copy[id] = cloneWeaponDefinition(catalogue[id]);
  }
  return copy;
}

/**
 * Pristine snapshot of the catalogue as built at module load. Used by
 * {@link resetWeaponCatalogueStore} so a test (or an operator) can always
 * return to the committed CSV state even after the live object was mutated by
 * a preview.
 */
const INITIAL_CATALOGUE = cloneCatalogue(WEAPON_CATALOGUE);

/** The catalogue as last read from / written to the CSV. */
let persisted: Record<WeaponId, WeaponDefinition> | null = null;

/** The persisted snapshot, lazily initialised from the module-load catalogue. */
function getPersisted(): Record<WeaponId, WeaponDefinition> {
  if (persisted === null) persisted = cloneCatalogue(INITIAL_CATALOGUE);
  return persisted;
}

// ── Public read/search API ──────────────────────────────────────────

/** Every weapon id, in catalogue order. */
export function listWeaponIds(): readonly WeaponId[] {
  return WEAPON_IDS;
}

/** True when `id` is a code-known weapon id (a fallback definition exists). */
export function isKnownWeaponId(id: string): id is WeaponId {
  return (WEAPON_IDS as readonly string[]).includes(id);
}

/**
 * The definition as last read from / written to the CSV — the value the panel
 * seeds its controls from. Returns a copy, so callers cannot mutate the
 * snapshot.
 */
export function getPersistedWeaponDefinition(id: WeaponId): WeaponDefinition {
  return cloneWeaponDefinition(getPersisted()[id]);
}

/** Every definition as last read from / written to the CSV (copies). */
export function listPersistedWeaponDefinitions(): WeaponDefinition[] {
  return WEAPON_IDS.map(getPersistedWeaponDefinition);
}

/**
 * The **live** runtime definition (what the player is firing right now),
 * including any unsaved preview edit. Returns a copy.
 */
export function getLiveWeaponDefinition(id: WeaponId): WeaponDefinition {
  return cloneWeaponDefinition(WEAPON_CATALOGUE[id]);
}

// ── Live preview (unsaved) ──────────────────────────────────────────

/**
 * Applies an unsaved draft to the live catalogue, so the preview scene fires
 * the edited definition on its next shot. Not persisted: {@link saveWeaponDefinition}
 * is the only write path.
 */
export function previewWeaponDefinition(definition: WeaponDefinition): void {
  WEAPON_CATALOGUE[definition.id] = cloneWeaponDefinition(definition);
}

/** Restores the live definition from the persisted snapshot (drops a draft). */
export function restorePersistedWeaponDefinition(id: WeaponId): void {
  WEAPON_CATALOGUE[id] = cloneWeaponDefinition(getPersisted()[id]);
}

// ── Guarded commit ──────────────────────────────────────────────────

/**
 * Commits a full catalogue to both snapshots: the persisted snapshot becomes
 * exactly what was read, and the live runtime catalogue is updated in place
 * through the same guard the module-load build runs (a rejected weapon falls
 * back to its code default so a bad row can never ship a broken roster).
 */
function commitCatalogue(
  catalogue: Readonly<Record<WeaponId, WeaponDefinition>>,
): void {
  const guarded = applyWeaponCatalogueGuards(catalogue, DEFAULT_WEAPON_CATALOGUE);
  persisted = cloneCatalogue(guarded.catalogue);
  for (const id of WEAPON_IDS) {
    WEAPON_CATALOGUE[id] = cloneWeaponDefinition(guarded.catalogue[id]);
  }
}

/** Client-side roster validation messages for a candidate catalogue. */
function catalogueErrors(
  catalogue: Readonly<Record<WeaponId, WeaponDefinition>>,
): string[] {
  return validateWeaponCatalogue(catalogue)
    .diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
    .map((diagnostic) => diagnostic.message);
}

// ── Transport ───────────────────────────────────────────────────────

/** Reads a project-relative CSV through the dev plugin. */
async function fetchCsv(path: string): Promise<string> {
  const res = await fetch(`${CSV_API_PREFIX}${path}`);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: HTTP ${res.status}`);
  return await res.text();
}

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

/** PUTs one weapon row (the full body is a valid one-row weapons CSV). */
async function putWeaponRow(
  body: string,
  mode: 'upsert' | 'append',
): Promise<WeaponSaveResult> {
  try {
    const query = mode === 'append' ? '?mode=append' : '';
    const res = await fetch(`${CSV_API_PREFIX}${WEAPONS_CSV_PATH}${query}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/csv' },
      body,
    });
    if (!res.ok) return { ok: false, reason: await describeWriteFailure(res) };
    const payload = (await res.json().catch(() => ({}))) as {
      weaponIds?: unknown;
      warnings?: unknown;
    };
    return {
      ok: true,
      weaponIds: Array.isArray(payload.weaponIds)
        ? payload.weaponIds.map(String)
        : undefined,
      warnings: Array.isArray(payload.warnings)
        ? payload.warnings.map(String)
        : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'Write failed',
    };
  }
}

/**
 * Re-reads both weapon CSVs through the dev plugin, re-parses them with the
 * shared codec and commits the result. Returns false when the read fails so
 * the caller can keep the validated in-memory definition instead.
 */
async function reReadWeaponCatalogue(): Promise<boolean> {
  try {
    const [weaponsCsv, patternsCsv] = await Promise.all([
      fetchCsv(WEAPONS_CSV_PATH),
      fetchCsv(WEAPON_PATTERNS_CSV_PATH),
    ]);
    const parsed = parseWeaponCatalogue(weaponsCsv, patternsCsv);
    const unguarded = {} as Record<WeaponId, WeaponDefinition>;
    for (const id of WEAPON_IDS) {
      unguarded[id] = parsed.catalogue[id] ?? DEFAULT_WEAPON_CATALOGUE[id];
    }
    commitCatalogue(unguarded);
    return true;
  } catch {
    return false;
  }
}

/** Builds the one-row CSV body the dev endpoint accepts for `definition`. */
export function buildWeaponWriteBody(definition: WeaponDefinition): string {
  return serializeWeaponCatalogue({
    [definition.id]: cloneWeaponDefinition(definition),
  }).weaponsCsv;
}

// ── Write API ───────────────────────────────────────────────────────

/**
 * Persists one weapon definition (the panel's **Save**).
 *
 * Validates the candidate catalogue client-side first (so an obvious roster
 * collision is a visible reason instead of a round trip), then:
 *
 * - non-dev builds report {@link WEAPON_CATALOGUE_READ_ONLY_REASON} and write
 *   nothing;
 * - test mode commits the validated definition to both snapshots in memory
 *   (no fetch, no disk I/O);
 * - the dev server PUTs the row and **re-reads** both CSVs, so the running
 *   catalogue is the file the designer just saved.
 */
export async function saveWeaponDefinition(
  definition: WeaponDefinition,
): Promise<WeaponSaveResult> {
  if (!isKnownWeaponId(definition.id)) {
    return {
      ok: false,
      reason: `Unknown weapon id "${definition.id}" — a weapon needs a code fallback definition (icon + audio cue) before it can be saved`,
    };
  }

  const candidate = {
    ...getPersisted(),
    [definition.id]: cloneWeaponDefinition(definition),
  } as Record<WeaponId, WeaponDefinition>;
  const errors = catalogueErrors(candidate);
  if (errors.length > 0) return { ok: false, reason: errors.join('; ') };

  if (!isDev()) return { ok: false, reason: WEAPON_CATALOGUE_READ_ONLY_REASON };

  if (isTestMode()) {
    commitCatalogue(candidate);
    return { ok: true, weaponIds: [definition.id] };
  }

  const result = await putWeaponRow(
    buildWeaponWriteBody(definition),
    'upsert',
  );
  if (!result.ok) return result;

  if (!(await reReadWeaponCatalogue())) {
    // The write landed but the re-read failed: keep the validated definition
    // so the running scene still reflects what was saved.
    commitCatalogue(candidate);
  }
  return result;
}

/** Normalises a free-typed Save-As id into a candidate weapon id. */
export function sanitiseWeaponId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * The panel's **Save As**: duplicate the current definition under a new id.
 *
 * A new weapon needs more than a CSV row — an icon arm
 * (`src/powerups/icons.ts`) and an audio cue arm (`src/audio/effects.ts`) are
 * code, not data. So this path is refused unless the id is already a
 * code-known weapon (it then resolves a fallback definition, icon and cue),
 * and an existing id is refused as a duplicate. Both refusals leave the file
 * untouched and return a visible reason (AC3).
 */
export async function saveWeaponDefinitionAs(
  source: WeaponDefinition,
  rawId: string,
): Promise<WeaponSaveResult> {
  const id = sanitiseWeaponId(rawId);
  if (id === '') {
    return { ok: false, reason: 'Enter a non-empty weapon id' };
  }
  if (!isKnownWeaponId(id)) {
    return {
      ok: false,
      reason:
        `No code fallback definition (icon + audio cue) exists for "${id}" — ` +
        'Save As is refused; add the weapon in code first (src/powerups/icons.ts, src/audio/effects.ts)',
    };
  }
  const catalogue = getPersisted();
  if (catalogue[id] !== undefined) {
    return { ok: false, reason: `A weapon with id "${id}" already exists` };
  }

  const duplicate: WeaponDefinition = {
    ...cloneWeaponDefinition(source),
    id,
  };
  const candidate = {
    ...catalogue,
    [id]: duplicate,
  } as Record<WeaponId, WeaponDefinition>;
  const errors = catalogueErrors(candidate);
  if (errors.length > 0) return { ok: false, reason: errors.join('; ') };

  if (!isDev()) return { ok: false, reason: WEAPON_CATALOGUE_READ_ONLY_REASON };

  if (isTestMode()) {
    commitCatalogue(candidate);
    return { ok: true, weaponIds: [id] };
  }

  const result = await putWeaponRow(buildWeaponWriteBody(duplicate), 'append');
  if (!result.ok) return result;

  if (!(await reReadWeaponCatalogue())) commitCatalogue(candidate);
  return result;
}

// ── Test / lifecycle helpers ────────────────────────────────────────

/**
 * Restores both snapshots to the catalogue as built at module load. Intended
 * for tests and for an explicit panel reset; not a write path.
 */
export function resetWeaponCatalogueStore(): void {
  persisted = cloneCatalogue(INITIAL_CATALOGUE);
  for (const id of WEAPON_IDS) {
    WEAPON_CATALOGUE[id] = cloneWeaponDefinition(INITIAL_CATALOGUE[id]);
  }
}

/**
 * Seeds the persisted snapshot directly (test seam / non-HTTP hydration),
 * applying the same runtime guards as a real read. The live catalogue is
 * updated in place, exactly as after a re-read.
 */
export function seedWeaponCatalogueStore(
  catalogue: Readonly<Partial<Record<WeaponId, WeaponDefinition>>>,
): void {
  const merged = {} as Record<WeaponId, WeaponDefinition>;
  for (const id of WEAPON_IDS) {
    merged[id] =
      catalogue[id] !== undefined
        ? cloneWeaponDefinition(catalogue[id] as WeaponDefinition)
        : cloneWeaponDefinition(getPersisted()[id]);
  }
  commitCatalogue(merged);
}
