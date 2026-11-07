import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Phaser from 'phaser';

import { bootScene } from '../test/gameHarness';
import {
  HUD,
  HUD_DEPTH,
  HUD_ROW_HEIGHT,
  NON_SLOT_SECTION_LABEL,
  NON_SLOT_SECTION_NAME,
  PERMANENT_VALUE,
  SLOT_BUDGET_NAME,
  SLOT_MARKER_ALWAYS_AVAILABLE,
  SLOT_MARKER_CHARGES_ONLY,
  buildHUDLabel,
  formatHUDValue,
  type HUDEntry,
  type HUDOptions,
} from './HUD';
import { EffectsRegistry } from '../powerups/effects';
import {
  ICON_COLORS,
  MIN_RING_SWEEP,
  POWER_UP_GREY_COLOUR,
  RING_RADIUS,
  RING_STROKE_WIDTH,
  weaponIconColour,
} from '../powerups/icons';
import {
  PowerUpLevelStore,
  resolvePowerUpAtLevel,
} from '../powerups/powerUpLevels';
import { POWER_UP_SLOT_CAP } from '../core/constants';
import {
  CONSUMABLE_POWER_UP_IDS,
  getPowerUpById,
  type PowerUpId,
} from '../powerups/types';
import { resolvePlayerSlotState } from '../powerups/slots';
import {
  SIX_SLOT_LOADOUT_IDS,
  buildSixSlotLoadout,
  isSlotCountedKind,
  slotCountedKinds,
  type SixSlotLoadoutId,
} from '../test/sixSlotLoadoutFixtures';


/**
 * A bare scene with no gym logic — proves the HUD attaches to ANY Phaser
 * scene (AC4: no gym-specific imports or logic required).
 */
class BareScene extends Phaser.Scene {
  constructor() {
    super({ key: 'BareScene' });
  }

  create(): void {
    // Empty on purpose.
  }
}

/** Boots a BareScene and attaches a HUD wired to `registry`. */
async function bootWithHUD(registry?: EffectsRegistry, options?: HUDOptions) {
  const { game, scene } = await bootScene([BareScene]);
  const hud = new HUD(scene, registry ?? null, options);
  return { game, scene, hud };
}

/** Text strings currently rendered by a HUD container. */
function hudTexts(hud: HUD): string[] {
  return (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list
    .filter((c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text)
    .map((c) => c.text);
}

const destroy = (game: Phaser.Game) => game.destroy(true);

// ── Grey-out contract helpers (AH-0MV82I8VA008LX0R) ──────────────────
//
// These read the not-yet-implemented grey-out contract by name where the
// production type does not yet carry it, mirroring the repository's
// test-first convention (powerUpLevels.test.ts reads the recharge axes by
// name). Once AH-0MV82I97Y007MB6M lands, the `greyed` field becomes a hard
// part of the HUD model and the guards can be dropped.

/** Reads a row's `greyed` flag (undefined until the HUD implements it). */
function rowGreyed(row: HUDEntry | undefined): boolean | undefined {
  return (row as unknown as { greyed?: boolean } | undefined)?.greyed;
}

/** The direct children of a HUD container (rows are rebuilt on refresh). */
function hudChildren(hud: HUD): Phaser.GameObjects.GameObject[] {
  return (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
}

/** Locates a row's label/value Text objects by their rendered strings. */
function rowTexts(
  hud: HUD,
  label: string,
  value: string,
): {
  labelText?: Phaser.GameObjects.Text;
  valueText?: Phaser.GameObjects.Text;
} {
  const texts = hudChildren(hud).filter(
    (c): c is Phaser.GameObjects.Text => c instanceof Phaser.GameObjects.Text,
  );
  return {
    labelText: texts.find((t) => t.text === label),
    valueText: texts.find((t) => t.text === value),
  };
}

/**
 * The icon Graphics rendered immediately before a row's label Text (rows are
 * added as `[icon, label, value]`, so the nearest preceding Graphics is the
 * row icon).
 */
function rowIcon(
  hud: HUD,
  label: string,
): Phaser.GameObjects.Graphics | undefined {
  const list = hudChildren(hud);
  const labelIndex = list.findIndex(
    (c) => c instanceof Phaser.GameObjects.Text && c.text === label,
  );
  if (labelIndex < 0) return undefined;
  for (let i = labelIndex - 1; i >= 0; i--) {
    if (list[i] instanceof Phaser.GameObjects.Graphics) {
      return list[i] as Phaser.GameObjects.Graphics;
    }
  }
  return undefined;
}

/** Parses a `#rrggbb` text colour into a 24-bit number (undefined otherwise). */
function textColour(text?: Phaser.GameObjects.Text): number | undefined {
  const colour = text?.style?.color;
  if (typeof colour !== 'string') return undefined;
  const hex = colour.startsWith('#') ? colour.slice(1) : colour;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return parseInt(hex, 16);
}

/**
 * The first `lineStyle` stroke colour a Graphics emitted — the row icon's
 * outline colour (Phaser `LINE_STYLE` command opcode is 6, followed by
 * lineWidth, colour, alpha).
 */
function firstStrokeColour(
  graphics?: Phaser.GameObjects.Graphics,
): number | undefined {
  const buf = graphics?.commandBuffer as number[] | undefined;
  if (!buf || buf[0] !== 6 || typeof buf[2] !== 'number') return undefined;
  return buf[2];
}

describe('HUD AC4: standalone scene attachability', () => {
  it('constructs with any Phaser scene and is added to the display list', async () => {
    const { game, scene, hud } = await bootWithHUD(new EffectsRegistry());
    expect(scene.children.list).toContain(hud);
    destroy(game);
  });

  it('renders above gameplay (depth above default game objects)', async () => {
    const { game, scene, hud } = await bootWithHUD(new EffectsRegistry());
    // A typical gameplay object sits at the default depth 0.
    const gameplay = scene.add.text(0, 0, 'gameplay', {});
    expect(gameplay.depth).toBeLessThan(hud.depth);
    expect(hud.depth).toBe(HUD_DEPTH);
    destroy(game);
  });

  it('works without a registry (standalone, idempotent)', async () => {
    const { game, hud } = await bootWithHUD();
    hud.refresh(); // no crash, no rows, no lives label yet
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });
});

describe('HUD AC1: one row per active power-up with the current level', () => {
  it('renders a single merged row: level in the label, timer in the value', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost'); // active, 10 s remaining at level 1
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('speed_boost');
    expect(rows[0].name).toBe('Speed Boost');
    expect(rows[0].label).toBe('Speed Boost Lvl 1');
    expect(rows[0].level).toBe(1);
    expect(rows[0].temporary).toBe(true);
    expect(rows[0].icon).toBe('speed_boost');
    expect(rows[0].value).toBe('10s');
    expect(hudTexts(hud)).toContain('Speed Boost Lvl 1');
    destroy(game);
  });

  it('counts down: the remaining-seconds timer decrements', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('10s');

    reg.tick(1); // one second passes
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('9s');

    reg.tick(7);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('2s');
    destroy(game);
  });

  it('renders multiple timed effects with no cross-contamination of values', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.tick(8);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].value).toBe('2s');
    destroy(game);
  });

  it('raises the label level on a second collection (effective level)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 2');
    expect(hud.getRows()[0].level).toBe(2);
    destroy(game);
  });
});

describe('HUD: permanent level-up window shows ∞ (AH-0MUX802450085VZZ)', () => {
  it('a hold-full reward raises the level permanently and shows ∞ (no timer)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows()[0];
    expect(row.label).toBe('Speed Boost Lvl 1');
    expect(row.temporary).toBe(false);
    expect(row.value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('a field pickup on a permanent base shows a timer, then reverts to ∞ — one row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost', true); // permanent base, level 1, no timeout
    reg.applyCollect('speed_boost'); // temporary field pickup, level 2, 10 s window
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    // Exactly one row for the item (permanent + temporary merged).
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 2');
    expect(hud.getRows()[0].temporary).toBe(true);
    expect(hud.getRows()[0].value).toBe(
      `${Math.ceil(resolvePowerUpAtLevel('speed_boost', 1).speedDuration!)}s`,
    );

    // Window expiry: level reverts to the permanent level and the value
    // becomes ∞ — still exactly one row.
    reg.tick(13);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 1');
    expect(hud.getRows()[0].temporary).toBe(false);
    expect(hud.getRows()[0].value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('a timed field pickup that expires leaves no row when nothing is permanent', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);

    reg.tick(10.5);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });
});

describe('HUD AC2: permanent stack power-ups merge into one row', () => {
  it('shows a single P9 magnet row at the effective level with ∞', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('magnet');
    expect(rows[0].name).toBe('Magnet');
    expect(rows[0].icon).toBe('magnet');
    expect(rows[0].label).toBe('Magnet Lvl 3');
    expect(rows[0].value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('merges a permanent stack with a timed field pickup into one row (timer, then ∞)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet', true); // permanent stack, level 1
    reg.applyCollect('magnet'); // timed field pickup, level 2, 15 s
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    // The previous design showed TWO Magnet rows here; one row is required.
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 2');
    expect(hud.getRows()[0].value).toBe('15s');

    reg.tick(15.5);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 1');
    expect(hud.getRows()[0].value).toBe(PERMANENT_VALUE);
    destroy(game);
  });

  it('shows a timed P9 field pickup as a countdown, then drops the row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet'); // field pickup → 15 s timed effect
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('magnet');
    expect(rows[0].label).toBe('Magnet Lvl 1');
    expect(rows[0].value).toBe('15s');

    reg.tick(15.5);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });

  it('increments the level as more permanent stacks are collected', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('magnet', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 1');

    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 3');
    destroy(game);
  });
});

describe('HUD P3 shield remaining absorptions (AH-0MUVM9RAO004Y3LB)', () => {
  it('shows the level and remaining absorptions as ×N, decrementing on absorb', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield'); // level 1 → 1 absorption
    reg.applyCollect('shield'); // level 2 → more absorptions
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'shield')!;
    expect(row.label).toBe(
      `Shield Lvl 2 ×${reg.shieldAbsorptionsRemaining()}`,
    );
    // The absorbed-hit pickup model (parent AH-0MVUVSW4J0009QUW AC3): a field
    // pickup opens only a temporary-**level** window, so the value column
    // renders the ∞ glyph — never a `Ns` cover the one-event charge alone
    // cannot honour, even though a level window is genuinely open.
    expect(reg.powerUpTemporaryRemaining('shield')).toBeGreaterThan(0);
    expect(row.temporary).toBe(false);
    expect(row.value).toBe(PERMANENT_VALUE);

    reg.tryAbsorbShield();
    hud.refresh();
    const updated = hud.getRows().find((r) => r.id === 'shield')!;
    expect(updated.label).toBe(
      `Shield Lvl 2 ×${reg.shieldAbsorptionsRemaining()}`,
    );
    destroy(game);
  });

  it('greys the P3 row once the last charge is spent and hides it at the level TTL', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('shield'); // level 1 → 1 charge
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'shield')).toBe(true);

    // Spending the last charge disarms the shield but the temporary level
    // stack keeps the row visible (greyed) until its own TTL expires (parent
    // AH-0MVUVSW4J0009QUW AC3).
    reg.tryAbsorbShield();
    hud.refresh();
    const row = hud.getRows().find((r) => r.id === 'shield')!;
    expect(row).toBeDefined();
    expect(row.greyed).toBe(true);

    // The temporary-level TTL expiry releases the row (field-only rule).
    reg.tick((reg.powerUpTemporaryRemaining('shield') ?? 0) + 0.1);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'shield')).toBe(false);
    destroy(game);
  });
});

