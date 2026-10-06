/**
 * Docs guard for the end-of-run victory/defeat treatment
 * (parent AH-0MUTV7632000ZWCB, child AH-0MUTYKXEB0027NCP, AC4/AC5).
 *
 * The victory celebration and defeat signal must be documented in the GDD
 * §7.2 (visual style / juice) and §7.3 (SFX catalogue + Player Audio
 * Character), including the shared module, the two composition entry points,
 * the two cues, the tunable/toggle convention and the gym-parity decision.
 *
 * Like the sibling `aoeDocs.test.ts`, this is a deliberate docs grep: it
 * asserts the canonical documentation text (the acceptance criterion), not
 * source behaviour, so the docs cannot silently drift from the implementation.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');

describe('End-of-run victory/defeat treatment is documented (AC4/AC5)', () => {
  const gdd = fs.readFileSync(GDD_PATH, 'utf8');

  it('GDD §7.2 names the shared module and its composition entry points', () => {
    expect(gdd).toContain('src/vfx/endOfRunJuice.ts');
    expect(gdd).toContain('spawnVictoryJuice');
    expect(gdd).toContain('spawnDefeatScreenJuice');
    expect(gdd).toContain('resolveEndOfRunJuiceParams');
  });

  it('GDD §7.2 documents the victory and defeat layers and their tunables', () => {
    // Victory celebration layers.
    expect(gdd).toMatch(/confetti/i);
    expect(gdd).toMatch(/ENDOFRUN_VICTORY_PARTICLE_COUNT/);
    expect(gdd).toMatch(/ENDOFRUN_VICTORY_RING_COUNT/);
    // Defeat treatment layers.
    expect(gdd).toMatch(/vignette/i);
    expect(gdd).toMatch(/glitch/i);
    expect(gdd).toMatch(/ENDOFRUN_DEFEAT_RED/);
    expect(gdd).toMatch(/ENDOFRUN_DEFEAT_GRAY/);
    // Per-layer toggles and registry teardown.
    expect(gdd).toMatch(/ENDOFRUN_ENABLE_/);
    expect(gdd).toMatch(/SHUTDOWN/);
  });

  it('GDD §7.2 documents the sustained victory fireworks sequence (AH-0MUWZ5HCV0034H44)', () => {
    expect(gdd).toContain('spawnVictoryFireworks');
    expect(gdd).toMatch(/ENDOFRUN_ENABLE_VICTORY_FIREWORKS/);
    expect(gdd).toMatch(/ENDOFRUN_VICTORY_FIREWORKS_DURATION_MS/);
    expect(gdd).toMatch(/ENDOFRUN_VICTORY_FIREWORKS_SPREAD_RADIUS/);
    expect(gdd).toMatch(/ENDOFRUN_VICTORY_SCREEN_FIREWORKS_DURATION_MS/);
    // Boss-position anchoring and the fireworks kinds.
    expect(gdd).toMatch(/boss/i);
    expect(gdd).toMatch(/implosion/i);
  });

  it('GDD §7.2 records the gym-parity decision (no gym run-end screen)', () => {
    expect(gdd).toMatch(/GameOverScene` is reached only from `PlayScene/);
    expect(gdd).toMatch(/no gym scene has a run-end screen/i);
  });

  it('GDD §7.3 catalogs the victory fanfare and defeat sting cues', () => {
    expect(gdd).toContain('playVictoryFanfareSound');
    expect(gdd).toContain('playDefeatStingSound');
    // Contours from the Player Audio Character table / bullet.
    expect(gdd).toContain('VICTORY_ARPEGGIO_FREQS');
    expect(gdd).toContain('VICTORY_CHORD_FREQS');
    expect(gdd).toContain('DEFEAT_STING_FREQS');
    expect(gdd).toContain('DEFEAT_STING_TAIL_FILTER_HZ');
    // The ≤ 0.2 player-cue ceiling and the no-op guarantee.
    expect(gdd).toMatch(/≤ 0\.2/);
    expect(gdd).toMatch(/safe no-op without an `AudioContext`/);
  });

  it('GDD §7.3 states the defeat sting is distinct from the player-destruction cue', () => {
    expect(gdd).toMatch(/distinct from `playPlayerDestructionSound\(\)`/);
    expect(gdd).toMatch(/low-pass/);
    expect(gdd).toMatch(/rumble wash/);
  });
});
