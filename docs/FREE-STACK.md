# Free-stack mode (M20)

The user ruling that started this work package (2026-09-03): **no paid keys**.
This document is the complete list of what runs entirely on free/open-source
pieces, the exact `.env` lines, start commands, and what is intentionally
unavailable in this mode.

The normal local infrastructure (PostgreSQL, Redis and MinIO), local Whisper,
Ollama, the API, the web app and the workers all run without a paid account.
The provider switches below make that mode explicit and keep unavailable
third-party actions out of the UI.

## 1. Local LLM (Ollama)

`LLM_PROVIDER=ollama` selects `OllamaLlmProvider`
(`apps/worker-ai/worker_ai/llm/providers/ollama.py`) and
`OllamaPlannerClient` (`apps/api/src/prompted-edits/planner-client.ts`) — no
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` needed. Both call a local Ollama
server's OpenAI-compatible `/v1/chat/completions` endpoint.

### Install and pull the default model

```
winget install --id Ollama.Ollama -e --silent
# confirm it's listening:
curl http://127.0.0.1:11434/api/tags
ollama pull qwen2.5:3b
```

`qwen2.5:3b` is ~1.9 GB on disk and runs on CPU only — no GPU required, which
is the point of this mode, but every call is materially slower than a hosted
model (real measurements below).

### `.env` lines

```
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:3b
```

Both `LLM_BASE_URL`/`LLM_MODEL` are optional — left blank, the same defaults
apply (`packages/config/src/env.ts`, `apps/worker-ai/worker_ai/settings.py`).

### Real latencies (this host, CPU-only, `qwen2.5:3b`)

Measured with a real run through `generate_insight`/`OllamaPlannerClient` —
not the mock provider:

| Call                 | Latency                  |
| -------------------- | ------------------------ |
| `summary` insight    | 2.5 s                    |
| `music-mood` insight | 0.7 s                    |
| prompted-edit plan   | 2.0 s                    |
| `chapters` insight   | failed twice (see below) |

### Small-model output normalisation (increment 2b)

A 3B local model's JSON reply is often _almost_ schema-valid rather than
exactly valid: a title a few characters over the cap, an optional field
spelled out as `null` instead of omitted, an edit plan with one pass more
than the workspace's tier allows, a reply cut off mid-string before the
model reached its 60-character title budget. `apps/worker-ai/worker_ai/llm/normalize.py`
(Python, insights) and `packages/prompts/src/eval/small-model-normalize.ts`
(TypeScript, edit plans + the local eval) apply a few deterministic,
conservative repairs to the raw JSON **before** schema validation, only on
the Ollama path:

- strip `null`-valued optional fields,
- truncate an over-cap string on a word boundary (never mid-word),
- request a bigger token budget (`options.num_predict`/`max_tokens` floored
  at 3,000, well above every template's own budget) and, when a reply looks
  truncated specifically (not merely mis-shaped), retry once with a
  stricter "reply with ONLY complete JSON, under 150 words" system line,
  instead of the generic repair message,
- for edit plans, clamp the pass count to the plan tier's budget by
  dropping the LOWEST-priority passes (`autocut` first, `textfx` last —
  `EDIT_PLAN_PASS_KINDS`'s own order) instead of failing the whole plan,
  and trim a rationale list that has more entries than kept passes,
- sanitise a hashtag to the schema's allowed character class (strip
  spaces/hyphens/punctuation, keep the letters) rather than rejecting it
  outright.

None of this ever invents content — every repair either removes something
the model already said or is a no-op. `pnpm --filter @montaj/prompts
eval:local` (below) is the harness that measures how much it actually helps.

### Known limitation: `chapters` and `hooks` on `qwen2.5:3b`

Even with the normaliser above, two templates are genuinely hard for a 3B
model:

- **`chapters`**: before the normaliser, `qwen2.5:3b` reliably exceeded the
  60-character chapter-title cap and the one repair attempt did not fix it
  either (this was the actual, unrecovered failure recorded in increment
  2's real run). The truncate-on-word-boundary rule in increment 2b fixes
  this deterministically — `chapters` now passes 4/4 fixtures in
  `eval:local` — but it is fixing the model's output after the fact, not
  making the model stop overshooting.
- **`hooks`**: the schema asks for exactly 5 hooks, exactly 5 titles and
  exactly 10 correctly-shaped hashtags, three times over (YouTube,
  Instagram, TikTok) — 45+ precisely-shaped strings in one JSON reply. A 3B
  model frequently returns the wrong count, or a reply so long it gets cut
  off before finishing even at the 3,000-token floor. The normaliser can
  truncate an over-long array or sanitise a malformed hashtag, but it never
  invents a missing hook or hashtag — so `hooks` remains the weakest
  category in local runs of `eval:local` (typically 0/4 fixtures).

If `hooks`/`chapters` reliability matters for your use of this build, see
the upgrade path below.

### `pnpm --filter @montaj/prompts eval:local`

Runs the same fixtures/checks `eval` (CI, mock-only) uses, once for real
against whatever `LLM_BASE_URL`/`LLM_MODEL` point at, with a clean skip
(exit 0) when nothing is reachable — safe to leave in a dev script:

```
pnpm --filter @montaj/prompts eval:local
```

Writes `packages/prompts/eval-results/report-local.{json,md}` (gitignored).
A real run against `qwen2.5:3b` on this host: **12-13/24** fixtures pass
(runs vary — the model is not deterministic even at low temperature).
`chapters` and edit-plan improved the most from the increment 2b
normaliser (chapters: 0/4 → 4/4); `hooks` remains the hardest category for
the reason above; two `summary`/`hooks` fixtures fail the hallucination
guard — a real, working guardrail catching the model paraphrasing rather
than quoting the transcript, which this normaliser deliberately does **not**
try to suppress (loosening a content-safety check to make an eval number
look better would defeat the check's purpose).

### Upgrade path: `qwen2.5:7b`

A bigger local model follows instructions and holds exact-shape constraints
more reliably — expect real, if not total, improvement in the `hooks` and
`chapters` failure rates above.

```
ollama pull qwen2.5:7b
```

- **Size**: ~4.7 GB on disk (versus `qwen2.5:3b`'s ~1.9 GB).
- **RAM**: needs roughly 8 GB of headroom free at inference time (rule of
  thumb: model size × ~1.5-2 for a quantised GGUF plus context). Check
  actual free RAM before pulling — this is real memory pressure, not disk.
- **Only pull it after freeing enough disk** — this repo's dev host runs
  close to its disk budget; do not pull `qwen2.5:7b` alongside `qwen2.5:3b`
  without checking `df -h` / `Get-PSDrive` first, and remove `qwen2.5:3b`
  first if space is tight (`ollama rm qwen2.5:3b`).
- Switch models with `LLM_MODEL=qwen2.5:7b` in `.env` — no code change.
  `eval:local` picks it up automatically.

## 2. Local Whisper (ASR)

Already free by default (M15) — see `docs/models/LOCAL-MODELS.md` for the
`WORKER_AI_WHISPER_MODEL=small` weight details, licence and SHA-256.
Switching to a more accurate model:

```
WORKER_AI_WHISPER_MODEL=medium
```

Costs more disk (the `medium` weight is materially larger than `small`) and
more RAM/CPU time per transcription job — no download is provisioned by this
work package; set the variable and let `faster-whisper` fetch it on first
use, or provision it the same way `docs/models/LOCAL-MODELS.md` documents
for `small`.

## 3. Development sign-up without a mail vendor

Set both lines together:

```dotenv
MAIL_PROVIDER=dev
AUTH_DEV_AUTO_VERIFY=1
```

The API still creates a single-use verification token and writes the would-be
message to the development outbox, then marks a newly created account verified.
It logs the would-be link and the sign-up page moves directly to “You can sign
in now”; no mail server or mailbox click is needed.

This is deliberately a two-key decision in code, and every unsafe combination
**refuses to start** rather than being quietly ignored — an ignored flag stays
armed in a parameter store until some unrelated change makes it live. The API
will not boot when `AUTH_DEV_AUTO_VERIFY=1` is combined with any of:

- a real transport (`MAIL_PROVIDER=smtp` or `ses`);
- a `MAIL_PROVIDER` that is merely _defaulting_ to `dev` because it was never
  set — the development outbox has to be chosen on purpose;
- `NODE_ENV=production`, under any mail provider.

Keep the default `AUTH_DEV_AUTO_VERIFY=0` anywhere that should exercise the real
confirmation flow.

Understand the blast radius before enabling it anywhere shared: a verified
address is not only mailbox proof, it is the authorisation gate for claiming a
pending workspace invitation. With auto-verification on, whoever types an address
into the sign-up form collects any invitation waiting for that address. This is a
single-developer local convenience, not a staging setting. The API preserves its anti-enumeration response in both modes: sign-up
does not reveal whether an address already existed.

## 4. UI with Google and Razorpay keys absent

Leave these values empty:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
```