describe('HUD pickup-row states for the budget kinds (AH-0MVVD8S4J007L8KX)', () => {
  /** Spends one granted field-pickup charge through the kind's seam. */
  function spendFieldCharge(reg: EffectsRegistry, id: PowerUpId): boolean {
    switch (id) {
      case 'thorns':
        return reg.tryConsumeThornsRam();
      case 'force_field':
        return reg.tryConsumeForceFieldReflect();
      default:
        throw new Error(`no one-event spend seam for ${id}`);
    }
  }

  // Shield's equivalent pickup-row states are pinned in the P3 describe above
  // (charge count and no-window-countdown ∞ in the first test, greyed-empty
  // and hide-at-TTL in the "greys the P3 row" test); these two kinds complete
  // the per-kind set.
  for (const id of ['thorns', 'force_field'] as PowerUpId[]) {
    it(`${id}: shows the pickup charge, no phantom countdown, greyed empty and hides at the level TTL`, async () => {
      const reg = new EffectsRegistry();
      reg.applyCollect(id); // one pickup charge, no effect window
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      // The row carries exactly the granted charge; a pickup-only charge is
      // never owed back, so no phantom countdown appears (Q-A1=b).
      const armed = hud.getRows().find((r) => r.id === id)!;
      expect(armed).toBeDefined();
      expect(armed.stacks).toBe(1);
      expect(armed.greyed).toBe(false);
      expect(armed.recharge).toBeUndefined();
      expect(armed.label).not.toContain('next in');
      // The temporary level window is genuinely open, yet the row renders ∞:
      // for the absorbed-hit kinds the pickup effect is the one granted
      // charge, not a timed cover, so no window countdown may appear (parent
      // AH-0MVUVSW4J0009QUW AC3).
      expect(reg.powerUpTemporaryRemaining(id)).toBeGreaterThan(0);
      expect(armed.temporary).toBe(false);
      expect(armed.value).toBe(PERMANENT_VALUE);

      // The one spent charge empties the pool: the temporary level stack
      // keeps the row visible but greyed until its own TTL expires.
      expect(spendFieldCharge(reg, id)).toBe(true);
      hud.refresh();
      const spent = hud.getRows().find((r) => r.id === id)!;
      expect(spent).toBeDefined();
      expect(spent.greyed).toBe(true);
      expect(spent.stacks).toBeUndefined();
      expect(spent.label).not.toContain('×0');
      expect(spent.recharge).toBeUndefined(); // nothing is owed back
      expect(spent.value).toBe(PERMANENT_VALUE); // greyed, still no countdown

      // The temporary-level TTL expiry releases the row (field-only rule).
      reg.tick((reg.powerUpTemporaryRemaining(id) ?? 0) + 0.1);
      hud.refresh();
      expect(hud.getRows().some((r) => r.id === id)).toBe(false);
      destroy(game);
    });
  }
});

describe('HUD P6 auto-activation readiness display (parent AH-0MW6O1690007P2SL)', () => {
  it('shows the single-use readiness state and a countdown while the pickup window is open', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift'); // level 1 → one ready activation
    reg.applyCollect('phase_shift'); // level 2 → still one ready activation
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'phase_shift')!;
    // Single-use: no stored count — the row reads `(ready)`.
    expect(row.label).toBe('Phase Shift Lvl 2 (ready)');
    expect(row.stacks).toBeUndefined();
    // A field pickup now opens a temporary level window, so the value is a
    // countdown — not the infinity glyph (AH-0MVUGI448000GNMJ).
    expect(row.temporary).toBe(true);
    expect(row.value).toMatch(/s$/);

    // Once the window expires the pickup-only readiness ends with it, so the
    // row disappears (a permanent ownership would keep it).
    reg.tick(reg.powerUpTemporaryRemaining('phase_shift')! + 0.1);
    hud.refresh();
    expect(hud.getRows().find((r) => r.id === 'phase_shift')).toBeUndefined();
    destroy(game);
  });

  it('merges the active phase timer and the readiness countdown into one row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('phase_shift');
    reg.applyCollect('phase_shift');
    reg.updateDanger(true, 0.016); // spends the activation, starts the recharge
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const rows = hud.getRows().filter((r) => r.id === 'phase_shift');
    expect(rows).toHaveLength(1);
    expect(rows[0].temporary).toBe(true);
    expect(rows[0].value).toMatch(/s$/);
    expect(rows[0].label).toContain('(next in ');
    expect(rows[0].stacks).toBeUndefined();
    destroy(game);
  });

  it(
    'shows the permanent reward as a single-use readiness state, not an unlimited supply',
    async () => {
      const store = new PowerUpLevelStore();
      const reg = new EffectsRegistry(store);
      store.collect('phase_shift', true); // hold-full: owned + one ready activation
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();
      const p6 = hud.getRows().find((r) => r.id === 'phase_shift')!;
      // Single-use readiness — never a stored count.
      expect(p6.label).toBe('Phase Shift Lvl 1 (ready)');
      expect(p6.stacks).toBeUndefined();
      // `∞` still means the level is permanent for the run (GDD §4.5), not
      // an unlimited activation supply.
      expect(p6.value).toBe(PERMANENT_VALUE);
      destroy(game);
    },
  );

  it('does not show a misleading x0 when no charges remain', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().filter((r) => r.id === 'phase_shift')).toHaveLength(0);
    destroy(game);
  });

  it('formats countdown and permanent values distinctly', () => {
    expect(formatHUDValue(true, 4.2)).toBe('5s');
    expect(formatHUDValue(true, 0)).toBe('0s');
    expect(formatHUDValue(false, 10)).toBe(PERMANENT_VALUE);
  });
});

describe('HUD grey-out for empty recharge pools (AH-0MV82I8VA008LX0R — test-first)', () => {
  /**
   * Grey-out contract for the HUD implemented by AH-0MV82I97Y007MB6M
   * ("HUD grey-out for zero-charge power-up rows"). Written test-first as
   * `it.fails(...)` expected failures by the test item and hard-gated here
   * once the implementation landed.
   *
   * Contract pinned here:
   * - a row is `greyed` when the player **owns** a consumable that is
   *   currently unavailable: a pooled kind (Shield / Thorn Field / Force
   *   Field / Mystery UFO) with **zero** charges, or a single-use kind
   *   (Phase Shift / Teleport) whose one activation is recharging;
   * - an owned-but-empty row stays **visible** (never hidden);
   * - the icon + label + value share one desaturated grey colour so they
   *   cannot diverge;
   * - charge-count labels surface the finite `×N` count (including the
   *   recharged value) without the unlimited marker;
   * - non-charge rows and charged rows render unchanged.
   */
  /** A registry backed by a store the test can drive directly. */
  function storeRegistry(): {
    store: PowerUpLevelStore;
    reg: EffectsRegistry;
  } {
    const store = new PowerUpLevelStore();
    return { store, reg: new EffectsRegistry(store) };
  }

  it(
    'greys out an owned Phase Shift row while it recharges',
    async () => {
      const { store, reg } = storeRegistry();
      store.collect('phase_shift', true); // hold-full: owned and ready
      store.consumePhaseCharge(); // spent → the one activation recharges
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const row = hud.getRows().find((r) => r.id === 'phase_shift');
      expect(row).toBeDefined();
      expect(rowGreyed(row)).toBe(true);
      destroy(game);
    },
  );

  it(
    'renders the owned Phase Shift row normally while it is ready',
    async () => {
      const { store, reg } = storeRegistry();
      store.collect('phase_shift', true); // owned, ready (single-use)
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const row = hud.getRows().find((r) => r.id === 'phase_shift');
      expect(row).toBeDefined();
      expect(rowGreyed(row)).toBe(false);
      destroy(game);
    },
  );

  it(
    'keeps an owned Teleport row visible and greyed while its one warp recharges',
    async () => {
      const { store, reg } = storeRegistry();
      store.collect('teleport', true); // hold-full: owned, warp ready
      store.consumeTeleport(); // spent → recharging, no count to bank
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const row = hud.getRows().find((r) => r.id === 'teleport');
      expect(row).toBeDefined();
      expect(rowGreyed(row)).toBe(true);
      destroy(game);
    },
  );

  it(
    'renders the owned Teleport row normally while its warp is ready',
    async () => {
      const { store, reg } = storeRegistry();
      store.collect('teleport', true); // owned, ready
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const row = hud.getRows().find((r) => r.id === 'teleport');
      expect(row).toBeDefined();
      expect(rowGreyed(row)).toBe(false);
      destroy(game);
    },
  );

  it(
    'surfaces readiness rather than a count, and restores it after a recharge',
    async () => {
      const { store, reg } = storeRegistry();
      store.collect('phase_shift', true); // single-use: ready, never ×1
      store.collect('teleport', true); // single-use: ready, never ×1
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const phase = () => hud.getRows().find((r) => r.id === 'phase_shift');
      const tele = () => hud.getRows().find((r) => r.id === 'teleport');

      // Both single-use kinds surface readiness only — no stored count.
      expect(phase()!.label).toBe('Phase Shift Lvl 1 (ready)');
      expect(phase()!.stacks).toBeUndefined();
      expect(tele()!.label).toBe('Teleport Lvl 1 (ready)');
      expect(tele()!.stacks).toBeUndefined();

      // Spending starts each one's recharge, so both rows grey out…
      store.consumePhaseCharge();
      store.consumeTeleport();
      hud.refresh();
      expect(rowGreyed(phase())).toBe(true);
      expect(rowGreyed(tele())).toBe(true);

      // …and a completed recharge restores the ready state.
      store.tickRecharge(store.phaseRechargeTime());
      store.tickRecharge(store.teleportRechargeTime());
      hud.refresh();
      expect(phase()!.label).toBe('Phase Shift Lvl 1 (ready)');
      expect(tele()!.label).toBe('Teleport Lvl 1 (ready)');
      expect(tele()!.recharge).toBeUndefined();
      expect(rowGreyed(phase())).toBe(false);
      expect(rowGreyed(tele())).toBe(false);
      destroy(game);
    },
  );

  it(
    'greys the icon and the label/value text with one shared grey',
    async () => {
      const { store, reg } = storeRegistry();
      store.collect('phase_shift', true);
      store.consumePhaseCharge(); // owned, empty
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const row = hud.getRows().find((r) => r.id === 'phase_shift')!;
      const { labelText, valueText } = rowTexts(hud, row.label, row.value);
      const labelColour = textColour(labelText);
      const valueColour = textColour(valueText);
      const iconColour = firstStrokeColour(rowIcon(hud, row.label));

      expect(labelColour).toBeDefined();
      expect(labelColour).not.toBe(0xffffff); // not the normal, active white
      expect(valueColour).toBe(labelColour); // label + value grey together
      expect(iconColour).toBe(labelColour); // the icon shares the same grey

      // A desaturated grey (r = g = b), so the row reads as inactive.
      expect((labelColour! >> 16) & 0xff).toBe((labelColour! >> 8) & 0xff);
      expect((labelColour! >> 8) & 0xff).toBe(labelColour! & 0xff);
      destroy(game);
    },
  );

  it(
    'reports greyed:false for a charged non-charge row (no cross-contamination)',
    async () => {
      const { reg } = storeRegistry();
      reg.applyCollect('speed_boost'); // activate the timed effect → row visible
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const row = hud.getRows().find((r) => r.id === 'speed_boost');
      expect(row).toBeDefined();
      expect(rowGreyed(row)).toBe(false);
      destroy(game);
    },
  );

  it('keeps the Teleport row hidden until the player owns it', async () => {
    // The corresponding never-owned Phase Shift case is already pinned by
    // the P6 suite above; this covers the Teleport sibling (AC3).
    const { reg } = storeRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'teleport')).toBe(false);
    destroy(game);
  });

  it('leaves a ready row visually unchanged (white label + value)', async () => {
    const { store, reg } = storeRegistry();
    store.collect('phase_shift', true); // owned, ready (single-use)
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'phase_shift')!;
    const { labelText, valueText } = rowTexts(hud, row.label, row.value);
    expect(textColour(labelText)).toBe(0xffffff);
    expect(textColour(valueText)).toBe(0xffffff);
    destroy(game);
  });
});

