/**
 * The verification snippets `/developers` renders under "Verify a webhook".
 *
 * Kept as data rather than hand-typed into a JSX/HTML template so
 * `webhook-signature.test.ts` can execute the Node snippet verbatim (`new
 * Function` against it, see that file) and prove it agrees with
 * {@link import("./webhook-signature.js").verifyWebhookSignature} — the doc and
 * the implementation cannot silently drift apart because the test IS the doc.
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

export const CURL_CREATE_PROJECT = `curl -X POST https://api.aksharo.example/v1/projects \\
  -H "X-Api-Key: $AKSHARO_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"title": "My project", "sourceUrl": "https://example.com/clip.mp4"}'`;

export const NODE_CREATE_PROJECT = `const res = await fetch("https://api.aksharo.example/v1/projects", {
  method: "POST",
  headers: {
    "X-Api-Key": process.env.AKSHARO_API_KEY,
    "Content-Type": "application/json",
    "Idempotency-Key": crypto.randomUUID(),
  },
  body: JSON.stringify({ title: "My project", sourceUrl: "https://example.com/clip.mp4" }),
});
const project = await res.json();`;

export const PYTHON_CREATE_PROJECT = `import os
import uuid

import requests

res = requests.post(
    "https://api.aksharo.example/v1/projects",
    headers={
        "X-Api-Key": os.environ["AKSHARO_API_KEY"],
        "Idempotency-Key": str(uuid.uuid4()),
    },
    json={"title": "My project", "sourceUrl": "https://example.com/clip.mp4"},
)
project = res.json()
`;
