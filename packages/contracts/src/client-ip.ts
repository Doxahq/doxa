/**
 * The rate-limit key of a client IP (SEC-007, SEC-008). An IPv4 address is
 * its own key. An IPv6 client usually holds a whole /64, so a key per address
 * would let one client rotate through 2^64 keys: the key is the /64 prefix.
 * A value that is not an IP address is its own key.
 */
export function clientIpRateLimitKey(ip: string): string {
  const value = ip.trim().toLowerCase();
  if (!value.includes(":")) return value;
  const groups = expandIpv6(value);
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : value;
}

/** The 8 groups of an IPv6 address, or null when it is not one. */
function expandIpv6(value: string): string[] | null {
  const address = value.split("%")[0] ?? "";
  // An embedded IPv4 tail counts as two groups.
  const ipv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  let text = address;
  if (ipv4) {
    const parts = ipv4[1]!.split(".").map(Number);
    if (parts.some((part) => part > 255)) return null;
    const high = ((parts[0]! << 8) | parts[1]!).toString(16);
    const low = ((parts[2]! << 8) | parts[3]!).toString(16);
    text = `${address.slice(0, -ipv4[1]!.length)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => group.replace(/^0+(?=.)/, ""));
}
