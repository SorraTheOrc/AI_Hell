# Style matching from telemetry

> Status: delivered by AH-0MUY08XXN003NV0I (child 9 of epic
> AH-0MUY089KR003F8S4). Source: [`src/ai/style/`](../src/ai/style). Feature
> extraction builds on the dev recording analysis
> ([`scripts/recording-analysis.mjs`](../scripts/recording-analysis.mjs)) and
> the competent bot framework ([`docs/BOT_FRAMEWORK.md`](./BOT_FRAMEWORK.md)).

Style matching turns a recorded human run into a bot that **plays like that
human**, while staying the shipped, safety-checked structured bot. There are
two paths, and the ordering matters:

1. **Parameter fitting (preferred).** Extract a small style profile from the
   recording and map it onto the structured bot's tunables. The bot is still
   the competent bot — only its knobs move — so every safety guarantee
   (never-suicide, priority order, committed selection) is untouched.
2. **Behaviour cloning (optional stretch).** Learn a policy directly from the
   recording's `(state → input)` pairs and replay the nearest recorded action.
   This is a coarse baseline, not a full-fidelity clone.

Both paths are pure and deterministic: the same recording always yields the
same profile / dataset / report.

## Quick start

```ts
import {
  extractStyleFeatures, // 1. profile the human
  fitStyle,             // 2. fit the structured bot to it
  createImitationPolicy,
  trainImitationPolicy, // 3. (optional) clone the recorded actions
  evaluateStyleMatch,   // 4. A/B the styled bot on the human's seed
} from './ai/style';

// 1. Extract a comparable style profile.
const features = extractStyleFeatures(humanRun);

// 2. Fit the structured bot's tunables (safety-checked).
const fit = fitStyle(features);
const styledBot = createCompetentBotBrain({ tunables: fit.tunables });
// ...and give the input governor `fit.humanInput`.

// 3. (Optional) behaviour cloning.
const imitation = createImitationPolicy(trainImitationPolicy(humanRun));

// 4. Evaluate: is the styled bot closer to the human, without losing
//    competence? The report is printed for a human reader.
const report = evaluateStyleMatch(humanRun, { ticks: 1800 });
console.log(report.closer, report.regressed);
```

## How it works

The pipeline is four small, pure stages:

| Stage | Module | What it does |
|---|---|---|
| Extract | `src/ai/style/features.ts` | One recording → a `StyleFeatures` vector. |
| Fit | `src/ai/style/fitting.ts` | `StyleFeatures` → structured-bot + governor tunables. |
| Clone (optional) | `src/ai/style/imitation.ts` | Recording → nearest-neighbour `(state → input)` policy. |
| Evaluate | `src/ai/style/evaluation.ts` | Human vs default vs styled, same seed, with a distance metric. |

The feature vector is deliberately small and interpretable:

| Feature | Human-style meaning |
|---|---|
| reaction latency | how quickly the player responds to incoming fire |
| key-hold distribution | how long each input key is held (cadence) |
| target preferences | which of minerals / power-ups / enemies they chase |
| engagement distances | how close they get before shooting or collecting |
| risk appetite | how much danger they accept (dodges vs hits, proximity) |

Every raw statistic is delegated to the existing dev-tooling analyser, so a
recorded human game and a headless bot run are measured by **exactly the same
code** — there is no second, divergent implementation. The extraction reads no
wall clock and performs no I/O.

## Feature extraction

```ts
const features = extractStyleFeatures(humanRun);
// or reuse a precomputed analysis:
const features2 = extractStyleFeatures(analyseRecording(humanRun));
```

`extractStyleFeatures` accepts either a raw `RecordingRun` (analysed on the
fly) or a precomputed `RecordingAnalysis`. Features that the recording does not
sample are returned as `null` (never invented) so downstream stages can warn
and keep a safe default.

## Parameter fitting

`fitStyle(features)` maps each feature onto the structured bot's knobs:

