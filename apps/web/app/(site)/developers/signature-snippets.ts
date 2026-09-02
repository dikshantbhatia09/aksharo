/**
 * Kept byte-for-byte identical to `apps/api/src/webhooks/webhook-doc-snippets.ts`
 * (`NODE_VERIFY_SNIPPET`/`CURL_VERIFY_EXAMPLE`/`PYTHON_VERIFY_SNIPPET`), which
 * `webhook-signature.test.ts` on the API side executes against the real
 * signer to prove it verifies correctly (B14 acceptance criterion 2). `apps/web`
 * cannot import from `apps/api/src` (different app, no shared package for it),
 * so this is a manual copy rather than an import — if the two ever drift, the
 * API-side test still catches an incorrect *algorithm*, just not a copy/paste
 * slip here. A shared `packages/` doc-snippets module would remove this risk.
 */

export const NODE_VERIFY_SNIPPET = `const crypto = require("node:crypto");

function verifyAksharoSignature(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  const { t, v1 } = parts;
  if (!t || !v1) return false;

  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSec) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(\`\${t}.\${rawBody}\`, "utf8")
    .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(v1, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyAksharoSignature };
`;

export const CURL_VERIFY_EXAMPLE = `# Given the raw request body in body.json and the header value in $SIGNATURE:
t=$(echo "$SIGNATURE" | sed -n 's/.*t=\\([0-9]*\\).*/\\1/p')
v1=$(echo "$SIGNATURE" | sed -n 's/.*v1=\\([0-9a-f]*\\).*/\\1/p')
expected=$(printf '%s.%s' "$t" "$(cat body.json)" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
[ "$v1" = "$expected" ] && echo "signature ok"`;

export const PYTHON_VERIFY_SNIPPET = `import hashlib
import hmac
import time


def verify_aksharo_signature(secret: str, raw_body: str, header: str, tolerance_sec: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t, v1 = parts.get("t"), parts.get("v1")
    if t is None or v1 is None:
        return False
    if abs(int(time.time()) - int(t)) > tolerance_sec:
        return False
    expected = hmac.new(
        secret.encode("utf-8"), f"{t}.{raw_body}".encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, v1)
`;
