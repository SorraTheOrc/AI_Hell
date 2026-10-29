# Human-experience validation

> Status: delivered by
> **Periodically validate the human experience against the intended experience**
> (AH-0MV7WVHU0000U775). Source:
> [`src/ai/eval/experienceTargets.ts`](../src/ai/eval/experienceTargets.ts),
> CLI: [`scripts/validate-experience.mjs`](../scripts/validate-experience.mjs),
> targets: [`src/data/experience-targets.json`](../src/data/experience-targets.json).
> Builds on the automated-balancing batch
> ([`docs/BALANCING.md`](./BALANCING.md)) and the human-play statistics it
> documents ([`policy: 'human'`](./BALANCING.md#human-play-statistics-policy-human)).

Balancing evidence records **what the game did**. This workflow records **what
it is supposed to do** — as a versioned, machine-checkable targets artifact —
and then periodically checks the measured experience (human **or** bot) against
those targets, so drift is a reviewed fact rather than a remembered feeling.

## The intended-experience targets

The operator decision recorded on the work item was: **derive the intended
experience from a bot batch and update the GDD to match.** Concretely:

- a bot batch (`npm run evaluate -- --batch`) produces a `BalanceAggregate`;
- each tracked metric's baseline **mean** becomes the band **centre**, and its
  tolerance comes from the documented rule below;
- the result is committed as [`src/data/experience-targets.json`](../src/data/experience-targets.json)
  — the single machine-checkable statement of intended experience;
- [`docs/Game Design Document.md`](./Game%20Design%20Document.md) §2.7 states
  the same experience in prose, so the narrative and the artifact agree.

### The committed baseline (targets v1)

| Field | Value |
|---|---|
| Baseline batch | 100 deterministic games, competent policy, seeds 1–100 |
| Mode | full shipped campaign (batch default) |
| Tick budget | 18 000 per game (5 simulated min at 60 Hz) |
| State sampling | every 5th tick (`--sample-every 5`; events, and so every metric, are recorded every tick) |
| Recorded on | the `dev` tree at commit `dc47d782` |
| Balance schema | `BALANCE_STATISTICS_SCHEMA_VERSION` 1 |
| Targets version | `targetsVersion` 1, artifact `schemaVersion` 1 |

### The bands

`upgradesSelected` is a per-key map in the shared schema; it is projected as
**mean upgrade selections per run** (the sum of the per-key means).

| Metric | Baseline mean | Baseline std-dev | Target band (centre ± tolerance) |
|---|---|---|---|
| `survivalSeconds` | 300.00 | 0.00 | 300.00 ± 30.00 → 270.00 – 330.00 |
| `mineralsCollected` | 18.00 | 0.00 | 18.00 ± 1.80 → 16.20 – 19.80 |
| `upgradesSelected` | 2.00 (per run) | — (per-key map) | 2.00 ± 0.50 → 1.50 – 2.50 |
| `waveReached` | 6.46 | 2.48 | 6.46 ± 4.96 → 1.50 – 11.42 |
| `levelReached` | 1.15 | 0.36 | 1.15 ± 0.71 → 0.44 – 1.86 |
| `avoidableHits` | 0.00 | 0.00 | 0.00 ± 0.50 → −0.50 – 0.50 |

### The tolerance rule

```
tolerance = max(2 × baseline stdDev, 10 % of |centre|, 0.5)
```

`upgradesSelected` uses `max(25 % of |centre|, 0.5)` instead, because the
per-key map has no single baseline std-dev. Bands are recorded to four decimal
places. The rule is stored **inside** the artifact (`toleranceRule` and
`toleranceRuleText`), so a later reader never has to reconstruct it.

The rule is a compromise between the two failure modes called out on the work
item: a tight band makes every noisy run a false alarm, a loose band hides a
real regression. Two std-devs of the recorded bot batch is the narrowest band
that still contains ~95 % of the baseline's own runs; the 10 % relative floor
keeps a band meaningful when the baseline is degenerate (std-dev 0), and the
0.5 floor stops a metric that is always 0 from having a zero-width band.

### Degenerate baseline metrics (read this before acting on a drift)

The recorded baseline is **directional evidence, not a design ideal**. Three of
its metrics are degenerate because the competent bot stalls at the tick budget
in a cleared wave rather than dying:

- `survivalSeconds` is exactly 300 s (the tick budget) for all 100 games —
  its band therefore says "runs last about five simulated minutes", not "a
  human should survive five minutes".
- `avoidableHits` is 0 for all 100 games — the band admits at most half a hit
  per run, so a human run that takes a single hit reports drift. That is a
  **prompt to investigate**, not a bug.
- `mineralsCollected` is 18 for all 100 games — its 10 % floor gives a ±1.8
  band.

A human report will therefore drift on survival and hits long before the bot
does. That is expected and is the "target inflation" risk recorded on the work
item: a green **bot** run only proves the baseline has not moved; judging the
human experience needs the human report. When the producer decides the recorded
standard no longer describes the intended experience, **re-baseline** (below)
rather than reading a drift as a defect.

### Re-baselining

The artifact is **generated, not hand-written**. After an intended change to
the experience (a deliberate tuning pass, a new content drop, a new bot
baseline), re-derive it from a fresh batch:

```bash
# record the new baseline batch (writes balance-report.json)
npm run evaluate -- --batch --games 100 --sample-every 5 --out eval-output/experience-baseline

# re-derive the committed artifact (bumps targetsVersion automatically)
npm run validate-experience -- --baseline eval-output/experience-baseline/balance-report.json
```

The derivation is pure and deterministic: the same baseline report + rule
yields a byte-identical artifact, and the command bumps `targetsVersion` by one
so a validation report always says which standard it was judged against. A
**human** report is rejected as a `--baseline` (exit 2): a human report measures
the experience, it does not define the intended one. Record
*why* the baseline changed on the work item for the change; the artifact alone
cannot explain intent.

## Running the validation

Any measured `BalanceReport` (`kind: 'balance'`) can be validated:

```bash
# a recorded human session — npm run record writes balance-stats.json
# next to the .jsonl recording, in the shared BalanceReport shape
npm run validate-experience -- recordings/balance-stats.json

# a fresh bot batch — catches a regression in the balance baseline itself
npm run evaluate -- --batch --games 100 --out eval-output
npm run validate-experience -- eval-output/balance-report.json

# machine-readable output instead of the Markdown summary
npm run validate-experience -- recordings/balance-stats.json --json
```

### Flags

| Flag | Meaning | Default |
|---|---|---|
| `<balance-report.json>` | The measured report to validate (positional). | — |
| `--targets <file>` | Targets artifact to judge against. | `src/data/experience-targets.json` |
| `--out <dir>` | Artifact output directory. | `experience-out` (git-ignored) |
| `--json` | Print the JSON report instead of the Markdown summary. | Markdown |
| `--baseline <file>` | **Re-baseline mode:** derive the targets from this bot batch report instead of validating. | off |
| `--targets-out <file>` | Where re-baseline writes the artifact. | `src/data/experience-targets.json` |
| `--targets-version <n>` | `targetsVersion` for the derived artifact. | next after the current file (or 1) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Every tracked metric was measured and in band (or the targets were derived). |
| `1` | **Drift** — at least one metric is outside its band. |
| `2` | Usage error, unreadable/invalid JSON, a non-`balance` report or a malformed targets artifact. |

The non-zero drift exit is what makes the command usable as a scheduled gate:
nothing else in the repo needs to understand the numbers.

### Artifacts

| Artifact | Contents |
|---|---|
| `experience-validation.json` | The versioned report: `schemaVersion`, `targetsVersion`, `balanceSchemaVersion`, `datasetVersion`, the measured `source`, the `targetSource` baseline, the tolerance rule, per-metric measured/band/drift/verdict, `driftedMetrics`, `missingMetrics` and any comparability `warnings`. |
| `experience-validation.md` | The same result as a readable Markdown summary (printed to stdout). |

## Reading the report

Each tracked metric gets one row with a **verdict**:

| Verdict | Meaning |
|---|---|
| `in-band` | The measured value sits inside the target band (the band edges are inclusive). |
| `above-band` | The measured value is above the upper edge; `drift` is positive. |
| `below-band` | The measured value is below the lower edge; `drift` is negative. |
| `missing` | The report carries no measurement for the metric (an absent distribution or one with no contributing runs). A missing metric **fails** the validation: an unmeasured experience cannot be confirmed to be in band. |

`drift` is signed (`measured − centre`) and `relativeDrift` is that drift as a
fraction of the band centre (`null` when the centre is 0). The measured source
is labelled in both artifacts — `human` for a recorded session, `bot:<policy>`
for a batch.

Example (the committed targets validated against the baseline batch itself —
the expected green case):

```
# Experience validation — bot:competent

- Targets: v1 (baseline: competent, 100 games, 18000 ticks, campaign=true)
- Measured: 100 run(s), balance schema v1
- Result: **PASS** (6/6 metrics in band)

| Metric | Measured | Target band | Drift | Verdict |
|---|---|---|---|---|
| survival (s) | 300.00 | 270.00 – 330.00 (±30.00) | 0.00 (0.0 %) | in-band |
| minerals collected | 18.00 | 16.20 – 19.80 (±1.80) | 0.00 (0.0 %) | in-band |
| upgrades selected / run | 2.00 | 1.50 – 2.50 (±0.50) | 0.00 (0.0 %) | in-band |
| wave reached | 6.46 | 1.50 – 11.42 (±4.96) | 0.00 (0.0 %) | in-band |
| level reached | 1.15 | 0.44 – 1.86 (±0.71) | 0.00 (0.0 %) | in-band |
| avoidable hits | 0.00 | -0.50 – 0.50 (±0.50) | 0.00 | in-band |
```

A bot report whose harness mode (campaign / level) differs from the baseline's
still validates, but carries a **warning** in the report and on stderr: the
bands were derived from a campaign batch, so a skirmish or different-level
batch is a directional check only. A human report has no harness mode and
never warns.

## Determinism and reproducibility

- The comparator, the derivation and both report builders are **pure**: no wall
  clock, no randomness, no I/O. The CLI shell is the only component that reads
  or writes files.
- Object keys are recursively sorted before serialisation, so the same measured
  report + targets yields **byte-identical** `experience-validation.json` and
  `experience-validation.md` (`diff` two runs, or read the tests).
- The same baseline + tolerance rule yields a byte-identical targets artifact,
  so a re-baseline diff shows exactly what changed.

## Scheduling (documented, not built)

This item deliberately adds **no CI infrastructure** — the repository has none
for scheduled jobs today. Wire the command into whatever scheduler the operator
already uses; the exit code is the contract.

```bash
# cron: validate the latest human report every Monday at 09:00
0 9 * * 1 cd /path/to/AI_Hell && \
  npm run validate-experience -- recordings/balance-stats.json --out reports/experience \
  >> /var/log/experience-validation.log 2>&1
```

```yaml
# CI job: on a schedule, rebuild the bot batch and validate it
- run: npm run evaluate -- --batch --games 100 --sample-every 5 --out eval-output
- run: npm run validate-experience -- eval-output/balance-report.json
```

Suggested cadence: validate a **fresh bot batch** on every release candidate (it
is cheap and catches a baseline regression), and a **human report** weekly while
tuning is active (or after each playtest session). Archive the JSON artifacts
beside the reports they judge — they are versioned pass/fail records, which is
what makes the experience reviewable over time.

## Tuning the intended experience

- **The bands are data.** Edit them by re-baselining, not by hand-editing the
  JSON: the artifact is regenerated deterministically and its `targetsVersion`
  bump keeps existing validation reports interpretable.
- **Loosen deliberately.** If a band produces repeated false alarms for a
  metric whose run-to-run variance is genuinely high, the honest fix is a
  wider rule (a larger `stdDevMultiplier` / `relativeFloor` in the derivation,
  recorded on the work item) or a better baseline — not a silently edited
  number. A hand-edited band is acceptable only with a `targetsVersion` bump
  and a stated reason; the schema test then still guarantees it validates.
- **Tighten after a fix.** Once a regression is fixed, re-baseline so the new
  behaviour becomes the recorded standard.
- The GDD (§2.7) must be updated in the same change whenever the numbers in
  the artifact move materially, so the prose and the artifact never disagree.

## Fidelity boundary and risks

- **The bot is a proxy.** The targets are derived from the headless arena
  documented in [`docs/BALANCING.md`](./BALANCING.md): no boss/mini-boss
  simulation, no VFX, no formation movement, no rendering. A human report is a
  real recorded game; the two are comparable on the shared statistics schema
  but are not the same experience.
- **Self-consistency is not quality.** Because the bot baseline defines the
  targets, the bot is trivially self-consistent: a green bot validation says
  "the baseline has not moved", never "the game is fun" or "the human
  experience is good". Only a human report makes the human-experience claim.
- **Drift is a prompt, not a verdict.** An out-of-band human result starts an
  investigation (is this a regression, a deliberate change, or a stale
  baseline?), it does not prove a bug.
- **Small-sample sensitivity.** Bands derived from a degenerate metric are
  narrow (see the degenerate-metrics note); a larger or more varied baseline —
  several policies, or human play once enough is recorded — produces more
  useful bands.

## Testing

- `src/ai/eval/experienceTargets.test.ts` — the committed artifact validates
  and covers every required metric; the derivation and tolerance rule; the
  comparator's in-band / above-band / below-band / boundary / missing-metric /
  empty-input cases; clock- and randomness-freedom; byte-stable JSON +
  Markdown.
- `scripts/validate-experience.test.ts` — the CLI shell: argument parsing,
  artifact writing, exit codes (0 / 1 / 2), source labelling, JSON mode and
  byte-identical repeat runs, plus the re-baseline mode and its version bump.
- `src/ai/eval/experienceTargets.ssr.test.ts` — the pure core loads through the
  same Vite SSR loader the CLI uses and validates the committed artifact.
- `src/ai/eval/experienceValidationDocs.test.ts` — this document's contract and
  the GDD/README cross-links.

## Related work

- **Automated Balancing** (AH-0MV1DLUZ8009OCJW) — the batch runner and the
  shared balance-statistics schema: [`docs/BALANCING.md`](./BALANCING.md).
- **Collect balance statistics from human player games (dev mode only)**
  (AH-0MV7WVEWL005XEMN) — the human `BalanceReport` this validation consumes.
- **Shared human balance-statistics helper** (AH-0MV8ISO4O002HHDT) —
  `src/ai/eval/humanStats.ts`.
- **Automate the balance-tuning loop** (AH-0MV8Q5EYE001R715) — the
  baseline → edit → re-run → compare loop for a *single tuning edit*; this
  document covers *periodic validation against a recorded standard*.
- Same-seed evaluation harness: [`docs/EVALUATION.md`](./EVALUATION.md).
- Telemetry schema: [`docs/TELEMETRY.md`](./TELEMETRY.md).
