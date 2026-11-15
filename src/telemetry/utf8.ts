/**
 * UTF-8 byte lengths for telemetry metering (AH-0MW2DC20A007TAVY).
 *
 * The dev recorder meters everything it writes in UTF-8 bytes: each record
 * line's contribution to the sink's retention cap, and each upload body's
 * size against the CDP-message cap. That makes this a per-record hot path, so
 * it is a single implementation shared by `sinks.ts` and `devUpload.ts`
 * rather than a private copy in each.
 *
 * Telemetry lines are overwhelmingly ASCII (positional/numeric gameplay
 * state), where the byte length is simply the string length. The fast path
 * therefore returns for ASCII **without encoding at all** — the previous
 * implementation allocated a fresh `TextEncoder` *and* a `Uint8Array` per call,
 * once per record line and once per part.
 *
 * @module src/telemetry/utf8
 */

/** The minimal encoder surface this module needs (injected in tests). */
export interface Utf8Encoder {
  /** Encodes text to UTF-8 bytes. */
  encode(text: string): Uint8Array;
}

/** Module-scoped encoder: allocated once, reused for every non-ASCII string. */
const sharedEncoder: Utf8Encoder | null =
  typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** Measures a non-ASCII string; the encoder is allocated once, not per call. */
const encodeWithShared: ((value: string) => Uint8Array) | null = sharedEncoder
  ? (value) => sharedEncoder.encode(value)
  : null;

/**
 * Size of a string in UTF-8 bytes — the unit the telemetry caps are expressed
 * in.
 *
 * ASCII text answers from the code-unit count (identical to its byte count)
 * without allocating; anything else is measured by the shared encoder. Text
 * outside the BMP (a surrogate pair) needs no special handling: the encoder's
 * byte count is authoritative, and the ASCII fast path only ever fires when
 * every code unit is below `0x80`.
 *
 * @param text - The string to measure.
 * @param encode - Encoder override for the non-ASCII path (tests).
 */
export function utf8ByteLength(
  text: string,
  encode?: (value: string) => Uint8Array,
): number {
  if (isAscii(text)) return text.length;
  const measure = encode ?? encodeWithShared;
  // No `TextEncoder` in this environment: the code-unit count is the only
  // answer available, and every metre here is a budget (never a guarantee).
  return measure ? measure(text).length : text.length;
}

/** True when every code unit is in the ASCII range (byte length == length). */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}
