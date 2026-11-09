/**
 * Docs guard for power-up leveling (AH-0MUU2QJE2007JNR6 AC8).
 *
 * The power-up level-curve catalogue and its shared diminishing-returns
 * curve must be documented in the player-facing references — GDD §4.4.3
 * and the README. This guard fails if that documentation is removed or
 * weakened, and cross-checks every implemented `POWER_UP_LEVEL_SPECS` label
 * against the GDD table so the docs cannot silently drift from the code
 * catalogue.
 *
 * Like the sibling `weaponLevelingDocs.test.ts`, this is a deliberate docs
 * grep: it asserts the canonical documentation (the AC), not runtime
 * behaviour.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { POWER_UP_CATALOGUE, type PowerUpId } from './powerups/types';
import {
  POWER_UP_LEVEL_SPECS,
  resolvePowerUpAtLevel,
} from './powerups/powerUpLevels';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const README_PATH = path.resolve(process.cwd(), 'README.md');
const BALANCING_PATH = path.resolve(process.cwd(), 'docs/BALANCING.md');
const GYM_PARITY_PATH = path.resolve(process.cwd(), 'docs/GYM_PARITY.md');
const ENEMY_DESIGN_PATH = path.resolve(
  process.cwd(),
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
);

/**
 * The shipped surfaces that describe Teleport to a player or a maintainer.
 * `CHANGELOG.md` is deliberately absent — it is the ship skill's release
 * pipeline's to manage and must keep its historical entries.
 */
const TELEPORT_DOC_SURFACES = [
  'docs/Game Design Document.md',
  'docs/BALANCING.md',
  'docs/GYM_PARITY.md',
  'docs/ENEMY_DESIGN_AND_IMPLEMENTATION.md',
  'README.md',
  'src/powerups/types.ts',
  'src/powerups/effects.ts',
  'src/powerups/powerUpLevels.ts',
  'src/powerups/choice.ts',
  'src/powerups/miniBossWheel.ts',
  'src/scenes/gym/GymPowerUpsCombat.ts',
  'src/scenes/gym/core/GymFormationScene.ts',
  'src/ui/HUD.ts',
] as const;

/**
 * The exact statements of the retired cap-3 / 15 s → 5 s / stored-FIFO
 * Teleport. A shipped surface may mention one only when the same line marks
 * it as history (`retired` / `superseded`), which is how the GDD records the
 * superseded greater-count auto-defence rule (parent AH-0MVY096RT006QMF4 AC2).
 */
const RETIRED_TELEPORT_STATEMENTS: ReadonlyArray<[string, RegExp]> = [
  ['a stored-teleport count', /stored teleports?/i],
  ['a stored Teleport use', /stored Teleport (?:use|count|stack)/i],
  ['a FIFO consumption order', /consumed on activation FIFO/i],
  ['multiple Teleports stacking', /Multiple Teleports stack/i],
  ['a cap-3 Teleport pool', /Teleport[^.]{0,60}\bcapped at 3\b/i],
  ['a cap-of-3 Teleport pool', /Teleport[^.]{0,60}\bcap of 3\b/i],
  ['a Teleport stack count', /teleport stacks?/i],
  ['the 15 s → 5 s recharge pair', /\b1\/15\b|15 s (?:at base|base) → 5 s/],
  ['the retired greater-count rule', /greater (?:available )?count/i],
  ['granted Teleport uses', /Teleport uses already granted/i],
];

const RETIREMENT_MARKER = /retired|superseded/i;

/**
 * The shipped surfaces that describe Phase Shift to a player or a maintainer
 * (parent AH-0MW6O1690007P2SL). `CHANGELOG.md` is deliberately absent — the
 * ship skill's release pipeline owns it and keeps its historical entries.
 */
const PHASE_SHIFT_DOC_SURFACES = [
  ...TELEPORT_DOC_SURFACES,
  'docs/BALANCING.md',
  'src/scenes/gym/GymRechargeTuning.ts',
] as const;

