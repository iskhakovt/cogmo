import { describe, expect, it } from "vitest";
import { isBlockedAddress } from "./blocked-address.js";

const BLOCKED_V4 = [
  "0.0.0.0",
  "0.0.0.2",
  "0.0.1.2",
  "0.1.2.3",
  "127.0.0.1",
  "127.255.255.254",
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.1",
  "169.254.169.254",
  "100.64.0.1",
  "100.127.255.255",
  "192.0.0.8",
  "192.0.2.1",
  "198.18.0.1",
  "198.19.255.255",
  "198.51.100.1",
  "192.88.99.1",
  "203.0.113.1",
  "224.0.0.1",
  "239.255.255.250",
  "240.0.0.1",
  "255.255.255.255",
];

const PUBLIC_V4 = [
  "1.1.1.1",
  "8.8.8.8",
  "11.0.0.1",
  "93.184.215.14",
  "100.63.255.255",
  "100.128.0.1",
  "172.15.255.255",
  "172.32.0.1",
  "198.17.0.1",
  "198.20.0.1",
  "223.255.255.255",
  // Beside the reserved /24s, which sit in otherwise public /16s:
  // wordpress.com and iana.org answer from these.
  "192.0.43.8",
  "192.0.78.9",
  "192.88.1.1",
  "198.51.99.1",
  "198.51.101.1",
  "203.0.112.1",
  "203.0.114.1",
];

/** The shapes an IPv4 address takes inside an IPv6 one. */
const V4_IN_V6: ReadonlyArray<[string, (v4: string) => string]> = [
  ["v4-mapped", (v4) => `::ffff:${v4}`],
  ["v4-mapped, hex", (v4) => `::ffff:${hexGroups(v4)}`],
  ["IPv4-compatible", (v4) => `::${v4}`],
  ["IPv4-translated", (v4) => `::ffff:0:${v4}`],
  ["NAT64", (v4) => `64:ff9b::${v4}`],
  ["6to4", (v4) => `2002:${hexGroups(v4)}::1`],
];

function hexGroups(v4: string): string {
  const [a = 0, b = 0, c = 0, d = 0] = v4.split(".").map(Number);
  return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
}

function embedded(addresses: ReadonlyArray<string>): Array<[string, string, string]> {
  return V4_IN_V6.flatMap(([form, embed]) =>
    addresses.map((v4): [string, string, string] => [embed(v4), form, v4]),
  );
}

describe("isBlockedAddress", () => {
  it.each(BLOCKED_V4)("blocks %s", (address) => {
    expect(isBlockedAddress(address, 4)).toBe(true);
  });

  it.each(PUBLIC_V4)("allows %s", (address) => {
    expect(isBlockedAddress(address, 4)).toBe(false);
  });

  it.each(embedded(BLOCKED_V4))("blocks %s (%s %s)", (address) => {
    expect(isBlockedAddress(address, 6)).toBe(true);
  });

  it.each(embedded(PUBLIC_V4))("allows %s (%s %s)", (address) => {
    expect(isBlockedAddress(address, 6)).toBe(false);
  });

  it.each([
    // Loopback and unspecified, in the notations that expand to them.
    ["::1"],
    ["0:0:0:0:0:0:0:1"],
    ["::0:0:1"],
    ["::"],
    // v4 in v6 written in hex, or with the trailing groups elided.
    ["::7f00:1"],
    ["64:ff9b::7f00:1"],
    ["64:ff9b::a00:1"],
    ["2002:7f00:1::"],
    // Unique-local, link-local (expanded, and with a zone id), site-local.
    ["fc00::1"],
    ["fd00:0:0:0:0:0:0:1"],
    ["fe80::1"],
    ["fe80:0:0:0:0:0:0:1"],
    ["fe80::1%eth0"],
    ["febf::1"],
    ["fec0::1"],
    // Multicast, every scope: the v4 arm refuses all of 224.0.0.0/4.
    ["ff00::"],
    ["ff02::1"],
    ["ff05::1:3"],
    ["ff0e::1"],
    // Teredo, whatever it embeds. RFC 4380's example (client 192.0.2.45),
    // a public server fronting client 127.0.0.1 (stored bit-inverted, as
    // 80ff:fffe), and a client field that inverts to the public
    // 128.255.255.254.
    ["2001:0:4136:e378:8000:63bf:3fff:fdd2"],
    ["2001:0:4136:e378:8000:63bf:80ff:fffe"],
    ["2001:0:53aa:64c:0:5bfe:7f00:1"],
    ["2001::1"],
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address, 6)).toBe(true);
  });

  it.each([
    ["2606:4700:4700::1111"],
    ["2a00:1450:4001::200e"],
    // Beside Teredo's 2001::/32, not inside it.
    ["2001:4860:4860::8888"],
    ["2001:db8::1"],
  ])("allows %s", (address) => {
    expect(isBlockedAddress(address, 6)).toBe(false);
  });

  it.each([
    ["not:an:address:at:all:::", 6],
    ["1::2::3", 6],
    ["12345::1", 6],
    ["::ffff:256.0.0.1", 6],
    ["", 6],
    ["256.0.0.1", 4],
    ["1.2.3", 4],
    ["a.b.c.d", 4],
    ["::1", 4],
  ])("blocks %s as family %s, which does not parse", (address, family) => {
    expect(isBlockedAddress(address, family)).toBe(true);
  });
});
