/**
 * Offline analysis of a recorded human/bot run
 * (AH-0MUY08W7Y004GATZ, AC2 + AC5).
 *
 * Pure, clock-free statistics over one {@link import('./recording.mjs').RecordingRun}:
 * key-hold duration histograms, input-change cadence, a reaction-latency
 * proxy, target-choice tallies, engagement distances, dodge outcomes and
 * survival/minerals-per-minute. Every function takes its inputs and returns
 * plain JSON, so the whole analyser is unit-testable without a browser or a
 * game instance.
 *
 * It is plain ESM JavaScript (like `inspect-telemetry.mjs`) so the Node CLI
 * runs without a TypeScript loader; `recording-analysis.d.mts` supplies the
 * types used by the test suite.
 *
 * ## Proxies and their limits
 *
 * A recording is state + input + events sampled per tick, not a full physics
 * trace, so a few metrics are necessarily **proxies**, documented on each
 * result field:
 *
 * - *Reaction latency* is the time from an incoming threat entering
 *   {@link DEFAULT_THREAT_RADIUS_PX} to the player's next input change.
 * - *Target choice* is the category (mineral / power-up / enemy) most aligned
 *   with the player's velocity at a tick.
 * - *Dodge outcomes* pair each threat window (a burst of in-range enemy
 *   bullets) with whether a hit was recorded during it.
 *
 * All are directional tuning signals, not exact measurements.
 *
 * @module scripts/recording-analysis
 */

import {
  DEFAULT_TICK_SECONDS,
  distance,
  inputChannels,
  inputSignature,
  tickPosition,
} from './recording.mjs';

/** Friendly label for a recording with no recorded ticks. */
export const EMPTY_ANALYSIS_NOTE = 'No recorded ticks to analyse.';

/**
 * Key-hold duration buckets, in seconds (upper bound exclusive). The final
 * bucket is open-ended (`Infinity`).
 */
export const HOLD_DURATION_BUCKETS = Object.freeze([
  { label: '<0.1 s', maxSeconds: 0.1 },
  { label: '0.1–0.25 s', maxSeconds: 0.25 },
  { label: '0.25–0.5 s', maxSeconds: 0.5 },
  { label: '0.5–1 s', maxSeconds: 1 },
  { label: '1–2 s', maxSeconds: 2 },
  { label: '≥2 s', maxSeconds: Number.POSITIVE_INFINITY },
]);

/** Input-change gap buckets, in seconds (upper bound exclusive). */
export const INPUT_CADENCE_BUCKETS = Object.freeze([
  { label: '<0.05 s', maxSeconds: 0.05 },
  { label: '0.05–0.1 s', maxSeconds: 0.1 },
  { label: '0.1–0.25 s', maxSeconds: 0.25 },
  { label: '0.25–0.5 s', maxSeconds: 0.5 },
  { label: '0.5–1 s', maxSeconds: 1 },
  { label: '≥1 s', maxSeconds: Number.POSITIVE_INFINITY },
]);

/** Reaction-latency buckets, in seconds (upper bound exclusive). */
export const REACTION_LATENCY_BUCKETS = Object.freeze([
  { label: '<0.1 s', maxSeconds: 0.1 },
  { label: '0.1–0.25 s', maxSeconds: 0.25 },
  { label: '0.25–0.5 s', maxSeconds: 0.5 },
  { label: '0.5–1 s', maxSeconds: 1 },
  { label: '≥1 s', maxSeconds: Number.POSITIVE_INFINITY },
]);

/** Threat radius (px) for the reaction/dodge proxies (≈ 7 × ship size). */
export const DEFAULT_THREAT_RADIUS_PX = 140;

/** Player speed (px/s) below which a tick is treated as "no heading". */
export const DEFAULT_SPEED_EPSILON = 1;

/** Places `value` in the first bucket whose upper bound it is below. */
function bucketLabel(value, buckets) {
  for (const bucket of buckets) {
    if (value < bucket.maxSeconds) return bucket.label;
  }
  return buckets[buckets.length - 1].label;
}

