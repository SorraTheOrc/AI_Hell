/**
 * Rule contract tests + classification fixture (AH-0MV84T78T008AB3E);
 * parent AH-0MV29XQ0H009P9WP.
 *
 * Test-first contract for the pure wave-balance rule module
 * (`src/core/waveBalance.ts`, F2 AH-0MV84TE7O006HI3R). Every assertion
 * exercises observable behaviour through the module's public API — no
 * source-grepping, no placeholders (see Test Writing Guidelines).
 *
 * Coverage:
 * - classification fixture: every `DEFAULT_ENEMY_CONFIGS` archetype key
 *   resolves to its declared `{movementClass, attackClass}`; unknown keys
 *   fall back to the documented defaults;
 * - R1 opening purity, R2 no-all-chaser, R3 bounded ranged mix with
 *   pass/violation/borderline cases at the named constants;
 * - effective-attack semantics (no-fire ⇒ contact, producer Q1);
 * - the audit validator: audits a list of waves, reuses the same rules,
 *   returns per-wave pass/fail + a per-rule human-readable message.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ENEMY_CONFIGS } from './configDefaults';
import type {
  EnemyAttackClass,
  EnemyMovementClass,
  EnemyShotPattern,
} from './configTypes';
import {
  CHASER_MOVEMENT_CLASS,
  OPENING_MOVEMENT_CLASSES,
  OPENING_WAVE_POSITIONS,
  RANGED_ATTACK_CLASSES,
  RANGED_SHARE_CAP,
  RULE_PRECEDENCE,
  auditWave,
  auditWaves,
  checkBoundedRangedMix,
  checkNoAllChaser,
  checkOpeningPurity,
  checkSequentialDistinctness,
  classifyArchetype,
  classifyGroup,
  classifyWaveGroups,
  compositionSignature,
  deriveAttackClassFromShotPattern,
  groupsComposition,
  isOpeningWavePosition,
  type BalancedWave,
  type ClassifiedGroup,
} from './waveBalance';

// ── Helpers ───────────────────────────────────────────────────────────

/** Build a classified group with explicit classes (public API input shape). */
function grp(
  enemyKey: string,
  movementClass: EnemyMovementClass,
  attackClass: EnemyAttackClass,
): ClassifiedGroup {
  return { enemyKey, movementClass, attackClass };
}

/** A firing wave built from explicit groups. */
function firingWave(groups: ClassifiedGroup[]): BalancedWave {
  return { groups, shootEnabled: true };
}

// ── Classification fixture ────────────────────────────────────────────

describe('classification fixture', () => {
  it('resolves every DEFAULT_ENEMY_CONFIGS archetype to its declared classes', () => {
    for (const [key, config] of Object.entries(DEFAULT_ENEMY_CONFIGS)) {
      expect(classifyArchetype(key)).toEqual({
        movementClass: config.movementClass,
        attackClass: config.attackClass,
      });
    }
  });

  it('falls back to the documented defaults for an unknown key', () => {
    expect(classifyArchetype('does-not-exist')).toEqual({
      movementClass: 'formation',
      attackClass: 'projectile',
    });
  });

  it('derives the attackClass from the shot pattern when a config omits it', () => {
    const config = { ...DEFAULT_ENEMY_CONFIGS.scout };
    // Absent classification columns exercise the documented fallbacks.
    config.movementClass = undefined as unknown as EnemyMovementClass;
    config.attackClass = undefined as unknown as EnemyAttackClass;
    config.shotPattern = 'none' as EnemyShotPattern;

    const resolved = classifyArchetype('scout', { scout: config });
    expect(resolved.movementClass).toBe('formation');
    expect(resolved.attackClass).toBe('contact');
  });

  it('derives `none` shot patterns to contact and every firing pattern to projectile', () => {
    expect(deriveAttackClassFromShotPattern('none')).toBe('contact');
    for (const pattern of ['aimed', 'spread', 'radial', 'orbital', 'coordinated'] as const) {
      expect(deriveAttackClassFromShotPattern(pattern)).toBe('projectile');
    }
  });

  it('classifies a group with its key attached', () => {
    expect(classifyGroup('grunt')).toEqual({
      enemyKey: 'grunt',
      movementClass: 'chaser',
      attackClass: 'contact',
    });
  });

  it('classifies a whole wave of keys, preserving play order', () => {
    expect(classifyWaveGroups([{ enemyKey: 'grunt' }, { enemyKey: 'scout' }])).toEqual([
      { enemyKey: 'grunt', movementClass: 'chaser', attackClass: 'contact' },
      { enemyKey: 'scout', movementClass: 'formation', attackClass: 'projectile' },
    ]);
  });
});

