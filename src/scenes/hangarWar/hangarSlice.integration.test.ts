/**
 * Hangar slice — end-to-end verification (AH-0MVUXC2T0009Y42G, phase A gate of
 * **Build Candidate D — Hangar War**).
 *
 * This suite proves the hangar slice stands alone as a complete outer loop
 * before any ring work starts (`docs/OUTER_LOOP_CANDIDATES.md` *Minimal first
 * slice* / *Recommendation*): deploy → bank salvage at a checkpoint → lose the
 * run → buy an unlock → deploy again with the new hull/loadout, all through an
 * **injected storage** so no test touches the browser's `localStorage`.
 *
 * It composes the *same shipped modules* the game composes — the versioned
 * store (`hangarWarStore`), salvage banking (`salvageBanking`), the unlock tree
 * (`hangarCatalogue` + `hangarScreen` updaters) and the deployment launch data
 * (`hangarDeployment`) — rather than a parallel test-only path, so the cycle
 * cannot drift from what `HangarScene`/`PlayScene` actually run. The
 * `PlayScene` side of the seam (banking at a mini-boss checkpoint, and a
 * deployment never writing the arcade checkpoint) is pinned by
 * `PlayScene.hangarWar.test.ts`; this file pins the slice as a whole.
 *
 * The second block is the **shipped-game regression assertion**: the classic
 * campaign start is still the default, the arcade checkpoint/Continue
 * semantics and the leaderboard/settings keys are untouched by the slice, and
 * the run's six shared loadout slots still admit Extra Life and Mystery UFO.
 * Those suites themselves are not modified — the slice is additive.
 *
 * @module src/scenes/hangarWar/hangarSlice.integration.test
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_LIVES, MAX_LIVES } from '../../core/GameState';
import {
  LEADERBOARD_STORAGE_KEY,
  addEntry,
  getEntries,
} from '../../core/Leaderboard';
import {
  CHECKPOINT_STORAGE_KEY,
  CHECKPOINT_VERSION,
  clearCheckpoint,
  hasCheckpoint,
  loadCheckpoint,
  saveCheckpoint,
  type Checkpoint,
} from '../../core/checkpointStore';
import { POWER_UP_SLOT_CAP } from '../../core/constants';
import {
  DEFAULT_HULL_ID,
  DEFAULT_STARTING_WEAPON_ID,
  HANGAR_WAR_STORAGE_KEY,
  HANGAR_WAR_VERSION,
  createDefaultPayload,
  loadHangarWarPayload,
  saveHangarWarPayload,
} from '../../core/hangarWar/hangarWarStore';
import {
  bankSalvage,
  bankedSalvageFromHangar,
  forfeitUnbankedSalvage,
  runSalvageFromRun,
  unbankedSalvage,
  type BankedSalvage,
} from '../../core/hangarWar/salvageBanking';
import { createInMemoryHangarWarStorage } from '../../core/hangarWar/storage';
import type {
  HangarWarPayload,
  HangarWarStorage,
} from '../../core/hangarWar/types';
import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
} from '../../core/settingsStore';
import { isWithinSlotPool, resolveSlotState } from '../../powerups/slots';
import type { PowerUpId } from '../../powerups/types';
import {
  applyHangarWarDeployment,
  buildHangarDeployment,
  readHangarWarDeployment,
  type HangarWarDeployment,
} from './hangarDeployment';
import {
  equipHangarHull,
  purchaseHangarEntry,
  toggleHangarModifier,
  toggleHangarWeapon,
} from './hangarScreen';

/** The war seed every scenario derives from (deterministic runs). */
const SLICE_SEED = 20261030;

/** The arcade checkpoint the mode-separation test keeps alive. */
const ARCADE_CHECKPOINT: Checkpoint = {
  version: CHECKPOINT_VERSION,
  level: 4,
  wave: 1,
  lives: 2,
  score: 9876,
  minerals: 3,
  mineralHoldCapacity: 5,
  weaponLevels: [],
  powerUpLevels: [],
  runSeed: 4242,
  savedAt: '2026-10-30T00:00:00.000Z',
};

/** The six ordinary power-up kinds used to fill the shared loadout pool. */
const POOL_FILLING_KINDS: readonly PowerUpId[] = [
  'shield',
  'bomb',
  'speed_boost',
  'phase_shift',
  'teleport',
  'magnet',
];

/**
 * Opens the war the hangar screen would open: the stored payload when there is
 * one, otherwise a fresh minimal fleet (`HangarScene.loadPayload`).
 */
function openWar(storage: HangarWarStorage): HangarWarPayload {
  return loadHangarWarPayload(storage) ?? createDefaultPayload(SLICE_SEED);
}

