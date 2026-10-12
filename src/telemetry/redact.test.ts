/**
 * Tests for PII/secret redaction and JSON safety
 * (AH-0MUY08VJ9006BHJO, AC5).
 *
 * These assert the observable output of `sanitiseTelemetryValue`: sensitive
 * keys/values never survive, and the result is always plain JSON.
 */

import { describe, expect, it } from 'vitest';

import {
  TELEMETRY_REDACTED,
  TELEMETRY_REDACTED_EMAIL,
  isSensitiveTelemetryKey,
  sanitiseTelemetryValue,
} from './redact';

describe('telemetry redaction', () => {
  it('flags PII and secret key names, but not innocuous fields', () => {
    expect(isSensitiveTelemetryKey('email')).toBe(true);
    expect(isSensitiveTelemetryKey('authToken')).toBe(true);
    expect(isSensitiveTelemetryKey('apiKey')).toBe(true);
    expect(isSensitiveTelemetryKey('playerName')).toBe(false);
    expect(isSensitiveTelemetryKey('passed')).toBe(false);
    expect(isSensitiveTelemetryKey('hotkey')).toBe(false);
    expect(isSensitiveTelemetryKey('archetype')).toBe(false);
  });

  it('redacts sensitive keys at every nesting level without mutating the input', () => {
    const input = {
      runSeed: 42,
      email: 'player@example.com',
      nested: { password: 'hunter2', score: 10 },
      list: [{ token: 'abc' }, 3],
    };

    const result = sanitiseTelemetryValue(input);

    expect(result).toEqual({
      runSeed: 42,
      email: TELEMETRY_REDACTED,
      nested: { password: TELEMETRY_REDACTED, score: 10 },
      list: [{ token: TELEMETRY_REDACTED }, 3],
    });
    // The caller's object is untouched.
    expect(input.email).toBe('player@example.com');
  });

  it('masks email-like substrings inside ordinary string values', () => {
    const result = sanitiseTelemetryValue({ note: 'contact me at a@b.com please' });
    expect(result).toEqual({ note: `contact me at ${TELEMETRY_REDACTED_EMAIL} please` });
  });

  it('coerces values that JSON cannot represent into safe placeholders', () => {
    const result = sanitiseTelemetryValue({
      infinite: Number.POSITIVE_INFINITY,
      notANumber: Number.NaN,
      missing: undefined,
      fn: () => 1,
      big: 10n,
      when: new Date('2026-10-08T00:00:00.000Z'),
      klass: new (class Widget {})(),
    });

    expect(result).toEqual({
      infinite: null,
      notANumber: null,
      missing: null,
      fn: null,
      big: '10',
      when: '2026-10-08T00:00:00.000Z',
      klass: null,
    });
  });

  it('breaks cycles instead of throwing', () => {
    const cyclic: Record<string, unknown> = { id: 1 };
    cyclic.self = cyclic;

    expect(sanitiseTelemetryValue(cyclic)).toEqual({ id: 1, self: '[circular]' });
  });
});
