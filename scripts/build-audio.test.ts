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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  REPO_ROOT,
  buildAssets,
  computeInputFingerprint,
  loadManifest,
  loadPin,
  main,
  pinPathFor,
  planRenderJobs,
  resolveMainCheckout,
  resolveToneForge,
  sha256,
  verifyAssets,
  verifyPinnedDependency,
} from './build-audio.mjs';

// The end-to-end CLI/wrapper tests spawn real `node` subprocesses (the shell
// wrapper adds a `bash` + `node` layer on top). Under full-suite parallel
// load that process startup can exceed the Vitest default 5 s timeout and
// report a spurious timeout for `scripts/build-audio.sh` even though the
// pipeline itself is fast (AH-0MV5L6CP4007HQP3). Give the whole file
// headroom so a slow parallel run does not fail on timing alone.
vi.setConfig({ testTimeout: 30000 });

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
      dependencies: { toneforge: pin.dependencySpecifier },
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
      "import { writeFileSync, appendFileSync } from 'node:fs';",
      "const args = process.argv.slice(2);",
      "const get = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };",
      'writeFileSync(get("--output"), `WAV:${get("--recipe")}:${get("--seed")}`);',
      "if (process.env.RENDER_LOG) appendFileSync(process.env.RENDER_LOG, get('--recipe') + '\\n');",
    ].join('\n'),
  );
  return stub;
}

/** Path to the render-invocation log directory used by the stub CLI tests. */
function renderLogPath(): string {
  return join(repoRoot, 'render.log');
}

/** Env that points `TONEFORGE_CLI` at a stub that records every render call. */
function stubEnv(stub: string): NodeJS.ProcessEnv {
  return { ...process.env, TONEFORGE_CLI: stub, RENDER_LOG: renderLogPath() };
}

/** Lines recorded by the stub CLI (one per render) since it first ran. */
function renderLogLines(): string[] {
  return readFileSync(renderLogPath(), 'utf8').trim().split('\n').filter(Boolean);
}

