import { describe, expect, it } from "vitest";

import * as ui from "./index";

describe("@montaj/ui", () => {
  it("declares its identity and its owning work package", () => {
    expect(ui.PACKAGE_INFO.name).toBe("@montaj/ui");
    expect(ui.PACKAGE_INFO.implementedBy).toBe("A13");
    expect(ui.PACKAGE_INFO.implemented).toBe(true);
  });

  it("exports every component 08 §2 names as the initial set", () => {
    for (const name of [
      "Button",
      "Input",
      "Field",
      "Dialog",
      "Sheet",
      "Tabs",
      "Tooltip",
      "DropdownMenu",
      "Toaster",
      "Command",
      "CommandDialog",
      "CreditMeter",
      "JobProgress",
      "UpgradeGate",
      "ShortcutHint",
      "EmptyState",
      "LangChip",
      "StatusChip",
    ]) {
      expect(ui, name).toHaveProperty(name);
    }
  });

  it("exports the tokens as data as well as CSS", () => {
    expect(ui.TOKENS.accent.lime500).toBe(ui.ACCENT.lime500);
    expect(ui.cn("p-2", "p-4")).toBe("p-4");
  });
});
