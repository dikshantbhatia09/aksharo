# Feature Blueprint: Subtitle File Export Engine (SRT, VTT, ASS, Remotion JSON)

**Domain:** Pillar 4 — Kinetic Captions & Multilingual Typography  
**Functionality:** 10 — Subtitle File Exports  
**Path:** `docs/features/04-kinetic-captions-and-typography/10-subtitle-file-exports/`  
**Status:** Approved Architectural Specification & Engineering Plan  

---

## 1. Feature Overview & Requirements

While many creators render final burned-in video shorts directly in Aksharo, professional video editors working in Adobe Premiere Pro, DaVinci Resolve, and Final Cut Pro require raw subtitle files to continue editing on their NLE timelines. Furthermore, uploading separate subtitle files to YouTube Studio boosts SEO and accessibility.

The **Subtitle File Export Engine**:
1. Instantly compiles transcript data into industry-standard subtitle formats:
   - **SRT (SubRip):** Universal format for video editing timelines and YouTube closed captions.
   - **VTT (WebVTT):** Web standard for HTML5 `<track>` video players.
   - **ASS (Advanced SubStation Alpha):** Rich typography format preserving exact font families, colors, strokes, and karaoke timing tags (`{\k...}`).
   - **Remotion / Timeline JSON:** Structured JSON for developers and automated workflows.
2. Generates and downloads files in $< 200\text{ ms}$ without requiring a video re-render.

### Core User Stories
1. **NLE Timeline Import:** As a Premiere Pro editor, I want to download an SRT or ASS file so I can drop the subtitles straight onto my timeline.
2. **Styled ASS Burn-In:** As an engineer running headless FFmpeg pipelines, I want an ASS subtitle file with embedded font and stroke styles so FFmpeg can burn in captions at $10\times$ realtime speed.

### Key Performance SLAs
- Subtitle file generation latency: $\le 150\text{ ms}$.
- Spec compliance: $100.0\%$ validation against SubRip, WebVTT, and ASS v4.00+ specifications.

---

## 2. Competitor Forensic Reverse-Engineering

### 2.1 How Descript & Submagic Build It
1. **Descript & Submagic:**
   - Both offer a *"Download Subtitles"* dropdown with format choices: `[SRT, VTT, ASS, TXT]`.
   - **ASS Exporter Format:**
     - Includes `[Script Info]` with `PlayResX: 1080`, `PlayResY: 1920`.
     - Defines `[V4+ Styles]` matching the project's active `StyleDoc` (Fontname, Fontsize, PrimaryColour, OutlineColour, Outline, Shadow, Alignment).
     - Renders `[Events]` using karaoke `\k` tags for word-level sync:
       `Dialogue: 0,0:00:01.20,0:00:03.50,Hormozi,,0,0,0,,{\k35}This {\k40}is {\k50}viral!`

---

## 3. Current Aksharo Baseline & Gap Audit

### 3.1 Existing Repository Assets
- `packages/ass-exporter`:
  - Dedicated package in `packages/ass-exporter` for generating ASS subtitle files!
- `apps/api/src/transcripts`:
  - Contains transcript retrieval endpoints.

### 3.2 Gaps
1. **No SRT / VTT Exporter in API:** While `packages/ass-exporter` exists for internal rendering, the API lacks dedicated public download endpoints for `.srt`, `.vtt`, and `.json`.
2. **Missing UI Export Buttons:** In `apps/web`, there is no *"Download Subtitles"* menu button in the project dashboard.

---

## 4. Target System Architecture & Data Flow

```mermaid
sequenceDiagram
    autonumber
    actor Editor as User
    participant Web as Next.js Web App
    participant API as NestJS API (/api/v1/transcripts/:id/export)
    participant Exporter as Subtitle Serializer Engine
    participant DB as PostgreSQL (Transcript Model)

    Editor->>Web: Clicks "Download Subtitles" -> Selects "ASS / SRT / VTT"
    Web->>API: GET /api/v1/transcripts/:id/export?format=srt
    API->>DB: Fetch Transcript lines and words
    API->>Exporter: Serialize to requested format (SRT / VTT / ASS / JSON)
    Exporter-->>API: Generated text string buffer
    API-->>Web: HTTP 200 with Content-Disposition: attachment; filename="clip.srt"
    Web->>Editor: Instant browser file download (< 200ms)
```

### 4.1 Sample SRT Formatter Implementation
```typescript
export function formatSRT(lines: readonly CaptionLine[]): string {
  return lines
    .map((line, index) => {
      const start = formatTimestampSRT(line.startSec);
      const end = formatTimestampSRT(line.endSec);
      return `${index + 1}\n${start} --> ${end}\n${line.text}\n`;
    })
    .join('\n');
}

function formatTimestampSRT(sec: number): string {
  const h = Math.floor(sec / 3600).toString().padStart(2, '0');
  const m = Math.floor((sec % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
  return `${h}:${m}:${s},${ms}`;
}
```

---

## 5. Step-by-Step Engineering Implementation Plan

### Step 1: Implement Universal Subtitle Serializer
- In `packages/shared/src/subtitles/serializer.ts`:
  - Add `exportToSRT(lines)`.
  - Add `exportToVTT(lines)`.
  - Add `exportToASS(lines, styleDoc)` (leveraging `packages/ass-exporter`).
  - Add `exportToJSON(lines, words)`.

### Step 2: Implement Export Controller in `apps/api`
- In `apps/api/src/transcripts/transcripts.controller.ts`:
  - Add `@Get(':id/export')`:
    - Reads query param `format` (`srt`, `vtt`, `ass`, `json`).
    - Sets appropriate `Content-Type` header (`text/plain`, `text/vtt`, etc.).
    - Streams response with attachment filename.

### Step 3: Add Subtitle Export Dropdown in `apps/web`
- In `apps/web/components/editor/export-dropdown.tsx`:
  - Add sub-menu: *"Download Subtitles (*.srt, *.vtt, *.ass)"*.

### Step 4: Automated Testing Suite
- Unit test: Serializer output validated against standard regex specifications for SRT and WebVTT timestamps.