// ── R1 — opening-wave purity ──────────────────────────────────────────

describe('R1 — opening-wave purity', () => {
  it('passes an opening wave whose groups are all formation/diver', () => {
    const result = checkOpeningPurity([
      grp('scout', 'formation', 'projectile'),
      grp('diver', 'diver', 'projectile'),
    ]);
    expect(result.pass).toBe(true);
    expect(result.applicable).toBe(true);
  });

  it('fails an opening wave containing a chaser group, naming the offender', () => {
    const result = checkOpeningPurity([
      grp('scout', 'formation', 'projectile'),
      grp('grunt', 'chaser', 'contact'),
    ]);
    expect(result.pass).toBe(false);
    expect(result.message).toContain('grunt');
    expect(result.message).toContain(CHASER_MOVEMENT_CLASS.toLowerCase());
  });

  it('fails an opening wave containing a patroller group', () => {
    expect(checkOpeningPurity([grp('raider', 'patroller', 'projectile')]).pass).toBe(false);
  });

  it('fails an opening wave containing a roamer group', () => {
    expect(checkOpeningPurity([grp('asteroid', 'roamer', 'contact')]).pass).toBe(false);
  });

  it('borderline: exactly every allowed movement class passes', () => {
    for (const movementClass of OPENING_MOVEMENT_CLASSES) {
      const result = checkOpeningPurity([grp('key', movementClass, 'contact')]);
      expect(result.pass).toBe(true);
    }
  });

  it('borderline: the first excluded movement class fails', () => {
    const excluded = (['chaser', 'patroller', 'roamer'] as const).filter(
      (movementClass) => !OPENING_MOVEMENT_CLASSES.includes(movementClass),
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const movementClass of excluded) {
      expect(checkOpeningPurity([grp('key', movementClass, 'contact')]).pass).toBe(false);
    }
  });
});

// ── R2 — no all-chaser wave ───────────────────────────────────────────

describe('R2 — no all-chaser wave', () => {
  it('passes a wave with at least one non-chaser group', () => {
    const result = checkNoAllChaser([
      grp('grunt', 'chaser', 'contact'),
      grp('scout', 'formation', 'projectile'),
    ]);
    expect(result.pass).toBe(true);
  });

  it('fails an all-chaser wave', () => {
    const result = checkNoAllChaser([
      grp('grunt', 'chaser', 'contact'),
      grp('ghost-chase', 'chaser', 'contact'),
    ]);
    expect(result.pass).toBe(false);
    expect(result.message).toContain('grunt');
  });

  it('fails a single-group chaser wave', () => {
    expect(checkNoAllChaser([grp('grunt', 'chaser', 'contact')]).pass).toBe(false);
  });

  it('passes a single-group non-chaser wave', () => {
    expect(checkNoAllChaser([grp('scout', 'formation', 'projectile')]).pass).toBe(true);
  });

  it('treats an empty wave as vacuously compliant', () => {
    const result = checkNoAllChaser([]);
    expect(result.pass).toBe(true);
    expect(result.applicable).toBe(false);
  });
});

// ── R3 — bounded ranged mix ───────────────────────────────────────────

