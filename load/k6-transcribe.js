// X02 load scenario, k6 form (the brief names k6 first; `run.mjs` in this
// directory is the harness that actually executes in this environment — see
// its header for why). Kept as a real, runnable k6 script for a machine that
// has k6 installed (`brew install k6` / the official Docker image), not a
// stub: it drives the same endpoint, the same way, with the same assertions.
//
//   ACCESS_TOKEN=<minted token> API_ORIGIN=http://localhost:59923 \
//   PROJECT_IDS=<comma-separated 100 project ids, already probed and credited> \
//     k6 run load/k6-transcribe.js
//
// `run.mjs --k6-prep` prints an `ACCESS_TOKEN=...` / `PROJECT_IDS=...` pair
// ready to paste into that invocation, so the two files share one setup path
// rather than inventing project creation twice.
import http from "k6/http";
import { check } from "k6";
import { Trend } from "k6/metrics";

const API_ORIGIN = __ENV.API_ORIGIN || "http://localhost:59923";
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN;
const PROJECT_IDS = (__ENV.PROJECT_IDS || "").split(",").filter(Boolean);

const jobCreateLatency = new Trend("job_create_latency_ms", true);

export const options = {
  scenarios: {
    transcribe_burst: {
      executor: "shared-iterations",
      vus: 100,
      iterations: PROJECT_IDS.length,
      maxDuration: "60s",
    },
  },
  thresholds: {
    // X02 acceptance: API p95 < 300ms for job creation, all jobs succeed.
    job_create_latency_ms: ["p(95)<300"],
    http_req_failed: ["rate<0.01"],
  },
};

export default function transcribeOne() {
  const projectId = PROJECT_IDS[__ITER % PROJECT_IDS.length];
  const response = http.post(
    `${API_ORIGIN}/projects/${projectId}/transcribe`,
    JSON.stringify({
      languages: ["hi-Latn"],
      hints: [],
      diarise: false,
      captions: { dropFillers: true, maxChars: 60, maxLines: 1, minMs: 200, maxMs: 8000 },
    }),
    {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/json" },
    },
  );
  jobCreateLatency.add(response.timings.duration);
  check(response, {
    "202 accepted": (r) => r.status === 202 || r.status === 200,
  });
}
