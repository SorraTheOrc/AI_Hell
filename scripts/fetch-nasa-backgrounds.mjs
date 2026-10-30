#!/usr/bin/env node
/**
 * Dev-time NASA background fetcher/resizer (AH-0MVSEB2WZ000MZY8).
 *
 * Downloads one curated NASA space photograph per bundled background texture
 * key, resizes/compresses it to a game-sized JPEG and writes the shipped asset
 * set plus `ATTRIBUTION.md`. The output is committed to the repository, so the
 * game never fetches anything from NASA at runtime.
 *
 * This module is **dev-only tooling**: nothing under `src/` may import it
 * (enforced by `src/data/backgrounds.assets.test.ts`). Run it with:
 *
 * ```bash
 * node scripts/fetch-nasa-backgrounds.mjs                 # fetch everything
 * node scripts/fetch-nasa-backgrounds.mjs --only background-earthrise
 * node scripts/fetch-nasa-backgrounds.mjs --dry-run       # resolve only
 * ```
 *
 * Curation is pinned by NASA asset id (not a live "first search hit"), so a
 * re-run reproduces the same set and the attribution cannot drift. The
 * `background-eskimo-nebula` slot is a documented exception: the Eskimo Nebula
 * is not indexed by the NASA Image and Video Library, so that legacy pool slot
 * carries the closest available NASA planetary-nebula photograph (the Helix
 * Nebula). The pool key itself is owned by the manifest
 * (`src/data/backgrounds.ts`) and must not change here.
 *
 * Requirements: Node 18+ (global `fetch`), `ffmpeg` and `ffprobe` on `PATH`.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/** Repository root (the directory that contains `package.json`). */
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');

/** Committed asset directory (`public/assets/backgrounds`). */
export const DEFAULT_OUT_DIR = join(
  REPO_ROOT,
  'public',
  'assets',
  'backgrounds',
);

/** Attribution filename inside the asset directory. */
export const ATTRIBUTION_FILE = 'ATTRIBUTION.md';

/** NASA media-usage guidance cited by the attribution file and the test. */
export const NASA_MEDIA_USAGE_URL =
  'https://www.nasa.gov/nasa-brand-center/images-and-media/';

const API_BASE = 'https://images-api.nasa.gov';

/** Hard upper bounds from the acceptance criteria (never exceeded). */
const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;

/** Default render target: comfortably above the 960×540 canvas, well under 1920×1080. */
const DEFAULT_TARGET_WIDTH = 1600;
const DEFAULT_TARGET_HEIGHT = 900;
/** ffmpeg `-q:v` (2–31, lower = better quality); ~80 % quality. */
const DEFAULT_QUALITY = 6;
const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/**
 * Curated key → NASA asset id map.
 *
 * The ids were selected from `https://images-api.nasa.gov` for gameplay
 * readability (dark, space-dominant, low detail in the frame centre) and are
 * pinned so the asset set is reproducible. `nasaId` is the authoritative
 * attribution record; the title is re-read from the API at fetch time.
 */
export const BACKGROUND_SOURCES = Object.freeze([
  { key: 'background-andromeda-galaxy', nasaId: 'PIA04921' },
  { key: 'background-bubble-nebula', nasaId: 'GSFC_20171208_Archive_e000383' },
  { key: 'background-carina-nebula', nasaId: 'GSFC_20171208_Archive_e002152' },
  { key: 'background-crab-nebula', nasaId: 'PIA03606' },
  { key: 'background-earthrise', nasaId: 'GSFC_20171208_Archive_e000496' },
  // Documented exception — see the module doc comment.
  { key: 'background-eskimo-nebula', nasaId: 'PIA15658' },
  { key: 'background-horsehead-nebula', nasaId: 'PIA04215' },
  { key: 'background-jupiter-storm', nasaId: 'PIA21985' },
  { key: 'background-lagoon-nebula', nasaId: 'PIA14728' },
  { key: 'background-mars-surface', nasaId: 'PIA05445' },
  { key: 'background-milky-way', nasaId: 'PIA03653' },
  { key: 'background-orion-nebula', nasaId: 'PIA04227' },
  { key: 'background-pillars-of-creation', nasaId: 'GSFC_20171208_Archive_e000842' },
  { key: 'background-ring-nebula', nasaId: 'GSFC_20171208_Archive_e001464' },
  { key: 'background-saturn-rings', nasaId: 'PIA01969' },
  { key: 'background-sombrero-galaxy', nasaId: 'PIA15226' },
  { key: 'background-sun-corona', nasaId: 'GSFC_20171208_Archive_e001831' },
  { key: 'background-tarantula-nebula', nasaId: 'PIA14415' },
  { key: 'background-veil-nebula', nasaId: 'PIA15413' },
  { key: 'background-whirlpool-galaxy', nasaId: 'PIA04230' },
]);