describe('HUD label builder (AH-0MUX802450085VZZ)', () => {
  it('appends a positive consumable count as ×N and omits zero/undefined', () => {
    expect(buildHUDLabel('Shield', 2, 2)).toBe('Shield Lvl 2 ×2');
    expect(buildHUDLabel('Shield', 2, undefined)).toBe('Shield Lvl 2');
    expect(buildHUDLabel('Shield', 2, 0)).toBe('Shield Lvl 2');
  });

  it('appends a recharge countdown when one is in progress (AH-0MVJ8YKR70096C6T)', () => {
    expect(buildHUDLabel('Thorn Field', 1, 1, 7.2)).toBe(
      'Thorn Field Lvl 1 ×1 (next in 8s)',
    );
    // A permanent field sitting at zero charges still shows its countdown.
    expect(buildHUDLabel('Thorn Field', 1, undefined, 4)).toBe(
      'Thorn Field Lvl 1 (next in 4s)',
    );
    expect(buildHUDLabel('Thorn Field', 1, 1, 0)).toBe('Thorn Field Lvl 1 ×1');
  });

  it('appends a `ready` state for a single-use kind with no countdown (AH-0MW231O8Q0095LQM)', () => {
    expect(buildHUDLabel('Teleport', 1, undefined, undefined, true)).toBe(
      'Teleport Lvl 1 (ready)',
    );
    // A live recharge always wins: a row can never read `ready` mid-countdown.
    expect(buildHUDLabel('Teleport', 1, undefined, 4.2, true)).toBe(
      'Teleport Lvl 1 (next in 5s)',
    );
    // Without the flag the label is byte-for-byte unchanged (pooled kinds).
    expect(buildHUDLabel('Shield', 1, 1)).toBe('Shield Lvl 1 ×1');
    expect(buildHUDLabel('Shield', 1, 1, 7.2)).toBe(
      'Shield Lvl 1 ×1 (next in 8s)',
    );
  });
});

describe('HUD Thorn Field recharge countdown (AH-0MVJ8YKR70096C6T)', () => {
  it('shows the remaining rams plus the next-recharge countdown while recharging', async () => {
    const reg = new EffectsRegistry();
    // Two hold-full grants fill the level-0 pool (cap 2): one charge is spent
    // below, so the row still shows a remaining ram alongside the countdown
    // (parent AH-0MVTQMREN009DSFW AC1).
    reg.applyCollect('thorns', true);
    reg.applyCollect('thorns', true);
    reg.tryConsumeThornsRam();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'thorns')!;
    expect(row).toBeDefined();
    expect(row.stacks).toBe(reg.thornsMaxAbsorbs() - 1);
    expect(row.recharge).toBeGreaterThan(0);
    expect(row.label).toContain('Thorn Field');
    expect(row.label).toContain(`×${reg.thornsMaxAbsorbs() - 1}`);
    expect(row.label).toContain('next in');

    // Once the ram is back, the countdown clears (the row is a full budget).
    reg.tick(reg.thornsRechargeTime() + 0.01);
    hud.refresh();
    const refilled = hud.getRows().find((r) => r.id === 'thorns')!;
    expect(refilled.recharge).toBeUndefined();
    expect(refilled.label).not.toContain('next in');
    destroy(game);
  });

  it('keeps a permanent field at zero charges labelled with its countdown', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('thorns', true);
    while (reg.thornsRemaining() > 0) reg.tryConsumeThornsRam();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'thorns')!;
    expect(row.stacks).toBeUndefined();
    expect(row.label).toContain('(next in');
    destroy(game);
  });
});

// ── Orbital Strike next-bolt countdown (AH-0MVS2T40T006QL7H) ─────────
//
// TEST-FIRST (AH-0MVS2SW8V007ZBJQ, parent AC6): a permanent strike's row is a
// bare `∞` label today, so a 10–30 s interval reads as an inert power-up. The
// countdown must reuse the shared `next in Ns` formatter (`buildHUDLabel`) and
// be driven by the shared registry state, never recomputed in the HUD.

/** The not-yet-existing latch acknowledgement on `EffectsRegistry`. */
interface StrikeLatchRegistry {
  resolveStrike(): void;
}

/**
 * Acknowledges the bolt the shared core has just landed. The retention
 * contract (AH-0MVS2T2DJ0069C0Y) keeps a due bolt latched until it is
 * acknowledged, so a test that wants the *interval* running must resolve the
 * opening bolt — read by name, per the repo's test-first convention.
 */
function ackStrike(reg: EffectsRegistry): void {
  (reg as unknown as StrikeLatchRegistry).resolveStrike();
}

/** Advances the shared strike clock, landing any bolt that comes due. */
function advanceStrikeClock(reg: EffectsRegistry, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 0.1) {
    if (reg.updateStrike(0.1)) ackStrike(reg);
  }
}

describe('HUD Orbital Strike next-bolt countdown (AH-0MVS2T40T006QL7H)', () => {
  it('shows a live next-bolt countdown on the permanent strike row', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike', true); // hold-full (permanent) reward
    const interval = reg.strikeInterval();
    ackStrike(reg); // the opening bolt lands — the interval is now running

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'strike')!;
    expect(row).toBeDefined();
    expect(row.label).toContain('Orbital Strike');
    expect(row.label).toContain('(next in');
    // The first grant fires every 9 beats of the 80 BPM grid (6.75 s), so the
    // rounded label reads "next in 7s" — the producer's ~7 s cadence
    // (AH-0MVRE6N08001TE4V).
    expect(row.label).toContain('(next in 7s)');
    // The value column still reads `∞` — the row is permanent, the countdown
    // lives in the label via the shared formatter.
    expect(row.value).toBe(PERMANENT_VALUE);

    const first = row.recharge;
    expect(first).toBeDefined();
    expect(first!).toBeGreaterThan(0);
    expect(first!).toBeLessThanOrEqual(interval);
    expect(row.label).toContain(`(next in ${Math.ceil(first!)}s)`);

    // The countdown is live: advancing the shared strike clock decreases it.
    advanceStrikeClock(reg, 3);
    hud.refresh();
    const second = hud.getRows().find((r) => r.id === 'strike')!;
    expect(second.recharge).toBeDefined();
    expect(second.recharge!).toBeLessThan(first!);
    expect(second.recharge!).toBeGreaterThan(0);
    expect(second.label).toContain(`(next in ${Math.ceil(second.recharge!)}s)`);

    // A bolt that lands resets the countdown — never negative, never NaN.
    advanceStrikeClock(reg, interval);
    hud.refresh();
    const afterBolt = hud.getRows().find((r) => r.id === 'strike')!;
    expect(afterBolt.recharge).toBeDefined();
    expect(afterBolt.recharge!).toBeGreaterThan(0);
    expect(afterBolt.label).not.toContain('NaN');
    expect(afterBolt.label).not.toMatch(/next in -/);

    destroy(game);
  });

  it('keeps a field-pickup-only strike off the HUD (no permanent row)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('strike'); // one-shot pickup, mirrors the Smart Bomb

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    expect(hud.getRows().some((r) => r.id === 'strike')).toBe(false);
    destroy(game);
  });
});

describe('HUD AC3: lives counter (P8)', () => {
  it('displays the lives state, starting at 3', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getLivesValue()).toBe(3);
    expect(hud.getLivesLabel()).toBe('Lives: 3');
    destroy(game);
  });

  it('updates on P8 collection (4 after one pickup; cap 5)', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    reg.applyCollect('extra_life');
    hud.refresh();
    expect(hud.getLivesValue()).toBe(4);
    expect(hud.getLivesLabel()).toBe('Lives: 4');

    reg.applyCollect('extra_life');
    hud.refresh();
    expect(hud.getLivesValue()).toBe(5);
    expect(hud.getLivesLabel()).toBe('Lives: 5');
    destroy(game);
  });
});

describe('HUD AC5: reacts to registry changes', () => {
  it('removes a row when the effect timer expires', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(1);

    reg.tick(10.5); // expires
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);
    destroy(game);
  });

  it('updates a row when a timed effect is refreshed (re-collect)', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    reg.tick(6); // 4 s left
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()[0].value).toBe('4s');

    reg.applyCollect('speed_boost'); // re-collect → refresh to the level-2 duration
    hud.refresh();
    const upgraded = Math.ceil(
      resolvePowerUpAtLevel('speed_boost', 1).speedDuration!,
    );
    expect(hud.getRows()[0].value).toBe(`${upgraded}s`);
    expect(hud.getRows()[0].label).toBe('Speed Boost Lvl 2');
    destroy(game);
  });

  it('adds a row when a new effect is collected', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows()).toHaveLength(0);

    reg.applyCollect('speed_boost');
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet', true);
    hud.refresh();
    const rows = hud.getRows();
    expect(rows).toHaveLength(2); // Speed Boost timed row + Magnet permanent row
    const ids = rows.map((r) => r.id);
    expect(ids).toContain('speed_boost');
    expect(ids).toContain('magnet');
    destroy(game);
  });
});
describe('HUD Mystery UFO row (AH-0MV1BIXFO006Z1I7)', () => {
  it('renders a countdown while a field-pickup window is open and ∞ once settled', async () => {
    const reg = new EffectsRegistry();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'mystery_ufo'), 'no row before pickup').toBe(false);

    reg.applyCollect('mystery_ufo');
    hud.refresh();
    const row = hud.getRows().find((r) => r.id === 'mystery_ufo')!;
    expect(row, 'row defined after pickup').toBeDefined();
    expect(row.name, 'row name').toBe('Mystery UFO');
    expect(row.label, 'row label').toBe('Mystery UFO Lvl 1');
    // A field pickup now opens a temporary level window → countdown, not the
    // infinity glyph (AH-0MVUGI448000GNMJ).
    expect(row.temporary).toBe(true);
    expect(row.value).toMatch(/s$/);

    // Expiry clears the temporary level, so a field-only row disappears.
    reg.tick(reg.powerUpTemporaryRemaining('mystery_ufo')! + 0.1);
    hud.refresh();
    expect(hud.getRows().some((r) => r.id === 'mystery_ufo'), 'row gone after expiry').toBe(false);

    // A hold-full reward is permanent and opens no window → ∞.
    reg.applyCollect('mystery_ufo', true);
    hud.refresh();
    const permanent = hud.getRows().find((r) => r.id === 'mystery_ufo')!;
    expect(permanent, 'permanent row defined').toBeDefined();
    expect(permanent.temporary, 'permanent row not temporary').toBe(false);
    expect(permanent.value, 'permanent row value').toBe(PERMANENT_VALUE);
    destroy(game);
  });
});

