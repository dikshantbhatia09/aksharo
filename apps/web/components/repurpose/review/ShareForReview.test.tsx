import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ShareForReview } from "./ShareForReview";

import type { CreatedReviewLink, ReviewLink, ReviewPermissions } from "./use-review";

import { renderWithProviders } from "@/test/harness";

const RUN = "01JS0000000000000000000RUN";
const LINKS = `/repurpose/runs/${RUN}/review-links`;
const ON = { flags: { "shares.public": true } };

const ADMIN: ReviewPermissions = {
  approve: true,
  requestChanges: true,
  comment: true,
  resolveAny: true,
  shareLinks: true,
  revokeLinks: true,
};
const EDITOR: ReviewPermissions = { ...ADMIN, approve: false, shareLinks: false };
const VIEWER: ReviewPermissions = {
  ...EDITOR,
  requestChanges: false,
  resolveAny: false,
  revokeLinks: false,
};

function link(over: Partial<ReviewLink> = {}): ReviewLink {
  return {
    id: "01JS000000000000000000LNK1",
    runId: RUN,
    hint: "a7Bq",
    label: "For Priya",
    requireName: true,
    expiresAt: "2026-10-10T06:00:00.000Z",
    revokedAt: null,
    status: "live",
    createdBy: "01JUSER",
    createdAt: "2026-10-03T06:00:00.000Z",
    visits: 2,
    lastVisitAt: null,
    decisions: 3,
    comments: 1,
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

describe("<ShareForReview />", () => {
  it("shows nothing while public links are off, or to a viewer", () => {
    const off = renderWithProviders(<ShareForReview runId={RUN} permissions={ADMIN} />, {
      config: { flags: { "shares.public": false } },
    });
    expect(off.container).toBeEmptyDOMElement();
    off.unmount();
    const viewer = renderWithProviders(<ShareForReview runId={RUN} permissions={VIEWER} />, {
      config: ON,
    });
    expect(viewer.container).toBeEmptyDOMElement();
  });

  it("lets an admin make a link, and shows it once", async () => {
    const user = userEvent.setup();
    const created: CreatedReviewLink = {
      ...link({ id: "01JS000000000000000000LNK2", label: null, hint: "Zq9x", visits: 0 }),
      url: "https://aksharo.test/share/review/abcdefghijklmnopqrstZq9x",
    };
    const { fetchMock } = renderWithProviders(<ShareForReview runId={RUN} permissions={ADMIN} />, {
      config: ON,
      routes: { [LINKS]: created },
    });
    await user.click(screen.getByTestId("share-for-review-open"));
    const dialog = await screen.findByTestId("share-for-review-dialog");
    await user.selectOptions(within(dialog).getByTestId("review-link-days"), "3");
    await user.type(within(dialog).getByLabelText(/Name this link/), "For Priya");
    await user.click(within(dialog).getByTestId("review-link-create"));
    expect(await within(dialog).findByTestId("review-link-url")).toHaveValue(created.url);
    expect(calls(fetchMock, LINKS, "POST")).toEqual([
      { expiresInDays: 3, requireName: true, label: "For Priya" },
    ]);
  });

  it("tells an editor only an owner or admin can share, and lets them turn a link off", async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderWithProviders(<ShareForReview runId={RUN} permissions={EDITOR} />, {
      config: ON,
      routes: {
        [LINKS]: { links: [link(), link({ id: "01JS000000000000000000LNK3", status: "expired" })] },
        [`${LINKS}/01JS000000000000000000LNK1`]: link({ status: "revoked" }),
      },
    });
    await user.click(screen.getByTestId("share-for-review-open"));
    const dialog = await screen.findByTestId("share-for-review-dialog");
    expect(within(dialog).getByTestId("review-link-admin-only")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("review-link-create")).not.toBeInTheDocument();
    const live = await within(dialog).findByTestId("review-link-01JS000000000000000000LNK1");
    expect(live).toHaveTextContent("For Priya");
    expect(live).toHaveTextContent("opened 2 times");
    expect(live).toHaveTextContent("3 decisions, 1 comment");
    expect(within(dialog).getByTestId("review-link-01JS000000000000000000LNK3")).toHaveTextContent(
      "Expired",
    );

    // Turning a link off cannot be undone, so it asks first.
    await user.click(within(live).getByRole("button", { name: "Turn off: For Priya" }));
    await user.click(
      await screen.findByTestId("review-link-revoke-confirm-01JS000000000000000000LNK1"),
    );
    await waitFor(() => {
      expect(calls(fetchMock, `${LINKS}/01JS000000000000000000LNK1`, "DELETE")).toHaveLength(1);
    });
  });
});
