/**
 * Tests for PII/secret redaction and JSON safety
 * (AH-0MUY08VJ9006BHJO, AC5).
 *
 * These assert the observable output of `sanitiseTelemetryValue`: sensitive
 * keys/values never survive, and the result is always plain JSON.
 */

import { describe, expect, it } from 'vitest';

import {
  REDACTION_CACHE_LIMIT,
  TELEMETRY_REDACTED,
  TELEMETRY_REDACTED_EMAIL,
  clearRedactionCaches,
  isSensitiveTelemetryKey,
  redactionCacheSizes,
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

/**
 * Memoised redaction (AH-0MW2DC20A007TAVY).
 *
 * A recorded tick repeats the same handful of keys (`x`, `y`, `vx`, `vy`,
 * `alive`, `archetype`, …) hundreds of times, so the key verdict and the
 * email scan are the dev recorder's per-record hot path. They are memoised;
 * these tests pin that the memo is an **implementation detail of the same
 * function**: every decision and every output is byte-identical to the
 * uncached reference, and the caches stay bounded so a pathological payload
 * cannot grow them without limit.
 */
describe('telemetry redaction — memoised verdicts (AH-0MW2DC20A007TAVY)', () => {
  /** Reference implementations: the pre-memo behaviour, written out longhand. */
  const SENSITIVE_KEY =
    /(password|passwd|passphrase|passcode|secret|token|api[_-]?key|apikey|authorization|cookie|credential|csrf|email|e[_-]?mail|phone|mobile|address|postcode|zip[_-]?code|ssn|social[_-]?security|passport|credit[_-]?card|card[_-]?number|cvv|username|user[_-]?id|display[_-]?name|real[_-]?name|full[_-]?name|first[_-]?name|last[_-]?name)/i;
  const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

  it('returns the same verdict on every repeat call for the same key', () => {
    const keys = ['x', 'email', 'archetype', 'authToken', 'passed', 'playerName', 'apiKey'];

    for (const key of keys) {
      const expected = SENSITIVE_KEY.test(key);
      // Three calls: cold (regex), then two memo hits.
      for (let repeat = 0; repeat < 3; repeat += 1) {
        expect(isSensitiveTelemetryKey(key)).toBe(expected);
      }
    }
  });

  it('redacts repeated string values exactly as the uncached scan does', () => {
    const strings = [
      'contact me at a@b.com please',
      'plain value',
      'not@valid',
      '@leading.space',
      'two@one.com and three@two.org',
    ];

    for (const value of strings) {
      const expected = value.replace(EMAIL, TELEMETRY_REDACTED_EMAIL);
      // Twice: cold scan, then memo hit — both must produce the same output.
      for (let repeat = 0; repeat < 2; repeat += 1) {
        expect(sanitiseTelemetryValue({ note: value })).toEqual({ note: expected });
      }
    }
  });

  it('still redacts a key the memo has already seen', () => {
    // Warm the cache with the harmless verdict, then prove the sensitive one
    // is not merely remembered as harmless.
    expect(isSensitiveTelemetryKey('displayName')).toBe(true);
    expect(isSensitiveTelemetryKey('displayName')).toBe(true);
    expect(sanitiseTelemetryValue({ displayName: 'Ada' })).toEqual({
      displayName: TELEMETRY_REDACTED,
    });
  });

  it('keeps both caches bounded, dropping entries rather than growing', () => {
    clearRedactionCaches();

    // Overwhelm both caches: many distinct keys and many distinct strings.
    for (let index = 0; index < REDACTION_CACHE_LIMIT * 2; index += 1) {
      isSensitiveTelemetryKey(`field_${index}`);
      sanitiseTelemetryValue({ value: `text ${index} with user${index}@example.com` });
    }

    const sizes = redactionCacheSizes();
    expect(sizes.keys).toBeLessThanOrEqual(REDACTION_CACHE_LIMIT);
    expect(sizes.values).toBeLessThanOrEqual(REDACTION_CACHE_LIMIT);
    // Bounded, but still working: the verdicts are correct after the flush.
    expect(isSensitiveTelemetryKey('email')).toBe(true);
    expect(isSensitiveTelemetryKey('archetype')).toBe(false);
  });
});
