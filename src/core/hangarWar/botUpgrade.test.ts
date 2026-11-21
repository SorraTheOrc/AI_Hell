/**
 * Bot-upgrade contract tests (parent AH-0MWH48IEG00929GQ, child
 * AH-0MWHWEY08009BJ3Y).
 *
 * The pure `botUpgrade` module owns the fit rule, the per-level upgrade price
 * (producer Q9 = B), the purchase economics and the one-formula rating
 * recompute. This suite pins that contract so no scene can re-derive a fit or
 * a price: every verdict, price and applied upgrade is asserted against the
 * module, never a copy of the rule.
 */

import { describe, expect, it } from 'vitest';

import { POWER_UP_SLOT_CAP } from '../constants';
import {
  MAX_PERMANENT_LEVEL,
  deriveDefenderRating,
  defenderRatingFromSnapshot,
  defenderStatBuckets,
  findHangarEntry,
} from './hangarEconomy';
import {
  BOT_WEAPON_UPGRADE_PRICES,
  BASE_BOT_WEAPON_LEVEL,
  botOccupiedSlots,
  botPriceLabel,
  botSlotUsage,
  botUpgradeRowLabel,
  botUpgradeRowKey,
  botUpgradeRows,
  botWeaponLevel,
  buyBotUpgrade,
  fitBotUpgrade,
} from './botUpgrade';
import { HANGAR_CATALOGUE } from '../../data/hangarCatalogue';
import { createInMemoryHangarWarStorage } from './storage';
import { loadHangarWarPayload, saveHangarWarPayload } from './hangarWarStore';
import { DEFAULT_FRONTIER_TUNING, runFrontierTick } from './hexDefence';
import { VALID_HANGAR_WAR_PAYLOAD } from './fixtures';
import type {
  DefenderUpgradeSnapshot,
  HangarWarPayload,
  HexDefender,
} from './types';
import type { WeaponId } from '../../utils/weapons';

/** The zero/empty wallet used by the fit tests. */
const RICH = { bankedMinerals: 10_000, bankedCores: 100 };

/** A held-hex payload whose defender is `defender`. */
function payloadWith(
  defender: HexDefender,
  wallet = RICH,
  ringIndex = 1,
): HangarWarPayload {
  return {
    version: 1,
    seed: 7,
    hangar: {
      bankedMinerals: wallet.bankedMinerals,
      bankedCores: wallet.bankedCores,
      unlockedHulls: ['hull-1', 'hull-2'],
      unlockedWeapons: ['spread'],
      ownedModifiers: [],
      activeHull: 'hull-2',
      activeLoadout: { startingWeapons: ['spread'], modifiers: [] },
    },
    ring: {
      ringIndex,
      hexes: [
        {
          id: 'hex-held',
          q: 1,
          r: 0,
          held: true,
          aggression: 1,
          defender,
          bossDefeated: true,
          grantedWeapon: null,
        },
      ],
    },
    pendingAttacks: [],
    bestScore: 0,
  };
}

/** A snapshot carrying the given weapon levels. */
function snapshotWithWeapons(
  levels: ReadonlyArray<{ id: WeaponId; level: number }>,
): DefenderUpgradeSnapshot {
  return {
    weaponLevels: levels.map((row) => ({ ...row })),
    powerUpLevels: [],
    consumablePools: [],
  };
}

/** A plain defender (the starter hull, no upgrades). */
function plainDefender(overrides: Partial<HexDefender> = {}): HexDefender {
  return {
    hullId: 'hull-1',
    defenceRating: deriveDefenderRating('hull-1'),
    bankedMinerals: 0,
    ...overrides,
  };
}

/** The catalogue entry by id, as a non-null value. */
function entry(id: string) {
  const found = findHangarEntry(id, HANGAR_CATALOGUE);
  if (found === null) throw new Error(`missing catalogue entry ${id}`);
  return found;
}

// ── Slot accounting (the shared POWER_UP_SLOT_CAP) ────────────────────────

