/**
 * Docs guard for the **per-upgrade temporary TTL rule** (AH-0MVUGI5P2001C1IL,
 * child of parent AH-0MVSTKGC3003OMAC; AC1–AC4).
 *
 * Every field pickup adds a temporary level component that reverts at the
 * item's own TTL. This guard fails if the player-facing and code-facing
 * documentation stops saying so, if it re-introduces the superseded
 * AH-0MUX802450085VZZ "Resolved decision 4" exception as a live rule, or if
 * the documented instant-kind TTL values drift from the shipped catalogue.
 *
 * Like the sibling docs guards (`weaponLevelingDocs.test.ts`,
 * `balancingDocs.test.ts`), this is a deliberate docs grep: the deliverable is
 * documentation, so the documentation text *is* the behaviour under test. The
 * runtime contract itself is pinned by `types.test.ts`, `effects.test.ts` and
 * `__tests__/temporaryRevert.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { POWER_UP_CATALOGUE, type PowerUpId } from './types';
import { POWER_UP_LEVEL_IDS, resolveTemporaryWindow } from './powerUpLevels';

const ROOT = process.cwd();
const read = (relative: string): string =>
  fs.readFileSync(path.resolve(ROOT, relative), 'utf8');

const GDD_PATH = 'docs/Game Design Document.md';
const README_PATH = 'README.md';
const BALANCING_PATH = 'docs/BALANCING.md';
const TYPES_PATH = 'src/powerups/types.ts';
const LEVELS_PATH = 'src/powerups/powerUpLevels.ts';
const EFFECTS_PATH = 'src/powerups/effects.ts';
const PLAYER_PATH = 'src/entities/Player.ts';

/**
 * The seven instant kinds (no timed effect of their own) whose TTL is declared
 * catalogue data. The map is the *expected* documentation content; the code
 * side is read from `POWER_UP_CATALOGUE` so a retune cannot silently leave the
 * docs behind.
 */
const INSTANT_KINDS: readonly PowerUpId[] = [
  'bomb',
  'smart_bomb',
  'strike',
  'phase_shift',
  'teleport',
  'extra_life',
  'mystery_ufo',
];

/** Phrases that must never describe a *live* rule for a field pickup. */
const SUPERSEDED_PHRASES = [
  'no timed window',
  'no temporary window',
  'Resolved decision 4',
];

