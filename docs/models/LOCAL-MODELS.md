# Local AI models (M15)

Every model weight this monorepo can use is fetched from its publisher, kept
**outside the repo**, and never committed. This is the H-22 licence-table
input: source URL, version/commit, licence and SHA-256 for each weight
provisioned on this machine, plus the exact `.env` variables and start
commands to reproduce it on another Windows dev box.

Weights live in `05-build/_models/` (sibling to `05-build/montaj`, outside
every worktree, so every WP shares one copy instead of downloading its own).
Total on-disk size: **~2.3 GB** (well under the 6 GB budget).

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
WORKER_AI_WHISPER_MODEL=small
```

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

```powershell
# from apps/worker-ai, once .venv is set up and the .env vars above are set
pnpm dev              # runs the worker (node scripts/py.mjs -m worker_ai)

# from the repo root — the rest of the stack
pnpm --filter @montaj/api dev
pnpm --filter @montaj/web dev
pnpm --filter @montaj/worker-media dev
pnpm --filter @montaj/render dev
```

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
