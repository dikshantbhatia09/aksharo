import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { ScriptTabs } from "./ScriptTabs";

import { renderWithProviders } from "@/test/harness";

const PROJECT = "01JPROJECT0000000000000000";

function scriptsBody(overrides: readonly Record<string, unknown>[] = []): unknown {
  const base: Record<string, unknown>[] = [
    { script: "roman", available: true, source: "transcription" },
    { script: "native", available: false },
    { script: "en", available: false },
    { script: "translated", available: false },
  ];
  for (const override of overrides) {
    const index = base.findIndex((row) => row["script"] === override["script"]);
    // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
    if (index >= 0) base[index] = override;
    else base.push(override);
  }
  return { scripts: base };
}

function Harness(): React.JSX.Element {
  const [active, setActive] = React.useState("roman");
  return <ScriptTabs projectId={PROJECT} activeScript={active} onScriptChange={setActive} />;
}

/** True once one of the mock's calls hit a path containing `fragment`. */
function calledPath(fetchMock: { mock: { calls: unknown[][] } }, fragment: string): boolean {
  return fetchMock.mock.calls.some((call) => String(call[0]).includes(fragment));
}

describe("<ScriptTabs />", () => {
  it("renders a tab per script and marks translation as not yet added", async () => {
    renderWithProviders(<Harness />, {
      routes: { [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody() },
    });
    expect(await screen.findByRole("tab", { name: "Roman" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Native" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "+ Add translation…" })).toBeInTheDocument();
  });

  it("clicking an unavailable script tab starts a free transliteration job", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<Harness />, {
      routes: {
        [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody(),
        [`/projects/${PROJECT}/transcript/transliterate`]: {
          jobId: "01JJOB0000000000000000000A",
          targetScript: "native",
          status: "queued",
          deduplicated: false,
        },
      },
    });
    await screen.findByRole("tab", { name: "Native" });
    await user.click(screen.getByRole("tab", { name: "Native" }));

    await waitFor(() => {
      expect(calledPath(fetchMock, "/transliterate")).toBe(true);
    });
  });

  it("clicking + Add translation opens the language picker, not a request yet", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, {
      routes: { [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody() },
    });
    await user.click(await screen.findByRole("tab", { name: "+ Add translation…" }));
    expect(screen.getByLabelText("Translate to")).toBeInTheDocument();
  });

  it("choosing a language starts a translate job for it", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<Harness />, {
      routes: {
        [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody(),
        [`/projects/${PROJECT}/transcript/translate`]: {
          targets: [
            {
              jobId: "01JJOB0000000000000000000B",
              targetLanguage: "en",
              status: "queued",
              deduplicated: false,
              quote: { tenths: 5, credits: "0.5" },
            },
          ],
          quote: { tenths: 5, credits: "0.5" },
        },
      },
    });
    await user.click(await screen.findByRole("tab", { name: "+ Add translation…" }));
    await user.selectOptions(screen.getByLabelText("Translate to"), "en");

    await waitFor(() => {
      expect(calledPath(fetchMock, "/translate")).toBe(true);
    });
  });

  it("clicking an existing translation asks for confirmation before regenerating", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<Harness />, {
      routes: {
        [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody([
          { script: "translated", available: true, language: "en", provider: "mock" },
        ]),
      },
    });
    const tab = await screen.findByRole("tab", { name: /Translated \(EN\)/ });
    await user.click(tab);

    expect(await screen.findByText("Regenerate this translation?")).toBeInTheDocument();
    // Cancel: no translate call fires.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calledPath(fetchMock, "/translate")).toBe(false);
  });

  it("surfaces a plan_required translation error as a readable message", async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />, {
      routes: {
        [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody(),
        [`/projects/${PROJECT}/transcript/translate`]: new Response(
          JSON.stringify({
            error: { code: "transcript/plan_required", message: "Translation needs Starter+." },
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
      },
    });
    await user.click(await screen.findByRole("tab", { name: "+ Add translation…" }));
    await user.selectOptions(screen.getByLabelText("Translate to"), "en");

    expect(await screen.findByRole("alert")).toHaveTextContent(/does not include this translation/);
  });
});