/**
 * The exact statements of the retired multi-charge Phase Shift pool. A
 * shipped surface may mention one only when the same line marks it as history
 * (`retired` / `superseded` / `legacy`), which is how the GDD and the store
 * record the retired `phaseCharges` axis.
 */
const RETIRED_PHASE_SHIFT_STATEMENTS: ReadonlyArray<[string, RegExp]> = [
  [
    'a Phase Shift charge pool',
    /Phase Shift[^.]{0,20}\bis (?:a )?(?:recharging )?charge pool/i,
  ],
  [
    "Phase Shift's charge pool",
    /Phase Shift's[^.]{0,80}\bcharge pool/i,
  ],
  [
    'a Phase Shift recharging pool',
    /Phase Shift[^.]{0,20}\brecharging (?:charge )?pool/i,
  ],
  ['a cap-3 Phase Shift pool', /Phase Shift[^.]{0,40}\bcapped at 3\b/i],
  ['a cap-of-3 Phase Shift pool', /Phase Shift[^.]{0,40}\bcap of 3\b/i],
  [
    'a base-1 cap-3 Phase Shift count',
    /Phase Shift[^.]{0,40}base 1 → cap 3/i,
  ],
  [
    'Phase Shift activation charges',
    /Phase Shift (?:auto-activation )?charges\b/i,
  ],
  [
    'the retired POWER_UP_CHARGE_CAP Phase Shift ceiling',
    /POWER_UP_CHARGE_CAP/,
  ],
];

const ids = Object.keys(POWER_UP_CATALOGUE) as PowerUpId[];

