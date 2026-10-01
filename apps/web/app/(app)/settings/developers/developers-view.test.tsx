import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DevelopersView, MCP_CONFIG } from "./developers-view";

import { renderWithProviders } from "@/test/harness";

describe("<DevelopersView /> using Aksharo from an AI assistant", () => {
  it("offers the MCP server and the settings that run it with a key", () => {
    renderWithProviders(<DevelopersView />, {
      routes: {
        "/workspaces/01JWORKSPACE/api-keys": [],
        "/workspaces/01JWORKSPACE/webhooks": [],
      },
    });
    expect(screen.getByTestId("mcp-download")).toHaveAttribute(
      "href",
      "/downloads/aksharo-mcp.mjs",
    );
    expect(screen.getByTestId("mcp-config")).toHaveTextContent('"AKSHARO_API_KEY": "ak_live_..."');
    // Valid JSON, so it pastes straight into an assistant's settings.
    expect(() => JSON.parse(MCP_CONFIG) as unknown).not.toThrow();
  });
});