The web server turns only provider availability — never a credential — into
runtime booleans for the browser. With no complete Google client, login and
sign-up omit both the Google action and its divider. Email/password sign-up and
login remain available.

With no complete Razorpay credential set, `/billing` says “Credits are granted
by your admin”, the plan screen shows the same explanation, and purchase and
upgrade checkout controls are absent. Existing credit balances and usage remain
visible. Administrators do not need a second free-stack-only tool: the existing
`/admin/credits` **Adjust (grant)** action calls `POST /admin/credits/adjust`, is
restricted to `finance`/`superadmin`, requires a reason, and writes the audited
`adjust` credit lot. Workspace detail pages link to it with the workspace ID
pre-filled. Amounts are entered in tenths of a credit (for example, `200` grants
20 credits).

## 5. Complete `.env` provider block

Keep the required database, object-store, JWT, callback-secret and origin values
from `.env.example`, then use this provider block for the all-local mode:

```dotenv
# No hosted identity or payments
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# No vendor speech APIs; local-whisper is selected when installed
SARVAM_API_KEY=
ELEVENLABS_API_KEY=
ASSEMBLYAI_API_KEY=
WORKER_AI_WHISPER_MODEL=small

# Local structured LLM
LLM_PROVIDER=ollama
LLM_BASE_URL=http://127.0.0.1:11434/v1
LLM_MODEL=qwen2.5:3b

# No mail vendor and no confirmation click in this local build
MAIL_PROVIDER=dev
AUTH_DEV_AUTO_VERIFY=1
MAIL_FROM=
SMTP_URL=

# Do not route work to a paid serverless GPU
GPU_PROVIDER=none
GPU_PROVIDER_URL=
GPU_PROVIDER_TOKEN=
```

