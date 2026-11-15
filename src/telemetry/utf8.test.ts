/**
 * Unit tests for the shared UTF-8 byte-length helper
 * (AH-0MW2DC20A007TAVY).
 *
 * The dev telemetry recorder meters every record line and every upload body in
 * UTF-8 bytes, so this helper sits on the per-record hot path. The tests pin
 * the two things the meter depends on:
 *
 * - **Byte-exactness.** The number must match `TextEncoder` for ASCII,
 *   multi-byte and astral-plane text — the caps it feeds are byte budgets, and
 *   an under-count would let an over-cap payload through.
 * - **One shared encoder.** The encoder is allocated once at module load, not
 *   per call: the metered hot path must not construct a `TextEncoder` per
 *   record line. The injected encoder seam is what makes that observable.
 */

import { describe, expect, it, vi } from 'vitest';

import { utf8ByteLength, type Utf8Encoder } from './utf8';

const realEncoder: Utf8Encoder = new TextEncoder();

/** Samples spanning the size/encoding cases the meter sees. */
const SAMPLES: readonly string[] = [
  '',
  'ascii only',
  '{"kind":"tick","tick":1,"state":{"x":1.5,"y":-2}}',
  'é', // 2 bytes (U+00E9)
  'café crème',
  '日本語', // 3 bytes per character
  '🎮🛸', // astral plane: surrogate pairs, 4 bytes each
  'mixed: ascii é 日本 🎮',
];

describe('utf8ByteLength', () => {
  it('matches TextEncoder for every encoding width', () => {
    for (const sample of SAMPLES) {
      expect(utf8ByteLength(sample)).toBe(realEncoder.encode(sample).length);
    }
  });

  it('counts ASCII records by their byte length', () => {
    expect(utf8ByteLength('{"kind":"tick","tick":7}')).toBe(24);
  });

  it('measurements a large NDJSON-sized record exactly', () => {
    const line = `{"kind":"tick","state":{"enemies":[${'{"x":1,"y":2},'.repeat(2_000)}]}}`;

    expect(utf8ByteLength(line)).toBe(realEncoder.encode(line).length);
  });

  it('uses the injected encoder when one is supplied', () => {
    const encode = vi.fn((text: string) => realEncoder.encode(text));

    expect(utf8ByteLength('café', encode)).toBe(5);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(utf8ByteLength('plain', encode)).toBe(5);
    expect(encode).toHaveBeenCalledTimes(2);
  });
});
