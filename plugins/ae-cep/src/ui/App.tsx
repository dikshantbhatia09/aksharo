import { useEffect, useMemo, useState } from "react";

import { SignInSession, type SignInState } from "../auth/session.js";
import { LANGUAGE_HINTS } from "../i18n/strings.js";
import { mixdownAndTranscribe } from "../upload/mixdown.js";
import { CompPanel } from "./components/CompPanel.js";
import { Footer } from "./components/Footer.js";
import { SignIn } from "./components/SignIn.js";
import { SURFACE, TEXT } from "./tokens.js";

import type { ApplyCaptionsResult } from "../apply/applyCaptions.js";
import type { BridgeClient } from "../bridge/client.js";
import type { AeHost, CompInfo } from "../host/ae.js";
import type { HttpClient, MixdownStage } from "../upload/mixdown.js";
import type { JSX } from "react";

export interface AppProps {
  readonly host: AeHost;
  readonly bridge: BridgeClient;
  readonly http: HttpClient;
  readonly apiOrigin: string;
  readonly webOrigin: string;
  readonly panelVersion: string;
  /**
   * Runs `src/apply/applyCaptions.ts` for the current comp/project. Injected rather than
   * called directly so this module (and its production bundle, `src/index.tsx`) never has to
   * import `@montaj/caption-styles` — that package reads style JSON files with `node:fs`
   * (`loadSystemStyles`), which esbuild's browser/IIFE panel bundle cannot resolve (see
   * `scripts/build.mjs`'s header on the CEP panel's Chromium target). Tests wire a real
   * `applyCaptions(host, {...})` call (Node/vitest can use `@montaj/caption-styles` freely);
   * `src/index.tsx`'s production wiring leaves this undefined until a real style/segment data
   * source for the active project is decided (open question, see the WP report) — the "Apply
   * captions" button simply stays disabled until then.
   */
  readonly onApplyCaptions?: () => Promise<ApplyCaptionsResult>;
}

export function App({
  host,
  bridge,
  http,
  apiOrigin,
  webOrigin,
  panelVersion,
  onApplyCaptions,
}: AppProps): JSX.Element {
  const session = useMemo(
    () => new SignInSession(bridge, host, webOrigin),
    [bridge, host, webOrigin],
  );
  const [signInState, setSignInState] = useState<SignInState>(session.getState());
  const [comp, setComp] = useState<CompInfo | undefined>(undefined);
  const [hostVersion, setHostVersion] = useState<string>();
  const [stage, setStage] = useState<MixdownStage | "idle">("idle");
  const [stageMessage, setStageMessage] = useState<string>();
  const [webEditorUrl, setWebEditorUrl] = useState<string>();
  const [projectId, setProjectId] = useState<string>();
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<ApplyCaptionsResult>();

  useEffect(() => session.onChange(setSignInState), [session]);

  useEffect(() => {
    let cancelled = false;
    void host.readComp().then((c) => {
      if (!cancelled) setComp(c);
    });
    void host.getHostVersion().then((v) => {
      if (!cancelled) setHostVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  async function handleCaption(): Promise<void> {
    if (!comp?.workArea) return;
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
        compId: comp.compId,
        range: comp.workArea,
        format: "mono16k",
        project: {
          compName: comp.name,
          languageHints: LANGUAGE_HINTS.map((hint) => hint.code),
          fps: comp.frameRate,
          width: comp.width,
          height: comp.height,
        },
        onStageChange: (event) => {
          setStage(event.stage);
          if (event.message) setStageMessage(event.message);
        },
      });
      setWebEditorUrl(result.webEditorUrl);
      setProjectId(result.projectId);
    } catch {
      // stage/stageMessage already reflect the error via onStageChange
    }
  }

  async function handleApply(): Promise<void> {
    if (!comp || !projectId || !onApplyCaptions) return;
    setApplying(true);
    try {
      setApplyResult(await onApplyCaptions());
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
      </header>

      {signInState.status === "signedIn" ? (
        <CompPanel
          comp={comp}
          stage={stage}
          stageMessage={stageMessage}
          webEditorUrl={webEditorUrl}
          applyResult={applyResult}
          applying={applying}
          canApply={Boolean(onApplyCaptions)}
          onCaption={() => void handleCaption()}
          onApply={() => void handleApply()}
        />
      ) : (
        <SignIn
          state={signInState}
          onBeginSignIn={() => void session.beginSignIn()}
          onConfirm={(code) => void session.confirmSignIn(code)}
          onSignOut={() => session.signOut()}
        />
      )}

      <Footer panelVersion={panelVersion} hostVersion={hostVersion} />
    </div>
  );
}