describe('HUD temporary window on the newly windowed kinds (AH-0MVUGI4WG008HU3M AC3)', () => {
  /**
   * The one-shot kinds that show a row only while permanently owned. A field
   * pickup on top of the permanent base opens a temporary level window, so the
   * row must read a live countdown and then settle back to `∞`; a field-only
   * pickup must still leave no row (the parent's row-visibility rule).
   */
  const PERMANENT_ROW_KINDS = ['bomb', 'smart_bomb', 'strike'] as const;

  /** Parses the whole-second countdown out of a `Ns` value column. */
  function countdownSeconds(value: string): number {
    expect(value).toMatch(/^\d+s$/);
    return Number.parseInt(value, 10);
  }

  for (const id of PERMANENT_ROW_KINDS) {
    it(`${id}: a permanent row counts down during a field window, then reads ∞`, async () => {
      const reg = new EffectsRegistry();
      reg.applyCollect(id, true); // permanent base → row, ∞
      reg.applyCollect(id, false); // field pickup → temporary level window
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      const during = hud.getRows().find((r) => r.id === id)!;
      expect(during).toBeDefined();
      expect(during.temporary).toBe(true);
      const opened = countdownSeconds(during.value);
      expect(opened).toBeGreaterThan(0);

      // The countdown is live, not a frozen snapshot.
      reg.tick(1);
      hud.refresh();
      const ticked = hud.getRows().find((r) => r.id === id)!;
      expect(countdownSeconds(ticked.value)).toBe(opened - 1);

      // Expiry reverts the temporary level: the permanent base keeps the row
      // and the value settles on ∞.
      reg.tick(reg.powerUpTemporaryRemaining(id)! + 0.1);
      hud.refresh();
      const settled = hud.getRows().find((r) => r.id === id)!;
      expect(settled.temporary).toBe(false);
      expect(settled.value).toBe(PERMANENT_VALUE);
      destroy(game);
    });

    it(`${id}: a field-only pickup opens a window but leaves no row`, async () => {
      const reg = new EffectsRegistry();
      reg.applyCollect(id, false);
      expect(reg.powerUpTemporaryRemaining(id)).toBeGreaterThan(0);

      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      expect(hud.getRows().some((r) => r.id === id)).toBe(false);
      destroy(game);
    });
  }

  // Teleport is single-use (parent AH-0MVY096RT006QMF4): its row carries no
  // stack count, and a field-only pickup's readiness ends with its window —
  // the row is only kept alive by permanent ownership or a live pickup level.
  it('teleport: the row counts down during the field window and carries no stack count', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport', false); // field pickup: temporary level, one ready warp
    expect(reg.hasTeleport()).toBe(true);

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const during = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(during.temporary).toBe(true);
    // No stored count is ever published for a single-use kind.
    expect(during.stacks).toBeUndefined();
    expect(during.label).toBe('Teleport Lvl 1 (ready)');
    const opened = countdownSeconds(during.value);

    reg.tick(1);
    hud.refresh();
    const teleportValue = () =>
      hud.getRows().find((r) => r.id === 'teleport')!.value;
    expect(countdownSeconds(teleportValue())).toBe(opened - 1);

    reg.tick(reg.powerUpTemporaryRemaining('teleport')! + 0.1);
    hud.refresh();
    // The level reverted and Teleport is not permanently owned → not held,
    // so the readiness model has nothing left to show.
    expect(reg.powerUpLevel('teleport')).toBe(0);
    expect(reg.hasTeleport()).toBe(false);
    expect(hud.getRows().some((r) => r.id === 'teleport')).toBe(false);
    destroy(game);
  });

  it('teleport: a permanently owned row stays visible and greys out while recharging', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('teleport', true); // hold-full grant: owned + ready

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const ready = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(ready.greyed).toBe(false);
    expect(ready.stacks).toBeUndefined();
    expect(ready.recharge).toBeUndefined();

    // Spend the warp: the row survives (owned) and counts the recharge down.
    reg.consumeTeleport();
    hud.refresh();
    const recharging = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(recharging.greyed).toBe(true);
    expect(recharging.recharge).toBeCloseTo(reg.teleportRechargeTime());
    expect(recharging.label).toContain('next in');

    // Ready again after the shared recharge clock completes the interval.
    reg.tick(reg.teleportRechargeTime() + 0.01);
    hud.refresh();
    const settled = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(settled.greyed).toBe(false);
    expect(settled.recharge).toBeUndefined();
    destroy(game);
  });
});

describe('HUD lives list layout (AH-0MU7JTFY1006QA8I)', () => {
  /** Rendered HUD texts, in container iteration order. */
  function hudTextObjects(hud: HUD): Phaser.GameObjects.Text[] {
    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] }).list;
    return list.filter((c) => c instanceof Phaser.GameObjects.Text);
  }

  it('AC1 — with lives shown, the first effect row starts below the lives label', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost'); // timed row: Speed Boost
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const texts = hudTextObjects(hud);
    const lives = texts.find((t) => t.text.startsWith('Lives: '));
    const firstRow = texts.find((t) => t.text === 'Speed Boost Lvl 1');
    expect(lives).toBeDefined();
    expect(firstRow).toBeDefined();

    // Bounds/y-order assertion: the effect list is pushed below the lives
    // label, so its first row cannot overlap the label's vertical span.
    expect(firstRow!.y).toBeGreaterThanOrEqual(
      lives!.y + HUD_ROW_HEIGHT / 2,
    );
    destroy(game);
  });

  it('AC3 — without lives (gym combat), the first row stays at the top', async () => {
    const reg = new EffectsRegistry();
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootScene([BareScene]).then(({ game: g, scene }) => {
      const h = new HUD(scene, reg, { showLives: false });
      h.refresh();
      return { game: g, hud: h };
    });

    const texts = hudTextObjects(hud);
    const firstRow = texts.find((t) => t.text === 'Speed Boost Lvl 1');
    expect(firstRow).toBeDefined();
    // Nothing above the list — the row is at the container's top band.
    expect(firstRow!.y).toBeLessThan(HUD_ROW_HEIGHT);
    destroy(game);
  });
});

describe('HUD weapon rows (AH-0MU3VOQKH005YOBH)', () => {
  it('renders a weapon row when a weapon is equipped', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] })
      .list;
    const names = list
      .filter((c) => c instanceof Phaser.GameObjects.Text)
      .map((c) => (c as Phaser.GameObjects.Text).text);
    expect(names).toContain('Weapon: spread Lvl 0');
    expect(names).toContain('10s');
    destroy(game);
  });

  it('renders one row per equipped weapon', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    reg.applyWeapon('dual');
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] })
      .list;
    const names = list
      .filter((c) => c instanceof Phaser.GameObjects.Text)
      .map((c) => (c as Phaser.GameObjects.Text).text);
    expect(names).toContain('Weapon: spread Lvl 0');
    expect(names).toContain('Weapon: dual Lvl 0');
    expect(names).toContain('Weapon: rapid Lvl 0');
    destroy(game);
  });

  it('renders the Cluster Missile weapon row from the catalogue (AH-0MV1BIVIJ007KYXU)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('cluster');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    expect(hudTexts(hud)).toContain('Weapon: cluster Lvl 0');
    destroy(game);
  });

  it('renders the Options weapon row from the catalogue (AH-0MV1BIVVK0043TEM)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('options');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    expect(hudTexts(hud)).toContain('Weapon: options Lvl 0');
    destroy(game);
  });

  it('drops the row once the weapon expires', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    reg.tick(10.1);
    hud.refresh();
    const list = (hud as unknown as { list: Phaser.GameObjects.GameObject[] })
      .list;

    expect(
      list.some(
        (c) =>
          c instanceof Phaser.GameObjects.Text &&
          c.text === 'Weapon: rapid Lvl 0',
      ),
    ).toBe(false);
    destroy(game);
  });

  it('shows ∞ for a permanent weapon and a countdown for a field pickup on top', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread', true); // permanent
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 0');
    expect(hudTexts(hud)).toContain(PERMANENT_VALUE);

    // A field pickup on the permanent weapon opens a temporary window: the
    // row shows a countdown, then reverts to ∞ — still one row.
    reg.applyWeapon('spread');
    hud.refresh();
    expect(hudTexts(hud).filter((t) => t === PERMANENT_VALUE)).toHaveLength(0);
    expect(hudTexts(hud)).toContain('10s');

    reg.tick(10.1);
    hud.refresh();
    expect(hudTexts(hud)).toContain(PERMANENT_VALUE);
    destroy(game);
  });

  it('a permanent grant mid-window reads ∞ immediately (AC3)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread'); // field pickup: countdown
    let level = 1;
    const { game, hud } = await bootWithHUD(reg, {
      getWeaponLevel: () => level,
    });
    hud.refresh();
    expect(hudTexts(hud)).toContain('10s');

    // The hold-full reward lands while the 10 s window is still open. The
    // weapon strategy clears the temporary component at grant time, so the
    // level settles on the permanent grant and the row shows ∞ with no
    // countdown left behind (AH-0MVUGI4IC006PUS5).
    reg.applyWeapon('spread', true);
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 1');
    expect(hudTexts(hud)).toContain(PERMANENT_VALUE);
    expect(hudTexts(hud).filter((t) => t === '10s')).toHaveLength(0);

    reg.tick(10.1);
    hud.refresh();
    expect(hudTexts(hud)).toContain(PERMANENT_VALUE);
    destroy(game);
  });
});

describe('HUD weapon level readout (parent AH-0MUPMPCB2009J54J)', () => {
  it('shows the effective level and updates reactively (AC1/AC3/AC5)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('spread');
    let level = 1;
    const { game, hud } = await bootWithHUD(reg, {
      getWeaponLevel: () => level,
    });
    hud.refresh();

    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 1');
    expect(hudTexts(hud)).toContain('10s');

    // A level-up is reflected on the next refresh (AC3), timer unchanged.
    level = 3;
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: spread Lvl 3');
    expect(hudTexts(hud)).toContain('10s');
    destroy(game);
  });

  it('reads the level from the provider by weapon id (AC2)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('dual');
    const seen: string[] = [];
    const { game, hud } = await bootWithHUD(reg, {
      getWeaponLevel: (id) => {
        seen.push(id);
        return id === 'dual' ? 4 : 0;
      },
    });
    hud.refresh();

    expect(seen).toContain('dual');
    expect(hudTexts(hud)).toContain('Weapon: dual Lvl 4');
    destroy(game);
  });

  it('shows Lvl 0 without a provider (standalone fallback)', async () => {
    const reg = new EffectsRegistry();
    reg.applyWeapon('rapid');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(hudTexts(hud)).toContain('Weapon: rapid Lvl 0');
    destroy(game);
  });
});

// ── HUD ↔ six-slot agreement (AH-0MVVJRFDV007OI49) ──────────────────
//
// **TEST-FIRST contract for child F2 (AH-0MVVJRRN10038VFR).** The RCA
// (parent AH-0MVVF0POV001JNKX) established that the cap is enforced but the
// HUD renders rows per `EffectsRegistry` visibility, never per slot: a held
// temporary Strike shows no row (tick 4540 → 5 rows for 6 slots) and a
// slot-exempt Mystery UFO plus a residual Phase Shift charge pool add rows
// that hold no slot (tick 5899 → 7 rows for 5 slots).
//
// The fixtures in `src/test/sixSlotLoadoutFixtures.ts` replay those two
// recorded states plus an ordinary below-cap loadout through the real shared
// seams. This block pins the seam F2 implements — read by name until it
// exists, per the repository's test-first convention (see the grey-out and
// Orbital Strike suites above):
//
// - `HUDOptions.getSlotState?: () => PowerUpSlotState | null` — the one seam
//   the shared scene layer supplies (game and every gym alike);
// - `HUD.getSlotBudget(): { used, cap }` — the slot read-out;
// - `HUD.getLoadoutRows(): { id, label, slotCounted }[]` — every rendered row
//   (power-up **and** weapon) with its slot classification, so a non-slot row
//   can be marked rather than silently counted as equipped.
//
// F2 (AH-0MVVJRRN10038VFR) landed the seam, so every case below is a plain
// `it(...)` — the `it.fails` pins that drove the test-first implementation have
// been flipped (the established convention — see `HUD grey-out …
// AH-0MV82I8VA008LX0R` above).

/** Boots a HUD over one committed loadout with the live slot-state seam. */
async function bootHudForLoadout(id: SixSlotLoadoutId) {
  const { game, scene } = await bootScene([BareScene]);
  const loadout = buildSixSlotLoadout(scene, id);
  const options: HUDOptions = {
    // The scene-supplied seam: the HUD never counts slots itself.
    getSlotState: () => resolvePlayerSlotState(loadout.player),
  };
  const hud = new HUD(scene, loadout.registry, options);
  hud.refresh();
  return { game, hud, loadout };
}

