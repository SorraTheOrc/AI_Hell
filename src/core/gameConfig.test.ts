/**
 * Scene-registration guard for the shipped game config (AH-0MVZ4S9ZU004GXUM).
 *
 * Phaser only resolves `scene.start('<Key>')` for scenes listed in
 * `buildGameConfig().scene`; an unregistered scene target silently does
 * nothing at runtime. `DefenceReportScene` was exactly that case: `PlayScene`
 * starts it after a Hangar War deployment ends, but it was missing from the
 * boot list, so the between-sortie report never appeared and the Hangar War
 * loop died after the first deployment.
 *
 * **Why the rest of the suite did not catch it.** The traversal and
 * integration suites boot an explicit scene-class list through
 * `src/test/gameHarness.ts` (`bootScene(sceneClasses, parent)`), so they never
 * exercise `buildGameConfig()` at all — a scene missing from the shipped array
 * is invisible to them. This suite asserts the shipped array itself:
 *
 * 1. every scene key a shipped screen starts resolves from
 *    `buildGameConfig().scene` (the transition guard that would have failed for
 *    `DefenceReportScene`), and
 * 2. every registered scene's *actual* Phaser key equals its class name, so the
 *    key-based transitions above cannot silently miss a renamed scene.
 */

import { describe, expect, it } from 'vitest';
import type Phaser from 'phaser';

import { buildGameConfig } from './gameConfig';
import { DEFENCE_REPORT_SCENE_KEY, DefenceReportScene } from '../scenes/DefenceReportScene';
import { HANGAR_SCENE_KEY, HangarScene } from '../scenes/HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from '../scenes/HexMapScene';

/**
 * Every scene key the shipped screens start by name.
 *
 * Maintained alongside the `scene.start(...)` call sites; the second assertion
 * below keeps it honest (a key that no longer matches a registered scene's own
 * key fails), and the end-to-end Hangar War flow suite
 * (`src/scenes/hangarWarFlow.integration.test.ts`) exercises the real
 * transitions through the shipped config.
 */
const TRANSITION_TARGETS = [
  'MenuScene',
  'PlayScene',
  'HangarScene',
  'HexMapScene',
  DEFENCE_REPORT_SCENE_KEY,
  'PauseScene',
  'HelpScene',
  'MineralChoiceScene',
  'MiniBossWheelScene',
  'SettingsScene',
  'TelemetryConsentScene',
  'GameOverScene',
  'LeaderboardScene',
  'GymIndex',
] as const;

/** The shipped scene array, as Phaser receives it. */
function shippedScenes(): (typeof Phaser.Scene)[] {
  return buildGameConfig().scene as unknown as (typeof Phaser.Scene)[];
}

/** The Phaser key each registered scene class actually boots with. */
function registeredKeys(): string[] {
  return shippedScenes().map(
    (sceneClass) =>
      (new sceneClass() as Phaser.Scene).sys.settings.key as string,
  );
}

describe('shipped scene registration', () => {
  it('boot-registers every Hangar War screen under its scene key', () => {
    const registered = shippedScenes();

    expect(registered).toContain(HangarScene);
    expect(registered).toContain(HexMapScene);
    expect(registered).toContain(DefenceReportScene);

    // The scene convention is key === class name; a mismatch would make the
    // registration useless (Phaser starts scenes by key).
    expect(HANGAR_SCENE_KEY).toBe(HangarScene.name);
    expect(HEX_MAP_SCENE_KEY).toBe(HexMapScene.name);
    expect(DEFENCE_REPORT_SCENE_KEY).toBe(DefenceReportScene.name);
  });

  it('resolves every scene key the shipped screens start', () => {
    const keys = new Set(registeredKeys());

    // A `scene.start('<Key>')` whose key is missing from the shipped array is a
    // silent no-op at runtime: this is the assertion that failed for the
    // unregistered `DefenceReportScene` (AH-0MVZ4S9ZU004GXUM AC2).
    for (const target of TRANSITION_TARGETS) {
      expect(
        keys.has(target),
        `scene key "${target}" is started by a shipped screen but is not ` +
          `registered in buildGameConfig().scene`,
      ).toBe(true);
    }
  });

  it('registers every scene under its own class name', () => {
    for (const sceneClass of shippedScenes()) {
      const scene = new sceneClass() as Phaser.Scene;
      expect(
        scene.sys.settings.key,
        `${sceneClass.name} boots with a key that differs from its class name`,
      ).toBe(sceneClass.name);
    }
  });
});
