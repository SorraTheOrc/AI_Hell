/**
 * Unit tests for the reusable gym tooltip helper (AH-0MV4XGXVL001GSB2).
 *
 * The helper is plain DOM (no Phaser), so it is exercised directly in
 * happy-dom. These tests pin the designer-facing contract: a control is
 * programmatically associated with its description, the tooltip is revealed
 * on both pointer hover and keyboard focus, and it is never clipped by the
 * panel's `overflow-y: auto` scroll container.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GYM_TOOLTIP_CLASS,
  GYM_TOOLTIP_ID_ATTR,
  GYM_TOOLTIP_VISIBLE_CLASS,
  attachTooltip,
  resetGymTooltipIds,
} from './gymTooltip';

/** Creates a slider-like control attached to `parent` (default `<body>`). */
function makeControl(parent: HTMLElement = document.body): HTMLInputElement {
  const control = document.createElement('input');
  control.type = 'range';
  parent.appendChild(control);
  return control;
}

describe('attachTooltip (AH-0MV4XGXVL001GSB2)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetGymTooltipIds();
  });

  it('associates the control with its tooltip via aria-describedby', () => {
    const control = makeControl();
    const tooltip = attachTooltip(control, 'Radius within which a mineral is pursued.');

    expect(control.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(control.getAttribute(GYM_TOOLTIP_ID_ATTR)).toBe(tooltip.id);
    expect(tooltip.id).not.toBe('');
    expect(tooltip.getAttribute('role')).toBe('tooltip');
    expect(tooltip.textContent).toBe(
      'Radius within which a mineral is pursued.',
    );
  });

  it('is hidden by default, revealed on pointer hover, hidden on leave', () => {
    const control = makeControl();
    const tooltip = attachTooltip(control, 'Progress weight.');

    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);

    control.dispatchEvent(new Event('pointerenter'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(true);

    control.dispatchEvent(new Event('pointerleave'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);
  });

  it('is revealed on keyboard focus (not hover-only) and hidden on blur', () => {
    const control = makeControl();
    const tooltip = attachTooltip(control, 'Reaction time.');

    control.dispatchEvent(new Event('focus'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(true);

    control.dispatchEvent(new Event('blur'));
    expect(tooltip.classList.contains(GYM_TOOLTIP_VISIBLE_CLASS)).toBe(false);
  });

  it('creates the tooltip once and reuses it on repeated attach', () => {
    const control = makeControl();
    const first = attachTooltip(control, 'First description.');
    const second = attachTooltip(control, 'Updated description.');

    expect(second).toBe(first);
    expect(second.textContent).toBe('Updated description.');
    expect(document.querySelectorAll(`.${GYM_TOOLTIP_CLASS}`)).toHaveLength(1);
  });

  it('appends every tooltip to <body>, outside the scrolling panel, with fixed positioning', () => {
    // A panel that would clip an absolutely-positioned child.
    const panel = document.createElement('div');
    panel.className = 'gym-panel';
    panel.style.overflowY = 'auto';
    document.body.appendChild(panel);
    const control = makeControl(panel);

    const tooltip = attachTooltip(control, 'Seek range.');

    // The tooltip lives outside the scroll container, so `overflow-y: auto`
    // on the panel cannot clip it, and it is pinned to the viewport.
    expect(tooltip.parentElement).toBe(document.body);
    expect(panel.contains(tooltip)).toBe(false);
    expect(tooltip.style.position).toBe('fixed');
  });

  it('positions the tooltip beside the control on reveal', () => {
    const control = makeControl();
    const tooltip = attachTooltip(control, 'Clearance weight.');
    vi.spyOn(control, 'getBoundingClientRect').mockReturnValue({
      top: 100,
      bottom: 120,
      left: 40,
      right: 140,
      width: 100,
      height: 20,
      x: 40,
      y: 100,
      toJSON: () => ({}),
    });

    control.dispatchEvent(new Event('focus'));

    // Fixed, viewport-relative coordinates are written on reveal.
    expect(tooltip.style.position).toBe('fixed');
    expect(tooltip.style.top).not.toBe('');
    expect(tooltip.style.left).toBe('40px');
  });

  it('keeps one tooltip per control and their ids distinct', () => {
    const first = makeControl();
    const second = makeControl();

    const firstTooltip = attachTooltip(first, 'First.');
    const secondTooltip = attachTooltip(second, 'Second.');

    expect(firstTooltip).not.toBe(secondTooltip);
    expect(firstTooltip.id).not.toBe(secondTooltip.id);
    expect(first.getAttribute('aria-describedby')).toBe(firstTooltip.id);
    expect(second.getAttribute('aria-describedby')).toBe(secondTooltip.id);
  });
});
