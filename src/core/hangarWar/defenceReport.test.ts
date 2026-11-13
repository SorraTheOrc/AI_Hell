/**
 * Defence report view-model tests (AH-0MVUXCBBK004EJIP).
 *
 * The report is a **pure view** over the resolver's per-tick record and the
 * stored payload (epic AC4), so these tests pin exactly that: every number a
 * row publishes is the record's own number, the retake plan names the
 * answerable neighbour, a quiet tick still renders, and nothing is mutated or
 * re-resolved.
 */

import { describe, expect, it } from 'vitest';

import {
  ASSAULT_HANGAR_FALLS_CONSEQUENCE,
  ASSAULT_HANGAR_FALLS_HEADLINE,
  ASSAULT_REPELLED_CONSEQUENCE,
  ASSAULT_REPELLED_HEADLINE,
  DEFENCE_REPORT_CONTINUE_KEY,
  DEFENCE_REPORT_CONTINUE_LABEL,
  DEFENCE_REPORT_NO_BATTLE_LINE,
  DEFENCE_REPORT_TITLE,
  buildDefenceReport,
  retakeTargetHex,
  retakeTargetIsAnswerable,
} from './defenceReport';
import {
  DEFAULT_FRONTIER_TUNING,
  resolveHangarAssault,
  runFrontierTick,
  type FrontierTickRecord,
  type FrontierTuning,
  type HangarAssaultResolution,
  type HexDefenceRecord,
} from './hexDefence';
import { aggressionScenario } from './__fixtures__/aggressionScenarios';
import { resolvePlayerStrength } from './hangarEconomy';
import { beatableAggressionCeiling } from './hexDifficulty';
import type { HangarWarPayload, HexState } from './types';

/** One hex of the synthetic two-hex ring. */
function hex(
  id: string,
  q: number,
  r: number,
  overrides: Partial<HexState> = {},
): HexState {
  return {
    id,
    q,
    r,
    held: false,
    aggression: 0,
    defender: null,
    bossDefeated: false,
    grantedWeapon: null,
    ...overrides,
  };
}

