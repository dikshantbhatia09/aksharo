import { describe, expect, it, vi } from "vitest";

import { resolveSafeTarget, safeFetch, SafeFetchError } from "./safe-fetch.js";

import type { AddressResolver, SafeTransport, SafeTransportResponse } from "./safe-fetch.js";

/** A resolver that answers with whatever the test says the name resolves to. */
function resolverFor(map: Record<string, readonly string[]>): AddressResolver {
  return async (hostname) => {
    const addresses = map[hostname];
    if (addresses === undefined) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({
      address,
      family: address.includes(":") ? 6 : 4,
    }));
  };
}

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): SafeTransportResponse {
  return {
    status,
    headers,
    body: (async function* stream() {
      yield new TextEncoder().encode(body);
    })(),
    destroy: () => undefined,
  };
}

const PUBLIC = resolverFor({
  "example.com": ["93.184.216.34"],
  "evil.test": ["10.0.0.5"],
  "mixed.test": ["93.184.216.34", "127.0.0.1"],
  "redirector.test": ["93.184.216.34"],
  "metadata.test": ["169.254.169.254"],
  "v6.test": ["fd00::1"],
});

describe("resolveSafeTarget", () => {
  it("accepts a public name", async () => {
    const target = await resolveSafeTarget("https://example.com/subs.srt", { resolver: PUBLIC });
    expect(target.address).toBe("93.184.216.34");
    expect(target.family).toBe(4);
  });

  it.each([
    ["http://127.0.0.1/x", "loopback literal"],
    ["http://10.0.0.1/x", "RFC1918 literal"],
    ["http://169.254.169.254/latest/meta-data/", "the metadata service"],
    ["http://[::1]/x", "IPv6 loopback literal"],
    ["http://[fd00::1]/x", "IPv6 ULA literal"],
  ])("refuses %s (%s)", async (url) => {
    // An IP literal still goes through the resolver, which hands it straight back.
    const resolver: AddressResolver = async (hostname) => [
      { address: hostname, family: hostname.includes(":") ? 6 : 4 },
    ];
    await expect(resolveSafeTarget(url, { resolver })).rejects.toMatchObject({
      code: "blocked_address",
    });
  });

  it("refuses a name that resolves into a private range", async () => {
    await expect(
      resolveSafeTarget("https://evil.test/subs.srt", { resolver: PUBLIC }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("refuses a name with one public AND one private record", async () => {
    // Judging only the address we would use would let a second record through on
    // the next lookup; every answer is checked instead.
    await expect(
      resolveSafeTarget("https://mixed.test/subs.srt", { resolver: PUBLIC }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it.each(["file:///etc/passwd", "gopher://example.com/", "redis://example.com/", "not a url"])(
    "refuses the scheme in %j",
    async (url) => {
      await expect(resolveSafeTarget(url, { resolver: PUBLIC })).rejects.toMatchObject({
        code: "blocked_scheme",
      });
    },
  );

  it("refuses an unusual port", async () => {
    await expect(
      resolveSafeTarget("http://example.com:6379/", { resolver: PUBLIC }),
    ).rejects.toMatchObject({ code: "blocked_port" });
  });

  it("reports a resolution failure as dns_failed, not as a crash", async () => {
    await expect(
      resolveSafeTarget("https://nowhere.test/", { resolver: PUBLIC }),
    ).rejects.toMatchObject({ code: "dns_failed" });
    await expect(
      resolveSafeTarget("https://example.com/", { resolver: async () => [] }),
    ).rejects.toMatchObject({ code: "dns_failed" });
  });
});

describe("safeFetch", () => {
  it("returns the body and pins the address it vetted", async () => {
    const transport = vi.fn<SafeTransport>(async () =>
      response(200, "WEBVTT", { "content-type": "text/vtt" }),
    );
    const result = await safeFetch("https://example.com/subs.vtt", {
      resolver: PUBLIC,
      transport,
    });

    expect(result.status).toBe(200);
    expect(result.body.toString("utf8")).toBe("WEBVTT");
    expect(result.contentType).toBe("text/vtt");
    expect(transport).toHaveBeenCalledTimes(1);
    const sent = transport.mock.calls[0]?.[0];
    expect(sent?.address).toBe("93.184.216.34");
    // The Host header still names the site, so TLS and vhosts still work.
    expect(sent?.headers["host"]).toBe("example.com");
  });

  it("follows a redirect and re-vets the new URL", async () => {
    const transport = vi
      .fn<SafeTransport>()
      .mockResolvedValueOnce(response(302, "", { location: "https://example.com/final.srt" }))
      .mockResolvedValueOnce(response(200, "1"));

    const result = await safeFetch("https://redirector.test/go", {
      resolver: PUBLIC,
      transport,
    });
    expect(result.url).toBe("https://example.com/final.srt");
    expect(result.redirects).toEqual(["https://redirector.test/go"]);
  });

  it("refuses a redirect that points at the metadata service", async () => {
    const transport = vi
      .fn<SafeTransport>()
      .mockResolvedValueOnce(
        response(302, "", { location: "http://metadata.test/latest/meta-data/" }),
      );

    await expect(
      safeFetch("https://redirector.test/go", { resolver: PUBLIC, transport }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("refuses a redirect to an IPv6 ULA", async () => {
    const transport = vi
      .fn<SafeTransport>()
      .mockResolvedValueOnce(response(301, "", { location: "http://v6.test/x" }));
    await expect(
      safeFetch("https://redirector.test/go", { resolver: PUBLIC, transport }),
    ).rejects.toMatchObject({ code: "blocked_address" });
  });

  it("caps the redirect chain", async () => {
    const transport = vi.fn<SafeTransport>(async () =>
      response(302, "", { location: "https://example.com/again" }),
    );
    await expect(
      safeFetch("https://example.com/start", {
        resolver: PUBLIC,
        transport,
        maxRedirects: 2,
      }),
    ).rejects.toMatchObject({ code: "too_many_redirects" });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("treats a redirect with no Location as a failed request", async () => {
    const transport = vi.fn<SafeTransport>(async () => response(302, ""));
    await expect(
      safeFetch("https://example.com/x", { resolver: PUBLIC, transport }),
    ).rejects.toMatchObject({ code: "request_failed" });
  });

  it("stops reading once the body passes the cap", async () => {
    const destroy = vi.fn();
    const transport: SafeTransport = async () => ({
      status: 200,
      headers: {},
      body: (async function* stream() {
        for (let index = 0; index < 100; index += 1) yield new Uint8Array(1_000);
      })(),
      destroy,
    });

    await expect(
      safeFetch("https://example.com/huge", { resolver: PUBLIC, transport, maxBytes: 2_000 }),
    ).rejects.toMatchObject({ code: "too_large" });
    // The socket is released rather than left draining a hostile server.
    expect(destroy).toHaveBeenCalled();
  });

  it("gives up when the time budget is gone", async () => {
    const transport = vi.fn<SafeTransport>(async () => response(200, "x"));
    await expect(
      safeFetch("https://example.com/x", { resolver: PUBLIC, transport, timeoutMs: 0 }),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("wraps a private address in a SafeFetchError rather than leaking a socket error", async () => {
    const transport = vi.fn<SafeTransport>(async () => response(200, "x"));
    const error = await safeFetch("https://evil.test/x", { resolver: PUBLIC, transport }).catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(SafeFetchError);
    expect(transport).not.toHaveBeenCalled();
  });
});
