import { useEffect, useMemo, useState } from "react";

import { SignInSession, type SignInState } from "../auth/session.js";
import { LANGUAGE_HINTS } from "../i18n/strings.js";
import { mixdownAndTranscribe } from "../upload/mixdown.js";
import { Footer } from "./components/Footer.js";
import { ProjectPanel } from "./components/ProjectPanel.js";
import { SignIn } from "./components/SignIn.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { SURFACE, TEXT } from "./tokens.js";

import type { BridgeClient } from "../bridge/client.js";
import type { PremiereHost, SequenceInfo } from "../host/premiere.js";
import type { HttpClient, MixdownStage } from "../upload/mixdown.js";
import type { UpdateBannerState } from "../version/manifestCheck.js";
import type { JSX } from "react";

/**
 * C11 owns activation/licensing (`POST /plugins/activate|heartbeat`, D65's "activation card").
 * This type mirrors only the shape this panel's header needs to render a badge — it does not
 * reimplement C11's state machine, and C11's real type should replace this once that package
 * exports one (both are additive C0x work packages landing in parallel; see the WP report).
 */
export type ActivationState = "active" | "trial" | "expired" | "unknown";

export interface AppProps {
  readonly host: PremiereHost;
  readonly bridge: BridgeClient;
  readonly http: HttpClient;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly panelVersion: string;
  readonly apiVersion: string;
  readonly activationState: ActivationState;
  readonly updateBannerState: UpdateBannerState;
}

export function App({
  host,
  bridge,
  http,
  apiOrigin,
  webOrigin,
  panelVersion,
  apiVersion,
  activationState,
  updateBannerState,
}: AppProps): JSX.Element {
  const session = useMemo(
    () => new SignInSession(bridge, host, webOrigin),
    [bridge, host, webOrigin],
  );
  const [signInState, setSignInState] = useState<SignInState>(session.getState());
  const [sequence, setSequence] = useState<SequenceInfo | undefined>(undefined);
  const [hostVersion, setHostVersion] = useState<string>();
  const [stage, setStage] = useState<MixdownStage | "idle">("idle");
  const [stageMessage, setStageMessage] = useState<string>();
  const [webEditorUrl, setWebEditorUrl] = useState<string>();

  useEffect(() => session.onChange(setSignInState), [session]);

  useEffect(() => {
    let cancelled = false;
    void host.getActiveSequence().then((seq) => {
      if (!cancelled) setSequence(seq);
    });
    void host.getHostVersion().then((v) => {
      if (!cancelled) setHostVersion(v);
    });
    const unsubscribe = host.onSequenceChange((event) => {
      if (!cancelled) setSequence(event.sequence);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [host]);

  async function handleTranscribe(): Promise<void> {
    if (!sequence?.inOut) return;
    const token = session.getSessionToken();
    if (!token) return;
    setStage("mixing");
    setStageMessage(undefined);
    try {
      const result = await mixdownAndTranscribe({
        host,
        bridge,
        http,
        apiOrigin,
        sessionToken: token,
        sequenceId: sequence.sequenceId,
        range: sequence.inOut,
        format: "mono16k",
        project: {
          sequenceName: sequence.name,
          languageHints: LANGUAGE_HINTS.map((hint) => hint.code),
          fps: sequence.frameRate.fps,
          width: sequence.width,
          height: sequence.height,
        },
        onStageChange: (event) => {
          setStage(event.stage);
          if (event.message) setStageMessage(event.message);
        },
      });
      setWebEditorUrl(result.webEditorUrl);
    } catch {
      // stage/stageMessage already reflect the error via onStageChange
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
        <span data-testid="activation-badge" data-state={activationState}>
          {activationState}
        </span>
      </header>

      <UpdateBanner state={updateBannerState} currentVersion={panelVersion} />

      {signInState.status === "signedIn" ? (
        <ProjectPanel
          sequence={sequence}
          stage={stage}
          stageMessage={stageMessage}
          webEditorUrl={webEditorUrl}
          onTranscribe={() => void handleTranscribe()}
        />
      ) : (
        <SignIn
          state={signInState}
          onBeginSignIn={() => void session.beginSignIn()}
          onConfirm={(code) => void session.confirmSignIn(code)}
          onSignOut={() => session.signOut()}
        />
      )}

      <Footer panelVersion={panelVersion} apiVersion={apiVersion} hostVersion={hostVersion} />
    </div>
  );
}
