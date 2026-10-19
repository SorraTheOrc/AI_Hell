/**
 * Test-project classification for the unit/integration split
 * (child AH-0MVF6XV87001NSEJ, parent AH-0MVF3BESP005ZDAV).
 *
 * `vitest.config.ts` and the project-membership guard test
 * (`src/test/projectMembership.test.ts`) both consume this module, so the
 * selection rule is defined exactly once and the guard asserts the real
 * config against it.
 *
 * ## Selection rule (deterministic, computed from source at config load)
 *
 * A test file belongs to the **integration** project when it needs a DOM or a
 * real `Phaser.Game`:
 *
 * 1. Its own source imports `phaser`, the shared boot harness
 *    (`src/test/gameHarness.ts`) or the DOM/canvas setup module
 *    (`src/test/setup.ts`); or
 * 2. its own source references a DOM global (`document`, `window`,
 *    `localStorage`, `sessionStorage`, `HTMLCanvasElement`, `HTMLElement`,
 *    `requestAnimationFrame`); or
 * 3. any module it imports transitively (project-relative imports, bounded)
 *    imports `phaser` — e.g. a test that only imports `PlayScene` still boots
 *    Phaser through the scene graph; or
 * 4. any module in that graph uses `import.meta.glob(...)` — a Vite-only
 *    dynamic import the static scan cannot follow (e.g.
 *    `gymDiscovery.ts` globs `src/scenes/gym/**`, which imports Phaser).
 *
 * Everything else belongs to the **unit** project (`environment: 'node'`, no
 * DOM setup, no Phaser inline transform).
 *
 * The rule is deliberately conservative: an ambiguous file lands in
 * `integration` (the slower, heavier project) rather than silently dropping
 * into a Node environment where its DOM dependency would fail. The
 * membership test fails loudly if a test file is selected by no project or by
 * both, and `classifyTestFiles` is exhaustive by construction.
 *
 * @module vitest.projects
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Directories scanned for `*.test.ts` files (mirrors the suite include globs). */
export const TEST_ROOTS = ['src', 'scripts', 'vite'] as const;

/** Vitest include globs for the whole suite (kept for documentation/tests). */
export const TEST_INCLUDE_GLOBS = [
  'src/**/*.test.ts',
  'scripts/**/*.test.ts',
  'vite/**/*.test.ts',
] as const;

/** Module specifiers that force a test file into the integration project. */
const INTEGRATION_SPECIFIERS = ['phaser'];

/** Project-relative modules that force integration membership. */
const INTEGRATION_MODULES = [
  'src/test/gameHarness.ts',
  'src/test/setup.ts',
];

/** DOM globals that force integration membership (happy-dom is required). */
const DOM_GLOBAL =
  /\b(document|window|localStorage|sessionStorage|Storage|HTMLCanvasElement|HTMLElement|requestAnimationFrame|navigator)\b/;

/** Vite-only dynamic import the static scan cannot follow. */
const DYNAMIC_GLOB = /\bimport\.meta\.glob\b/;

/** Guard against pathological import cycles / very deep graphs. */
const MAX_IMPORT_DEPTH = 24;

/** Recursively lists `*.test.ts` files under `dir` (repo-relative, sorted). */
export function collectTestFiles(
  root: string,
  dir: string = root,
  out: string[] = [],
): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      collectTestFiles(root, full, out);
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(path.relative(root, full));
    }
  }
  return out.sort();
}

/** All test files of the suite, repo-relative and sorted. */
export function allTestFiles(root: string): string[] {
  return TEST_ROOTS.flatMap((dir) => {
    const abs = path.join(root, dir);
    return fs.existsSync(abs) ? collectTestFiles(root, abs) : [];
  }).sort();
}

/** Strips block/line comments so prose mentions do not count as imports. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/**
 * Strips comments **and string literals** for DOM-global detection: a test
 * description such as `'snaps a mid-window request…'` must not be mistaken
 * for a `window` reference (observed false positive during the split).
 */
function stripNonCode(source: string): string {
  return stripComments(source)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** Import/require specifiers in a TypeScript source file. */
export function importSpecifiers(source: string): string[] {
  const code = stripComments(source);
  const out: string[] = [];
  const fromRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  const bareRe = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const sideEffectRe = /\bimport\s+['"]([^'"]+)['"]/g;
  for (const re of [fromRe, bareRe, sideEffectRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) out.push(match[1]);
  }
  return out;
}

/**
 * Resolves a relative import specifier to an existing project file
 * (repo-relative), trying `x.ts`, `x.tsx`, `x/index.ts`, `x.d.ts`.
 */
function resolveRelative(root: string, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(root, fromFile)), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(root, candidate);
    }
  }
  return null;
}

const integrationCache = new Map<string, boolean>();

/**
 * True when `file` (repo-relative) belongs to the integration project.
 * Results are memoised per process (config load + guard test).
 */
export function isIntegrationTest(root: string, file: string): boolean {
  const cached = integrationCache.get(file);
  if (cached !== undefined) return cached;

  const own = fs.readFileSync(path.join(root, file), 'utf8');
  let integration = DOM_GLOBAL.test(stripNonCode(own));

  const visited = new Set<string>([file]);
  const queue: Array<{ file: string; depth: number }> = [{ file, depth: 0 }];
  while (queue.length > 0 && !integration) {
    const { file: current, depth } = queue.shift()!;
    const source = current === file ? own : fs.readFileSync(path.join(root, current), 'utf8');
    if (DYNAMIC_GLOB.test(stripComments(source))) {
      // A glob's targets cannot be resolved statically; treat it as heavy.
      integration = true;
      break;
    }
    for (const specifier of importSpecifiers(source)) {
      if (INTEGRATION_SPECIFIERS.includes(specifier)) {
        integration = true;
        break;
      }
      const resolved = resolveRelative(root, current, specifier);
      if (resolved === null) continue;
      if (INTEGRATION_MODULES.includes(resolved)) {
        integration = true;
        break;
      }
      if (depth < MAX_IMPORT_DEPTH && !visited.has(resolved) && resolved.endsWith('.ts')) {
        visited.add(resolved);
        queue.push({ file: resolved, depth: depth + 1 });
      }
    }
  }

  integrationCache.set(file, integration);
  return integration;
}

/** The classified suite: `unit` and `integration` project file lists. */
export function classifyTestFiles(root: string = process.cwd()): {
  unit: string[];
  integration: string[];
} {
  const unit: string[] = [];
  const integration: string[] = [];
  for (const file of allTestFiles(root)) {
    (isIntegrationTest(root, file) ? integration : unit).push(file);
  }
  return { unit: unit.sort(), integration: integration.sort() };
}
