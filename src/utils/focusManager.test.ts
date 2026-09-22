/**
 * Unit tests for the in-canvas FocusManager (AH-0MU9LKQEP008LCX9-C1).
 *
 * Covers:
 * - Default focus on first registered control.
 * - Tab cycles forward with wrap-around.
 * - Shift+Tab cycles backward with wrap-around.
 * - Arrow keys cycle focus (up/down for vertical layout).
 * - Enter and Space activate the focused control.
 * - Visible focus style is applied to exactly one control.
 * - Shutdown removes keyboard listeners and clears the registry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { bootScene, type BootedGame } from '../test/gameHarness';
import { FocusManager } from './focusManager';

/* ─── helpers ──────────────────────────────────────────────────── */

/** Stub a minimal scene that exposes `add.text` and `input.keyboard`. */
async function bootWithFocusManager(
  sceneClass: typeof Phaser.Scene,
  onSceneCreate: (
    scene: Phaser.Scene,
    fm: FocusManager,
  ) => void,
): Promise<{ game: Phaser.Game; scene: Phaser.Scene; fm: FocusManager }> {
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    backgroundColor: '#000000',
    parent: document.body,
    scene: [
      {
        key: 'TestScene',
        extends: sceneClass,
        create(this: Phaser.Scene) {
          // Delegate to the caller for scene-specific setup.
          onSceneCreate(this, fm);
        },
      },
    ],
  });

  await new Promise((r) => setTimeout(r, 150));
  const scene = game.scene.getScenes(true)[0]!;
  return { game, scene, fm };
}

let fm: FocusManager | null = null;
let bootedGame: Phaser.Game | null = null;

afterEach(() => {
  fm?.shutdown();
  bootedGame?.destroy(true);
  fm = null;
  bootedGame = null;
});

/* ─── AC1 — register / unregister ─────────────────────────────── */

describe('FocusManager — register / unregister (AC1)', () => {
  it('register adds a control and returns its index', () => {
    const focusable = {
      text: 'dummy',
      setStyle: vi.fn(),
    } as unknown as Phaser.GameObjects.Text;
    const action = vi.fn();
    fm = new FocusManager();

    const idx = fm.register(focusable, action);
    expect(idx).toBe(0);
    expect(fm.getControlCount()).toBe(1);
  });

  it('unregister removes a control and reduces count', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const i1 = fm.register(f1, vi.fn());
    const i2 = fm.register(f2, vi.fn());
    expect(fm.getControlCount()).toBe(2);

    fm.unregister(f1);
    expect(fm.getControlCount()).toBe(1);
    expect(i1).toBe(0); // unregister returns the index
  });
});

/* ─── AC2 — default focus ─────────────────────────────────────── */

describe('FocusManager — default focus (AC2)', () => {
  it('focuses the first registered control by default', () => {
    const f1 = { text: 'first', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'second', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    expect(fm.getFocusedIndex()).toBe(0);
    // First control should have the focus style applied.
    expect(f1.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
    // Second control gets the unfocus style on registration.
    expect(f2.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());
  });
});

/* ─── AC3 — Tab / Shift+Tab cycling ───────────────────────────── */

describe('FocusManager — Tab cycling (AC3)', () => {
  it('Tab cycles forward through controls', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f3 = { text: 'c', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());
    fm.register(f3, vi.fn());

    // Tab forward → index 1.
    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(1);
    // Tab forward → index 2.
    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(2);
  });

  it('Shift+Tab cycles backward', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    // Start at 0; backward wraps to last.
    fm.cycleFocus(-1);
    expect(fm.getFocusedIndex()).toBe(1);

    // Backward again wraps to 0.
    fm.cycleFocus(-1);
    expect(fm.getFocusedIndex()).toBe(0);
  });

  it('wrap-around: forward from last goes to first', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    fm.cycleFocus(1); // → 1
    fm.cycleFocus(1); // → wraps to 0
    expect(fm.getFocusedIndex()).toBe(0);
  });

  it('wrap-around: backward from first goes to last', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    fm.cycleFocus(-1); // → wraps to 1
    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('a single control stays focused on Tab', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(0);
  });
});

/* ─── AC4 — arrow-key cycling ─────────────────────────────────── */

describe('FocusManager — arrow-key cycling (AC4)', () => {
  it('ArrowDown cycles forward (same as Tab)', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('ArrowUp cycles backward (same as Shift+Tab)', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    fm.cycleFocus(-1);
    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('arrow keys wrap around', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f3 = { text: 'c', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());
    fm.register(f3, vi.fn());

    // Down × 3 wraps: 0→1→2→0
    fm.cycleFocus(1);
    fm.cycleFocus(1);
    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(0);
  });
});

/* ─── AC5 — Enter / Space activation ──────────────────────────── */

describe('FocusManager — Enter / Space activation (AC5)', () => {
  it('Enter invokes the focused control action callback', () => {
    const action1 = vi.fn();
    const action2 = vi.fn();
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, action1);
    fm.register(f2, action2);

    fm.activateFocused();
    expect(action1).toHaveBeenCalledOnce();
    expect(action2).not.toHaveBeenCalled();
  });

  it('Space invokes the focused control action callback', () => {
    const action = vi.fn();
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, action);

    fm.activateFocused();
    expect(action).toHaveBeenCalledOnce();
  });

  it('activation moves focus forward (convenience for next control)', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    fm.activateFocused();
    expect(fm.getFocusedIndex()).toBe(1);
  });
});

