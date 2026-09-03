import { describe, expect, it, vi } from "vitest";

import { requestWsTicket } from "./wsTransport.js";

/**
 * `wsTransport.ts` itself is excluded from coverage (vitest.config.ts: no live `WebSocket`
 * server in jsdom) and exercised manually per docs/GATE-C-CHECKLIST.md. `requestWsTicket`
 * needs no `WebSocket` at all, only a mockable `fetch`, so it is unit-tested here — C02c's
 * replacement for C09's `?token=` fallback (docs/security/threat-model-audit-2026-09-03.md,
 * T11 follow-up): the panel exchanges its bearer for a one-time ticket over `fetch`
 * (which, unlike the `WebSocket` constructor, can set an `Authorization` header).
 */
describe("requestWsTicket", () => {
  it("GETs /session/ws-ticket with a Bearer Authorization header and returns the ticket", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe("http://127.0.0.1:47842/session/ws-ticket");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
      return new Response(JSON.stringify({ ticket: "tk_abc123", expiresInMs: 30_000 }), {
        status: 200,
      });
    });

    const ticket = await requestWsTicket(47842, "secret-token", fetchImpl as typeof fetch);
    expect(ticket).toBe("tk_abc123");
  });

  it("rejects when the server refuses the bearer", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    );

    await expect(requestWsTicket(47842, "wrong-token", fetchImpl as typeof fetch)).rejects.toThrow(
      /ws-ticket request failed \(401\)/,
    );
  });

  it("rejects when the response carries no ticket", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));

    await expect(requestWsTicket(47842, "secret-token", fetchImpl as typeof fetch)).rejects.toThrow(
      /carried no ticket/,
    );
  });
});
