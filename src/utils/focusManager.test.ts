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

import { afterEach, describe, expect, it, vi } from 'vitest';
import Phaser from 'phaser';

import { FocusManager } from './focusManager';

/** Creates a lightweight text-gameobject double with a spy on `setStyle`. */
function makeControl(label: string): Phaser.GameObjects.Text {
  return { text: label, setStyle: vi.fn() } as unknown as Phaser.GameObjects.Text;
}

/** Creates a lightweight scene double exposing `input.keyboard.on/off`. */
function makeScene(): Phaser.Scene {
  return {
    input: {
      keyboard: {
        on: vi.fn(),
        off: vi.fn(),
      },
    },
  } as unknown as Phaser.Scene;
}

/** The registered keydown handler from `attachKeyboard`. */
function keyHandler(scene: Phaser.Scene): (e: KeyboardEvent) => void {
  const on = vi.mocked(scene.input.keyboard!.on);
  return on.mock.calls[0][1] as (e: KeyboardEvent) => void;
}

let fm: FocusManager | null = null;

afterEach(() => {
  fm?.shutdown();
  fm = null;
});

/* ─── AC1 — register / unregister ─────────────────────────────── */

describe('FocusManager — register / unregister (AC1)', () => {
  it('register adds a control and returns its index', () => {
    const control = makeControl('dummy');
    fm = new FocusManager();

    expect(fm.register(control, vi.fn())).toBe(0);
    expect(fm.getControlCount()).toBe(1);
  });

  it('unregister removes a control and reduces count', () => {
    const f1 = makeControl('a');
    const f2 = makeControl('b');
    fm = new FocusManager();

    expect(fm.register(f1, vi.fn())).toBe(0);
    expect(fm.register(f2, vi.fn())).toBe(1);
    expect(fm.getControlCount()).toBe(2);

    expect(fm.unregister(f1)).toBe(0);
    expect(fm.getControlCount()).toBe(1);
  });

  it('unregister returns −1 for an unknown control', () => {
    const known = makeControl('a');
    const unknown = makeControl('b');
    fm = new FocusManager();
    fm.register(known, vi.fn());

    expect(fm.unregister(unknown)).toBe(-1);
  });

  it('unregistering the focused control moves focus to a remaining control', () => {
    const f1 = makeControl('a');
    const f2 = makeControl('b');
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    fm.unregister(f1);
    expect(fm.getFocusedIndex()).toBe(0);
    expect(fm.getControlCount()).toBe(1);
  });
});

/* ─── AC2 — default focus ─────────────────────────────────────── */

