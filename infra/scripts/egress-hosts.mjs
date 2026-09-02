/**
 * Egress host discovery — the shared logic behind `generate-egress-inventory.mjs`
 * and `check-egress-inventory.mjs` (X08 scope item 1).
 *
 * Two sources feed the inventory, and the split matters:
 *
 *   - **code hosts**: a literal hostname a provider adapter dials, found by
 *     grepping `apps/api/src`, `apps/worker-ai`, `apps/worker-media/src`,
 *     `apps/render/src` and `apps/model-server` for a small set of patterns
 *     ("*_BASE_URL = "https://...""" and friends). This is the half the CI gate
 *     enforces: a hostname discovered here that has no metadata entry fails the
 *     build, so nobody can wire up a new vendor without also writing down who
 *     owns it and why the workload is allowed to reach it.
 *
 *   - **declared hosts**: reached only through an env-configured SDK
 *     (`R2_ENDPOINT`, `SENTRY_DSN`, the AWS SDK's SES/SNS regional endpoints),
 *     so no literal hostname sits in application code for a grep to find. These
 *     come from `DECLARED_HOSTS` below, cross-referenced against
 *     `docs/CONTRACTS.md` section 1 and `docs/runbooks/deploy.md`, and are
 *     marked `"source": "declared"` in the inventory rather than `"code"`.
 *
 * Both are metadata-first: `VENDOR_METADATA` is the single table of owner,
 * purpose and workload for every hostname or suffix this repo is expected to
 * reach. `scanCodeHosts()` only ever returns what it found in the tree; turning
 * that into an inventory (`buildInventory()`) is what cross-references against
 * the metadata table and fails loudly on a gap.
 */

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** Directories scanned for outbound hostnames, relative to the repo root. */
export const SCAN_TARGETS = [
  "apps/api/src",
  "apps/worker-ai/worker_ai",
  "apps/worker-media/src",
  "apps/render/src",
  "apps/model-server/model_server",
];

/** File extensions worth grepping. Fixtures and generated code live outside these trees. */
const SCAN_EXTENSIONS = new Set([".ts", ".tsx", ".py"]);

/** Path fragments never scanned: tests intentionally contain fake and adversarial hosts. */
const EXCLUDE_PATTERNS = [/\.test\.[tj]sx?$/, /\.spec\.[tj]sx?$/, /(^|[\\/])tests?([\\/]|$)/];

/**
 * Hostname literals worth flagging, matched line by line rather than against
 * the whole file: every one of these vendors assigns its base URL to a single
 * named constant, so a per-line regex is enough and never needs a real
 * TypeScript/Python parser.
 */
// A real hostname: starts and ends alphanumeric, at least one label, a
// dot-separated TLD of 2+ letters. Deliberately excludes the docstring
// placeholders this codebase writes for illustrative URLs (`https://…`,
// `https://...`, `https://acct.blob.core.windows.net/job-1?sv=...`'s
// leading `acct` is fine, but a bare ellipsis is not a hostname and must
// not become one).
const HOSTNAME = "(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}";

const HOST_PATTERNS = [
  // Python: `SARVAM_DEFAULT_BASE_URL = "https://api.sarvam.ai"`, `ASSEMBLYAI_DEFAULT_BASE_URL = "..."`.
  new RegExp(
    `^\\s*[A-Z][A-Z0-9_]*(?:_DEFAULT)?_(?:BASE_URL|ENDPOINT)\\s*=\\s*"(https?://${HOSTNAME})`,
  ),
  // TypeScript: `const RAZORPAYX_BASE_URL = "https://api.razorpay.com/v1"`,
  // `export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"`.
  new RegExp(
    `^\\s*(?:export\\s+)?const\\s+[A-Z][A-Z0-9_]*(?:_BASE_URL|_ENDPOINT|_URL)\\s*=\\s*"(https?://${HOSTNAME})`,
  ),
  // Python per-region endpoint maps, e.g. the LLM adapters'
  // `_ENDPOINTS: dict[str, str] = { "in": "https://api.anthropic.com/...", ... }`:
  // one quoted-key/quoted-URL pair per line.
  new RegExp(`^\\s*"[a-z0-9_-]+"\\s*:\\s*"(https?://${HOSTNAME})`),
];

