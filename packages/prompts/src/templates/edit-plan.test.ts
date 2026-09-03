import { describe, expect, it } from "vitest";

import {
  editPlanTemplate,
  EDIT_PLAN_PASS_KINDS,
  MAX_PASSES_BY_TIER,
  validateEditPlan,
} from "./edit-plan.js";
import { runEditPlanChecks } from "../eval/edit-plan-checks.js";
import { EDIT_PLAN_FIXTURES } from "../eval/edit-plan-fixtures.js";
import { mockEditPlan } from "../eval/edit-plan-mock.js";

import type { EditPlanInput } from "./edit-plan.js";

const BASE: EditPlanInput = {
  prompt: "Cut the silences and add background music",
  language: "en",
  durationMs: 60_000,
  existingStyles: [],
  planTier: "creator",
  segments: [{ startMs: 0, endMs: 4_000, text: "Hello everyone welcome to the show" }],
};

describe("edit-plan@1", () => {
  it("builds non-empty system/user messages, transcript fenced as data", () => {
    const input = editPlanTemplate.inputSchema.parse(BASE);
    const messages = editPlanTemplate.build(input);
    expect(messages.system.length).toBeGreaterThan(0);
    expect(messages.user).toContain("<transcript>");
  });

  it("rejects an unknown pass kind", () => {
    const violations = validateEditPlan(
      { passes: [{ kind: "sfx", params: {} }], rationale: ["ok"] },
      { planTier: "creator", existingStyles: [] },
    );
    expect(violations).toHaveLength(0);

    const bad = validateEditPlan(
      // @ts-expect-error -- deliberately an unknown kind, guardrail must catch it at runtime too
      { passes: [{ kind: "denoise", params: {} }], rationale: ["ok"] },
      { planTier: "creator", existingStyles: [] },
    );
    expect(bad.some((v) => v.code === "unknown_kind")).toBe(true);
  });

  it("rejects a plan over the plan tier's pass budget", () => {
    const tooMany = Array.from({ length: MAX_PASSES_BY_TIER.starter + 1 }, () => ({
      kind: "autocut" as const,
      params: {},
    }));
    const violations = validateEditPlan(
      { passes: tooMany, rationale: tooMany.map(() => "reason") },
      { planTier: "starter", existingStyles: [] },
    );
    expect(violations.some((v) => v.code === "budget_exceeded")).toBe(true);
  });

  it("rejects the pro engine tier on a non-Studio/Agency plan", () => {
    const violations = validateEditPlan(
      { passes: [{ kind: "autocut", params: { engine: "pro" } }], rationale: ["reason"] },
      { planTier: "creator", existingStyles: [] },
    );
    expect(violations.some((v) => v.code === "engine_not_allowed")).toBe(true);
  });

  it("allows the pro engine tier on Studio/Agency", () => {
    const violations = validateEditPlan(
      { passes: [{ kind: "autocut", params: { engine: "pro" } }], rationale: ["reason"] },
      { planTier: "studio", existingStyles: [] },
    );
    expect(violations).toHaveLength(0);
  });

  it("rejects a style not in the project's existing styles", () => {
    const violations = validateEditPlan(
      { passes: [{ kind: "autocut", params: {} }], rationale: ["reason"], style: "ghost_style" },
      { planTier: "creator", existingStyles: ["style_a", "style_b"] },
    );
    expect(violations.some((v) => v.code === "unknown_style")).toBe(true);
  });

  it("every EDIT_PLAN_FIXTURES entry produces a schema- and guardrail-valid mock plan", () => {
    expect(EDIT_PLAN_FIXTURES.length).toBeGreaterThanOrEqual(12);
    for (const fixture of EDIT_PLAN_FIXTURES) {
      const parsedInput = editPlanTemplate.inputSchema.parse(fixture.input);
      const output = mockEditPlan(parsedInput);
      const checks = runEditPlanChecks(parsedInput, output);
      const failing = checks.filter((c) => !c.ok);
      expect(failing, `${fixture.id}: ${JSON.stringify(failing)}`).toHaveLength(0);
      for (const pass of output.passes) {
        expect(EDIT_PLAN_PASS_KINDS).toContain(pass.kind);
      }
    }
  });

  it("includes a Hinglish fixture", () => {
    expect(EDIT_PLAN_FIXTURES.some((f) => f.input.language === "hi-Latn")).toBe(true);
  });
});
