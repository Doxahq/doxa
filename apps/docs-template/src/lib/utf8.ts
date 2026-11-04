/** The UTF-8 size of a string, without copying it. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isSurrogatePair(code, value.charCodeAt(index + 1))) {
      // A surrogate pair is one 4-byte character.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

function isSurrogatePair(high: number, low: number): boolean {
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}
