import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ApiError } from "@montaj/api-client";

import { GUEST_LINK_COPY, describeGuestLinkError } from "./guest-copy";
import { ShareWithGuest, type GuestClipChoice } from "./ShareWithGuest";

import type { CreatedGuestLink, GuestLink } from "./use-guest-links";

import { beginnerSafetyViolations } from "@/components/repurpose/copy";
import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";
const LINKS = `/repurpose/runs/${RUN}/guest-links`;
const ON = { flags: { "shares.public": true } };
const CLIPS: readonly GuestClipChoice[] = [
  { id: "01JS00000000000000000CL1PA", title: "Why most people never save" },
  { id: "01JS00000000000000000CL1PB", title: "The one habit" },
  { id: "01JS00000000000000000CL1PC", title: "What I would tell my younger self" },
];

function link(over: Partial<GuestLink> = {}): GuestLink {
  return {
    id: "01JS000000000000000000LNK1",
    runId: RUN,
    hint: "a7Bq",
    guestName: "Priya",
    allClips: false,
    clipIds: [CLIPS[0]?.id ?? ""],
    clipCount: 1,
    includeDubs: false,
    expiresAt: "2026-10-19T06:00:00.000Z",
    revokedAt: null,
    status: "live",
    createdBy: "01JUSER",
    createdAt: "2026-10-05T06:00:00.000Z",
    visits: 2,
    lastVisitAt: null,
    downloads: 5,
    lastDownloadAt: null,
    ...over,
  };
}

function calls(
  fetchMock: ReturnType<typeof renderWithProviders>["fetchMock"],
  path: string,
  method: string,
): unknown[] {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        new URL(String(input)).pathname === path &&
        ((init as RequestInit | undefined)?.method ?? "GET") === method,
    )
    .map(([, init]) => {
      const body = (init as RequestInit | undefined)?.body;
      return body === undefined ? null : (JSON.parse(String(body)) as unknown);
    });
}

function share(
  props: Partial<React.ComponentProps<typeof ShareWithGuest>> = {},
  routes: Record<string, unknown> = {},
) {
  return renderWithProviders(
    <ShareWithGuest
      runId={RUN}
      clips={CLIPS}
      canShare
      needsApproval={false}
      hasDubs={false}
      {...props}
    />,
    { config: ON, routes },
  );
}

const CREATED: CreatedGuestLink = {
  ...link({ id: "01JS000000000000000000LNK2", hint: "Zq9x", visits: 0, downloads: 0 }),
  url: "https://aksharo.test/share/guest/abcdefghijklmnopqrstZq9x",
};