/** Asserts every active weapon really has a rendered row (not just a model entry). */
function expectWeaponRowsRendered(hud: HUD, registry: EffectsRegistry): void {
  const texts = hudTexts(hud);
  for (const weapon of registry.activeWeapons()) {
    expect(
      texts.some((text) => text.startsWith(`Weapon: ${weapon.weaponId} `)),
    ).toBe(true);
  }
}

/**
 * Ids of every row the HUD renders today: power-up rows (`getRows()`) plus the
 * active weapon rows it draws after them. An independent projection of the
 * rendered loadout, so the counting assertion cannot agree with the HUD by
 * construction.
 */
function renderedRowIds(hud: HUD, registry: EffectsRegistry): string[] {
  expectWeaponRowsRendered(hud, registry);
  return [
    ...hud.getRows().map((row) => row.id),
    ...registry.activeWeapons().map((weapon) => weapon.weaponId),
  ];
}

describe('HUD ↔ six-slot agreement (AH-0MVVJRFDV007OI49)', () => {
  it('below-cap mixed loadout: slot-counted rows equal the model and stay under the cap', async () => {
    const { game, hud, loadout } = await bootHudForLoadout('below-cap-mixed');
    const state = resolvePlayerSlotState(loadout.player);
    const rowIds = renderedRowIds(hud, loadout.registry);
    destroy(game);

    const counted = rowIds.filter((rowId) =>
      isSlotCountedKind(rowId, state),
    );
    expect(state.used).toBe(4);
    expect(counted).toHaveLength(state.used);
    expect(counted.length).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    // The exempt Mystery UFO row is rendered, but it never counts (Q7a).
    expect(rowIds).toContain('mystery_ufo');
    expect(counted).not.toContain('mystery_ufo');
  });

  it('tick 4540 fixture: the slot-counted rows match the six held slots', async () => {
    const { game, hud, loadout } = await bootHudForLoadout(
      'six-slots-five-rows',
    );
    const state = resolvePlayerSlotState(loadout.player);
    const rowIds = renderedRowIds(hud, loadout.registry);
    const counted = rowIds.filter((rowId) => isSlotCountedKind(rowId, state));
    destroy(game);

    // Six slot-counted kinds are held (mineral_scoop, strike, heavy_slug,
    // mortar, rapid, shard_swarm). The temporary Strike used to render no row
    // (5 rows for 6 slots); every slot-held kind now gets a row, so the list
    // agrees with the model instead of under-reporting it.
    expect(state.used).toBe(POWER_UP_SLOT_CAP);
    expect(rowIds).toContain('strike');
    expect(counted).toHaveLength(state.used);
    expect(counted.length).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
  });

  it('tick 5899 fixture: seven rendered rows classify as five slot rows and two non-slot rows', async () => {
    {
      const { game, hud, loadout } = await bootHudForLoadout(
        'seven-rows-five-slots',
      );
      const state = resolvePlayerSlotState(loadout.player);
      const rows = hud.getLoadoutRows();
      destroy(game);

      // The seven rows the recording showed at tick 5899 (the slot budget
      // read-out is not a loadout row).
      expect(rows.map((row) => row.id).sort()).toEqual(
        [
          'heavy_slug',
          'mortar',
          'mystery_ufo',
          'rear_guard',
          'salvage',
          'shield',
          'spread',
        ].sort(),
      );
      const counted = rows
        .filter((row) => row.slotCounted)
        .map((row) => row.id)
        .sort();
      expect(counted).toEqual(slotCountedKinds(state));
      expect(counted).toHaveLength(state.used);
      expect(counted.length).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);

      // Non-slot rows are excluded whatever their reason: the exempt Mystery
      // UFO, the residual Shield charge pool, and the exempt Extra Life,
      // which is held but has no row at all.
      expect(rows.filter((row) => !row.slotCounted).map((row) => row.id).sort()).toEqual([
        'mystery_ufo',
        'shield',
      ]);
      expect(state.heldIds.has('extra_life')).toBe(true);
      expect(rows.map((row) => row.id)).not.toContain('extra_life');
    }
  });

  it('exposes the shared slot budget (used/cap) for every fixture loadout', async () => {
    for (const id of SIX_SLOT_LOADOUT_IDS) {
      const { game, hud, loadout } = await bootHudForLoadout(id);
      const state = resolvePlayerSlotState(loadout.player);
      const budget = hud.getSlotBudget();
      destroy(game);

      expect(budget.used).toBe(state.used);
      expect(budget.cap).toBe(POWER_UP_SLOT_CAP);
      expect(budget.used).toBeLessThanOrEqual(budget.cap);
    }
  });

  it('renders the slot budget read-out with the rows', async () => {
    const { game, hud, loadout } = await bootHudForLoadout(
      'seven-rows-five-slots',
    );
    const state = resolvePlayerSlotState(loadout.player);
    const label = hud.getSlotBudgetLabel();
    const texts = hudTexts(hud);
    destroy(game);

    expect(label).toBe(`Loadout ${state.used}/${POWER_UP_SLOT_CAP}`);
    expect(texts).toContain(`Loadout ${state.used}/${POWER_UP_SLOT_CAP}`);
  });

  it('renders the budget as its own visible read-out object', async () => {
    const { game, hud } = await bootHudForLoadout('seven-rows-five-slots');
    const budgetText = hudChildren(hud).find(
      (child) =>
        child instanceof Phaser.GameObjects.Text &&
        child.name === SLOT_BUDGET_NAME,
    ) as Phaser.GameObjects.Text | undefined;
    destroy(game);

    expect(budgetText).toBeDefined();
    expect(budgetText!.visible).toBe(true);
    expect(budgetText!.text).toBe(hud.getSlotBudgetLabel());
  });

  it('marks every non-slot row and leaves slot-counted rows unmarked', async () => {
    const { game, hud } = await bootHudForLoadout('seven-rows-five-slots');
    const rows = hud.getLoadoutRows();
    const texts = hudTexts(hud);
    destroy(game);

    const markerOf = (id: string) =>
      rows.find((row) => row.id === id)?.marker;

    // The exempt Mystery UFO is always available, never a slot holder (Q7a).
    expect(markerOf('mystery_ufo')).toBe(SLOT_MARKER_ALWAYS_AVAILABLE);
    // The Shield row survives its expired window on its charge alone.
    expect(markerOf('shield')).toBe(SLOT_MARKER_CHARGES_ONLY);
    // Slot-counted kinds carry no marker: they are the loadout.
    for (const row of rows.filter((candidate) => candidate.slotCounted)) {
      expect(row.marker).toBeUndefined();
    }
    // The markers are actually rendered, not only present in the model.
    expect(texts).toContain(SLOT_MARKER_ALWAYS_AVAILABLE);
    expect(texts).toContain(SLOT_MARKER_CHARGES_ONLY);
  });

  it('is inert without a slot-state provider (standalone HUD unchanged)', async () => {
    const { game, scene } = await bootScene([BareScene]);
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('strike');
    const hud = new HUD(scene, reg);
    hud.refresh();
    const budget = hud.getSlotBudget();
    const label = hud.getSlotBudgetLabel();
    const texts = hudTexts(hud);
    const rows = hud.getRows();
    destroy(game);

    expect(budget).toEqual({ used: 0, cap: POWER_UP_SLOT_CAP });
    expect(label).toBe('');
    expect(texts.some((text) => text.startsWith('Loadout '))).toBe(false);
    // The reserved read-out object stays inert (invisible, empty).
    const budgetText = hudChildren(hud).find(
      (child) =>
        child instanceof Phaser.GameObjects.Text &&
        child.name === SLOT_BUDGET_NAME,
    ) as Phaser.GameObjects.Text | undefined;
    expect(budgetText?.visible ?? false).toBe(false);
    // The pre-existing visibility rules are untouched: a temporary one-shot
    // still renders no row when the HUD is not slot-aware.
    expect(rows.map((row) => row.id)).not.toContain('strike');
  });
});

// ── Loadout grouping (AH-0MVVF0POV001JNKX) ─────────────────────────────
//
// The producer rejected the earlier presentation (budget + markers + dimmed
// rows) because the upgrade list still showed more than six entries. The rows
// are now grouped: the slot-counted loadout rows are contiguous and come first,
// and every non-slot row (exempt entry, residual charge pool) is rendered below
// a `Not in loadout` heading. The visible loadout list therefore never contains
// more rows than the model says are equipped.

describe('HUD loadout grouping (AH-0MVVF0POV001JNKX)', () => {
  it('groups non-slot rows below a heading, after a contiguous loadout list', async () => {
    const { game, hud } = await bootHudForLoadout('seven-rows-five-slots');
    const rows = hud.getLoadoutRows();
    const texts = hudTexts(hud);
    destroy(game);

    const loadout = rows.filter((row) => row.group === 'loadout');
    const nonSlot = rows.filter((row) => row.group === 'non-slot');

    // The group split is exactly the slot classification: every loadout row
    // precedes every non-slot row, so a player counting the list stops at six.
    expect(rows.slice(0, loadout.length).every((row) => row.group === 'loadout')).toBe(true);
    expect(rows.slice(loadout.length).every((row) => row.group === 'non-slot')).toBe(true);
    expect(loadout.length).toBe(
      rows.filter((row) => row.slotCounted).length,
    );
    expect(loadout.length).toBeLessThanOrEqual(POWER_UP_SLOT_CAP);
    expect(nonSlot.length).toBeGreaterThan(0);

    // The grouping is visible: the heading is rendered, not model-only.
    expect(texts).toContain(NON_SLOT_SECTION_LABEL);
  });

  it('renders the heading between the loadout rows and the non-slot rows', async () => {
    const { game, hud } = await bootHudForLoadout('seven-rows-five-slots');
    const rows = hud.getLoadoutRows();
    const children = hudChildren(hud);
    const textOf = (text: string): Phaser.GameObjects.Text | undefined =>
      children.find(
        (child): child is Phaser.GameObjects.Text =>
          child instanceof Phaser.GameObjects.Text && child.text === text,
      );
    const heading = children.find(
      (child) =>
        child instanceof Phaser.GameObjects.Text &&
        child.name === NON_SLOT_SECTION_NAME,
    ) as Phaser.GameObjects.Text | undefined;
    const loadoutLabels = rows
      .filter((row) => row.group === 'loadout')
      .map((row) => row.label);
    const nonSlotLabels = rows
      .filter((row) => row.group === 'non-slot')
      .map((row) => row.label);
    const maxLoadoutY = Math.max(
      ...loadoutLabels.map((label) => textOf(label)!.y),
    );
    const minNonSlotY = Math.min(
      ...nonSlotLabels.map((label) => textOf(label)!.y),
    );
    destroy(game);

    expect(heading).toBeDefined();
    expect(heading!.text).toBe(NON_SLOT_SECTION_LABEL);
    expect(heading!.y).toBeGreaterThan(maxLoadoutY);
    expect(heading!.y).toBeLessThan(minNonSlotY);
  });

  it('renders no heading when every rendered row holds a slot', async () => {
    const { game, hud } = await bootHudForLoadout('six-slots-five-rows');
    const rows = hud.getLoadoutRows();
    const texts = hudTexts(hud);
    destroy(game);

    expect(rows.every((row) => row.group === 'loadout')).toBe(true);
    expect(texts).not.toContain(NON_SLOT_SECTION_LABEL);
  });
});