describe('botSlotUsage — the shared permanent slot pool', () => {
  it('derives occupancy from the stored permanent kinds, not a counter', () => {
    const defender = plainDefender({
      upgradeSnapshot: {
        weaponLevels: [
          { id: 'spread', level: 1 },
          { id: 'wave_laser', level: 2 },
        ],
        powerUpLevels: [{ id: 'bomb', level: 1 }],
        // A charge pool is not a permanent kind: it must not occupy a slot.
        consumablePools: [{ id: 'shield', charges: 3 }],
      },
    });
    expect(botOccupiedSlots(defender)).toBe(3);
    expect(botSlotUsage(defender)).toEqual({
      used: 3,
      capacity: POWER_UP_SLOT_CAP,
      free: POWER_UP_SLOT_CAP - 3,
      isFull: false,
    });
  });

  it('reports full at the shared cap and never below zero free slots', () => {
    const levels = Array.from({ length: POWER_UP_SLOT_CAP + 2 }, (_, index) => ({
      id: `kind-${index}` as WeaponId,
      level: 1,
    }));
    const defender = plainDefender({
      upgradeSnapshot: {
        weaponLevels: levels,
        powerUpLevels: [],
        consumablePools: [],
      },
    });
    expect(botSlotUsage(defender).isFull).toBe(true);
    expect(botSlotUsage(defender).free).toBe(0);
  });
});

// ── Fit rule (producer Q8 = A, Q10 = everything) ─────────────────────────

describe('fitBotUpgrade — one verdict per entry, per defender', () => {
  it('offers a new weapon kind as add-to-empty-slot at the catalogue price', () => {
    const verdict = fitBotUpgrade(plainDefender(), entry('wave_laser'), RICH, 1);
    expect(verdict.fit).toBe('add-to-empty-slot');
    expect(verdict.reason).toBeNull();
    expect(verdict.actionable).toBe(true);
    expect(verdict.currentLevel).toBeNull();
    expect(verdict.nextLevel).toBe(BASE_BOT_WEAPON_LEVEL);
    expect(verdict.price).toEqual(entry('wave_laser').price);
  });

  it('offers a carried weapon as upgrade-existing at the per-level price (Q9 = B)', () => {
    const defender = plainDefender({
      upgradeSnapshot: snapshotWithWeapons([{ id: 'wave_laser', level: 1 }]),
    });
    const verdict = fitBotUpgrade(defender, entry('wave_laser'), RICH, 1);
    expect(verdict.fit).toBe('upgrade-existing');
    expect(verdict.currentLevel).toBe(1);
    expect(verdict.nextLevel).toBe(2);
    // The Q9 = B table, distinct from the catalogue's new-kind purchase price.
    expect(verdict.price).toEqual(BOT_WEAPON_UPGRADE_PRICES[2]);
    expect(verdict.price).not.toEqual(entry('wave_laser').price);
  });

  it('refuses a new weapon kind when the slot pool is full', () => {
    const levels = Array.from({ length: POWER_UP_SLOT_CAP }, (_, index) => ({
      id: (index === 0 ? 'spread' : `kind-${index}`) as WeaponId,
      level: 1,
    }));
    const defender = plainDefender({
      upgradeSnapshot: snapshotWithWeapons(levels),
    });
    const verdict = fitBotUpgrade(defender, entry('cluster'), RICH, 1);
    expect(verdict.fit).toBeNull();
    expect(verdict.reason).toBe('slot-full');
    expect(verdict.actionable).toBe(false);
    expect(verdict.price).toEqual({ minerals: 0, cores: 0 });
  });

  it('still offers a carried weapon when the pool is full (upgrade, not add)', () => {
    const levels = Array.from({ length: POWER_UP_SLOT_CAP }, (_, index) => ({
      id: (index === 0 ? 'wave_laser' : `kind-${index}`) as WeaponId,
      level: 1,
    }));
    const defender = plainDefender({
      upgradeSnapshot: snapshotWithWeapons(levels),
    });
    const verdict = fitBotUpgrade(defender, entry('wave_laser'), RICH, 1);
    expect(verdict.fit).toBe('upgrade-existing');
  });

  it('refuses an upgrade past the shared maximum level', () => {
    const defender = plainDefender({
      upgradeSnapshot: snapshotWithWeapons([
        { id: 'wave_laser', level: MAX_PERMANENT_LEVEL },
      ]),
    });
    const verdict = fitBotUpgrade(defender, entry('wave_laser'), RICH, 1);
    expect(verdict.reason).toBe('capped');
    expect(verdict.actionable).toBe(false);
  });

  it('offers a hull as re-hull, and refuses the hull already flown', () => {
    const rehull = fitBotUpgrade(plainDefender(), entry('hull-2'), RICH, 1);
    expect(rehull.fit).toBe('re-hull');
    expect(rehull.price).toEqual(entry('hull-2').price);

    const same = fitBotUpgrade(
      plainDefender({ hullId: 'hull-2' }),
      entry('hull-2'),
      RICH,
      1,
    );
    expect(same.reason).toBe('already-equipped');
  });

  it('offers a defence-skill modifier as train and refuses a repeat', () => {
    const train = fitBotUpgrade(
      plainDefender(),
      entry('anti_maw_plating'),
      RICH,
      1,
    );
    expect(train.fit).toBe('train');
    expect(train.price).toEqual(entry('anti_maw_plating').price);

    const trained = plainDefender({
      skills: [
        { id: 'maw-warded', name: 'Maw-warded', bossType: 'maw-of-ashes', bonus: 5 },
      ],
    });
    const again = fitBotUpgrade(trained, entry('anti_maw_plating'), RICH, 1);
    expect(again.reason).toBe('already-equipped');
  });

  it('refuses modifier effects with no stored-bot meaning', () => {
    const verdict = fitBotUpgrade(
      plainDefender(),
      entry('hardened_plating'),
      RICH,
      1,
    );
    expect(verdict.reason).toBe('not-sendable');
    expect(verdict.actionable).toBe(false);
  });

  it('refuses a power-up entry (never a bot purchase candidate)', () => {
    const verdict = fitBotUpgrade(plainDefender(), entry('bomb'), RICH, 1);
    expect(verdict.reason).toBe('not-sendable');
  });

  it('refuses ring-gated entries (ring 2 hull at ring 1, grant-only hull)', () => {
    expect(fitBotUpgrade(plainDefender(), entry('hull-3'), RICH, 1).reason).toBe(
      'gated',
    );
    expect(fitBotUpgrade(plainDefender(), entry('hull-4'), RICH, 1).reason).toBe(
      'gated',
    );
  });

  it('refuses an unaffordable entry and reports the exact shortfall', () => {
    const verdict = fitBotUpgrade(
      plainDefender(),
      entry('wave_laser'),
      { bankedMinerals: 10, bankedCores: 0 },
      1,
    );
    expect(verdict.reason).toBe('unaffordable');
    expect(verdict.shortfall).toEqual({ minerals: 110, cores: 1 });
    expect(verdict.actionable).toBe(false);
  });

  it('refuses every row when there is no defender (unheld/undefended hex)', () => {
    expect(fitBotUpgrade(null, entry('wave_laser'), RICH, 1).reason).toBe(
      'not-sendable',
    );
  });
});

