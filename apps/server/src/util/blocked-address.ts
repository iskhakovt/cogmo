import type { LookupAddress } from "node:dns";

/**
 * Every address a hostname resolves to, as `dns.promises.lookup(hostname,
 * { all: true })` answers.
 */
export type ResolveHost = (hostname: string) => Promise<ReadonlyArray<LookupAddress>>;

/**
 * Whether an address is off the public internet: this-host, loopback,
 * private, link-local, CGNAT, multicast or reserved, or an IPv4 address in
 * one of those ranges carried inside an IPv6 one.
 *
 * `family` is the resolver's (4 or 6). An address that does not parse as its
 * family is blocked: a shape this does not understand is not one it can
 * vouch for.
 */
export function isBlockedAddress(address: string, family: number): boolean {
  if (family === 6) {
    const bytes = parseIpv6(address);
    return bytes === null || isBlockedV6(bytes);
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  return isBlockedV4(parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0);
}

/** The first three octets: every range below is a /24 or wider. */
function isBlockedV4(a: number, b: number, c: number): boolean {
  if (a === 0 || a === 127) return true; // this-host, loopback
  if (a === 10) return true; // private
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 documentation
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 relay anycast
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 documentation
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 documentation
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isBlockedV6(bytes: Uint8Array): boolean {
  const zeroThrough = (end: number) => bytes.subarray(0, end).every((b) => b === 0);
  const embeddedV4At = (i: number) =>
    isBlockedV4(bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0);

  // ::/96, IPv4-compatible. `::` and `::1` land here as 0.0.0.0 and 0.0.0.1,
  // which the v4 arm refuses as this-host.
  if (zeroThrough(12)) return embeddedV4At(12);
  // ::ffff:0:0/96, v4-mapped: ::ffff:7f00:1 and ::ffff:127.0.0.1 are one address.
  if (zeroThrough(10) && bytes[10] === 0xff && bytes[11] === 0xff) return embeddedV4At(12);
  // ::ffff:0:0:0/96, IPv4-translated (SIIT).
  if (
    zeroThrough(8) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0
  ) {
    return embeddedV4At(12);
  }
  // 64:ff9b::/96, NAT64: a DNS64 resolver synthesises one from a private A
  // record, and the gateway translates it straight back to 10.x.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.subarray(4, 12).every((b) => b === 0)
  ) {
    return embeddedV4At(12);
  }
  // 2002::/16, 6to4: the v4 address is the next four bytes.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embeddedV4At(2);
  // 2001::/32, Teredo. Refused whole rather than judged by what it embeds:
  // it carries two v4 addresses, the server's in bytes 4–7 and the client's
  // bit-inverted in bytes 12–15 (RFC 4380 §4), and no HTTP origin is served
  // from one.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  if (first === 0xff) return true; // ff00::/8 multicast
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if (first === 0xfe && (second & 0xc0) === 0xc0) return true; // fec0::/10 site-local, deprecated
  return false;
}

function parseIpv6(input: string): Uint8Array | null {
  let addr = input.split("%")[0] ?? ""; // drop any zone id
  // A trailing dotted quad (::ffff:127.0.0.1) is two hex groups wearing
  // another notation; fold it in so the rest of the parse is uniform.
  const embedded = addr.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embedded) {
    const octets = (embedded[2] ?? "").split(".").map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
    const hi = (((octets[0] ?? 0) << 8) | (octets[1] ?? 0)).toString(16);
    const lo = (((octets[2] ?? 0) << 8) | (octets[3] ?? 0)).toString(16);
    addr = `${embedded[1]}${hi}:${lo}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":").filter((g) => g !== "") : [];
  const right =
    halves.length === 2 && halves[1] ? halves[1].split(":").filter((g) => g !== "") : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0) return null;
  const groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] ?? "";
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}
