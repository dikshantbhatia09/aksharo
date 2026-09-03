import { useCallback, useEffect, useState } from "react";

import { runApply } from "../apply/runApply.js";
import { parseSessionStatus, SIGNED_OUT_STATUS, type SessionStatus } from "../auth/session.js";
import { acceptedItemIds, fetchPasses, type PassesListResult } from "../passes/passes.js";
import { tryConnect, type ConnectOptions } from "../rpc/connect.js";
import { Footer } from "./components/Footer.js";
import { PassesPanel } from "./components/PassesPanel.js";
import { SignIn } from "./components/SignIn.js";
import { StudioRequired } from "./components/StudioRequired.js";
import {
  TimelinePanel,
  type TimelineInfo,
  type TranscribeStage,
} from "./components/TimelinePanel.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { SURFACE, TEXT } from "./tokens.js";

import type { WorkflowIntegrationHost } from "../host/workflow-integration.js";
import type { ResolveRpcClient } from "../rpc/client.js";
import type { UpdateBannerState } from "../version/manifestCheck.js";
import type { JSX } from "react";

export interface AppProps {
  readonly host: WorkflowIntegrationHost;
  readonly createTransport: ConnectOptions["createTransport"];
  readonly panelVersion: string;
  readonly apiVersion: string;
  readonly updateBannerState: UpdateBannerState;
  readonly projectId: string;
  readonly languageHints: readonly string[];
}

type ConnectionState =
  | { readonly status: "checkingStudio" }
  | { readonly status: "studioRequired" }
  | { readonly status: "waitingForScript" }
  | { readonly status: "connected"; readonly client: ResolveRpcClient }
  | { readonly status: "error"; readonly message: string };

export function App({
  host,
  createTransport,
  panelVersion,
  apiVersion,
  updateBannerState,
  projectId,
  languageHints,
}: AppProps): JSX.Element {
  const [connection, setConnection] = useState<ConnectionState>({ status: "checkingStudio" });
  const [hostVersion, setHostVersion] = useState<string>();
  const [session, setSession] = useState<SessionStatus>(SIGNED_OUT_STATUS);
  const [timeline, setTimeline] = useState<TimelineInfo>();
  const [passes, setPasses] = useState<PassesListResult>();
  const [stage, setStage] = useState<TranscribeStage>("idle");
  const [stageMessage, setStageMessage] = useState<string>();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string>();

  const refreshFrom = useCallback(async (client: ResolveRpcClient) => {
    try {
      const [statusWire, timelineResult, passesResult] = await Promise.all([
        client.call<Parameters<typeof parseSessionStatus>[0]>("session.status"),
        client.call<{ timeline: TimelineInfo | null }>("timeline.current"),
        fetchPasses(client),
      ]);
      setSession(parseSessionStatus(statusWire));
      setTimeline(timelineResult.timeline ?? undefined);
      setPasses(passesResult);
    } catch (error) {
      setConnection({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const attemptConnect = useCallback(async () => {
    const isStudio = await host.isStudio();
    if (!isStudio) {
      setConnection({ status: "studioRequired" });
      return;
    }
    const result = await tryConnect({ host, createTransport });
    if (!result) {
      setConnection({ status: "waitingForScript" });
      return;
    }
    setConnection({ status: "connected", client: result.client });
    await refreshFrom(result.client);
  }, [host, createTransport, refreshFrom]);

  const refresh = useCallback(async () => {
    if (connection.status !== "connected") return;
    await refreshFrom(connection.client);
  }, [connection, refreshFrom]);

  useEffect(() => {
    void host.getHostVersion().then(setHostVersion);
  }, [host]);

  useEffect(() => {
    void attemptConnect();
    // Runs once on mount only; `attemptConnect` is re-triggered explicitly afterwards (retry
    // button, post-transcribe/apply refresh calls `refreshFrom` directly instead).
  }, []);

  async function handleTranscribe(): Promise<void> {
    if (connection.status !== "connected" || !timeline) return;
    setStage("mixing");
    setStageMessage(undefined);
    try {
      await connection.client.call("transcribe.start", {
        projectId,
        timelineName: timeline.name,
        languageHints: [...languageHints],
        fps: timeline.fps,
      });
      setStage("done");
      await refresh();
    } catch (error) {
      setStage("error");
      setStageMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function handleApply(): Promise<void> {
    if (connection.status !== "connected" || !passes) return;
    const itemIds = acceptedItemIds(passes);
    if (itemIds.length === 0) return;
    setApplying(true);
    setApplyError(undefined);
    try {
      await runApply(connection.client, { projectId, itemIds });
      await refresh();
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div style={{ background: SURFACE.bg0, color: TEXT.fg0, fontSize: 13, minHeight: "100%" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 12px",
          borderBottom: `1px solid ${SURFACE.border}`,
        }}
      >
        <span>Aksharo</span>
        <span data-testid="connection-status" data-status={connection.status}>
          {connection.status}
        </span>
      </header>

      <UpdateBanner state={updateBannerState} currentVersion={panelVersion} />

      {connection.status === "studioRequired" && <StudioRequired />}

      {connection.status === "waitingForScript" && (
        <div
          data-testid="waiting-for-script"
          style={{ padding: 16, fontSize: 12, color: TEXT.fg2 }}
        >
          Waiting for the Aksharo script to start (Workspace ▸ Scripts ▸ aksharo_core)…
          <div>
            <button type="button" data-testid="retry-connect" onClick={() => void attemptConnect()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {connection.status === "error" && (
        <div data-testid="connection-error" style={{ padding: 16, fontSize: 12, color: TEXT.fg1 }}>
          Could not connect: {connection.message}
          <div>
            <button type="button" data-testid="retry-connect" onClick={() => void attemptConnect()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {connection.status === "connected" &&
        (session.signedIn ? (
          <>
            <TimelinePanel
              timeline={timeline}
              stage={stage}
              stageMessage={stageMessage}
              onTranscribe={() => void handleTranscribe()}
            />
            <PassesPanel
              passes={passes}
              applying={applying}
              applyError={applyError}
              onApply={() => void handleApply()}
            />
          </>
        ) : (
          <SignIn
            status={session}
            onOpenVerificationUrl={(url) => void host.openExternalUrl(url)}
          />
        ))}

      <Footer panelVersion={panelVersion} apiVersion={apiVersion} hostVersion={hostVersion} />
    </div>
  );
}