// ── Single-use Teleport row (AH-0MW231O8Q0095LQM, parent AH-0MVY096RT006QMF4
//    AC7) ─────────────────────────────────────────────────────────────────
//
// Teleport holds no charge pool: its row reads `ready` while the readiness
// timer is 0 and the shared `next in Ns` countdown while it recharges, greys
// out while recharging, and never carries a `×N` stack suffix. All of it comes
// from the shared HUD model, so `PlayScene` and every gym inherit it
// (`src/scenes/core/hudSingleUseTeleport.parity.test.ts` pins that parity).

/** The body of `methodName` in a TypeScript source text (brace-balanced). */
function methodSource(source: string, methodName: string): string {
  const start = source.indexOf(methodName);
  if (start < 0) return '';
  const open = source.indexOf('{', start);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return '';
}

describe('HUD single-use Teleport row (AH-0MW231O8Q0095LQM)', () => {
  /** A registry whose store the test drives, with a permanently owned Teleport. */
  function ownedTeleport(): {
    store: PowerUpLevelStore;
    reg: EffectsRegistry;
  } {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    store.collect('teleport', true); // hold-full grant: owned and ready
    return { store, reg };
  }

  it('renders `ready` for an owned Teleport, with no stack suffix (AC1/AC2)', async () => {
    const { reg } = ownedTeleport();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(row).toBeDefined();
    expect(row.label).toBe('Teleport Lvl 1 (ready)');
    expect(row.label).not.toContain('×');
    expect(row.stacks).toBeUndefined();
    expect(row.recharge).toBeUndefined();
    expect(rowGreyed(row)).toBe(false);
    destroy(game);
  });

  it('renders `next in Ns` from the store timer and greys the row while recharging (AC2/AC3)', async () => {
    const { store, reg } = ownedTeleport();
    expect(reg.consumeTeleport()).toBe(true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const remaining = store.teleportRechargeRemaining();
    expect(remaining).toBeCloseTo(store.teleportRechargeTime(), 6);

    const row = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(row).toBeDefined();
    // N is the store's remaining seconds through the shared label formatter.
    expect(row.recharge).toBeCloseTo(remaining, 6);
    expect(row.label).toBe(
      `Teleport Lvl 1 (next in ${Math.ceil(remaining)}s)`,
    );
    expect(row.label).not.toContain('×');
    expect(row.stacks).toBeUndefined();
    expect(rowGreyed(row)).toBe(true);

    // The countdown is live: only the shared recharge clock advances it.
    store.tickRecharge(10);
    hud.refresh();
    const ticking = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(ticking.recharge).toBeCloseTo(remaining - 10, 6);
    expect(ticking.label).toBe(
      `Teleport Lvl 1 (next in ${Math.ceil(remaining - 10)}s)`,
    );
    expect(rowGreyed(ticking)).toBe(true);

    // Elapsed interval: the row returns to `ready` and un-greys.
    store.tickRecharge(store.teleportRechargeTime());
    hud.refresh();
    const settled = hud.getRows().find((r) => r.id === 'teleport')!;
    expect(settled.label).toBe('Teleport Lvl 1 (ready)');
    expect(settled.recharge).toBeUndefined();
    expect(settled.label).not.toContain('next in');
    expect(rowGreyed(settled)).toBe(false);
    destroy(game);
  });

  it('keeps the recharging row visible through the shared ownership rule, not a charge count (AC4)', async () => {
    const { reg } = ownedTeleport();
    expect(reg.consumeTeleport()).toBe(true);
    // A single-use kind never holds a pool charge, so the pooled-charge half
    // of the generalised visibility rule can never be what keeps this row
    // alive — ownership does, exactly as for every other consumable.
    expect(reg.consumableCharges('teleport')).toBe(0);

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'teleport');
    expect(row).toBeDefined();
    expect(rowGreyed(row)).toBe(true);
    // The row is owned, so it is loadout-counted — no non-slot marker is
    // needed to explain it away.
    expect(row!.slotCounted).toBe(true);
    expect(row!.marker).toBeUndefined();
    destroy(game);
  });

  it('suppresses the stack suffix from the catalogue single-use flag, never an id branch (AC5)', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/ui/HUD.ts'),
      'utf8',
    );
    // Prose may name Teleport; only executable code is inspected.
    const stacks = methodSource(source, 'private _powerUpStacks(').replace(
      /\/\/.*$/gm,
      '',
    );
    expect(stacks).not.toBe('');
    // Data-driven: the suppression reads the catalogue `singleUse` flag…
    expect(stacks).toContain('singleUse');
    // …and the HUD holds no `id === 'teleport'` stack special case.
    expect(stacks).not.toContain("'teleport'");
    expect(stacks).not.toContain('"teleport"');
  });
});

// ── Single-use Phase Shift row (AH-0MW6QY70A00171QB, parent
//    AH-0MW6O1690007P2SL AC4) ──────────────────────────────────────────
//
// Phase Shift holds the same single activation model as Teleport: its row
// reads `ready` while the readiness timer is 0 and the shared `next in Ns`
// countdown while it recharges, greys out while recharging, and never carries
// a `×N` stack suffix. Every one of those comes from the shared HUD model
// keyed on the catalogue `singleUse` flag, so `PlayScene` and every gym
// inherit it (`src/scenes/core/hudSingleUseTeleport.parity.test.ts` pins that
// parity).

describe('HUD single-use Phase Shift row (AH-0MW6QY70A00171QB)', () => {
  /** A registry whose store the test drives, with a permanently owned Phase Shift. */
  function ownedPhaseShift(): {
    store: PowerUpLevelStore;
    reg: EffectsRegistry;
  } {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    store.collect('phase_shift', true); // hold-full grant: owned and ready
    return { store, reg };
  }

  it('renders `ready` for an owned Phase Shift, with no stack suffix (AC1/AC4)', async () => {
    const { reg } = ownedPhaseShift();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'phase_shift')!;
    expect(row).toBeDefined();
    expect(row.label).toBe('Phase Shift Lvl 1 (ready)');
    expect(row.label).not.toContain('×');
    expect(row.stacks).toBeUndefined();
    expect(row.recharge).toBeUndefined();
    expect(rowGreyed(row)).toBe(false);
    destroy(game);
  });

  it('renders `next in Ns` from the store timer and greys the row while recharging (AC2/AC3)', async () => {
    const { store, reg } = ownedPhaseShift();
    expect(reg.consumePhaseShift()).toBe(true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const remaining = store.phaseShiftRechargeRemaining();
    expect(remaining).toBeCloseTo(store.phaseRechargeTime(), 6);

    const row = hud.getRows().find((r) => r.id === 'phase_shift')!;
    expect(row).toBeDefined();
    // N is the store's remaining seconds through the shared label formatter.
    expect(row.recharge).toBeCloseTo(remaining, 6);
    expect(row.label).toBe(
      `Phase Shift Lvl 1 (next in ${Math.ceil(remaining)}s)`,
    );
    expect(row.label).not.toContain('×');
    expect(row.stacks).toBeUndefined();
    expect(rowGreyed(row)).toBe(true);

    // The countdown is live: only the shared recharge clock advances it.
    store.tickRecharge(10);
    hud.refresh();
    const ticking = hud.getRows().find((r) => r.id === 'phase_shift')!;
    expect(ticking.recharge).toBeCloseTo(remaining - 10, 6);
    expect(ticking.label).toBe(
      `Phase Shift Lvl 1 (next in ${Math.ceil(remaining - 10)}s)`,
    );
    expect(rowGreyed(ticking)).toBe(true);

    // Elapsed interval: the row returns to `ready` and un-greys.
    store.tickRecharge(store.phaseRechargeTime());
    hud.refresh();
    const settled = hud.getRows().find((r) => r.id === 'phase_shift')!;
    expect(settled.label).toBe('Phase Shift Lvl 1 (ready)');
    expect(settled.recharge).toBeUndefined();
    expect(settled.label).not.toContain('next in');
    expect(rowGreyed(settled)).toBe(false);
    destroy(game);
  });

  it('keeps the recharging row visible through the shared ownership rule, not a charge count (AC3/AC4)', async () => {
    const { reg } = ownedPhaseShift();
    expect(reg.consumePhaseShift()).toBe(true);
    // A single-use kind never holds a pool charge, so the pooled-charge half
    // of the generalised visibility rule can never be what keeps this row
    // alive — ownership does, exactly as for Teleport.
    expect(reg.consumableCharges('phase_shift')).toBe(0);

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((r) => r.id === 'phase_shift');
    expect(row).toBeDefined();
    expect(rowGreyed(row)).toBe(true);
    // The row is owned, so it is loadout-counted — no non-slot marker is
    // needed to explain it away.
    expect(row!.slotCounted).toBe(true);
    expect(row!.marker).toBeUndefined();
    destroy(game);
  });

  it('drives the single-use presentation from the catalogue flag, never an id branch (AC1)', () => {
    // Phase Shift is on the catalogue single-use list exactly like Teleport,
    // so the shared HUD path (stack suppression, readiness label, grey-out)
    // applies to both without a per-kind branch.
    expect(CONSUMABLE_POWER_UP_IDS).toContain('phase_shift');
    const entry = getPowerUpById('phase_shift');
    expect(entry.singleUse).toBe(true);
    expect(entry.consumable).toBe(true);
    // The shared formatter renders the readiness state for a single-use row.
    expect(buildHUDLabel('Phase Shift', 1, undefined, undefined, true)).toBe(
      'Phase Shift Lvl 1 (ready)',
    );
    expect(buildHUDLabel('Phase Shift', 1, undefined, 4.2, true)).toBe(
      'Phase Shift Lvl 1 (next in 5s)',
    );
    // No state ever produces a `×N` charge suffix for Phase Shift.
    expect(
      buildHUDLabel('Phase Shift', 1, undefined, undefined, true),
    ).not.toContain('×');
  });
});

// ── Consumable charges and regeneration countdown (parent AH-0MVTQMREN009DSFW
//    AC4) ────────────────────────────────────────────────────────────────
//
// Every consumable row — Shield, Thorn Field, Phase Shift, Teleport, Force
// Field, Mystery UFO — shows its available charge count (` ×N`, never ` ×0`),
// a live `next in Ns` countdown while a charge is regenerating, no countdown
// while the pool is full, and an owned-but-empty row that stays visible and
// greyed. The set comes from the catalogue (`CONSUMABLE_POWER_UP_IDS`), so a
// new consumable is covered without touching this suite.

