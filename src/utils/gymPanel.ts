/**
 * Shared collapse/expand affordance for the plain-DOM gym panels
 * (AH-0MUDYFMUX007Q0W3).
 *
 * Every gym scene (`GymPlayer`, `GymEnemies`, `GymBoss`) builds a
 * bottom-left tuning panel that shares the `.gym-panel` class
 * (AH-0MUAYB7O4009LWBF). A tall panel such as the ~21-row enemy editor
 * permanently occupies a large part of the screen, so this helper wraps a
 * panel's existing children in a `.gym-panel-body` and prepends a
 * `.gym-panel-header` with a native `<button class="gym-panel-toggle">`.
 * Activating the toggle flips the panel's `data-collapsed` attribute; CSS
 * hides the body while leaving the header visible.
 *
 * The helper is deliberately framework-free: it works in the existing
 * happy-dom test environment and adds no runtime dependencies.
 *
 * @module utils/gymPanel
 */

/** Class of the panel header element. */
export const GYM_PANEL_HEADER_CLASS = 'gym-panel-header';

/** Class of the element wrapping the panel's controls. */
export const GYM_PANEL_BODY_CLASS = 'gym-panel-body';

/** Class of the native collapse/expand toggle button. */
export const GYM_PANEL_TOGGLE_CLASS = 'gym-panel-toggle';

/** Class of the toggle's text label. */
export const GYM_PANEL_TOGGLE_LABEL_CLASS = 'gym-panel-toggle-label';

/** Class of the toggle's state icon (decorative, hidden from AT). */
export const GYM_PANEL_TOGGLE_ICON_CLASS = 'gym-panel-toggle-icon';

/** Panel attribute encoding the collapsed state (`"true"`/`"false"`). */
export const GYM_PANEL_COLLAPSED_ATTR = 'data-collapsed';

/** A panel converted into a collapsible panel. */
export interface CollapsiblePanel {
  /** The header element prepended to the panel. */
  header: HTMLDivElement;
  /** The body element holding the original panel children. */
  body: HTMLDivElement;
  /** The native toggle button. */
  toggle: HTMLButtonElement;
  /** Whether the panel is currently collapsed. */
  isCollapsed(): boolean;
  /** Programmatically sets the collapsed state. */
  setCollapsed(collapsed: boolean): void;
}

/** Options accepted by {@link makeCollapsible}. */
export interface MakeCollapsibleOptions {
  /** The panel whose children are wrapped and which gains the header. */
  panel: HTMLElement;
  /** Short label shown on the toggle (e.g. "AI Config"). */
  title: string;
}

let bodyIdSeq = 0;

/** Deterministic body id when the panel has no id of its own. */
function nextBodyId(): string {
  bodyIdSeq += 1;
  return `gym-panel-body-${bodyIdSeq}`;
}

/**
 * Wraps a panel's existing children in a `.gym-panel-body` and prepends a
 * `.gym-panel-header` containing a native toggle button. The panel starts
 * expanded (`data-collapsed="false"`) and toggles on click — including the
 * keyboard activation native buttons provide for free.
 *
 * @param options - The panel to make collapsible and its toggle title.
 * @returns Handles to the created elements plus state accessors.
 */
export function makeCollapsible({
  panel,
  title,
}: MakeCollapsibleOptions): CollapsiblePanel {
  const body = document.createElement('div');
  body.className = GYM_PANEL_BODY_CLASS;
  body.id = panel.id ? `${panel.id}-body` : nextBodyId();

  // Move every existing child into the body, preserving order.
  while (panel.firstChild) {
    body.appendChild(panel.firstChild);
  }

  const header = document.createElement('div');
  header.className = GYM_PANEL_HEADER_CLASS;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = GYM_PANEL_TOGGLE_CLASS;
  toggle.setAttribute('aria-controls', body.id);

  const label = document.createElement('span');
  label.className = GYM_PANEL_TOGGLE_LABEL_CLASS;
  label.textContent = title;

  const icon = document.createElement('span');
  icon.className = GYM_PANEL_TOGGLE_ICON_CLASS;
  icon.setAttribute('aria-hidden', 'true');

  toggle.append(label, icon);
  header.appendChild(toggle);
  panel.append(header, body);

  const isCollapsed = (): boolean =>
    panel.getAttribute(GYM_PANEL_COLLAPSED_ATTR) === 'true';

  const setCollapsed = (collapsed: boolean): void => {
    panel.setAttribute(GYM_PANEL_COLLAPSED_ATTR, collapsed ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    icon.textContent = collapsed ? '▸' : '▾';
  };

  toggle.addEventListener('click', () => setCollapsed(!isCollapsed()));
  setCollapsed(false);

  return { header, body, toggle, isCollapsed, setCollapsed };
}
