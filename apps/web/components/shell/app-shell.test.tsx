import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ApiClientModule from "@montaj/api-client";
import { toast } from "@montaj/ui";

import type * as AppShellModule from "./app-shell";

import { AuthCard } from "@/components/auth/auth-card";
import { Providers } from "@/components/providers";
import { SettingsRow, SettingsSection } from "@/components/settings/section";
import { TRANSCRIPT_READY_EVENT } from "@/lib/edg/transcription-state";
import { TEST_CONFIG } from "@/test/harness";
import { routerMock } from "@/test/next-router";

const refreshSession = vi.hoisted(() => vi.fn());
/** The realtime `onEvent` the shell installed, so a test can deliver a frame. */
const realtime = vi.hoisted(() => ({
  onEvent: undefined as ((event: { event: string; data: unknown }) => void) | undefined,
}));

vi.mock("@/lib/session/client", () => ({
  refreshSession,
  persistSession: vi.fn(),
  clearSession: vi.fn(),
  hasSessionCookie: vi.fn(),
}));

/** Nothing here should open a socket; the shell's realtime client is stubbed. */
vi.mock("@montaj/api-client", async () => {
  const actual = await vi.importActual<typeof ApiClientModule>("@montaj/api-client");
  return {
    ...actual,
    RealtimeClient: class {
      constructor(options: { onEvent?: (event: { event: string; data: unknown }) => void }) {
        realtime.onEvent = options.onEvent;
      }
      subscribe(): void {}
      connect(): void {}
      disconnect(): void {}
    },
  };
});

let AppShell: (typeof AppShellModule)["AppShell"];

const SESSION_TOKEN =
  "header.eyJzdWIiOiIwMUpVIiwid3MiOiIwMUpXIiwicm9sZSI6Im93bmVyIiwia2luZCI6IndlYiIsImp0aSI6IjAxSlMiLCJleHAiOjQxMDI0NDQ4MDB9.sig";

beforeEach(async () => {
  ({ AppShell } = await import("./app-shell"));
  refreshSession.mockReset();
  realtime.onEvent = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderShell(): void {
  render(
    <Providers config={TEST_CONFIG}>
      <AppShell>
        <p>Shell content</p>
      </AppShell>
    </Providers>,
  );
}

describe("<AppShell />", () => {
  it("turns the httpOnly cookie into an access token on mount", async () => {
    refreshSession.mockResolvedValue({
      accessToken:
        "header.eyJzdWIiOiIwMUpVIiwid3MiOiIwMUpXIiwicm9sZSI6Im93bmVyIiwia2luZCI6IndlYiIsImp0aSI6IjAxSlMiLCJleHAiOjQxMDI0NDQ4MDB9.sig",
      expiresIn: 900,
      workspaceId: "01JW",
      role: "owner",
    });

    renderShell();
    await waitFor(() => {
      expect(refreshSession).toHaveBeenCalledOnce();
    });
    expect(screen.getByText("Shell content")).toBeInTheDocument();
  });

  it("sends the user to sign in when the family is gone", async () => {
    refreshSession.mockResolvedValue(null);
    renderShell();
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalledWith("/login?reason=expired");
    });
  });

  it("puts a skip link first and a focusable main landmark second (08 §6)", async () => {
    refreshSession.mockResolvedValue(null);
    renderShell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main");
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main");
    expect(main).toHaveAttribute("tabindex", "-1");
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalled();
    });
  });

  it("renders exactly one navigation landmark on a wide viewport", async () => {
    refreshSession.mockResolvedValue(null);
    renderShell();
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    await waitFor(() => {
      expect(routerMock.replace).toHaveBeenCalled();
    });
  });
});

describe("<AuthCard />", () => {
  it("is a main landmark with a single heading", () => {
    render(
      <AuthCard title="Sign in" subtitle="Welcome back" footer={<span>Footer</span>}>
        <p>Body</p>
      </AuthCard>,
    );
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByText("Welcome back")).toBeInTheDocument();
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });

  it("omits the subtitle and footer when there are none", () => {
    render(
      <AuthCard title="Sign in">
        <p>Body</p>
      </AuthCard>,
    );
    expect(screen.getAllByRole("heading")).toHaveLength(1);
  });
});