/** Fetch and parse JSON, retrying transient network failures a few times. */
async function fetchJson(url, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ai-hell-asset-fetch/1.0 (+dev tooling)' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((wait) => setTimeout(wait, 500 * attempt));
      }
    }
  }
  throw lastError;
}

/** Download a binary URL to *destination* with the same retry policy. */
async function download(url, destination, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'ai-hell-asset-fetch/1.0 (+dev tooling)' },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      writeFileSync(destination, bytes);
      return bytes.length;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((wait) => setTimeout(wait, 500 * attempt));
      }
    }
  }
  throw lastError;
}

/** NASA item metadata (title, id, centre) for a pinned asset id. */
async function fetchMetadata(nasaId) {
  const data = await fetchJson(
    `${API_BASE}/search?${new URLSearchParams({ nasa_id: nasaId })}`,
  );
  const item = data?.collection?.items?.[0]?.data?.[0];
  if (!item) throw new Error(`NASA asset not found: ${nasaId}`);
  return {
    nasaId: item.nasa_id ?? nasaId,
    title: item.title ?? nasaId,
    center: item.center ?? 'NASA',
  };
}

/** Rank image variants so a large, high-quality JPEG is preferred. */
function rankAssetHref(href) {
  if (/~large\.jpe?g$/i.test(href)) return 0;
  if (/~medium\.jpe?g$/i.test(href)) return 1;
  if (/~orig\.jpe?g$/i.test(href)) return 2;
  if (/~orig\.png$/i.test(href)) return 3;
  if (/~small\.jpe?g$/i.test(href)) return 4;
  if (/~thumb\.jpe?g$/i.test(href)) return 5;
  return 6;
}

/** The best downloadable image href from an `asset/<id>` manifest. */
async function resolveAssetHref(nasaId) {
  const data = await fetchJson(
    `${API_BASE}/asset/${encodeURIComponent(nasaId)}`,
  );
  const links = (data?.collection?.items ?? [])
    .map((item) => item?.href)
    .filter((href) => typeof href === 'string')
    .map((href) => href.replace(/^http:/, 'https:'))
    .filter((href) => /\.(jpe?g|png)$/i.test(href));
  if (links.length === 0) {
    throw new Error(`no image variant for NASA asset: ${nasaId}`);
  }
  return links.sort((a, b) => rankAssetHref(a) - rankAssetHref(b))[0];
}

/** Width/height of a local image via `ffprobe`. */
function probeDimensions(file) {
  const output = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  const stream = JSON.parse(output)?.streams?.[0];
  if (!stream?.width || !stream?.height) {
    throw new Error(`could not read dimensions of ${file}`);
  }
  return { width: stream.width, height: stream.height };
}