/** Builds a zeroed histogram for `buckets` and fills it from `values`. */
function histogram(values, buckets) {
  const counts = new Map(buckets.map((bucket) => [bucket.label, 0]));
  for (const value of values) {
    const label = bucketLabel(value, buckets);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return buckets.map((bucket) => ({
    label: bucket.label,
    count: counts.get(bucket.label) ?? 0,
  }));
}

/** Summary statistics for a numeric list; all fields are `null` when empty. */
function stats(values) {
  const list = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b);
  if (list.length === 0) {
    return { count: 0, mean: null, median: null, min: null, max: null };
  }
  const total = list.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(list.length / 2);
  const median =
    list.length % 2 === 0 ? (list[middle - 1] + list[middle]) / 2 : list[middle];
  return {
    count: list.length,
    mean: total / list.length,
    median,
    min: list[0],
    max: list[list.length - 1],
  };
}

// ── State accessors (defensive: the payload is opaque to the framework) ──

/** The recorded player's full state (`x`,`y`,`vx`,`vy`), or `null`. */
function statePlayer(state) {
  if (typeof state !== 'object' || state === null) return null;
  const player = /** @type {Record<string, unknown>} */ (state).player;
  if (typeof player !== 'object' || player === null) return null;
  const value = /** @type {Record<string, unknown>} */ (player);
  if (
    !Number.isFinite(Number(value.x)) ||
    !Number.isFinite(Number(value.y)) ||
    !Number.isFinite(Number(value.vx)) ||
    !Number.isFinite(Number(value.vy))
  ) {
    return null;
  }
  return { x: Number(value.x), y: Number(value.y), vx: Number(value.vx), vy: Number(value.vy) };
}

/** Reads an array field from a recorded state, or `[]`. */
function stateArray(state, key) {
  if (typeof state !== 'object' || state === null) return [];
  const value = /** @type {Record<string, unknown>} */ (state)[key];
  return Array.isArray(value) ? value : [];
}

