import { execFileSync } from "node:child_process";
import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { pushEndpointProblem } from "./push-endpoint.js";
import { webPushSetting } from "./push-env.js";
import {
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  PushSubscriptionsService,
} from "./push-subscriptions.service.js";
import {
  MAX_PUSH_FAILURES,
  PUSH_TTL_SECONDS,
  WebPushChannel,
  devicePayload,
} from "./push.channel.js";
import { base64UrlDecode, base64UrlEncode, generateVapidKeys } from "./web-push.crypto.js";
import { AppException } from "../../common/index.js";

import type { WebPushSetting } from "./push-env.js";
import type { PrismaService } from "../../common/prisma/prisma.service.js";
import type { PushSubscription } from "@prisma/client";

const USER = "01JCUSER00000000000000000A";
const OTHER = "01JCUSER00000000000000000B";
const FCM = "https://fcm.googleapis.com/fcm/send/abc123";
const MOZILLA = "https://updates.push.services.mozilla.com/wpush/v2/xyz";

/** A browser: its key pair and auth secret, as `PushSubscription.toJSON()` would give them. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.from("fedcba9876543210");
  return {
    ecdh,
    p256dh: base64UrlEncode(ecdh.getPublicKey()),
    auth: base64UrlEncode(auth),
    authBytes: auth,
  };
}

/** What a browser does with a push: RFC 8291 decryption with its own private key. */
function openAsBrowser(body: Buffer, device: ReturnType<typeof browser>): unknown {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverKey = body.subarray(21, 21 + idLength);
  const ciphertext = body.subarray(21 + idLength);
  const shared = device.ecdh.computeSecret(serverKey);
  const info = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    device.ecdh.getPublicKey(),
    serverKey,
  ]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, device.authBytes, info, 32));
  const cek = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  return JSON.parse(record.subarray(0, record.lastIndexOf(0x02)).toString());
}

/** Just enough of `prisma.pushSubscription` for the service, in memory. */
function fakePrisma() {
  const rows = new Map<string, PushSubscription>();
  let clock = Date.parse("2026-09-29T10:00:00Z");
  const matches = (row: PushSubscription, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === "id" && typeof value === "object" && value !== null && "in" in value) {
        return (value as { in: string[] }).in.includes(row.id);
      }
      // eslint-disable-next-line security/detect-object-injection -- a column name from the service's own `where`
      return (row as unknown as Record<string, unknown>)[key] === value;
    });
  const pushSubscription = {
    upsert: async (args: {
      where: { endpoint: string };
      create: Partial<PushSubscription>;
      update: Partial<PushSubscription>;
    }) => {
      const existing = [...rows.values()].find((row) => row.endpoint === args.where.endpoint);
      if (existing !== undefined) {
        const next = { ...existing, ...args.update };
        rows.set(next.id, next);
        return next;
      }
      clock += 1_000;
      const created: PushSubscription = {
        id: String(args.create.id),
        userId: String(args.create.userId),
        endpoint: String(args.create.endpoint),
        p256dh: String(args.create.p256dh),
        auth: String(args.create.auth),
        createdAt: new Date(clock),
        lastSuccessAt: null,
        failureCount: 0,
      };
      rows.set(created.id, created);
      return created;
    },
    findMany: async (args: { where: Record<string, unknown>; orderBy?: unknown }) =>
      [...rows.values()]
        .filter((row) => matches(row, args.where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    deleteMany: async (args: { where: Record<string, unknown> }) => {
      let count = 0;
      for (const row of [...rows.values()]) {
        if (!matches(row, args.where)) continue;
        rows.delete(row.id);
        count += 1;
      }
      return { count };
    },
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const row of [...rows.values()]) {
        if (!matches(row, args.where)) continue;
        const increment = (args.data["failureCount"] as { increment?: number } | undefined)
          ?.increment;
        rows.set(row.id, {
          ...row,
          ...(args.data as Partial<PushSubscription>),
          failureCount:
            increment === undefined
              ? ((args.data["failureCount"] as number | undefined) ?? row.failureCount)
              : row.failureCount + increment,
        });
        count += 1;
      }
      return { count };
    },
  };
  return { rows, prisma: { pushSubscription } as unknown as PrismaService };
}