describe('per-upgrade temporary TTL rule is documented (AH-0MVUGI5P2001C1IL)', () => {
  const gdd = read(GDD_PATH);
  const readme = read(README_PATH);
  const balancing = read(BALANCING_PATH);

  it('AC2 — the GDD §4.4.3 states that every field pickup expires at its own TTL', () => {
    expect(gdd).toContain('#### 4.4.3 Power-Up Leveling');
    expect(gdd).toMatch(/per-upgrade TTL rule/);
    expect(gdd).toMatch(/Every\*\* field pickup has one|every field pickup has one/i);
    // The single resolver is named, so the rule has one implementation.
    expect(gdd).toContain('resolveTemporaryWindow');
    expect(gdd).toContain('src/powerups/powerUpLevels.ts');
  });

  it('AC2 — timed kinds keep their level-resolved effect duration as the TTL', () => {
    expect(gdd).toMatch(/keep their level-resolved effect duration as their TTL/i);
    // A level-scaled example proves the window is not one global constant.
    expect(gdd).toMatch(/Shield 15 s → 30 s/);
    expect(gdd).toMatch(/Force Field 8 s → 18 s/);
  });

  it('AC2/AC4 — the documented instant-kind TTLs match the shipped catalogue', () => {
    for (const id of INSTANT_KINDS) {
      const entry = POWER_UP_CATALOGUE[id];
      expect(
        entry.temporaryWindow,
        `${id} must declare a catalogue TTL`,
      ).toBeTypeOf('number');
      const documented = `${entry.name} ${String(entry.temporaryWindow)} s`;
      expect(
        gdd,
        `GDD must document "${documented}" (§4.4.3)`,
      ).toContain(documented);
    }
  });

  it('AC4 — the balance docs record the TTLs as tunable data with a rationale', () => {
    expect(balancing).toContain('PowerUpEntry.temporaryWindow');
    for (const id of INSTANT_KINDS) {
      const entry = POWER_UP_CATALOGUE[id];
      // One tunable row per instant kind: "| <name> | <ttl> |".
      expect(
        balancing,
        `BALANCING.md must list "${entry.name}" as a tunable TTL`,
      ).toMatch(
        new RegExp(
          `\\|\\s*${entry.name}\\s*\\|\\s*${String(entry.temporaryWindow)}\\s*\\|`,
        ),
      );
    }
    expect(balancing).toMatch(/Mirrors the established 10 s weapon window/);
    expect(balancing).toMatch(/no code change is needed/i);
  });

  it('AC2 — weapons obey the same rule with their own TTL', () => {
    expect(gdd).toMatch(/resolveWeaponTemporaryWindow/);
    expect(read(LEVELS_PATH)).toMatch(/resolveWeaponTemporaryWindow/);
    expect(read(PLAYER_PATH)).toMatch(/Per-upgrade TTL rule/);
    expect(read(PLAYER_PATH)).toContain('resolveWeaponTemporaryWindow');
  });

  it('AC2 — the docs state that consumables are never clawed back', () => {
    for (const doc of [gdd, balancing]) {
      expect(doc).toMatch(/never clawed back/i);
      expect(doc).toMatch(/lives|charge|teleport/i);
    }
  });

  it('AC2/AC3 — the four module doc comments describe the per-upgrade TTL', () => {
    // Catalogue field + header (types.ts).
    expect(read(TYPES_PATH)).toContain('temporaryWindow');
    expect(read(TYPES_PATH)).toMatch(/Every field pickup is temporary/);
    // Level-model header (powerUpLevels.ts) — no stale "persist until reset".
    expect(read(LEVELS_PATH)).toMatch(/Every field pickup has a temporary window/);
    // Effect-path doc block (effects.ts).
    expect(read(EFFECTS_PATH)).toMatch(/Every field pickup also gets a temporary level window/);
    // Weapon contract (Player.ts) already asserted above.
  });

  it('AC1 — no live statement claims a field pickup lacks an expiry', () => {
    // Only an explicit description of the superseded history may carry the old
    // wording, so every occurrence must sit within a paragraph that names the
    // supersession.
    const sources = [
      GDD_PATH,
      README_PATH,
      BALANCING_PATH,
      TYPES_PATH,
      LEVELS_PATH,
      EFFECTS_PATH,
      PLAYER_PATH,
      'src/ui/HUD.ts',
      'src/scenes/core/CombatEffectVisuals.ts',
    ];
    for (const file of sources) {
      const text = read(file);
      for (const phrase of SUPERSEDED_PHRASES) {
        for (let at = text.indexOf(phrase); at !== -1; ) {
          const context = text
            .slice(Math.max(0, at - 400), at + 400)
            .toLowerCase();
          expect(
            context,
            `${file} still states "${phrase}" as a live rule (no supersession nearby)`,
          ).toContain('supersed');
          at = text.indexOf(phrase, at + 1);
        }
      }
    }
  });

  it('AC2 — the supersession is explicit in the GDD and the module headers', () => {
    expect(gdd).toMatch(/Superseded decision/);
    expect(gdd).toContain('AH-0MUX802450085VZZ');
    expect(gdd).toContain('AH-0MVSTKGC3003OMAC');
    expect(read(LEVELS_PATH)).toMatch(/Superseded/);
    expect(read(TYPES_PATH)).toMatch(/superseded/);
  });

  it('AC2 — the README agrees with the rule (no pickup persists for the run)', () => {
    expect(readme).toMatch(/per-upgrade TTL/i);
    expect(readme).toContain('resolveTemporaryWindow');
    // Every documented instant kind is a levelled power-up the resolver covers,
    // and the documented value is the value the shipping resolver returns.
    for (const id of INSTANT_KINDS) {
      expect(POWER_UP_LEVEL_IDS).toContain(id);
      expect(resolveTemporaryWindow(id, 0)).toBe(
        POWER_UP_CATALOGUE[id].temporaryWindow,
      );
    }
  });
});
