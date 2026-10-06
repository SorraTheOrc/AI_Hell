/**
 * Hermetic tests for the deterministic WAV build pipeline
 * (`scripts/build-audio.mjs` + `scripts/build-audio.sh`), work item
 * AH-0MUTYV8FU007X7JD.
 *
 * The ToneForge CLI is never invoked for real: the module-level renderer
 * is replaced with a deterministic in-memory fake, and the end-to-end
 * wrapper test points `TONEFORGE_CLI` at a tiny stub script that writes
 * reproducible bytes. This keeps the suite fast, offline and
 * deterministic while still asserting the observable behaviour of the
 * committed pipeline: the rendered asset set, `checksums.json`, the
 * reproducibility guard, drift detection and the CLI modes.
 *
 * Runs in the Node environment (not happy-dom) because it uses the
 * filesystem and spawns processes.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MANIFEST_PATH,
  buildAssets,
  loadManifest,
  loadPin,
  main,
  pinPathFor,
  planRenderJobs,
  sha256,
  verifyAssets,
  verifyPinnedDependency,
} from './build-audio.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('./build-audio.sh', import.meta.url));

const silentLogger = {
  log() {},
  warn() {},
  error() {},
} as unknown as Console;

let repoRoot: string;
let manifestJsonPath: string;

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'aihell-audio-test-'));
  mkdirSync(join(root, 'audio', 'toneforge'), { recursive: true });
  writeFileSync(
    join(root, 'audio', 'toneforge', 'manifest.json'),
    readFileSync(MANIFEST_PATH, 'utf8'),
  );
  // Minimal pin + declared dependency so `main()`'s pin check passes in the
  // hermetic CLI tests (the real repository files are exercised separately).
  const pin = {
    version: 1,
    repository: 'https://example.test/ToneForge.git',
    revision: 'a'.repeat(40),
    licence: 'MIT',
    cli: 'bin/dev-cli.js',
    dependencySpecifier: 'file:../ToneForge',
  };
  writeFileSync(join(root, 'audio', 'toneforge', 'pin.json'), JSON.stringify(pin));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'aihell-audio-fixture',
      optionalDependencies: { toneforge: pin.dependencySpecifier },
    }),
  );
  writeFileSync(
    join(root, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/toneforge': { resolved: pin.dependencySpecifier } },
    }),
  );
  return root;
}

function build(renderJob = fakeRender): ReturnType<typeof buildAssets> {
  return buildAssets({
    manifest: loadManifest(manifestJsonPath),
    repoRoot,
    manifestPath: manifestJsonPath,
    renderJob,
    logger: silentLogger,
  });
}

function assetPath(file: string): string {
  return join(repoRoot, 'public', 'audio', 'sfx', file);
}

function checksumsPath(): string {
  return join(repoRoot, 'public', 'audio', 'sfx', 'checksums.json');
}

function readChecksums(): { assets: Record<string, string> } {
  return JSON.parse(readFileSync(checksumsPath(), 'utf8'));
}

const fakeRender = (job: { recipe: string; seed: number }): Buffer =>
  Buffer.from(`WAV:${job.recipe}:${job.seed}\n`);

/**
 * A tiny manifest for the end-to-end CLI tests so those tests spawn only a
 * few stub processes instead of the full recipe set (which the fast
 * in-memory `buildAssets` tests already cover).
 */
function useMinimalManifest(): void {
  writeFileSync(
    manifestJsonPath,
    JSON.stringify(
      {
        version: 1,
        recipeDirectory: 'recipes',
        outputDirectory: 'public/audio/sfx',
        checksumsFile: 'public/audio/sfx/checksums.json',
        defaultExistingRecipeSeed: 1,
        retiredCues: [],
        controlCues: [],
        cues: [
          {
            cue: 'playSpawnSound',
            recipe: 'aihell-enemy-spawn',
            delivery: 'baked',
            seeds: [32101],
          },
          {
            cue: 'playScoutFireSound',
            recipe: 'weapon-laser-zap',
            delivery: 'existing-recipe',
            seeds: [],
          },
        ],
      },
      null,
      2,
    ),
  );
}

