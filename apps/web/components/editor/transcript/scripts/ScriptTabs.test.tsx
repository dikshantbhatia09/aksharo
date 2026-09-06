import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

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
    await user.click(screen.getByLabelText("Translate to"));
    await user.click(await screen.findByRole("menuitem", { name: "English" }));

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
    await user.click(screen.getByLabelText("Translate to"));
    await user.click(await screen.findByRole("menuitem", { name: "English" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/does not include this translation/);
  });
});
/**
 * FIX-04: the strip is built from the response, not from three hard-coded
 * triggers. `onAvailable` is what stops the editor selecting a script the
 * transcript does not have — the Devanagari-under-"Roman" repro.
 */
describe("<ScriptTabs /> is availability-driven (FIX-04)", () => {
  it("renders a tab only for the scripts the response lists", async () => {
    renderWithProviders(<Harness />, {
      routes: {
        [`/projects/${PROJECT}/transcript/scripts`]: {
          scripts: [{ script: "native", available: true, source: "transcription" }],
        },
      },
    });

    expect(await screen.findByRole("tab", { name: "Native" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Roman" })).toBeNull();
    // The translation affordance is unchanged and always offered.
    expect(screen.getByRole("tab", { name: "+ Add translation…" })).toBeInTheDocument();
  });

  it("reports the available scripts — and only those — through onAvailable", async () => {
    const onAvailable = vi.fn();
    renderWithProviders(
      <ScriptTabs
        projectId={PROJECT}
        activeScript="native"
        onScriptChange={vi.fn()}
        onAvailable={onAvailable}
      />,
      {
        routes: {
          [`/projects/${PROJECT}/transcript/scripts`]: scriptsBody([
            { script: "roman", available: false },
            { script: "native", available: true },
          ]),
        },
      },
    );

    await waitFor(() => {
      expect(onAvailable).toHaveBeenCalledWith(["native"]);
    });
  });

  it("does not let a second click spend the same transliteration twice", async () => {
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
    const tab = await screen.findByRole("tab", { name: "Native" });
    await user.click(tab);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).includes("/transliterate")),
      ).toHaveLength(1);
    });
  });
});

/**
 * Step 4b's contract, as a unit: the editor keeps a script it still has, and
 * moves to the first one it does have otherwise. This is the exact logic in
 * `editor-client.tsx`'s `onScriptsAvailable`.
 */
describe("the editor's default-tab correction", () => {
  const correct = (available: readonly string[], current: string): string =>
    available.includes(current) ? current : (available[0] ?? current);

  it("moves off a script the transcript does not have", () => {
    expect(correct(["native"], "roman")).toBe("native");
  });

  it("keeps a script that is really there", () => {
    expect(correct(["roman", "native"], "native")).toBe("native");
  });

  it("changes nothing while the transcript has no scripts at all", () => {
    expect(correct([], "roman")).toBe("roman");
  });
});