/** The `inputs` fingerprint persisted in the committed checksums.json. */
function readInputsFingerprint(): string | undefined {
  return (JSON.parse(readFileSync(checksumsPath(), 'utf8')) as { inputs?: string }).inputs;
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
    // card-token-earn remains the sole reused ToneForge recipe; weapon-laser-zap
    // was retired under AC4 (AH-0MVCRR2H2007VPDU) in favour of the in-repo
    // aihell-scout-fire recipe, which is planned at its declared seed.
    for (const recipe of ['card-token-earn']) {
      expect(
        jobs.some(
          (job) => job.recipe === recipe && job.seed === manifest.defaultExistingRecipeSeed,
        ),
        `${recipe} is not planned`,
      ).toBe(true);
    }
    expect(jobs.some((job) => job.recipe === 'weapon-laser-zap')).toBe(false);
    expect(jobs.some((job) => job.recipe === 'aihell-scout-fire' && job.seed === 32181)).toBe(true);
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

// ── Input fingerprint (AH-0MV87694J009Z34V) ─────────────────────────

describe('computeInputFingerprint', () => {
  it('is deterministic for identical inputs', () => {
    useMinimalManifest();
    const manifest = loadManifest(manifestJsonPath);
    const options = { manifest, repoRoot, manifestPath: manifestJsonPath };
    expect(computeInputFingerprint(options).sha).toBe(computeInputFingerprint(options).sha);
    expect(computeInputFingerprint(options).parts).toEqual(computeInputFingerprint(options).parts);
  });

  it('covers the seed block, recipe set and pin (all render inputs)', () => {
    useMinimalManifest();
    const manifest = loadManifest(manifestJsonPath);
    const { sha, parts } = computeInputFingerprint({
      manifest,
      repoRoot,
      manifestPath: manifestJsonPath,
    });
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(parts.seedBlock).toBe(manifest.seedBlock ?? null);
    expect(parts.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parts.pinSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parts.recipes).toEqual([]);
  });

  it('changes when the manifest changes', () => {
    useMinimalManifest();
    const options = {
      manifest: loadManifest(manifestJsonPath),
      repoRoot,
      manifestPath: manifestJsonPath,
    };
    const before = computeInputFingerprint(options).sha;
    const mutated = JSON.parse(readFileSync(manifestJsonPath, 'utf8'));
    mutated.cues[0].seeds = [32102];
    writeFileSync(manifestJsonPath, JSON.stringify(mutated));
    const after = computeInputFingerprint({
      manifest: loadManifest(manifestJsonPath),
      repoRoot,
      manifestPath: manifestJsonPath,
    }).sha;
    expect(after).not.toBe(before);
  });

  it('changes when a recipe file changes', () => {
    useMinimalManifest();
    const recipeDir = join(repoRoot, 'audio', 'toneforge', 'recipes');
    mkdirSync(recipeDir, { recursive: true });
    writeFileSync(join(recipeDir, 'aihell-enemy-spawn.yaml'), '# v1\n');
    const options = {
      manifest: loadManifest(manifestJsonPath),
      repoRoot,
      manifestPath: manifestJsonPath,
    };
    const before = computeInputFingerprint(options).sha;
    writeFileSync(join(recipeDir, 'aihell-enemy-spawn.yaml'), '# v2 — changed recipe\n');
    const after = computeInputFingerprint({
      manifest: loadManifest(manifestJsonPath),
      repoRoot,
      manifestPath: manifestJsonPath,
    }).sha;
    expect(after).not.toBe(before);
  });

  it('changes when the pin changes', () => {
    useMinimalManifest();
    const options = {
      manifest: loadManifest(manifestJsonPath),
      repoRoot,
      manifestPath: manifestJsonPath,
    };
    const before = computeInputFingerprint(options).sha;
    const pin = JSON.parse(readFileSync(pinPathFor(repoRoot), 'utf8'));
    pin.revision = 'f'.repeat(40);
    writeFileSync(pinPathFor(repoRoot), JSON.stringify(pin));
    const after = computeInputFingerprint({
      manifest: loadManifest(manifestJsonPath),
      repoRoot,
      manifestPath: manifestJsonPath,
    }).sha;
    expect(after).not.toBe(before);
  });
});

// ── Auto-mode verify-first fast path (AH-0MV87694J009Z34V) ──────────

describe('auto-mode fast path', () => {
  it('verifies without re-rendering when the inputs are unchanged', () => {
    useMinimalManifest();
    const env = stubEnv(writeStubCli());
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    const checksumsBefore = readFileSync(checksumsPath(), 'utf8');
    const rendersAfterFirstBuild = renderLogLines().length;
    expect(readInputsFingerprint()).toMatch(/^[0-9a-f]{64}$/);

    const code = main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
      logger: silentLogger,
      env,
    });
    expect(code).toBe(0);
    // No renderer invocation (fast path), byte-identical artifact set.
    expect(renderLogLines().length).toBe(rendersAfterFirstBuild);
    expect(readFileSync(checksumsPath(), 'utf8')).toBe(checksumsBefore);
    expect(verifyAssets({ manifest: loadManifest(manifestJsonPath), repoRoot }).ok).toBe(true);
  });

  it('re-renders when a recipe file changes, then fast-paths again', () => {
    useMinimalManifest();
    const recipeDir = join(repoRoot, 'audio', 'toneforge', 'recipes');
    mkdirSync(recipeDir, { recursive: true });
    writeFileSync(join(recipeDir, 'aihell-enemy-spawn.yaml'), '# v1\n');
    const env = stubEnv(writeStubCli());
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    const fingerprintV1 = readInputsFingerprint();
    const rendersAfterV1 = renderLogLines().length;

    writeFileSync(join(recipeDir, 'aihell-enemy-spawn.yaml'), '# v2 — changed recipe\n');
    expect(
      main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    expect(renderLogLines().length).toBeGreaterThan(rendersAfterV1);
    expect(readInputsFingerprint()).not.toBe(fingerprintV1);

    // The fresh fingerprint matches again, so the next run fast-paths.
    const rendersAfterV2 = renderLogLines().length;
    expect(
      main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    expect(renderLogLines().length).toBe(rendersAfterV2);
  });

  it('re-renders when the manifest changes and updates the asset set', () => {
    useMinimalManifest();
    const env = stubEnv(writeStubCli());
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    const rendered = readChecksums().assets;
    expect(rendered['audio/sfx/aihell-enemy-spawn.32101.wav']).toBeTruthy();

    const manifest = JSON.parse(readFileSync(manifestJsonPath, 'utf8')) as {
      cues: Array<{ recipe: string; seeds: number[] }>;
    };
    manifest.cues = manifest.cues.map((cue) =>
      cue.recipe === 'aihell-enemy-spawn' ? { ...cue, seeds: [32102] } : cue,
    );
    writeFileSync(manifestJsonPath, JSON.stringify(manifest, null, 2));

    expect(
      main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    const assets = readChecksums().assets;
    expect(assets['audio/sfx/aihell-enemy-spawn.32102.wav']).toBeTruthy();
    expect(assets['audio/sfx/aihell-enemy-spawn.32101.wav']).toBeUndefined();
  });

  it('falls through to render when the committed checksums.json has no fingerprint (rollout)', () => {
    useMinimalManifest();
    const env = stubEnv(writeStubCli());
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    const checksums = JSON.parse(readFileSync(checksumsPath(), 'utf8'));
    delete (checksums as { inputs?: string }).inputs;
    writeFileSync(checksumsPath(), JSON.stringify(checksums));

    const rendersBefore = renderLogLines().length;
    expect(
      main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    expect(renderLogLines().length).toBeGreaterThan(rendersBefore);
    expect(readInputsFingerprint()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when the inputs are unchanged but a committed asset drifts', () => {
    useMinimalManifest();
    const env = stubEnv(writeStubCli());
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    writeFileSync(assetPath('weapon-laser-zap.1.wav'), 'tampered');
    expect(
      main(['--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(1);
  });

  it('keeps --verify strict and render-free and --render always forced', () => {
    useMinimalManifest();
    const env = stubEnv(writeStubCli());
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    const rendersAfterBuild = renderLogLines().length;

    // --verify never renders and stays strict.
    expect(
      main(['--verify', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    expect(renderLogLines().length).toBe(rendersAfterBuild);
    writeFileSync(assetPath('weapon-laser-zap.1.wav'), 'tampered');
    expect(
      main(['--verify', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(1);

    // --render forces a full render even when the inputs are unchanged.
    const rendersBeforeForce = renderLogLines().length;
    expect(
      main(['--render', '--repo-root', repoRoot, '--manifest', manifestJsonPath], {
        logger: silentLogger,
        env,
      }),
    ).toBe(0);
    expect(renderLogLines().length).toBeGreaterThan(rendersBeforeForce);
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

  it('declares toneforge as a required dependency, not an optional one', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.toneforge).toBe('file:../ToneForge');
    expect(pkg.optionalDependencies?.toneforge).toBeUndefined();
  });

  it('pins the file: dependency install strategy for npm 9/npm 10 parity', () => {
    // npm 9 defaults `install-links=true`, npm 10 defaults it to `false`; the
    // committed lockfile uses the regular (packed) representation, so the
    // setting must be pinned for `npm ci` to agree in both toolchains.
    const npmrc = readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^install-links=true\s*$/m);
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
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));

    const result = verifyPinnedDependency({ repoRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/dependencies/);
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
      JSON.stringify({ dependencies: { toneforge: 'file:../ToneForge' } }),
    );
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));

    const result = verifyPinnedDependency({ repoRoot: root });

    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/package-lock/);
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the pin from dependencies and ignores a stray optionalDependencies entry', () => {
    const root = mkdtempSync(join(tmpdir(), 'aihell-pin-'));
    mkdirSync(join(root, 'audio', 'toneforge'), { recursive: true });
    writeFileSync(
      pinPathFor(root),
      JSON.stringify({
        version: 1,
        repository: 'https://example.test/ToneForge.git',
        revision: 'd'.repeat(40),
        licence: 'MIT',
        cli: 'bin/dev-cli.js',
        dependencySpecifier: 'file:../ToneForge',
      }),
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { toneforge: 'file:../ToneForge' },
        optionalDependencies: { toneforge: 'file:../Elsewhere' },
      }),
    );
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        packages: { 'node_modules/toneforge': { resolved: 'file:../ToneForge' } },
      }),
    );

    const result = verifyPinnedDependency({ repoRoot: root });

    expect(result.ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe('resolveToneForge (worktree sibling resolution)', () => {
  it('resolves the sibling CLI next to the main checkout from inside a worktree', () => {
    const root = mkdtempSync(join(tmpdir(), 'aihell-tf-'));
    const mainRoot = join(root, 'AI_Hell');
    const worktree = join(mainRoot, '.worklog', 'worktrees', 'wl-AH-test');
    mkdirSync(worktree, { recursive: true });
    const siblingCli = join(root, 'ToneForge', 'bin', 'dev-cli.js');
    mkdirSync(join(root, 'ToneForge', 'bin'), { recursive: true });
    writeFileSync(siblingCli, '// fake CLI\n');

    const fakeSpawn = ((command: string) => {
      if (command === 'git') {
        return { status: 0, stdout: `${join(mainRoot, '.git')}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: '' };
    }) as unknown as typeof spawnSync;

    const cli = resolveToneForge({ repoRoot: worktree, env: {}, spawn: fakeSpawn });

    expect(cli).not.toBeNull();
    expect(cli?.prefixArgs).toContain(siblingCli);
    expect(cli?.source).toBe(siblingCli);
    rmSync(root, { recursive: true, force: true });
  });

  it('derives the main checkout root from the shared git directory', () => {
    const fakeSpawn = (() => ({
      status: 0,
      stdout: '/tmp/example/AI_Hell/.git\n',
      stderr: '',
    })) as unknown as typeof spawnSync;

    expect(resolveMainCheckout({ repoRoot: '/tmp/example/worktree', spawn: fakeSpawn })).toBe(
      '/tmp/example/AI_Hell',
    );
  });

  it('prefers TONEFORGE_CLI over sibling resolution', () => {
    const cli = resolveToneForge({
      repoRoot: '/nonexistent/repo',
      env: { TONEFORGE_CLI: '/somewhere/dev-cli.js' },
    });

    expect(cli?.prefixArgs).toEqual(['/somewhere/dev-cli.js']);
    expect(cli?.source).toBe('TONEFORGE_CLI');
  });

  it('returns null when neither a sibling nor a PATH CLI is available', () => {
    const root = mkdtempSync(join(tmpdir(), 'aihell-tf-none-'));
    const fakeSpawn = (() => ({ status: 1, stdout: '', stderr: '' })) as unknown as typeof spawnSync;

    expect(resolveToneForge({ repoRoot: root, env: {}, spawn: fakeSpawn })).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });
});
