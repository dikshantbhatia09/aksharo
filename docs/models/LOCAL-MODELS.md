# Local AI models (M15)

Every model weight this monorepo can use is fetched from its publisher, kept
**outside the repo**, and never committed. This is the H-22 licence-table
input: source URL, version/commit, licence and SHA-256 for each weight
provisioned on this machine, plus the exact `.env` variables and start
commands to reproduce it on another Windows dev box.

Weights live in `05-build/_models/` (sibling to `05-build/montaj`, outside
every worktree, so every WP shares one copy instead of downloading its own).
Total on-disk size: **~3.1 GB** (well under the 6 GB budget).

## 0. Whisper-Hindi2Hinglish-Apex (faster-whisper / CTranslate2, GPU)

- **Purpose**: the `local-whisper` provider's default weight
  (`apps/worker-ai/worker_ai/providers/local_whisper.py`) on this deployment,
  replacing stock Whisper `small` on CPU. Generic Whisper — any size — is
  well-documented to struggle on Hindi-English code-switched speech
  specifically (loanwords mis-spelled in Devanagari, no romanised-output
  option, degraded accuracy at language boundaries); this fine-tune outputs
  Hinglish (Latin script) directly and was trained on noisy, Indian-accented
  audio, which is what this product's real traffic actually is (see the
  domain vocabulary this replaced, `git log -p` on this file's history).
  Chosen after comparing published benchmarks against stock `large-v3` and
  against AI4Bharat/vasista22's pure-Hindi (Devanagari-output, not
  code-switch-trained) fine-tunes — see the session's memory note on the
  Hinglish transcription investigation for the comparison.
- **Source**: `https://huggingface.co/Oriserve/Whisper-Hindi2Hinglish-Apex`
  (a fine-tune of `openai/whisper-large-v3`), converted to CTranslate2 with
  `python -m ctranslate2.converters.transformers --model
  Oriserve/Whisper-Hindi2Hinglish-Apex --quantization int8_float16
  --copy_files preprocessor_config.json tokenizer_config.json` plus a
  hand-copied `tokenizer.json` (see "Local path" below) so the local
  directory needs no network access at load time — CTranslate2's converter
  does not fetch it, and without it `faster-whisper` silently falls back to
  downloading `openai/whisper-tiny`'s tokenizer (byte-identical vocabulary
  across every Whisper size, so this is harmless *except* for the added
  network dependency and ~30 s latency it costs the first load).
- **Version**: HF revision `f3214eed20b4e4d4144e739982d911f87b9cb223`.
- **Licence**: Apache-2.0 (Oriserve).
- **Local path**: `_models/whisper-hindi2hinglish-apex-ct2-int8/` (`config.json`,
  `model.bin`, `vocabulary.json`, `tokenizer.json`, `tokenizer_config.json`,
  `preprocessor_config.json`).
- **Size**: 782 MB (`model.bin` is 814,054,531 bytes, int8_float16).
- **SHA-256** (`model.bin`):
  `834c6a9417cfab2417752dfc160998e3c77dad7f1f77f65f4a31ec8f3c13c472`
- **Runs on GPU here**: this host has an NVIDIA GeForce RTX 2060 (6 GB VRAM),
  previously unused by `local-whisper` — the adapter defaulted to
  `device="cpu"` unconditionally with no setting to override it. CTranslate2's
  Windows wheel needs `nvidia-cublas-cu12`/`nvidia-cudnn-cu12` (`pip install`,
  no CUDA Toolkit installer needed) on `PATH` — not merely registered via
  `os.add_dll_directory`, which does not reach a `LoadLibrary` call a compiled
  extension issues internally; `local_whisper.py`'s
  `_ensure_cuda_libraries_on_path()` does this automatically and is a no-op
  where the packages are absent. `WORKER_AI_WHISPER_DEVICE=auto` (the default)
  probes for a working GPU and falls back to CPU rather than failing a job.

## 1. Whisper `small` (faster-whisper / CTranslate2)

- **Purpose**: self-hosted ASR — the `local-whisper` provider
  (`apps/worker-ai/worker_ai/providers/local_whisper.py`), CPU int8.
- **Source**: `https://huggingface.co/Systran/faster-whisper-small`
  (the CTranslate2 conversion `faster-whisper` downloads automatically;
  fetched here via the shared Hugging Face cache and copied into `_models/`
  for the pinned, offline copy below).