/** Rounds down to an even positive integer (JPEG-friendly). */
function even(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Scales and centre-crops `source` into `destination` as a uniformly-sized
 * 16:9 JPEG (the 960×540 canvas aspect), then tightens quality until it fits
 * the per-file budget.
 *
 * A uniform aspect ratio matters because the shared background layer draws the
 * texture with `setDisplaySize(GAME_WIDTH, GAME_HEIGHT)`: a square or portrait
 * photo would be stretched. Centre-cropping gives every level a clean
 * full-canvas backdrop without distortion. Output never exceeds the hard
 * 1920×1080 canvas budget.
 */
function resizeToJpeg(source, destination, options) {
  const { targetWidth, targetHeight, quality, maxFileBytes } = options;
  let outWidth = even(Math.min(targetWidth, CANVAS_WIDTH));
  let outHeight = even(Math.min(targetHeight, CANVAS_HEIGHT));
  let outQuality = quality;

  // Cover the box (may upscale) and centre-crop to exactly outWidth×outHeight.
  const coverCrop = (width, height) =>
    `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height}`;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        source,
        '-vf',
        coverCrop(outWidth, outHeight),
        '-pix_fmt',
        'yuvj420p',
        '-q:v',
        String(outQuality),
        '-frames:v',
        '1',
        destination,
      ],
      { stdio: 'pipe' },
    );
    const bytes = statSync(destination).size;
    if (bytes <= maxFileBytes) {
      return { width: outWidth, height: outHeight, bytes, quality: outQuality };
    }
    if (outQuality < 12) {
      outQuality += 1;
    } else {
      outWidth = even(outWidth * 0.85);
      outHeight = even(outHeight * 0.85);
    }
  }
  const bytes = statSync(destination).size;
  if (bytes > maxFileBytes) {
    throw new Error(
      `${destination} is ${bytes} bytes, above the ${maxFileBytes}-byte budget`,
    );
  }
  return { width: outWidth, height: outHeight, bytes, quality: outQuality };
}

/** The NASA image-detail page used as the human-readable source URL. */
function sourceUrlFor(nasaId) {
  return `https://images.nasa.gov/details/${encodeURIComponent(nasaId)}`;
}

/** Renders `ATTRIBUTION.md` from the fetched rows (deterministic order). */
export function renderAttribution(rows, retrievedOn) {
  const header = [
    '# Background photo attribution',
    '',
    'Every photo in this directory is a NASA space photograph bundled as a',
    'game asset; the game never fetches imagery at runtime. Filenames are the',
    'Phaser texture keys from `src/data/backgrounds.ts` with the shared',
    '`.jpg` extension, so `background-<slug>.jpg` backs the',
    '`background-<slug>` texture key. The pool is curated for gameplay',
    'readability: dark, space-dominant frames that do not fight the neon',
    'vector art.',
    '',
    'These images are in the **public domain** as US Government works; NASA',
    'media usage guidelines apply:',
    NASA_MEDIA_USAGE_URL,
    '',
    `Retrieved **${retrievedOn}** from the NASA Image and Video Library`,
    '(https://images.nasa.gov). Attribution is generated by',
    '`scripts/fetch-nasa-backgrounds.mjs`, so a filename can never drift from',
    'its source record.',
    '',
    '## Photos',
    '',
    '| File | NASA title | NASA asset ID | Source URL | Licence | Retrieved |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const body = rows.map(
    (row) =>
      `| \`${row.file}\` | ${row.title} | \`${row.nasaId}\` | ${row.sourceUrl} | ` +
      `NASA public domain (US Government work) — NASA media usage guidelines apply | ${retrievedOn} |`,
  );
  const footer = [
    '',
    '## Curation note',
    '',
    '`background-eskimo-nebula.jpg` is a legacy pool slot: the NASA Image and',
    'Video Library does not index the Eskimo Nebula (NGC 2392), so the slot',
    'holds the closest available NASA planetary-nebula photograph (recorded in',
    'the table above). The pool key is retained so the manifest and loader',
    'contracts stay stable.',
    '',
  ];
  return [...header, ...body, ...footer].join('\n');
}

