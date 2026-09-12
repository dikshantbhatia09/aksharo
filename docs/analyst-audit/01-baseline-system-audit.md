# Analyst System Audit — Baseline Issues & Root Cause Resolutions

## Purpose
This document logs the continuous analyst-driven audit of the Kalakar platform stack, tracking baseline failures, root causes, architectural invariants, and applied resolutions.

---

## Audit Item 1: Browser Network Connectivity (Authentication)
* **Symptom**: "We could not reach the server. Check your connection and try again" on `/login`.
* **Root Cause**: Web container rendered `apiOrigin: http://api:3001` to browser client components. `api` is a Docker network alias unresolvable by the host operating system's browser.
* **Resolution**: Introduced `BROWSER_API_ORIGIN: http://localhost:3001` in runtime config and docker compose to separate server-side rendering (SSR) routes from client browser API calls. Scoped CORS to permit `http://localhost:3000`.

---

## Audit Item 2: Media Upload Network Error ("part 1: network error")
* **Symptom**: Dropping or selecting media in the upload modal produced "The upload failed — part 1: network error".
* **Root Cause**:
  1. API presigned upload URLs targeted internal `http://minio:9000/...` because `S3_PUBLIC_ENDPOINT` was unset.
  2. AWS SigV4 signed headers calculated against `Host: minio:9000` rather than the host's actual port.
  3. MinIO port was mapped to 59000 rather than 9000.
  4. Content Security Policy lacked `http://localhost:9000` and enforced `upgrade-insecure-requests`, converting local HTTP XHRs to HTTPS.
* **Resolution**:
  - Mapped MinIO to standard `9000` (API) and `9001` (Console).
  - Configured `S3_PUBLIC_ENDPOINT: http://localhost:9000` and `R2_PUBLIC_ENDPOINT: http://localhost:9000` in API environment and compose.
  - Enabled MinIO CORS (`MINIO_API_CORS_ALLOW_ORIGIN: "*"`).
  - Updated web CSP headers to permit `http://localhost:9000` across `connect-src`, `img-src`, and `media-src`.

---

## Audit Item 3: AI Worker Storage Unconfigured (`ai.transcribe` failure)
* **Symptom**: `ai.transcribe` jobs immediately failed with `worker/storage_unconfigured`.
* **Root Cause**: `worker-ai` service in `docker-compose.test.yml` lacked `R2_ENDPOINT`, `R2_BUCKET_DERIVED`, and R2/S3 credentials. When downloading extracted `audio16k.wav` for speech-to-text, Python processor threw `JobFailureError("worker/storage_unconfigured")`.
* **Resolution**: Inherited `<<: *api-env` in `worker-ai` service definition in `docker-compose.test.yml`, giving it identical datastore/MinIO credentials as `worker-media` and `render`.

---

## Audit Item 4: Project Stall on "Analyzing your media"
* **Symptom**: Screen remains indefinitely on "Analyzing your media — Transcription starts by itself as soon as the media is ready".
* **Root Causes**:
  1. If a media upload was interrupted or previously failed, `media_assets.status` remained `"uploading"`. The read-model endpoint `/projects/{id}/transcription-state` treated any non-ready media as `processing_media`, narrating it indefinitely without timeout or error.
  2. If media completed probing and proxying (`status: "ready"`), but the project lacked `sourceLanguage`, `AutoTranscribeTrigger` deliberately held off on auto-transcribing. The read-model transitioned to `awaiting_language` (asking the user to choose language).
