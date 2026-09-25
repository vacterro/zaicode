/**
 * Layout-independent key test for ZAICODE hotkeys: Ctrl+Q must be Ctrl+Q on
 * a Russian, Estonian or any other layout. `event.key` follows the layout
 * ("й" on the Q key under ЙЦУКЕН), `event.code` names the physical key
 * ("KeyQ" everywhere).
 *
 * Letters: when the layout prints a Latin letter, that letter decides, so
 * AZERTY Ctrl+A (physical KeyQ) stays select-all and QWERTZ Ctrl+Y (physical
 * KeyZ) is not Ctrl+Z. Only a non-Latin layout falls back to the physical key.
 * Digits match the physical digit keys (AZERTY prints "&" on Digit1).
 */
export function zaicodeKeyIs(event: Pick<KeyboardEvent, "key" | "code">, key: string): boolean {
  const wanted = key.toLowerCase();
  const printed = event.key.toLowerCase();
  if (wanted.length === 1 && wanted >= "a" && wanted <= "z") {
    if (printed.length === 1 && printed >= "a" && printed <= "z") return printed === wanted;
    return event.code === `Key${wanted.toUpperCase()}`;
  }
  if (wanted.length === 1 && wanted >= "0" && wanted <= "9") {
    if (event.code === `Digit${wanted}` || event.code === `Numpad${wanted}`) return true;
  }
  return printed === wanted;
}

/** Digit 0-9 from the top row or the numpad, whatever the layout prints; null otherwise. */
export function zaicodeDigitOf(event: Pick<KeyboardEvent, "key" | "code">): number | null {
  const match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code ?? "");
  if (match) return Number(match[1]);
  return /^[0-9]$/.test(event.key) ? Number(event.key) : null;
}