/** A two-hex payload: `hex-held` is the player's, `hex-frontier` attacks it. */
function makePayload(overrides: Partial<HangarWarPayload> = {}): HangarWarPayload {
  return {
    version: 1,
    seed: 424242,
    hangar: {
      bankedMinerals: 120,
      bankedCores: 1,
      unlockedHulls: ['hull-1'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-1',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: {
      ringIndex: 1,
      hexes: [
        // (1,0) and (0,1) share an edge — the answerable-neighbour pair.
        hex('hex-held', 1, 0, {
          held: true,
          aggression: 3,
          defender: { hullId: 'hull-1', defenceRating: 2, bankedMinerals: 5 },
          bossDefeated: true,
        }),
        hex('hex-frontier', 0, 1, { aggression: 2 }),
      ],
    },
    pendingAttacks: [],
    bestScore: 0,
    ...overrides,
  };
}

/** One resolved attack, as the tick's record carries it. */
function attack(
  overrides: Partial<HexDefenceRecord> = {},
): HexDefenceRecord {
  return {
    outcome: 'fell',
    defenderRating: 2,
    attackingForce: 4,
    aggression: 3,
    aggressionMultiplierPercent: 145,
    jitterPercent: 6,
    attackStrength: 6,
    margin: -4,
    hexId: 'hex-held',
    attackerOriginId: 'hex-frontier',
    attackerOrigin: { q: 0, r: 1 },
    source: 'frontier',
    ...overrides,
  };
}

/** A tick record over the given attacks. */
function makeRecord(
  attacks: readonly HexDefenceRecord[],
  overrides: Partial<FrontierTickRecord> = {},
): FrontierTickRecord {
  return {
    tick: 4,
    playerStrength: 2,
    aggressionBudget: 20,
    beatableCeiling: 2,
    deltas: [],
    rose: 0,
    fell: 0,
    attacks,
    ...overrides,
  };
}

describe('buildDefenceReport — every number comes from the record', () => {
  it('publishes the attacking force, aggression, defender rating, outcome and margin', () => {
    const model = buildDefenceReport(
      makePayload({ ring: { ringIndex: 1, hexes: [
        hex('hex-held', 1, 0, { aggression: 3 }),
        hex('hex-frontier', 0, 1, { aggression: 2 }),
      ] } }),
      makeRecord([attack()]),
    );

    expect(model.rows).toHaveLength(1);
    const row = model.rows[0];
    expect(row.hexId).toBe('hex-held');
    expect(row.outcome).toBe('fell');
    expect(row.attackingForce).toBe(4);
    expect(row.aggression).toBe(3);
    expect(row.aggressionMultiplierPercent).toBe(145);
    expect(row.jitterPercent).toBe(6);
    expect(row.defenderRating).toBe(2);
    expect(row.attackStrength).toBe(6);
    expect(row.margin).toBe(-4);
    expect(row.source).toBe('frontier');
    expect(row.attackerOriginId).toBe('hex-frontier');
    expect(row.key).toBe('defence:hex-held');
  });

  it('renders the numbers into the row label, so the screen is not opaque', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([attack()]));
    const label = model.rows[0].label;

    expect(label).toContain('hex-held — FELL');
    expect(label).toContain('atk 4 × AGG 3');
    expect(label).toContain('145%');
    expect(label).toContain('jitter +6%');
    expect(label).toContain('= 6 vs bot 2');
    expect(label).toContain('margin -4');
  });

  it('marks a held defence as HELD with a positive margin', () => {
    const model = buildDefenceReport(
      makePayload(),
      makeRecord([
        attack({
          outcome: 'held',
          defenderRating: 9,
          attackStrength: 6,
          margin: 3,
          source: 'pending',
        }),
      ]),
    );
    const row = model.rows[0];
    expect(row.outcome).toBe('held');
    expect(row.margin).toBe(3);
    expect(row.label).toContain('hex-held — HELD');
    expect(row.label).toContain('queued attack');
  });

  it('records whether the hex is still held after the tick', () => {
    const payload = makePayload();
    const model = buildDefenceReport(payload, makeRecord([attack()]));
    // `hex-held` is still marked held in this payload, so the row mirrors it.
    expect(model.rows[0].held).toBe(true);

    const lostPayload = makePayload({
      ring: {
        ringIndex: 1,
        hexes: [hex('hex-held', 1, 0), hex('hex-frontier', 0, 1)],
      },
    });
    const lost = buildDefenceReport(lostPayload, makeRecord([attack()]));
    expect(lost.rows[0].held).toBe(false);
    expect(lost.rows[0].label).toContain('· LOST');
  });
});

describe('buildDefenceReport — what it would take to retake the hex', () => {
  it('names the unheld neighbour and the defender rating the same attack needs', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([attack()]));
    const { retake } = model.rows[0];

    expect(retake.originHexId).toBe('hex-frontier');
    expect(retake.origin).toEqual({ q: 0, r: 1 });
    expect(retake.originAggression).toBe(2);
    // A tie holds, so the requirement is the attack strength itself.
    expect(retake.requiredDefenderRating).toBe(6);
    expect(retake.note).toBe(
      'strike hex-frontier (AGG 2) to stop the pressure, then hold with a bot rated ≥ 6',
    );
    expect(model.rows[0].label).toContain('retake: strike hex-frontier');
  });

  it('describes a standing defence as not needing a retake', () => {
    const model = buildDefenceReport(
      makePayload(),
      makeRecord([attack({ outcome: 'held', margin: 3 })]),
    );
    expect(model.rows[0].retake.note).toBe(
      'held — a bot rated ≥ 6 would hold it again',
    );
  });

  it('still builds a plan when the payload no longer carries the origin', () => {
    const model = buildDefenceReport(
      makePayload({
        ring: { ringIndex: 1, hexes: [hex('hex-held', 1, 0)] },
      }),
      makeRecord([attack()]),
    );
    expect(model.rows[0].retake.originHexId).toBe('hex-frontier');
    expect(model.rows[0].retake.originAggression).toBe(0);
    expect(model.rows[0].retake.note).toContain('strike hex-frontier to stop');
  });

  it('points at an unheld neighbour of the attacked hex (the answerability rule)', () => {
    const payload = makePayload();
    const model = buildDefenceReport(payload, makeRecord([attack()]));
    expect(retakeTargetIsAnswerable(payload, model.rows[0])).toBe(true);
    expect(retakeTargetHex(model)).toBe('hex-frontier');
  });
});

