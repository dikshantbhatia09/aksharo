import { describe, expect, it } from "vitest";

import { scrubEvent, scrubText } from "./sentry";

describe("scrubText", () => {
  it("removes email addresses", () => {
    expect(scrubText("login failed for priya@example.co.in")).toBe("login failed for [email]");
  });

  it("removes JWTs and bearer headers", () => {
    expect(scrubText("Authorization: Bearer abc123.def456-ghi")).toContain("[token]");
    expect(scrubText("token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIwMUoifQ.c2lnbmF0dXJl is bad")).toBe(
      "token [jwt] is bad",
    );
  });

  it("removes secrets from query strings, including signed storage URLs", () => {
    expect(scrubText("https://api.aksharo.ai/auth/verify?token=abc123&next=/")).toBe(
      "https://api.aksharo.ai/auth/verify?token=[redacted]&next=/",
    );
    expect(scrubText("https://r2/ws/1/raw.mp4?X-Amz-Signature=deadbeef&x=1")).toContain(
      "X-Amz-Signature=[redacted]",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(scrubText("Could not read the audio track.")).toBe("Could not read the audio track.");
  });
});

describe("scrubEvent", () => {
  it("keeps the account id and drops everything else about the person", () => {
    const event = scrubEvent({
      user: { id: "01JUSER", email: "priya@example.com", ip_address: "203.0.113.10" },
    });
    expect(event.user).toEqual({ id: "01JUSER" });
  });

  it("drops the user object entirely when there is no id", () => {
    expect(scrubEvent({ user: { email: "priya@example.com" } }).user).toEqual({});
  });

  it("drops cookies and headers, and scrubs the URL", () => {
    const event = scrubEvent({
      request: {
        url: "https://aksharo.ai/verify?token=secret",
        headers: { authorization: "Bearer x" },
        cookies: "aksharo_rt=secret",
      },
    });
    expect(event.request?.url).toBe("https://aksharo.ai/verify?token=[redacted]");
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
  });

  it("scrubs the message and every exception value", () => {
    const event = scrubEvent({
      message: "failed for priya@example.com",
      exception: { values: [{ value: "no user priya@example.com" }] },
    });
    expect(event.message).toBe("failed for [email]");
    expect(event.exception?.values?.[0]?.value).toBe("no user [email]");
  });

  it("scrubs breadcrumb messages and drops their data", () => {
    const event = scrubEvent({
      breadcrumbs: [{ message: "POST /auth/login as priya@example.com", data: { body: "secret" } }],
    });
    expect(event.breadcrumbs?.[0]?.message).toBe("POST /auth/login as [email]");
    expect(event.breadcrumbs?.[0]?.data).toBeUndefined();
  });
});