describe('R3 — bounded ranged mix', () => {
  it('passes a firing wave with at least one effective-contact group', () => {
    const result = checkBoundedRangedMix(
      [grp('grunt', 'chaser', 'contact'), grp('scout', 'formation', 'projectile')],
      true,
    );
    expect(result.pass).toBe(true);
  });

  it('fails an all-ranged firing wave', () => {
    const result = checkBoundedRangedMix(
      [grp('scout', 'formation', 'projectile'), grp('phaser', 'formation', 'projectile')],
      true,
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/ranged/i);
  });

  it('passes a no-fire wave regardless of attackClass (effective-attack semantics)', () => {
    const allRanged = [
      grp('scout', 'formation', 'projectile'),
      grp('phaser', 'formation', 'projectile'),
    ];
    expect(checkBoundedRangedMix(allRanged, false).pass).toBe(true);
    expect(checkBoundedRangedMix(allRanged, false).applicable).toBe(true);
  });

  it('passes a single-group contact firing wave', () => {
    expect(checkBoundedRangedMix([grp('grunt', 'chaser', 'contact')], true).pass).toBe(true);
  });

  it('fails a single-group firing wave for every ranged attack class', () => {
    for (const attackClass of RANGED_ATTACK_CLASSES) {
      expect(checkBoundedRangedMix([grp('key', 'formation', attackClass)], true).pass).toBe(
        false,
      );
    }
  });

  it('borderline: a share exactly at the cap fails, just below it passes', () => {
    // share = 1 (all ranged, incl. beam/area classes) reaches the cap.
    const atCap = [
      grp('phaser', 'formation', 'projectile'),
      grp('capturer', 'formation', 'beam'),
    ];
    expect(checkBoundedRangedMix(atCap, true).pass).toBe(false);

    // Adding a single contact group drops the share below the cap.
    const belowCap = [...atCap, grp('grunt', 'chaser', 'contact')];
    const result = checkBoundedRangedMix(belowCap, true);
    expect(result.pass).toBe(true);
    expect(result.message).toContain('contact');
  });

  it('exposes the tunable cap as a positive named constant', () => {
    expect(RANGED_SHARE_CAP).toBeGreaterThan(0);
  });
});

// ── Audit validator ───────────────────────────────────────────────────

describe('audit validator', () => {
  it('audits a list of waves, reusing the same rule functions with per-rule messages', () => {
    const audited = auditWaves([
      firingWave([grp('grunt', 'chaser', 'contact'), grp('ghost-chase', 'chaser', 'contact')]),
      firingWave([
        grp('scout', 'formation', 'projectile'),
        grp('grunt', 'chaser', 'contact'),
      ]),
    ]);
    const [violating, compliant] = audited.waves;
    expect(audited.pass).toBe(false);
    expect(violating.pass).toBe(false);
    expect(compliant.pass).toBe(true);
    for (const wave of audited.waves) {
      expect(wave.rules).toHaveLength(3);
      for (const rule of wave.rules) {
        expect(rule.id).toMatch(/^R[123]$/);
        expect(rule.message.length).toBeGreaterThan(0);
      }
    }
    const r2 = violating.rules.find((rule) => rule.id === 'R2');
    expect(r2?.pass).toBe(false);
    expect(r2?.message).toContain('grunt');
  });

  it('passes when every generated wave is compliant', () => {
    const audited = auditWaves([
      firingWave([grp('scout', 'formation', 'projectile'), grp('grunt', 'chaser', 'contact')]),
      firingWave([grp('diver', 'diver', 'projectile'), grp('grunt', 'chaser', 'contact')]),
    ]);
    expect(audited.pass).toBe(true);
    expect(audited.waves.every((wave) => wave.pass)).toBe(true);
  });

  it('applies R1 only to opening waves', () => {
    // A wave that is R1-violating (patroller) yet R2/R3-compliant
    // (non-chaser, effective-contact) isolates the R1 gate.
    const patrollerContact = [grp('raider', 'patroller', 'contact')];

    const opening = auditWave({ groups: patrollerContact, shootEnabled: true, isOpening: true });
    expect(opening.pass).toBe(false);
    const openingR1 = opening.rules.find((rule) => rule.id === 'R1');
    expect(openingR1?.pass).toBe(false);
    expect(openingR1?.applicable).toBe(true);

    const nonOpening = auditWave({ groups: patrollerContact, shootEnabled: true });
    expect(nonOpening.pass).toBe(true);
    const nonOpeningR1 = nonOpening.rules.find((rule) => rule.id === 'R1');
    expect(nonOpeningR1?.pass).toBe(true);
    expect(nonOpeningR1?.applicable).toBe(false);
  });

  it('reports fixed waves as exempt without evaluating the rules (Q3=a)', () => {
    const fixedWave: BalancedWave = {
      groups: [grp('grunt', 'chaser', 'contact')],
      shootEnabled: true,
      generation: 'fixed',
    };
    const wave = auditWave(fixedWave);
    expect(wave.exempt).toBe(true);
    expect(wave.pass).toBe(true);
    expect(wave.rules).toHaveLength(0);

    const audited = auditWaves([fixedWave]);
    expect(audited.pass).toBe(true);
  });

  it('echoes the wave id into the report', () => {
    const audited = auditWaves([
      { id: '2:3', groups: [grp('grunt', 'chaser', 'contact')], shootEnabled: true },
    ]);
    expect(audited.waves[0].id).toBe('2:3');
  });
});

