/**
 * Regression tests for the shared gym-panel anchoring stylesheet contract
 * (AH-0MUAYB7O4009LWBF).
 *
 * The gym editor panels are plain DOM under `#game-container`; the game's
 * Phaser HUD renders at the top-left of the canvas.  These tests load the
 * real `src/style.css` into happy-dom and assert the computed anchoring
 * properties, so a future edit that moves the panels back to the top (or
 * drops the height cap) fails here.
 *
 * happy-dom does not perform real layout, but it does cascade injected
 * stylesheets, so `getComputedStyle` is a meaningful assertion for the
 * `position`/`bottom`/`max-height`/`overflow-y` contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read the real stylesheet from disk: Vite's CSS pipeline strips `?raw`
// CSS imports, and vitest processes plain CSS imports as empty modules
// unless `css: true` is configured.
const css = readFileSync(resolve(process.cwd(), 'src/style.css'), 'utf8');

/** Injects the real stylesheet into the document once per test. */
function injectStylesheet(): void {
  const style = document.createElement('style');
  style.setAttribute('data-test', 'gym-panel-anchoring');
  style.textContent = css;
  document.head.appendChild(style);
}

/** Creates a panel element with the id and class used by a gym scene. */
function makePanel(id: string): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = 'gym-panel';
  document.body.appendChild(panel);
  return panel;
}

describe('gym-panel anchoring stylesheet (AH-0MUAYB7O4009LWBF)', () => {
  afterEach(() => {
    document.head
      .querySelectorAll('style[data-test="gym-panel-anchoring"]')
      .forEach((el) => el.remove());
    document.body.innerHTML = '';
  });

  it('anchors every gym panel to the bottom-left (not the top)', () => {
    injectStylesheet();

    for (const id of [
      'gym-config-panel',
      'enemy-gym-panel',
      'boss-gym-panel',
    ]) {
      const panel = makePanel(id);
      const computed = getComputedStyle(panel);
      expect(computed.position, `${id} position`).toBe('fixed');
      expect(computed.bottom, `${id} bottom`).toBe('8px');
      expect(computed.left, `${id} left`).toBe('8px');
      // The panels must no longer be pinned to the top (the HUD lives there).
      // happy-dom leaves an unset `top` as '', so accept '' or 'auto'.
      expect(['', 'auto'], `${id} top`).toContain(computed.top);
      expect(computed.top, `${id} top`).not.toBe('8px');
    }
  });

  it('caps panel height to the viewport with internal vertical scrolling', () => {
    injectStylesheet();

    const panel = makePanel('enemy-gym-panel');
    const computed = getComputedStyle(panel);

    // The cap is viewport-relative (100vh minus a reserve) rather than a
    // fixed pixel height, so a tall panel never extends above the HUD.
    // happy-dom resolves `100vh` to the viewport height (768px), leaving a
    // `calc(<viewport> - <reserve>)` expression with a positive reserve.
    const match = computed.maxHeight.match(
      /calc\((\d+(?:\.\d+)?)px\s*-\s*(\d+(?:\.\d+)?)px\)/,
    );
    expect(match, `unexpected maxHeight: ${computed.maxHeight}`).not.toBeNull();
    const viewportPx = Number(match![1]);
    const reservePx = Number(match![2]);
    expect(viewportPx).toBeGreaterThan(reservePx);
    expect(reservePx).toBeGreaterThan(0);
    expect(computed.overflowY).toBe('auto');
  });

  it('defines the shared anchoring on the .gym-panel class', () => {
    injectStylesheet();

    const panel = document.createElement('div');
    panel.className = 'gym-panel';
    document.body.appendChild(panel);
    const computed = getComputedStyle(panel);

    expect(computed.position).toBe('fixed');
    expect(computed.bottom).toBe('8px');
    expect(computed.left).toBe('8px');
    expect(computed.overflowY).toBe('auto');
  });

  it("hides .gym-panel-body when the panel is collapsed but keeps the header visible (AH-0MUDYFMUX007Q0W3)", () => {
    injectStylesheet();

    const panel = makePanel('enemy-gym-panel');
    const header = document.createElement('div');
    header.className = 'gym-panel-header';
    const body = document.createElement('div');
    body.className = 'gym-panel-body';
    panel.append(header, body);

    // Default expanded: the body is laid out.
    panel.setAttribute('data-collapsed', 'false');
    expect(getComputedStyle(body).display).not.toBe('none');

    // Collapsed: the body is hidden, the header (and toggle) stay visible.
    panel.setAttribute('data-collapsed', 'true');
    expect(getComputedStyle(body).display).toBe('none');
    expect(getComputedStyle(header).display).not.toBe('none');
  });
});
