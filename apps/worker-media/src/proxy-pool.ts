/**
 * Multi-Proxy Egress Manager with Health Probing (Pillar 1 §01).
 *
 * Implements rotating residential and datacenter proxy egress routing to ensure
 * zero 429s and resilience against YouTube bot challenges. Supports Bright Data,
 * Webshare, custom egress endpoints, and fallback to direct interface binding.
 */

import { logger } from "./logger.js";

export interface ProxyNode {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  healthy: boolean;
  failureCount: number;
  consecutiveSuccesses: number;
  lastFailureTime: number;
  cooldownUntil: number;
}

export const BASE_COOLDOWN_MS = 15_000;
export const MAX_COOLDOWN_MS = 600_000; // 10 minutes max backoff

export const BLOCK_PATTERNS = [
  "sign in to confirm you're not a bot",
  "sign in to confirm you are not a bot",
  "http error 429",
  "too many requests",
  "rate-limited",
  "rate limited",
  "captcha",
  "automated queries",
  "bot verification",
  "http error 403",
  "forbidden",
  "proxy connection failed",
  "tunnel connection failed",
] as const;

export function isProxyBlockError(errorOrStderr: string): boolean {
  const lower = errorOrStderr.toLowerCase();
  return BLOCK_PATTERNS.some((pattern) => lower.includes(pattern));
}

export class ProxyPool {
  private readonly nodes: ProxyNode[] = [];
  private roundRobinIndex = 0;
  private readonly sessionMap = new Map<string, string>(); // sessionId -> proxyId

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.initFromEnv(env);
  }

  private initFromEnv(env: NodeJS.ProcessEnv): void {
    if (env["BRIGHT_DATA_PROXY_URL"]?.trim()) {
      this.addNode(env["BRIGHT_DATA_PROXY_URL"].trim(), "brightdata");
    }
    if (env["WEBSHARE_PROXY_URL"]?.trim()) {
      this.addNode(env["WEBSHARE_PROXY_URL"].trim(), "webshare");
    }
    const customList = env["WORKER_MEDIA_PROXIES"]?.trim();
    if (customList) {
      const parts = customList.split(",").map((p) => p.trim()).filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const url = parts[i];
        if (url) {
          this.addNode(url, `custom-proxy-${i + 1}`);
        }
      }
    }

    // Direct interface node (undefined url) as fallback
    const directDisabled = env["WORKER_MEDIA_DISABLE_DIRECT_EGRESS"] === "1";
    if (!directDisabled) {
      this.nodes.push({
        id: "direct",
        url: "direct",
        name: "direct-egress",
        healthy: true,
        failureCount: 0,
        consecutiveSuccesses: 0,
        lastFailureTime: 0,
        cooldownUntil: 0,
      });
    }
  }

  public addNode(url: string, name = "proxy"): ProxyNode {
    const id = `node-${String(this.nodes.length + 1)}-${Math.random().toString(36).slice(2, 6)}`;
    const node: ProxyNode = {
      id,
      url,
      name,
      healthy: true,
      failureCount: 0,
      consecutiveSuccesses: 0,
      lastFailureTime: 0,
      cooldownUntil: 0,
    };
    this.nodes.push(node);
    return node;
  }

  public getNodes(): readonly ProxyNode[] {
    return this.nodes;
  }

  public clear(): void {
    this.nodes.length = 0;
    this.sessionMap.clear();
    this.roundRobinIndex = 0;
  }

  public acquireNode(sessionId?: string): ProxyNode | undefined {
    const now = Date.now();
    // Check if cooldown has expired on any unhealthy nodes
    for (const node of this.nodes) {
      if (!node.healthy && now >= node.cooldownUntil) {
        node.healthy = true;
        logger.info("proxy node restored from cooldown", { node: node.name, id: node.id });
      }
    }

    // 1. Try sticky session if healthy
    if (sessionId && this.sessionMap.has(sessionId)) {
      const assignedId = this.sessionMap.get(sessionId);
      const stickyNode = this.nodes.find((n) => n.id === assignedId && n.healthy);
      if (stickyNode) {
        return stickyNode;
      }
    }

    // 2. Select next healthy proxy in round robin
    const healthyNodes = this.nodes.filter((n) => n.healthy);
    if (healthyNodes.length === 0) {
      // If all nodes are unhealthy, pick the one with earliest cooldown expiry
      const fallback = [...this.nodes].sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
      if (sessionId && fallback) this.sessionMap.set(sessionId, fallback.id);
      return fallback;
    }

    const selected = healthyNodes[this.roundRobinIndex % healthyNodes.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % healthyNodes.length;
    if (sessionId && selected) {
      this.sessionMap.set(sessionId, selected.id);
    }
    return selected;
  }

  public reportFailure(proxyUrlOrId: string | undefined, errorText: string): void {
    if (!proxyUrlOrId) return;
    const node = this.nodes.find((n) => n.url === proxyUrlOrId || n.id === proxyUrlOrId);
    if (!node) return;

    node.failureCount += 1;
    node.consecutiveSuccesses = 0;
    node.lastFailureTime = Date.now();

    // Exponential backoff
    const delay = Math.min(
      BASE_COOLDOWN_MS * Math.pow(2, Math.max(0, node.failureCount - 1)),
      MAX_COOLDOWN_MS,
    );
    node.cooldownUntil = node.lastFailureTime + delay;

    if (isProxyBlockError(errorText)) {
      node.healthy = false;
      logger.warn("proxy node marked unhealthy due to 429/bot block", {
        node: node.name,
        id: node.id,
        failures: node.failureCount,
        cooldownMs: delay,
        reason: errorText.slice(0, 200),
      });
    }
  }

  public reportSuccess(proxyUrlOrId: string | undefined): void {
    if (!proxyUrlOrId) return;
    const node = this.nodes.find((n) => n.url === proxyUrlOrId || n.id === proxyUrlOrId);
    if (!node) return;

    node.healthy = true;
    node.failureCount = 0;
    node.consecutiveSuccesses += 1;
    node.cooldownUntil = 0;
  }

  /**
   * Helper to execute a yt-dlp operation with automatic proxy failover and retry.
   */
  public async executeWithProxyFailover<T>(
    operation: (proxyArg: string | undefined, nodeName: string) => Promise<T>,
    options: { sessionId?: string; maxRetries?: number } = {},
  ): Promise<{ result: T; egressNode: string; proxyUrl: string | undefined }> {
    const maxRetries = options.maxRetries ?? Math.min(3, Math.max(1, this.nodes.length));
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const node = this.acquireNode(options.sessionId);
      const proxyUrl = node && node.url !== "direct" ? node.url : undefined;
      const nodeName = node ? node.name : "direct";

      try {
        const result = await operation(proxyUrl, nodeName);
        if (node) this.reportSuccess(node.id);
        return { result, egressNode: nodeName, proxyUrl };
      } catch (err) {
        lastError = err;
        const errMsg = err instanceof Error ? err.message : String(err);
        if (node) this.reportFailure(node.id, errMsg);

        if (!isProxyBlockError(errMsg) || attempt >= maxRetries) {
          throw err;
        }

        logger.info("retrying operation with next proxy node", {
          attempt,
          maxRetries,
          failedNode: nodeName,
          err: errMsg.slice(0, 150),
        });
      }
    }

    throw lastError;
  }
}

export const globalProxyPool = new ProxyPool();
