import { endpoints } from "@montaj/api-client";
import type { ApiClient, Project, UploadTicket } from "@montaj/api-client";

import { hashFile } from "./hash-client";
import { MultipartUpload } from "./multipart-upload";
import { deleteUploadRecord, getUploadRecord, putUploadRecord } from "./store";

import type { CompletedPartRecord, UploadProgressState } from "./multipart-upload";
import type { PersistedUploadRecord, UploadPartTicket } from "./store";
import type { UploadItemState, UploadQuickPick, UploadStatus } from "./types";

/**
 * One file's whole journey: hash it, create its project, upload its parts
 * (resumably, through `MultipartUpload` and `store.ts`), complete it, and try
 * to start transcription with the quick-pick options.
 *
 * A class rather than a hook so the whole flow is testable with a fake
 * `ApiClient` and no React — `use-upload-queue.ts` is the thin hook that owns
 * one of these per file and mirrors its updates into component state.
 */
export interface UploadJobDeps {
  readonly client: ApiClient;
  readonly file: File;
  readonly quickPick: UploadQuickPick;
  /** A stable id assigned before anything else — the IndexedDB resume key. */
  readonly localId: string;
  readonly onUpdate: (state: UploadItemState) => void;
  /** Batch: skip `POST /projects` and upload straight into this project (B15). */
  readonly existingProjectId?: string;
  /** Injected for tests; defaults to the real streaming hash + IndexedDB. */
  readonly hashFileFn?: typeof hashFile;
  readonly putRecord?: typeof putUploadRecord;
  readonly deleteRecord?: typeof deleteUploadRecord;
  /** 3 in production; a test drops this to make interleaving deterministic. */
  readonly concurrency?: number;
  /** Passed through to `MultipartUpload`; a test fakes the transport here. */
  readonly xhrFactory?: ConstructorParameters<typeof MultipartUpload>[0]["xhrFactory"];
  readonly setTimeoutFn?: ConstructorParameters<typeof MultipartUpload>[0]["setTimeoutFn"];
}

const NO_PROGRESS: UploadProgressState = {
  uploadedBytes: 0,
  totalBytes: 0,
  completedParts: 0,
  totalParts: 0,
};

export class UploadJob {
  private status: UploadStatus = "hashing";
  private progress: UploadProgressState = NO_PROGRESS;
  private projectId: string | undefined;
  private mediaId: string | undefined;
  private duplicateOfProjectId: string | undefined;
  private jobId: string | undefined;
  private errorMessage: string | undefined;
  private engine: MultipartUpload | undefined;
  private cancelled = false;
  /** Every part with a confirmed ETag so far, in this run or a resumed one. */
  private completedParts: CompletedPartRecord[] = [];
  /**
   * The most recent `persist()` call, so a caller that needs the database
   * settled first (deleting the record once the upload is done) can await it
   * rather than race an in-flight write from the last part's completion —
   * IndexedDB round trips are not ordered relative to a fire-and-forget call
   * site, only relative to each other.
   */
  private lastPersist: Promise<void> = Promise.resolve();

  private readonly putRecord: typeof putUploadRecord;
  private readonly deleteRecord: typeof deleteUploadRecord;
  private readonly hashFn: typeof hashFile;

  constructor(private readonly deps: UploadJobDeps) {
    this.putRecord = deps.putRecord ?? putUploadRecord;
    this.deleteRecord = deps.deleteRecord ?? deleteUploadRecord;
    this.hashFn = deps.hashFileFn ?? hashFile;
  }

  getState(): UploadItemState {
    return {
      id: this.deps.localId,
      fileName: this.deps.file.name,
      fileSize: this.deps.file.size,
      status: this.status,
      progress: this.progress,
      ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
      ...(this.mediaId === undefined ? {} : { mediaId: this.mediaId }),
      ...(this.duplicateOfProjectId === undefined
        ? {}
        : { duplicateOfProjectId: this.duplicateOfProjectId }),
      ...(this.jobId === undefined ? {} : { jobId: this.jobId }),
      ...(this.errorMessage === undefined ? {} : { error: this.errorMessage }),
    };
  }

  pause(): void {
    this.engine?.pause();
    this.setStatus("paused");
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.setStatus("uploading");
    this.engine?.resume();
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.engine?.cancel();
    this.setStatus("cancelled");
    await this.lastPersist;
    await this.deleteRecord(this.deps.localId);
  }

  /** Start a brand-new upload. */
  async run(): Promise<void> {
    this.setStatus("hashing");
    let contentHash: string;
    try {
      contentHash = await this.hashFn(this.deps.file);
    } catch (error) {
      await this.fail(error);
      return;
    }
    if (this.cancelled) return;

    await this.persist({ status: "hashing", contentHash, createdAt: Date.now() });
    await this.createProjectAndUpload(contentHash);
  }

