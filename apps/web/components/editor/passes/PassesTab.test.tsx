import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DeviceView, Entitlement } from "@montaj/api-client";
import type { EdgHot, Pass, PassItem, Segment, TranscriptChunk } from "@montaj/edg";

import { PassesTab } from "./PassesTab";
import { EditorStore, type EditorStoreInit } from "../../../lib/edg/store";

import { renderWithProviders } from "@/test/harness";

const PROJECT = "01JPROJECT0000000000000000";

function entitlement(activeDevices: number): Entitlement {
  return {
    workspaceId: "01JWORKSPACE",
    planKey: "free",
    planName: "Free",
    creditsPerMonthTenths: 0,
    seatsIncluded: 1,
    seatsUsed: 1,
    entitlements: { activeDevices },
    computedAt: "2026-09-03T00:00:00.000Z",
  };
}

function device(overrides: Partial<DeviceView> = {}): DeviceView {
  return {
    id: "d1",
    name: "Studio PC",
    platform: "windows",
    host: "premiere",
    hostVersion: null,
    appVersion: null,
    lastActiveAt: null,
    leaseUntil: null,
    revokedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    isCurrentSession: false,
    ...overrides,
  };
}

function cutItem(
  itemId: string,
  startMs: number,
  endMs: number,
  state: PassItem["state"],
  confidence: number,
): PassItem {
  return { itemId, passId: "pass-1", kind: "cut", startMs, endMs, payload: {}, state, confidence };
}

function fixtureInit(items: PassItem[]): EditorStoreInit {
  const hot: EdgHot = {
    meta: { edgId: "e1", projectId: "p1", revision: 1, schemaVersion: 2 },
    media: [{ mediaId: "m1", role: "primary", durationMs: 10_000 }],
    transcript: { transcriptId: "t1", revision: 1, language: "en", scripts: ["roman"] },
    canvas: { aspect: "9:16", width: 1080, height: 1920 },
    styles: { defaultStyleId: "punch-pop" },
  };
  const chunks: TranscriptChunk[] = [];
  const segments: Segment[] = [];
  const passes: Pass[] = [
    { passId: "pass-1", type: "autocut", engine: "autocut@2", params: {}, status: "ready", items },
  ];
  return { hot, segments, passes, chunks, revision: 1 };
}

function buildStore(items: PassItem[]): EditorStore {
  const init = fixtureInit(items);
  return new EditorStore(init, {
    applyBatch: async (body) => ({
      revision: 2,
      applied: body.clientOpIds,
      rebased: [],
      rejected: [],
    }),
    resegment: async () => ({ revision: 2, applied: [], rebased: [], rejected: [] }),
    reloadDocument: async () => ({
      hot: init.hot,
      segments: init.segments,
      passes: init.passes,
      revision: 2,
    }),
    debounceMs: 0,
  });
}

