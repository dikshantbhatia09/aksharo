import { describe, expect, it } from "vitest";

import type { Env } from "@montaj/config";

import { DevOutboxProvider, DEV_OUTBOX_LIMIT } from "./dev-outbox.provider.js";
import { createMailProvider, MailProviderConfigError } from "./mail.factory.js";
import { SesProvider, sesTagValue } from "./ses.provider.js";
import { parseSmtpUrl, SmtpProvider } from "./smtp.provider.js";
import { createMemoryRedis } from "../../../test/fakes.js";
import { redisKeys } from "../../auth/auth.constants.js";

import type { MailMessage } from "./mail.provider.js";
import type { SesClient } from "./ses.provider.js";
import type { SmtpTransport } from "./smtp.provider.js";
import type Redis from "ioredis";

const BASE_ENV = {
  S3_REGION: "ap-south-1",
  WEB_ORIGIN: "http://localhost:3000",
} as unknown as Env;

function env(overrides: Partial<Env>): Env {
  return { ...BASE_ENV, ...overrides } as Env;
}

const MESSAGE: MailMessage = {
  to: "asha@example.test",
  subject: "Confirm your email address",
  text: "text body",
  html: "<p>html body</p>",
  tags: { kind: "verify-email", locale: "en" },
  idempotencyKey: "verify-email-abc123",
};

describe("provider selection", () => {
  it("picks the development outbox by default and refuses it in production", () => {
    const redis = createMemoryRedis() as unknown as Redis;
    const provider = createMailProvider(env({ MAIL_PROVIDER: "dev" }), redis);
    expect(provider.name).toBe("dev");

    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(() => createMailProvider(env({ MAIL_PROVIDER: "dev" }), redis)).toThrow(
        MailProviderConfigError,
      );
    } finally {
      if (previous === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = previous;
    }
  });

  it("picks SES and takes its region from S3_REGION, with no credentials", () => {
    const provider = createMailProvider(
      env({ MAIL_PROVIDER: "ses", MAIL_FROM: "Aksharo <hello@aksharo.ai>" }),
      createMemoryRedis() as unknown as Redis,
    );
    expect(provider.name).toBe("ses");
    expect(provider).toBeInstanceOf(SesProvider);
  });

  it("picks SMTP from SMTP_URL", () => {
    const provider = createMailProvider(
      env({
        MAIL_PROVIDER: "smtp",
        MAIL_FROM: "hello@aksharo.ai",
        SMTP_URL: "smtp://localhost:1025",
      }),
      createMemoryRedis() as unknown as Redis,
    );
    expect(provider.name).toBe("smtp");
    expect(provider).toBeInstanceOf(SmtpProvider);
  });

  it("refuses a real transport with no envelope sender, and SMTP with no URL", () => {
    const redis = createMemoryRedis() as unknown as Redis;
    expect(() => createMailProvider(env({ MAIL_PROVIDER: "ses" }), redis)).toThrow(
      MailProviderConfigError,
    );
    expect(() =>
      createMailProvider(env({ MAIL_PROVIDER: "smtp", MAIL_FROM: "a@b.test" }), redis),
    ).toThrow(MailProviderConfigError);
  });
});

describe("the development outbox", () => {
  it("writes A04's entry shape at A04's key, so its e2e suite still reads it", async () => {
    const redis = createMemoryRedis();
    const provider = new DevOutboxProvider(redis as unknown as Redis);

    await provider.send({
      ...MESSAGE,
      devOutbox: { template: "email_verification", token: "tok-1", link: "https://x.test/v" },
    });

    const entries = redis.lists.get(redisKeys.devOutbox()) ?? [];
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(entries[0] ?? "{}") as Record<string, unknown>;
    expect(entry["to"]).toBe("asha@example.test");
    expect(entry["template"]).toBe("email_verification");
    expect(entry["token"]).toBe("tok-1");
    expect(entry["link"]).toBe("https://x.test/v");
    // Plus what A25 renders, which A04 never had.
    expect(entry["subject"]).toBe(MESSAGE.subject);
    expect(entry["html"]).toContain("html body");
  });

  it("falls back to the tag when there is no A04 template name", async () => {
    const redis = createMemoryRedis();
    await new DevOutboxProvider(redis as unknown as Redis).send(MESSAGE);
    const entry = JSON.parse((redis.lists.get(redisKeys.devOutbox()) ?? [])[0] ?? "{}") as Record<
      string,
      unknown
    >;
    expect(entry["template"]).toBe("verify-email");
    expect(entry["kind"]).toBe("verify-email");
  });

  it("keeps the newest entries first and caps the list", async () => {
    const redis = createMemoryRedis();
    const provider = new DevOutboxProvider(redis as unknown as Redis);
    for (let index = 0; index < DEV_OUTBOX_LIMIT + 5; index += 1) {
      await provider.send({ ...MESSAGE, subject: `message ${String(index)}` });
    }
    const entries = redis.lists.get(redisKeys.devOutbox()) ?? [];
    expect(entries).toHaveLength(DEV_OUTBOX_LIMIT);
    expect(JSON.parse(entries[0] ?? "{}")).toMatchObject({
      subject: `message ${String(DEV_OUTBOX_LIMIT + 4)}`,
    });
  });
});

