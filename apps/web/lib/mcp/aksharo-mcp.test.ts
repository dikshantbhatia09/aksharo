import { describe, expect, it, vi } from "vitest";

import { TOOLS, apiClient, callTool, handle } from "../../public/downloads/aksharo-mcp.mjs";

function answers(routes: Record<string, unknown>) {
  const table = new Map(Object.entries(routes));
  return vi.fn(async (method: string, path: string, body?: unknown) => {
    const key = `${method} ${path.split("?")[0] ?? path}`;
    if (!table.has(key)) throw new Error(`no route ${key}`);
    return { routes: table.get(key), body, path };
  });
}

describe("the Aksharo MCP server", () => {
  it("introduces itself and lists its tools", async () => {
    const init = await handle(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      null,
    );
    expect(init).toMatchObject({
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "aksharo" },
        capabilities: { tools: {} },
      },
    });
    expect(
      await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, null),
    ).toBeUndefined();
    const listed = (await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, null)) as {
      result: { tools: { name: string }[] };
    };
    expect(listed.result.tools.map((tool) => tool.name)).toEqual([
      "find_clips",
      "list_videos",
      "get_video",
      "list_clips",
      "search_clips",
    ]);
    expect(TOOLS.every((tool) => typeof tool.inputSchema === "object")).toBe(true);
    expect(await handle({ jsonrpc: "2.0", id: 3, method: "nope" }, null)).toMatchObject({
      error: { code: -32601 },
    });
  });

  it("starts a run only with the rights confirmed, sending what was asked", async () => {
    const call = answers({ "POST /v1/runs": { id: "RUN" } });
    await expect(callTool(call, "find_clips", { url: "https://youtu.be/x" })).rejects.toThrow(
      /permission/,
    );
    await callTool(call, "find_clips", {
      url: "https://youtu.be/x",
      rights_attested: true,
      clip_length: "short",
      start_at_seconds: 90.5,
    });
    expect(call).toHaveBeenLastCalledWith("POST", "/v1/runs", {
      url: "https://youtu.be/x",
      rightsAttested: true,
      clipLength: "short",
      startAtMs: 90_500,
    });
  });

  it("answers a search with the clips it found", async () => {
    const call = vi.fn(async (_method: string, path: string) =>
      path.includes("/search")
        ? { semantic: true, matches: [{ momentId: "M1", score: 0.7 }] }
        : { clips: [{ id: "C1", momentId: "M1", title: "Raising money" }] },
    );
    const result = await callTool(call, "search_clips", {
      run_id: "RUN",
      question: "raising money",
    });
    expect(result.content[0]?.text).toContain("Raising money");
    expect(call).toHaveBeenCalledWith("GET", "/v1/runs/RUN/search?q=raising%20money");
  });

  it("turns a tool's failure into an error result, not a broken connection", async () => {
    const call = vi.fn(async () => {
      throw new Error("Not enough credits. (repurpose/no_credits)");
    });
    const answer = await handle(
      {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "get_video", arguments: { run_id: "R" } },
      },
      call,
    );
    expect((answer as { result: unknown }).result).toMatchObject({ isError: true });
  });

  it("sends the key and reads the API's own error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "auth/forbidden", message: "Missing scope." } }),
          {
            status: 403,
          },
        ),
    );
    const call = apiClient({ apiKey: "ak_live_x.y", apiUrl: "https://api.test/", fetchImpl });
    await expect(call("GET", "/v1/runs")).rejects.toThrow("Missing scope. (auth/forbidden)");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.test/v1/runs",
      expect.objectContaining({ headers: expect.objectContaining({ "x-api-key": "ak_live_x.y" }) }),
    );
  });
});
