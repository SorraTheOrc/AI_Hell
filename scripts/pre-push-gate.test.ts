/**
 * Behavioural regression tests for the committed dev-push gate in
 * `.githooks/pre-push` (AH-0MW28RGA6008DFT1).
 *
 * Why these exist: the repository shipped the pre-gate **v2** pre-push
 * template, which never ran the test suite. `implement.py finish` then refused
 * every dev push's terminal transition with "no valid full-suite cache entry"
 * and filed a false critical `test-failure` item, because the hook is what
 * writes the full-suite cache entry the post-push verification reads.
 *
 * The canonical template (refreshed by AH-0MW1VJK63003KHD8, which ran
 * `wl doctor upgrade --confirm`) gates the *checked-out tree* (pinned via
 * `--project-root`), warns — without refusing the push — when the checked-out
 * HEAD is not the sha being pushed to dev/main, and skips the suite for a ref
 * deletion (all-zero local sha). The hook is executed for real (in a temporary
 * git repository, with a stub `run_tests.py` that records its argv) so the
 * gate is pinned by observable behaviour — which refs trigger a suite, which
 * tree the suite is bound to, what a red suite does to the push — rather than
 * by grepping the script.
 *
 * Runs in the Node environment: it spawns processes and touches the
 * filesystem.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliSpawnEnv } from './cliChildEnv';

// Spawning `git` and `python3` per case is fast, but the shared host can be
// saturated; an explicit budget keeps a slow spawn from becoming a timeout.
vi.setConfig({ testTimeout: 30_000 });

const HOOK_PATH = fileURLToPath(
  new URL('../.githooks/pre-push', import.meta.url),
);

const SH = existsSync('/bin/sh') ? '/bin/sh' : '/usr/bin/sh';

const ZERO_SHA = '0'.repeat(40);
const DEV_SHA = 'a'.repeat(40);

/**
 * Stub canonical runner: records the argv it was invoked with and exits with
 * `STUB_RUNNER_EXIT` (0 by default). The hook treats a non-zero exit as a red
 * suite.
 */
const RUNNER_STUB = `import json, os, sys

log = os.environ.get("STUB_RUNNER_LOG")
if log:
    with open(log, "w", encoding="utf-8") as handle:
        json.dump(sys.argv[1:], handle)
sys.exit(int(os.environ.get("STUB_RUNNER_EXIT", "0")))
`;

interface Harness {
  repo: string;
  runnerLog: string;
  /** HOME for the hook: empty, so the global runner fallback cannot resolve. */
  home: string;
  /** The repository's checked-out HEAD sha (a fixture commit on branch dev). */
  head: string;
}

let workDir: string;
let harness: Harness;

function makeHarness(): Harness {
  const repo = join(workDir, 'repo');
  const home = join(workDir, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  const gitEnv = cleanGitEnv();
  spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8', env: gitEnv });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  });
  spawnSync('git', ['config', 'user.name', 'Pre-push Test'], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  spawnSync('git', ['add', '.'], { cwd: repo, encoding: 'utf8', env: gitEnv });
  spawnSync('git', ['commit', '--quiet', '-m', 'fixture'], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  });
  spawnSync('git', ['branch', '-M', 'dev'], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  });

  const runnerDir = join(repo, 'skill', 'test', 'scripts');
  mkdirSync(runnerDir, { recursive: true });
  const runnerPath = join(runnerDir, 'run_tests.py');
  writeFileSync(runnerPath, RUNNER_STUB, { mode: 0o755 });
  chmodSync(runnerPath, 0o755);

  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
    env: gitEnv,
  }).stdout.trim();
  return {
    repo,
    runnerLog: join(workDir, 'runner-argv.json'),
    home,
    head,
  };
}

/** Feed the hook one `<local_ref> <local_sha> <remote_ref> <remote_sha>` line. */
function pushLine(
  remoteRef: string,
  localSha: string,
  localRef = 'refs/heads/wl-test',
): string {
  return `${localRef} ${localSha} ${remoteRef} ${ZERO_SHA}\n`;
}

/**
 * Hermetic environment for fixture `git` invocations: the suite's runner may
 * export `GIT_DIR`/`GIT_INDEX_FILE` for its own gate index, which would leak
 * into a child `git` and stage into the wrong index. Stripping the GIT_*
 * overrides (as ContextHub's own hook tests do) keeps the throwaway repo's
 * git commands self-contained.
 */
