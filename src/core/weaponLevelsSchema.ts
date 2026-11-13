/**
 * Weapon-levels (Euclidean cadence ladder) schema, parsing and file I/O
 * contract (AH-0MW0WLZ9600693R9).
 *
 * `src/utils/weaponLevels.ts` builds the runtime `WEAPON_EUCLIDEAN_LADDERS`
 * from the bundled `src/data/weapon-levels.json`, and the dev-only write-back
 * middleware (`vite/plugins/weaponLevelsPlugin.ts`) writes designer edits back
 * to that Git-tracked file. Both must agree on the file shape, the parse
 * diagnostics and the canonical byte format, so the shape and the pure
 * parsing live here **once**.
 *
 * The module is deliberately **pure** — no DOM, no `?raw` bundle imports, no
 * Vite-only imports — because `vite.config.ts` imports the plugin that uses
 * it, and the Vite config loader cannot resolve `?raw` imports (compare
 * `botTuningSchema.ts`). `src/utils/weaponLevels.ts` imports the parser from
 * here and re-exports it for its existing callers.
 *
 * Accepted file shape: a JSON object keyed by weapon id, each value a
 * non-empty array of `{ k, n, rotation }` rungs (`stepMs` is deliberately not
 * authored — it is injected at load time from the shared 16th-note lattice).
 *
 * @module src/core/weaponLevelsSchema
 */

import type { WeaponId } from '../utils/weapons';

/** Project-relative path of the Git-tracked authored ladder data. */
export const WEAPON_LEVELS_FILE_PATH = 'src/data/weapon-levels.json';

/** Prefix under which the dev-only write-back middleware serves its endpoint. */
export const WEAPON_LEVELS_API_PREFIX = '/api/weapon-levels/';

/** Dev-server endpoint the client PUTs a weapon's rung list to. */
export const WEAPON_LEVELS_WRITE_PATH = `${WEAPON_LEVELS_API_PREFIX}${WEAPON_LEVELS_FILE_PATH}`;

/**
 * The shipped weapon roster, in catalogue order.
 *
 * Pinned here (rather than imported from `src/utils/weapons.ts`, which pulls
 * `?raw` bundle imports the Vite config loader cannot resolve) so the pure
 * schema can validate weapon ids. `src/utils/weaponLevelsData.test.ts` and the
 * plugin suite assert this stays identical to the runtime `WEAPON_IDS`, so a
 * newly added weapon cannot drift silently.
 */
export const SHIPPED_WEAPON_IDS: readonly WeaponId[] = [
  'cannon',
  'spread',
  'dual',
  'rapid',
  'wave_laser',
  'ricochet',
  'cluster',
  'options',
  'nova',
  'mortar',
  'arc',
  'rear_guard',
  'broadside',
  'railgun',
  'shard_swarm',
  'heavy_slug',
];

/** Every shipped weapon id, for id validation. */
const SHIPPED_WEAPON_ID_SET: ReadonlySet<string> = new Set(SHIPPED_WEAPON_IDS);

/** Difference below which two densities are treated as identical. */
export const DENSITY_EPSILON = 1e-9;