/* ─── AC6 — visible focus style ───────────────────────────────── */

describe('FocusManager — visible focus style (AC6)', () => {
  it('the focused control receives the focus style', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    expect(f1.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
  });

  it('moving focus updates styles: previous restores, new gets focus style', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f3 = { text: 'c', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());
    fm.register(f3, vi.fn());

    // Focus is on f1 (index 0).
    expect(f1.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
    // f2 and f3 should have the unfocused style.
    expect(f2.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());
    expect(f3.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());

    // Move to f2.
    fm.setFocusedIndex(1);

    expect(f1.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());
    expect(f2.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
    expect(f3.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());
  });

  it('focus style defaults to bright colour + highlight border', () => {
    fm = new FocusManager();
    const style = fm.getFocusStyle();
    expect(style).toHaveProperty('color');
    expect(style).toHaveProperty('stroke');
    expect(style).toHaveProperty('strokeWidth');
  });
});

/* ─── AC7 — shutdown cleanup ──────────────────────────────────── */

describe('FocusManager — shutdown cleanup (AC7)', () => {
  it('shutdown clears the registry', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    expect(fm.getControlCount()).toBe(1);

    fm.shutdown();
    expect(fm.getControlCount()).toBe(0);
    expect(fm.getFocusedIndex()).toBe(-1);
  });

  it('shutdown is idempotent', () => {
    fm = new FocusManager();
    fm.shutdown();
    fm.shutdown(); // no throw
  });
});

/* ─── AC8 — keyboard event integration ────────────────────────── */

describe('FocusManager — keyboard event integration (AC8)', () => {
  it('keydown Tab cycles focus forward', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const scene = {
      input: {
        keyboard: {
          on: vi.fn(),
        },
      },
    } as unknown as Phaser.Scene;

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());
    fm.attachKeyboard(scene);

    // Simulate Tab keydown.
    const handler = (vi.mocked(scene.input.keyboard.on).mock.calls[0][1] as (e: KeyboardEvent) => void);
    handler({ key: 'Tab', repeat: false, preventDefault: vi.fn() } as KeyboardEvent);

    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('keydown Shift+Tab cycles focus backward', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const scene = {
      input: {
        keyboard: {
          on: vi.fn(),
        },
      },
    } as unknown as Phaser.Scene;

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());
    fm.attachKeyboard(scene);

    const handler = (vi.mocked(scene.input.keyboard.on).mock.calls[0][1] as (e: KeyboardEvent) => void);
    handler({
      key: 'Tab',
      shiftKey: true,
      repeat: false,
      preventDefault: vi.fn(),
    } as KeyboardEvent);

    expect(fm.getFocusedIndex()).toBe(1); // wraps from 0 to last
  });

  it('keydown ArrowDown cycles focus forward', () => {
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    const f2 = { text: 'b', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const scene = {
      input: {
        keyboard: {
          on: vi.fn(),
        },
      },
    } as unknown as Phaser.Scene;

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());
    fm.attachKeyboard(scene);

    const handler = (vi.mocked(scene.input.keyboard.on).mock.calls[0][1] as (e: KeyboardEvent) => void);
    handler({ key: 'ArrowDown', repeat: false, preventDefault: vi.fn() } as KeyboardEvent);

    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('keydown Enter activates focused control', () => {
    const action = vi.fn();
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const scene = {
      input: {
        keyboard: {
          on: vi.fn(),
        },
      },
    } as unknown as Phaser.Scene;

    fm.register(f1, action);
    fm.attachKeyboard(scene);

    const handler = (vi.mocked(scene.input.keyboard.on).mock.calls[0][1] as (e: KeyboardEvent) => void);
    handler({ key: 'Enter', repeat: false, preventDefault: vi.fn() } as KeyboardEvent);

    expect(action).toHaveBeenCalledOnce();
  });

  it('keydown Space activates focused control', () => {
    const action = vi.fn();
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const scene = {
      input: {
        keyboard: {
          on: vi.fn(),
        },
      },
    } as unknown as Phaser.Scene;

    fm.register(f1, action);
    fm.attachKeyboard(scene);

    const handler = (vi.mocked(scene.input.keyboard.on).mock.calls[0][1] as (e: KeyboardEvent) => void);
    handler({ key: ' ', repeat: false, preventDefault: vi.fn() } as KeyboardEvent);

    expect(action).toHaveBeenCalledOnce();
  });

  it('keydown with repeat flag is ignored', () => {
    const action = vi.fn();
    const f1 = { text: 'a', setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
    fm = new FocusManager();

    const scene = {
      input: {
        keyboard: {
          on: vi.fn(),
        },
      },
    } as unknown as Phaser.Scene;

    fm.register(f1, action);
    fm.attachKeyboard(scene);

    const handler = (vi.mocked(scene.input.keyboard.on).mock.calls[0][1] as (e: KeyboardEvent) => void);
    handler({ key: 'Enter', repeat: true, preventDefault: vi.fn() } as KeyboardEvent);

    // Repeated key should not trigger activation.
    expect(action).not.toHaveBeenCalled();
  });
});
