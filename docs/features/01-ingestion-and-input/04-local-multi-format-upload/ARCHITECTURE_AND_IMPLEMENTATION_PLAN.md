# Feature Blueprint: Local Multi-Format Resumable Upload (Up to 10 GB)

**Domain:** Pillar 1 — Ingestion & Input Engine  
**Functionality:** 04 — Local Multi-Format Resumable Upload  
**Path:** `docs/features/01-ingestion-and-input/04-local-multi-format-upload/`  
**Status:** Approved Architectural Specification & Engineering Plan  

---

## 1. Feature Overview & Requirements

Creators film videos on smartphones, mirrorless cameras (Sony, Canon, Blackmagic), and screen recorders (OBS, QuickTime), yielding diverse containers (MP4, MOV, WEBM, MKV, AVI) and audio formats (WAV, M4A, MP3, AAC, FLAC). Files frequently range from 500 MB to 10 GB.

The **Local Multi-Format Resumable Upload** engine enables direct client-to-storage multipart uploads with chunk-level resumption, network jitter recovery, real-time progress indicators, and instant validation.

### Core User Stories
1. **Direct-to-Storage Resumable Upload:** As a creator on unstable WiFi, if my 4 GB video upload drops at 75%, I want it to automatically resume from 75% when my connection recovers.
2. **Support for Pro Codecs & Containers:** As a filmmaker, I want to upload Apple ProRes 422 MOV files, MKV recordings from OBS, and WEBM screen captures without seeing "unsupported format" errors.
3. **Audio-Only Mode:** As a podcaster with only a WAV or MP3 recording, I want to upload audio and have Aksharo generate dynamic visual audiograms and shorts automatically.

### Key Performance SLAs
- Upload start latency (presigned URL generation): $\le 250\text{ ms}$.
- Resumption time after network recovery: $\le 1.0\text{ s}$.
- API Gateway memory overhead: $0\text{ MB}$ (zero proxying of file payloads through API process).

---

## 2. Competitor Forensic Reverse-Engineering

### 2.1 How Market Leaders (Opus Clip, Descript, Submagic) Build It
1. **Opus Clip & Submagic:**
   - **TUS Protocol / S3 Presigned Multipart Upload:** Never upload files through their web application servers.
   - Frontend splits the file into fixed chunks (typically 10 MB or 16 MB).
   - Frontend requests presigned URLs in batches:
     `POST /api/upload/initiate -> { uploadId, key, partUrls: ["https://s3...part=1", ...] }`.
   - Browser uses `fetch` or `XMLHttpRequest` with `PUT` directly to S3/Cloudflare R2.
   - Browser stores `{ uploadId, key, uploadedParts: [...] }` in `localStorage` or `IndexedDB`. If the browser tab is closed and reopened, the upload resumes seamlessly.
   - Once all parts succeed:
     `POST /api/upload/complete -> calls S3 CompleteMultipartUpload`.

2. **Common Competitor Edge Cases Handled:**
   - Files with Variable Frame Rates (VFR) from smartphones causing audio drift during editing.
   - MOV files encoded with Apple ProRes 422 HQ consuming massive storage if not transcoded to a 720p H.264 proxy immediately upon ingestion.
   - MKV files with multiple audio streams or corrupted container headers.

---

## 3. Current Aksharo Baseline & Gap Audit

### 3.1 Existing Repository Assets
- `apps/api/src/media`: Basic upload endpoints exist.
- `apps/worker-media/src/processors/probe.ts`: Probes video width, height, duration, and codecs using `ffprobe`.
- `apps/worker-media/src/processors/proxy.ts`: Transcodes source videos into 720p H.264 proxies.

### 3.2 Current Gaps & Architectural Deficiencies
1. **Lack of Browser Direct-to-S3 Multipart Pipeline:** Current upload paths in parts of the app route files through the API server, creating bottlenecking and 413 "Payload Too Large" errors under high concurrency.
2. **No Resumable Client State Persistence:** The web frontend lacks an IndexedDB-backed upload queue that can survive browser refreshes.
3. **VFR (Variable Frame Rate) Normalization:** Aksharo lacks automated VFR-to-CFR (Constant Frame Rate) detection and flag injection (`-vsync cfr`) during mezzanine proxy extraction.

