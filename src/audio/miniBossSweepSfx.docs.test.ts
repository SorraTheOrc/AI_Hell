/**
 * Docs guard for the mini-boss death-sweep audio (AH-0MVVEI7FD004TR2M, AC7).
 *
 * The sweep's audio is only half-shipped if the docs do not say what it plays
 * and why it is visual-timed, so this is a deliberate docs grep (the repo
 * convention used by `endOfRunJuice.docs.test.ts`): it asserts the canonical
 * documentation text — the acceptance criterion — not source behaviour.
 *
 * Covered:
 * - GDD §3.3.1 (the sweep's `Sound.` bullet) and §7.3 (the SFX event catalog
 *   row + the documented departure from the 16th-note accent grid);
 * - `docs/AUDIO_TONEFORGE_CUE_MAPPING.md` (reuse-only palette record);
 * - `docs/GYM_PARITY.md` (the gym gets the same audio from the shared seam).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const gdd = fs.readFileSync(
  path.join(root, 'docs/Game Design Document.md'),
  'utf8',
);
const cueMapping = fs.readFileSync(
  path.join(root, 'docs/AUDIO_TONEFORGE_CUE_MAPPING.md'),
  'utf8',
);
const gymParity = fs.readFileSync(path.join(root, 'docs/GYM_PARITY.md'), 'utf8');

describe('mini-boss defeat sweep audio is documented (AC7)', () => {
  it('GDD §3.3.1 documents the body cue, the thinning rule and the palette', () => {
    const sweepSection = gdd.slice(
      gdd.indexOf('#### 3.3.1 Mini-boss defeat sweep'),
      gdd.indexOf('## 4. Content Catalogs'),
    );
    expect(sweepSection).not.toBe('');
    expect(sweepSection).toContain('playBossDestructionSound()');
    expect(sweepSection).toMatch(/per-role thinning rule/i);
    expect(sweepSection).toMatch(/both\*?\*? voices of every\s+finale pair/i);
    expect(sweepSection).toMatch(/reuse-only/i);
    expect(sweepSection).toContain('MINI_BOSS_SWEEP_SFX_');
  });

  it('GDD §7.3 SFX event catalog has a mini-boss defeat row', () => {
    const row = gdd
      .split('\n')
      .find((line) => /^\|.*Mini-boss defeat/.test(line));
    expect(row, 'no mini-boss defeat row in the §7.3 catalog').toBeDefined();
    // Character, volume and lead time: the three documented columns.
    expect(row).toContain('playBossDestructionSound()');
    expect(row).toContain('playDestructionSound()');
    expect(row).toContain('playVictoryExplosionSound()');
    expect(row).toMatch(/visual-timed/i);
  });

  it('GDD §7.3 records the visual-timed departure from the accent grid', () => {
    expect(gdd).toMatch(/One documented departure — the mini-boss death sweep/);
    expect(gdd).toContain('playMiniBossSweepSound()');
    expect(gdd).toMatch(/187\.5\s*ms/);
    expect(gdd).toContain('MINI_BOSS_SWEEP_SFX_');
  });

  it('the cue mapping records the reuse-only palette (no new recipe/asset)', () => {
    expect(cueMapping).toContain('playMiniBossSweepSound');
    expect(cueMapping).toContain('playVictoryExplosionSound');
    expect(cueMapping).toContain('playBossDestructionSound');
    expect(cueMapping).toMatch(/No new recipe, baked\s+asset or manifest entry/);
    expect(cueMapping).toMatch(/reuse-only/i);
  });

  it('the gym-parity matrix records that GymMiniBoss shares the sweep audio', () => {
    const row = gymParity
      .split('\n')
      .find((line) => line.startsWith('| `GymMiniBoss`'));
    expect(row, 'no GymMiniBoss row in the parity matrix').toBeDefined();
    expect(row).toContain('playMiniBossSweepSound');
    expect(row).toMatch(/no\s+per-scene cue logic/);
  });
});