// ── Row builder ──────────────────────────────────────────────────────────

describe("botUpgradeRows — the screen's rows", () => {
  it('lists weapons, hulls and modifiers but never power-ups', () => {
    const rows = botUpgradeRows(payloadWith(plainDefender()), 'hex-held');
    const ids = rows.map((row) => row.entryId);
    expect(ids).toContain('wave_laser');
    expect(ids).toContain('hull-2');
    expect(ids).toContain('anti_maw_plating');
    expect(ids).not.toContain('bomb');
    expect(ids).not.toContain('magnet');
  });

  it('offers nothing for an unheld hex or a held hex with no defender', () => {
    const payload = payloadWith(plainDefender());
    payload.ring.hexes[0].held = false;
    expect(botUpgradeRows(payload, 'hex-held')).toEqual([]);

    const open = payloadWith(plainDefender());
    open.ring.hexes[0].defender = null;
    expect(botUpgradeRows(open, 'hex-held')).toEqual([]);

    expect(botUpgradeRows(payloadWith(plainDefender()), 'missing')).toEqual([]);
  });

  it('labels a row with its fit, both price kinds and the disabled reason', () => {
    const rows = botUpgradeRows(payloadWith(plainDefender()), 'hex-held');
    const newWeapon = rows.find((row) => row.entryId === 'wave_laser')!;
    expect(newWeapon.key).toBe(botUpgradeRowKey('wave_laser'));
    expect(newWeapon.label).toContain('NEW WEAPON');
    expect(newWeapon.label).toContain(botPriceLabel(newWeapon.price));

    const disabled = rows.find((row) => row.entryId === 'hardened_plating')!;
    expect(botUpgradeRowLabel(disabled)).toContain('NO BOT EFFECT');
  });
});

