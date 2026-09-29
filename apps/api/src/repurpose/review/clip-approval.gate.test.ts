import { describe, expect, it } from "vitest";

import { ClipApprovalGate, clipsNeedApproval } from "./clip-approval.gate.js";
import { IDS, ReviewMemory, seedWorkspace } from "./review-memory.test-support.js";
import { APPROVAL_MESSAGES, NOT_REQUIRED, mayPost } from "./review-state.js";

describe("the approval setting", () => {
  it("is on only when the workspace's settings say true", () => {
    expect(clipsNeedApproval({ clipsNeedApproval: true })).toBe(true);
    for (const settings of [
      {},
      { clipsNeedApproval: false },
      { clipsNeedApproval: "true" },
      null,
      undefined,
      [],
      "clipsNeedApproval",
    ]) {
      expect(clipsNeedApproval(settings), JSON.stringify(settings)).toBe(false);
    }
  });
});

describe("ClipApprovalGate", () => {
  function gate(settings: Record<string, unknown>): {
    memory: ReviewMemory;
    gate: ClipApprovalGate;
  } {
    const memory = new ReviewMemory();
    seedWorkspace(memory, { settings });
    return { memory, gate: new ClipApprovalGate(memory.prisma) };
  }

  it("requires nothing while the setting is off, whatever the decisions", async () => {
    const { memory, gate: approvals } = gate({});
    memory.tables.clipReview.push({
      clipId: "C1",
      workspaceId: IDS.ws,
      state: "changes_requested",
      videos: {},
    });
    await expect(approvals.required(IDS.ws)).resolves.toBe(false);
    await expect(approvals.forClip(IDS.ws, "C1")).resolves.toBe(NOT_REQUIRED);
  });

  it("answers every clip asked about, from this workspace's decisions only", async () => {
    const { memory, gate: approvals } = gate({ clipsNeedApproval: true });
    memory.tables.clipReview.push(
      { clipId: "C1", workspaceId: IDS.ws, state: "approved", videos: { "9:16": "E1" } },
      { clipId: "C2", workspaceId: IDS.ws, state: "changes_requested", videos: { "9:16": "E2" } },
      // The same clip id under another workspace is not this one's decision.
      { clipId: "C3", workspaceId: IDS.otherWs, state: "approved", videos: { "9:16": "E3" } },
    );
    const checks = await approvals.forClips(IDS.ws, ["C1", "C2", "C3", "C4", "C1"]);
    expect([...checks.keys()]).toEqual(["C1", "C2", "C3", "C4"]);
    expect(checks.get("C1")?.message).toBeNull();
    expect(mayPost(checks.get("C1") ?? NOT_REQUIRED, "E1")).toBe(true);
    expect(checks.get("C2")?.message).toBe(APPROVAL_MESSAGES.changes_requested);
    expect(checks.get("C3")?.message).toBe(APPROVAL_MESSAGES.pending);
    expect(checks.get("C4")?.state).toBe("pending");
  });
});