describe("<PassesTab />", () => {
  it("lists proposals and shows the summary bar", () => {
    const items = [
      cutItem("i1", 0, 1000, "proposed", 0.9),
      cutItem("i2", 2000, 2500, "accepted", 0.6),
    ];
    const store = buildStore(items);
    const passes: Pass[] = [
      {
        passId: "pass-1",
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "ready",
        items,
      },
    ];
    renderWithProviders(
      <PassesTab projectId={PROJECT} store={store} passes={passes} sourceDurationMs={10_000} />,
    );
    expect(screen.getByTestId("passes-tab")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-card-i1")).toBeInTheDocument();
    expect(screen.getByTestId("proposal-card-i2")).toBeInTheDocument();
    expect(screen.getByTestId("passes-summary-bar")).toHaveTextContent("Removed: 0.5s");
  });

  it("brief C04b §3: greys the run button and shows the upload-to-cloud notice for a local project", () => {
    const items = [cutItem("i1", 0, 1000, "proposed", 0.9)];
    const store = buildStore(items);
    const passes: Pass[] = [
      {
        passId: "pass-1",
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "ready",
        items,
      },
    ];
    const onUploadToCloud = vi.fn();
    renderWithProviders(
      <PassesTab
        projectId={PROJECT}
        store={store}
        passes={passes}
        sourceDurationMs={10_000}
        isLocalProject
        onUploadToCloud={onUploadToCloud}
      />,
    );
    expect(screen.getByTestId("local-mode-notice")).toHaveTextContent(
      "upload to cloud to use passes",
    );
    expect(screen.getByTestId("run-autocut-button")).toBeDisabled();
    fireEvent.click(screen.getByTestId("local-mode-upload"));
    expect(onUploadToCloud).toHaveBeenCalledTimes(1);
  });

  it("accepting a card sends a DecideItems op and updates its state optimistically", async () => {
    const user = userEvent.setup();
    const items = [cutItem("i1", 0, 1000, "proposed", 0.9)];
    const store = buildStore(items);
    const passes: Pass[] = [
      {
        passId: "pass-1",
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "ready",
        items,
      },
    ];
    renderWithProviders(
      <PassesTab projectId={PROJECT} store={store} passes={passes} sourceDurationMs={10_000} />,
    );

    await user.click(screen.getByTestId("proposal-card-accept"));

    await waitFor(() => {
      expect(store.getSnapshot().state.items.get("i1")?.state).toBe("accepted");
    });
  });

  it("bulk-accepts every proposed item at or above 0.8 confidence", async () => {
    const user = userEvent.setup();
    const items = [
      cutItem("i1", 0, 1000, "proposed", 0.9),
      cutItem("i2", 1000, 2000, "proposed", 0.5),
    ];
    const store = buildStore(items);
    const passes: Pass[] = [
      {
        passId: "pass-1",
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "ready",
        items,
      },
    ];
    renderWithProviders(
      <PassesTab projectId={PROJECT} store={store} passes={passes} sourceDurationMs={10_000} />,
    );

    await user.click(screen.getByTestId("bulk-accept-above-0-8"));

    await waitFor(() => {
      expect(store.getSnapshot().state.items.get("i1")?.state).toBe("accepted");
      expect(store.getSnapshot().state.items.get("i2")?.state).toBe("proposed");
    });
  });

  it("opens the run-autocut dialog with a credits estimate", async () => {
    const user = userEvent.setup();
    const store = buildStore([]);
    renderWithProviders(
      <PassesTab projectId={PROJECT} store={store} passes={[]} sourceDurationMs={120_000} />,
    );

    await user.click(screen.getByTestId("run-autocut-button"));
    expect(await screen.findByTestId("autocut-quote-estimate")).toHaveTextContent("credits");
  });

  it("shows an empty state when filters exclude every row", () => {
    const items = [cutItem("i1", 0, 1000, "accepted", 0.9)];
    const store = buildStore(items);
    const passes: Pass[] = [
      {
        passId: "pass-1",
        type: "autocut",
        engine: "autocut@2",
        params: {},
        status: "ready",
        items,
      },
    ];
    renderWithProviders(
      <PassesTab projectId={PROJECT} store={store} passes={passes} sourceDurationMs={10_000} />,
    );
    expect(screen.queryByTestId("passes-empty-state")).not.toBeInTheDocument();
  });

  describe("plugin activation cue (M08)", () => {
    function renderTab(routes: Record<string, unknown>) {
      const items = [cutItem("i1", 0, 1000, "proposed", 0.9)];
      const store = buildStore(items);
      const passes: Pass[] = [
        {
          passId: "pass-1",
          type: "autocut",
          engine: "autocut@2",
          params: {},
          status: "ready",
          items,
        },
      ];
      return renderWithProviders(
        <PassesTab projectId={PROJECT} store={store} passes={passes} sourceDurationMs={10_000} />,
        { routes },
      );
    }

    it("hides the cue once every NLE host is already activated", async () => {
      renderTab({
        "/devices": [device({ host: "premiere" }), device({ id: "d2", host: "resolve" })],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(2),
      });
      await screen.findByTestId("passes-tab");
      await waitFor(() => {
        expect(screen.queryByTestId("passes-plugin-cues")).not.toBeInTheDocument();
      });
    });

    it("shows a cue for a host that is not yet activated when another device is paired", async () => {
      renderTab({
        "/devices": [device({ host: "premiere" })],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(2),
      });
      const cue = await screen.findByTestId("passes-plugin-cue-resolve");
      expect(cue).toHaveTextContent("Not installed");
      expect(screen.queryByTestId("passes-plugin-cue-premiere")).not.toBeInTheDocument();
    });

    it("hides the cue entirely when no plugin device is paired at all", async () => {
      renderTab({
        "/devices": [],
        "/workspaces/01JWORKSPACE/entitlement": entitlement(1),
      });
      await screen.findByTestId("passes-tab");
      await waitFor(() => {
        expect(screen.queryByTestId("passes-plugin-cues")).not.toBeInTheDocument();
      });
    });

    it("hides the cue for a local project even when a device is paired but not activated", async () => {
      const items = [cutItem("i1", 0, 1000, "proposed", 0.9)];
      const store = buildStore(items);
      const passes: Pass[] = [
        {
          passId: "pass-1",
          type: "autocut",
          engine: "autocut@2",
          params: {},
          status: "ready",
          items,
        },
      ];
      renderWithProviders(
        <PassesTab
          projectId={PROJECT}
          store={store}
          passes={passes}
          sourceDurationMs={10_000}
          isLocalProject
        />,
        {
          routes: {
            "/devices": [device({ host: "premiere" })],
            "/workspaces/01JWORKSPACE/entitlement": entitlement(1),
          },
        },
      );
      await screen.findByTestId("passes-tab");
      expect(screen.queryByTestId("passes-plugin-cues")).not.toBeInTheDocument();
      expect(screen.queryByTestId("passes-plugin-cue-resolve")).not.toBeInTheDocument();
    });
  });
});