describe('power-up leveling is documented (AH-0MUU2QJE2007JNR6 AC8)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('the GDD has a dedicated §4.4.3 Power-Up Leveling subsection', () => {
    expect(gdd).toContain('#### 4.4.3 Power-Up Leveling');
    expect(gdd).toMatch(/run-scoped integer level/);
  });

  it('the GDD documents the shared diminishing-returns curve', () => {
    expect(gdd).toContain('effective(level) = cap − (cap − base) × e^(−k × level)');
    expect(gdd).toContain('src/utils/curve.ts');
  });

  it('the GDD lists every power-up level variable label', () => {
    for (const id of ids) {
      for (const spec of POWER_UP_LEVEL_SPECS[id]) {
        expect(gdd).toContain(spec.label);
      }
    }
  });

  it('the GDD §4.4.3 table pins the consumable charge numbers to the catalogue (AH-0MVTQMREN009DSFW AC1)', () => {
    // The per-consumable charge caps and regeneration intervals must read as
    // the same numbers the resolver produces, so the player-facing docs
    // cannot drift from the catalogue: level-0 values, the level cap/floor
    // and the shipped Phase/Teleport/Thorn intervals all below.
    const shield0 = resolvePowerUpAtLevel('shield', 0).shieldRecharge;
    const shieldFloor = resolvePowerUpAtLevel('shield', 10).shieldRecharge;
    const field0 = resolvePowerUpAtLevel('force_field', 0).forceFieldRecharge;
    const fieldFloor = resolvePowerUpAtLevel('force_field', 10).forceFieldRecharge;
    const ufo0 = resolvePowerUpAtLevel('mystery_ufo', 0).mysteryUfoChargeCap;
    const ufoCap = resolvePowerUpAtLevel('mystery_ufo', 10).mysteryUfoChargeCap;
    expect(shield0).toBe(45);
    expect(shieldFloor).toBe(20);
    expect(field0).toBe(45);
    expect(fieldFloor).toBe(20);
    expect(ufo0).toBe(1);
    expect(ufoCap).toBe(3);
    expect(gdd).toContain(`Shield recharge (${shield0} s → ${shieldFloor} s,`);
    expect(gdd).toContain(`Field recharge (${field0} s → ${fieldFloor} s,`);
    expect(gdd).toContain(`UFO charges (${ufo0} → ${ufoCap},`);
    expect(gdd).toContain('Phase recharge (1/30 → 1/10');
    expect(gdd).toContain('Teleport recharge (1/60 → 1/20');
    expect(gdd).toContain('Thorn recharge (12 s → 5 s,');
  });

  it('the GDD records the stack-reconciliation and hybrid semantics', () => {
    expect(gdd).toMatch(/Stack reconciliation/);
    expect(gdd).toMatch(/permanent stack/);
  });

  it('the GDD states the absorbed-hit pickup model and the pickup-versus-permanent regeneration asymmetry (AH-0MVVD8UL6008JLNF AC7)', () => {
    // The §4.4.3 unified charge-pool bullet must describe a field pickup of
    // the three budget kinds (Shield/Thorn Field/Force Field) as buying
    // exactly one event with no effect window, and must state the deliberate
    // Q-A1=b asymmetry and its reason so a later refactor cannot normalise it.
    expect(gdd).toContain('Absorbed-hit field pickups');
    expect(gdd).toMatch(/grants exactly \*\*one charge\*\* and opens no effect window/i);
    expect(gdd).toContain('pickup-versus-permanent asymmetry');
    expect(gdd).toContain('Q-A1=b');
    expect(gdd).toContain('regenRequiresOwnership');
    // One drop buys one event, then the kind is inert until owned.
    expect(gdd).toMatch(/one drop buys exactly one event/i);
  });

  it('the GDD and README document the linear/clamped curve family (AH-0MV8GPGBL009M0D8)', () => {
    // The power-up side now mixes exponential-saturation with the
    // linear-clamped curve for additive-capped schedules (the Smart Bomb
    // radius/interval); both curves must stay documented.
    expect(gdd).toMatch(/linear[/-]clamped/);
    expect(gdd).toContain('clamp(base + k × level, [min(base, cap), max(base, cap)])');
    expect(readme).toMatch(/linear[/-]clamped/);
  });

  it('the GDD and README document the re-balanced Smart Bomb radius and interval (AH-0MV8GPGBL009M0D8)', () => {
    // The old screen-wide smart bomb (1200 → 2400 px, 0.2/s → 0.5/s) is
    // replaced by a modest 200 → 400 px ship-centred radius pulsing on a
    // 30 → 10 s interval; the docs must record the new schedules.
    expect(gdd).toMatch(/200\s*→\s*400/);
    expect(gdd).toMatch(/30\s*s?\s*→\s*10\s*s/);
    expect(readme).toMatch(/200\s*→\s*400/);
    expect(readme).toMatch(/30\s*→\s*10\s*s/);
  });

  it('the README points at the power-up leveling module and resolver', () => {
    expect(readme).toContain('src/powerups/powerUpLevels.ts');
    expect(readme).toContain('resolvePowerUpAtLevel');
    expect(readme).toMatch(/power-up leveling/i);
  });

  // ── Single-use Teleport docs sweep (parent AH-0MVY096RT006QMF4) ──────

  it('the GDD, BALANCING and GYM_PARITY document the single-use Teleport recharge (AC1/AC3)', () => {
    // The escape is one warp on a level-derived timer; the retired cap-3 pool
    // had its own per-charge timers. Pin the shipped numbers against the
    // catalogue so the docs cannot drift from it: the axis is stored as
    // charges/second and inverted to seconds (1/60 base, 1/20 asymptote).
    const spec = POWER_UP_LEVEL_SPECS.teleport.find(
      (candidate) => candidate.variable === 'teleportRechargeRate',
    );
    expect(spec).toBeDefined();
    expect(Math.round(1 / spec!.base)).toBe(60);
    expect(Math.round(1 / spec!.cap)).toBe(20);
    const rate0 = resolvePowerUpAtLevel('teleport', 0).teleportRechargeRate!;
    expect(Math.round(1 / rate0)).toBe(60);

    expect(gdd).toMatch(/Teleport is \*\*single-use\*\*/);
    expect(gdd).toContain('60 s at base → 20 s at the upgrade cap');
    expect(gdd).toContain('no FIFO queue');
    expect(gdd).toContain('`PowerUpEntry.singleUse`');

    const balancing = fs.readFileSync(BALANCING_PATH, 'utf8');
    expect(balancing).toContain('teleportRechargeRate');
    expect(balancing).toMatch(/\| \*\*60 s\*\* \| \*\*20 s\*\* \|/);

    const gymParity = fs.readFileSync(GYM_PARITY_PATH, 'utf8');
    expect(gymParity).toContain('single-use carve-out');
    expect(gymParity).toContain('PowerUpLevelStore.consumeTeleport()');
    expect(gymParity).toMatch(/uniform 50\/50/);
  });

  it('the GDD records the 50/50 auto-defence pick and why the greater-count rule was retired (AC2)', () => {
    // The change is a rule change, not a tuning tweak, so the rationale has
    // to survive in the GDD next to the numbers.
    expect(gdd).toMatch(/uniform seeded 50\/50/);
    expect(gdd).toMatch(/greater available count/);
    expect(gdd).toMatch(/silently starved Teleport/);
    expect(gdd).toMatch(/retired greater-count rule/i);
  });

  it('no shipped surface still states a cap-3 / 15 s → 5 s / stored-FIFO Teleport (AC5)', () => {
    // A grep sweep as a test: every shipped doc, catalogue description and
    // code comment must describe the single-use escape. `CHANGELOG.md` is
    // excluded (release-managed history), and a line may quote a retired
    // statement only when it marks it as history (`retired`/`superseded`).
    const offenders: string[] = [];
    for (const relative of TELEPORT_DOC_SURFACES) {
      const absolute = path.resolve(process.cwd(), relative);
      const lines = fs.readFileSync(absolute, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (RETIREMENT_MARKER.test(line)) return;
        for (const [description, pattern] of RETIRED_TELEPORT_STATEMENTS) {
          if (pattern.test(line)) {
            offenders.push(`${relative}:${index + 1} — ${description}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the Teleport catalogue description states one rechargeable escape and a pickup refreshing it (AC1)', () => {
    const description = POWER_UP_CATALOGUE.teleport.description;
    expect(description).toMatch(/ready warp/i);
    expect(description).toMatch(/60 s → 20 s/);
    expect(description).toMatch(/pickup readies it/i);
    expect(description).not.toMatch(/stores up to/i);
  });

  it('the ENEMY_DESIGN_AND_IMPLEMENTATION hold-full note describes a ready warp, not a stored use (AC3)', () => {
    const enemyDesign = fs.readFileSync(ENEMY_DESIGN_PATH, 'utf8');
    expect(enemyDesign).toMatch(/ready Teleport warp/);
    expect(enemyDesign).toContain('`canTeleport()` accepts a ready warp');
  });

  // ── Single-use Phase Shift docs sweep (parent AH-0MW6O1690007P2SL) ──

  it('the GDD describes Phase Shift as single-use with a readiness + countdown row (AC1/AC2)', () => {
    // The catalogue row, not just the §4.4.3 table, must describe one held
    // activation that readies on pickup/reward and then recharges once spent
    // — the player-facing statement of the shipped model.
    expect(gdd).toContain('single-use** since parent AH-0MW6O1690007P2SL');
    expect(gdd).toMatch(/The player holds exactly \*\*one\*\* Phase Shift activation/);
    expect(gdd).toContain('a field pickup or a hold-full grant **readies** it');
    expect(gdd).toContain(
      'the HUD row shows the readiness state and a live **`next in Ns`** countdown while it recharges',
    );
    expect(gdd).toContain('a recharging Phase Shift drops out of the auto-defence draw');
  });

  it('the GDD §4.4.3 level table pins Phase Shift to the catalogue recharge interval (AC1)', () => {
    // The interval is stored as charges/second and inverted to seconds by the
    // store (1/30 base, 1/10 asymptote); pin both so the docs cannot drift.
    const spec = POWER_UP_LEVEL_SPECS.phase_shift.find(
      (candidate) => candidate.variable === 'phaseRechargeRate',
    );
    expect(spec).toBeDefined();
    expect(Math.round(1 / spec!.base)).toBe(30);
    expect(Math.round(1 / spec!.cap)).toBe(10);
    const rate0 = resolvePowerUpAtLevel('phase_shift', 0).phaseRechargeRate!;
    expect(Math.round(1 / rate0)).toBe(30);

    expect(gdd).toContain('Phase recharge (1/30 → 1/10');
    expect(gdd).toContain('30 s at base → 10 s at the cap');
  });

  it('the retired phaseCharges level axis is recorded as history (AC5)', () => {
    // The axis no longer exists in the catalogue; the docs must say so next to
    // the table rather than quietly dropping it (a reader may still have an
    // older build in mind).
    const variables = POWER_UP_LEVEL_SPECS.phase_shift.map(
      (candidate) => candidate.variable,
    );
    expect(variables).not.toContain('phaseCharges');
    expect(gdd).toMatch(/retired `phaseCharges` axis/);
  });

  it('the README, BALANCING and GYM_PARITY document the single-use Phase Shift (AC1/AC6)', () => {
    expect(readme).toContain('single-use since parent AH-0MW6O1690007P2SL');
    expect(readme).toMatch(/A normally-collected Phase Shift \*\*readies\*\* its one activation/);

    const balancing = fs.readFileSync(BALANCING_PATH, 'utf8');
    expect(balancing).toContain('phaseRechargeRate');
    expect(balancing).toMatch(/\| \*\*30 s\*\* \| \*\*10 s\*\* \|/);
    expect(balancing).toMatch(/Phase Shift mirrors that shape/);

    const gymParity = fs.readFileSync(GYM_PARITY_PATH, 'utf8');
    expect(gymParity).toContain('hasPhaseShift()');
    expect(gymParity).toContain(
      'Phase Shift — the single activation is spent by one auto-defence phase (**single-use**)',
    );
  });

  it('the GymRechargeTuning comments describe single-use Phase Shift (AC4)', () => {
    // The gym needs no behaviour change (it reads the store readiness API);
    // only its explanatory comment had to follow the model.
    const gym = fs.readFileSync(
      path.resolve(process.cwd(), 'src/scenes/gym/GymRechargeTuning.ts'),
      'utf8',
    );
    expect(gym).toMatch(/Both abilities are \*\*single-use\*\*/);
    expect(gym).toContain('spent\n * activation recharges on the level-derived interval');
    expect(gym).not.toMatch(/regenerating ceiling is 3/);
  });

  it('no shipped surface still states a multi-charge Phase Shift pool (AC3/AC6)', () => {
    // A grep sweep as a test: every shipped doc, catalogue description and
    // code comment must describe the single-use activation. `CHANGELOG.md` is
    // excluded (release-managed history), and a line may quote a retired
    // statement only when it marks it as history.
    const offenders: string[] = [];
    for (const relative of PHASE_SHIFT_DOC_SURFACES) {
      const absolute = path.resolve(process.cwd(), relative);
      const lines = fs.readFileSync(absolute, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (RETIREMENT_MARKER.test(line)) return;
        for (const [description, pattern] of RETIRED_PHASE_SHIFT_STATEMENTS) {
          if (pattern.test(line)) {
            offenders.push(`${relative}:${index + 1} — ${description}`);
          }
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the Phase Shift catalogue description states one activation and its recharge (AC1)', () => {
    const description = POWER_UP_CATALOGUE.phase_shift.description;
    expect(description).toMatch(/one activation/i);
    expect(description).toMatch(/30 s → 10 s/);
    expect(description).toMatch(/ready again/i);
    expect(description).not.toMatch(/charge pool/i);
    expect(POWER_UP_CATALOGUE.phase_shift.singleUse).toBe(true);
  });
});