describe("the SES adapter", () => {
  function fakeSes(): { client: SesClient; commands: Record<string, unknown>[] } {
    const commands: Record<string, unknown>[] = [];
    return {
      commands,
      client: {
        send: async (command) => {
          commands.push((command as unknown as { input: Record<string, unknown> }).input);
          return { MessageId: "ses-1" };
        },
      },
    };
  }

  it("sends both bodies, the tags and the headers, from the configured sender", async () => {
    const { client, commands } = fakeSes();
    const provider = new SesProvider(client, "Aksharo <hello@aksharo.ai>");

    const result = await provider.send({
      ...MESSAGE,
      headers: { "List-Unsubscribe": "<https://x.test/u>" },
    });

    expect(result.providerMessageId).toBe("ses-1");
    const input = commands[0] ?? {};
    expect(input["FromEmailAddress"]).toBe("Aksharo <hello@aksharo.ai>");
    expect(input["Destination"]).toEqual({ ToAddresses: ["asha@example.test"] });
    expect(input["EmailTags"]).toEqual([
      { Name: "kind", Value: "verify-email" },
      { Name: "locale", Value: "en" },
    ]);
    const content = input["Content"] as { Simple: Record<string, unknown> };
    expect(content.Simple["Headers"]).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://x.test/u>" },
    ]);
    const body = content.Simple["Body"] as Record<string, { Data: string }>;
    expect(body["Text"]?.Data).toBe("text body");
    expect(body["Html"]?.Data).toBe("<p>html body</p>");
  });

  it("omits the tag list rather than sending an empty one", async () => {
    const { client, commands } = fakeSes();
    await new SesProvider(client, "hello@aksharo.ai").send({ ...MESSAGE, tags: {} });
    expect((commands[0] ?? {})["EmailTags"]).toBeUndefined();
  });

  /** SES rejects the whole request over one character SES does not like. */
  it("sanitises a tag value", () => {
    expect(sesTagValue("verify-email")).toBe("verify-email");
    expect(sesTagValue("en-IN/web")).toBe("en-IN_web");
    expect(sesTagValue("a".repeat(300))).toHaveLength(256);
  });

  it("lets a provider failure through, so the queue retries it", async () => {
    const provider = new SesProvider(
      {
        send: async () => {
          throw new Error("Throttling");
        },
      },
      "hello@aksharo.ai",
    );
    await expect(provider.send(MESSAGE)).rejects.toThrow("Throttling");
  });
});

describe("the SMTP adapter", () => {
  it("parses a connection URL into host, port, TLS and credentials", () => {
    expect(parseSmtpUrl("smtp://localhost:1025")).toEqual({
      host: "localhost",
      port: 1025,
      secure: false,
    });
    expect(parseSmtpUrl("smtps://relay.example.test")).toEqual({
      host: "relay.example.test",
      port: 465,
      secure: true,
    });
    expect(parseSmtpUrl("smtp://relay.example.test")).toMatchObject({ port: 587, secure: false });
    // A password with an `@` is common and must survive the round trip.
    expect(parseSmtpUrl("smtp://user%40corp:p%40ss@relay.test:25")).toEqual({
      host: "relay.test",
      port: 25,
      secure: false,
      auth: { user: "user@corp", pass: "p@ss" },
    });
  });

  it("sends both bodies and stamps the message key as a header", async () => {
    const sent: Record<string, unknown>[] = [];
    const transport: SmtpTransport = {
      sendMail: async (options) => {
        sent.push(options);
        return { messageId: "<1@relay>" };
      },
      close: () => undefined,
    };
    const provider = new SmtpProvider(transport, "hello@aksharo.ai");

    const result = await provider.send({ ...MESSAGE, headers: { "List-Unsubscribe": "<u>" } });

    expect(result.providerMessageId).toBe("<1@relay>");
    const options = sent[0] ?? {};
    expect(options["from"]).toBe("hello@aksharo.ai");
    expect(options["to"]).toBe("asha@example.test");
    expect(options["text"]).toBe("text body");
    expect(options["html"]).toBe("<p>html body</p>");
    expect(options["headers"]).toEqual({
      "List-Unsubscribe": "<u>",
      "X-Aksharo-Message-Key": "verify-email-abc123",
    });
    await provider.close();
  });

  it("reports no id when the relay does not give one", async () => {
    const provider = new SmtpProvider({ sendMail: async () => ({}) }, "hello@aksharo.ai");
    expect(await provider.send(MESSAGE)).toEqual({});
    // A transport with no `close` must not make shutdown throw.
    await provider.close();
  });
});