// ── R1 opening positions constant ─────────────────────────────────────

describe('opening wave positions', () => {
  it('marks waves 1–2 of levels 1–2 as opening positions', () => {
    expect(isOpeningWavePosition(1, 1)).toBe(true);
    expect(isOpeningWavePosition(1, 2)).toBe(true);
    expect(isOpeningWavePosition(2, 1)).toBe(true);
    expect(isOpeningWavePosition(2, 2)).toBe(true);
  });

  it('marks every other position as non-opening', () => {
    expect(isOpeningWavePosition(1, 3)).toBe(false);
    expect(isOpeningWavePosition(2, 3)).toBe(false);
    expect(isOpeningWavePosition(3, 1)).toBe(false);
  });

  it('declares the curated positions as the named constant', () => {
    expect(OPENING_WAVE_POSITIONS).toEqual([
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ]);
  });
});

// ── R4 — sequential distinctness (AH-0MVSE6XIO007BXYM) ───────────────

describe('R4 — sequential distinctness', () => {
  /** A non-firing wave group (classification is irrelevant to R4). */
  const group = (enemyKey: string) => ({ enemyKey });

  it('exposes the composition signature as the single "same enemies" definition', () => {
    // Counts, spacing, order and duplicate groups cannot manufacture variety.
    expect(compositionSignature(['tank', 'scout', 'scout'])).toBe('scout+tank');
    expect(groupsComposition([group('tank'), group('scout'), group('scout')])).toBe(
      'scout+tank',
    );
    expect(compositionSignature([])).toBe('');
  });

  it('passes when the composition differs from the preceding wave', () => {
    const result = checkSequentialDistinctness([group('scout')], 'tank');
    expect(result.id).toBe('R4');
    expect(result.pass).toBe(true);
    expect(result.applicable).toBe(true);
    expect(result.message).toContain('scout');
  });

  it('fails when the composition repeats the preceding wave', () => {
    // Same archetype set in a different order: still a repeat.
    const result = checkSequentialDistinctness(
      [group('tank'), group('scout')],
      'scout+tank',
    );
    expect(result.pass).toBe(false);
    expect(result.applicable).toBe(true);
    expect(result.message).toContain('repeats');
  });

  it('does not apply to a level-first wave (no predecessor)', () => {
    const result = checkSequentialDistinctness([group('scout')], undefined);
    expect(result.pass).toBe(true);
    expect(result.applicable).toBe(false);
  });

  it('treats two archetype-less waves as a repeat of the empty signature', () => {
    expect(checkSequentialDistinctness([], '').pass).toBe(false);
  });

  it('documents the precedence: the balance rules win over distinctness', () => {
    expect(RULE_PRECEDENCE).toEqual(['R1', 'R2', 'R3', 'R4']);
  });

  it('audits R4 for a generated wave when the predecessor composition is supplied', () => {
    const groups = classifyWaveGroups([{ enemyKey: 'scout' }]);
    const wave: BalancedWave = {
      groups,
      shootEnabled: false,
      previousComposition: 'scout',
    };
    const audited = auditWave(wave);
    expect(audited.rules.map((rule) => rule.id)).toEqual(['R1', 'R2', 'R3', 'R4']);
    expect(audited.pass).toBe(false);
    const r4 = audited.rules.find((rule) => rule.id === 'R4');
    expect(r4?.pass).toBe(false);
  });

  it('keeps the R1–R3 report shape when no predecessor composition is supplied', () => {
    const groups = classifyWaveGroups([{ enemyKey: 'scout' }]);
    const audited = auditWave({ groups, shootEnabled: false });
    expect(audited.rules.map((rule) => rule.id)).toEqual(['R1', 'R2', 'R3']);
  });

  it('never constrains a fixed wave, even when it repeats its predecessor (Q3=a)', () => {
    const groups = classifyWaveGroups([{ enemyKey: 'scout' }]);
    const audited = auditWave({
      groups,
      shootEnabled: false,
      generation: 'fixed',
      previousComposition: 'scout',
    });
    expect(audited.exempt).toBe(true);
    expect(audited.pass).toBe(true);
    expect(audited.rules).toHaveLength(0);
  });
});
