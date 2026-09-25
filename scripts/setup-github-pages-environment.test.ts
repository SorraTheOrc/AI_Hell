/**
 * Hermetic tests for `scripts/setup-github-pages-environment.sh`
 * (AH-0MUG2CGIQ002Y63K).
 *
 * The script configures the `github-pages` environment deployment policy so
 * `v*` release tags can deploy. These tests stub `gh` on `PATH` with a small
 * shell script that records every invocation and simulates the environment
 * policies API, so no network call or GitHub credential is required.
 *
 * Runs in the Node environment (not happy-dom) because it spawns processes
 * and touches the filesystem.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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

const SCRIPT_PATH = fileURLToPath(
  new URL('./setup-github-pages-environment.sh', import.meta.url),
);

// Resolve bash by absolute path so tests can run with a deliberately minimal
// PATH (the missing-`gh` case) without losing the interpreter itself.
const BASH = existsSync('/bin/bash') ? '/bin/bash' : '/usr/bin/bash';

// A stub `gh` that records invocations and simulates the deployment-policies
// API. State (whether the tag policy exists) lives in a marker file so the
// second run of the script observes the policy added by the first.
const GH_STUB = `#!/usr/bin/env bash
set -euo pipefail

log="\${GH_STUB_LOG:?GH_STUB_LOG not set}"
printf '%s\\n' "$*" >> "$log"

case "$1" in
  auth)
    if [ "\${GH_STUB_AUTH:-ok}" = "fail" ]; then
      echo "not logged in" >&2
      exit 1
    fi
    exit 0
    ;;
  repo)
    printf '%s\\n' "\${GH_STUB_REPO:-stub-owner/stub-repo}"
    exit 0
    ;;
  api)
    case " $* " in
      *" POST "*)
        : > "\${GH_STUB_STATE:?GH_STUB_STATE not set}"
        printf '%s\\n' '{"id":1,"name":"v*","type":"tag"}'
        exit 0
        ;;
    esac
    # GET: mimic the --jq filter used by the script.
    if [ -n "\${GH_STUB_STATE:-}" ] && [ -f "$GH_STUB_STATE" ]; then
      printf '%s\\n' 'tag:v*'
    fi
    exit 0
    ;;
  *)
    echo "unexpected stubbed gh invocation: $*" >&2
    exit 2
    ;;
esac
`;

interface StubEnv {
  binDir: string;
  logFile: string;
  stateFile: string;
  repo: string;
}

let workDir: string;
let stub: StubEnv;

function makeStub(): StubEnv {
  const binDir = join(workDir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const ghPath = join(binDir, 'gh');
  writeFileSync(ghPath, GH_STUB, { mode: 0o755 });
  chmodSync(ghPath, 0o755);
  return {
    binDir,
    logFile: join(workDir, 'gh.log'),
    stateFile: join(workDir, 'tag-policy.state'),
    repo: 'stub-owner/stub-repo',
  };
}

function runScript(args: string[] = [], overrides: Record<string, string> = {}) {
  return spawnSync(BASH, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
      GH_STUB_LOG: stub.logFile,
      GH_STUB_STATE: stub.stateFile,
      GH_STUB_REPO: stub.repo,
      ...overrides,
    },
  });
}

function readLog(): string {
  return existsSync(stub.logFile) ? readFileSync(stub.logFile, 'utf8') : '';
}

function countPosts(log: string): number {
  return log.split('\n').filter((line) => line.includes('POST')).length;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'pages-env-setup-'));
  stub = makeStub();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('setup-github-pages-environment.sh', () => {
  it('adds the v* tag policy when it is missing', () => {
    const result = runScript(['--repo', stub.repo]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Added');
    expect(existsSync(stub.stateFile)).toBe(true);

    const log = readLog();
    const post = log.split('\n').find((line) => line.includes('POST'));
    expect(post).toBeDefined();
    expect(post).toContain(
      `repos/${stub.repo}/environments/github-pages/deployment-branch-policies`,
    );
    expect(post).toContain('name=v*');
    expect(post).toContain('type=tag');
  });

  it('is idempotent: a second run makes no change and exits 0', () => {
    const first = runScript(['--repo', stub.repo]);
    expect(first.status).toBe(0);

    const logAfterFirst = readLog();
    expect(countPosts(logAfterFirst)).toBe(1);

    const second = runScript(['--repo', stub.repo]);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('already allows');

    const logAfterSecond = readLog();
    expect(countPosts(logAfterSecond)).toBe(1);
    const secondRunLines = logAfterSecond
      .split('\n')
      .slice(logAfterFirst.trim().split('\n').length);
    expect(secondRunLines.some((line) => line.includes('POST'))).toBe(false);
  });

  it('never deletes or rewrites the existing dev branch policy', () => {
    const result = runScript(['--repo', stub.repo]);
    expect(result.status).toBe(0);

    const log = readLog();
    expect(log).not.toMatch(/DELETE/);
    expect(log).not.toContain('--method DELETE');
  });

  it('fails loudly when gh is not installed', () => {
    // An empty bin directory on PATH: `command -v gh` cannot resolve it.
    const emptyBin = join(workDir, 'empty-bin');
    mkdirSync(emptyBin, { recursive: true });

    const result = spawnSync(BASH, [SCRIPT_PATH, '--repo', stub.repo], {
      encoding: 'utf8',
      env: { ...process.env, PATH: emptyBin },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not installed');
    expect(existsSync(stub.stateFile)).toBe(false);
  });

  it('fails loudly when gh is not authenticated and makes no partial write', () => {
    const result = runScript(['--repo', stub.repo], { GH_STUB_AUTH: 'fail' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not authenticated');
    expect(existsSync(stub.stateFile)).toBe(false);
  });

  it('resolves the repository from gh repo view when --repo is omitted', () => {
    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Added');

    const log = readLog();
    expect(log).toContain('repo view');
    expect(log).toContain(
      `repos/${stub.repo}/environments/github-pages/deployment-branch-policies`,
    );
  });

  it('prints usage on --help without calling the API', () => {
    const result = runScript(['--help']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--repo');
    expect(readLog()).toBe('');
  });

  it('rejects an unknown argument with a clear message', () => {
    const result = runScript(['--bogus']);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unknown argument: --bogus');
    expect(readLog()).toBe('');
  });
});
