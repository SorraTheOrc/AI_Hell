/**
 * Asset + attribution contract for the bundled NASA background photos
 * (slice AH-0MVSEB2WZ000MZY8 of parent AH-0MVIB7PD50029ZY1; written
 * test-first).
 *
 * Runs in the `unit` project: plain Node `fs`, no Phaser boot. The suite
 * asserts the *shipped* asset set rather than a mock, so a missing, oversized,
 * mis-shaped, duplicated or unattributed photo fails the build:
 *
 * - ≥ 20 bundled JPEGs with an exact 1:1 match against the manifest texture
 *   keys (`BACKGROUND_TEXTURE_KEYS`), with no orphan and no missing file;
 * - every photo within the 1920×1080 canvas budget — the JPEG SOF header is
 *   parsed here, so no image-decoding dependency is added;
 * - a per-file budget and the ≤ 5 MB directory budget from the acceptance
 *   criteria;
 * - no byte-identical duplicate photos;
 * - a complete `ATTRIBUTION.md` row (NASA title/asset id, source URL, licence,
 *   retrieval date) for every file, plus the NASA media-usage URL;
 * - no reachable `nasa.gov` / `images-api` dependency from `src/**` runtime
 *   code — the dev-only fetch tooling lives outside the runtime entry graph.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BACKGROUND_ASSET_DIR,
  BACKGROUND_TEXTURE_KEYS,
  backgroundFileName,
} from './backgrounds';

/** `src/data` → repository root. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** `public/assets/backgrounds/` — where the committed photos live. */
const ASSET_DIR = join(REPO_ROOT, 'public', BACKGROUND_ASSET_DIR);
const ATTRIBUTION_PATH = join(ASSET_DIR, 'ATTRIBUTION.md');

/** Dev-only fetch/resize tooling; must never be imported by `src/`. */
const FETCH_SCRIPT = 'fetch-nasa-backgrounds';

/** Acceptance-criteria budgets. */
const MAX_DIRECTORY_BYTES = 5 * 1024 * 1024; // 5 MB for the whole directory
const MAX_FILE_BYTES = 512 * 1024; // 512 KB per photo
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

/** The filenames the manifest requires (key → `background-<slug>.jpg`). */
const expectedFiles = BACKGROUND_TEXTURE_KEYS.map(backgroundFileName);

/** Every JPEG file currently on disk in the background directory. */
function bundledFiles(): string[] {
  if (!existsSync(ASSET_DIR)) return [];
  return readdirSync(ASSET_DIR)
    .filter((name) => name.toLowerCase().endsWith('.jpg'))
    .sort();
}

/**
 * Reads a JPEG's pixel dimensions from its Start-Of-Frame (SOF) marker.
 *
 * Minimal, dependency-free header inspection: walk the marker segments from
 * the SOI marker to the first SOF marker and read the two big-endian 16-bit
 * height/width fields. Throws on anything that is not a well-formed JPEG, so a
 * corrupt asset fails loudly instead of silently skipping the size check.
 */
function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('not a JPEG (missing SOI marker)');
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) break; // end of image, no SOF found
    if (marker === 0xda) break; // start of scan, no SOF found before it

    const segmentLength = buffer.readUInt16BE(offset + 2);
    // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the dimensions.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      if (offset + 8 >= buffer.length) break;
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }

    offset += 2 + segmentLength;
  }

  throw new Error('not a JPEG (no Start-Of-Frame marker found)');
}

/** Recursively lists `.ts` files under `dir`, excluding test files. */
function runtimeSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...runtimeSourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('bundled background photos — manifest contract', () => {
  it('bundles at least 20 JPEG photos', () => {
    expect(bundledFiles().length).toBeGreaterThanOrEqual(20);
  });

  it('matches the manifest texture keys exactly one-to-one (no orphans, no gaps)', () => {
    const actual = new Set(bundledFiles());
    const expected = new Set(expectedFiles);

    const missing = [...expected].filter((file) => !actual.has(file));
    const orphaned = [...actual].filter((file) => !expected.has(file));

    expect(missing, `missing background files: ${missing.join(', ')}`).toEqual(
      [],
    );
    expect(
      orphaned,
      `background files with no manifest key: ${orphaned.join(', ')}`,
    ).toEqual([]);
  });
});