`WORKER_AI_WHISPER_MODEL=medium` is the accuracy-over-speed alternative from
section 2. It is not downloaded by M20.

## 6. Start from a fresh checkout (Windows PowerShell)

Prerequisites are Node 22, pnpm 9, Python 3.12, Docker Desktop and ffmpeg on
`PATH`. Install dependencies and build internal packages once:

```powershell
corepack enable
corepack prepare pnpm@9.15.9 --activate
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# Edit .env: retain its required local values and apply section 5 above.
pnpm --filter "./packages/*" build
```

Install local Whisper into the worker's managed virtual environment. The named
Whisper weight is fetched on its first transcription unless it has already been
provisioned as described in `docs/models/LOCAL-MODELS.md`:

```powershell
Set-Location apps\worker-ai
# `pnpm run setup`, never `pnpm setup`: the latter is pnpm's own global command and
# shadows the package script, so it exits without ever creating `.venv`.
pnpm run setup
.\.venv\Scripts\python.exe -m pip install "faster-whisper==1.2.1"
Set-Location ..\..
```

Start the shared free infrastructure once from the checkout that owns it, then
migrate and seed the database:

```powershell
docker compose up -d
docker compose ps
pnpm db:migrate
pnpm db:seed
```

Confirm Ollama is running and the small model is present (section 1 has the
one-time install command):

```powershell
curl.exe http://127.0.0.1:11434/api/tags
ollama list
# First setup only, if qwen2.5:3b is absent:
ollama pull qwen2.5:3b
```

Run each long-lived process in its own PowerShell terminal from the repository
root. The four Node/Python services read the repository-root `.env`; Next.js is the
exception, loading env only from `apps/web`, so give the web app the same values
there (a symlink, a copy, or `pnpm dev` from the root, which passes them through):

```powershell
pnpm --filter @montaj/api dev
pnpm --filter @montaj/worker-media dev
pnpm --filter @montaj/render dev
pnpm --filter @montaj/web dev
pnpm --filter @montaj/worker-ai dev
```

Running a second checkout at the same time? Give it its own `WORKER_AI_PORT` (the
default control port is 8091) and its own `MONTAJ_QUEUE_PREFIX`, or the two workers
fight over the port and consume each other's jobs. `docs/models/LOCAL-MODELS.md`
carries the same guidance for the model services.

The compact alternative is `pnpm dev`, after the one-time package build. Check
`/health` on the API, open the web origin, create an account, and sign in without
an email click. `node scripts/local-ai-smoke.mjs` exercises the local media/ASR
path; `pnpm --filter @montaj/prompts eval:local` exercises Ollama and skips with
exit 0 when Ollama is not reachable.

## 7. Intentionally unavailable in free-stack mode

- Google OAuth. Email/password and magic-link mechanics remain, but a magic link
  still needs a human to retrieve it from the development outbox unless dev
  auto-verification is used for a fresh password sign-up.
- Razorpay checkout, top-ups, mandates, renewals and new paid subscriptions.
  Credits are granted through the audited admin action instead. Historical
  billing records remain readable if the database already contains them.
- Sarvam, ElevenLabs and AssemblyAI speech services. Transcription uses local
  Whisper; features requiring a specific vendor response do not silently call a
  paid service. Expect a real quality drop rather than parity: the local `small`
  weight on CPU is materially less accurate than the vendor ASR it replaces,
  most visibly on Indian-language and code-mixed audio, which is exactly the
  material this product targets. Judge caption quality on a paid provider before
  concluding the pipeline is at fault.
- Hosted Anthropic/OpenAI generation and paid serverless GPU routing. Ollama and
  the local CPU path are used instead, with the small-model quality limitations
  documented in section 1.

The development outbox, fake billing provider and mock LLM remain test/dev
facilities; they are not substitutes for production delivery or settlement.
