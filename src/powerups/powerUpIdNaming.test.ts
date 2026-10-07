/**
 * Repo-wide guard against surviving legacy GDD power-up codes
 * (AH-0MUY0GLPF009H0LE, parent "Use power up name for ID" AH-0MUX6S20F002GHPF).
 *
 * The parent renames every power-up identity from the opaque GDD codes
 * `'P3'`–`'P10'` to the canonical snake_case names (`shield`, `bomb`, …). A
 * mechanical rename across ~52 files can silently miss a literal, so this
 * guard scans **every** `src/**\/*.ts` file (production code *and* tests) and
 * fails with the exact `file:line` of every quoted legacy code that survives
 * outside the documented allow-list.
 *
 * ## Status (F2 has landed)
 *
 * This guard was originally written **test-first** (F1): the offender
 * assertion was wrapped in Vitest's `it.fails(...)` so the suite stayed green
 * while the legacy codes were still present. F2 has now renamed every
 * `P3`–`P10` literal, so the guard is a hard gate — the offender assertion is
 * a plain `it(...)` and fails on any surviving legacy code.
 *
 * See the parent plan for the red-before/green-after evidence.
 *
 * ## Allow-list
 *
 * The allow-list is deliberately small and data-driven. Two things are exempt:
 * - `src/powerups/PowerUp.test.ts` uses `'P1'` — a *deliberately invalid* id
 *   proving `getPowerUpById` throws for an unknown power-up. `P1` is the GDD
 *   weapon code for Spread Shot, not a power-up id, and must stay unknown.
 * - `src/utils/weapons.ts` — the weapon codes `P1`/`P2` (Spread/Rapid) resolve
 *   to the name-based `WeaponId` union here; weapon ids are out of scope.
 *
 * Every allow-list entry is verified to still match (a stale entry fails the
 * guard), so an entry cannot silently outlive the code it excuses. When F4
 * (persisted-weight migration) adds the `LEGACY_POWER_UP_ID_BY_CODE` map in
 * `src/core/rules.ts`, add an entry for its `'P3'`–`'P10'` keys here with a
 * matching signature — the keys are the one place legacy codes legitimately
 * remain.
 *
 * @module powerups/powerUpIdNaming.test
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Project root — Vitest runs from the repository root. */
const ROOT = process.cwd();
const SRC_DIR = path.join(ROOT, 'src');

/** This guard names the forbidden patterns, so it must never scan itself. */
const GUARD_BASENAME = 'powerUpIdNaming.test.ts';

/**
 * A quoted legacy GDD code. The scan covers `P1`–`P10` so the allow-list can
 * pin the non-power-up `P1` weapon reference; the rename targets are
 * `P3`–`P10`. `P11`+ cannot match because the closing quote is required.
 */
const LEGACY_LITERAL_RE = /['"](P(?:[1-9]|10))['"]/g;

/** One legacy-code occurrence found while scanning the source tree. */
interface Occurrence {
  /** Repo-relative POSIX path. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The exact quoted literal, e.g. `'P5'`. */
  literal: string;
}

/** A documented exemption from the repo-wide legacy-code guard. */
interface AllowListEntry {
  /** Repo-relative POSIX path the exemption applies to. */
  path: string;
  /**
   * When set, only occurrences of this exact quoted literal are exempt.
   * When omitted the whole file is exempt (used for the weapon-ID module).
   */
  literal?: string;
  /** Why the occurrence legitimately survives the power-up rename. */
  reason: string;
  /** A signature that must still match the file (stale-entry guard). */
  signature: RegExp;
}

const ALLOW_LIST: readonly AllowListEntry[] = [
  {
    path: 'src/powerups/PowerUp.test.ts',
    literal: "'P1'",
    reason:
      'Deliberately-invalid id used to prove getPowerUpById throws for an ' +
      'unknown power-up; P1 is the GDD Spread Shot weapon code, not a power-up ' +
      'id, and must remain unknown after the rename.',
    signature: /getPowerUpById\('P1' as PowerUpId\)/,
  },
  {
    path: 'src/utils/weapons.ts',
    reason:
      'The GDD weapon codes P1 (Spread) / P2 (Rapid) resolve to the ' +
      'name-based WeaponId union here; weapon ids are out of scope for the ' +
      'power-up rename.',
    signature: /export type WeaponId\s*=/,
  },
];

/** Recursively lists every TypeScript file under `dir`. */
function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(full));
    } else if (entry.isFile() && full.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

/** Repo-relative POSIX path for an absolute path. */
function relPosix(absPath: string): string {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

/** Finds every quoted legacy GDD code across the supplied files. */
function findLegacyOccurrences(files: readonly string[]): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const file of files) {
    const rel = relPosix(file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(LEGACY_LITERAL_RE)) {
        occurrences.push({ file: rel, line: index + 1, literal: match[0] });
      }
    });
  }
  return occurrences;
}