// ── Purchase economics ────────────────────────────────────────────────────

describe('buyBotUpgrade — spend, apply and recompute', () => {
  it('adds a new weapon kind at level 1 for exactly the catalogue price', () => {
    const payload = payloadWith(plainDefender());
    const result = buyBotUpgrade(payload, 'hex-held', 'wave_laser');
    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.spent).toEqual(entry('wave_laser').price);
    expect(result.payload.hangar.bankedMinerals).toBe(
      payload.hangar.bankedMinerals - entry('wave_laser').price.minerals,
    );
    expect(result.payload.hangar.bankedCores).toBe(
      payload.hangar.bankedCores - entry('wave_laser').price.cores,
    );
    const defender = result.payload.ring.hexes[0].defender!;
    expect(botWeaponLevel(defender, 'wave_laser')).toBe(1);
    expect(defender.upgradeSnapshot).toEqual(
      snapshotWithWeapons([{ id: 'wave_laser', level: 1 }]),
    );
  });

  it('raises a carried weapon one level for the Q9 = B per-level price', () => {
    const defender = plainDefender({
      upgradeSnapshot: snapshotWithWeapons([{ id: 'wave_laser', level: 1 }]),
    });
    const payload = payloadWith(defender);
    const result = buyBotUpgrade(payload, 'hex-held', 'wave_laser');
    expect(result.ok).toBe(true);
    expect(result.spent).toEqual(BOT_WEAPON_UPGRADE_PRICES[2]);
    expect(
      botWeaponLevel(result.payload.ring.hexes[0].defender!, 'wave_laser'),
    ).toBe(2);
  });

  it('recomputes the rating through the one shipped formula', () => {
    const payload = payloadWith(plainDefender());
    const result = buyBotUpgrade(payload, 'hex-held', 'wave_laser');
    const defender = result.payload.ring.hexes[0].defender!;
    const expected = defenderRatingFromSnapshot(
      deriveDefenderRating('hull-1'),
      defender.upgradeSnapshot!,
    );
    expect(defender.defenceRating).toBe(expected);
    expect(result.defenceRating).toBe(expected);
    // One firepower level → +2 rating on top of the hull's own rating.
    expect(expected).toBe(deriveDefenderRating('hull-1') + 2);
    expect(defenderStatBuckets(defender.upgradeSnapshot!).firepower).toBe(1);
  });

  it('re-hulls the bot while keeping the carried loadout', () => {
    const defender = plainDefender({
      upgradeSnapshot: snapshotWithWeapons([{ id: 'wave_laser', level: 2 }]),
    });
    const payload = payloadWith(defender);
    const result = buyBotUpgrade(payload, 'hex-held', 'hull-2');
    const bot = result.payload.ring.hexes[0].defender!;
    expect(bot.hullId).toBe('hull-2');
    expect(bot.upgradeSnapshot).toEqual(defender.upgradeSnapshot);
    expect(bot.defenceRating).toBe(
      defenderRatingFromSnapshot(
        deriveDefenderRating('hull-2'),
        defender.upgradeSnapshot!,
      ),
    );
  });

  it('trains a defence-skill modifier onto the bot', () => {
    const payload = payloadWith(plainDefender());
    const result = buyBotUpgrade(payload, 'hex-held', 'anti_maw_plating');
    expect(result.ok).toBe(true);
    expect(result.payload.ring.hexes[0].defender!.skills).toEqual([
      {
        id: 'maw-warded',
        name: 'Maw-warded',
        bossType: 'maw-of-ashes',
        bonus: 5,
      },
    ]);
  });

  it('refuses an unaffordable purchase and returns the payload unchanged', () => {
    const payload = payloadWith(plainDefender(), {
      bankedMinerals: 0,
      bankedCores: 0,
    });
    const before = JSON.parse(JSON.stringify(payload));
    const result = buyBotUpgrade(payload, 'hex-held', 'wave_laser');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unaffordable');
    expect(result.spent).toEqual({ minerals: 0, cores: 0 });
    expect(result.payload).toEqual(before);
  });

  it('refuses a slot-full purchase without touching the wallet', () => {
    const levels = Array.from({ length: POWER_UP_SLOT_CAP }, (_, index) => ({
      id: (index === 0 ? 'spread' : `kind-${index}`) as WeaponId,
      level: 1,
    }));
    const payload = payloadWith(
      plainDefender({ upgradeSnapshot: snapshotWithWeapons(levels) }),
    );
    const wallet = payload.hangar.bankedMinerals;
    const result = buyBotUpgrade(payload, 'hex-held', 'cluster');
    expect(result.reason).toBe('slot-full');
    expect(result.payload.hangar.bankedMinerals).toBe(wallet);
  });

  it('refuses an unknown entry id', () => {
    const result = buyBotUpgrade(
      payloadWith(plainDefender()),
      'hex-held',
      'not-a-real-entry',
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unknown');
  });

  it('never touches the fleet owned sets, active hull/loadout or deployed ship', () => {
    const payload = payloadWith(plainDefender());
    const before = {
      unlockedHulls: [...payload.hangar.unlockedHulls],
      unlockedWeapons: [...payload.hangar.unlockedWeapons],
      ownedModifiers: [...payload.hangar.ownedModifiers],
      activeHull: payload.hangar.activeHull,
      activeLoadout: JSON.parse(JSON.stringify(payload.hangar.activeLoadout)),
    };
    const result = buyBotUpgrade(payload, 'hex-held', 'wave_laser');
    // Only the wallet is spent; ownership, the active hull/loadout and what the
    // player deploys are untouched (producer Q7).
    expect({
      unlockedHulls: result.payload.hangar.unlockedHulls,
      unlockedWeapons: result.payload.hangar.unlockedWeapons,
      ownedModifiers: result.payload.hangar.ownedModifiers,
      activeHull: result.payload.hangar.activeHull,
      activeLoadout: result.payload.hangar.activeLoadout,
    }).toEqual(before);
    // The fleet does not gain the unlock: the bot gets the weapon, the fleet
    // does not (producer Q7).
    expect(result.payload.hangar.unlockedWeapons).not.toContain('wave_laser');
  });

  it('does not mutate the caller’s payload', () => {
    const payload = payloadWith(plainDefender());
    const before = JSON.parse(JSON.stringify(payload));
    buyBotUpgrade(payload, 'hex-held', 'wave_laser');
    expect(payload).toEqual(before);
  });
});