- **Version**: HF revision `536b0662742c02347bc0e980a01041f333bce120`.
- **Licence**: MIT (Whisper weights, OpenAI; this CTranslate2 conversion by
  Systran, also MIT).
- **Local path**: `_models/whisper-small/` (`config.json`, `model.bin`,
  `tokenizer.json`, `vocabulary.txt`).
- **Size**: 464 MB (`model.bin` is 483,546,902 bytes).
- **SHA-256** (`model.bin`):
  `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`

`faster-whisper` resolves the model by name through its own Hugging Face
cache (`~/.cache/huggingface`, not `_models/`) — `_models/whisper-small/` is
the pinned, checksummed copy this doc accounts for; set `HF_HOME` to
`05-build/_models/hf-cache` if you want faster-whisper to read from inside
`_models/` directly instead of the user-wide HF cache.

## 2. DeepFilterNet3 (ONNX export)

- **Purpose**: audio-clean denoise. `apps/worker-ai/worker_ai/clean/dsp.py`
  still runs the pure-numpy spectral-gate stand-in in production passes;
  `apps/worker-ai/worker_ai/clean/deepfilternet3.py` (new, M15) loads and
  runs the three real ONNX graphs end to end as a provisioning/loader proof
  — see "Scope note" below.
- **Source**:
  `https://github.com/Rikorose/DeepFilterNet/raw/main/models/DeepFilterNet3_onnx.tar.gz`
  (redirects to `raw.githubusercontent.com`).
- **Version**: archive timestamped 2023-05-23 (`DeepFilterNet3_onnx.tar`
  gzip member mtime); this is the `main`-branch published ONNX export, no
  pinned release tag upstream.
- **Licence**: MIT (Rikorose/DeepFilterNet).
- **Local path**: `_models/deepfilternet3/` (`enc.onnx`, `erb_dec.onnx`,
  `df_dec.onnx`, `config.ini`; the original `DeepFilterNet3_onnx.tar.gz` is
  kept alongside for provenance).
- **Size**: 7.98 MB archive; 8.5 MB extracted.
- **SHA-256**:
  - `DeepFilterNet3_onnx.tar.gz`:
    `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616`
  - `enc.onnx`: `7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916`
  - `erb_dec.onnx`: `ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895`
  - `df_dec.onnx`: `23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a`
  - `config.ini`: `415eb925d44990d938fb739f514aa3662c1ec0ea836cff044fa1291b82cb4290`

**Scope note**: a bit-accurate DeepFilterNet3 forward pass needs the same ERB
filterbank and deep-filtering synthesis the upstream Rust `libdf` crate
implements; reimplementing that DSP pipeline is out of this work package's
scope. `DeepFilterNet3Onnx.smoke_run()` proves the three graphs load through
`onnxruntime` and execute a real forward pass chained the way the export
graph chains them (`enc` → `{erb_dec, df_dec}`) — the "loads through the
model-manager code with a fixture" bar the brief asks for — without claiming
production denoise quality.

## 3. YuNet (OpenCV Zoo, ONNX)

- **Purpose**: face/subject detection for the reframe/zoom passes.
  `apps/worker-ai/worker_ai/passes/tracking.py`'s `YuNetDetector` (new, M15)
  wraps `cv2.FaceDetectorYN`; `BrightBlobDetector` remains the OpenCV-free
  stand-in the synthetic tracking tests use.
- **Source**:
  `https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`
  (Git LFS object; resolved via `media.githubusercontent.com`).
- **Version**: `2023mar` release, `main` branch as of 2026-09-03.
- **Licence**: Apache-2.0 (OpenCV Zoo).
- **Local path**: `_models/yunet/face_detection_yunet_2023mar.onnx`.
- **Size**: 232,589 bytes (227 KB).
- **SHA-256**:
  `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
  (matches the file's Git LFS pointer `oid` exactly).

## 4. CLAP (LAION, `630k-audioset-best`)

- **Purpose**: audio embeddings for retrieval/SFX matching (D04a).
  `apps/worker-ai/worker_ai/audio_embed/__init__.py`'s `ClapEmbedder` was
  already fully implemented against `laion_clap`; this WP provisioned the
  checkpoint and proved it loads and embeds real audio.
- **Source**: `https://huggingface.co/lukewys/laion_clap`, file
  `630k-audioset-best.pt`.
- **Version**: the `630k-audioset-best` checkpoint (trained on AudioSet,
  630k pairs) — LAION's general-purpose default, not the music- or
  fusion-specialised variants.