describe('FocusManager — default focus (AC2)', () => {
  it('focuses the first registered control by default', () => {
    const f1 = makeControl('first');
    const f2 = makeControl('second');
    fm = new FocusManager();

    fm.register(f1, vi.fn());
    fm.register(f2, vi.fn());

    expect(fm.getFocusedIndex()).toBe(0);
    // First control receives the focus style; the second the unfocus style.
    expect(f1.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
    expect(f2.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());
  });
});

/* ─── AC3 — Tab / Shift+Tab cycling ───────────────────────────── */

describe('FocusManager — Tab cycling (AC3)', () => {
  it('Tab cycles forward through controls', () => {
    const f = [makeControl('a'), makeControl('b'), makeControl('c')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(1);
    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(2);
  });

  it('Shift+Tab cycles backward', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

    fm.cycleFocus(-1);
    expect(fm.getFocusedIndex()).toBe(1);
    fm.cycleFocus(-1);
    expect(fm.getFocusedIndex()).toBe(0);
  });

  it('wrap-around: forward from last goes to first', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

    fm.cycleFocus(1); // → 1
    fm.cycleFocus(1); // → wraps to 0
    expect(fm.getFocusedIndex()).toBe(0);
  });

  it('wrap-around: backward from first goes to last', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

    fm.cycleFocus(-1); // → wraps to 1
    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('a single control stays focused on Tab', () => {
    fm = new FocusManager();
    fm.register(makeControl('a'), vi.fn());
    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(0);
  });
});

/* ─── AC4 — arrow-key cycling ─────────────────────────────────── */

describe('FocusManager — arrow-key cycling (AC4)', () => {
  it('ArrowDown cycles forward (same as Tab)', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

    fm.cycleFocus(1);
    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('ArrowUp cycles backward (same as Shift+Tab)', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

    fm.cycleFocus(-1);
    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('arrow keys wrap around', () => {
    const f = [makeControl('a'), makeControl('b'), makeControl('c')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));

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
    fm = new FocusManager();
    fm.register(makeControl('a'), action1);
    fm.register(makeControl('b'), action2);

    fm.activateFocused();
    expect(action1).toHaveBeenCalledOnce();
    expect(action2).not.toHaveBeenCalled();
  });

  it('Space invokes the focused control action callback', () => {
    const action = vi.fn();
    fm = new FocusManager();
    fm.register(makeControl('a'), action);

    fm.activateFocused();
    expect(action).toHaveBeenCalledOnce();
  });

  it('activation does NOT move focus (conventional menu behaviour)', () => {
    fm = new FocusManager();
    fm.register(makeControl('a'), vi.fn());
    fm.register(makeControl('b'), vi.fn());

    fm.activateFocused();
    expect(fm.getFocusedIndex()).toBe(0);
  });

  it('activation with no controls is a safe no-op', () => {
    fm = new FocusManager();
    expect(() => fm!.activateFocused()).not.toThrow();
  });
});

/* ─── AC6 — visible focus style ───────────────────────────────── */

describe('FocusManager — visible focus style (AC6)', () => {
  it('the focused control receives the focus style', () => {
    const f1 = makeControl('a');
    fm = new FocusManager();
    fm.register(f1, vi.fn());
    fm.register(makeControl('b'), vi.fn());

    expect(f1.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
  });

  it('moving focus repaints: previous gets unfocus, new gets focus style', () => {
    const f1 = makeControl('a');
    const f2 = makeControl('b');
    const f3 = makeControl('c');
    fm = new FocusManager();
    [f1, f2, f3].forEach((c) => fm!.register(c, vi.fn()));

    expect(f1.setStyle).toHaveBeenCalledWith(fm.getFocusStyle());
    expect(f2.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());
    expect(f3.setStyle).toHaveBeenCalledWith(fm.getUnfocusStyle());

    fm.setFocusedIndex(1);

    expect(f1.setStyle).toHaveBeenLastCalledWith(fm.getUnfocusStyle());
    expect(f2.setStyle).toHaveBeenLastCalledWith(fm.getFocusStyle());
    expect(f3.setStyle).toHaveBeenLastCalledWith(fm.getUnfocusStyle());
  });

  it('focus style defaults to bright colour + highlight border', () => {
    fm = new FocusManager();
    const style = fm.getFocusStyle();
    expect(style).toHaveProperty('color');
    expect(style).toHaveProperty('stroke');
    expect(style).toHaveProperty('strokeThickness');
  });

  it('the unfocus style explicitly clears the focus border', () => {
    fm = new FocusManager();
    // Phaser's setStyle merges, so the border must be cleared explicitly or
    // a previously-focused control would keep its stroke (exactly one
    // control must appear focused).
    expect(fm.getUnfocusStyle()).toHaveProperty('strokeThickness', 0);
  });
});

/* ─── AC7 — shutdown cleanup ──────────────────────────────────── */

describe('FocusManager — shutdown cleanup (AC7)', () => {
  it('shutdown clears the registry and resets focus', () => {
    fm = new FocusManager();
    fm.register(makeControl('a'), vi.fn());
    expect(fm.getControlCount()).toBe(1);

    fm.shutdown();
    expect(fm.getControlCount()).toBe(0);
    expect(fm.getFocusedIndex()).toBe(-1);
  });

  it('shutdown removes the keyboard listener from the scene', () => {
    fm = new FocusManager();
    fm.register(makeControl('a'), vi.fn());
    const scene = makeScene();
    fm.attachKeyboard(scene);

    const on = vi.mocked(scene.input.keyboard!.on);
    expect(on).toHaveBeenCalledOnce();

    fm.shutdown();

    const off = vi.mocked(scene.input.keyboard!.off);
    expect(off).toHaveBeenCalledOnce();
    expect(off.mock.calls[0][0]).toBe('keydown');
    expect(off.mock.calls[0][1]).toBe(on.mock.calls[0][1]);
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
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));
    const scene = makeScene();
    fm.attachKeyboard(scene);

    keyHandler(scene)({
      key: 'Tab',
      repeat: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('keydown Shift+Tab cycles focus backward', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));
    const scene = makeScene();
    fm.attachKeyboard(scene);

    keyHandler(scene)({
      key: 'Tab',
      shiftKey: true,
      repeat: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(fm.getFocusedIndex()).toBe(1); // wraps from 0 to last
  });

  it('keydown ArrowDown cycles focus forward', () => {
    const f = [makeControl('a'), makeControl('b')];
    fm = new FocusManager();
    f.forEach((c) => fm!.register(c, vi.fn()));
    const scene = makeScene();
    fm.attachKeyboard(scene);

    keyHandler(scene)({
      key: 'ArrowDown',
      repeat: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(fm.getFocusedIndex()).toBe(1);
  });

  it('keydown Enter activates the focused control', () => {
    const action = vi.fn();
    fm = new FocusManager();
    fm.register(makeControl('a'), action);
    const scene = makeScene();
    fm.attachKeyboard(scene);

    const preventDefault = vi.fn();
    keyHandler(scene)({
      key: 'Enter',
      repeat: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(action).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('keydown Space activates the focused control', () => {
    const action = vi.fn();
    fm = new FocusManager();
    fm.register(makeControl('a'), action);
    const scene = makeScene();
    fm.attachKeyboard(scene);

    keyHandler(scene)({
      key: ' ',
      repeat: false,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(action).toHaveBeenCalledOnce();
  });

  it('keydown with repeat flag is ignored', () => {
    const action = vi.fn();
    fm = new FocusManager();
    fm.register(makeControl('a'), action);
    const scene = makeScene();
    fm.attachKeyboard(scene);

    keyHandler(scene)({
      key: 'Enter',
      repeat: true,
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent);

    expect(action).not.toHaveBeenCalled();
  });

  it('unhandled keys are not consumed', () => {
    fm = new FocusManager();
    fm.register(makeControl('a'), vi.fn());
    const scene = makeScene();
    fm.attachKeyboard(scene);

    const preventDefault = vi.fn();
    keyHandler(scene)({
      key: 'q',
      repeat: false,
      preventDefault,
    } as unknown as KeyboardEvent);

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
