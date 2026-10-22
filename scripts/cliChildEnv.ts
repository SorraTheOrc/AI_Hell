/**
 * Sanitised environment for spawning a real CLI child process from a test.
 *
 * Vitest's fork workers export `NODE_CHANNEL_FD` (the worker's IPC channel
 * number) and keep a descriptor open on that number for the worker's
 * lifetime. A child spawned from a test with `execFileSync`/`spawnSync`
 * inherits both by default — Node then tries to treat the (worker-owned)
 * descriptor as its own IPC channel and the child process aborts (SIGABRT)
 * at startup or exit. Under the full suite that made every child-spawning
 * CLI test (capture-gameplay, recording-cli, …) fail intermittently.
 *
 * Spread `cliSpawnEnv()` into a spawn's `env` (merging any per-call
 * overrides) so the child starts clean.
 */
export function cliSpawnEnv(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The worker's IPC channel is meaningless to a freshly spawned CLI and its
  // descriptor is not valid for the child — dropping it is mandatory.
  delete env.NODE_CHANNEL_FD;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