- **Licence**: Apache-2.0 (LAION-CLAP).
- **Local path**: `_models/clap/630k-audioset-best.pt`.
- **Size**: 1,863,587,645 bytes (1.86 GB).
- **SHA-256**:
  `8053c9775516af2f4902e1e8281e356cc1bf7a85e8b761908170767b77c3f037`

**Torch compatibility note**: `laion_clap.load_ckpt` calls `torch.load` with
torch's default `weights_only`, which torch >= 2.6 changed to `True` — this
rejects the numpy-scalar globals pickled into LAION's 2023-era checkpoint.
`ClapEmbedder.__init__` narrowly patches `torch.load` to
`weights_only=False` for the scope of that one call (see the comment at
`worker_ai/audio_embed/__init__.py:104`) since `CLAP_MODEL_PATH` is always an
operator-provisioned local file, never attacker input.

## `.env` additions

Add to `_worktrees/main/.env` (variable names only — no secrets, these are
local filesystem paths):

```
# apps/worker-ai — local model weights (05-build/_models/, never committed)
CLAP_MODEL_PATH=C:\Dikshant\Crest Mond\Product 2\05-build\_models\clap\630k-audioset-best.pt
YUNET_MODEL_PATH=C:\Dikshant\Crest Mond\Product 2\05-build\_models\yunet\face_detection_yunet_2023mar.onnx
DEEPFILTERNET_MODEL_DIR=C:\Dikshant\Crest Mond\Product 2\05-build\_models\deepfilternet3
WORKER_AI_WHISPER_MODEL=C:\Dikshant\Crest Mond\Product 2\05-build\_models\whisper-hindi2hinglish-apex-ct2-int8
WORKER_AI_WHISPER_ENGINE=faster-whisper
```

`WORKER_AI_WHISPER_MODEL` also accepts a plain size name (`small`, `large-v3`,
…) instead of a local directory — `faster-whisper`/`openai-whisper` then
resolve it through the Hugging Face cache as before. `WORKER_AI_WHISPER_DEVICE`
(default `auto`) and `WORKER_AI_WHISPER_COMPUTE_TYPE` (default: an
device-appropriate pick) are documented in `apps/worker-ai/README.md`'s
configuration table.

`local-whisper` needs no path variable: `faster-whisper` resolves `small` by
name through its own (Hugging Face) cache once the `local-asr` extra is
installed — see "Install" below. `WORKER_AI_WHISPER_MODEL` only overrides
which named model it asks for (`Settings.whisper_model`,
`apps/worker-ai/worker_ai/settings.py:231`).

None of these four variables are read as ASR-routing toggles — `local-whisper`
becomes usable automatically once `faster-whisper` is importable (registry
`unmet` check, `apps/worker-ai/worker_ai/providers/registry.py:274`), and the
routing table (`worker_ai/routing.yaml`) now lists it as the last-resort
candidate on the Hindi, Hinglish, Indian-English and global lanes.

## Install (Windows, from a worktree)

```powershell
cd apps\worker-ai
pnpm setup                                  # creates .venv, installs the pinned lock
.\.venv\Scripts\python.exe -m pip install "faster-whisper==1.2.1"
.\.venv\Scripts\python.exe -m pip install "opencv-python-headless==4.10.0.84"
.\.venv\Scripts\python.exe -m pip install --no-deps "laion-clap==1.1.6"
.\.venv\Scripts\python.exe -m pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cpu
.\.venv\Scripts\python.exe -m pip install librosa transformers torchlibrosa ftfy braceexpand webdataset wget h5py pandas progressbar
```

GPU execution for `faster-whisper` (needs no CUDA Toolkit installer — the pip
packages carry the runtime DLLs; `local_whisper.py` puts them on `PATH` at
load time):

```powershell
.\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

Converting a Hugging Face checkpoint (any Whisper-architecture fine-tune,
official or community) to a local CTranslate2 directory — a one-time step;
`transformers` is needed only for the conversion, never at runtime:

```powershell
.\.venv\Scripts\python.exe -m pip install transformers safetensors accelerate
.\.venv\Scripts\python.exe -m ctranslate2.converters.transformers `
  --model <hf-repo-id> --output_dir <local-dir> --quantization int8_float16 `
  --copy_files preprocessor_config.json tokenizer_config.json