/**
 * Banks one checkpoint moment into the persistent payload and writes it through
 * the versioned store — exactly what `PlayScene._bankSalvageAtCheckpoint` does.
 */
function bankAtCheckpoint(
  payload: HangarWarPayload,
  bank: BankedSalvage,
  runId: string,
  checkpointId: string,
  minerals: number,
  cores: number,
  storage: HangarWarStorage,
): BankedSalvage {
  const next = bankSalvage(
    bank,
    runSalvageFromRun({ runId, checkpointId, minerals, cores }),
  );
  payload.hangar.bankedMinerals = next.minerals;
  payload.hangar.bankedCores = next.cores;
  saveHangarWarPayload(payload, storage);
  return next;
}

/** Applies a deployment through the shared seams and records what was applied. */
function applyDeployment(deployment: HangarWarDeployment): {
  lives: number | null;
  equipped: Array<{ id: string; permanent: boolean | undefined }>;
} {
  const applied = {
    lives: null as number | null,
    equipped: [] as Array<{ id: string; permanent: boolean | undefined }>,
  };
  applyHangarWarDeployment(
    {
      getPlayer: () => ({
        equipWeapon: (id, permanent) => {
          applied.equipped.push({ id, permanent });
        },
      }),
      setStartingLives: (lives) => {
        applied.lives = lives;
      },
    },
    deployment,
  );
  return applied;
}

