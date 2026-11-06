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
 * The hook is executed for real (in a temporary git repository, with a stub
 * `run_tests.py` that records its argv) so the gate is pinned by observable
 * behaviour — which refs trigger a suite, which commit the suite is bound to,
 * what a red suite does to the push — rather than by grepping the script.
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
const OTHER_SHA = 'b'.repeat(40);

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
}

let workDir: string;
let harness: Harness;

function makeHarness(): Harness {
  const repo = join(workDir, 'repo');
  const home = join(workDir, 'home');
  mkdirSync(repo, { recursive: true });
  mkdirSync(home, { recursive: true });
  spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });

  const runnerDir = join(repo, 'skill', 'test', 'scripts');
  mkdirSync(runnerDir, { recursive: true });
  const runnerPath = join(runnerDir, 'run_tests.py');
  writeFileSync(runnerPath, RUNNER_STUB, { mode: 0o755 });
  chmodSync(runnerPath, 0o755);

  return { repo, runnerLog: join(workDir, 'runner-argv.json'), home };
}

/** Feed the hook one `<local_ref> <local_sha> <remote_ref> <remote_sha>` line. */
function pushLine(
  remoteRef: string,
  localSha: string,
  localRef = 'refs/heads/wl-test',
): string {
  return `${localRef} ${localSha} ${remoteRef} ${ZERO_SHA}\n`;
}

function runHook(input: string, overrides: Record<string, string> = {}) {
  return spawnSync(SH, [HOOK_PATH], {
    cwd: harness.repo,
    encoding: 'utf8',
    input,
    env: cliSpawnEnv({
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

  it('runs the full suite bound to the pushed commit on a dev push', () => {
    const result = runHook(pushLine('refs/heads/dev', DEV_SHA));

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('full suite green');

    const argv = requireRunnerArgv();
    expect(argAfter(argv, '--scope')).toBe('full');
    expect(argv).toContain('--strict-git-env');
    // The gate must evidence the pushed commit, not whichever tree it ran in.
    expect(argAfter(argv, '--gate-commit')).toBe(DEV_SHA);
    expect(realpathSync(argAfter(argv, '--project-root') ?? '')).toBe(
      realpathSync(harness.repo),
    );
  });

  it('gates main pushes as well as dev pushes', () => {
    const result = runHook(pushLine('refs/heads/main', DEV_SHA));

    expect(result.status).toBe(0);
    expect(argAfter(requireRunnerArgv(), '--gate-commit')).toBe(DEV_SHA);
  });

  it('blocks the push when the suite is red', () => {
    const result = runHook(pushLine('refs/heads/dev', DEV_SHA), {
      STUB_RUNNER_EXIT: '1',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Full test suite failed');
    expect(result.stderr).toContain(`gated commit: ${DEV_SHA}`);
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

  it('refuses a push that carries two different dev commits', () => {
    const input =
      pushLine('refs/heads/dev', DEV_SHA, 'refs/heads/wl-a') +
      pushLine('refs/heads/dev', OTHER_SHA, 'refs/heads/wl-b');

    const result = runHook(input);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('several pushed commits');
    expect(runnerArgv()).toBeNull();
  });

  it('still gates a deletion push (all-zero sha) without a commit subject', () => {
    const result = runHook(pushLine('refs/heads/dev', ZERO_SHA));

    expect(result.status).toBe(0);
    const argv = requireRunnerArgv();
    expect(argAfter(argv, '--scope')).toBe('full');
    expect(argv).not.toContain('--gate-commit');
  });
});
