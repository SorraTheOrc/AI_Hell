/**
 * Scene tests for the Settings screen audio section
 * (AH-0MUA8BEUR006RWCI — child of the In-game menu epic
 * AH-0MU9LPZ0G0015292).
 *
 * Covers: initial values from persisted settings (defaults when unset),
 * slider change → live master volume + persistence, mute toggle restore
 * semantics, restore-on-reopen, and Back navigation to the origin scene.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootScene, type BootedGame } from '../test/gameHarness';
import {
  loadSettings,
  saveSettings,
  DEFAULT_BINDINGS,
  type SettingsRecord,
} from '../core/settingsStore';
import { PauseScene } from './PauseScene';
import { MenuScene } from './MenuScene';
import { SettingsScene } from './SettingsScene';
import { setSfxMuted, setSfxVolume } from '../audio/effects';

// Verify the scene actually drives the live master SFX plumbing.
vi.mock('../audio/effects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../audio/effects')>();
  return {
    ...actual,
    setSfxVolume: vi.fn(),
    setSfxMuted: vi.fn(),
  };
});

const setSfxVolumeMock = vi.mocked(setSfxVolume);
const setSfxMutedMock = vi.mocked(setSfxMuted);

function customSettings(partial: Partial<SettingsRecord>): SettingsRecord {
  return {
    sfxVolume: 1,
    sfxMuted: false,
    bindings: { ...DEFAULT_BINDINGS },
    ...partial,
  };
}

describe('SettingsScene — SFX volume slider + mute toggle (AH-0MUA8BEUR006RWCI)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  async function bootSettings(origin = 'PauseScene'): Promise<SettingsScene> {
    booted = await bootScene([SettingsScene, PauseScene, MenuScene]);
    booted!.game.scene.start('SettingsScene', { origin });
    await new Promise((r) => setTimeout(r, 150));
    return booted!.game.scene.getScene('SettingsScene') as SettingsScene;
  }

  // ── AC4 — initial values ────────────────────────────────────────

  it('AC4 — initialises from persisted settings (defaults when unset)', async () => {
    window.localStorage.clear();
    const scene = await bootSettings();
    expect(scene.getSfxVolume()).toBe(1);
    expect(scene.isSfxMuted()).toBe(false);
  });

  it('AC4 — initialises from saved non-default settings', async () => {
    window.localStorage.clear();
    saveSettings(customSettings({ sfxVolume: 0.35, sfxMuted: true }));
    const scene = await bootSettings();
    expect(scene.getSfxVolume()).toBe(0.35);
    expect(scene.isSfxMuted()).toBe(true);
  });

  // ── AC1 — slider change → live volume + persistence ─────────────

  it('AC1 — setVolume applies the master SFX volume live and persists it', async () => {
    window.localStorage.clear();
    const scene = await bootSettings();

    scene.setVolume(0.4);

    expect(scene.getSfxVolume()).toBe(0.4);
    expect(setSfxVolumeMock).toHaveBeenCalledWith(0.4);
    expect(loadSettings().sfxVolume).toBe(0.4);
    // The persisted rest of the record is intact.
    expect(loadSettings().bindings).toEqual(DEFAULT_BINDINGS);
    expect(loadSettings().sfxMuted).toBe(false);
  });

  it('AC1 — volume clamps to the 0–1 slider range', async () => {
    const scene = await bootSettings();
    scene.setVolume(2.5);
    expect(scene.getSfxVolume()).toBe(1);
    expect(loadSettings().sfxVolume).toBe(1);

    scene.setVolume(-1);
    expect(scene.getSfxVolume()).toBe(0);
    expect(loadSettings().sfxVolume).toBe(0);
  });

  it('AC1 — keyboard left/right nudges the slider while it is focused', async () => {
    const scene = await bootSettings();
    expect(scene.getFocusedLabel()).toBe('volume');

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    // Starts at the default 1.0; nudging up clamps at 1.0.
    expect(scene.getSfxVolume()).toBe(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(scene.getSfxVolume()).toBe(1);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(scene.getSfxVolume()).toBeCloseTo(0.95, 5);
  });

  // ── AC2 — mute toggle ───────────────────────────────────────────

  it('AC2 — muting silences live and preserves the persisted volume', async () => {
    const scene = await bootSettings();
    scene.setVolume(0.6);

    scene.setMuted(true);

    expect(scene.isSfxMuted()).toBe(true);
    expect(setSfxMutedMock).toHaveBeenCalledWith(true);
    // The volume is preserved while muted (persisted unchanged).
    expect(loadSettings().sfxVolume).toBe(0.6);
    expect(loadSettings().sfxMuted).toBe(true);
  });

  it('AC2 — un-muting restores the volume without losing it', async () => {
    const scene = await bootSettings();
    scene.setVolume(0.7);
    scene.setMuted(true);
    scene.setMuted(false);

    expect(scene.isSfxMuted()).toBe(false);
    expect(setSfxMutedMock).toHaveBeenLastCalledWith(false);
    expect(scene.getSfxVolume()).toBe(0.7);
    expect(loadSettings().sfxVolume).toBe(0.7);
    expect(loadSettings().sfxMuted).toBe(false);
  });

  // ── AC3 — persistence across reload ─────────────────────────────

  it('AC3 — a simulated reload restores volume and mute from storage', async () => {
    window.localStorage.clear();
    const scene = await bootSettings();
    scene.setVolume(0.25);
    scene.setMuted(true);

    // Destroy and re-open the scene ("page reload").
    booted!.game.destroy(true);
    booted = null;
    const scene2 = await bootSettings();
    expect(scene2.getSfxVolume()).toBe(0.25);
    expect(scene2.isSfxMuted()).toBe(true);
    expect(scene2.getSfxVolume()).not.toBe(1);
  });

  // ── Back navigation ─────────────────────────────────────────────

  it('returns to the origin scene via Back', async () => {
    const scene = await bootSettings();
    expect(booted!.game.scene.isActive('SettingsScene')).toBe(true);

    scene.goBack();
    await new Promise((r) => setTimeout(r, 150));

    expect(booted!.game.scene.isActive('SettingsScene')).toBe(false);
    expect(booted!.game.scene.isActive('PauseScene')).toBe(true);
  });

  it('respects a MenuScene origin for Back', async () => {
    const scene = await bootSettings('MenuScene');
    scene.goBack();
    await new Promise((r) => setTimeout(r, 150));

    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('SettingsScene')).toBe(false);
  });
});