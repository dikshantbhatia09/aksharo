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