describe("<SettingsSection />", () => {
  it("renders a heading, a lead line and its rows", () => {
    render(
      <SettingsSection title="Privacy" description="What we may collect." testId="settings-privacy">
        <SettingsRow
          label="Analytics"
          description="Off by default"
          control={<button>Toggle</button>}
        />
      </SettingsSection>,
    );
    expect(screen.getByTestId("settings-privacy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Privacy" })).toBeInTheDocument();
    expect(screen.getByText("Off by default")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle" })).toBeInTheDocument();
  });

  it("works without a test id or a row description", () => {
    render(
      <SettingsSection title="Notifications" description="Emails.">
        <SettingsRow label="Digest" control={<span>None</span>} />
      </SettingsSection>,
    );
    expect(screen.getByText("Digest")).toBeInTheDocument();
  });
});
/**
 * FIX-04 step 4c: the shell's one narrow branch that changes which screen the
 * user should be on now covers transliteration too. Both strings come from
 * `apps/api/src/jobs/contracts/queue-names.ts` (`"ai.transcribe"` line 17,
 * `"ai.transliterate"` line 21) — the announcement path is identical, because
 * the editor reload refetches the chunks that carry the word scripts.
 */
describe("<AppShell /> announces finished AI work", () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  // Route-aware on purpose: the shell also asks for its workspaces and its
  // recent projects, and answering those with the job body renders a broken
  // tree whose errors would drown the assertion below.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        // A base is required: the shell also fetches relative paths of its own
        // (`WhatsNewModal` asks for `/api/changelog/latest`), and `new URL`
        // throws on those without one.
        const { pathname } = new URL(
          typeof input === "string" ? input : input.toString(),
          "https://api.test",
        );
        if (pathname.startsWith("/jobs/")) {
          return Promise.resolve(
            json({ id: "01JOB", projectId: "01JPROJECT", status: "succeeded" }),
          );
        }
        if (pathname === "/workspaces") return Promise.resolve(json([]));
        if (pathname === "/projects") return Promise.resolve(json({ items: [], nextCursor: null }));
        return Promise.resolve(
          json({ error: { code: "common/not_found", message: "Not found." } }, 404),
        );
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Deliver one `job.completed` frame and collect whatever the shell announced.
   * `frame` overrides the default succeeded body — S-06 uses it to fail a job.
   */
  async function deliver(
    type: string,
    frame: { status?: string; error?: { message?: string } } = {},
  ): Promise<string[]> {
    refreshSession.mockResolvedValue({
      accessToken: SESSION_TOKEN,
      expiresIn: 900,
      workspaceId: "01JW",
      role: "owner",
    });

    const announced: string[] = [];
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId !== undefined) announced.push(detail.projectId);
    };
    window.addEventListener(TRANSCRIPT_READY_EVENT, listener);
    try {
      renderShell();
      await waitFor(() => {
        expect(realtime.onEvent).toBeDefined();
      });
      realtime.onEvent?.({
        event: "job.completed",
        data: { jobId: "01JOB", status: "succeeded", type, ...frame },
      });
      // The handler reads the job back before it announces, so give the whole
      // round trip room to happen (or to correctly not happen).
      await waitFor(() => {
        expect(announced.length).toBeGreaterThan(0);
      }).catch(() => undefined);
      return announced;
    } finally {
      window.removeEventListener(TRANSCRIPT_READY_EVENT, listener);
    }
  }

  it("announces a finished transcription", async () => {
    expect(await deliver("ai.transcribe")).toEqual(["01JPROJECT"]);
  });

  // The membership change: a script job finishing is the same story for the
  // editor, because the new script rides on the same words.
  it("announces a finished transliteration too", async () => {
    expect(await deliver("ai.transliterate")).toEqual(["01JPROJECT"]);
  });

  /**
   * S-03: an import's `ai.align` completion is what writes the editing document
   * for a project that never ran a transcription (`align-completion.handler.ts`
   * → `edgService.initialise`), so it changes which screen the user should be on
   * for exactly the same reason. `"ai.align"` is `queue-names.ts` line 18.
   */
  it("announces a finished subtitle alignment", async () => {
    expect(await deliver("ai.align")).toEqual(["01JPROJECT"]);
  });

  it("stays quiet for any other completed job", async () => {
    expect(await deliver("render.video")).toEqual([]);
  });

  /**
   * S-06. The shell announced successes only (`data.status === "succeeded"`), so
   * a failed transcription or import was silent everywhere except the waiting
   * screen the user had to already be sitting on. The job row said `failed` and
   * nobody was told.
   */
  it("toasts a failed transcription with the failure's own message", async () => {
    const error = vi.spyOn(toast, "error");
    const success = vi.spyOn(toast, "success");
    try {
      const announced = await deliver("ai.transcribe", {
        status: "failed",
        error: { message: "The ASR provider timed out." },
      });

      // Nothing is ready, so nothing is announced to the editor's store.
      expect(announced).toEqual([]);
      await waitFor(() => {
        expect(error).toHaveBeenCalledTimes(1);
      });
      expect(error).toHaveBeenCalledWith(
        "Transcription failed",
        expect.objectContaining({
          description: "The ASR provider timed out.",
          action: expect.objectContaining({ label: "Open project" }),
        }),
      );
      // One completion, one toast — never both branches.
      expect(success).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      success.mockRestore();
    }
  });
});