// ── Persistence round-trip and fall destruction ──────────────────────────

describe('bot upgrades persist and are destroyed with the bot', () => {
  it('round-trips the purchased upgrade state through the versioned store', () => {
    const purchased = buyBotUpgrade(
      payloadWith(plainDefender()),
      'hex-held',
      'wave_laser',
    );
    const store = createInMemoryHangarWarStorage();
    expect(saveHangarWarPayload(purchased.payload, store)).toBe(true);
    const loaded = loadHangarWarPayload(store);
    expect(loaded).not.toBeNull();
    const defender = loaded!.ring.hexes[0].defender!;
    expect(defender.upgradeSnapshot).toEqual(
      purchased.payload.ring.hexes[0].defender!.upgradeSnapshot,
    );
    expect(defender.defenceRating).toBe(
      purchased.payload.ring.hexes[0].defender!.defenceRating,
    );
  });

  it('destroys the bot and its upgrades when its hex falls in a defence tick', () => {
    // The fixture's hex-1 is held with an unheld neighbour (hex-2), so a queued
    // attack is answerable; an overwhelming force falls it.
    const payload: HangarWarPayload = JSON.parse(
      JSON.stringify(VALID_HANGAR_WAR_PAYLOAD),
    );
    payload.ring.hexes[0].defender = plainDefender({
      hullId: 'hull-2',
      upgradeSnapshot: snapshotWithWeapons([
        { id: 'wave_laser', level: 3 },
      ]),
      skills: [
        { id: 'maw-warded', name: 'Maw-warded', bossType: 'maw-of-ashes', bonus: 5 },
      ],
    });
    payload.pendingAttacks = [{ hexId: 'hex-1', force: 10_000 }];

    const { payload: next } = runFrontierTick(payload, {
      tuning: {
        ...DEFAULT_FRONTIER_TUNING,
        aggressionRiseMin: 0,
        aggressionRiseMax: 0,
        jitterPercent: 0,
        attackChancePercent: 0,
      },
    });

    const fallen = next.ring.hexes.find((hex) => hex.id === 'hex-1')!;
    expect(fallen.held).toBe(false);
    expect(fallen.defender).toBeNull();
  });
});
