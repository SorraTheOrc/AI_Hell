/**
 * Docs guard for the shared six-slot cap (parent AH-0MVLIJT3M005HPHF, AC6;
 * docs items AH-0MVNT31C50065EE0 and AH-0MVRCF584004SQFV).
 *
 * The cap and its per-entry exemption flag must be discoverable by producers
 * and agents, and the two consequences that would otherwise look like bugs must
 * be recorded as *chosen* semantics:
 *
 * - a **temporary (field) pickup occupies a slot while it lasts** and releases
 *   it on expiry (producer Q4a), and
 * - a **weapon-heavy build can take the pool before any power-up reward**
 *   (shared pool, producer Q1 answer (c)).
 *
 * The guard also documents the blocked-collection cue (Q5b), the
 * available-when-full entries never occupying a slot (Q7a), and the choice's
 * "only what is in the slots" rule (Q6a). It fails if that documentation is
 * removed or weakened, and cross-checks the documented exemptions against the
 * live catalogue so the prose cannot silently drift from the code.
 *
 * Like the sibling `powerUpLevelingDocs.test.ts` and
 * `choiceWeightingDocs.test.ts`, this is a deliberate docs grep: it asserts
 * the canonical documentation (the AC), not runtime behaviour. Runtime
 * accounting is covered by `src/powerups/slots.test.ts` and friends.
 *
 * UK English throughout, per the project convention.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { POWER_UP_SLOT_CAP } from './core/constants';
import { SLOTS_FULL_EXEMPT_IDS } from './powerups/slots';
import { POWER_UP_CATALOGUE } from './powerups/types';

const GDD_PATH = path.resolve(process.cwd(), 'docs/Game Design Document.md');
const BALANCING_PATH = path.resolve(process.cwd(), 'docs/BALANCING.md');

const read = (file: string): string =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

/** The GDD section that documents the cap (`§4.4` → before `§4.4.1`). */
function slotsSection(gdd: string): string {
  const start = gdd.indexOf('#### Loadout slots');
  expect(start, 'the GDD has a "Loadout slots" subsection').toBeGreaterThan(-1);
  const end = gdd.indexOf('#### 4.4.1', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

/** The GDD §4.4.1 hold-full choice section (up to §4.4.2). */
function holdFullChoiceSection(gdd: string): string {
  const start = gdd.indexOf('#### 4.4.1 Minerals, the Ship');
  expect(start, 'the GDD has the §4.4.1 hold-full choice section').toBeGreaterThan(-1);
  const end = gdd.indexOf('#### 4.4.2', start);
  return gdd.slice(start, end === -1 ? undefined : end);
}

/** The BALANCING section that records the cap (`### The six loadout slots`). */
function balancingSection(balancing: string): string {
  const start = balancing.indexOf('### The six loadout slots');
  expect(start, 'docs/BALANCING.md has a six loadout slots section').toBeGreaterThan(-1);
  const end = balancing.indexOf('\n### ', start + 1);
  return balancing.slice(start, end === -1 ? undefined : end);
}

describe('the six-slot cap and exemption flag are documented (AH-0MVLIJT3M005HPHF)', () => {
  const gdd = read(GDD_PATH);
  const balancing = read(BALANCING_PATH);

  it('the documented cap is the shipped named constant', () => {
    // The cap is a named constant, not a magic number copied into prose.
    expect(POWER_UP_SLOT_CAP).toBe(6);
    expect(slotsSection(gdd)).toMatch(/POWER_UP_SLOT_CAP\s*=\s*6/);
    expect(slotsSection(gdd)).toContain('src/core/constants.ts');
  });

  it('the GDD records that the six slots are one pool shared by power-ups and weapons', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/shared/i);
    expect(section).toMatch(/power-up and weapon|weapon and power-up|power-up\*? and \*?weapon/i);
    expect(section).toMatch(/six distinct kinds|distinct held drop kind/i);
  });

  it('the GDD records that slots are derived from the existing stores (no new counter)', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/derived/i);
    expect(section).toContain('PowerUpLevelStore.getLevels()');
    expect(section).toContain('Player.getWeaponLevels()');
    expect(section).toMatch(/no second\s+slot\s+counter|no (second |new )?slot counter/i);
  });

  // Producer Q4a (2026-10-27) — the rule changed from permanent-only to the
  // union of permanent and temporary holdings.
  it('the GDD records that a field pickup occupies a slot while it lasts and releases it on expiry', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/field pickup\*{0,2}s?\*{0,2} (occup|count|hold)/i);
    expect(section).toMatch(/slot is \*\*released\*\*|released when the window expires|released when/i);
    expect(section).toMatch(/expir/i);
    // The temporary snapshot accessors are part of the derived view.
    expect(section).toContain('getTempPowerUpIds()');
    expect(section).toContain('getTempWeaponIds()');
  });

  it('the GDD records that the permanent cannon and reset are never counted', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/cannon/i);
    expect(section).toMatch(/reset/i);
    expect(section).toMatch(/never count|not counted|never granted|slot-exempt/i);
  });

  // Producer Q7a — the flag excludes an entry from the count, not just the gate.
  it('the GDD documents availableWhenSlotsFull as a per-entry flag that never occupies a slot', () => {
    const section = slotsSection(gdd);
    expect(section).toContain('availableWhenSlotsFull');
    expect(section).toMatch(/default(s)? to `false`|default `false`|defaults to \*\*`false`\*\*|default \*\*`false`\*\*/);
    expect(section).toMatch(/per-entry|on the (power-up )?catalogue entry|PowerUpEntry/);
    expect(section).toMatch(/no `id === '…'`|data change|no special case/i);
    expect(section).toMatch(/never occupies a slot|never occupy a slot/i);
  });

  it('the GDD names every catalogue entry that is exempt when the slots are full', () => {
    const section = slotsSection(gdd);
    // Cross-check the prose against the live catalogue: every flagged entry
    // must be named, so adding or removing a flag forces a docs update.
    expect(SLOTS_FULL_EXEMPT_IDS.length).toBeGreaterThan(0);
    for (const id of SLOTS_FULL_EXEMPT_IDS) {
      expect(section, `${id} is exempt but not documented`).toContain(
        POWER_UP_CATALOGUE[id].name,
      );
    }
  });

  // Producer Q5b — a refused pickup must be visible, not silent.
  it('the GDD documents the blocked collection and its distinct cue', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/not collectable|not-collectable|blocked/i);
    expect(section).toContain('playPowerUpBlockedSound()');
    expect(section).toMatch(/once per drop|stays on the field/i);
    expect(section).toContain('collectOverlappingDrops');
  });

  // Producer Q6a — the choice offers only what is in the slots.
  it('the GDD records that the hold-full choice offers only items currently in the slots', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/offers only what is in the slots|only items currently in the slots/i);
    expect(section).toMatch(/level-ups? of permanently-owned|level-ups of owned/i);
    expect(section).toMatch(/mini-boss/i);

    const choice = holdFullChoiceSection(gdd);
    expect(choice).toMatch(/only items currently in the slots/i);
    expect(choice).toMatch(/availableWhenSlotsFull/);
    expect(choice).toMatch(/seventh/i);
    // The gate lives once in the shared builder, not in a scene.
    expect(choice).toContain('buildChoiceCandidates');
    expect(choice).toMatch(/tempPowerUpIds/);
  });

  // Producer rejection 2026-10-29 ("we seem able to get 7 slots"): the leak was
  // the mini-boss reward's unlock half, a base-entry offer that does not come
  // through `buildChoiceCandidates`. The rule now applies to every offer
  // surface, and the docs must say so.
  it('the GDD records that the mini-boss unlock half is gated by the same pool', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/mini-boss/i);
    expect(section).toContain('filterOptionsWithinSlotPool');
    expect(section).toMatch(/unlock/i);
    expect(section).toMatch(/seventh/i);
    expect(section).toMatch(/falls back to\s+base picks|never open empty/i);
  });

  it('docs/BALANCING.md records that no reward screen can breach the cap', () => {
    const section = balancingSection(balancing);
    expect(section).toContain('filterOptionsWithinSlotPool');
    expect(section).toMatch(/mini-boss/i);
    expect(section).toMatch(/unlock/i);
    expect(section).toMatch(/held\s+kinds/i);
  });

  it('the GDD records the parity note: the game and the gyms consume the same gate', () => {
    const section = slotsSection(gdd);
    expect(section).toContain('src/powerups/slots.ts');
    expect(section).toContain('drawNextDrop');
    expect(section).toMatch(/PlayScene/);
    expect(section).toMatch(/gym/i);
    expect(section).toMatch(/parity/i);
  });

  it('docs/BALANCING.md records the cap as the demand-side balance lever', () => {
    const section = balancingSection(balancing);
    expect(section).toContain('POWER_UP_SLOT_CAP');
    // Paired with the supply reduction it complements.
    expect(section).toContain('AH-0MVHT1M6O003PU7P');
    expect(section).toMatch(/supply/i);
    expect(section).toMatch(/demand/i);
  });

  it('docs/BALANCING.md records the field-pickup churn and the blocked-pickup cue as intended', () => {
    const section = balancingSection(balancing);
    expect(section).toMatch(/field pickup/i);
    expect(section).toMatch(/while (its timed window is active|it lasts)|while they last/i);
    expect(section).toMatch(/releases? it on expiry|expiry/i);
    expect(section).toMatch(/churn/i);
    expect(section).toMatch(/not-collectable cue|not collectable cue/i);
  });

  it('docs/BALANCING.md records the shared-pool starvation consequence as intended (Q1 answer (c))', () => {
    const section = balancingSection(balancing);
    expect(section).toMatch(/weapon-heavy|weapon-first|weapon build/i);
    expect(section).toMatch(/starv|occupy|consum(e|ing) the pool/i);
    expect(section).toMatch(/intended|chosen|by design|not a bug/i);
    expect(section).toMatch(/Q1/);
    // The producer's answer: one shared pool across power-up and weapon kinds.
    expect(section).toMatch(/\(c\)|answer \(c\)/);
  });
});