describe('Hangar slice — end to end (AH-0MVUXC2T0009Y42G)', () => {
  it('walks deploy → bank → lose → buy → redeploy, forfeiting only unbanked salvage', () => {
    const storage = createInMemoryHangarWarStorage();

    // ── 1. A fresh war is the minimal fleet with nothing banked ──────────
    expect(loadHangarWarPayload(storage)).toBeNull();
    let payload = openWar(storage);
    expect(payload.version).toBe(HANGAR_WAR_VERSION);
    expect(payload.hangar.unlockedHulls).toEqual([DEFAULT_HULL_ID]);
    expect(payload.hangar.unlockedWeapons).toEqual([
      DEFAULT_STARTING_WEAPON_ID,
    ]);
    expect(payload.hangar.ownedModifiers).toEqual([]);
    expect(payload.hangar.bankedMinerals).toBe(0);
    expect(payload.hangar.bankedCores).toBe(0);

    // ── 2. Deploy: the starter hull and its factory weapon ──────────────
    const firstDeployment = buildHangarDeployment(payload);
    expect(firstDeployment).toMatchObject({
      hexId: null,
      aggression: 0,
      startLevel: 1,
      hullId: DEFAULT_HULL_ID,
      startingLives: DEFAULT_LIVES,
      startingWeapons: [DEFAULT_STARTING_WEAPON_ID],
      modifiers: [],
    });
    expect(applyDeployment(firstDeployment)).toEqual({
      lives: DEFAULT_LIVES,
      equipped: [{ id: DEFAULT_STARTING_WEAPON_ID, permanent: true }],
    });

    // ── 3. Bank the salvage earned at the run's checkpoint moments ───────
    // A run starts its watermark empty (PlayScene rebuilds the bank from the
    // stored hangar balance), so each run banks its own snapshot afresh.
    const runOneId = `run-${firstDeployment.seed}`;
    let bank = bankedSalvageFromHangar(payload.hangar);
    bank = bankAtCheckpoint(
      payload,
      bank,
      runOneId,
      'checkpoint-1',
      140,
      1,
      storage,
    );
    expect(bank).toMatchObject({ minerals: 140, cores: 1 });
    bank = bankAtCheckpoint(
      payload,
      bank,
      runOneId,
      'checkpoint-2',
      260,
      2,
      storage,
    );
    // Cumulative snapshots bank only the increase, never the whole run twice.
    expect(bank).toMatchObject({ minerals: 260, cores: 2 });
    expect(
      bankSalvage(
        bank,
        runSalvageFromRun({
          runId: runOneId,
          checkpointId: 'checkpoint-2',
          minerals: 260,
          cores: 2,
        }),
      ),
    ).toMatchObject({ minerals: 260, cores: 2 });
    expect(loadHangarWarPayload(storage)?.hangar).toMatchObject({
      bankedMinerals: 260,
      bankedCores: 2,
    });

    // ── 4. Lose the run: only the unbanked salvage is forfeit ────────────
    const storedAtDeath = storage.getItem(HANGAR_WAR_STORAGE_KEY);
    const runEnd = runSalvageFromRun({
      runId: runOneId,
      checkpointId: 'run-end',
      minerals: 300,
      cores: 3,
    });
    expect(unbankedSalvage(bank, runEnd)).toEqual({ minerals: 40, cores: 1 });
    const loss = forfeitUnbankedSalvage(bank, runEnd);
    expect(loss.forfeited).toEqual({ minerals: 40, cores: 1 });
    expect(loss.banked).toMatchObject({ minerals: 260, cores: 2 });
    // Death writes nothing: the banked balance and the hangar survive intact.
    expect(storage.getItem(HANGAR_WAR_STORAGE_KEY)).toBe(storedAtDeath);

    // ── 5. Buy unlocks and equip them for the next deployment ────────────
    const afterWeapon = purchaseHangarEntry(payload, 'wave_laser');
    expect(afterWeapon.ok).toBe(true);
    expect(afterWeapon.payload.hangar).toMatchObject({
      bankedMinerals: 140,
      bankedCores: 1,
    });
    expect(afterWeapon.payload.hangar.unlockedWeapons).toContain('wave_laser');
    payload = afterWeapon.payload;

    const equippedWeapon = toggleHangarWeapon(payload, 'wave_laser');
    expect(equippedWeapon.ok).toBe(true);
    expect(
      equippedWeapon.payload.hangar.activeLoadout.startingWeapons,
    ).toEqual([DEFAULT_STARTING_WEAPON_ID, 'wave_laser']);
    payload = equippedWeapon.payload;

    const afterModifier = purchaseHangarEntry(payload, 'hardened_plating');
    expect(afterModifier.ok).toBe(true);
    expect(afterModifier.payload.hangar).toMatchObject({
      bankedMinerals: 60,
      bankedCores: 0,
    });
    payload = afterModifier.payload;

    const equippedModifier = toggleHangarModifier(payload, 'hardened_plating');
    expect(equippedModifier.ok).toBe(true);
    expect(equippedModifier.payload.hangar.activeLoadout.modifiers).toEqual([
      'hardened_plating',
    ]);
    payload = equippedModifier.payload;

    // The extra hull is a real, still-unaffordable choice: 220/3 > 60/0.
    const refusedHull = purchaseHangarEntry(payload, 'hull-2');
    expect(refusedHull.ok).toBe(false);
    expect(refusedHull.reason).toBe('unaffordable');
    expect(refusedHull.payload.hangar).toEqual(payload.hangar);
    saveHangarWarPayload(payload, storage);

    // ── 6. Redeploy: the same run code with the newly bought loadout ─────
    const reloaded = loadHangarWarPayload(storage);
    expect(reloaded).not.toBeNull();
    const secondDeployment = buildHangarDeployment(reloaded!);
    expect(secondDeployment.hullId).toBe(DEFAULT_HULL_ID);
    expect(secondDeployment.startingWeapons).toEqual([
      DEFAULT_STARTING_WEAPON_ID,
      'wave_laser',
    ]);
    expect(secondDeployment.modifiers).toEqual(['hardened_plating']);
    // The modifier's one extra life is a run stat, not a cosmetic unlock.
    expect(secondDeployment.startingLives).toBe(DEFAULT_LIVES + 1);
    expect(applyDeployment(secondDeployment)).toEqual({
      lives: DEFAULT_LIVES + 1,
      equipped: [
        { id: DEFAULT_STARTING_WEAPON_ID, permanent: true },
        { id: 'wave_laser', permanent: true },
      ],
    });

    // ── 7. A later run banks enough for the extra hull, then redeploys ───
    payload = reloaded!;
    let secondBank = bankedSalvageFromHangar(payload.hangar);
    secondBank = bankAtCheckpoint(
      payload,
      secondBank,
      `run-${secondDeployment.seed}`,
      'checkpoint-1',
      220,
      3,
      storage,
    );
    expect(secondBank).toMatchObject({ minerals: 280, cores: 3 });

    const boughtHull = purchaseHangarEntry(payload, 'hull-2');
    expect(boughtHull.ok).toBe(true);
    expect(boughtHull.payload.hangar.unlockedHulls).toEqual([
      DEFAULT_HULL_ID,
      'hull-2',
    ]);
    const equippedHull = equipHangarHull(boughtHull.payload, 'hull-2');
    expect(equippedHull.ok).toBe(true);
    saveHangarWarPayload(equippedHull.payload, storage);

    const thirdDeployment = buildHangarDeployment(
      loadHangarWarPayload(storage)!,
    );
    expect(thirdDeployment.hullId).toBe('hull-2');
    expect(thirdDeployment.speedMultiplier).toBe(0.85);
    // Bulwark's four lives plus Hardened Plating, capped at the run's maximum.
    expect(thirdDeployment.startingLives).toBe(MAX_LIVES);
    expect(thirdDeployment.startingWeapons).toEqual([
      DEFAULT_STARTING_WEAPON_ID,
      'wave_laser',
    ]);
    expect(thirdDeployment.modifiers).toEqual(['hardened_plating']);

    // One versioned key carries the whole slice — nothing else was written.
    expect(storage.keys()).toEqual([HANGAR_WAR_STORAGE_KEY]);
  });

  it('keeps the hangar and the arcade checkpoint in separate keys, so Continue is untouched', () => {
    const storage = createInMemoryHangarWarStorage();
    expect(saveCheckpoint(ARCADE_CHECKPOINT, storage)).toBe(true);
    const storedCheckpoint = storage.getItem(CHECKPOINT_STORAGE_KEY);
    expect(hasCheckpoint(storage)).toBe(true);
    expect(loadCheckpoint(storage)).toEqual(ARCADE_CHECKPOINT);

    // Run a slice pass: bank, buy, equip and persist the war.
    const payload = openWar(storage);
    const deployment = buildHangarDeployment(payload);
    bankAtCheckpoint(
      payload,
      bankedSalvageFromHangar(payload.hangar),
      `run-${deployment.seed}`,
      'checkpoint-1',
      200,
      2,
      storage,
    );
    const purchase = purchaseHangarEntry(payload, 'wave_laser');
    expect(purchase.ok).toBe(true);
    expect(saveHangarWarPayload(purchase.payload, storage)).toBe(true);

    // Continue still resumes the arcade checkpoint, byte-for-byte.
    expect(storage.getItem(CHECKPOINT_STORAGE_KEY)).toBe(storedCheckpoint);
    expect(loadCheckpoint(storage)).toEqual(ARCADE_CHECKPOINT);
    expect(hasCheckpoint(storage)).toBe(true);
    expect(storage.keys().sort()).toEqual(
      [CHECKPOINT_STORAGE_KEY, HANGAR_WAR_STORAGE_KEY].sort(),
    );

    // Starting a new arcade game clears the checkpoint, never the hangar.
    const storedHangar = storage.getItem(HANGAR_WAR_STORAGE_KEY);
    clearCheckpoint(storage);
    expect(storage.getItem(CHECKPOINT_STORAGE_KEY)).toBeNull();
    expect(hasCheckpoint(storage)).toBe(false);
    expect(storage.getItem(HANGAR_WAR_STORAGE_KEY)).toBe(storedHangar);
  });

  it('leaves the shipped run untouched: arcade default, six slots, Extra Life, Mystery UFO, leaderboard and settings', () => {
    // Classic campaign start is still the default: only tagged launch data
    // switches PlayScene into a hangar deployment.
    expect(readHangarWarDeployment(undefined)).toBeNull();
    expect(readHangarWarDeployment(null)).toBeNull();
    expect(readHangarWarDeployment({})).toBeNull();
    expect(readHangarWarDeployment({ kind: 'not-a-deployment' })).toBeNull();

    // Six shared loadout slots, with Extra Life and Mystery UFO exempt from
    // the cap and every other seventh kind gated until a slot frees.
    expect(POWER_UP_SLOT_CAP).toBe(6);
    const fullPool = resolveSlotState(
      POOL_FILLING_KINDS.map((id) => ({ id, level: 1 })),
      [],
    );
    expect(fullPool.used).toBe(6);
    expect(fullPool.free).toBe(0);
    expect(fullPool.isFull).toBe(true);
    expect(isWithinSlotPool('extra_life', fullPool)).toBe(true);
    expect(isWithinSlotPool('mystery_ufo', fullPool)).toBe(true);
    expect(isWithinSlotPool('mineral_scoop', fullPool)).toBe(false);

    // Leaderboard and settings keep their own keys; a slice pass never
    // overwrites or migrates them.
    const storage = createInMemoryHangarWarStorage();
    addEntry('ABC', 1234, storage);
    const storedLeaderboard = storage.getItem(LEADERBOARD_STORAGE_KEY);
    expect(getEntries(storage)).toHaveLength(1);

    const previousSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    try {
      saveSettings({ ...DEFAULT_SETTINGS, sfxVolume: 0.25, sfxMuted: true });
      const storedSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

      const payload = openWar(storage);
      bankAtCheckpoint(
        payload,
        bankedSalvageFromHangar(payload.hangar),
        `run-${buildHangarDeployment(payload).seed}`,
        'checkpoint-1',
        120,
        1,
        storage,
      );
      const purchase = purchaseHangarEntry(payload, 'hardened_plating');
      expect(purchase.ok).toBe(true);
      expect(saveHangarWarPayload(purchase.payload, storage)).toBe(true);

      expect(storage.getItem(LEADERBOARD_STORAGE_KEY)).toBe(storedLeaderboard);
      expect(getEntries(storage)).toHaveLength(1);
      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(
        storedSettings,
      );
      expect(loadSettings()).toMatchObject({ sfxVolume: 0.25, sfxMuted: true });
    } finally {
      if (previousSettings === null) {
        window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
      } else {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, previousSettings);
      }
    }
  });
});