/** Pulls `host` out of a URL string; returns null for anything unparsable. */
function hostFromUrl(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // target does not exist in this checkout — not an error, just nothing to scan
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Scans `SCAN_TARGETS` (or `targets`, for tests) under `root` and returns a
 * sorted, de-duplicated list of `{ host, occurrences }`, each occurrence a
 * `{ file, line }` relative to `root`.
 */
export async function scanCodeHosts(root, targets = SCAN_TARGETS) {
  const found = new Map();

  for (const target of targets) {
    for await (const file of walk(join(root, target))) {
      const ext = file.slice(file.lastIndexOf("."));
      if (!SCAN_EXTENSIONS.has(ext)) continue;
      const relPath = relative(root, file).replace(/\\/g, "/");
      if (EXCLUDE_PATTERNS.some((pattern) => pattern.test(relPath))) continue;

      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        for (const pattern of HOST_PATTERNS) {
          const match = pattern.exec(lines[i]);
          if (!match) continue;
          const host = hostFromUrl(match[1]);
          if (!host) continue;
          if (!found.has(host)) found.set(host, []);
          found.get(host).push({ file: relPath, line: i + 1 });
        }
      }
    }
  }

  return [...found.entries()]
    .map(([host, occurrences]) => ({ host, occurrences }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

/**
 * The metadata table. Every hostname (or, for `matchType: "suffix"`, domain
 * suffix) this repo is expected to reach, with who owns the relationship, why
 * the call is made, and which chart component(s) (`infra/k8s/montaj/values.yaml`
 * `components.*`) make it — `[]` for a workload this chart does not run as a
 * component (model-server runs on the serverless GPU provider, D15).
 */
export const VENDOR_METADATA = [
  {
    host: "api.elevenlabs.io",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "ElevenLabs Scribe v2 ASR (CONTRACTS ELEVENLABS_API_KEY)",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "api.in.residency.elevenlabs.io",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "ElevenLabs Scribe v2 ASR, India-residency endpoint",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "api.sarvam.ai",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "Sarvam Saaras v4 ASR and Mayura translate (CONTRACTS SARVAM_API_KEY)",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "api.assemblyai.com",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "AssemblyAI Universal-2 ASR (CONTRACTS ASSEMBLYAI_API_KEY)",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "api.anthropic.com",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "LLM extras when LLM_PROVIDER=anthropic",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "api.openai.com",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "LLM extras when LLM_PROVIDER=openai",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "eu.api.openai.com",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "LLM extras, EU data-residency endpoint when LLM_PROVIDER=openai",
    workloads: ["worker-ai"],
    source: "code",
  },
  {
    host: "api.runpod.ai",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "Serverless GPU control plane (decision D15)",
    workloads: ["worker-ai"],
    source: "declared",
  },
  {
    host: "api.runpod.io",
    matchType: "exact",
    owner: "platform-ai",
    purpose: "Serverless GPU job submission (decision D15)",
    workloads: ["worker-ai"],
    source: "declared",
  },
  {
    host: "api.razorpay.com",
    matchType: "exact",
    owner: "platform-billing",
    purpose: "Razorpay checkout/orders and RazorpayX payouts (CONTRACTS RAZORPAY_KEY_ID)",
    workloads: ["api"],
    source: "code",
  },
  {
    host: "accounts.google.com",
    matchType: "exact",
    owner: "platform-auth",
    purpose: "Google OAuth authorization endpoint and issuer (CONTRACTS GOOGLE_OAUTH_CLIENT_ID)",
    workloads: ["api"],
    source: "code",
  },
  {
    host: "oauth2.googleapis.com",
    matchType: "exact",
    owner: "platform-auth",
    purpose: "Google OAuth token endpoint (CONTRACTS GOOGLE_OAUTH_CLIENT_ID)",
    workloads: ["api"],
    source: "code",
  },
  {
    host: "api.pwnedpasswords.com",
    matchType: "exact",
    owner: "platform-auth",
    purpose:
      "Have I Been Pwned k-anonymity range lookup, breached-password check (THREAT-MODEL T1)",
    workloads: ["api"],
    source: "code",
  },
  {
    host: ".r2.cloudflarestorage.com",
    matchType: "suffix",
    owner: "platform-infra",
    purpose: "Derived object storage (CONTRACTS R2_ENDPOINT) — env-configured, not a code literal",
    workloads: ["api", "worker-media", "worker-ai", "render"],
    source: "declared",
  },
  {
    host: ".ingest.sentry.io",
    matchType: "suffix",
    owner: "platform-infra",
    purpose: "Error reporting (CONTRACTS SENTRY_DSN) — env-configured, not a code literal",
    workloads: ["api", "web", "realtime", "worker-media", "worker-ai", "render", "scheduler"],
    source: "declared",
  },
  {
    host: ".amazonaws.com",
    matchType: "suffix",
    owner: "platform-infra",
    purpose:
      "AWS SDK regional endpoints: SES (transactional mail, MAIL_PROVIDER=ses) and SNS " +
      "(bounce/complaint webhooks) — built by the SDK from AWS_REGION, not a code literal " +
      "(docs/runbooks/deploy.md 'Email (SES) setup')",
    workloads: ["api"],
    source: "declared",
  },
  {
    host: "eu.i.posthog.com",
    matchType: "exact",
    owner: "platform-infra",
    purpose:
      "Product analytics (CONTRACTS POSTHOG_KEY), browser-side default host — not scanned from " +
      "apps/web (out of this chart's egress scope: it never leaves the visitor's browser) and " +
      "not a cluster egress path",
    workloads: ["web"],
    source: "declared",
  },
];

/** Looks up the metadata entry covering `host` (exact match first, then longest matching suffix). */
export function findMetadata(host) {
  const exact = VENDOR_METADATA.find((m) => m.matchType === "exact" && m.host === host);
  if (exact) return exact;
  const suffixes = VENDOR_METADATA.filter(
    (m) => m.matchType === "suffix" && host.endsWith(m.host),
  ).sort((a, b) => b.host.length - a.host.length);
  return suffixes[0] ?? null;
}

/**
 * Builds the inventory document from a fresh code scan plus every declared
 * entry, and reports any code-discovered host with no metadata (the CI gate:
 * X08 acceptance criterion "inventory check ... provably fails on a new host").
 */
export async function buildInventory(root, targets = SCAN_TARGETS) {
  const codeHosts = await scanCodeHosts(root, targets);
  const unknown = [];
  const entries = [];

  for (const { host, occurrences } of codeHosts) {
    const meta = findMetadata(host);
    if (!meta) {
      unknown.push({ host, occurrences });
      continue;
    }
    entries.push({
      host: meta.host,
      matchType: meta.matchType,
      owner: meta.owner,
      purpose: meta.purpose,
      workloads: meta.workloads,
      source: meta.source,
      discoveredIn: occurrences,
    });
  }

  // Declared entries with no code occurrence (R2, Sentry, SES/SNS, RunPod):
  // still part of the inventory, with an empty discoveredIn.
  for (const meta of VENDOR_METADATA) {
    if (meta.source !== "declared") continue;
    if (entries.some((e) => e.host === meta.host)) continue;
    entries.push({
      host: meta.host,
      matchType: meta.matchType,
      owner: meta.owner,
      purpose: meta.purpose,
      workloads: meta.workloads,
      source: meta.source,
      discoveredIn: [],
    });
  }

  entries.sort((a, b) => a.host.localeCompare(b.host));

  return { entries, unknown };
}