// ── HUD presentation of the cap (AH-0MVVJRRN10038VFR) ─────────────────
//
// The cap is only legible if the player can tell a *slot* from a *row*: the
// HUD list can legitimately show an exempt entry (always available) or a
// charge pool that outlives its window (charges only). The docs must state how
// the budget and the non-slot rows are presented, and where the state comes
// from, so this presentation cannot silently drift from the code.

describe('the HUD slot budget and non-slot rows are documented (AH-0MVVJRRN10038VFR)', () => {
  const gdd = read(GDD_PATH);
  const balancing = read(BALANCING_PATH);

  it('the GDD states that the HUD row list is not the loadout', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/row(s)? (is|are)\s+\*{0,2}not\*{0,2}\s+(the )?loadout|HUD[^.]*not\*{0,2} the loadout/i);
    expect(section).toContain('Loadout n/6');
  });

  it('the GDD names the non-slot row classes and their markers', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/always available/i);
    expect(section).toMatch(/charges only/i);
    expect(section).toMatch(/Mystery UFO/);
    expect(section).toMatch(/Phase Shift/);
  });

  it('the GDD records the shared HUD wiring and the row/slot agreement', () => {
    const section = slotsSection(gdd);
    expect(section).toContain('resolvePlayerSlotState');
    expect(section).toContain('combatHudOptions');
    expect(section).toMatch(/src\/ui\/HUD\.ts/);
    expect(section).toMatch(/POWER_UP_SLOT_CAP/);
  });

  it('docs/BALANCING.md records the presented budget and the marked non-slot rows', () => {
    const section = balancingSection(balancing);
    expect(section).toContain('Loadout n/6');
    expect(section).toMatch(/always available/i);
    expect(section).toMatch(/charges only/i);
    expect(section).toContain('resolvePlayerSlotState');
    expect(section).toContain('combatHudOptions');
  });
});

