# Test-suite timing measurement procedure

> Child AH-0MVF6XLBQ002GYWQ of the *Reduce full test-suite wall clock* epic
> (AH-0MVF3BESP005ZDAV). Every timing claim anywhere in that epic is made
> through this procedure so the numbers are reproducible and honestly
> load-labelled.

## Why this exists

The cached sanctioned full-suite runs spread 262 s → 415 s (~58 %) purely
with host-load: several agents sharing a 16-core host run suites
concurrently, and each run spawns fork workers over the shared
`node_modules`. **A wall-clock number without its load conditions is
meaningless** — the epic's AC3/AC5 comparisons are only valid when taken
under the same (ideally idle) load and recorded alongside the numbers.

## Run verification suites in an isolated worktree, never in the shared main checkout

A full-suite result is only trustworthy if the checkout did **not** move while
the suite ran. The shared main checkout *does* move: another session's
`implement.py finish` fast-forwards its local `dev` ref (and working tree)
straight after that session pushes. A run that spans such a fast-forward loads
the post-change test file against the pre-change source module (or the reverse)
and can report failures against a commit that never existed.

Observed (AH-0MVVE2QFP002HSUD, 2026-10-30): a `--scope full` run started in the
main checkout at `147f4991` (19:47:49Z) and was fast-forwarded to `40314aeb`
mid-run. It reported 4 failures in `src/utils/bulletVisuals.test.ts` — the
strengthened-shard assertions added by `40314aeb` run against the pre-change
`bulletVisuals.ts` — and minted the critical `test-failure` item
AH-0MVVE2QFP002HSUD. Re-running the same suite in a clean worktree at
`40314aeb` was green (355 files / 8,191 tests).

Framework-side detection of this mixed state (`state_changed_during_run`,
never cached, never triaged) is tracked in `SA-0MVL2NH1G0094FA2` (from
AH-0MVSRO0MM004T450). Until that ships in the installed skill tree, the
operational rule is:

- Run verification suites (any run whose result you will trust or cache) from
the work item's worktree under `.worklog/worktrees/`, not from the shared main
checkout.
- Treat a red result whose failing test file is newer than the source it
exercises — or whose run started and finished on different commits — as a
**mixed-state** artefact, not a defect: re-run from a clean worktree before
triaging or filing a `test-failure` item.

## Current state (post-split, deterministic boot default)

Since child AH-0MVF6XQIC005RY3P the harness boots **deterministically by
default** (no opt-in flag): `bootScene()` / `bootCombat()` advance the scene by
fixed-delta `game.step` calls instead of a `setTimeout(150)` wall-clock sleep,
and the legacy real-time path is deleted (guarded by
`src/test/deterministicBootGuard.test.ts`). Since AH-0MVF6VZG9000AN6E heavy
suites may share one `Phaser.Game` shell per file via `createReusableBoot()`.
The suite is split (AH-0MVF6XV87001NSEJ) into `unit` (node env, no DOM/Phaser
inline; the fast TDD loop) and `integration` (happy-dom + `src/test/setup.ts` +
`deps.inline: ['phaser']`); the typed run commands below are registered as
project test types in `.pi/skills_extensions/test/extension.json`
(`unit`/`coverage`/`e2e`), while `--type full` falls back to
`npm --silent test`.

Expectation summary (each figure carries its load; the full rows live on the
epic AH-0MVF3BESP005ZDAV and its final validation child AH-0MVF6W8NC006RT2B):

- **`unit`** — measured **43.5 s** (140 files, 2,497 tests) at load
  26.5/27.4/24.0, **83–101 s** (141 files, 2,517 tests) at load 24–44. The
  former "≤ 60 s on an idle host" target was **dropped by the producer
  (2026-10-20)**: the host is shared, an idle window is not obtainable on
  demand, and the fast loop's *relative* win (seconds, not minutes) is what
  matters. Report the measured figure with its load; do not chase a target.
- **`integration`** — ~250–350 s *loaded*; transform/import dominate (the
  Phaser bundle re-transform per worker; pool/isolate/optimiser experiments
  were measured and rejected — see `vitest.config.ts`).
- **full `npm --silent test`** — measured **346.56 / 370.75 / 408.96 s**
  (280 files, 6,137 tests) at load 12.7–24.7 in the final validation, against
  a pre-epic baseline of 262–415 s (median 314 s). Load alone moves this span
  ~58 %; never compare runs taken under different loads.

### What the suite is expected to cost now (restated target)