/** True when an occurrence is covered by a documented allow-list entry. */
function isAllowListed(occurrence: Occurrence): boolean {
  return ALLOW_LIST.some((entry) => {
    if (entry.path !== occurrence.file) return false;
    return entry.literal === undefined || entry.literal === occurrence.literal;
  });
}

/** Human-readable offender report used as the assertion message. */
function formatOffenders(offenders: readonly Occurrence[]): string {
  if (offenders.length === 0) return 'no legacy power-up ID literals found';
  const lines = offenders.map((o) => `  ${o.file}:${o.line}  ${o.literal}`);
  return (
    `${offenders.length} legacy power-up ID literal(s) remain ` +
    `(rename to the canonical snake_case name):\n${lines.join('\n')}`
  );
}

/** Every `src/` TypeScript file except this guard itself. */
const SCANNED_FILES = collectTypeScriptFiles(SRC_DIR).filter(
  (file) => path.basename(file) !== GUARD_BASENAME,
);

describe('power-up ID naming guard (AH-0MUY0GLPF009H0LE)', () => {
  it('scans the whole src/ tree, production code and tests', () => {
    expect(SCANNED_FILES.length).toBeGreaterThan(0);
    expect(SCANNED_FILES.some((f) => f.endsWith('powerups/types.ts'))).toBe(true);
    expect(SCANNED_FILES.some((f) => f.endsWith('powerups/effects.test.ts'))).toBe(
      true,
    );
  });

  it('detects a legacy literal and ignores the canonical name', () => {
    const sample = "const shield: PowerUpId = 'P3'; // speed_boost is the new name";
    const detected = [...sample.matchAll(LEGACY_LITERAL_RE)].map((m) => m[0]);
    expect(detected).toEqual(["'P3'"]);
  });

  it('keeps every allow-list entry current (stale-entry check)', () => {
    for (const entry of ALLOW_LIST) {
      const abs = path.join(ROOT, entry.path);
      expect(
        fs.existsSync(abs),
        `allow-list path no longer exists: ${entry.path}`,
      ).toBe(true);
      const content = fs.readFileSync(abs, 'utf8');
      expect(
        entry.signature.test(content),
        `stale allow-list entry: ${entry.path} no longer matches ${entry.signature}`,
      ).toBe(true);
      if (entry.literal !== undefined) {
        expect(
          content.includes(entry.literal),
          `stale allow-list entry: ${entry.path} no longer contains ${entry.literal}`,
        ).toBe(true);
      }
    }
  });

  // Hard gate (F2 landed): no legacy `P3`–`P10` power-up ID literal may
  // survive outside the documented allow-list.
  it('contains no legacy P3-P10 power-up ID literal', () => {
    const offenders = findLegacyOccurrences(SCANNED_FILES).filter(
      (occurrence) => !isAllowListed(occurrence),
    );
    expect(offenders, formatOffenders(offenders)).toEqual([]);
  });
});
