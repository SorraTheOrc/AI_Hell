/**
 * Dev-only telemetry enforcement scan
 * (AH-0MVBMR0BG0005BBI, parent AH-0MVBHRLY8004BGDN).
 *
 * The dev-mode telemetry feature is only safe while **every** production-
 * reachable module routes its decision through `src/telemetry/devMode.ts`.
 * This static scan fails the suite if that invariant regresses:
 *
 * - AC2 — the gate module is the sole decision point: it is the only
 *   production module that combines `import.meta.env.DEV` with telemetry, and
 *   no module re-implements the `DEV && shareTelemetryDev` decision.
 * - AC3a — every production module that reads the local JSONL sink key or the
 *   dev upload endpoint goes through the gate.
 * - AC3b — the dev setting never leaks into the consent-gated production
 *   config (`src/telemetry/config.ts`), so collection-on-by-default cannot be
 *   reached when `import.meta.env.DEV` is false.
 * - AC3c — every dev telemetry upload Vite plugin declares `apply: 'serve'`,
 *   so the endpoint is never registered for a production build.
 * - AC4 — the bundle-hygiene gate forbids the dev upload endpoint in the
 *   shipped bundle while leaving production-reachable markers (the local sink
 *   key, which ships with the telemetry framework) untouched.
 *
 * The scanning helpers are pure and exported so the tests below prove the
 * scan **detects** violations with synthetic files, instead of only asserting
 * today's (currently empty) live result. Only browser/server sources under
 * `src/` and `vite/` are scanned: `scripts/*.mjs` is Node-only dev tooling
 * that never ships in the bundle, so it is not dev-gated.
 *
 * @module src/telemetry/devModeEnforcement
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

import { FORBIDDEN_MARKERS } from '../../scripts/check-bundle-hygiene.mjs';

const ROOT = process.cwd();

/** The single dev-only decision point. */
const GATE_MODULE = 'src/telemetry/devMode.ts';

/** The dev upload endpoint the later slices add (dev-only). */
const DEV_UPLOAD_ENDPOINT = '/api/telemetry/upload';

/** Identifiers of the sanctioned gate predicates. */
const GATE_CALLS = ['isDevTelemetryCollectionEnabled', 'isDevTelemetryUploadEnabled'] as const;

/** Markers that identify a module consuming dev telemetry. */
const DEV_CONSUMER_MARKERS = ['TELEMETRY_JSONL_STORAGE_KEY', 'ai_hell_telemetry_jsonl', DEV_UPLOAD_ENDPOINT];

/**
 * Sites that *name* the markers without acting on them: the sink defines the
 * storage key, and the barrel re-exports it. Neither decides or performs a
 * dev-telemetry action, so neither needs the gate. The dev-server upload
 * middleware (Node-only, never shipped in the bundle) likewise *declares* the
 * endpoint it serves; its dev-only-ness is enforced by the `apply: 'serve'`
 * scan below and the bundle-hygiene marker.
 */
const DECLARATION_SITES: ReadonlySet<string> = new Set([
  'src/telemetry/sinks.ts',
  'src/telemetry/index.ts',
  'vite/plugins/telemetryUploadPlugin.ts',
]);

/** Production source roots scanned for dev-telemetry decisions. */
const PRODUCTION_ROOTS = ['src', 'vite'];

/** Test/type-declaration files are not production-reachable code. */
const NON_PRODUCTION = /(\.test\.ts|\.d\.ts)$/;

/** One production source file, repo-relative. */
interface SourceFile {
  readonly file: string;
  readonly source: string;
}

/** Strips block/line comments, keeping string literals. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Strips comments and string literals so only executable code is matched. */
function stripNonCode(source: string): string {
  return stripComments(source)
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/** True when the source *code* decides on the Vite dev flag. */
function readsDevFlag(source: string): boolean {
  return /import\.meta\.env\.DEV\b|\benv\.DEV\b/.test(stripNonCode(source));
}

/** True when the source *code* invokes one of the gate predicates. */
function usesGate(source: string): boolean {
  const code = stripNonCode(source);
  return GATE_CALLS.some((name) => code.includes(name));
}

/**
 * Production modules that consume dev telemetry (sink key or upload endpoint)
 * without going through the dev gate.
 */
function ungatedDevTelemetryConsumers(
  files: readonly SourceFile[],
  declarationSites: ReadonlySet<string> = DECLARATION_SITES,
): string[] {
  return files
    .filter((file) => !declarationSites.has(file.file))
    .filter((file) => DEV_CONSUMER_MARKERS.some((marker) => file.source.includes(marker)))
    .filter((file) => !usesGate(file.source))
    .map((file) => file.file)
    .sort();
}

/**
 * Production modules that combine the dev build flag with telemetry code —
 * the set the gate module must be the only member of.
 */
function devTelemetryDecisionFiles(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => readsDevFlag(file.source))
    .filter((file) => /telemetry/i.test(stripComments(file.source)))
    .map((file) => file.file)
    .sort();
}

