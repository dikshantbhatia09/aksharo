import { describe, expect, it, vi } from "vitest";

import { JobCompletionRegistry } from "./completion-handlers.js";

import type { JobCompletionHandler } from "./completion-handlers.js";

function handler(jobType: JobCompletionHandler["jobType"]): JobCompletionHandler {
  return { jobType, handle: vi.fn(async () => undefined) };
}

describe("JobCompletionRegistry", () => {
  it("answers with the handler registered for a queue, and nothing for the rest", () => {
    const registry = new JobCompletionRegistry();
    const transcribe = handler("ai.transcribe");
    registry.register(transcribe);

    expect(registry.handlerFor("ai.transcribe")).toBe(transcribe);
    expect(registry.handlerFor("render.video")).toBeUndefined();
    expect(registry.handlerFor("not-a-queue")).toBeUndefined();
    expect(registry.registeredTypes()).toEqual(["ai.transcribe"]);
  });

  it("refuses a second owner for the same queue", () => {
    const registry = new JobCompletionRegistry();
    registry.register(handler("ai.transcribe"));

    expect(() => registry.register(handler("ai.transcribe"))).toThrow(/already registered/);
  });

  it("tolerates the same handler registering twice (a module re-init)", () => {
    const registry = new JobCompletionRegistry();
    const transcribe = handler("ai.transcribe");
    registry.register(transcribe);
    registry.register(transcribe);

    expect(registry.registeredTypes()).toEqual(["ai.transcribe"]);
  });

  it("keeps one owner per queue across several queues", () => {
    const registry = new JobCompletionRegistry();
    registry.register(handler("render.video"));
    registry.register(handler("ai.transcribe"));

    expect(registry.registeredTypes()).toEqual(["ai.transcribe", "render.video"]);
  });
});