describe('bundled background photos — size budgets', () => {
  it('keeps the whole directory within the 5 MB budget', () => {
    const files = bundledFiles();
    expect(files.length).toBeGreaterThan(0);
    const totalBytes = files.reduce(
      (sum, file) => sum + statSync(join(ASSET_DIR, file)).size,
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(MAX_DIRECTORY_BYTES);
  });

  it('keeps every photo within the per-file budget', () => {
    for (const file of bundledFiles()) {
      const bytes = statSync(join(ASSET_DIR, file)).size;
      expect(bytes, `${file} is ${bytes} bytes`).toBeLessThanOrEqual(
        MAX_FILE_BYTES,
      );
    }
  });

  it('bundles every photo within the 1920×1080 canvas budget', () => {
    for (const file of bundledFiles()) {
      const buffer = readFileSync(join(ASSET_DIR, file));
      const { width, height } = readJpegDimensions(buffer);
      expect(width, `${file} width`).toBeGreaterThan(0);
      expect(height, `${file} height`).toBeGreaterThan(0);
      expect(width, `${file} width ${width}`).toBeLessThanOrEqual(MAX_WIDTH);
      expect(height, `${file} height ${height}`).toBeLessThanOrEqual(MAX_HEIGHT);
    }
  });
});

describe('bundled background photos — distinctness', () => {
  it('contains no byte-identical duplicate photos', () => {
    const digests = new Map<string, string>();
    for (const file of bundledFiles()) {
      const digest = createHash('sha256')
        .update(readFileSync(join(ASSET_DIR, file)))
        .digest('hex');
      const existing = digests.get(digest);
      expect(
        existing,
        `${file} is byte-identical to ${existing ?? '<none>'}`,
      ).toBeUndefined();
      digests.set(digest, file);
    }
  });
});

describe('bundled background photos — attribution', () => {
  /** Attribution markdown, or an empty string when the file is missing. */
  function readAttribution(): string {
    return existsSync(ATTRIBUTION_PATH) ? readFileSync(ATTRIBUTION_PATH, 'utf8') : '';
  }

  it('ships an ATTRIBUTION.md that cites the NASA media-usage guidelines', () => {
    const attribution = readAttribution();
    expect(attribution.length).toBeGreaterThan(0);
    expect(attribution).toContain(
      'https://www.nasa.gov/nasa-brand-center/images-and-media/',
    );
  });

  it('has a complete attribution row for every bundled photo', () => {
    const rows = readAttribution().split('\n');
    for (const file of bundledFiles()) {
      const row = rows.find((line) => line.includes(file));
      expect(row, `attribution row for ${file}`).toBeDefined();
      // NASA title/asset id (e.g. PIA04921, GSFC_20171208_Archive_e000383).
      expect(row).toMatch(/PIA\d+|GSFC_[\w-]+|as\d{2}-/);
      // Source URL, licence statement and retrieval date.
      expect(row).toMatch(/https?:\/\//);
      expect(row).toMatch(/public\s*domain|NASA media usage/i);
      expect(row).toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});

describe('bundled background photos — no runtime NASA dependency', () => {
  it('has no NASA service URL reachable from src/** runtime code', () => {
    const sourceFiles = runtimeSourceFiles(join(REPO_ROOT, 'src'));
    expect(sourceFiles.length).toBeGreaterThan(0);

    const offenders = sourceFiles.filter((file) =>
      /nasa\.gov|images-api/i.test(readFileSync(file, 'utf8')),
    );
    expect(
      offenders.map((file) => relative(REPO_ROOT, file)),
      'runtime files referencing a NASA service',
    ).toEqual([]);
  });

  it('keeps the fetch/resize tooling outside the runtime entry graph', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts', `${FETCH_SCRIPT}.mjs`))).toBe(
      true,
    );

    const importers = runtimeSourceFiles(join(REPO_ROOT, 'src')).filter((file) =>
      new RegExp(`\\b${FETCH_SCRIPT}\\b`).test(readFileSync(file, 'utf8')),
    );
    expect(
      importers.map((file) => relative(REPO_ROOT, file)),
      'runtime files importing the dev-only fetch tooling',
    ).toEqual([]);
  });
});
