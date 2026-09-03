/**
 * Which IP addresses an outbound fetch may reach (THREAT-MODEL T6).
 *
 * The rule is a **deny list of address ranges**, not of hostnames: a hostname is
 * attacker-controlled and a DNS record can be changed between two lookups, so the
 * only thing worth judging is the address the connection would actually go to.
 * Everything private, local, or that a cloud provider has given a special meaning
 * is refused; anything else is public and allowed.
 */

export type IpFamily = 4 | 6;

export interface DeniedRange {
  readonly cidr: string;
  readonly why: string;
}

/** IPv4 ranges no outbound request from this process may reach. */
export const DENIED_IPV4: readonly DeniedRange[] = [
  { cidr: "0.0.0.0/8", why: "this network" },
  { cidr: "10.0.0.0/8", why: "RFC1918 private" },
  { cidr: "100.64.0.0/10", why: "carrier-grade NAT" },
  { cidr: "127.0.0.0/8", why: "loopback" },
  { cidr: "169.254.0.0/16", why: "link-local, including the 169.254.169.254 metadata service" },
  { cidr: "172.16.0.0/12", why: "RFC1918 private" },
  { cidr: "192.0.0.0/24", why: "IETF protocol assignments" },
  { cidr: "192.0.2.0/24", why: "documentation (TEST-NET-1)" },
  { cidr: "192.168.0.0/16", why: "RFC1918 private" },
  { cidr: "198.18.0.0/15", why: "benchmarking" },
  { cidr: "198.51.100.0/24", why: "documentation (TEST-NET-2)" },
  { cidr: "203.0.113.0/24", why: "documentation (TEST-NET-3)" },
  { cidr: "224.0.0.0/4", why: "multicast" },
  { cidr: "240.0.0.0/4", why: "reserved, including the broadcast address" },
];

/** IPv6 ranges no outbound request from this process may reach. */
export const DENIED_IPV6: readonly DeniedRange[] = [
  { cidr: "::/128", why: "unspecified" },
  { cidr: "::1/128", why: "loopback" },
  { cidr: "::ffff:0:0/96", why: "IPv4-mapped; judged as IPv4 instead" },
  { cidr: "64:ff9b::/96", why: "NAT64, which can name an IPv4 private address" },
  { cidr: "100::/64", why: "discard-only" },
  { cidr: "2001:db8::/32", why: "documentation" },
  { cidr: "fc00::/7", why: "unique local (ULA)" },
  { cidr: "fe80::/10", why: "link-local" },
  { cidr: "ff00::/8", why: "multicast" },
];

/** Parse dotted-quad IPv4 into a 32-bit unsigned integer, or `null`. */
export function parseIpv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/** Parse an IPv6 literal into its sixteen bytes, or `null`. */
export function parseIpv6(value: string): Uint8Array | null {
  const address = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const zone = address.indexOf("%");
  const bare = zone === -1 ? address : address.slice(0, zone);
  if (!bare.includes(":")) return null;

  const halves = bare.split("::");
  if (halves.length > 2) return null;

  const expand = (group: string): string[] => (group === "" ? [] : group.split(":"));
  const head = expand(halves[0] ?? "");
  const tail = halves.length === 2 ? expand(halves[1] ?? "") : [];

  // A trailing IPv4 literal (`::ffff:127.0.0.1`) contributes two groups.
  const groups: string[] = [];
  const pushGroup = (list: string[], into: string[]): boolean => {
    for (let index = 0; index < list.length; index += 1) {
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const piece = list[index] ?? "";
      if (piece.includes(".")) {
        if (index !== list.length - 1) return false;
        const v4 = parseIpv4(piece);
        if (v4 === null) return false;
        into.push(((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return false;
      into.push(piece);
    }
    return true;
  };

  const headGroups: string[] = [];
  const tailGroups: string[] = [];
  if (!pushGroup(head, headGroups)) return null;
  if (!pushGroup(tail, tailGroups)) return null;

  if (halves.length === 2) {
    const fill = 8 - headGroups.length - tailGroups.length;
    if (fill < 0) return null;
    groups.push(...headGroups, ...Array.from({ length: fill }, () => "0"), ...tailGroups);
  } else {
    groups.push(...headGroups);
  }
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let index = 0; index < 8; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    const word = Number.parseInt(groups[index] ?? "0", 16);
    bytes[index * 2] = (word >> 8) & 0xff;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function inIpv4Range(address: number, cidr: string): boolean {
  const [network, bits] = cidr.split("/");
  const base = parseIpv4(network ?? "");
  const prefix = Number(bits ?? "32");
  if (base === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === (base & mask) >>> 0;
}

function inIpv6Range(address: Uint8Array, cidr: string): boolean {
  const [network, bits] = cidr.split("/");
  const base = parseIpv6(network ?? "");
  const prefix = Number(bits ?? "128");
  if (base === null) return false;
  const fullBytes = Math.floor(prefix / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    if (address[index] !== base[index]) return false;
  }
  const remainder = prefix % 8;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  return ((address[fullBytes] ?? 0) & mask) === ((base[fullBytes] ?? 0) & mask);
}

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as its IPv4 address, else `null`. */
function mappedIpv4(bytes: Uint8Array): number | null {
  // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
  for (let index = 0; index < 10; index += 1) if (bytes[index] !== 0) return null;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return (
    (((bytes[12] ?? 0) << 24) |
      ((bytes[13] ?? 0) << 16) |
      ((bytes[14] ?? 0) << 8) |
      (bytes[15] ?? 0)) >>>
    0
  );
}

/**
 * Why this address may not be reached, or `null` when it may.
 *
 * Accepts anything `dns.lookup` can return, including IPv4-mapped IPv6, which is
 * judged as the IPv4 address it carries — otherwise `::ffff:127.0.0.1` would walk
 * straight past an IPv4-only deny list.
 */
export function reasonAddressIsDenied(address: string): string | null {
  const v4 = parseIpv4(address);
  if (v4 !== null) {
    const hit = DENIED_IPV4.find((range) => inIpv4Range(v4, range.cidr));
    return hit === undefined ? null : `${address} is ${hit.why}`;
  }

  const v6 = parseIpv6(address);
  if (v6 === null) return `${address} is not an IP address`;

  const mapped = mappedIpv4(v6);
  if (mapped !== null) {
    const hit = DENIED_IPV4.find((range) => inIpv4Range(mapped, range.cidr));
    return hit === undefined ? null : `${address} maps to an address that is ${hit.why}`;
  }

  const hit = DENIED_IPV6.find((range) => inIpv6Range(v6, range.cidr));
  return hit === undefined ? null : `${address} is ${hit.why}`;
}

/** Convenience predicate over {@link reasonAddressIsDenied}. */
export function isPublicAddress(address: string): boolean {
  return reasonAddressIsDenied(address) === null;
}
