/**
 * Unit tests for the shared gym-panel collapse/expand helper
 * (AH-0MUDYFMUX007Q0W3).
 *
 * The helper is plain DOM (no Phaser), so it is exercised directly in
 * happy-dom: it wraps a panel's existing children in a `.gym-panel-body`
 * and prepends a `.gym-panel-header` carrying a native toggle button.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  GYM_PANEL_BODY_CLASS,
  GYM_PANEL_COLLAPSED_ATTR,
  GYM_PANEL_HEADER_CLASS,
  GYM_PANEL_TOGGLE_CLASS,
  makeCollapsible,
} from './gymPanel';

/** Builds a panel with two children in a known order. */
function makePanel(id = 'test-gym-panel'): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = id;
  panel.className = 'gym-panel';
  const first = document.createElement('span');
  first.id = 'first-child';
  const second = document.createElement('span');
  second.id = 'second-child';
  panel.append(first, second);
  document.body.appendChild(panel);
  return panel;
}

describe('makeCollapsible', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('prepends a header and wraps the existing children in a body, preserving order', () => {
    const panel = makePanel();
    const { header, body } = makeCollapsible({ panel, title: 'AI Config' });

    // Header is the panel's first element and carries the shared class.
    expect(panel.firstElementChild).toBe(header);
    expect(header.className).toContain(GYM_PANEL_HEADER_CLASS);
    expect(header.parentElement).toBe(panel);

    // Every pre-existing child now lives in the body, in the same order.
    expect(body.className).toContain(GYM_PANEL_BODY_CLASS);
    expect(body.parentElement).toBe(panel);
    expect(body.children).toHaveLength(2);
    expect(body.children[0].id).toBe('first-child');
    expect(body.children[1].id).toBe('second-child');
  });

  it('exposes a native toggle labelled with the title and wired to the body', () => {
    const panel = makePanel();
    const { body, toggle } = makeCollapsible({ panel, title: 'AI Config' });

    expect(toggle).toBeInstanceOf(HTMLButtonElement);
    expect(toggle.type).toBe('button');
    expect(toggle.className).toContain(GYM_PANEL_TOGGLE_CLASS);
    expect(toggle.textContent).toContain('AI Config');
    expect(toggle.getAttribute('aria-controls')).toBe(body.id);
    expect(body.id).not.toBe('');
  });

  it('starts expanded with consistent state attributes', () => {
    const panel = makePanel();
    const { isCollapsed, toggle } = makeCollapsible({ panel, title: 'Boss Config' });

    expect(panel.getAttribute(GYM_PANEL_COLLAPSED_ATTR)).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(isCollapsed()).toBe(false);
  });

  it('collapses on toggle activation and expands again on a second activation', () => {
    const panel = makePanel();
    const { isCollapsed, toggle } = makeCollapsible({ panel, title: 'AI Config' });

    toggle.click();
    expect(isCollapsed()).toBe(true);
    expect(panel.getAttribute(GYM_PANEL_COLLAPSED_ATTR)).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(isCollapsed()).toBe(false);
    expect(panel.getAttribute(GYM_PANEL_COLLAPSED_ATTR)).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('setCollapsed drives the state and the toggle attributes', () => {
    const panel = makePanel();
    const { setCollapsed, toggle } = makeCollapsible({ panel, title: 'AI Config' });

    setCollapsed(true);
    expect(panel.getAttribute(GYM_PANEL_COLLAPSED_ATTR)).toBe('true');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    setCollapsed(false);
    expect(panel.getAttribute(GYM_PANEL_COLLAPSED_ATTR)).toBe('false');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });
});
