/**
 * DOM-key-name → Phaser key-code resolution (parent AH-0MU9LPZ0G0015292).
 *
 * Bindings are stored as DOM `KeyboardEvent.key` values (e.g. `'w'`,
 * `'Escape'`, `'ArrowUp'`). PlayScene and the menus need Phaser key codes
 * to create `Key` objects. `toKeyCode` maps the common named keys and falls
 * back to the ASCII code for single characters (letters, digits,
 * punctuation); unrecognised names return `null` so callers can fall back
 * to the action's default (AC3).
 */

/** Named DOM keys → Phaser `KeyCodes` values. */
const NAMED_KEY_CODES: Record<string, number> = {
  Escape: 27, // Phaser KeyCodes.ESC
  Enter: 13,
  ' ': 32,
  Tab: 9,
  Backspace: 8,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Insert: 45,
  Delete: 46,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  // Punctuation uses browser keyCodes (which differ from ASCII); these
  // match Phaser's KeyCodes values exactly.
  ';': 186,
  '=': 187,
  ',': 188,
  '-': 189,
  '.': 190,
  '/': 191,
  '`': 192,
  '[': 219,
  '\\': 220,
  ']': 221,
  "'": 222,
};

/**
 * Resolves a DOM key name to a Phaser key code. Letters and digits use
 * their uppercase ASCII code (which matches Phaser's `KeyCodes`); named
 * keys and punctuation use the explicit map above. Returns `null` for
 * unknown multi-character names.
 */
export function toKeyCode(key: string): number | null {
  if (Object.prototype.hasOwnProperty.call(NAMED_KEY_CODES, key)) {
    return NAMED_KEY_CODES[key];
  }
  if (key.length === 1) {
    const code = key.toUpperCase().charCodeAt(0);
    return Number.isFinite(code) && code > 0 ? code : null;
  }
  return null;
}

/**
 * Resolves `key` to a key code, falling back to `fallback` (the action's
 * default key name) when `key` is missing or not a supported name.
 */
export function resolveKeyCode(key: string, fallback: string): number {
  const resolved = toKeyCode(key);
  if (resolved !== null) return resolved;
  return toKeyCode(fallback) ?? 0;
}