describe('HUD consumable charges (parent AH-0MVTQMREN009DSFW AC4)', () => {
  /**
   * The four **pool-backed** consumables. Phase Shift and Teleport are
   * single-use (parent AH-0MW6O1690007P2SL / AH-0MVY096RT006QMF4) and have
   * their own readiness-row coverage above.
   */
  const POOLED_CONSUMABLE_IDS = CONSUMABLE_POWER_UP_IDS.filter(
    (id) => id !== 'teleport' && id !== 'phase_shift',
  );
  /** The row for `id`, or `undefined` when the HUD renders none. */
  function rowFor(hud: HUD, id: string): HUDEntry | undefined {
    return hud.getRows().find((row) => row.id === id);
  }

  /** A registry whose store the test drives, plus one owned charge. */
  function ownedConsumable(id: PowerUpId): {
    store: PowerUpLevelStore;
    reg: EffectsRegistry;
  } {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    store.collect(id, true); // hold-full: owned, one charge, no level
    return { store, reg };
  }

  it('covers the catalogue consumable set (six kinds)', () => {
    expect([...CONSUMABLE_POWER_UP_IDS].sort()).toEqual(
      [
        'force_field',
        'mystery_ufo',
        'phase_shift',
        'shield',
        'teleport',
        'thorns',
      ].sort(),
    );
  });

  for (const id of POOLED_CONSUMABLE_IDS) {
    it(`${id}: shows the charge count, no countdown while full, then greyed + live countdown while recharging`, async () => {
      const { store, reg } = ownedConsumable(id);
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();

      // Full/partial pool: the available count is surfaced, nothing is owed.
      const owned = rowFor(hud, id)!;
      expect(owned, 'owned consumable has a row').toBeDefined();
      expect(owned.stacks).toBe(1);
      expect(owned.label).toContain('×1');
      expect(owned.recharge).toBeUndefined();
      expect(owned.label).not.toContain('next in');
      expect(owned.greyed).toBe(false);
      // A permanently granted item opens no effect window, so the value
      // column reads ∞ — never a window countdown (parent
      // AH-0MVUVSW4J0009QUW AC3); the label carries the charge and, once a
      // charge is owed, the live `next in Ns` regeneration countdown below.
      expect(owned.value).toBe(PERMANENT_VALUE);

      // Fill the pool to its level-derived cap: a full pool owes no charge,
      // so the countdown never appears even though charges were banked.
      store.grantConsumableCharge(id, 99);
      const cap = store.consumableChargeCap(id);
      expect(reg.consumableCharges(id)).toBe(cap);
      hud.refresh();
      const full = rowFor(hud, id)!;
      expect(full.stacks).toBe(cap);
      expect(full.recharge).toBeUndefined();
      expect(full.label).not.toContain('next in');

      // Empty the pool through the shared spend seam: the row is still
      // visible, greyed, and counts down to the next charge.
      let spent = 0;
      while (reg.tryConsumeConsumableCharge(id)) spent += 1;
      expect(spent).toBe(cap);
      hud.refresh();
      const empty = rowFor(hud, id)!;
      expect(empty, 'owned-but-empty pool keeps its row').toBeDefined();
      expect(empty.stacks).toBeUndefined();
      expect(empty.label).not.toContain('×0');
      expect(empty.greyed).toBe(true);
      const first = empty.recharge;
      expect(first).toBeDefined();
      expect(first!).toBeGreaterThan(0);
      expect(empty.label).toContain('(next in');
      expect(empty.label).toContain(`(next in ${Math.ceil(first!)}s)`);

      // The countdown is live, advanced only by the shared registry tick.
      reg.tick(1);
      hud.refresh();
      const ticking = rowFor(hud, id)!;
      expect(ticking.greyed).toBe(true);
      expect(ticking.recharge).toBeDefined();
      expect(ticking.recharge!).toBeLessThan(first!);
      expect(ticking.label).toContain(`(next in ${Math.ceil(ticking.recharge!)}s)`);

      // A completed regeneration returns the charge, clears the countdown and
      // un-greys the row.
      reg.tick(ticking.recharge! + 0.01);
      hud.refresh();
      const refilled = rowFor(hud, id)!;
      expect(reg.consumableCharges(id)).toBe(cap);
      expect(refilled.stacks).toBe(cap);
      expect(refilled.label).toContain(`×${cap}`);
      expect(refilled.recharge).toBeUndefined();
      expect(refilled.label).not.toContain('next in');
      expect(refilled.greyed).toBe(false);
      destroy(game);
    });

    it(`${id}: stays hidden while the player neither owns it nor holds a charge`, async () => {
      const reg = new EffectsRegistry(new PowerUpLevelStore());
      const { game, hud } = await bootWithHUD(reg);
      hud.refresh();
      expect(rowFor(hud, id)).toBeUndefined();
      destroy(game);
    });
  }

  it('teleport: a single-use row shows no charge count and counts its recharge down', async () => {
    const { store, reg } = ownedConsumable('teleport');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const ready = rowFor(hud, 'teleport')!;
    expect(ready).toBeDefined();
    expect(ready.stacks).toBeUndefined();
    expect(ready.label).toBe('Teleport Lvl 1 (ready)');
    expect(ready.recharge).toBeUndefined();
    expect(ready.greyed).toBe(false);

    // Spending the warp greys the owned row and starts the one countdown.
    expect(reg.consumeTeleport()).toBe(true);
    hud.refresh();
    const recharging = rowFor(hud, 'teleport')!;
    expect(recharging.greyed).toBe(true);
    expect(recharging.stacks).toBeUndefined();
    expect(recharging.recharge).toBeCloseTo(store.teleportRechargeTime(), 6);
    expect(recharging.label).toContain('(next in');

    // The shared recharge clock returns it to ready.
    store.tickRecharge(store.teleportRechargeTime() + 0.01);
    hud.refresh();
    const settled = rowFor(hud, 'teleport')!;
    expect(settled.greyed).toBe(false);
    expect(settled.recharge).toBeUndefined();
    destroy(game);
  });

  it('renders a field-pickup Shield from the granted charge with no countdown', async () => {
    // A field pickup grants exactly one charge into the shared pool (parent
    // AH-0MVUVSW4J0009QUW): the row reports that charge and no pool timer,
    // because a pickup-only charge is never owed back (Q-A1=b).
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('shield');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = rowFor(hud, 'shield')!;
    expect(row).toBeDefined();
    expect(row.stacks).toBe(1);
    expect(row.greyed).toBe(false);
    // No pool timer was opened by a field pickup, so nothing counts down.
    expect(row.recharge).toBeUndefined();
    destroy(game);
  });

  it('leaves non-consumable rows unchanged: no charge count, no countdown, never greyed', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('bomb', true); // permanent (hold-full) non-consumable
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = rowFor(hud, 'bomb')!;
    expect(row).toBeDefined();
    expect(row.label).toBe('Bomb Lvl 1');
    expect(row.stacks).toBeUndefined();
    expect(row.recharge).toBeUndefined();
    expect(row.greyed).toBe(false);
    destroy(game);
  });
});

// ── Countdown ring (AH-0MW2AVRNL008F9FX) ─────────────────────────────
//
// Every row with a live countdown draws a sweeping arc ring around its icon
// (parent AH-0MVZ8YQQV006Q09W): `arriving` countdowns fill from empty at the
// spend/fire instant to complete when the event is due, `expiring` countdowns
// drain from complete at pickup to empty at expiry. These tests pin the row
// model's fraction, the rendered arc (geometry + palette) and the invariants
// (no countdown ⇒ no ring, bounded objects, unmoved columns) from the command
// buffer, which is the only rendering evidence available headless (see
// `src/test/setup.ts`).

/** Phaser Graphics command opcodes (subset the row icons emit). */
const CMD = {
  ARC: 0,
  BEGIN_PATH: 1,
  CLOSE_PATH: 2,
  FILL_RECT: 3,
  LINE_TO: 4,
  MOVE_TO: 5,
  LINE_STYLE: 6,
  FILL_STYLE: 7,
  FILL_PATH: 8,
  STROKE_PATH: 9,
  FILL_TRIANGLE: 10,
  STROKE_TRIANGLE: 11,
} as const;

/** Parameter count per opcode (opcode + N params in the flat command buffer). */
const CMD_PARAMS: Record<number, number> = {
  [CMD.ARC]: 7,
  [CMD.FILL_RECT]: 4,
  [CMD.LINE_TO]: 2,
  [CMD.MOVE_TO]: 2,
  [CMD.LINE_STYLE]: 3,
  [CMD.FILL_STYLE]: 2,
  [CMD.FILL_TRIANGLE]: 6,
  [CMD.STROKE_TRIANGLE]: 6,
};

interface ArcCommand {
  x: number;
  y: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  anticlockwise: boolean;
}

interface ArcEntry {
  arc: ArcCommand;
  /** Index of the opcode in the command buffer (for the preceding lineStyle). */
  index: number;
}

/** Every `arc()` emitted to a Graphics, in draw order. */
function arcEntries(graphics?: Phaser.GameObjects.Graphics): ArcEntry[] {
  const buf = graphics?.commandBuffer as number[] | undefined;
  if (!buf) return [];
  const entries: ArcEntry[] = [];
  for (let i = 0; i < buf.length; ) {
    const op = buf[i];
    if (op === CMD.ARC) {
      entries.push({
        arc: {
          x: buf[i + 1],
          y: buf[i + 2],
          radius: buf[i + 3],
          startAngle: buf[i + 4],
          endAngle: buf[i + 5],
          anticlockwise: buf[i + 6] === 1,
        },
        index: i,
      });
      i += 1 + 7;
      continue;
    }
    i += 1 + (CMD_PARAMS[op] ?? 0);
  }
  return entries;
}

/** The countdown ring arc on a row icon (drawn at {@link RING_RADIUS}). */
function ringArc(graphics?: Phaser.GameObjects.Graphics): ArcCommand | undefined {
  return arcEntries(graphics).find(
    (entry) => Math.abs(entry.arc.radius - RING_RADIUS) < 1e-6,
  )?.arc;
}

/** The stroke colour of the ring arc (the `lineStyle` that preceded it). */
function ringColour(
  graphics?: Phaser.GameObjects.Graphics,
): number | undefined {
  const buf = graphics?.commandBuffer as number[] | undefined;
  const entry = arcEntries(graphics).find(
    (candidate) => Math.abs(candidate.arc.radius - RING_RADIUS) < 1e-6,
  );
  if (!buf || !entry) return undefined;
  for (let i = entry.index; i >= 0; i -= 1) {
    if (buf[i - 3] === CMD.LINE_STYLE) return buf[i - 1];
  }
  return undefined;
}

/** The sweep of an arc as a fraction of a full turn. */
function arcSweep(arc: ArcCommand): number {
  return Math.abs(arc.endAngle - arc.startAngle) / (Math.PI * 2);
}

/** A registry with a permanently-owned pooled consumable holding one spent charge. */
function rechargingConsumable(): {
  store: PowerUpLevelStore;
  reg: EffectsRegistry;
  total: number;
} {
  const store = new PowerUpLevelStore();
  const reg = new EffectsRegistry(store);
  reg.applyCollect('force_field', true); // hold-full: owned, one charge spent
  expect(reg.tryConsumeConsumableCharge('force_field')).toBe(true);
  return { store, reg, total: store.consumableRechargeTime('force_field') };
}

/** A registry with a permanent Orbital Strike cadence counting down. */
function strikeCadence(): { reg: EffectsRegistry; total: number } {
  const reg = new EffectsRegistry(new PowerUpLevelStore());
  reg.applyCollect('strike', true);
  // The grant queues one immediate bolt; resolve it so the cadence clock is the
  // live countdown the row reports (a latched bolt freezes the timer).
  expect(reg.updateStrike(0)).toBe(true);
  reg.resolveStrike();
  return { reg, total: reg.strikeInterval() };
}

