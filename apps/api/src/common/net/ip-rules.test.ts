import { describe, expect, it } from "vitest";

import { isPublicAddress, parseIpv4, parseIpv6, reasonAddressIsDenied } from "./ip-rules.js";

describe("parseIpv4", () => {
  it("reads dotted quads", () => {
    expect(parseIpv4("0.0.0.0")).toBe(0);
    expect(parseIpv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIpv4("10.0.0.1")).toBe(0x0a000001);
  });

  it.each(["1.2.3", "1.2.3.4.5", "256.0.0.1", "a.b.c.d", "", "1.2.3.-1"])("refuses %j", (bad) => {
    expect(parseIpv4(bad)).toBeNull();
  });
});

describe("parseIpv6", () => {
  it("expands the compressed form", () => {
    const loopback = parseIpv6("::1");
    expect(loopback?.[15]).toBe(1);
    expect(parseIpv6("fd00::1")?.[0]).toBe(0xfd);
    expect(parseIpv6("2001:4860:4860::8888")?.[0]).toBe(0x20);
  });

  it("reads a bracketed literal and a zone id", () => {
    expect(parseIpv6("[::1]")).not.toBeNull();
    expect(parseIpv6("fe80::1%eth0")).not.toBeNull();
  });

  it("reads an embedded IPv4 tail", () => {
    const mapped = parseIpv6("::ffff:127.0.0.1");
    expect(mapped?.[12]).toBe(127);
    expect(mapped?.[15]).toBe(1);
  });

  it.each(["1.2.3.4", "", "gggg::1", "1::2::3", "::ffff:999.1.1.1"])("refuses %j", (bad) => {
    expect(parseIpv6(bad)).toBeNull();
  });
});

describe("the deny list (THREAT-MODEL T6)", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "RFC1918"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.255", "RFC1918"],
    ["192.168.1.1", "RFC1918"],
    ["169.254.169.254", "the cloud metadata service"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["0.0.0.0", "this network"],
    ["255.255.255.255", "broadcast"],
    ["224.0.0.1", "multicast"],
    ["::1", "IPv6 loopback"],
    ["[::1]", "IPv6 loopback, bracketed"],
    ["::", "unspecified"],
    ["fd00::1", "IPv6 ULA"],
    ["fc00::1", "IPv6 ULA"],
    ["fe80::1", "IPv6 link-local"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["64:ff9b::a00:1", "NAT64 wrapping RFC1918"],
  ])("denies %s (%s)", (address) => {
    expect(reasonAddressIsDenied(address)).not.toBeNull();
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "93.184.216.34",
    "172.32.0.1",
    "9.255.255.255",
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
  ])("allows the public address %s", (address) => {
    expect(reasonAddressIsDenied(address)).toBeNull();
    expect(isPublicAddress(address)).toBe(true);
  });

  it("denies anything that is not an address at all", () => {
    expect(reasonAddressIsDenied("localhost")).toContain("not an IP address");
  });

  it("explains itself, so an operator reading a log knows which rule bit", () => {
    expect(reasonAddressIsDenied("169.254.169.254")).toContain("metadata");
    expect(reasonAddressIsDenied("fd00::1")).toContain("unique local");
  });
});