/** True for a finite positive whole number. */
export function isPositiveWhole(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/**
 * One authored rung of a weapon's Euclidean ladder **as stored in data**.
 *
 * Only the tempo-independent shape is authored: `stepMs` is deliberately
 * absent and injected at load time from the shared 16th-note lattice, so a
 * data edit cannot desynchronise a rung from the shared tempo.
 */
export interface WeaponLadderRung {
  /** Onsets per tile (`1 <= k <= n`). */
  readonly k: number;
  /** Steps per tile (`n > 0`). */
  readonly n: number;
  /** Phase shift in steps (`0 <= rotation < n`). */
  readonly rotation: number;
}

/** The result of parsing the bundled `src/data/weapon-levels.json` blob. */
export interface WeaponLadderParseResult {
  /** Weapon ids whose ladder rungs came from the data file. */
  ladders: Partial<Record<WeaponId, readonly WeaponLadderRung[]>>;
  /** Human-readable diagnostics (empty for the committed file). */
  errors: string[];
}

/** The data file as a plain record of weapon id → authored rungs. */
export type WeaponLevelsRecord = Partial<
  Record<WeaponId, readonly WeaponLadderRung[]>
>;

/**
 * Parses the authored `src/data/weapon-levels.json` blob into per-weapon
 * ladder rungs. **Never throws.**
 *
 * Accepted shape: a JSON object keyed by weapon id, each value a non-empty
 * array of `{ k, n, rotation }` rungs. The three rung fields are validated
 * here — not only at ladder build time — so a data typo is reported against
 * the file a designer edited: `k`/`n` are positive whole numbers with
 * `k <= n`, `rotation` is a whole number with `0 <= rotation < n`, and the
 * rung densities (`k / n`) must not decrease along the ladder. Every rung
 * shares the runtime 16th-note step, so `stepMs` is deliberately **not**
 * authored.
 *
 * The density check is the semantic invariant that would otherwise throw from
 * the ladder builder at module load: validating it here keeps a well-formed
 * but wrong data edit on the code-fallback path instead of crashing the boot.
 *
 * @param raw - The JSON text (typically the committed file's contents).
 * @param weaponIds - The shipped roster, in report order. Defaults to
 *   {@link SHIPPED_WEAPON_IDS}; `weaponLevels.ts` passes the runtime
 *   `WEAPON_IDS` so its report order is unchanged.
 */
export function parseWeaponLevels(
  raw: string | null | undefined,
  weaponIds: readonly WeaponId[] = SHIPPED_WEAPON_IDS,
): WeaponLadderParseResult {
  const errors: string[] = [];
  const ladders: Partial<Record<WeaponId, readonly WeaponLadderRung[]>> = {};

  if (raw === null || raw === undefined || raw.trim() === '') {
    errors.push(`${WEAPON_LEVELS_FILE_PATH}: file is missing or empty`);
    return { ladders, errors };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    errors.push(`${WEAPON_LEVELS_FILE_PATH}: invalid JSON (${reason})`);
    return { ladders, errors };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    errors.push(
      `${WEAPON_LEVELS_FILE_PATH}: expected an object keyed by weapon id`,
    );
    return { ladders, errors };
  }

  const knownIds: ReadonlySet<string> = new Set(weaponIds);
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!knownIds.has(key)) {
      errors.push(`${key}: unknown weapon id`);
    }
  }

  for (const weaponId of weaponIds) {
    const entry = record[weaponId];
    if (entry === undefined) {
      errors.push(`${weaponId}: missing ladder`);
      continue;
    }
    if (!Array.isArray(entry) || entry.length === 0) {
      errors.push(`${weaponId}: expected a non-empty array of rungs`);
      continue;
    }

    const rungs: WeaponLadderRung[] = [];
    let valid = true;
    let previousDensity = Number.NEGATIVE_INFINITY;
    entry.forEach((rung: unknown, index: number) => {
      const where = `${weaponId}[${index}]`;
      if (typeof rung !== 'object' || rung === null || Array.isArray(rung)) {
        errors.push(`${where}: expected { k, n, rotation }`);
        valid = false;
        return;
      }
      const { k, n, rotation } = rung as Record<string, unknown>;
      if (!isPositiveWhole(k) || !isPositiveWhole(n)) {
        errors.push(`${where}: k and n must be positive whole numbers`);
        valid = false;
        return;
      }
      if ((k as number) > (n as number)) {
        errors.push(
          `${where}: k (${String(k)}) must not exceed n (${String(n)})`,
        );
        valid = false;
        return;
      }
      if (
        !Number.isInteger(rotation) ||
        (rotation as number) < 0 ||
        (rotation as number) >= (n as number)
      ) {
        errors.push(
          `${where}: rotation must be a whole number in [0, ${String(n)})`,
        );
        valid = false;
        return;
      }
      const density = (k as number) / (n as number);
      if (density + DENSITY_EPSILON < previousDensity) {
        errors.push(
          `${where}: density decreases (${String(k)}/${String(n)} < ${previousDensity.toFixed(4)})`,
        );
        valid = false;
        return;
      }
      previousDensity = density;
      rungs.push({
        k: k as number,
        n: n as number,
        rotation: rotation as number,
      });
    });

    if (valid) ladders[weaponId] = rungs;
  }

  return { ladders, errors };
}

// ── Dev write payload ───────────────────────────────────────────────

/** The PUT body the panel's **Save** sends: one weapon's full rung list. */
export interface WeaponLevelsWritePayload {
  /** The weapon whose ladder is being replaced. */
  readonly weaponId: WeaponId;
  /** The complete, ordered rung list for {@link weaponId}. */
  readonly rungs: readonly WeaponLadderRung[];
}

/** Result of validating a PUT body destined for the committed file. */
export type WeaponLevelsWriteValidation =
  | { readonly ok: true; readonly payload: WeaponLevelsWritePayload }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validates a single rung, pushing diagnostics naming weapon/index/field. */
