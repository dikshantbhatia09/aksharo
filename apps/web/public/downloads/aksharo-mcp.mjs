#!/usr/bin/env node
// Aksharo MCP server (2026-10-01): lets an AI assistant (Claude, Cursor, any
// Model Context Protocol client) find clips in a video, follow the run, list
// the clips with their files and search them by meaning, through Aksharo's
// public API with your own API key.
//
// Needs Node 18 or newer and nothing else. Configure your assistant with:
//
//   "aksharo": {
//     "command": "node",
//     "args": ["/path/to/aksharo-mcp.mjs"],
//     "env": { "AKSHARO_API_KEY": "ak_live_..." }
//   }
//
// The key needs the projects_read scope, and projects_write to start a run.
// AKSHARO_API_URL changes the API's address (default: Aksharo's own).
//
// It speaks MCP over standard input and output: one JSON-RPC message a line.
// Nothing is written to standard output except those messages.

import { pathToFileURL } from "node:url";

export const SERVER_NAME = "aksharo";
export const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_API_URL = "https://aksharo-api.crestmondtechnologies.com";

export const TOOLS = [
  {
    name: "find_clips",
    description:
      "Start finding short clips in a long video from its link (a YouTube link). Uses the workspace's saved settings unless told otherwise. Returns the run, whose progress get_video follows. Costs credits.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The video's link." },
        rights_attested: {
          type: "boolean",
          description: "Must be true: you own the video or have permission to use it.",
        },
        autopilot: {
          type: "boolean",
          description:
            "Make every strong moment into captioned clips in every size by itself (default: the saved setting, else on).",
        },
        clip_length: {
          type: "string",
          enum: ["short", "medium", "long"],
          description: "15-35 s, 30-60 s or 55-95 s.",
        },
        topic: { type: "string", description: "What the clips should be about." },
        start_at_seconds: { type: "number", description: "Where to start in a long video." },
      },
      required: ["url", "rights_attested"],
      additionalProperties: false,
    },
  },
  {
    name: "list_videos",
    description: "The workspace's videos being or already made into clips, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "How many (1-50, default 10)." } },
      additionalProperties: false,
    },
  },
  {
    name: "get_video",
    description:
      "Where a video's run is: its stage, progress, how many moments and clips, and its page in the app.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "list_clips",
    description:
      "A video's clips: title, score, times, and download links for every size with and without captions (links expire within the hour).",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "search_clips",
    description:
      "Find a video's clips by what they are about, e.g. 'the part about raising money'.",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" }, question: { type: "string" } },
      required: ["run_id", "question"],
      additionalProperties: false,
    },
  },
];

/** Calls the public API; `fetchImpl` and the config are parameters so it can be tested. */
export function apiClient({ apiKey, apiUrl = DEFAULT_API_URL, fetchImpl = globalThis.fetch }) {
  return async function call(method, path, body) {
    const response = await fetchImpl(`${apiUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message ?? `The API answered ${response.status}.`;
      const code = data?.error?.code ? ` (${data.error.code})` : "";
      throw new Error(`${message}${code}`);
    }
    return data;
  };
}

function text(value) {
  return {
    content: [
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

function requireString(args, name) {
  const value =
    args === null || typeof args !== "object" ? undefined : new Map(Object.entries(args)).get(name);
  if (typeof value !== "string" || value.trim() === "") throw new Error(`"${name}" is required.`);
  return value.trim();
}

/** Runs one tool. */
export async function callTool(call, name, args = {}) {
  switch (name) {
    case "find_clips": {
      if (args.rights_attested !== true) {
        throw new Error(
          "Confirm you own the video or have permission to use it (rights_attested: true).",
        );
      }
      const body = { url: requireString(args, "url"), rightsAttested: true };
      if (typeof args.autopilot === "boolean") body.autopilot = args.autopilot;
      if (typeof args.clip_length === "string") body.clipLength = args.clip_length;
      if (typeof args.topic === "string" && args.topic.trim() !== "")
        body.topic = args.topic.trim();
      if (typeof args.start_at_seconds === "number" && args.start_at_seconds >= 0) {
        body.startAtMs = Math.round(args.start_at_seconds * 1000);
      }
      return text(await call("POST", "/v1/runs", body));
    }
    case "list_videos": {
      const limit = Math.min(50, Math.max(1, Math.round(Number(args.limit ?? 10)) || 10));
      return text(await call("GET", `/v1/runs?limit=${limit}`));
    }
    case "get_video":
      return text(
        await call("GET", `/v1/runs/${encodeURIComponent(requireString(args, "run_id"))}`),
      );
    case "list_clips":
      return text(
        await call("GET", `/v1/runs/${encodeURIComponent(requireString(args, "run_id"))}/clips`),
      );
    case "search_clips": {
      const runId = encodeURIComponent(requireString(args, "run_id"));
      const question = encodeURIComponent(requireString(args, "question"));
      const found = await call("GET", `/v1/runs/${runId}/search?q=${question}`);
      if (!found?.semantic)
        return text(
          "Search by meaning is not available right now; use list_clips and read the titles.",
        );
      if ((found.matches ?? []).length === 0) return text("No clip of this video is about that.");
      const listed = await call("GET", `/v1/runs/${runId}/clips`);
      const byMoment = new Map((listed?.clips ?? []).map((clip) => [clip.momentId, clip]));
      return text(
        found.matches.map((match) => {
          const clip = byMoment.get(match.momentId);
          return {
            score: match.score,
            clip: clip ?? { momentId: match.momentId, note: "not cut into a clip yet" },
          };
        }),
      );
    }
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

/** Answers one JSON-RPC message; `undefined` for a notification. */
export async function handle(message, call) {
  const { id, method, params } = message ?? {};
  const isRequest = id !== undefined && id !== null;
  const reply = (result) => (isRequest ? { jsonrpc: "2.0", id, result } : undefined);
  const fail = (code, text) =>
    isRequest ? { jsonrpc: "2.0", id, error: { code, message: text } } : undefined;
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion:
          typeof params?.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Aksharo turns long videos into short captioned clips. Start with find_clips, follow it with get_video, then list_clips for the files.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      if (call === null) {
        return reply({
          ...text("Set AKSHARO_API_KEY to your Aksharo API key (Settings > Developers)."),
          isError: true,
        });
      }
      try {
        return reply(await callTool(call, params?.name, params?.arguments ?? {}));
      } catch (error) {
        return reply({
          ...text(error instanceof Error ? error.message : String(error)),
          isError: true,
        });
      }
    }
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

async function main() {
  const apiKey = process.env.AKSHARO_API_KEY?.trim() ?? "";
  const call =
    apiKey === ""
      ? null
      : apiClient({ apiKey, apiUrl: process.env.AKSHARO_API_URL?.trim() || DEFAULT_API_URL });
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
        );
        continue;
      }
      void handle(message, call).then((response) => {
        if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
      });
    }
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