describe('buildDefenceReport — summary, quiet ticks and totals', () => {
  it('summarises the tick and counts held/fell', () => {
    const model = buildDefenceReport(
      makePayload(),
      makeRecord([
        attack({ hexId: 'hex-held', outcome: 'held', margin: 3 }),
        attack({ hexId: 'hex-frontier', outcome: 'fell', margin: -2 }),
      ]),
    );
    expect(model.tickLine).toBe('TICK 4 · AGG 20/20 · 0 rose, 0 fell');
    expect(model.summaryLine).toBe('ATTACKED 2 · HELD 1 · FELL 1');
    expect(model.attackedCount).toBe(2);
    expect(model.heldCount).toBe(1);
    expect(model.fellCount).toBe(1);
    expect(model.quiet).toBe(false);
  });

  it('renders a quiet tick (a secured ring) instead of an empty screen', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([]));
    expect(model.quiet).toBe(true);
    expect(model.rows).toEqual([]);
    expect(model.summaryLine).toBe('QUIET — no hex was attacked this tick');
    expect(model.tickLine).toBe('TICK 4 · AGG 20/20 · 0 rose, 0 fell');
    // The continue action is always present, so the screen can never stall.
    expect(model.focusOrder).toEqual([DEFENCE_REPORT_CONTINUE_KEY]);
    expect(model.defaultFocusKey).toBe(DEFENCE_REPORT_CONTINUE_KEY);
  });

  it('is total for a malformed record', () => {
    const model = buildDefenceReport(makePayload(), {
      tick: Number.NaN,
      playerStrength: Number.NaN,
      aggressionBudget: -3,
      beatableCeiling: Number.NaN,
      deltas: [],
      rose: -1,
      fell: Number.NaN,
      attacks: undefined as unknown as readonly HexDefenceRecord[],
    });
    expect(model.quiet).toBe(true);
    expect(model.tick).toBe(0);
    expect(model.playerStrength).toBe(0);
    expect(model.aggressionBudget).toBe(0);
  });

  it('publishes the title, continue action and the no-battle line', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([]));
    expect(model.title).toBe(DEFENCE_REPORT_TITLE);
    expect(model.continueKey).toBe(DEFENCE_REPORT_CONTINUE_KEY);
    expect(model.continueLabel).toBe(DEFENCE_REPORT_CONTINUE_LABEL);
    expect(model.noBattleLine).toBe(DEFENCE_REPORT_NO_BATTLE_LINE);
    // Nothing about a battle: the report is arithmetic over stored numbers.
    expect(model.noBattleLine).toContain('no battle was simulated');
  });

  it('honours title/continue-label overrides (gyms and captures)', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      title: 'GYM DEFENCE REPORT',
      continueLabel: 'BACK',
    });
    expect(model.title).toBe('GYM DEFENCE REPORT');
    expect(model.continueLabel).toBe('BACK');
  });
});

describe('buildDefenceReport — pure', () => {
  it('never mutates the payload or the record', () => {
    const payload = makePayload();
    const record = makeRecord([attack()]);
    const payloadBefore = JSON.parse(JSON.stringify(payload));
    const recordBefore = JSON.parse(JSON.stringify(record));

    buildDefenceReport(payload, record);

    expect(payload).toEqual(payloadBefore);
    expect(record).toEqual(recordBefore);
  });

  it('is deterministic for the same inputs', () => {
    const payload = makePayload();
    const record = makeRecord([attack()]);
    expect(buildDefenceReport(payload, record)).toEqual(
      buildDefenceReport(payload, record),
    );
  });
});