  /** Continue a record `listResumableUploads()` returned after a reload. */
  async resumeFromRecord(record: PersistedUploadRecord): Promise<void> {
    if (
      record.mediaId === undefined ||
      record.parts === undefined ||
      record.projectId === undefined ||
      record.projectId === ""
    ) {
      // Never made it past `init` last time (or not even past creating the
      // project); the hash is already known, so there is nothing to re-read.
      await this.createProjectAndUpload(record.contentHash ?? "");
      return;
    }
    this.projectId = record.projectId;
    this.mediaId = record.mediaId;
    this.completedParts = [...record.completedParts];
    await this.uploadParts(record.projectId, record.mediaId, {
      mediaId: record.mediaId,
      uploadId: record.uploadId ?? null,
      key: record.storageKey ?? "",
      bucket: record.bucket ?? "s3",
      partSizeBytes: record.partSizeBytes ?? 0,
      parts: [...record.parts],
      expiresAt: null,
      duplicate: false,
      media: {} as UploadTicket["media"],
    });
  }

  private async createProjectAndUpload(contentHash: string): Promise<void> {
    let project: Project;
    if (this.deps.existingProjectId !== undefined) {
      // Batch (B15): the project already exists — `BatchService.create`
      // made it — so this job only has to attach an upload to it.
      project = { id: this.deps.existingProjectId } as Project;
    } else {
      this.setStatus("creating-project");
      const title = titleFromFilename(this.deps.file.name);
      try {
        project = await this.deps.client.call(endpoints.projects.create, {
          body: {
            title,
            aspect: this.deps.quickPick.aspect,
            // FIX-04: omitted rather than guessed. A project created without a
            // language is the server's `awaiting_language` state, which the
            // editor's waiting screen offers a picker for — that is a question,
            // where a wrong tag would have been a charge.
            ...(this.deps.quickPick.language === undefined
              ? {}
              : { sourceLanguage: this.deps.quickPick.language }),
          },
        });
      } catch (error) {
        await this.fail(error);
        return;
      }
      if (this.cancelled) return;
    }
    this.projectId = project.id;
    await this.persist({ status: "uploading", contentHash, projectId: project.id });

    let ticket: UploadTicket;
    try {
      ticket = await this.deps.client.call(endpoints.media.init, {
        params: { projectId: project.id },
        body: {
          filename: this.deps.file.name,
          size: this.deps.file.size,
          mime: this.deps.file.type || "application/octet-stream",
          contentHash,
        },
      });
    } catch (error) {
      await this.fail(error);
      return;
    }
    if (this.cancelled) return;

    if (ticket.duplicate) {
      // The bytes already exist elsewhere in the workspace. A job that
      // created its own project removes it (it has nothing else in it and
      // would only confuse the Recent grid); a batch job's project was
      // created alongside its siblings and stays, empty, for the owner to
      // deal with — removing it would leave a hole in `Batch.projects`.
      this.duplicateOfProjectId = ticket.media.projectId;
      if (this.deps.existingProjectId === undefined) {
        await this.deps.client
          .call(endpoints.projects.remove, { params: { projectId: project.id } })
          .catch(() => undefined);
      }
      await this.lastPersist;
      await this.deleteRecord(this.deps.localId);
      this.mediaId = ticket.mediaId;
      this.setStatus("duplicate");
      return;
    }

    this.mediaId = ticket.mediaId;
    await this.uploadParts(project.id, ticket.mediaId, ticket);
  }

  private async uploadParts(
    projectId: string,
    mediaId: string,
    ticket: UploadTicket,
  ): Promise<void> {
    this.setStatus("uploading");

    const engine = new MultipartUpload({
      file: this.deps.file,
      parts: ticket.parts,
      partSizeBytes: ticket.partSizeBytes,
      concurrency: this.deps.concurrency ?? 3,
      alreadyCompleted: this.completedParts,
      ...(this.deps.xhrFactory === undefined ? {} : { xhrFactory: this.deps.xhrFactory }),
      ...(this.deps.setTimeoutFn === undefined ? {} : { setTimeoutFn: this.deps.setTimeoutFn }),
      onProgress: (progress) => {
        this.progress = progress;
        this.emit();
      },
      onPartCompleted: (part) => {
        if (!this.completedParts.some((done) => done.partNumber === part.partNumber)) {
          this.completedParts = [...this.completedParts, part];
        }
        this.lastPersist = this.persist({
          status: "uploading",
          projectId,
          mediaId,
          uploadId: ticket.uploadId,
          storageKey: ticket.key,
          bucket: ticket.bucket,
          partSizeBytes: ticket.partSizeBytes,
          parts: ticket.parts,
        });
      },
    });
    this.engine = engine;

    let parts: CompletedPartRecord[];
    try {
      parts = await engine.run();
    } catch (error) {
      if (this.cancelled || this.status === "cancelled") return;
      await this.fail(error);
      return;
    }
    if (this.cancelled) return;

    this.setStatus("completing");
    try {
      await this.deps.client.call(endpoints.media.complete, {
        params: { projectId, mediaId },
        body: { etags: parts.map((part) => part.etag) },
      });
    } catch (error) {
      await this.fail(error);
      return;
    }

    await this.tryStartTranscription(projectId);
    await this.lastPersist;
    await this.deleteRecord(this.deps.localId);
  }

