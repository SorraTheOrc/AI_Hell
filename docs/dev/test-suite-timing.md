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