describe('buildDefenceReport — the redistributed tick passthrough (AH-0MWBBUAUQ0038GFL)', () => {
  it('copies the tick record\'s strength, budget, ceiling and deltas unchanged', () => {
    const payload = aggressionScenario(1);
    const tick = runFrontierTick(payload);
    const model = buildDefenceReport(tick.payload, tick.record);

    expect(model.playerStrength).toBe(tick.record.playerStrength);
    expect(model.aggressionBudget).toBe(tick.record.aggressionBudget);
    expect(model.beatableCeiling).toBe(tick.record.beatableCeiling);
    expect(model.deltas).toEqual(tick.record.deltas);
    expect(model.rose).toBe(tick.record.rose);
    expect(model.fell).toBe(tick.record.fell);
  });

  it('states the ring\'s aggression against its budget and what moved', () => {
    const payload = aggressionScenario(1);
    const tick = runFrontierTick(payload);
    const model = buildDefenceReport(tick.payload, tick.record);
    expect(model.tickLine).toBe(
      `TICK ${tick.record.tick} · AGG ${tick.record.aggressionBudget}/${tick.record.aggressionBudget} · ${tick.record.rose} rose, ${tick.record.fell} fell`,
    );
  });

  it('uses the same resolvers the tick used (no second calculation)', () => {
    const payload = aggressionScenario(2);
    const tick = runFrontierTick(payload);
    const model = buildDefenceReport(tick.payload, tick.record);
    expect(model.playerStrength).toBe(resolvePlayerStrength(payload.hangar));
    expect(model.beatableCeiling).toBe(
      beatableAggressionCeiling(model.playerStrength),
    );
  });
});