describe("<ShareWithGuest />", () => {
  it("shows nothing while public links are off, or to someone who may not share", () => {
    const off = renderWithProviders(
      <ShareWithGuest runId={RUN} clips={CLIPS} canShare needsApproval={false} hasDubs={false} />,
      { config: { flags: { "shares.public": false } } },
    );
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();
    const viewer = share({ canShare: false });
    expect(viewer.container).toBeEmptyDOMElement();
  });

  it("shares every clip for 14 days by default, greets the guest by name, and shows the link once", async () => {
    const user = userEvent.setup();
    const { fetchMock } = share({}, { [LINKS]: CREATED });
    await user.click(screen.getByTestId("share-with-guest-open"));
    const dialog = await screen.findByTestId("share-with-guest-dialog");
    expect(within(dialog).getByTestId("guest-link-days")).toHaveValue("14");
    expect(within(dialog).queryByTestId("guest-link-include-dubs")).not.toBeInTheDocument();
    expect(within(dialog).queryByTestId("guest-link-approval-note")).not.toBeInTheDocument();
    await user.type(within(dialog).getByTestId("guest-link-name"), "Priya");
    await user.click(within(dialog).getByTestId("guest-link-create"));
    expect(await within(dialog).findByTestId("guest-link-url")).toHaveValue(CREATED.url);
    expect(calls(fetchMock, LINKS, "POST")).toEqual([
      { allClips: true, clipIds: [], expiresInDays: 14, includeDubs: false, guestName: "Priya" },
    ]);
    expect(within(dialog).queryByTestId("guest-link-create")).not.toBeInTheDocument();
  });

  it("shares a choice of clips, and will not share none", async () => {
    const user = userEvent.setup();
    const { fetchMock } = share({}, { [LINKS]: CREATED });
    await user.click(screen.getByTestId("share-with-guest-open"));
    const dialog = await screen.findByTestId("share-with-guest-dialog");
    await user.click(within(dialog).getByTestId("guest-link-all-clips"));
    const list = within(dialog).getByTestId("guest-link-clips");
    // Every clip starts chosen: the guest is usually in most of them.
    for (const clip of CLIPS) {
      expect(within(list).getByTestId(`guest-link-clip-${clip.id}`)).toBeChecked();
    }
    for (const clip of CLIPS)
      await user.click(within(list).getByTestId(`guest-link-clip-${clip.id}`));
    await user.click(within(dialog).getByTestId("guest-link-create"));
    expect(within(dialog).getByRole("alert")).toHaveTextContent(GUEST_LINK_COPY.noneChosen);
    expect(calls(fetchMock, LINKS, "POST")).toEqual([]);

    await user.click(within(list).getByTestId(`guest-link-clip-${CLIPS[2]?.id ?? ""}`));
    await user.click(within(list).getByTestId(`guest-link-clip-${CLIPS[0]?.id ?? ""}`));
    await user.selectOptions(within(dialog).getByTestId("guest-link-days"), "3");
    await user.click(within(dialog).getByTestId("guest-link-create"));
    await within(dialog).findByTestId("guest-link-url");
    expect(calls(fetchMock, LINKS, "POST")).toEqual([
      {
        allClips: false,
        clipIds: [CLIPS[0]?.id, CLIPS[2]?.id],
        expiresInDays: 3,
        includeDubs: false,
      },
    ]);
  });

  it("offers the dubbed versions when the run has them, and says when clips wait for approval", async () => {
    const user = userEvent.setup();
    const { fetchMock } = share({ hasDubs: true, needsApproval: true }, { [LINKS]: CREATED });
    await user.click(screen.getByTestId("share-with-guest-open"));
    const dialog = await screen.findByTestId("share-with-guest-dialog");
    expect(within(dialog).getByTestId("guest-link-approval-note")).toHaveTextContent(
      GUEST_LINK_COPY.approvalNote,
    );
    const dubs = within(dialog).getByTestId("guest-link-include-dubs");
    expect(dubs).not.toBeChecked();
    await user.click(dubs);
    await user.click(within(dialog).getByTestId("guest-link-create"));
    await within(dialog).findByTestId("guest-link-url");
    expect(calls(fetchMock, LINKS, "POST")).toEqual([
      expect.objectContaining({ includeDubs: true }),
    ]);
  });

  it("lists the links with their clips, visits and downloads, and turns one off after asking", async () => {
    const user = userEvent.setup();
    const { fetchMock } = share(
      {},
      {
        [LINKS]: {
          links: [
            link(),
            link({
              id: "01JS000000000000000000LNK3",
              guestName: null,
              allClips: true,
              clipCount: 3,
              status: "expired",
              visits: 1,
              downloads: 1,
            }),
          ],
        },
        [`${LINKS}/01JS000000000000000000LNK1`]: link({ status: "revoked" }),
      },
    );
    await user.click(screen.getByTestId("share-with-guest-open"));
    const dialog = await screen.findByTestId("share-with-guest-dialog");
    const live = await within(dialog).findByTestId("guest-link-01JS000000000000000000LNK1");
    expect(live).toHaveTextContent("For Priya");
    expect(
      within(live).getByTestId("guest-link-01JS000000000000000000LNK1-stats"),
    ).toHaveTextContent("Works until 19 Oct · 1 clip · opened 2 times · 5 downloads");
    const expired = within(dialog).getByTestId("guest-link-01JS000000000000000000LNK3");
    expect(expired).toHaveTextContent("…a7Bq");
    expect(expired).toHaveTextContent("Expired · every clip (3) · opened once · 1 download");
    expect(within(expired).queryByRole("button", { name: /Turn off/ })).not.toBeInTheDocument();

    await user.click(within(live).getByRole("button", { name: "Turn off: For Priya" }));
    await user.click(
      await screen.findByTestId("guest-link-revoke-confirm-01JS000000000000000000LNK1"),
    );
    await waitFor(() => {
      expect(calls(fetchMock, `${LINKS}/01JS000000000000000000LNK1`, "DELETE")).toHaveLength(1);
    });
  });

  it("says why a link could not be made", async () => {
    const user = userEvent.setup();
    share(
      {},
      {
        [LINKS]: new Response(
          JSON.stringify({
            error: {
              code: "guest/too_many_links",
              message:
                "This video already has 20 guest links. Turn off one you no longer need first.",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
      },
    );
    await user.click(screen.getByTestId("share-with-guest-open"));
    const dialog = await screen.findByTestId("share-with-guest-dialog");
    await user.click(within(dialog).getByTestId("guest-link-create"));
    expect(await within(dialog).findByTestId("guest-link-error")).toHaveTextContent(
      "This video already has 20 guest links.",
    );
  });
});

describe("guest link words", () => {
  it("never name a tool, a queue or a codename", () => {
    const sentences: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") sentences.push(value);
      else if (typeof value === "function") {
        sentences.push(String((value as (...args: unknown[]) => unknown)(3, 1)));
      } else if (value !== null && typeof value === "object") {
        for (const entry of Object.values(value)) walk(entry);
      }
    };
    walk(GUEST_LINK_COPY);
    for (const text of sentences) expect(beginnerSafetyViolations(text), text).toEqual([]);
  });

  it("explain a refusal in a sentence", () => {
    expect(describeGuestLinkError(new Error("offline"))).toMatch(/could not reach/);
    expect(
      describeGuestLinkError(
        new ApiError({ status: 400, code: "guest/clip_not_in_run", message: "Choose again." }),
      ),
    ).toBe("Choose again.");
    expect(
      describeGuestLinkError(
        new ApiError({ status: 404, code: "guest/link_not_found", message: "" }),
      ),
    ).toBe("That guest link is no longer here.");
  });
});