function cleanGitEnv(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runHook(input: string, overrides: Record<string, string> = {}) {
  return spawnSync(SH, [HOOK_PATH], {
    cwd: harness.repo,
    encoding: 'utf8',
    input,
    env: cleanGitEnv(
      cliSpawnEnv({
        // Only the gate under test is exercised: branch policy, context budget
        // and the worklog sync are other hooks' concerns (and the sync would
        // reach the network).
        BRANCH_POLICY_SKIP: '1',
        CONTEXT_BUDGET_SKIP: '1',
        WORKLOG_SKIP_PRE_PUSH: '1',
        TEST_SCOPE_SKIP: undefined,
        STUB_RUNNER_LOG: harness.runnerLog,
        STUB_RUNNER_EXIT: '0',
        HOME: harness.home,
        ...overrides,
      }),
    ),
  });
}

function runnerArgv(): string[] | null {
  if (!existsSync(harness.runnerLog)) return null;
  return JSON.parse(readFileSync(harness.runnerLog, 'utf8')) as string[];
}

/** The recorded runner argv, or a failure: the gate must have been invoked. */
function requireRunnerArgv(): string[] {
  const argv = runnerArgv();
  if (argv === null) throw new Error('the gate runner was not invoked');
  return argv;
}

function argAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'pre-push-gate-')));
  harness = makeHarness();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('committed pre-push hook', () => {
  it('is executable, so git actually runs it', () => {
    expect(statSync(HOOK_PATH).mode & 0o111).not.toBe(0);
  });

  it('runs the full suite on a dev push', () => {
    const result = runHook(pushLine('refs/heads/dev', harness.head));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('full suite green');
    // No warning: the pushed sha is the checked-out commit.
    expect(result.stderr).not.toContain('is not the ref being pushed');

    const argv = requireRunnerArgv();
    expect(argAfter(argv, '--scope')).toBe('full');
    expect(argv).toContain('--strict-git-env');
    // The gate pins the checked-out tree via --project-root, not a separately
    // bound pushed commit (the pre-revert --gate-commit era is obsolete).
    expect(argAfter(argv, '--gate-commit')).toBeUndefined();
    expect(realpathSync(argAfter(argv, '--project-root') ?? '')).toBe(
      realpathSync(harness.repo),
    );
  });

  it('gates main pushes as well as dev pushes', () => {
    const result = runHook(pushLine('refs/heads/main', harness.head));

    expect(result.status).toBe(0);
    expect(argAfter(requireRunnerArgv(), '--scope')).toBe('full');
  });

  it('blocks the push when the suite is red', () => {
    const result = runHook(pushLine('refs/heads/dev', harness.head), {
      STUB_RUNNER_EXIT: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Full test suite failed');
    // The verdict is the suite's, so it must actually have been invoked.
    expect(runnerArgv()).not.toBeNull();
  });

  it('runs no suite for a feature-branch push', () => {
    const result = runHook(pushLine('refs/heads/wl-test', DEV_SHA));

    expect(result.status).toBe(0);
    expect(runnerArgv()).toBeNull();
  });

  it('honours TEST_SCOPE_SKIP=1 on a dev push', () => {
    const result = runHook(pushLine('refs/heads/dev', DEV_SHA), {
      TEST_SCOPE_SKIP: '1',
    });

    expect(result.status).toBe(0);
    expect(runnerArgv()).toBeNull();
  });

  it('fails closed when no canonical runner can be resolved', () => {
    // Remove the local runner so only the (empty) HOME fallback remains.
    rmSync(join(harness.repo, 'skill'), { recursive: true, force: true });

    const result = runHook(pushLine('refs/heads/dev', DEV_SHA));

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('run_tests.py not found');
    expect(runnerArgv()).toBeNull();
  });

  it('warns — without refusing — when the checked-out HEAD is not the pushed sha', () => {
    // DEV_SHA is not the harness repo's HEAD, so the gate warns and still runs.
    const result = runHook(pushLine('refs/heads/dev', DEV_SHA));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('is not the ref being pushed to dev/main');
    // The gate still runs: its verdict describes the checked-out tree.
    expect(requireRunnerArgv()).not.toBeNull();
  });

  it('does not run the runner for a dev ref deletion (all-zero local sha)', () => {
    const result = runHook(pushLine('refs/heads/dev', ZERO_SHA));

    expect(result.status).toBe(0);
    expect(runnerArgv()).toBeNull();
  });
});