describe('buildDefenceReport — the hangar assault record (AH-0MWEZZ9EB00604U0)', () => {
  /** The resolver's tuning with jitter disabled, so the arithmetic is exact. */
  const NO_JITTER: FrontierTuning = {
    ...DEFAULT_FRONTIER_TUNING,
    jitterPercent: 0,
  };

  /** A repelled, jitter-free assault (12 held defence against a massed 5). */
  function repelledAssault(): HangarAssaultResolution {
    return resolveHangarAssault(
      { defenderSum: 12, attackerBase: 5, aggression: 0, seed: 1 },
      NO_JITTER,
    );
  }

  /** A failed, jitter-free assault (3 held defence against a massed 5). */
  function fellAssault(): HangarAssaultResolution {
    return resolveHangarAssault(
      { defenderSum: 3, attackerBase: 5, aggression: 0, seed: 1 },
      NO_JITTER,
    );
  }

  it('carries every assault figure verbatim from the resolver record', () => {
    const resolution = resolveHangarAssault(
      { defenderSum: 9, attackerBase: 4, aggression: 3, seed: 7 },
    );
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: resolution,
    });
    const section = model.assault;
    expect(section).not.toBeNull();
    expect(section!.outcome).toBe(resolution.outcome);
    expect(section!.defenderSum).toBe(resolution.defenderSum);
    expect(section!.attackerBase).toBe(resolution.attackerBase);
    expect(section!.aggression).toBe(resolution.aggression);
    expect(section!.aggressionMultiplierPercent).toBe(
      resolution.aggressionMultiplierPercent,
    );
    expect(section!.jitterPercent).toBe(resolution.jitterPercent);
    expect(section!.attackStrength).toBe(resolution.attackStrength);
    expect(section!.margin).toBe(resolution.margin);
    expect(model.assaultLine).toBe(section!.label);
  });

  it('renders the held-ring defender sum against the massed force, with no re-derivation', () => {
    const resolution = repelledAssault();
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: resolution,
    });
    const { numbersLine } = model.assault!;

    expect(numbersLine).toContain(`defender sum ${resolution.defenderSum}`);
    expect(numbersLine).toContain(`massed ${resolution.attackerBase}`);
    expect(numbersLine).toContain(`AGG ${resolution.aggression}`);
    expect(numbersLine).toContain('100%');
    expect(numbersLine).toContain('no jitter');
    expect(numbersLine).toContain(`= ${resolution.attackStrength}`);
    expect(numbersLine).toContain(`margin +${resolution.margin}`);
    expect(numbersLine).toContain('REPELLED');
  });

  it('renders a repelled assault as the legible ring-won line', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: repelledAssault(),
    });

    expect(model.ringWon).toBe(true);
    expect(model.campaignReset).toBe(false);
    expect(model.assault!.ringWon).toBe(true);
    expect(model.assault!.campaignReset).toBe(false);
    expect(model.assault!.headline).toBe(ASSAULT_REPELLED_HEADLINE);
    expect(model.assaultLine).toContain('RING WON');
    expect(model.assaultLine).toContain('repelled');
    expect(model.assaultLine).toContain(ASSAULT_REPELLED_CONSEQUENCE);
    expect(model.assaultLine).not.toContain('FULL CAMPAIGN RESET');
  });

  it('renders a failed assault as the hangar-falls full campaign reset announcement', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: fellAssault(),
    });

    expect(model.ringWon).toBe(false);
    expect(model.campaignReset).toBe(true);
    expect(model.assault!.ringWon).toBe(false);
    expect(model.assault!.campaignReset).toBe(true);
    expect(model.assault!.headline).toBe(ASSAULT_HANGAR_FALLS_HEADLINE);
    expect(model.assaultLine).toContain('HANGAR FALLS');
    expect(model.assaultLine).toContain('FULL CAMPAIGN RESET');
    expect(model.assaultLine).toContain('wiped');
    expect(model.assaultLine).toContain(ASSAULT_HANGAR_FALLS_CONSEQUENCE);
    expect(model.assaultLine).not.toContain('RING WON');
  });

  it('renders an exact tie as a repel (margin 0 holds the line)', () => {
    const resolution = resolveHangarAssault(
      { defenderSum: 5, attackerBase: 5, aggression: 0, seed: 1 },
      NO_JITTER,
    );
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: resolution,
    });

    expect(resolution.outcome).toBe('repelled');
    expect(model.assault!.outcome).toBe('repelled');
    expect(model.assault!.margin).toBe(0);
    expect(model.assault!.numbersLine).toContain('margin 0');
    expect(model.ringWon).toBe(true);
    expect(model.campaignReset).toBe(false);
  });

  it('leaves a quiet / no-assault report unchanged', () => {
    const baseline = buildDefenceReport(makePayload(), makeRecord([]));
    const explicitNull = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: null,
    });

    expect(explicitNull).toEqual(baseline);
    expect(baseline.assault).toBeNull();
    expect(baseline.assaultLine).toBeNull();
    expect(baseline.ringWon).toBe(false);
    expect(baseline.campaignReset).toBe(false);
    expect(baseline.quiet).toBe(true);
    expect(baseline.summaryLine).toBe('QUIET — no hex was attacked this tick');
  });

  it('still reports the tick\'s own rows alongside the assault section', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([attack()]), {
      assault: repelledAssault(),
    });

    expect(model.rows).toHaveLength(1);
    expect(model.attackedCount).toBe(1);
    expect(model.fellCount).toBe(1);
    expect(model.summaryLine).toBe('ATTACKED 1 · HELD 0 · FELL 1');
    expect(model.assault).not.toBeNull();
  });

  it('never stalls the attract bot on an assault report', () => {
    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: repelledAssault(),
    });

    // The report keeps exactly one action, focused by default.
    expect(model.focusOrder).toEqual([DEFENCE_REPORT_CONTINUE_KEY]);
    expect(model.defaultFocusKey).toBe(DEFENCE_REPORT_CONTINUE_KEY);
    expect(model.continueLabel).toBe(DEFENCE_REPORT_CONTINUE_LABEL);

    const fellModel = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: fellAssault(),
    });
    expect(fellModel.focusOrder).toEqual([DEFENCE_REPORT_CONTINUE_KEY]);
  });

  it('never mutates the resolution and is deterministic', () => {
    const resolution = repelledAssault();
    const before = { ...resolution };

    const first = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: resolution,
    });
    const second = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: resolution,
    });

    expect(resolution).toEqual(before);
    expect(first).toEqual(second);
  });

  it('is total on a corrupt assault record', () => {
    const corrupt = {
      outcome: 'fell',
      defenderSum: Number.NaN,
      attackerBase: -4,
      aggression: Number.POSITIVE_INFINITY,
      aggressionMultiplierPercent: Number.NaN,
      jitterPercent: Number.NaN,
      attackStrength: -2,
      margin: 1.9,
    } as unknown as HangarAssaultResolution;

    const model = buildDefenceReport(makePayload(), makeRecord([]), {
      assault: corrupt,
    });
    const section = model.assault!;

    expect(section.defenderSum).toBe(0);
    expect(section.attackerBase).toBe(0);
    expect(section.aggression).toBe(0);
    expect(section.aggressionMultiplierPercent).toBe(0);
    expect(section.jitterPercent).toBe(0);
    expect(section.attackStrength).toBe(0);
    expect(section.margin).toBe(1);
    expect(section.outcome).toBe('fell');
    expect(model.campaignReset).toBe(true);
  });
});
