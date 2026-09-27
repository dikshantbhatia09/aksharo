import { describe, expect, it } from "vitest";

import { alertWebhookSetting } from "./ops-env.js";

describe("ALERT_WEBHOOK_URL", () => {
  it("is unset when absent or blank", () => {
    expect(alertWebhookSetting({})).toEqual({ kind: "unset" });
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "   " })).toEqual({ kind: "unset" });
  });

  it("accepts an https ntfy topic", () => {
    const setting = alertWebhookSetting({ ALERT_WEBHOOK_URL: " https://ntfy.sh/aksharo-ops-x1 " });
    expect(setting.kind).toBe("ok");
    expect(setting.kind === "ok" ? setting.url.href : "").toBe("https://ntfy.sh/aksharo-ops-x1");
  });

  it("accepts plain http only to this machine", () => {
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "http://127.0.0.1:8090/ops" }).kind).toBe("ok");
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "http://localhost/ops" }).kind).toBe("ok");
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "http://ntfy.sh/ops" })).toEqual({
      kind: "invalid",
      problem: "insecure",
    });
  });

  it("refuses credentials in the URL and anything that is not a URL", () => {
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "https://u:p@ntfy.sh/ops" })).toEqual({
      kind: "invalid",
      problem: "has_credentials",
    });
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "ntfy.sh/ops" })).toEqual({
      kind: "invalid",
      problem: "not_a_url",
    });
    expect(alertWebhookSetting({ ALERT_WEBHOOK_URL: "ftp://ntfy.sh/ops" })).toEqual({
      kind: "invalid",
      problem: "not_a_url",
    });
  });
});
