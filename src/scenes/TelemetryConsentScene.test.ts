/**
 * Scene tests for the production telemetry consent prompt
 * (AH-0MUY08Y9P005ER7A, AC1/AC3).
 *
 * Covers: the prompt renders the privacy summary; the safe default is
 * focused; opting in/out persists the decision and returns to the origin
 * scene; ESC declines.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { loadTelemetryConsent } from '../core/telemetryConsentStore';
import { MenuScene } from './MenuScene';
import { TelemetryConsentScene } from './TelemetryConsentScene';

describe('TelemetryConsentScene (AH-0MUY08Y9P005ER7A)', () => {
  let booted: BootedGame | null = null;

  afterEach(() => {
    booted?.game.destroy(true);
    booted = null;
    window.localStorage.clear();
  });

  async function bootConsent(origin = 'MenuScene'): Promise<TelemetryConsentScene> {
    booted = await bootScene([TelemetryConsentScene, MenuScene]);
    booted.game.scene.start('TelemetryConsentScene', { origin });
    await new Promise((r) => setTimeout(r, 150));
    return booted.game.scene.getScene('TelemetryConsentScene') as TelemetryConsentScene;
  }

  it('shows a privacy summary that states no-PII and retention', async () => {
    const scene = await bootConsent();
    const text = scene.getPrivacySummary();
    expect(text).toMatch(/never records names, emails, accounts/i);
    expect(text).toMatch(/retained for a bounded period/i);
    expect(text).toMatch(/Settings/i);
  });

  it('focuses the privacy-safe default (decline)', async () => {
    const scene = await bootConsent();
    expect(scene.getFocusedLabel()).toBe('deny');
  });

  it('Allow telemetry grants consent, records the decision and returns to the origin', async () => {
    const scene = await bootConsent('MenuScene');

    scene.allow();
    await new Promise((r) => setTimeout(r, 150));

    expect(loadTelemetryConsent()).toEqual({ granted: true, decided: true });
    expect(booted!.game.scene.isActive('MenuScene')).toBe(true);
    expect(booted!.game.scene.isActive('TelemetryConsentScene')).toBe(false);
  });

  it('No thanks denies consent but records that the player decided', async () => {
    const scene = await bootConsent();

    scene.deny();
    await new Promise((r) => setTimeout(r, 150));

    expect(loadTelemetryConsent()).toEqual({ granted: false, decided: true });
  });

  it('ESC declines without opting in', async () => {
    await bootConsent();

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 150));

    expect(loadTelemetryConsent()).toEqual({ granted: false, decided: true });
  });
});
