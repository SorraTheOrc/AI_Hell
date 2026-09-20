/**
 * Unit tests for the DOM-key-name → Phaser key-code resolver
 * (AH-0MUA8BK1E001UZUC — apply rebindable keys).
 */

import { describe, expect, it } from 'vitest';
import Phaser from 'phaser';

import { resolveKeyCode, toKeyCode } from './keys';

const KC = Phaser.Input.Keyboard.KeyCodes;

describe('toKeyCode (AH-0MUA8BK1E001UZUC)', () => {
  it('maps single letters to their uppercase ASCII key codes', () => {
    expect(toKeyCode('w')).toBe(KC.W);
    expect(toKeyCode('i')).toBe(KC.I);
    expect(toKeyCode('S')).toBe(KC.S);
  });

  it('maps digits and punctuation via their ASCII codes', () => {
    expect(toKeyCode('1')).toBe(KC.ONE);
    expect(toKeyCode(';')).toBe(KC.SEMICOLON);
  });

  it('maps named keys (Escape, arrows, Enter, Space)', () => {
    expect(toKeyCode('Escape')).toBe(KC.ESC);
    expect(toKeyCode('ArrowUp')).toBe(KC.UP);
    expect(toKeyCode('ArrowDown')).toBe(KC.DOWN);
    expect(toKeyCode('Enter')).toBe(KC.ENTER);
    expect(toKeyCode(' ')).toBe(KC.SPACE);
  });

  it('returns null for unknown multi-character names', () => {
    expect(toKeyCode('NotAKey')).toBeNull();
    expect(toKeyCode('')).toBeNull();
  });
});

describe('resolveKeyCode fallback (AC3)', () => {
  it('returns the key code for a supported binding', () => {
    expect(resolveKeyCode('i', 'w')).toBe(KC.I);
  });

  it('falls back to the default when the binding is blank', () => {
    expect(resolveKeyCode('', 'w')).toBe(KC.W);
  });

  it('falls back to the default when the binding is unknown', () => {
    expect(resolveKeyCode('NotAKey', 'Escape')).toBe(KC.ESC);
  });
});