/**
 * Scene-registration guard for the shipped game config.
 *
 * Phaser only resolves `scene.start('<Key>')` for scenes listed in
 * `buildGameConfig().scene`; an unregistered scene target silently does
 * nothing at runtime. `DefenceReportScene` was exactly that case: `PlayScene`
 * starts it after a Hangar War deployment ends, but it was missing from the
 * boot list, so the between-sortie report never appeared. The capture tooling
 * has the same dependency (it switches to boot-registered Hangar War screens
 * in-page, AH-0MVWMUQUC003WXF5), so this pins the three Hangar War screens in
 * the boot scene list.
 */

import { describe, expect, it } from 'vitest';

import { buildGameConfig } from './gameConfig';
import { DEFENCE_REPORT_SCENE_KEY, DefenceReportScene } from '../scenes/DefenceReportScene';
import { HANGAR_SCENE_KEY, HangarScene } from '../scenes/HangarScene';
import { HEX_MAP_SCENE_KEY, HexMapScene } from '../scenes/HexMapScene';

describe('shipped scene registration', () => {
  it('boot-registers every Hangar War screen under its scene key', () => {
    const registered = buildGameConfig().scene as unknown[];

    expect(registered).toContain(HangarScene);
    expect(registered).toContain(HexMapScene);
    expect(registered).toContain(DefenceReportScene);

    // The scene convention is key === class name; a mismatch would make the
    // registration useless (Phaser starts scenes by key).
    expect(HANGAR_SCENE_KEY).toBe(HangarScene.name);
    expect(HEX_MAP_SCENE_KEY).toBe(HexMapScene.name);
    expect(DEFENCE_REPORT_SCENE_KEY).toBe(DefenceReportScene.name);
  });
});
