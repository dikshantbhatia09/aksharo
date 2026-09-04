import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { Project } from "@montaj/api-client";

import { ProjectCard } from "./project-card";

import { renderWithProviders } from "@/test/harness";

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "01JPROJECT0000000000000AA",
    workspaceId: "01JWORKSPACE000000000000A",
    title: "Holiday clip",
    folderId: null,
    clientTag: null,
    sourceLanguage: "hi-Latn",
    scripts: [],
    aspect: "9:16",
    status: "active",
    thumbnailKey: null,
    durationMs: 125_000,
    mediaCount: 1,
    lastActivityAt: "2026-09-02T00:00:00.000Z",
    retentionUntil: null,
    createdBy: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

const EMPTY_JOBS = { "/jobs": { items: [], nextCursor: null } };

describe("<ProjectCard />", () => {
  it("shows the title, duration and status once jobs have loaded", async () => {
    renderWithProviders(<ProjectCard project={project()} />, { routes: EMPTY_JOBS });
    expect(screen.getByText("Holiday clip")).toBeInTheDocument();
    expect(screen.getByText("2:05")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("status-chip")).toHaveTextContent("Ready");
    });
    expect(screen.getByTestId("lang-chip")).toBeInTheDocument();
  });

  it("shows Working while a job for it is still running", async () => {
    renderWithProviders(<ProjectCard project={project({ mediaCount: 0 })} />, {
      routes: {
        "/jobs": {
          items: [
            {
              id: "01JJOB0000000000000000000",
              type: "media.probe",
              status: "running",
              priority: 0,
              progress: 40,
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
              finishedAt: null,
            },
          ],
          nextCursor: null,
        },
      },
    });
    await waitFor(() => {
      expect(screen.getByTestId("status-chip")).toHaveTextContent("Working");
    });
    expect(screen.getByTestId("project-card-eta")).toBeInTheDocument();
  });

  it("links to the project's editor route", async () => {
    renderWithProviders(<ProjectCard project={project()} />, { routes: EMPTY_JOBS });
    await waitFor(() => {
      expect(screen.getByTestId("project-card")).toHaveAttribute(
        "href",
        "/p/01JPROJECT0000000000000AA",
      );
    });
  });

  // --- FIX-05: the card frames and labels the project from its own data ------

  it("frames a portrait project in the document's aspect, not 16:9", async () => {
    const { container } = renderWithProviders(
      <ProjectCard project={project({ aspect: "9:16" })} />,
      { routes: EMPTY_JOBS },
    );
    await waitFor(() => {
      expect(screen.getByTestId("project-card")).toBeInTheDocument();
    });
    // `getElementsByClassName` takes a raw class name — a CSS selector would have
    // to escape both brackets and the slash in Tailwind's arbitrary-value class.
    expect(container.getElementsByClassName("aspect-[9/16]")).toHaveLength(1);
    expect(container.getElementsByClassName("aspect-video")).toHaveLength(0);
  });

  it("renders the presigned thumbnail when the project has one", async () => {
    const url = "https://derived.example/thumb-0.jpg?sig=abc";
    const { container } = renderWithProviders(
      <ProjectCard project={project({ thumbnailUrl: url })} />,
      { routes: EMPTY_JOBS },
    );
    await waitFor(() => {
      expect(screen.getByTestId("project-card")).toBeInTheDocument();
    });
    // A plain <img> by design (the guide's own note): assert the src directly.
    const image = container.querySelector("img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("src")).toBe(url);
  });

  it("shows a m:ss duration chip from durationMs", async () => {
    renderWithProviders(<ProjectCard project={project({ durationMs: 20_200 })} />, {
      routes: EMPTY_JOBS,
    });
    await waitFor(() => {
      expect(screen.getByTestId("project-card-duration")).toHaveTextContent("0:20");
    });
  });

  it("opens the kebab menu without navigating", async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectCard project={project()} />, { routes: EMPTY_JOBS });
    await user.click(screen.getByTestId("project-kebab-01JPROJECT0000000000000AA"));
    expect(await screen.findByTestId("kebab-open")).toBeInTheDocument();
  });
});