function validateRung(
  weaponId: string,
  rung: unknown,
  index: number,
  errors: string[],
): WeaponLadderRung | null {
  const where = `${weaponId}[${index}]`;
  if (typeof rung !== 'object' || rung === null || Array.isArray(rung)) {
    errors.push(`${where}: expected { k, n, rotation }`);
    return null;
  }
  const { k, n, rotation } = rung as Record<string, unknown>;
  if (!isPositiveWhole(k) || !isPositiveWhole(n)) {
    errors.push(`${where}: k and n must be positive whole numbers`);
    return null;
  }
  if ((k as number) > (n as number)) {
    errors.push(
      `${where}: k (${String(k)}) must not exceed n (${String(n)})`,
    );
    return null;
  }
  if (
    !Number.isInteger(rotation) ||
    (rotation as number) < 0 ||
    (rotation as number) >= (n as number)
  ) {
    errors.push(
      `${where}: rotation must be a whole number in [0, ${String(n)})`,
    );
    return null;
  }
  return { k: k as number, n: n as number, rotation: rotation as number };
}

/**
 * Strict validation of a PUT body before any file access: true when it is a
 * self-consistent `{ weaponId, rungs }` payload that can be merged into the
 * committed file.
 *
 * Rejects every sibling of the parser's rung diagnostics (positive whole
 * `k`/`n`, `k <= n`, `rotation` in `[0, n)`, non-decreasing density) plus a
 * malformed body and an unknown weapon id, naming the weapon, rung index and
 * field so the panel can surface an actionable message. The middleware
 * returns `errors` and never touches the file when validation fails.
 */
export function validateWeaponLevelsWriteBlob(
  raw: string | null,
): WeaponLevelsWriteValidation {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, errors: ['Weapon-levels payload is empty'] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['Weapon-levels payload is not valid JSON'] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, errors: ['Weapon-levels payload must be a JSON object'] };
  }

  const record = parsed as Record<string, unknown>;
  const weaponId = record.weaponId;
  if (typeof weaponId !== 'string' || weaponId.trim() === '') {
    return { ok: false, errors: ['weaponId must be a non-empty string'] };
  }
  if (!SHIPPED_WEAPON_ID_SET.has(weaponId)) {
    return { ok: false, errors: [`${weaponId}: unknown weapon id`] };
  }

  const rungsRaw = record.rungs;
  if (!Array.isArray(rungsRaw) || rungsRaw.length === 0) {
    return {
      ok: false,
      errors: [`${weaponId}: rungs must be a non-empty array`],
    };
  }

  const errors: string[] = [];
  const rungs: WeaponLadderRung[] = [];
  let previousDensity = Number.NEGATIVE_INFINITY;
  rungsRaw.forEach((rung: unknown, index: number) => {
    const parsedRung = validateRung(weaponId, rung, index, errors);
    if (parsedRung === null) return;
    const density = parsedRung.k / parsedRung.n;
    if (density + DENSITY_EPSILON < previousDensity) {
      errors.push(
        `${weaponId}[${index}]: density decreases (${parsedRung.k}/${parsedRung.n} < ${previousDensity.toFixed(4)})`,
      );
      return;
    }
    previousDensity = density;
    rungs.push(parsedRung);
  });
  if (errors.length > 0) return { ok: false, errors };

  return { ok: true, payload: { weaponId: weaponId as WeaponId, rungs } };
}

// ── Canonical serialisation ─────────────────────────────────────────

/**
 * Canonical pretty-printed JSON for a levels record (no trailing newline).
 * Key order follows the parsed object, so a merge that replaces one weapon's
 * rungs leaves every other weapon (and the file's key order) byte-identical.
 */
export function serialiseWeaponLevelsRecord(
  record: Record<string, unknown>,
): string {
  return JSON.stringify(record, null, 2);
}

/**
 * The committed file's exact bytes: canonical JSON plus a trailing newline.
 * Preserving this keeps the file Git-committable and byte-stable.
 */
export function serialiseWeaponLevelsFile(
  record: Record<string, unknown>,
): string {
  return `${serialiseWeaponLevelsRecord(record)}\n`;
}

/**
 * Merges a validated weapon's rung list into the committed record (parsed
 * from the existing file), preserving key order and every other weapon.
 */
export function mergeWeaponLevelsRecord(
  record: Record<string, unknown>,
  weaponId: string,
  rungs: readonly WeaponLadderRung[],
): Record<string, unknown> {
  return {
    ...record,
    [weaponId]: rungs.map(({ k, n, rotation }) => ({ k, n, rotation })),
  };
}
