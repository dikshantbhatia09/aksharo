import { describe, expect, it } from "vitest";
import { ProxyPool, isProxyBlockError } from "./proxy-pool.js";

describe("ProxyPool Egress Manager", () => {
  it("detects bot challenges and 429 block errors", () => {
    expect(isProxyBlockError("HTTP Error 429: Too Many Requests")).toBe(true);
    expect(isProxyBlockError("WARNING: Sign in to confirm you're not a bot")).toBe(true);
    expect(isProxyBlockError("Solve the captcha to proceed")).toBe(true);
    expect(isProxyBlockError("File not found on disk")).toBe(false);
  });

  it("rotates healthy nodes and marks failing nodes unhealthy", () => {
    const pool = new ProxyPool({ WORKER_MEDIA_DISABLE_DIRECT_EGRESS: "1" });
    const n1 = pool.addNode("http://proxy1:8080", "proxy-1");
    const n2 = pool.addNode("http://proxy2:8080", "proxy-2");

    const first = pool.acquireNode();
    expect(first).toBeDefined();

    // Report 429 failure on node 1
    pool.reportFailure(n1.id, "HTTP Error 429: Too Many Requests");
    expect(n1.healthy).toBe(false);

    // Next acquisition should return node 2
    const next = pool.acquireNode();
    expect(next?.id).toBe(n2.id);
  });

  it("supports sticky sessions for same video ID", () => {
    const pool = new ProxyPool({ WORKER_MEDIA_DISABLE_DIRECT_EGRESS: "1" });
    const n1 = pool.addNode("http://proxy1:8080", "proxy-1");
    pool.addNode("http://proxy2:8080", "proxy-2");

    const session = "video-dQw4w9WgXcQ";
    const acquired = pool.acquireNode(session);
    const again = pool.acquireNode(session);

    expect(again?.id).toBe(acquired?.id);
  });

  it("executes operations with automatic proxy failover on block", async () => {
    const pool = new ProxyPool({ WORKER_MEDIA_DISABLE_DIRECT_EGRESS: "1" });
    const n1 = pool.addNode("http://bad-proxy:8080", "bad-proxy");
    const n2 = pool.addNode("http://good-proxy:8080", "good-proxy");

    let callCount = 0;
    const { result, egressNode } = await pool.executeWithProxyFailover(async (proxyUrl) => {
      callCount++;
      if (proxyUrl === n1.url) {
        throw new Error("HTTP Error 429: Too Many Requests");
      }
      return "success-data";
    });

    expect(result).toBe("success-data");
    expect(callCount).toBe(2);
    expect(egressNode).toBe("good-proxy");
    expect(n1.healthy).toBe(false);
    expect(n2.healthy).toBe(true);
  });
});