---

## 4. Target System Architecture & Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor User as Creator Browser
    participant Web as Next.js Web (IndexedDB Upload Client)
    participant API as NestJS API Gateway
    participant S3 as MinIO / Cloudflare R2 / AWS S3
    participant MediaWorker as worker-media (Probe & Proxy)

    User->>Web: Drops 6 GB MOV / MP4 / WAV file
    Web->>Web: Slice into 16MB Chunks; Calculate file hash
    Web->>API: POST /api/v1/media/upload/initiate { fileName, fileSizeBytes, mimeType }
    API->>S3: CreateMultipartUploadCommand
    API-->>Web: Return { uploadId, s3Key, chunkSize: 16777216 }
    
    loop For Each 16MB Chunk (4 parallel streams)
        Web->>API: POST /api/v1/media/upload/part-url { uploadId, s3Key, partNumber }
        API-->>Web: Return signed PUT URL
        Web->>S3: HTTP PUT Chunk to Signed URL
        Web->>Web: Record ETag in IndexedDB
    end

    Web->>API: POST /api/v1/media/upload/complete { uploadId, s3Key, parts: [{ PartNumber, ETag }] }
    API->>S3: CompleteMultipartUploadCommand
    API->>MediaWorker: Enqueue media.probe & media.proxy
    API-->>Web: Upload complete! Switch to processing state
```

### 4.1 Schema Additions (`packages/db/prisma/schema.prisma`)
```prisma
model MediaUploadSession {
  id            String    @id @default(uuid())
  workspaceId   String
  uploadId      String    // S3 Multipart Upload ID
  s3Key         String
  fileName      String
  fileSizeBytes BigInt
  mimeType      String
  chunkSizeBytes Int      @default(16777216) // 16MB
  totalParts    Int
  completedParts Int      @default(0)
  status        String    @default("UPLOADING") // UPLOADING, COMPLETED, ABORTED, EXPIRED
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  
  workspace     Workspace @relation(fields: [workspaceId], references: [id], onDelete: Cascade)
}
```

---

## 5. Step-by-Step Engineering Implementation Plan

### Step 1: Implement S3 Multipart Orchestrator in `apps/api`
- Create `apps/api/src/media/multipart-upload.service.ts`:
  - `initiateUpload(workspaceId, dto)`: Calls `CreateMultipartUploadCommand` on S3 client, records `MediaUploadSession`.
  - `signPartUrl(uploadId, s3Key, partNumber)`: Calls `getSignedUrl(s3Client, new UploadPartCommand(...), { expiresIn: 3600 })`.
  - `completeUpload(uploadId, s3Key, parts)`: Calls `CompleteMultipartUploadCommand`, updates session status to `COMPLETED`.
  - `abortUpload(uploadId, s3Key)`: Cleans up orphaned parts on S3.

### Step 2: Build IndexedDB Resumable Upload Client in `apps/web`
- Create `apps/web/lib/upload/resumable-uploader.ts`:
  - Uses native `Blob.slice()` to generate 16 MB chunks.
  - Concurrency limiter maintaining 4 active parallel uploads via `p-limit`.
  - Automatic retry on 5xx or network disconnects with exponential jitter (1s, 2s, 4s, 8s).
  - Persists progress in `idb` (IndexedDB) with session restoration upon page reload.

### Step 3: Implement VFR to CFR Normalization in `worker-media`
- In `apps/worker-media/src/processors/proxy.ts`:
  - Check `ffprobe` output for `r_frame_rate != avg_frame_rate`.
  - If VFR is detected, inject `-fps_mode cfr` or `-vsync cfr` into FFmpeg proxy transcode to prevent audio/video synchronization drift during editing.

### Step 4: Automated Testing Suite
- Unit test: Multipart chunk boundary calculations and part signature generation.
- Integration test: Complete upload lifecycle with mock S3 endpoint, simulating network interruption and chunk resumption.

