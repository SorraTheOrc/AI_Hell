/**
 * Weapon tuning gym (AH-0MW0Q1HMH0037RNC) — panel binding, Save / Save As,
 * catalogue re-read and the read-only rhythm ladder.
 *
 * Boots the real scene through the shared deterministic harness so the preview
 * runs the shipped auto-fire/collision path. The store's dev-server transport
 * and payload are pinned separately in `src/core/weaponCatalogueStore.test.ts`;
 * here the store's test-mode path (registry-only) is exercised through the
 * buttons, which is exactly what a suite must never write to disk.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../../test/gameHarness';
import { GymIndex } from '../GymIndex';
import { discoverGymScenes, loadGymSceneModules } from '../../utils/gymDiscovery';
import {
  GYM_WEAPON_TUNING_SCENE_KEY,
  GymWeaponTuning,
  WEAPON_RHYTHM_READ_ONLY_NOTE,
  WEAPON_TUNING_FIELD_ATTR,
  WEAPON_TUNING_NOMINAL_ID,
  WEAPON_TUNING_PANEL_ID,
  WEAPON_TUNING_PREVIEW_LEVEL_ID,
  WEAPON_TUNING_READONLY_ID,
  WEAPON_TUNING_RHYTHM_EDITORS_ID,
  WEAPON_TUNING_RHYTHM_FIELD_ATTR,
  WEAPON_TUNING_RHYTHM_ID,
  WEAPON_TUNING_RHYTHM_ROW_ATTR,
  WEAPON_TUNING_RHYTHM_STATUS_ID,
  WEAPON_TUNING_ROW_ATTR,
  WEAPON_TUNING_SAVE_AS_ID,
  WEAPON_TUNING_SAVE_AS_INPUT_ID,
  WEAPON_TUNING_SAVE_ID,
  WEAPON_TUNING_SELECT_ID,
  WEAPON_TUNING_STATUS_ID,
  describeEditableWeaponRhythm,
  describeWeaponRhythm,
  maxPreviewLevel,
} from './GymWeaponTuning';
import {
  DEFAULT_WEAPON_SUBDIVISIONS,
  WEAPON_CATALOGUE,
  WEAPON_IDS,
  type WeaponId,
} from '../../utils/weapons';
import {
  WEAPON_EUCLIDEAN_LADDERS,
  resolveWeaponPattern,
} from '../../utils/weaponLevels';
import {
  getPersistedWeaponDefinition,
  resetWeaponCatalogueStore,
} from '../../core/weaponCatalogueStore';
import { resetWeaponLevelsStore } from '../../core/weaponLevelsStore';

describe('GymWeaponTuning — discovery', () => {
  it('is auto-discovered by the gym folder glob', () => {
    const entries = discoverGymScenes(loadGymSceneModules());
    const entry = entries.find((e) => e.key === GYM_WEAPON_TUNING_SCENE_KEY);
    expect(entry).toBeDefined();
    expect(entry!.label).toBe('WeaponTuning');
  });
});

describe('GymWeaponTuning — scene and panel', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetWeaponCatalogueStore();
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.unstubAllEnvs();
    resetWeaponCatalogueStore();
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    document.body.innerHTML = '';
  });

  async function bootTuning(): Promise<GymWeaponTuning> {
    booted = await bootScene([GymWeaponTuning]);
    return booted.scene as GymWeaponTuning;
  }

  it('is listed by the real gym index and registered so it can be started', async () => {
    booted = await bootScene([GymIndex]);
    const index = booted.scene as GymIndex;
    expect(index.listedScenes.map((s) => s.key)).toContain(
      GYM_WEAPON_TUNING_SCENE_KEY,
    );
    expect(booted.game.scene.getScene(GYM_WEAPON_TUNING_SCENE_KEY)).not.toBeNull();
  });

  it('boots with a player, a dummy target and a collapsible .gym-panel', async () => {
    const scene = await bootTuning();
    expect(scene.sys.isActive()).toBe(true);
    expect(scene.getPlayer()).not.toBeNull();
    expect(scene.getTarget()).not.toBeNull();
    expect(scene.getTarget()!.alive).toBe(true);

    const panel = document.getElementById(WEAPON_TUNING_PANEL_ID);
    expect(panel, 'tuning panel missing').not.toBeNull();
    expect(panel!.className).toContain('gym-panel');
    expect(panel!.querySelector('.gym-panel-toggle')).not.toBeNull();
  });

  it('lists every catalogue weapon in the selector and defaults to cannon', async () => {
    const scene = await bootTuning();
    const select = document.getElementById(
      WEAPON_TUNING_SELECT_ID,
    ) as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect([...select.options].map((option) => option.value)).toEqual([
      ...WEAPON_IDS,
    ]);
    expect(select.value).toBe('cannon');
    expect(scene.getSelectedWeapon()).toBe('cannon');
  });

  it('binds bulletSize to the live definition and previews it without a restart', async () => {
    const scene = await bootTuning();
    const select = document.getElementById(
      WEAPON_TUNING_SELECT_ID,
    ) as HTMLSelectElement;
    select.value = 'spread';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const size = document.querySelector<HTMLInputElement>(
      `[${WEAPON_TUNING_FIELD_ATTR}="bulletSize"]`,
    );
    expect(size).not.toBeNull();
    size!.value = '1.75';
    size!.dispatchEvent(new Event('input', { bubbles: true }));

    expect(scene.getDraftDefinition().bulletSize).toBe(1.75);
    // The live runtime catalogue the preview ship fires is updated at once.
    expect(WEAPON_CATALOGUE.spread.bulletSize).toBe(1.75);
    expect(scene.getPlayer()!.getWeaponDef('spread').bulletSize).toBe(1.75);
    // It is still an unsaved draft.
    expect(getPersistedWeaponDefinition('spread').bulletSize).not.toBe(1.75);
  });

  it('shows the AOE controls only for the AOE family and binds aoeRadius', async () => {
    const scene = await bootTuning();
    const aoeRow = document.querySelector<HTMLElement>(
      `[${WEAPON_TUNING_ROW_ATTR}="aoeRadius"]`,
    )!;
    expect(aoeRow.hidden).toBe(true);

    const select = document.getElementById(
      WEAPON_TUNING_SELECT_ID,
    ) as HTMLSelectElement;
    select.value = 'nova';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    expect(aoeRow.hidden).toBe(false);
    const radius = document.querySelector<HTMLInputElement>(
      `[${WEAPON_TUNING_FIELD_ATTR}="aoeRadius"]`,
    )!;
    const before = scene.getDraftDefinition().aoe?.radius ?? 0;
    radius.value = String(before + 10);
    radius.dispatchEvent(new Event('input', { bubbles: true }));

    expect(scene.getDraftDefinition().aoe?.radius).toBe(before + 10);
    expect(WEAPON_CATALOGUE.nova.aoe?.radius).toBe(before + 10);
  });

  it('Save persists the draft and re-seeds the panel from the catalogue', async () => {
    const scene = await bootTuning();
    const select = document.getElementById(
      WEAPON_TUNING_SELECT_ID,
    ) as HTMLSelectElement;
    select.value = 'rapid';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const size = document.querySelector<HTMLInputElement>(
      `[${WEAPON_TUNING_FIELD_ATTR}="bulletSize"]`,
    )!;
    size.value = '1.4';
    size.dispatchEvent(new Event('input', { bubbles: true }));

    (document.getElementById(WEAPON_TUNING_SAVE_ID) as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById(WEAPON_TUNING_STATUS_ID)!.textContent).toContain(
        'Saved rapid',
      ),
    );
    expect(getPersistedWeaponDefinition('rapid').bulletSize).toBe(1.4);
    expect(WEAPON_CATALOGUE.rapid.bulletSize).toBe(1.4);
    expect(scene.getDraftDefinition().bulletSize).toBe(1.4);
  });

  it('Save As refuses an unknown id with a visible reason and leaves the catalogue unchanged', async () => {
    await bootTuning();
    const input = document.getElementById(
      WEAPON_TUNING_SAVE_AS_INPUT_ID,
    ) as HTMLInputElement;
    input.value = 'brand_new_weapon';
    (document.getElementById(WEAPON_TUNING_SAVE_AS_ID) as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById(WEAPON_TUNING_STATUS_ID)!.textContent).toContain(
        'No code fallback definition',
      ),
    );
    expect(WEAPON_IDS).not.toContain('brand_new_weapon');
    expect(WEAPON_CATALOGUE['brand_new_weapon' as WeaponId]).toBeUndefined();
  });

  it('Save As refuses a duplicate id with a visible reason', async () => {
    await bootTuning();
    const input = document.getElementById(
      WEAPON_TUNING_SAVE_AS_INPUT_ID,
    ) as HTMLInputElement;
    input.value = 'dual';
    (document.getElementById(WEAPON_TUNING_SAVE_AS_ID) as HTMLButtonElement).click();

    await vi.waitFor(() =>
      expect(document.getElementById(WEAPON_TUNING_STATUS_ID)!.textContent).toContain(
        'already exists',
      ),
    );
  });

  it('keeps every editable control keyboard-accessible and on the shared panel conventions', async () => {
    await bootTuning();
    const panel = document.getElementById(WEAPON_TUNING_PANEL_ID)!;
    const controls = panel.querySelectorAll<HTMLElement>(
      'input, select, button',
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      // A native, focusable control — no bespoke widget and no negative tabindex.
      expect(['INPUT', 'SELECT', 'BUTTON']).toContain(control.tagName);
      expect(Number(control.getAttribute('tabindex') ?? '0')).toBeGreaterThanOrEqual(0);
    }
    // Tooltips are attached through the shared helper (aria-describedby).
    const size = panel.querySelector<HTMLInputElement>(
      `[${WEAPON_TUNING_FIELD_ATTR}="bulletSize"]`,
    )!;
    expect(size.getAttribute('aria-describedby')).not.toBeNull();
    expect(panel.querySelector('.gym-panel-actions')).not.toBeNull();
  });
});

describe('GymWeaponTuning — rhythm panel (AC7)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetWeaponCatalogueStore();
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.unstubAllEnvs();
    resetWeaponCatalogueStore();
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    document.body.innerHTML = '';
  });

  it('describes the live ladder rung for rung, matching resolveWeaponPattern', () => {
    for (const id of WEAPON_IDS) {
      const rows = describeWeaponRhythm(id);
      const ladder = WEAPON_EUCLIDEAN_LADDERS[id];
      expect(rows).toHaveLength(ladder.length);
      for (const [index, row] of rows.entries()) {
        const node = ladder[index];
        expect(row.levelFrom).toBe(node.minLevel);
        expect(row.k).toBe(node.pattern.k);
        expect(row.n).toBe(node.pattern.n);
        expect(row.rotation).toBe(node.pattern.rotation);
        expect(row.onsetsPerBeat).toBeCloseTo(node.onsetsPerBeat, 6);
        const resolved = resolveWeaponPattern(id, row.levelFrom);
        expect(resolved.k).toBe(row.k);
        expect(resolved.n).toBe(row.n);
        expect(resolved.rotation).toBe(row.rotation);
      }
    }
  });

  it('renders the ladder for the selected weapon and states the read-only cadence rule', async () => {
    booted = await bootScene([GymWeaponTuning]);
    const scene = booted.scene as GymWeaponTuning;
    scene.selectWeapon('heavy_slug');

    const rhythm = document.getElementById(WEAPON_TUNING_RHYTHM_ID)!;
    // The read-only cadence note is stated by the panel (not buried in code).
    expect(
      document.getElementById(WEAPON_TUNING_PANEL_ID)!.textContent,
    ).toContain(WEAPON_RHYTHM_READ_ONLY_NOTE);
    for (const row of describeWeaponRhythm('heavy_slug')) {
      expect(rhythm.textContent).toContain(`E(${row.k},${row.n})`);
    }

    const nominal = document.getElementById(WEAPON_TUNING_NOMINAL_ID)!;
    expect(nominal.textContent).toContain('Legacy nominal');
    expect(nominal.textContent).toContain(
      String(DEFAULT_WEAPON_SUBDIVISIONS.heavy_slug),
    );
    // The legacy nominal figure is labelled as legacy and read-only — there is
    // no editable fire-rate or subdivisions control anywhere in the panel.
    expect(
      document.querySelector(`[${WEAPON_TUNING_FIELD_ATTR}="fireRateMs"]`),
    ).toBeNull();
    expect(
      document.querySelector(`[${WEAPON_TUNING_FIELD_ATTR}="subdivisions"]`),
    ).toBeNull();
  });

  it('clamps the preview-rung slider to the weapon ladder and re-equips the rung', async () => {
    booted = await bootScene([GymWeaponTuning]);
    const scene = booted.scene as GymWeaponTuning;
    scene.selectWeapon('heavy_slug');
    const max = maxPreviewLevel('heavy_slug');
    const slider = document.getElementById(
      WEAPON_TUNING_PREVIEW_LEVEL_ID,
    ) as HTMLInputElement;
    expect(slider.max).toBe(String(max));

    slider.value = String(max);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scene.getPreviewLevel()).toBe(max);

    // Out-of-range input is clamped to the authored ladder.
    scene.setPreviewLevel(max + 99);
    expect(scene.getPreviewLevel()).toBe(max);
    scene.setPreviewLevel(-5);
    expect(scene.getPreviewLevel()).toBe(0);

    // The permanent cannon cannot be levelled through the collection API, so
    // its preview is pinned to level 0 (the ladder is still shown).
    scene.selectWeapon('cannon');
    scene.setPreviewLevel(5);
    expect(scene.getPreviewLevel()).toBe(0);
    expect(
      document.getElementById(WEAPON_TUNING_PREVIEW_LEVEL_ID),
    ).toHaveProperty('max', '0');
  });
});

describe('GymWeaponTuning — live preview firing', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetWeaponCatalogueStore();
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.unstubAllEnvs();
    resetWeaponCatalogueStore();
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    document.body.innerHTML = '';
  });

  it('fires the selected weapon at the dummy target through the shared scheduler', async () => {
    booted = await bootScene([GymWeaponTuning]);
    const scene = booted.scene as GymWeaponTuning;
    scene.selectWeapon('spread');

    for (let frame = 0; frame < 180; frame += 1) scene.tick(1 / 60);

    expect(scene.getFiredWeapons()).toContain('spread');
    expect(scene.getBullets().length).toBeGreaterThan(0);
    // The dummy is a tuning fixture: it absorbs hits and stays alive.
    expect(scene.getTarget()!.alive).toBe(true);
  });

  it('keeps firing after a save so the re-read catalogue drives the preview', async () => {
    booted = await bootScene([GymWeaponTuning]);
    const scene = booted.scene as GymWeaponTuning;
    scene.selectWeapon('rapid');
    const size = document.querySelector<HTMLInputElement>(
      `[${WEAPON_TUNING_FIELD_ATTR}="bulletSize"]`,
    )!;
    size.value = '1.6';
    size.dispatchEvent(new Event('input', { bubbles: true }));
    (document.getElementById(WEAPON_TUNING_SAVE_ID) as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(
        document.getElementById(WEAPON_TUNING_STATUS_ID)!.textContent,
      ).toContain('Saved rapid'),
    );

    for (let frame = 0; frame < 180; frame += 1) scene.tick(1 / 60);
    expect(scene.getFiredWeapons()).toContain('rapid');
    expect(scene.getPlayer()!.getWeaponDef('rapid').bulletSize).toBe(1.6);
  });
});

describe('GymWeaponTuning — read-only build (AC4/AC8)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetWeaponCatalogueStore();
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.unstubAllEnvs();
    resetWeaponCatalogueStore();
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    document.body.innerHTML = '';
  });

  it('disables Save / Save As with a visible message outside the dev server', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    booted = await bootScene([GymWeaponTuning]);

    const notice = document.getElementById(WEAPON_TUNING_READONLY_ID);
    expect(notice, 'read-only notice missing').not.toBeNull();
    expect(notice!.textContent).toContain('Read-only build');
    expect(
      (document.getElementById(WEAPON_TUNING_SAVE_ID) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (document.getElementById(WEAPON_TUNING_SAVE_AS_ID) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe('GymWeaponTuning — editable rhythm + Save (AH-0MW0WLZ9600693R9)', () => {
  let booted: BootedGame | null = null;

  beforeEach(() => {
    localStorage.clear();
    resetWeaponCatalogueStore();
    resetWeaponLevelsStore();
    document.body.innerHTML = '<div id="game-container"></div>';
  });

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    vi.unstubAllEnvs();
    resetWeaponCatalogueStore();
    resetWeaponLevelsStore();
    document.getElementById(WEAPON_TUNING_PANEL_ID)?.remove();
    document.body.innerHTML = '';
  });

  async function bootTuning(): Promise<GymWeaponTuning> {
    booted = await bootScene([GymWeaponTuning]);
    return booted.scene as GymWeaponTuning;
  }

  /** The editable input for one rung/field. */
  function rhythmControl(row: Element, field: string): HTMLInputElement {
    return row.querySelector<HTMLInputElement>(
      `[${WEAPON_TUNING_RHYTHM_FIELD_ATTR}="${field}"]`,
    )!;
  }

  function rhythmRows(): Element[] {
    return [
      ...document.querySelectorAll(
        `#${WEAPON_TUNING_RHYTHM_EDITORS_ID} [${WEAPON_TUNING_RHYTHM_ROW_ATTR}]`,
      ),
    ];
  }

  it('renders one editable k/n/rotation control set per authored rung, seeded from the ladder', async () => {
    const scene = await bootTuning();
    scene.selectWeapon('heavy_slug');

    const authored = describeEditableWeaponRhythm('heavy_slug');
    const rows = rhythmRows();
    expect(rows.length).toBe(authored.length);
    expect(rows.length).toBeGreaterThan(0);

    for (const [index, rung] of authored.entries()) {
      expect(rhythmControl(rows[index], 'k').value).toBe(String(rung.k));
      expect(rhythmControl(rows[index], 'n').value).toBe(String(rung.n));
      expect(rhythmControl(rows[index], 'rotation').value).toBe(
        String(rung.rotation),
      );
    }
  });

  it('builds the exact PUT payload and updates the live rhythm on Save without a restart', async () => {
    const scene = await bootTuning();
    scene.selectWeapon('cannon');

    const row = rhythmRows()[0];
    const kInput = rhythmControl(row, 'k');
    kInput.value = '10'; // cannon rung 0: 9/16 -> 10/16 (non-decreasing)
    kInput.dispatchEvent(new Event('input', { bubbles: true }));

    expect(scene.getRhythmDraft()[0]).toStrictEqual({
      k: 10,
      n: 16,
      rotation: 0,
    });
    const payload = JSON.parse(scene.getRhythmPayloadJson()) as {
      weaponId: string;
      rungs: unknown[];
    };
    expect(payload.weaponId).toBe('cannon');
    expect(payload.rungs).toStrictEqual(scene.getRhythmDraft());

    (document.getElementById(WEAPON_TUNING_SAVE_ID) as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(
        document.getElementById(WEAPON_TUNING_STATUS_ID)!.textContent,
      ).toContain('Saved cannon'),
    );

    // The live ladder the scheduler reads now plays the saved rung.
    expect(resolveWeaponPattern('cannon', 0)).toStrictEqual({
      k: 10,
      n: 16,
      rotation: 0,
      stepMs: resolveWeaponPattern('cannon', 0).stepMs,
    });
  });

  it('shows a diagnostic naming weapon/rung/field for an invalid edit and does not re-time the rhythm', async () => {
    const scene = await bootTuning();
    scene.selectWeapon('cannon');
    const before = resolveWeaponPattern('cannon', 0);

    const kInput = rhythmControl(rhythmRows()[0], 'k');
    kInput.value = '20'; // k > n
    kInput.dispatchEvent(new Event('input', { bubbles: true }));

    const rhythmStatus = document.getElementById(
      WEAPON_TUNING_RHYTHM_STATUS_ID,
    )!;
    expect(rhythmStatus.textContent).toContain('cannon[0]');
    expect(rhythmStatus.textContent).toContain('must not exceed n');
    // The running rhythm is not silently re-timed.
    expect(resolveWeaponPattern('cannon', 0)).toEqual(before);

    // Save is refused with the same diagnostic and leaves the ladder alone.
    (document.getElementById(WEAPON_TUNING_SAVE_ID) as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(
        document.getElementById(WEAPON_TUNING_STATUS_ID)!.textContent,
      ).toContain('Save failed'),
    );
    expect(resolveWeaponPattern('cannon', 0)).toEqual(before);
  });

  it('keeps the preview-rung slider and audition working alongside the editors', async () => {
    const scene = await bootTuning();
    scene.selectWeapon('heavy_slug');

    const max = maxPreviewLevel('heavy_slug');
    const slider = document.getElementById(
      WEAPON_TUNING_PREVIEW_LEVEL_ID,
    ) as HTMLInputElement;
    expect(slider.max).toBe(String(max));
    slider.value = String(max);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    expect(scene.getPreviewLevel()).toBe(max);

    for (let frame = 0; frame < 180; frame += 1) scene.tick(1 / 60);
    expect(scene.getFiredWeapons()).toContain('heavy_slug');
  });

  it('disables the rhythm controls and Save with a visible read-only message', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('MODE', 'production');
    booted = await bootScene([GymWeaponTuning]);

    const rows = rhythmRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      for (const field of ['k', 'n', 'rotation']) {
        expect(rhythmControl(row, field).disabled).toBe(true);
      }
    }
    expect(
      (document.getElementById(WEAPON_TUNING_SAVE_ID) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    const notice = document.getElementById(WEAPON_TUNING_READONLY_ID);
    expect(notice).not.toBeNull();
    expect(notice!.textContent!.toLowerCase()).toContain('rhythm');
  });
});