function onSetting(): WebPushSetting {
  const keys = generateVapidKeys();
  const setting = webPushSetting({
    WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
    WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
    WEB_PUSH_SUBJECT: "mailto:alerts@example.test",
  });
  if (setting.kind !== "on") throw new Error("expected web push on");
  return setting;
}

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

function pushService(statuses: readonly number[] | ((url: string) => number)) {
  const sent: Sent[] = [];
  let call = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    const status =
      // eslint-disable-next-line security/detect-object-injection -- a counter into the test's own list
      typeof statuses === "function" ? statuses(String(url)) : (statuses[call] ?? 201);
    call += 1;
    return new Response(null, { status });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

describe("WEB_PUSH_* settings", () => {
  const keys = generateVapidKeys();

  it("is simply off when no key is set", () => {
    expect(webPushSetting({}).kind).toBe("off");
  });

  it("says what is wrong, never with the value, when it cannot be used", () => {
    expect(webPushSetting({ WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey })).toEqual({
      kind: "invalid",
      problem: "half_configured",
    });
    expect(
      webPushSetting({
        WEB_PUSH_VAPID_PUBLIC_KEY: generateVapidKeys().publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
      }),
    ).toEqual({ kind: "invalid", problem: "bad_keys" });
    expect(
      webPushSetting({
        WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
        WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
        WEB_PUSH_SUBJECT: "http://insecure.example.test",
      }),
    ).toEqual({ kind: "invalid", problem: "bad_subject" });
  });

  it("takes the pair `scripts/generate-vapid-keys.mjs` prints, as the deploy step runs it", () => {
    const printed = execFileSync(process.execPath, [
      fileURLToPath(new URL("../../../scripts/generate-vapid-keys.mjs", import.meta.url)),
    ]).toString();
    const env = Object.fromEntries(
      printed
        .trim()
        .split("\n")
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(Object.keys(env).sort()).toEqual([
      "WEB_PUSH_VAPID_PRIVATE_KEY",
      "WEB_PUSH_VAPID_PUBLIC_KEY",
    ]);
    expect(webPushSetting(env).kind).toBe("on");
  });

  it("is on with a pair, and falls back to the support address as the subject", () => {
    const setting = webPushSetting({
      WEB_PUSH_VAPID_PUBLIC_KEY: keys.publicKey,
      WEB_PUSH_VAPID_PRIVATE_KEY: keys.privateKey,
    });
    expect(setting.kind).toBe("on");
    if (setting.kind === "on") {
      expect(setting.publicKey).toBe(keys.publicKey);
      expect(setting.subject).toMatch(/^mailto:.+@.+/);
    }
  });
});

describe("push endpoints (the API only ever POSTs to browser push services)", () => {
  it("accepts every push service a supported browser uses", () => {
    for (const endpoint of [
      FCM,
      MOZILLA,
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/QGuQyavXutnMHzmdvD1ot6",
    ]) {
      expect(pushEndpointProblem(endpoint), endpoint).toBeNull();
    }
  });

  it("refuses this machine, a private address, a lookalike host, and anything but https:443", () => {
    expect(pushEndpointProblem("https://127.0.0.1:3913/internal/jobs")).toBe("insecure");
    expect(pushEndpointProblem("https://localhost/x")).toBe("unknown_service");
    expect(pushEndpointProblem("https://169.254.169.254/latest/meta-data")).toBe("unknown_service");
    expect(pushEndpointProblem("https://fcm.googleapis.com.evil.test/x")).toBe("unknown_service");
    expect(pushEndpointProblem("https://evilfcm.googleapis.com/x")).toBe("unknown_service");
    expect(pushEndpointProblem("https://mozilla.com.push.services.mozilla.com.evil/x")).toBe(
      "unknown_service",
    );
    expect(pushEndpointProblem("http://fcm.googleapis.com/fcm/send/abc")).toBe("insecure");
    expect(pushEndpointProblem("https://fcm.googleapis.com:8443/fcm/send/abc")).toBe("insecure");
    expect(pushEndpointProblem("https://user:pw@fcm.googleapis.com/x")).toBe("insecure");
    expect(pushEndpointProblem("not a url")).toBe("not_a_url");
    expect(pushEndpointProblem(`${FCM}/${"a".repeat(2_100)}`)).toBe("too_long");
  });
});

describe("PushSubscriptionsService", () => {
  it("keeps a browser's subscription, and the same browser again is one row with fresh keys", async () => {
    const { prisma, rows } = fakePrisma();
    const service = new PushSubscriptionsService(prisma);
    const device = browser();
    const first = await service.save(USER, {
      endpoint: FCM,
      p256dh: device.p256dh,
      auth: device.auth,
    });
    const again = browser();
    const second = await service.save(USER, {
      endpoint: FCM,
      p256dh: again.p256dh,
      auth: again.auth,
    });
    expect(second.id).toBe(first.id);
    expect(rows.size).toBe(1);
    expect(rows.get(first.id)?.p256dh).toBe(again.p256dh);
  });

  it("moves a browser to whoever turned notifications on in it last", async () => {
    const { prisma, rows } = fakePrisma();
    const service = new PushSubscriptionsService(prisma);
    const device = browser();
    const saved = await service.save(USER, {
      endpoint: FCM,
      p256dh: device.p256dh,
      auth: device.auth,
    });
    await service.save(OTHER, { endpoint: FCM, p256dh: device.p256dh, auth: device.auth });
    expect(rows.get(saved.id)?.userId).toBe(OTHER);
    // And the first account can no longer remove it: it is not theirs.
    expect(await service.remove(USER, FCM)).toBe(false);
    expect(await service.remove(OTHER, FCM)).toBe(true);
  });

  it("refuses an endpoint off the allow-list and keys that cannot be encrypted to", async () => {
    const { prisma, rows } = fakePrisma();
    const service = new PushSubscriptionsService(prisma);
    const device = browser();
    await expect(
      service.save(USER, {
        endpoint: "https://127.0.0.1:3913/x",
        p256dh: device.p256dh,
        auth: device.auth,
      }),
    ).rejects.toBeInstanceOf(AppException);
    await expect(
      service.save(USER, {
        endpoint: FCM,
        p256dh: base64UrlEncode(Buffer.alloc(65, 7)),
        auth: device.auth,
      }),
    ).rejects.toMatchObject({ code: "notify/push_subscription_invalid" });
    await expect(
      service.save(USER, { endpoint: FCM, p256dh: device.p256dh, auth: "short" }),
    ).rejects.toMatchObject({ code: "notify/push_subscription_invalid" });
    expect(rows.size).toBe(0);
  });

  it("keeps at most a handful of browsers per person, forgetting the oldest", async () => {
    const { prisma, rows } = fakePrisma();
    const service = new PushSubscriptionsService(prisma);
    const device = browser();
    for (let index = 0; index <= MAX_PUSH_SUBSCRIPTIONS_PER_USER; index += 1) {
      await service.save(USER, {
        endpoint: `${FCM}-${String(index)}`,
        p256dh: device.p256dh,
        auth: device.auth,
      });
    }
    const kept = [...rows.values()].map((row) => row.endpoint);
    expect(kept).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    expect(kept).not.toContain(`${FCM}-0`);
    expect(kept).toContain(`${FCM}-${String(MAX_PUSH_SUBSCRIPTIONS_PER_USER)}`);
  });
});

describe("WebPushChannel", () => {
  const message = {
    userId: USER,
    kind: "clips-ready" as const,
    title: "Your clips are ready",
    body: "3 clips from Diwali vlog ready to watch.",
    url: "https://app.example.test/repurpose/01JRUN0000000000000000000A",
    thread: "01JRUN0000000000000000000A",
  };

  async function withSubscriptions(count: number) {
    const { prisma, rows } = fakePrisma();
    const service = new PushSubscriptionsService(prisma);
    const devices = Array.from({ length: count }, () => browser());
    for (const [index, device] of devices.entries()) {
      await service.save(USER, {
        endpoint: index % 2 === 0 ? `${FCM}${String(index)}` : `${MOZILLA}${String(index)}`,
        p256dh: device.p256dh,
        auth: device.auth,
      });
    }
    return { service, rows, devices };
  }

  it("does nothing, and says it is off, without VAPID keys", async () => {
    const { service } = await withSubscriptions(1);
    const { sent, fetchImpl } = pushService([201]);
    const channel = new WebPushChannel(service, { kind: "off" }, fetchImpl);
    expect(channel.publicKey).toBeNull();
    expect(await channel.deliver(message)).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("encrypts to each browser's own keys and signs for each push service", async () => {
    const { service, devices, rows } = await withSubscriptions(2);
    const { sent, fetchImpl } = pushService([201, 201]);
    const setting = onSetting();
    const channel = new WebPushChannel(service, setting, fetchImpl);

    expect(await channel.deliver(message)).toEqual({ sent: 2, failed: 0, removed: 0 });
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      const headers = request.init.headers as Record<string, string>;
      expect(request.init.method).toBe("POST");
      expect(request.init.redirect).toBe("manual");
      expect(headers["Content-Encoding"]).toBe("aes128gcm");
      expect(headers["TTL"]).toBe(String(PUSH_TTL_SECONDS));
      expect(headers["Topic"]).toBe(message.thread);
      expect(headers["Authorization"]).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
      expect(headers["Authorization"]).toContain(
        `k=${setting.kind === "on" ? setting.publicKey : ""}`,
      );
      const claims = JSON.parse(
        base64UrlDecode(String(headers["Authorization"]).split(".")[1] ?? "").toString(),
      ) as { aud: string };
      expect(claims.aud).toBe(new URL(request.url).origin);
    }
    // Each browser reads its own message, and nobody else's key opens it.
    const byEndpoint = [...rows.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
    for (const [index, device] of devices.entries()) {
      const endpoint = index % 2 === 0 ? `${FCM}${String(index)}` : `${MOZILLA}${String(index)}`;
      const request = sent.find((entry) => entry.url === endpoint);
      expect(openAsBrowser(Buffer.from(request?.init.body as Uint8Array), device)).toEqual({
        title: message.title,
        body: message.body,
        url: message.url,
        kind: "clips-ready",
        tag: message.thread,
      });
    }
    expect(byEndpoint.every((row) => row.lastSuccessAt !== null)).toBe(true);
  });

  it("forgets a browser the push service says is gone, and counts other refusals", async () => {
    const { service, rows } = await withSubscriptions(2);
    const { fetchImpl } = pushService((url) => (url.startsWith(FCM) ? 410 : 503));
    const channel = new WebPushChannel(service, onSetting(), fetchImpl);

    expect(await channel.deliver(message)).toEqual({ sent: 0, failed: 1, removed: 1 });
    const left = [...rows.values()];
    expect(left).toHaveLength(1);
    expect(left[0]?.endpoint.startsWith(MOZILLA)).toBe(true);
    expect(left[0]?.failureCount).toBe(1);
  });

  it("forgets a browser that has refused every message for a long time", async () => {
    const { service, rows } = await withSubscriptions(1);
    const [row] = [...rows.values()];
    if (row === undefined) throw new Error("no row");
    rows.set(row.id, { ...row, failureCount: MAX_PUSH_FAILURES - 1 });
    const { fetchImpl } = pushService([400]);
    const channel = new WebPushChannel(service, onSetting(), fetchImpl);
    expect(await channel.deliver(message)).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect(rows.size).toBe(0);
  });

  it("survives a push service that cannot be reached", async () => {
    const { service, rows } = await withSubscriptions(1);
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const channel = new WebPushChannel(service, onSetting(), failing);
    expect(await channel.deliver(message)).toEqual({ sent: 0, failed: 1, removed: 0 });
    expect([...rows.values()][0]?.failureCount).toBe(1);
  });

  it("never pushes to a stored endpoint that is off the allow-list", async () => {
    const { service, rows } = await withSubscriptions(1);
    const [row] = [...rows.values()];
    if (row === undefined) throw new Error("no row");
    rows.set(row.id, { ...row, endpoint: "https://10.0.0.5/steal" });
    const { sent, fetchImpl } = pushService([201]);
    const channel = new WebPushChannel(service, onSetting(), fetchImpl);
    expect(await channel.deliver(message)).toEqual({ sent: 0, failed: 0, removed: 1 });
    expect(sent).toHaveLength(0);
  });

  it("keeps the payload inside one record however long the copy is", () => {
    const long = devicePayload({ ...message, body: "क्लिप ".repeat(2_000) });
    expect(long.length).toBeLessThan(4_000);
    expect(JSON.parse(long.toString())).toMatchObject({ title: message.title, url: message.url });
  });
});
