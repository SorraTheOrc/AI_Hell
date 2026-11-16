/**
 * UTF-8 byte lengths for telemetry metering (AH-0MW2DC20A007TAVY).
 *
 * The dev recorder meters everything it writes in UTF-8 bytes: each record
 * line's contribution to the sink's retention cap, and each upload body's
 * size against the CDP-message cap. That makes this a per-record hot path, so
 * it is a single implementation shared by `sinks.ts`, `devUpload.ts` and
 * `devStreamProtocol.ts` rather than a private copy in each.
 *
 * The encoder is allocated **once** per module rather than once per call: the
 * previous copies constructed a fresh `TextEncoder` (and a fresh `Uint8Array`)
 * for every record line. A hand-written ASCII scan was measured to be ~8×
 * slower than the native encoder on real record lines (58 ms vs 7.6 ms of a
 * 60 s demo window), so the native encoder is used unconditionally.
 *
 * @module src/telemetry/utf8
 */

/** The minimal encoder surface this module needs (injected in tests). */
export interface Utf8Encoder {
  /** Encodes text to UTF-8 bytes. */
  encode(text: string): Uint8Array;
}

/** Module-scoped encoder: allocated once, reused for every call. */
const sharedEncoder: Utf8Encoder | null =
  typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** Measures a string with the shared encoder (bound once, not per call). */
const encodeWithShared: ((value: string) => Uint8Array) | null = sharedEncoder
  ? (value) => sharedEncoder.encode(value)
  : null;

/**
 * Size of a string in UTF-8 bytes — the unit the telemetry caps are expressed
 * in.
 *
 * @param text - The string to measure.
 * @param encode - Encoder override for tests; defaults to the shared encoder.
 */
export function utf8ByteLength(
  text: string,
  encode?: (value: string) => Uint8Array,
): number {
  const measure = encode ?? encodeWithShared;
  // No `TextEncoder` in this environment: the code-unit count is the only
  // answer available, and every metre here is a budget (never a guarantee).
  return measure ? measure(text).length : text.length;
}