| Feature | Knob(s) |
|---|---|
| reaction latency | `humanInput.reactionTimeMs`, `commitment.minCommitSeconds`, `firePredictionHorizon` |
| key-hold distribution | `humanInput.thrustPressMinMs` / `MaxMs` / `MaxMsLong` |
| target preferences | objective priority bands (`mineralBase`, `powerUpBase`, `enemyBase`) |
| engagement distances | `engagementRange`, `firePredictionHorizon` |
| risk appetite | `dangerMargin`, `wallMargin`, `survivalUrgencyPort` |

Fitting is **clamped**: reaction time, hold timing, stand-off and margins are
all bounded to sane envelopes, so an extreme or malformed recording cannot
produce a degenerate bot.

### Safety guarantees

Fitting never weakens the bot's safety model. `enforceSafety()` re-establishes
and validates the invariants on **every** fit:

- the fixed priority order (minerals > power-ups > enemies > asteroids) is
  re-imposed with a gap, so no lower band can ever outrank a higher one;
- the survival band is forced strictly above the top objective band by a clear
  margin; and
- the steering safety filter itself — the actual never-suicide guarantee — is
  never touched.

A `StyleFit` also carries `applied` (the knobs the fit set, with the feature
that drove each) and `warnings` (e.g. an unsampled feature left at its
default) so a fit is auditable.

## Behaviour cloning (optional)

The stretch path learns a policy from `(state → input)` pairs:

```ts
const dataset = trainImitationPolicy(humanRun); // deterministic
const policy = createImitationPolicy(dataset);
```

Each recorded tick becomes a fixed-length feature vector (relative geometry to
the nearest collectable, hostile and incoming shot, plus the player's
velocity) paired with the movement action the player took. The policy is a
1-nearest-neighbour lookup over those pairs, replaying the recorded heading and
thrust through the human-like input governor.

> **Limitation.** This is a coarse clone: it does not model enemies'
> behaviours, holds no memory, and cannot exceed the coverage of the states it
> was trained on. Full-fidelity cloning is out of scope for the epic; the
> clone exists as a same-seed baseline for the structured bot.

## Evaluation

`evaluateStyleMatch(humanRun)` runs the **default** structured bot and the
**fitted** (styled) bot on the human recording's own seed — the same-seed
evaluation harness, so scenario variance cancels — and measures, for each:

- the `styleDistance` between the bot's play and the human's play (lower is
  closer), and
- the competence metrics (objective score, survival seconds) from the harness.

The report states:

| Field | Meaning |
|---|---|
| `closer` | Whether the styled bot is strictly closer to the human. |
| `distanceImprovement` | `structured.distance - styled.distance` (positive = better). |
| `competenceDelta` | Styled objective score minus the structured score. |
| `survivalDelta` | Styled survival seconds minus the structured survival. |
| `regressed` | Whether competence/survival dropped beyond the tolerance. |
| `fit` | The fitted tunables, applied knobs and warnings. |

`formatStyleMatchReport(report)` renders the same information as text.

The distance is the weighted, scale-normalised sum of the per-feature
differences. It is deliberately simple and interpretable — no learned metric —
so the report can show **which** feature moved. It is a directional tuning
signal, not a perceptual model. Every component is skipped when either side
lacks a sample, so a featureless run never manufactures a difference.

## Reproducibility

Everything in the pipeline is a pure function of the recording and the seed:
feature extraction, fitting, training and evaluation are all deterministic.
The same human recording always produces a byte-identical `StyleMatchReport`.
Because the styled and default bots run on the human's seed, any difference in
the report comes from the policy, not the scenario.

## References

- Work item: **AH-0MUY08XXN003NV0I** (child 9 of epic **AH-0MUY089KR003F8S4**).
- Recording/analysis tooling: `scripts/recording.mjs`,
  `scripts/recording-analysis.mjs`.
- Competent bot and tunables: [`docs/BOT_FRAMEWORK.md`](./BOT_FRAMEWORK.md),
  `src/ai/framework/competent/tunables.ts`.
- Same-seed evaluation harness: [`docs/EVALUATION.md`](./EVALUATION.md).