/** A finite `{ x, y }` from an arbitrary point-like value, or `null`. */
function asPoint(value) {
  if (typeof value !== 'object' || value === null) return null;
  const point = /** @type {Record<string, unknown>} */ (value);
  if (!Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
  return { x: Number(point.x), y: Number(point.y) };
}

/** The recorded mineral hold total at a tick (latest `state.hold.minerals`). */
function holdMinerals(state) {
  if (typeof state !== 'object' || state === null) return 0;
  const hold = /** @type {Record<string, unknown>} */ (state).hold;
  if (typeof hold !== 'object' || hold === null) return 0;
  const minerals = Number(/** @type {Record<string, unknown>} */ (hold).minerals);
  return Number.isFinite(minerals) ? minerals : 0;
}

// ── Metric computations ──────────────────────────────────────────────

/** Key-hold durations (AC2): per channel and overall, in seconds. */
function computeKeyHolds(ticks, dtSeconds) {
  /** @type {Map<string, number[]>} */
  const durations = new Map();
  /** @type {Map<string, { scheme: string, channel: string }>} */
  const open = new Map();
  const all = [];

  for (const entry of ticks) {
    const { scheme, channels } = inputChannels(entry.input);
    for (const channel of Object.keys(channels)) {
      const key = `${scheme}:${channel}`;
      if (channels[channel]) {
        const current = open.get(key);
        if (current) current.ticks += 1;
        else open.set(key, { scheme, channel, ticks: 1 });
      } else {
        const current = open.get(key);
        if (current) {
          const seconds = current.ticks * dtSeconds;
          if (!durations.has(key)) durations.set(key, []);
          durations.get(key).push(seconds);
          all.push(seconds);
          open.delete(key);
        }
      }
    }
    // A scheme switch closes any channel not present in the new scheme.
    for (const [key, current] of Array.from(open.entries())) {
      if (current.scheme !== scheme) {
        const seconds = current.ticks * dtSeconds;
        if (!durations.has(key)) durations.set(key, []);
        durations.get(key).push(seconds);
        all.push(seconds);
        open.delete(key);
      }
    }
  }
  for (const [key, current] of open.entries()) {
    const seconds = current.ticks * dtSeconds;
    if (!durations.has(key)) durations.set(key, []);
    durations.get(key).push(seconds);
    all.push(seconds);
  }

  const byChannel = {};
  for (const [key, values] of durations.entries()) {
    byChannel[key] = {
      count: values.length,
      meanSeconds: stats(values).mean,
      maxSeconds: stats(values).max,
      histogram: histogram(values, HOLD_DURATION_BUCKETS),
    };
  }

  return {
    byChannel,
    overall: {
      count: all.length,
      meanSeconds: stats(all).mean,
      histogram: histogram(all, HOLD_DURATION_BUCKETS),
    },
  };
}

/** Input-change cadence (AC2): intervals between successive changes. */
function computeInputCadence(ticks, dtSeconds) {
  const gaps = [];
  let changes = 0;
  let lastChangeTick = ticks.length > 0 ? ticks[0].tick : 0;
  let previousSignature = ticks.length > 0 ? inputSignature(ticks[0].input) : null;

  for (let i = 1; i < ticks.length; i += 1) {
    const entry = ticks[i];
    const signature = inputSignature(entry.input);
    if (signature !== previousSignature) {
      changes += 1;
      gaps.push((entry.tick - lastChangeTick) * dtSeconds);
      lastChangeTick = entry.tick;
      previousSignature = signature;
    }
  }

  const summary = stats(gaps);
  const firstTick = ticks.length > 0 ? ticks[0].tick : 0;
  const lastTick = ticks.length > 0 ? ticks[ticks.length - 1].tick : 0;
  const durationSeconds = ticks.length === 0 ? 0 : (lastTick - firstTick + 1) * dtSeconds;

  return {
    changes,
    changesPerSecond: durationSeconds > 0 ? changes / durationSeconds : 0,
    meanGapSeconds: summary.mean,
    medianGapSeconds: summary.median,
    histogram: histogram(gaps, INPUT_CADENCE_BUCKETS),
  };
}

/** Per-tick count of enemy bullets within `threatRadius` of the player. */
function threatCounts(ticks, threatRadius) {
  return ticks.map((entry) => {
    const player = tickPosition(entry.state);
    if (!player) return 0;
    let count = 0;
    for (const bullet of stateArray(entry.state, 'enemyBullets')) {
      const point = asPoint(bullet);
      if (point && distance(point, player) <= threatRadius) count += 1;
    }
    return count;
  });
}

/**
 * Contiguous threat windows: `[startTick, endTick]` where the in-radius
 * bullet count is non-zero.
 */
function threatWindows(ticks, threatRadius) {
  const counts = threatCounts(ticks, threatRadius);
  const windows = [];
  let start = -1;
  for (let i = 0; i < ticks.length; i += 1) {
    const active = counts[i] > 0;
    if (active && start < 0) start = i;
    if (!active && start >= 0) {
      windows.push({ startTick: ticks[start].tick, endTick: ticks[i - 1].tick });
      start = -1;
    }
  }
  if (start >= 0) {
    windows.push({ startTick: ticks[start].tick, endTick: ticks[ticks.length - 1].tick });
  }
  return windows;
}

/** Reaction latency proxy (AC2). */
function computeReactionLatency(ticks, dtSeconds, threatRadius) {
  const windows = threatWindows(ticks, threatRadius);
  const latencies = [];
  let noReactionCount = 0;

  for (const window of windows) {
    const startIndex = ticks.findIndex((entry) => entry.tick === window.startTick);
    if (startIndex < 0) continue;
    const startSignature = inputSignature(ticks[startIndex].input);
    let changeTick = null;
    for (let i = startIndex + 1; i < ticks.length; i += 1) {
      if (ticks[i].tick > window.endTick) break;
      if (inputSignature(ticks[i].input) !== startSignature) {
        changeTick = ticks[i].tick;
        break;
      }
    }
    if (changeTick === null) noReactionCount += 1;
    else latencies.push((changeTick - window.startTick) * dtSeconds);
  }

  const summary = stats(latencies);
  return {
    windows: windows.length,
    samples: latencies.length,
    noReactionCount,
    meanSeconds: summary.mean,
    medianSeconds: summary.median,
    histogram: histogram(latencies, REACTION_LATENCY_BUCKETS),
  };
}

/** Cosine alignment between the player's velocity and the vector to a target. */
function alignment(player, target) {
  const speed = Math.hypot(player.vx, player.vy);
  if (speed < DEFAULT_SPEED_EPSILON) return null;
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return 1;
  return (player.vx / speed) * (dx / length) + (player.vy / speed) * (dy / length);
}

/** Target-choice stats (AC2): the category most aligned with the velocity. */
function computeTargetChoice(ticks) {
  const counts = { mineral: 0, powerUp: 0, enemy: 0, none: 0 };
  let samples = 0;

  for (const entry of ticks) {
    const player = statePlayer(entry.state);
    if (!player) continue;
    samples += 1;

    const candidates = [
      { category: 'mineral', points: stateArray(entry.state, 'minerals') },
      { category: 'powerUp', points: stateArray(entry.state, 'drops') },
      {
        category: 'enemy',
        points: stateArray(entry.state, 'enemies').filter(
          (enemy) => asPoint(enemy) && /** @type {any} */ (enemy).alive !== false,
        ),
      },
    ];

    let best = null;
    for (const candidate of candidates) {
      const point = candidate.points.map(asPoint).find((value) => value !== null);
      if (!point) continue;
      const score = alignment(player, point);
      if (score === null) continue;
      if (best === null || score > best.score) best = { category: candidate.category, score };
    }

    if (best && best.score > 0) counts[best.category] += 1;
    else counts.none += 1;
  }

  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const rates = {};
  for (const key of Object.keys(counts)) rates[key] = total > 0 ? counts[key] / total : 0;

  return { counts, rates, samples };
}

/** Engagement distances (AC2): kill / pickup / mineral-collection ranges. */
function computeEngagementDistances(ticks, events) {
  /** The player position at the latest tick at or before `tick`. */
  const positionAt = (tick) => {
    let best = null;
    for (const entry of ticks) {
      if (entry.tick > tick) break;
      best = tickPosition(entry.state);
    }
    return best;
  };

  const lists = { enemy: [], powerUp: [], mineral: [] };

  for (const event of events) {
    const player = positionAt(event.tick);
    if (!player) continue;
    if (event.event === 'enemy_killed') {
      const point = asPoint(event.payload);
      if (point) lists.enemy.push(distance(player, point));
    } else if (event.event === 'mineral_collected') {
      const nearest = nearestDistance(
        player,
        stateArray(nearestState(ticks, event.tick), 'minerals'),
      );
      if (nearest !== null) lists.mineral.push(nearest);
    } else if (event.event === 'pickup') {
      const nearest = nearestDistance(
        player,
        stateArray(nearestState(ticks, event.tick), 'drops'),
      );
      if (nearest !== null) lists.powerUp.push(nearest);
    }
  }

  return {
    enemy: stats(lists.enemy),
    powerUp: stats(lists.powerUp),
    mineral: stats(lists.mineral),
  };
}

/** The recorded state at the latest tick at or before `tick`. */
function nearestState(ticks, tick) {
  let best = null;
  for (const entry of ticks) {
    if (entry.tick > tick) break;
    best = entry.state;
  }
  return best;
}

/** Distance to the nearest point in `points`, or `null` when none. */
function nearestDistance(player, points) {
  let best = null;
  for (const value of points) {
    const point = asPoint(value);
    if (!point) continue;
    const dist = distance(player, point);
    if (best === null || dist < best) best = dist;
  }
  return best;
}

/** Dodge outcomes (AC2): threat windows paired with recorded hits. */
function computeDodgeOutcomes(ticks, events, threatRadius) {
  const windows = threatWindows(ticks, threatRadius);
  const hitEvents = events.filter(
    (event) => event.event === 'player_hit' || event.event === 'player_hit_absorbed',
  );
  let hit = 0;
  let dodged = 0;
  for (const window of windows) {
    const wasHit = hitEvents.some(
      (event) => event.tick >= window.startTick && event.tick <= window.endTick,
    );
    if (wasHit) hit += 1;
    else dodged += 1;
  }
  return {
    windows: windows.length,
    dodged,
    hit,
    dodgeRate: windows.length === 0 ? 0 : dodged / windows.length,
  };
}

/** Run summary (AC2): survival, minerals and minerals-per-minute. */
function computeSummary(ticks, events, dtSeconds) {
  const firstTick = ticks.length > 0 ? ticks[0].tick : 0;
  const lastTick = ticks.length > 0 ? ticks[ticks.length - 1].tick : 0;
  const durationSeconds = ticks.length === 0 ? 0 : (lastTick - firstTick + 1) * dtSeconds;
  const minutes = durationSeconds / 60;

  let minerals = 0;
  for (const entry of ticks) minerals = Math.max(minerals, holdMinerals(entry.state));

  const eventCounts = {};
  for (const event of events) {
    eventCounts[event.event] = (eventCounts[event.event] ?? 0) + 1;
  }

  const runEnd = events.find((event) => event.event === 'run_end');

  return {
    ticks: ticks.length,
    firstTick,
    lastTick,
    durationSeconds,
    minutes,
    minerals,
    mineralsPerMinute: minutes > 0 ? minerals / minutes : 0,
    survived: (eventCounts.player_death ?? 0) === 0,
    won: typeof runEnd?.payload === 'object' && runEnd.payload !== null
      ? /** @type {any} */ (runEnd.payload).won === true
      : null,
    score:
      typeof runEnd?.payload === 'object' && runEnd.payload !== null
        ? Number(/** @type {any} */ (runEnd.payload).score) || 0
        : null,
    eventCounts,
  };
}

/**
 * Analyses one recorded run (AC2). Pure and deterministic.
 *
 * @param {import('./recording.mjs').RecordingRun} run
 * @param {{ dtSeconds?: number, threatRadiusPx?: number }} [options]
 * @returns {import('./recording-analysis.mjs').RecordingAnalysis}
 */
export function analyseRecording(run, options = {}) {
  const dtSeconds =
    Number.isFinite(Number(options.dtSeconds)) && Number(options.dtSeconds) > 0
      ? Number(options.dtSeconds)
      : DEFAULT_TICK_SECONDS;
  const threatRadius =
    Number.isFinite(Number(options.threatRadiusPx)) && Number(options.threatRadiusPx) > 0
      ? Number(options.threatRadiusPx)
      : DEFAULT_THREAT_RADIUS_PX;

  const ticks = Array.isArray(run?.ticks) ? run.ticks : [];
  const events = Array.isArray(run?.events) ? run.events : [];

  return {
    datasetVersion: run?.datasetVersion ?? null,
    runSeed: Number(run?.runSeed) >>> 0,
    build: run?.build ?? { appVersion: 'unknown', commit: 'unknown' },
    dtSeconds,
    threatRadiusPx: threatRadius,
    summary: computeSummary(ticks, events, dtSeconds),
    keyHolds: computeKeyHolds(ticks, dtSeconds),
    inputCadence: computeInputCadence(ticks, dtSeconds),
    reactionLatency: computeReactionLatency(ticks, dtSeconds, threatRadius),
    targetChoice: computeTargetChoice(ticks),
    engagementDistances: computeEngagementDistances(ticks, events),
    dodge: computeDodgeOutcomes(ticks, events, threatRadius),
  };
}

// ── Formatting ───────────────────────────────────────────────────────

/** Formats a number with a fixed precision, or `n/a` for `null`. */
function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

/** Formats a histogram as indented `label: count` lines. */
function formatHistogram(histogram, indent = '    ') {
  return histogram
    .map((bucket) => `${indent}${bucket.label}: ${bucket.count}`)
    .join('\n');
}

/** Formats the distance-stats groups as `category: count mean median max`. */
function formatDistance(label, group) {
  return `  ${label}: n=${group.count} mean=${formatNumber(group.mean, 1)} ` +
    `median=${formatNumber(group.median, 1)} max=${formatNumber(group.max, 1)}`;
}

/**
 * Renders an analysis as a human-readable text report (AC2).
 *
 * @param {import('./recording-analysis.mjs').RecordingAnalysis} report
 * @returns {string}
 */
export function formatAnalysis(report) {
  const summary = report.summary;
  const lines = [];
  lines.push('Recording analysis');
  lines.push('==================');
  lines.push(`Seed: ${report.runSeed}`);
  lines.push(`Build: ${report.build.appVersion}@${report.build.commit}`);
  lines.push(
    `Duration: ${formatNumber(summary.durationSeconds, 1)} s ` +
      `(${summary.ticks} ticks, ${formatNumber(summary.minutes, 2)} min)`,
  );
  lines.push(
    `Survival: ${summary.survived ? 'survived' : 'died'}` +
      (summary.won === null ? '' : `, ${summary.won ? 'victory' : 'defeat'}`) +
      (summary.score === null ? '' : `, score ${summary.score}`),
  );
  lines.push(
    `Minerals: ${formatNumber(summary.minerals, 1)} ` +
      `(${formatNumber(summary.mineralsPerMinute, 1)}/min)`,
  );

  lines.push('');
  lines.push('Key-hold duration histogram (overall)');
  lines.push(formatHistogram(report.keyHolds.overall.histogram));
  lines.push(`  holds: ${report.keyHolds.overall.count}, mean ${formatNumber(report.keyHolds.overall.meanSeconds, 3)} s`);
  const channels = Object.keys(report.keyHolds.byChannel).sort();
  for (const channel of channels) {
    const entry = report.keyHolds.byChannel[channel];
    lines.push(`  ${channel}: n=${entry.count} mean=${formatNumber(entry.meanSeconds, 3)} s`);
    lines.push(formatHistogram(entry.histogram, '      '));
  }

  lines.push('');
  lines.push('Input-change cadence');
  lines.push(
    `  changes: ${report.inputCadence.changes} ` +
      `(${formatNumber(report.inputCadence.changesPerSecond, 2)}/s), ` +
      `mean gap ${formatNumber(report.inputCadence.meanGapSeconds, 3)} s`,
  );
  lines.push(formatHistogram(report.inputCadence.histogram));

  lines.push('');
  lines.push('Reaction latency proxy');
  lines.push(
    `  windows: ${report.reactionLatency.windows}, ` +
      `reactions: ${report.reactionLatency.samples}, ` +
      `no-reaction: ${report.reactionLatency.noReactionCount}, ` +
      `mean ${formatNumber(report.reactionLatency.meanSeconds, 3)} s`,
  );
  lines.push(formatHistogram(report.reactionLatency.histogram));

  lines.push('');
  lines.push('Target choice (alignment with velocity)');
  const choiceOrder = ['mineral', 'powerUp', 'enemy', 'none'];
  lines.push(
    '  ' +
      choiceOrder
        .map((key) => `${key}=${report.targetChoice.counts[key]}`)
        .join('  '),
  );

  lines.push('');
  lines.push('Engagement distances (px)');
  lines.push(formatDistance('enemy kills', report.engagementDistances.enemy));
  lines.push(formatDistance('power-ups', report.engagementDistances.powerUp));
  lines.push(formatDistance('minerals', report.engagementDistances.mineral));

  lines.push('');
  lines.push('Dodge outcomes (threat windows)');
  lines.push(
    `  windows: ${report.dodge.windows}, dodged: ${report.dodge.dodged}, ` +
      `hit: ${report.dodge.hit}, dodge rate ${formatNumber(report.dodge.dodgeRate, 2)}`,
  );

  lines.push('');
  const eventNames = Object.keys(summary.eventCounts).sort();
  lines.push('Events');
  if (eventNames.length === 0) {
    lines.push('  none');
  } else {
    for (const name of eventNames) lines.push(`  ${name}: ${summary.eventCounts[name]}`);
  }

  return lines.join('\n');
}
