import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ProjectDetailSheet } from "./project-detail-sheet";

import { renderWithProviders } from "@/test/harness";

const PROJECT_ROUTE = {
  "/projects/01JPROJECT0000000000000AA": {
    id: "01JPROJECT0000000000000AA",
    workspaceId: "01JWORKSPACE",
    title: "Holiday clip",
    folderId: null,
    clientTag: null,
    sourceLanguage: "hi-Latn",
    scripts: [],
    aspect: "9:16",
    status: "active",
    thumbnailKey: null,
    durationMs: null,
    mediaCount: 2,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
    retentionUntil: "2026-12-01T00:00:00.000Z",
    createdBy: null,
    createdAt: "2026-09-02T00:00:00.000Z",
  },
  "/jobs": {
    items: [
      {
        id: "01JJOB0000000000000000000",
        type: "media.probe",
        status: "succeeded",
        priority: 0,
        progress: 100,
        etaMs: null,
        projectId: "01JPROJECT0000000000000AA",
        jobKey: "media.probe:x",
        attemptId: null,
        creditsChargedTenths: 0,
        maxQueueWaitMs: null,
        result: null,
        error: null,
        provider: null,
        model: null,
        queuedAt: "2026-09-02T00:00:00.000Z",
        startedAt: "2026-09-02T00:00:01.000Z",
        finishedAt: "2026-09-02T00:00:05.000Z",
      },
    ],
    nextCursor: null,
  },
};

describe("<ProjectDetailSheet />", () => {
  it("is closed when there is no project id", () => {
    renderWithProviders(<ProjectDetailSheet projectId={undefined} onOpenChange={vi.fn()} />, {
      routes: {},
    });
    expect(screen.queryByTestId("project-detail-sheet")).toBeNull();
  });

  it("shows the project's metadata, retention date and job history", async () => {
    renderWithProviders(
      <ProjectDetailSheet projectId="01JPROJECT0000000000000AA" onOpenChange={vi.fn()} />,
      { routes: PROJECT_ROUTE },
    );
    await waitFor(() => {
      expect(screen.getByText("2")).toBeInTheDocument(); // media count
    });
    expect(screen.getByTestId("project-detail-retention")).toHaveTextContent("2026");
    expect(screen.getByTestId("project-detail-jobs")).toHaveTextContent("media.probe");
  });

  it("says when there are no jobs yet", async () => {
    renderWithProviders(
      <ProjectDetailSheet projectId="01JPROJECT0000000000000AA" onOpenChange={vi.fn()} />,
      {
        routes: {
          ...PROJECT_ROUTE,
          "/jobs": { items: [], nextCursor: null },
        },
      },
    );
    await waitFor(() => {
      expect(screen.getByText("No jobs yet.")).toBeInTheDocument();
    });
  });
});