function writeStubCli(): string {
  const stub = join(repoRoot, 'stub-tf.mjs');
  writeFileSync(
    stub,
    [
      "import { writeFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };",
      'writeFileSync(get("--output"), `WAV:${get("--recipe")}:${get("--seed")}`);',
    ].join('\n'),
  );
  return stub;
}

beforeEach(() => {
  repoRoot = makeTempRepo();
  manifestJsonPath = join(repoRoot, 'audio', 'toneforge', 'manifest.json');
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ── Render planning ─────────────────────────────────────────────────

describe('planRenderJobs', () => {
  const manifest = loadManifest(MANIFEST_PATH);
  const jobs = planRenderJobs(manifest);

  it('is deterministic for a given manifest', () => {
    expect(planRenderJobs(manifest)).toEqual(jobs);
  });

  it('plans one asset for every baked cue seed in the manifest', () => {
    const planned = new Set(jobs.map((job) => job.assetPath));
    for (const entry of manifest.cues) {
      if (entry.delivery !== 'baked') continue;
      for (const seed of entry.seeds) {
        expect(
          planned.has(`audio/sfx/${entry.recipe}.${seed}.wav`),
          `${entry.cue} seed ${seed} is not planned`,
        ).toBe(true);
      }
    }
  });

  it('never bakes the continuous thruster hum runtime shim', () => {
    expect(jobs.some((job) => job.recipe === 'aihell-thruster-hum')).toBe(false);
  });

  it('renders reused ToneForge recipes at the default seed', () => {
    for (const recipe of ['weapon-laser-zap', 'card-token-earn']) {
      expect(
        jobs.some(
          (job) => job.recipe === recipe && job.seed === manifest.defaultExistingRecipeSeed,
        ),
        `${recipe} is not planned`,
      ).toBe(true);
    }
  });

  it('assigns unique asset paths', () => {
    const paths = jobs.map((job) => job.assetPath);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

// ── Rendering + checksums ───────────────────────────────────────────

describe('buildAssets', () => {
  it('writes every rendered asset and a matching checksums.json', () => {
    const { jobs, assets } = build();

    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(existsSync(join(repoRoot, job.outputPath)), job.outputPath).toBe(true);
    }

    const recorded = readChecksums().assets;
    expect(Object.keys(recorded).sort()).toEqual(Object.keys(assets).sort());
    for (const [asset, hash] of Object.entries(assets)) {
      const bytes = readFileSync(join(repoRoot, 'public', asset));
      expect(sha256(bytes), asset).toBe(hash);
    }
  });

  it('is reproducible: rebuilding with the same renderer keeps checksums stable', () => {
    const first = build().checksums;
    const second = build().checksums;
    expect(second).toBe(first);
  });

  it('fails closed on a non-deterministic render', () => {
    let calls = 0;
    const flaky = (): Buffer => Buffer.from(`nondeterministic-${calls++}`);
    expect(() => build(flaky)).toThrow(/Non-deterministic render/);
  });

  it('removes stale WAVs that are no longer in the manifest', () => {
    mkdirSync(join(repoRoot, 'public', 'audio', 'sfx'), { recursive: true });
    writeFileSync(assetPath('stale-old-cue.wav'), 'stale');
    build();
    expect(existsSync(assetPath('stale-old-cue.wav'))).toBe(false);
  });
});

// ── Verification ────────────────────────────────────────────────────

describe('verifyAssets', () => {
  it('passes for a freshly built, committed asset set', () => {
    build();
    expect(verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot })).toEqual({
      ok: true,
      errors: [],
    });
  });

  it('reports a missing checksums file', () => {
    build();
    rmSync(checksumsPath());
    const result = verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/missing checksums file/);
  });

  it('reports a checksum mismatch when an asset drifts', () => {
    const { jobs } = build();
    writeFileSync(assetPath(jobs[0].file), 'tampered');
    const result = verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(
      new RegExp(`checksum mismatch for ${jobs[0].assetPath}`),
    );
  });

  it('reports a missing rendered asset', () => {
    const { jobs } = build();
    rmSync(assetPath(jobs[0].file));
    const result = verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/missing rendered asset/);
  });

  it('reports an unexpected asset on disk', () => {
    build();
    writeFileSync(assetPath('rogue.wav'), 'rogue');
    const result = verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/unexpected rendered asset/);
  });
});

// ── CLI modes ───────────────────────────────────────────────────────

