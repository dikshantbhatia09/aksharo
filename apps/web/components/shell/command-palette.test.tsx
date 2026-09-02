import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { CommandPalette, useCommandPalette } from "./command-palette";

import { routerMock } from "@/test/next-router";

describe("useCommandPalette", () => {
  it("toggles on Ctrl+K", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useCommandPalette());
    expect(result.current.open).toBe(false);

    await user.keyboard("{Control>}k{/Control}");
    expect(result.current.open).toBe(true);

    await user.keyboard("{Control>}k{/Control}");
    expect(result.current.open).toBe(false);
  });

  it("toggles on ⌘K", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useCommandPalette());
    await user.keyboard("{Meta>}k{/Meta}");
    expect(result.current.open).toBe(true);
  });

  it("ignores a bare k, so typing in a field does not open it", async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useCommandPalette());
    await user.keyboard("k");
    expect(result.current.open).toBe(false);
  });

  it("stops listening once unmounted", async () => {
    const user = userEvent.setup();
    const { result, unmount } = renderHook(() => useCommandPalette());
    unmount();
    await user.keyboard("{Control>}k{/Control}");
    expect(result.current.open).toBe(false);
  });
});

describe("<CommandPalette />", () => {
  const recent = [
    { id: "01JP1", title: "Diwali reel cut 3", href: "/p/01JP1" },
    { id: "01JP2", title: "Podcast ep 12", href: "/p/01JP2" },
  ];

  it("has an accessible name even though it shows no heading", () => {
    render(<CommandPalette open onOpenChange={() => undefined} />);
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
  });

  it("lists recent projects and the actions", () => {
    render(<CommandPalette open onOpenChange={() => undefined} recentProjects={recent} />);
    expect(screen.getByText("Diwali reel cut 3")).toBeInTheDocument();
    expect(screen.getByText("New project")).toBeInTheDocument();
    expect(screen.getByText("Privacy and consents")).toBeInTheDocument();
  });

  it("omits the recent-projects group when there is no history", () => {
    render(<CommandPalette open onOpenChange={() => undefined} />);
    expect(screen.queryByText("Recent projects")).toBeNull();
  });

  it("filters as the user types", async () => {
    const user = userEvent.setup();
    render(<CommandPalette open onOpenChange={() => undefined} recentProjects={recent} />);
    await user.type(screen.getByTestId("command-input"), "podcast");
    expect(screen.getByText("Podcast ep 12")).toBeInTheDocument();
    expect(screen.queryByText("Diwali reel cut 3")).toBeNull();
  });

  it("navigates and closes when an item is chosen", async () => {
    const user = userEvent.setup();
    let open = true;
    render(
      <CommandPalette
        open
        onOpenChange={(value) => {
          open = value;
        }}
        recentProjects={recent}
      />,
    );

    await user.click(screen.getByText("Podcast ep 12"));
    expect(routerMock.push).toHaveBeenCalledWith("/p/01JP2");
    expect(open).toBe(false);
  });

  it("only offers destinations that exist", () => {
    render(<CommandPalette open onOpenChange={() => undefined} />);
    // "Templates" is not built yet, so it must not be a one-keystroke path to
    // a 404; "Projects" landed in A14 and is now offered.
    expect(screen.queryByText("Templates")).toBeNull();
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Projects")).toBeInTheDocument();
  });

  it("runs a caller-supplied action", async () => {
    const user = userEvent.setup();
    let ran = false;
    render(
      <CommandPalette
        open
        onOpenChange={() => undefined}
        extraActions={[
          {
            id: "custom",
            label: "Do the thing",
            run: () => {
              ran = true;
            },
          },
        ]}
      />,
    );
    await act(async () => {
      await user.click(screen.getByText("Do the thing"));
    });
    expect(ran).toBe(true);
  });
});