/**
 * Production modules that re-implement the `DEV && shareTelemetryDev` gate
 * outside the gate module (a settings default alone is fine — it makes no
 * build decision).
 */
function reimplementedDevSettingGates(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.file !== GATE_MODULE)
    .filter((file) => stripNonCode(file.source).includes('shareTelemetryDev'))
    .filter((file) => readsDevFlag(file.source))
    .map((file) => file.file)
    .sort();
}

/**
 * Dev telemetry upload Vite plugins (by filename or by the endpoint literal)
 * that fail to declare `apply: 'serve'`. The gate is a no-op in a production
 * bundle, but the *server* plugin must also never be registered for a build.
 */
function uploadPluginsWithoutServe(files: readonly SourceFile[]): string[] {
  return files
    .filter((file) => file.file.startsWith('vite/plugins/'))
    .filter((file) => /telemetry/i.test(file.file) || file.source.includes(DEV_UPLOAD_ENDPOINT))
    .filter((file) => !/apply\s*:\s*['"]serve['"]/.test(stripComments(file.source)))
    .map((file) => file.file)
    .sort();
}

/** Recursively collects production sources under the given repo-relative roots. */
function collectProductionSources(
  roots: readonly string[] = PRODUCTION_ROOTS,
  root: string = ROOT,
): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.m?ts$/.test(entry.name)) {
        const file = path.relative(root, full).split(path.sep).join('/');
        if (NON_PRODUCTION.test(file)) continue;
        out.push({ file, source: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  for (const rel of roots) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) walk(abs);
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Reads one production source by repo-relative path. */
function readSource(file: string): string {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}

/** Shorthand for a synthetic source file in the scan self-tests. */
function fixture(file: string, source: string): SourceFile {
  return { file, source };
}

const LIVE_SOURCES = collectProductionSources();

describe('dev-only telemetry gate — sole decision point (AC2)', () => {
  it('is the only production module that combines the dev flag with telemetry', () => {
    expect(devTelemetryDecisionFiles(LIVE_SOURCES)).toEqual([GATE_MODULE]);
  });

  it('is detected by the scan when another module decides on the dev flag (self-test)', () => {
    const files = [
      fixture(GATE_MODULE, 'if (import.meta.env.DEV) collectTelemetry();'),
      fixture('src/scenes/PlayScene.ts', 'if (import.meta.env.DEV) collectTelemetry();'),
    ];

    expect(devTelemetryDecisionFiles(files)).toEqual([
      'src/scenes/PlayScene.ts',
      GATE_MODULE,
    ]);
  });

  it('no production module re-implements the DEV && shareTelemetryDev decision', () => {
    expect(reimplementedDevSettingGates(LIVE_SOURCES)).toEqual([]);
  });

  it('flags a re-implemented gate but not a settings default (self-test)', () => {
    const files = [
      fixture(
        'src/scenes/PlayScene.ts',
        "if (import.meta.env.DEV && settings.shareTelemetryDev) uploadTelemetry();",
      ),
      fixture('src/core/settingsStore.ts', 'const DEFAULTS = { shareTelemetryDev: true };'),
    ];

    expect(reimplementedDevSettingGates(files)).toEqual(['src/scenes/PlayScene.ts']);
  });
});

describe('dev-only telemetry gate — consumers (AC3a)', () => {
  it('every module naming the dev sink key or the upload endpoint goes through the gate', () => {
    expect(ungatedDevTelemetryConsumers(LIVE_SOURCES)).toEqual([]);
  });

  it('flags an ungated sink-key reader and an ungated uploader (self-test)', () => {
    const files = [
      fixture(
        'src/core/devSinkReader.ts',
        "const raw = store.getItem(TELEMETRY_JSONL_STORAGE_KEY);",
      ),
      fixture('src/core/devUploader.ts', "fetch('/api/telemetry/upload', { method: 'POST' });"),
    ];

    expect(ungatedDevTelemetryConsumers(files)).toEqual([
      'src/core/devSinkReader.ts',
      'src/core/devUploader.ts',
    ]);
  });

  it('accepts a consumer that routes the decision through the gate (self-test)', () => {
    const files = [
      fixture(
        'src/core/devUploader.ts',
        "import { isDevTelemetryUploadEnabled } from '../telemetry/devMode';\n" +
          'if (!isDevTelemetryUploadEnabled(import.meta.env, settings)) return;\n' +
          "fetch('/api/telemetry/upload', { method: 'POST' });",
      ),
      fixture(
        'src/core/devSinkReader.ts',
        "import { isDevTelemetryCollectionEnabled } from '../telemetry/devMode';\n" +
          'if (!isDevTelemetryCollectionEnabled(import.meta.env, settings)) return;\n' +
          'const raw = store.getItem(TELEMETRY_JSONL_STORAGE_KEY);',
      ),
    ];

    expect(ungatedDevTelemetryConsumers(files)).toEqual([]);
  });

  it('exempts only the declaration sites that name the markers without acting', () => {
    const files = [
      fixture(
        'src/telemetry/sinks.ts',
        "export const TELEMETRY_JSONL_STORAGE_KEY = 'ai_hell_telemetry_jsonl';",
      ),
    ];

    expect(ungatedDevTelemetryConsumers(files)).toEqual([]);
    expect(ungatedDevTelemetryConsumers(files, new Set())).toEqual(['src/telemetry/sinks.ts']);
  });

  it('exempts the Node-only dev upload middleware that declares the endpoint', () => {
    const files = [
      fixture(
        'vite/plugins/telemetryUploadPlugin.ts',
        `export const TELEMETRY_UPLOAD_PATH = '${DEV_UPLOAD_ENDPOINT}';`,
      ),
    ];

    expect(ungatedDevTelemetryConsumers(files)).toEqual([]);
    // The exemption is load-bearing: without it the plugin is flagged.
    expect(ungatedDevTelemetryConsumers(files, new Set())).toEqual([
      'vite/plugins/telemetryUploadPlugin.ts',
    ]);
  });
});

describe('dev-only telemetry gate — production defaults (AC3b)', () => {
  it('keeps the dev setting out of the consent-gated production config', () => {
    // `resolveTelemetryConfig` decides production recording via
    // `VITE_TELEMETRY_ENABLED`/consent only; dev collectability must never be
    // folded into it, so it cannot be reached when DEV is false.
    expect(readSource('src/telemetry/config.ts')).not.toContain('shareTelemetryDev');
  });

  it('keeps the dev upload endpoint out of the gate module (bundle marker stays reliable)', () => {
    expect(readSource(GATE_MODULE)).not.toContain(DEV_UPLOAD_ENDPOINT);
  });
});

describe('dev-only telemetry gate — server plugin registration (AC3c)', () => {
  it('every dev telemetry upload plugin declares apply: serve', () => {
    expect(uploadPluginsWithoutServe(LIVE_SOURCES)).toEqual([]);
  });

  it('flags a plugin without apply: serve and accepts one with it (self-test)', () => {
    const noApply = fixture(
      'vite/plugins/telemetryUploadPlugin.ts',
      `export function telemetryUploadPlugin() { return { name: 'x', configureServer() {} }; }`,
    );
    const buildOnly = fixture(
      'vite/plugins/telemetryUploadPlugin.ts',
      `export function telemetryUploadPlugin() { return { name: 'x', apply: 'build', configureServer() {} }; }`,
    );
    const serveOnly = fixture(
      'vite/plugins/telemetryUploadPlugin.ts',
      `export function telemetryUploadPlugin() { return { name: 'x', apply: 'serve', configureServer() {} }; }`,
    );

    expect(uploadPluginsWithoutServe([noApply, buildOnly])).toEqual([
      'vite/plugins/telemetryUploadPlugin.ts',
      'vite/plugins/telemetryUploadPlugin.ts',
    ]);
    expect(uploadPluginsWithoutServe([serveOnly])).toEqual([]);
  });
});

describe('dev-only telemetry gate — bundle reachability (AC4)', () => {
  it('forbids the dev upload endpoint in the production bundle', () => {
    expect(FORBIDDEN_MARKERS.map((entry) => entry.marker)).toContain(DEV_UPLOAD_ENDPOINT);
  });

  it('leaves production-reachable telemetry markers untouched', () => {
    // The local JSONL sink ships with the telemetry framework (it is the
    // production `jsonl` sink too), so it must stay a legal bundle marker —
    // only the dev-only upload endpoint is forbidden.
    const markers = FORBIDDEN_MARKERS.map((entry) => entry.marker);
    expect(markers).not.toContain('ai_hell_telemetry_jsonl');
    expect(markers).not.toContain('TELEMETRY_JSONL_STORAGE_KEY');
  });
});