# tokenizer.json is not fetched by the converter; copy it by hand or the
# first load fetches openai/whisper-tiny's (byte-identical, ~30 s, one-time
# network dependency this deployment avoids by shipping it locally):
.\.venv\Scripts\python.exe -c "from huggingface_hub import hf_hub_download; print(hf_hub_download('<hf-repo-id>', 'tokenizer.json'))"
# then copy the printed path's file into <local-dir>/tokenizer.json
```

`laion-clap`'s declared dependency `numpy==1.23.5` has no Python 3.12 wheel
and fails to build from source on this toolchain (`pkgutil.ImpImporter` was
removed in 3.12) — install it `--no-deps` and let the already-installed
`numpy==2.5.2` (this repo's pin) serve instead; the rest of its real runtime
dependencies (torch stack, librosa, transformers, …) are installed
separately above. `pyproject.toml`'s `local-clap` and `local-vision` extras
document the two lighter dependencies (`laion-clap`, `opencv-python-headless`)
as optional installs; the CLAP transformer stack (`torch`+`transformers`+…)
is deliberately not pinned as a single extra here since it is ~2.5 GB of
packages most worker-ai tasks never need.

## Start commands

Build the internal packages once first (`pnpm dev` does not build workspace
package dependencies for you — a fresh worktree's `apps/api`/`worker-media`/
`render` fail to resolve `@montaj/config`, `@montaj/edg`, `@montaj/render-
manifest` etc. until this has run once):

```powershell
pnpm --filter "./packages/*" build
```

Then, each in its own terminal (or backgrounded), from the repo root unless
noted — every process below picks up this worktree's `.env` on its own
(`loadRepoDotenv`/`--env-file` walk up from cwd to find it; see each app's
own `dev`/`start` script):

```powershell
pnpm --filter @montaj/api dev            # http://127.0.0.1:<API_PORT>
pnpm --filter @montaj/worker-media dev
pnpm --filter @montaj/render dev
pnpm --filter @montaj/web dev            # http://127.0.0.1:<WEB_PORT>

# worker-ai: give it its own WORKER_AI_PORT so multiple worktrees' control
# apps don't fight over 8091.
cd apps\worker-ai
$env:WORKER_AI_PORT = "8095"
node scripts/py.mjs -m worker_ai --env-file=../../.env
```

First run only, once the API is up and `montaj_<wp>` is migrated:

```powershell
cd apps\api
pnpm db:seed          # plans + system styles + feature flags; POST /projects/sample
                       # answers 503 workspace/plans_missing without this.
```

`MAIL_PROVIDER=dev` must be in `.env` (not just `.env.example`) — with it
unset, `@montaj/config` defaults to `"dev"` for the app itself, but add it
explicitly if you rely on the default in your own tooling; a
`local-ai-smoke.mjs` run reads verification tokens out of the Redis dev
outbox (`<MONTAJ_REDIS_PREFIX>:auth:dev-outbox`) that only that mode writes.

## Verifying a weight loads (skips cleanly when absent)

```powershell
cd apps\worker-ai
$env:CLAP_MODEL_PATH = "...\_models\clap\630k-audioset-best.pt"
$env:YUNET_MODEL_PATH = "...\_models\yunet\face_detection_yunet_2023mar.onnx"
$env:DEEPFILTERNET_MODEL_DIR = "...\_models\deepfilternet3"
.\.venv\Scripts\python.exe -m pytest -q tests -m slow
```

On a machine with none of these set, the same command skips all three real-
model tests (`test_audio_embed.py`, `test_deepfilternet3.py`,
`test_tracking.py`) with a message naming the missing variable — never a
failure.

## Real end-to-end smoke test

`scripts/local-ai-smoke.mjs` (repo root, plain `node`, no dependencies of its
own — it shells out to `docker exec psql`/`redis-cli` against the shared
compose stack rather than adding `pg`/`ioredis`) reproduces a full local run:
sign-up, email verification via the dev outbox, a credits grant, the bundled
sample project (real `welcome.wav`, real `media.probe`/`media.proxy`), a real
transcription (routed to `local-whisper` since no vendor ASR key is set),
the first caption segment(s) printed, and a real SRT export.

```powershell
node scripts/local-ai-smoke.mjs
```

Requires: the compose stack (`montaj-postgres`, `montaj-redis`, `montaj-
minio`) up, `montaj_<wp>` migrated and seeded (`pnpm --filter @montaj/api
db:seed`), and the API + worker-media + render + worker-ai processes running
against this worktree's `.env` (see "Start commands" above). Prints per-step
timings and exits non-zero on any failure.