describe('AH-0MW2AVRNL008F9FX AC1: the row model reports each countdown fraction', () => {
  it('a recharging consumable reports an arriving (filling) fraction', async () => {
    const { store, reg, total } = rechargingConsumable();
    store.tickRecharge(total / 4); // a quarter of the wait has elapsed
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((entry) => entry.id === 'force_field')!;
    expect(row.recharge).toBeCloseTo(total * 0.75, 6);
    expect(row.countdown).toBeCloseTo(0.25, 6);
    destroy(game);
  });

  it('several in-flight charges report the soonest-returning one (same timer as the label)', async () => {
    const { store, reg, total } = rechargingConsumable();
    // A second charge is spent later, so it returns later; the ring must show
    // the soonest — the very timer the `next in Ns` label reports.
    store.tickRecharge(total / 2);
    reg.applyCollect('force_field', true); // one more charge…
    expect(reg.tryConsumeConsumableCharge('force_field')).toBe(true); // …spent now
    store.tickRecharge(total / 4);

    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((entry) => entry.id === 'force_field')!;
    expect(row.recharge).toBeCloseTo(total * 0.25, 6);
    expect(row.countdown).toBeCloseTo(0.75, 6);
    destroy(game);
  });

  it('the permanent Orbital Strike cadence reports an arriving (filling) fraction', async () => {
    const { reg, total } = strikeCadence();
    reg.updateStrike(total * 0.25); // a quarter of the cadence elapsed
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((entry) => entry.id === 'strike')!;
    expect(row.recharge).toBeCloseTo(total * 0.75, 6);
    expect(row.countdown).toBeCloseTo(0.25, 6);
    destroy(game);
  });

  it('a power-up timed window reports an expiring (draining) fraction', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('speed_boost');
    const total = reg.powerUpTemporaryRemaining('speed_boost')!;
    reg.tick(total * 0.25);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((entry) => entry.id === 'speed_boost')!;
    expect(row.temporary).toBe(true);
    expect(row.countdown).toBeCloseTo(0.75, 6);
    destroy(game);
  });

  it('a weapon field-pickup window reports an expiring (draining) fraction', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyWeapon('spread');
    const total = reg.activeWeapons()[0].duration;
    reg.tick(total * 0.25);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const weapon = hud.getLoadoutRows().find((row) => row.id === 'spread')!;
    expect(weapon.countdown).toBeCloseTo(0.75, 6);
    destroy(game);
  });

  it('rows with nothing counting down report no fraction', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('magnet', true); // permanent, no window
    reg.applyCollect('speed_boost', true); // permanent, no window
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    for (const row of hud.getRows()) {
      expect(row.countdown).toBeUndefined();
    }
    destroy(game);
  });

  it('a ready single-use row reports no fraction (nothing is owed)', async () => {
    const store = new PowerUpLevelStore();
    const reg = new EffectsRegistry(store);
    reg.applyCollect('phase_shift', true); // owned, ready, no recharge timer
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((entry) => entry.id === 'phase_shift')!;
    expect(row.recharge).toBeUndefined();
    expect(row.countdown).toBeUndefined();
    destroy(game);
  });
});

describe('AH-0MW2AVRNL008F9FX AC2: the rendered arc carries the row fraction', () => {
  it('draws the ring at RING_RADIUS around the icon, clockwise from 12 o’clock, at half a turn for 0.5', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('speed_boost');
    const total = reg.powerUpTemporaryRemaining('speed_boost')!;
    reg.tick(total / 2);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const icon = rowIcon(hud, hud.getRows()[0].label)!;
    const arc = ringArc(icon)!;
    expect(arc).toBeDefined();
    expect(arc.anticlockwise).toBe(false);
    expect(arc.startAngle).toBeCloseTo(-Math.PI / 2, 6); // 12 o'clock
    expect(arcSweep(arc)).toBeCloseTo(0.5, 6);
    destroy(game);
  });

  it('draws the row icon in the item palette and the ring in the same hue', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('speed_boost');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const icon = rowIcon(hud, hud.getRows()[0].label)!;
    expect(firstStrokeColour(icon)).toBe(ICON_COLORS.speed_boost);
    expect(ringColour(icon)).toBe(ICON_COLORS.speed_boost);
    destroy(game);
  });

  it('draws a weapon row ring in the weapon palette colour', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyWeapon('spread');
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const weapon = hud.getLoadoutRows().find((row) => row.id === 'spread')!;
    const icon = rowIcon(hud, weapon.label)!;
    expect(ringColour(icon)).toBe(weaponIconColour('spread'));
    expect(arcSweep(ringArc(icon)!)).toBeCloseTo(1, 6);
    destroy(game);
  });

  it('redraws the arc on the existing icon Graphics as the fraction moves (no new object)', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('speed_boost'); // 10 s window → whole seconds in the value
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const label = hud.getRows()[0].label;
    const icon = rowIcon(hud, label)!;
    expect(arcSweep(ringArc(icon)!)).toBeCloseTo(1, 6);
    const childCount = hudChildren(hud).length;

    reg.tick(0.5); // the value column still reads `10s`: same render plan
    hud.refresh();

    // The same Graphics object now carries the updated sweep.
    expect(rowIcon(hud, label)).toBe(icon);
    expect(hudChildren(hud).length).toBe(childCount);
    expect(arcSweep(ringArc(icon)!)).toBeCloseTo(0.95, 6);
    destroy(game);
  });

  it('keeps a minimum visible sweep while an expiring window is nearly done', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('speed_boost');
    const total = reg.powerUpTemporaryRemaining('speed_boost')!;
    reg.tick(total - 0.04); // 0.04 s of a 10 s window is left
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows()[0];
    expect(row.countdown!).toBeLessThan(MIN_RING_SWEEP);
    const icon = rowIcon(hud, row.label)!;
    expect(arcSweep(ringArc(icon)!)).toBeCloseTo(MIN_RING_SWEEP, 6);
    destroy(game);
  });
});

describe('AH-0MW2AVRNL008F9FX AC3: per-state coverage for all four countdown sources', () => {
  it('arriving consumable recharge: empty at spend → half → nearly full', async () => {
    const { store, reg, total } = rechargingConsumable();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const fractions: number[] = [];
    const sample = () => {
      hud.refresh();
      fractions.push(
        hud.getRows().find((entry) => entry.id === 'force_field')!.countdown!,
      );
    };

    sample(); // just spent
    store.tickRecharge(total / 2);
    sample();
    store.tickRecharge(total / 2 - 0.01); // still owed, but nearly returned
    sample();
    destroy(game);

    expect(fractions[0]).toBeCloseTo(0, 6);
    expect(fractions[1]).toBeCloseTo(0.5, 6);
    // 0.01 s of the wait is still owed, so the ring is nearly complete.
    expect(fractions[2]).toBeCloseTo(1 - 0.01 / total, 6);
    expect(fractions[1]).toBeGreaterThan(fractions[0]);
    expect(fractions[2]).toBeGreaterThan(fractions[1]);
  });

  it('arriving Orbital Strike cadence: empty after a bolt → half → nearly due', async () => {
    const { reg, total } = strikeCadence();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const sample = () => {
      hud.refresh();
      return hud.getRows().find((entry) => entry.id === 'strike')!.countdown!;
    };

    const empty = sample();
    reg.updateStrike(total / 2);
    const half = sample();
    reg.updateStrike(total / 2 - 0.01);
    const nearlyDue = sample();
    destroy(game);

    expect(empty).toBeCloseTo(0, 6);
    expect(half).toBeCloseTo(0.5, 6);
    expect(nearlyDue).toBeCloseTo(1 - 0.01 / total, 6);
    expect(half).toBeGreaterThan(empty);
    expect(nearlyDue).toBeGreaterThan(half);
  });

  it('expiring power-up window: complete at pickup → half → nearly empty', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('speed_boost');
    const total = reg.powerUpTemporaryRemaining('speed_boost')!;
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const sample = () => {
      hud.refresh();
      return hud.getRows().find((entry) => entry.id === 'speed_boost')!.countdown!;
    };

    const full = sample();
    reg.tick(total / 2);
    const half = sample();
    reg.tick(total / 2 - 0.01);
    const nearlyEmpty = sample();
    destroy(game);

    expect(full).toBeCloseTo(1, 6);
    expect(half).toBeCloseTo(0.5, 6);
    expect(nearlyEmpty).toBeCloseTo(0.01 / total, 6);
    expect(half).toBeLessThan(full);
    expect(nearlyEmpty).toBeLessThan(half);
  });

  it('expiring weapon window: complete at pickup → half → nearly empty', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyWeapon('spread');
    const total = reg.activeWeapons()[0].duration;
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const sample = () => {
      hud.refresh();
      return hud.getLoadoutRows().find((row) => row.id === 'spread')!.countdown!;
    };

    const full = sample();
    reg.tick(total / 2);
    const half = sample();
    reg.tick(total / 2 - 0.01);
    const nearlyEmpty = sample();
    destroy(game);

    expect(full).toBeCloseTo(1, 6);
    expect(half).toBeCloseTo(0.5, 6);
    expect(nearlyEmpty).toBeCloseTo(0.01 / total, 6);
    expect(half).toBeLessThan(full);
    expect(nearlyEmpty).toBeLessThan(half);
  });
});

describe('AH-0MW2AVRNL008F9FX AC4: no countdown ⇒ no ring, and no object leak', () => {
  it('draws no arc on a row with no live countdown', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('magnet', true);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const icon = rowIcon(hud, hud.getRows()[0].label)!;
    expect(ringArc(icon)).toBeUndefined();
    destroy(game);
  });

  it('stops drawing the ring once the countdown is gone', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('magnet', true);
    reg.applyCollect('magnet'); // temporary window on top of the permanent base
    const total = reg.powerUpTemporaryRemaining('magnet')!;
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    expect(ringArc(rowIcon(hud, 'Magnet Lvl 2'))).toBeDefined();

    reg.tick(total + 0.5); // window expired, permanent base remains
    hud.refresh();
    expect(hud.getRows()[0].label).toBe('Magnet Lvl 1');
    expect(ringArc(rowIcon(hud, 'Magnet Lvl 1'))).toBeUndefined();
    destroy(game);
  });

  it('keeps the rendered child count bounded across many refreshes with a live countdown', async () => {
    const { store, reg, total } = rechargingConsumable();
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();
    const baseline = hudChildren(hud).length;
    expect(baseline).toBeGreaterThan(0);

    for (let i = 0; i < 120; i += 1) {
      store.tickRecharge(total / 300); // sub-second fraction movement per frame
      hud.refresh();
    }
    expect(hudChildren(hud).length).toBe(baseline);

    for (let i = 0; i < 120; i += 1) hud.refresh();
    expect(hudChildren(hud).length).toBe(baseline);
    destroy(game);
  });
});

describe('AH-0MW2AVRNL008F9FX AC5: layout invariants', () => {
  it('does not move the label, value or marker columns and fits inside the row', async () => {
    const reg = new EffectsRegistry(new PowerUpLevelStore());
    reg.applyCollect('magnet', true); // no countdown: the layout baseline
    reg.applyCollect('speed_boost'); // countdown row
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const plain = rowTexts(hud, 'Magnet Lvl 1', PERMANENT_VALUE);
    const ringed = rowTexts(hud, 'Speed Boost Lvl 1', '10s');
    expect(plain.labelText).toBeDefined();
    expect(ringed.labelText).toBeDefined();

    // Same columns, and the rows keep the shared row height apart.
    expect(ringed.labelText!.x).toBe(plain.labelText!.x);
    expect(ringed.valueText!.x).toBe(plain.valueText!.x);

    const arc = ringArc(rowIcon(hud, 'Speed Boost Lvl 1'))!;
    expect(arc).toBeDefined();
    // The ring sits outside the 8 px glyph but clear of the label column.
    expect(arc.radius).toBeGreaterThan(4);
    expect(arc.x + arc.radius + RING_STROKE_WIDTH / 2).toBeLessThan(
      ringed.labelText!.x,
    );
    // …and inside the 22 px row band it belongs to.
    const row = hud.getRows().find((entry) => entry.id === 'speed_boost')!;
    expect(row).toBeDefined();
    expect(arc.radius * 2).toBeLessThan(HUD_ROW_HEIGHT);
    destroy(game);
  });

  it('keeps the shared grey on a greyed empty-pool row’s ring', async () => {
    // Owned with its charge spent → greyed, and half the wait elapsed so the
    // ring actually has a sweep to draw (an arriving ring is empty at spend).
    const { store, reg, total } = rechargingConsumable();
    store.tickRecharge(total / 2);
    const { game, hud } = await bootWithHUD(reg);
    hud.refresh();

    const row = hud.getRows().find((entry) => entry.id === 'force_field')!;
    expect(row.greyed).toBe(true);
    const icon = rowIcon(hud, row.label)!;
    expect(firstStrokeColour(icon)).toBe(POWER_UP_GREY_COLOUR);
    expect(ringColour(icon)).toBe(POWER_UP_GREY_COLOUR);
    destroy(game);
  });
});