  /**
   * Best-effort: the freshly-uploaded media has not been probed yet (that is
   * `media.probe`, enqueued by `complete` above), so the real
   * `POST /projects/{id}/transcribe` (A11) usually answers
   * `transcript/media_not_ready` — a 409 — right here. That is not a
   * failure: the upload already succeeded, the project exists and the media
   * is ready to open. This call is just the eager attempt for the common
   * case where probing has already finished by the time the last part
   * lands; when it has not, the project simply opens without a transcript
   * yet and nothing here needs to retry it.
   */
  private async tryStartTranscription(projectId: string): Promise<void> {
    const language = this.deps.quickPick.language;
    if (language === undefined) {
      // FIX-04: no language, no spend. The server's `awaiting_language` read
      // model owns the story from here and the waiting screen asks.
      this.setStatus("processing");
      return;
    }
    this.setStatus("transcribing");
    try {
      // The primary pick leads; any other languages the onboarding wizard
      // recorded (F-002 "Languages you speak on camera") ride along as
      // routing hints — naming more than one is what tells the router this
      // is code-mixed speech (`transcripts.dto.ts`'s `languages` doc-comment).
      const secondary = (this.deps.quickPick.languages ?? []).filter((tag) => tag !== language);
      const result = await this.deps.client.call(endpoints.transcripts.transcribe, {
        params: { projectId },
        body: {
          languages: [language, ...secondary],
          hints: [],
          ...(this.deps.quickPick.styleId === undefined
            ? {}
            : { captions: { styleRef: this.deps.quickPick.styleId } }),
        },
      });
      this.jobId = result.jobId;
      this.setStatus("transcribing");
    } catch {
      // The expected 409 (media still probing) — and any other refusal — means the
      // SERVER pipeline owns what happens next (auto-transcribe on proxy
      // completion, FIX-M20). Claiming "ready" here was the audit's decorative
      // green tick; "processing" is the truth this tray can stand behind.
      this.setStatus("processing");
    }
  }

  private async persist(fields: {
    status: PersistedUploadRecord["status"];
    contentHash?: string;
    projectId?: string;
    mediaId?: string;
    uploadId?: string | null;
    storageKey?: string;
    bucket?: "s3" | "r2";
    partSizeBytes?: number;
    parts?: readonly UploadPartTicket[];
    createdAt?: number;
  }): Promise<void> {
    const existing = await getUploadRecord(this.deps.localId);
    await this.putRecord({
      id: this.deps.localId,
      projectId: fields.projectId ?? existing?.projectId ?? "",
      fileBytes: existing?.fileBytes ?? (await this.deps.file.arrayBuffer()),
      fileName: this.deps.file.name,
      fileType: this.deps.file.type,
      fileSize: this.deps.file.size,
      contentHash: fields.contentHash ?? existing?.contentHash,
      mediaId: fields.mediaId ?? existing?.mediaId,
      uploadId: fields.uploadId ?? existing?.uploadId,
      storageKey: fields.storageKey ?? existing?.storageKey,
      bucket: fields.bucket ?? existing?.bucket,
      partSizeBytes: fields.partSizeBytes ?? existing?.partSizeBytes,
      parts: fields.parts ?? existing?.parts,
      completedParts: this.completedParts,
      status: fields.status,
      createdAt: fields.createdAt ?? existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    });
  }

  private setStatus(status: UploadStatus): void {
    this.status = status;
    this.emit();
  }

  /**
   * Awaited (not fire-and-forget like `persist()`'s other callers) because
   * every caller returns immediately after this, and the write has to have
   * actually landed before then -- see the comment inside.
   */
  private async fail(error: unknown): Promise<void> {
    this.errorMessage = error instanceof Error ? error.message : "The upload failed.";
    this.status = "error";
    this.emit();
    // Every other terminal path (`cancel()`, the duplicate branch, a clean
    // finish) persists or deletes the IndexedDB record; this one never did.
    // A record left at whatever non-terminal status it last saw --
    // "uploading", "completing" -- is exactly what `listResumableUploads()`
    // still offers back on the next mount, so a failed upload retried the
    // same doomed resume, and failed the same way, on every single page load
    // forever (observed live: an upload whose project had since been
    // deleted kept coming back as "No such media" no matter how many times
    // it was dismissed, because dismiss only ever cleared the in-memory row
    // -- see `dismiss()` in `use-upload-queue.ts`).
    await this.persist({
      status: "error",
      ...(this.projectId === undefined ? {} : { projectId: this.projectId }),
      ...(this.mediaId === undefined ? {} : { mediaId: this.mediaId }),
    });
  }

  private emit(): void {
    this.deps.onUpdate(this.getState());
  }
}

/** "holiday-clip-final-v2.mp4" -> "holiday clip final v2". Never empty. */
export function titleFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^./\\]+$/, "");
  const spaced = withoutExtension.replace(/[_-]+/g, " ").trim();
  return spaced.length > 0 ? spaced : "Untitled project";
}