describe('main', () => {
  it('renders with a ToneForge CLI and then verifies', () => {
    useMinimalManifest();
    const stub = writeStubCli();
    const code = main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
      logger: silentLogger,
      env: { ...process.env, TONEFORGE_CLI: stub },
    });
    expect(code).toBe(0);
    expect(existsSync(checksumsPath())).toBe(true);
    expect(verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot }).ok).toBe(true);
  });

  it('fails --render when no ToneForge CLI is available', () => {
    useMinimalManifest();
    const code = main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
      logger: silentLogger,
      env: { PATH: '/nonexistent', TONEFORGE_CLI: '' },
    });
    expect(code).toBe(1);
    expect(existsSync(checksumsPath())).toBe(false);
  });

  it('falls back to verification in auto mode without a ToneForge CLI', () => {
    useMinimalManifest();
    const stub = writeStubCli();
    main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
      logger: silentLogger,
      env: { ...process.env, TONEFORGE_CLI: stub },
    });
    const code = main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
      logger: silentLogger,
      env: { PATH: '/nonexistent', TONEFORGE_CLI: '' },
    });
    expect(code).toBe(0);
  });

  it('fails auto mode without a CLI when the committed assets drift', () => {
    build();
    writeFileSync(assetPath('weapon-laser-zap.1.wav'), 'tampered');
    const code = main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
      logger: silentLogger,
      env: { PATH: '/nonexistent', TONEFORGE_CLI: '' },
    });
    expect(code).toBe(1);
  });

  it('exits non-zero on an unknown argument', () => {
    expect(main(['--nope'], { logger: silentLogger })).toBe(2);
  });
});

// ── Shell wrapper (the documented entry point) ──────────────────────

describe('scripts/build-audio.sh', () => {
  it('forwards arguments and renders through the manifest', () => {
    useMinimalManifest();
    const stub = writeStubCli();
    const result = spawnSync(
      SCRIPT_PATH,
      ['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath],
      {
        encoding: 'utf8',
        env: { ...process.env, TONEFORGE_CLI: stub },
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(existsSync(checksumsPath())).toBe(true);
  });
});

// ── Pinned ToneForge dependency (AH-0MUTYVA2C000SNPO) ────────────────

describe('ToneForge pin', () => {
  it('the repository pin records a full commit and the MIT licence', () => {
    const pin = loadPin();
    expect(pin.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.repository).toMatch(/ToneForge/);
    expect(pin.licence).toBe('MIT');
    expect(pin.dependencySpecifier).toBe('file:../ToneForge');
  });

  it('the declared dependency matches the pin in the real repository', () => {
    expect(verifyPinnedDependency().ok).toBe(true);
  });

  it('fails when package.json does not declare the pinned specifier', () => {
    const root = mkdtempSync(join(tmpdir(), 'aihell-pin-'));
    mkdirSync(join(root, 'audio', 'toneforge'), { recursive: true });
    writeFileSync(
      pinPathFor(root),
      JSON.stringify({
        version: 1,
        repository: 'https://example.test/ToneForge.git',
        revision: 'b'.repeat(40),
        licence: 'MIT',
        cli: 'bin/dev-cli.js',
        dependencySpecifier: 'file:../ToneForge',
      }),
    );
    writeFileSync(join(root, 'package.json'), JSON.stringify({ optionalDependencies: {} }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));

    const result = verifyPinnedDependency({ repoRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/optionalDependencies/);
    rmSync(root, { recursive: true, force: true });
  });

  it('fails on a lockfile that does not record the pinned dependency', () => {
    const root = mkdtempSync(join(tmpdir(), 'aihell-pin-'));
    mkdirSync(join(root, 'audio', 'toneforge'), { recursive: true });
    writeFileSync(
      pinPathFor(root),
      JSON.stringify({
        version: 1,
        repository: 'https://example.test/ToneForge.git',
        revision: 'c'.repeat(40),
        licence: 'MIT',
        cli: 'bin/dev-cli.js',
        dependencySpecifier: 'file:../ToneForge',
      }),
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ optionalDependencies: { toneforge: 'file:../ToneForge' } }),
    );
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));

    const result = verifyPinnedDependency({ repoRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/package-lock/);
    rmSync(root, { recursive: true, force: true });
  });
});