// ── Audited surfaces and their documented divergence (AH-0MVVJS34M00551ES) ──
//
// Every acquisition surface consults the shared pool. Two surfaces behave
// differently *by decision*, and the reason must stay discoverable so a future
// reader does not "fix" the divergence or, worse, assume the cap is broken:
//
// - capture/scripted setups may pre-grant more than six kinds (dev-gated off
//   the normal play path), and
// - a checkpoint is bounded on save (the replay restores a hand-written
//   payload verbatim, for resumed-run parity).

describe('the audited acquisition surfaces are documented (AH-0MVVJS34M00551ES)', () => {
  const gdd = read(GDD_PATH);
  const balancing = read(BALANCING_PATH);

  it('the GDD records the capture-setup divergence and its dev-gate guard', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/capture|scripted/i);
    expect(section).toMatch(/divergen/i);
    expect(section).toContain('resolveSceneSetupState');
    expect(section).toMatch(/dev gate|import\.meta\.env\.DEV/i);
    expect(section).toMatch(/sceneSetup\.ts/);
  });

  it('the GDD records that a checkpoint never persists a seventh kind', () => {
    const section = slotsSection(gdd);
    expect(section).toMatch(/checkpoint/i);
    expect(section).toContain('saveCheckpoint');
    expect(section).toContain('capCheckpointLoadout');
    expect(section).toMatch(/exempt\s+entries?\s+(still\s+)?(survive|come back|restore)/i);
  });

  it('docs/BALANCING.md records both named surfaces and their reasons', () => {
    const section = balancingSection(balancing);
    expect(section).toMatch(/capture|scripted/i);
    expect(section).toContain('resolveSceneSetupState');
    expect(section).toContain('capCheckpointLoadout');
    expect(section).toMatch(/checkpoint/i);
    expect(section).toMatch(/deliberate|by design|intended/i);
  });
});