/** Parses CLI arguments (exported for reuse). */
export function parseArgs(argv) {
  const args = {
    outDir: DEFAULT_OUT_DIR,
    only: null,
    targetWidth: DEFAULT_TARGET_WIDTH,
    targetHeight: DEFAULT_TARGET_HEIGHT,
    quality: DEFAULT_QUALITY,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out-dir') args.outDir = resolve(argv[++i]);
    else if (arg === '--only') args.only = (args.only ?? []).concat(argv[++i].split(','));
    else if (arg === '--max-width') args.targetWidth = Number(argv[++i]);
    else if (arg === '--max-height') args.targetHeight = Number(argv[++i]);
    else if (arg === '--quality') args.quality = Number(argv[++i]);
    else if (arg === '--max-file-bytes') args.maxFileBytes = Number(argv[++i]);
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

const USAGE = `Usage: node scripts/fetch-nasa-backgrounds.mjs [options]

Options:
  --out-dir <dir>        Output directory (default public/assets/backgrounds)
  --only <key[,key]>     Fetch only the named texture key(s)
  --max-width <px>       Render target width (default ${DEFAULT_TARGET_WIDTH}, hard cap ${CANVAS_WIDTH})
  --max-height <px>      Render target height (default ${DEFAULT_TARGET_HEIGHT}, hard cap ${CANVAS_HEIGHT})
  --quality <n>          ffmpeg -q:v quality (default ${DEFAULT_QUALITY})
  --max-file-bytes <n>   Per-file budget (default ${DEFAULT_MAX_FILE_BYTES})
  --dry-run              Resolve sources and report without writing images
  -h, --help             Show this help`;

/** Fetches, resizes and writes every selected background; returns the rows. */
export async function fetchBackgrounds(args = parseArgs([])) {
  if (args.targetWidth > CANVAS_WIDTH || args.targetHeight > CANVAS_HEIGHT) {
    throw new Error(
      `target box ${args.targetWidth}×${args.targetHeight} exceeds the ` +
        `${CANVAS_WIDTH}×${CANVAS_HEIGHT} canvas budget`,
    );
  }

  const selected = BACKGROUND_SOURCES.filter(
    (source) => !args.only || args.only.includes(source.key),
  );
  if (selected.length === 0) {
    throw new Error(
      `no matching texture keys (requested: ${(args.only ?? []).join(', ')})`,
    );
  }

  const retrievedOn = new Date().toISOString().slice(0, 10);
  const tempDir = mkdtempSync(join(tmpdir(), 'nasa-backgrounds-'));
  const rows = [];

  try {
    if (!args.dryRun) mkdirSync(args.outDir, { recursive: true });

    for (const source of selected) {
      const metadata = await fetchMetadata(source.nasaId);
      const href = await resolveAssetHref(source.nasaId);
      const extension = href.toLowerCase().endsWith('.png') ? 'png' : 'jpg';
      const downloadPath = join(tempDir, `${source.key}.${extension}`);
      const file = `${source.key}.jpg`;
      const outputPath = join(args.outDir, file);

      console.log(`• ${source.key} ← ${source.nasaId} (${metadata.title})`);
      console.log(`  downloading ${href}`);
      await download(href, downloadPath);

      if (args.dryRun) {
        const { width, height } = probeDimensions(downloadPath);
        rows.push({ file, ...metadata, sourceUrl: sourceUrlFor(metadata.nasaId), sourceSize: `${width}×${height}` });
        continue;
      }

      const result = resizeToJpeg(downloadPath, outputPath, {
        targetWidth: args.targetWidth,
        targetHeight: args.targetHeight,
        quality: args.quality,
        maxFileBytes: args.maxFileBytes,
      });
      console.log(
        `  wrote ${file} (${result.width}×${result.height}, ${result.bytes} bytes)`,
      );
      rows.push({ file, ...metadata, sourceUrl: sourceUrlFor(metadata.nasaId) });
    }

    if (!args.dryRun) {
      rows.sort((a, b) => a.file.localeCompare(b.file));
      const attributionPath = join(args.outDir, ATTRIBUTION_FILE);
      writeFileSync(attributionPath, renderAttribution(rows, retrievedOn));
      console.log(`• wrote ${attributionPath}`);
    }
    return rows;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** CLI entry point. Returns the process exit code. */
export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    return 2;
  }
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const rows = await fetchBackgrounds(args);
    console.log(`Done: ${rows.length} background(s).`);
    return 0;
  } catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await main();
}