The epic's original target — *full suite ≤ 50 % of the 314 s baseline, i.e.
≤ ~150 s* — was **evaluated and redefined by the producer (2026-10-20,
option (a))**. Every lever available under the epic's constraints was used or
measured negative: deterministic boot (C2), the project split (C3), `scripts/`
bounding plus gating the real-ffmpeg promo smoke out of the default suite
(C5/AH-0MVFSNO0G00035AP), removal of all wall-clock waits (C6, completed by AH-0MVFPMT4P005UHZL), per-describe
boot reuse (C7, −17 % of the adopted suites' test phase) and the Phaser
transform experiment (C4, **rejected**: `isolate: false` breaks 78 files /
1,202 tests; `pool: 'threads'` and the optimiser variant are slower). The
remaining cost is the per-file Phaser transform/import under `isolate: true`
(summed `import` 674–789 s per run), which cannot be removed without either
losing test isolation or taking heavy work out of the audit-accepted suite.

The expectation is therefore **qualitative and enforced by tests, not by a
wall-clock number**:

1. **No wall-clock waiting in tests.** Zero `setTimeout`-based boot delays and
   zero wall-clock waits remain; any new one fails
   `src/test/deterministicBootGuard.test.ts` or
   `src/test/wallClockWaitGuard.test.ts` (its allow-list is empty).
2. **Deterministic and repeatable.** Boot is fixed-delta by default; runs pass
   under load without retries. Tests whose *assertions* legitimately take
   seconds of real computation declare an explicit per-file timing budget with
   `vi.setConfig({ testTimeout: … })` instead of inheriting Vitest's 5 s
   default — an inherited default turns shared-host load into a timeout
   failure (see [Per-file timing budgets](#per-file-timing-budgets)).
3. **The default suite excludes real-binary work** (the ~140 s ffmpeg promo
   compile lives in the gated `e2e` type), so the feedback loop pays only for
   assertion work plus the unavoidable Phaser transform.
4. **The fast loop stays sub-minute on a quiet host** (`unit`, ≈43 s measured);
   under shared-host load it degrades with load like everything else, and the
   measured figure is reported with its load rather than against a target.

A future change that wants to halve the wall clock must first take a
producer-authorised scope decision (see the closed item AH-0MVGRR51H008WP2N for
the measured trade-offs of each option).

## The load snapshot

Run before (and, for long runs, after) every measured suite:

```bash
uptime
# or, with the measurement script:
node scripts/measure-suite-timing.mjs --no-run
```

Record the 1/5/15-minute load averages and the CPU count. Target conditions:

- **idle host**: 1-minute load average < 4 on this 16-core host (per the
  epic's resume guidance).
- Any run taken at higher load must be labelled `loaded` and is *not* a
  baseline-valid measurement.

## The measurement commands

1. **Audit-accepted full-suite evidence (always this for gate claims):**

   ```bash
   python3 ~/.pi/agent/skills/test/scripts/run_tests.py --scope full --force
   ```

   This runs through the test skill (the sanctioned route, populates the
   per-repo cache that audits consume). The wall-clock + per-phase figures
   come from the run's cache entry:

   ```bash
   node scripts/measure-suite-timing.mjs --no-run --cache-dir .worklog/cache
   ```

2. **Measured run with load label (timing experiments only):**

   ```bash
   node scripts/measure-suite-timing.mjs                      # default: npm --silent test
   node scripts/measure-suite-timing.mjs --command "<cmd>"    # e.g. a project-scoped run
   node scripts/measure-suite-timing.mjs --json               # machine-readable
   ```

   The script times the command, parses vitest's
   `Test Files / Tests / Duration (transform … environment)` summary and
   prints it next to the load snapshot. It never writes to the repo and is
   not collected as a test.

3. **Unit project fast loop (AH-0MVF6XV87001NSEJ):**

   ```bash
   npm run test:unit                                 # raw: npx vitest run --project unit
   python3 ~/.pi/agent/skills/test/scripts/run_tests.py --type unit --force
   # heavy project alone (Phaser/DOM suites):
   npm run test:integration
   # coverage thresholds (registered as a project test type):
   python3 ~/.pi/agent/skills/test/scripts/run_tests.py --type coverage --force
   ```

   `--type unit`/`--type coverage` use independent cache keys and never
   masquerade as full-suite evidence (parent AC6). The full suite still runs
   the `unit` + `integration` projects (`npm --silent test`), so timings for
   "the suite" remain directly comparable with the baseline rows.

4. **Gated end-to-end suites (not part of the full suite):**

   ```bash
   npm run test:e2e                                   # npx vitest run --project e2e
   python3 ~/.pi/agent/skills/test/scripts/run_tests.py --type e2e --force
   ```

   `*.e2e.test.ts` files run **only** in the `e2e` project (real ffmpeg/ffprobe
   work, ~140 s for the promo compile). They are excluded from `--type full`
   by design (AH-0MVFSNO0G00035AP), so a full-suite timing **excludes** them —
   state which run you are reporting (full vs e2e) whenever you quote a number.

> **Exception note:** item-level timed runs of step 2 invoke `npm test`
> directly. This is the epic's documented "measurement command" exception;
> verification/evidence runs always go through step 1.

## Per-file boot reuse (AH-0MVF6VZG9000AN6E)

Heavy Phaser suites can share one `Phaser.Game` shell for the whole file and
reboot into fresh scene instances per test via `createReusableBoot()`
(`src/test/gameHarness.ts`). Measure a reuse change by running the same file set
on the pre-change tree and the changed tree **under the same load**, comparing
the vitest `tests` phase and per-file test sums (the boot cost lives there), not
just the wall clock — transform/import dominate the wall clock and swamp the
saving.

Measured adoption (four gym suites, concurrent baseline/after runs at load
~33 on 16 cpus): test phase 34.9 s → 28.7 s (**−17 %**); wall clock 52.0 s →
49.6 s (−4 %). Per-boot medians on the same host: fresh 21–78 ms vs reused
11–75 ms (the saving is the removed game construction/destroy; scene
`create()` still runs).

## Per-file timing budgets

Vitest's default `testTimeout` is 5 000 ms and `vitest.config.ts` deliberately
sets no global override, so most tests keep that tight budget. A test whose
assertions are seconds of real computation — the eval-arena batch tests are the
main case (`src/ai/eval/cli.test.ts`, `src/ai/eval/engine.test.ts`, which run a
campaign batch resolving to `DEFAULT_BATCH_TICKS` = 18 000 and a ~100-game
sweep, and `src/ai/eval/arena.test.ts`, whose per-level campaign tests run
four full headless 600-tick arena simulations and stringify every record
stream) — **must declare its own budget** at the top of its file:

```ts
import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30000 });
```

Why: those two files failed the full suite three times on 2026-10-27 at
5.5–6.5 s per test — just past the 5 s default, under shared-host load, with no
assertion failure at all (AH-0MVR8QM89004OQZQ, recurring after
AH-0MVPJETJF009E0S8 was closed as a load-induced flake). The budget is a
*bound*, not a target: 30 s gives ~5x headroom over the observed worst case
while still failing a genuine hang. Do **not** "fix" such a failure by
reducing the work in the test, and do not raise the global default — a global
budget loosens every fast test in the suite.

`src/ai/eval/arena.test.ts` joined the same budget on 2026-10-28 with observed
symptom `Test timed out in 5000ms` (AH-0MVSGJ5N6005U7P6) — the env-arena
member of the environmental-saturation family (AH-0MVSBEIVK003XAFB lineage,
see `src/test/wallClockWaitGuard.test.ts`). Its four 600-tick runs and full
record-stream stringifications were already pinned GREEN and unchanged; the
budget is the only change.

### Subprocess-spawn tests

The same reasoning applies to tests whose work is a **real child process**
(`spawnSync` / `execFileSync` of a `scripts/*.mjs` CLI). Those are not slow
assertions, but under a saturated shared host the child's module graph (the
Vite-SSR loader, Playwright) can take longer to load than the 5 s default, so
the test is killed mid-spawn with a misleading "Test timed out" and no
assertion failure. Declare the budget **per test** (not per file, so the plain
unit tests in the same file keep the tight 5 s default), and keep the child's
own `spawnSync` timeout as the real fail-fast contract:

```ts
it('spawns the real CLI and fails fast', { timeout: 60_000 }, () => {
  const result = spawnSync(process.execPath, [script, '--config', 'missing.json'], {
    encoding: 'utf8',
    timeout: 30_000, // the behavioural bound: exceeding it is a failure
    env: cliSpawnEnv(),
  });
  if (result.error) throw new Error(`spawn failed: ${result.error.message}`);
  expect(result.status).toBe(1);
});
```

Observed cases: the two spawned-CLI tests in
`scripts/capture-gameplay.test.ts` (`--list-scenarios` — AH-0MVE112BV006EDSZ /
AH-0MVE466JU001HR8T; bad-config fail-fast — AH-0MVSAPI66009T6PU, recorded
5 889 ms against the 5 s default) and `scripts/recording-cli.test.ts`, whose
real-entry-point spawns declare `15_000` per test. On an idle host the bad
config child exits in ~1.1 s, so the budget costs nothing in the normal case.
Do not reduce the per-test timeout to "make it fast", and keep the child
bound (30 s) small enough that a genuine hang still fails.

## Recording format

One table row per measured run, in a work-item comment on the epic
(AH-0MVF3BESP005ZDAV):

| Date | Command/scope | Wall clock | Phases (transform/setup/import/tests/environment, worker-summed) | Files | Tests | Load 1/5/15 | Exit |
|------|---------------|-----------:|-----------------------------------------------------------------|------:|------:|-------------|-----:|

Include the `cache_entry` dir for traceability. The phase figures are
summed across parallel workers so they exceed wall clock; they diagnose
*where* time goes, they are not the elapsed time.

## FAQs

- **Why do the phase sums exceed the wall clock?** Workers run in parallel;
  vitest reports per-worker sums.
- **Can I compare a loaded run with an idle run?** No. Re-measure under the
  target condition or the 58 % spread invalidates the comparison.
- **No `npm test` tweaks?** The suite entry point stays `npm test`; the
  script only *measures* it.
