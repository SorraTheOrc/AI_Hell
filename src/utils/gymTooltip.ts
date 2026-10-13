/**
 * Reusable plain-DOM tooltip helper for the gym panels
 * (AH-0MV4XGXVL001GSB2).
 *
 * The bot-tuning gym exposes ~50 live controls labelled with raw internal
 * names. This helper attaches a short, designer-facing description to any
 * element and reveals it on pointer hover *and* keyboard focus, so the help
 * is reachable without a mouse. It is deliberately framework-free: it works
 * in the existing happy-dom test environment and adds no runtime dependency
 * (the same constraints as `gymPanel.ts` / `gymHelp.ts`).
 *
 * ## Why the tooltip lives on `<body>`
 *
 * Gym panels are `position: fixed` with `overflow-y: auto`. A tooltip nested
 * inside the panel would be clipped by that scroll container whenever it
 * overflows the panel's edge. Each tooltip is therefore appended to
 * `document.body` — outside the scroll container — and positioned with
 * `position: fixed` relative to its control on reveal, so it is never
 * clipped and stays fully visible near a viewport edge.
 *
 * ## Association
 *
 * `attachTooltip(el, text)` sets `aria-describedby` on the control to the
 * tooltip's id, so screen readers and other assistive technology announce
 * the description as well as sighted hover/focus users seeing it. The
 * tooltip element is created once per control and reused for every
 * show/hide, never rebuilt on hover.
 *
 * @module utils/gymTooltip
 */

/** Base class of every tooltip element. */
export const GYM_TOOLTIP_CLASS = 'gym-tooltip';

/** Class added to the tooltip while it is visible. */
export const GYM_TOOLTIP_VISIBLE_CLASS = 'gym-tooltip-visible';

/** Data attribute on a control holding its tooltip's element id. */
export const GYM_TOOLTIP_ID_ATTR = 'data-gym-tooltip-id';

/** Id prefix for generated tooltips. */
export const GYM_TOOLTIP_ID_PREFIX = 'gym-tooltip-';

/** Gap (px) between the control and its tooltip. */
const TOOLTIP_GAP_PX = 6;

let tooltipIdSeq = 0;

/**
 * Tooltips keyed by the control they describe, so an element attached twice
 * reuses (and updates) its existing tooltip rather than creating a second.
 */
const tooltipByControl = new WeakMap<HTMLElement, HTMLElement>();

/** Resets the tooltip id counter (intended for deterministic tests). */
export function resetGymTooltipIds(): void {
  tooltipIdSeq = 0;
}

/** Positions a tooltip with fixed coordinates beside its control. */
function positionTooltip(control: HTMLElement, tooltip: HTMLElement): void {
  const rect = control.getBoundingClientRect();
  const width = tooltip.offsetWidth || 0;
  const height = tooltip.offsetHeight || 0;

  // Prefer above the control; drop below it when there is no room.
  let top = rect.top - height - TOOLTIP_GAP_PX;
  if (top < 0) top = rect.bottom + TOOLTIP_GAP_PX;

  // Keep the tooltip inside the viewport on the horizontal axis.
  let left = rect.left;
  const viewportWidth =
    typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 0;
  if (viewportWidth > 0 && width > 0 && left + width > viewportWidth) {
    left = Math.max(0, viewportWidth - width);
  }

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

/** Shows a control's tooltip, positioned beside the control. */
function showTooltip(control: HTMLElement, tooltip: HTMLElement): void {
  positionTooltip(control, tooltip);
  tooltip.classList.add(GYM_TOOLTIP_VISIBLE_CLASS);
}

/** Hides a control's tooltip. */
function hideTooltip(tooltip: HTMLElement): void {
  tooltip.classList.remove(GYM_TOOLTIP_VISIBLE_CLASS);
}

/**
 * Attaches a tooltip to `control` showing `text`. The tooltip is created once
 * and reused on every subsequent call, and revealed on pointer hover and
 * keyboard focus. The control's `aria-describedby` is pointed at the tooltip
 * so the description is programmatically associated with it.
 *
 * @param control - The control the tooltip describes (slider, checkbox, …).
 * @param text - The plain-English description to show.
 * @returns The tooltip element (for tests and advanced callers).
 */
export function attachTooltip(control: HTMLElement, text: string): HTMLElement {
  const existing = tooltipByControl.get(control);
  if (existing) {
    existing.textContent = text;
    return existing;
  }

  tooltipIdSeq += 1;
  const tooltip = document.createElement('div');
  tooltip.id = `${GYM_TOOLTIP_ID_PREFIX}${tooltipIdSeq}`;
  tooltip.className = GYM_TOOLTIP_CLASS;
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = text;
  // Appended to `<body>` — outside the panel's scroll container — and pinned
  // with `position: fixed` so the panel's `overflow-y: auto` cannot clip it.
  tooltip.style.position = 'fixed';
  document.body.appendChild(tooltip);

  control.setAttribute('aria-describedby', tooltip.id);
  control.setAttribute(GYM_TOOLTIP_ID_ATTR, tooltip.id);

  control.addEventListener('pointerenter', () =>
    showTooltip(control, tooltip),
  );
  control.addEventListener('focus', () => showTooltip(control, tooltip));
  control.addEventListener('pointerleave', () => hideTooltip(tooltip));
  control.addEventListener('blur', () => hideTooltip(tooltip));

  tooltipByControl.set(control, tooltip);
  return tooltip;
}
