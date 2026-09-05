import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "./context-menu";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./dialog";
import { Input } from "./input";
import { Field } from "./label";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "./sheet";
import { ProgressBar } from "./surface";
import { Checkbox, Switch } from "./toggles";

describe("<Button />", () => {
  it("defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "button");
  });

  it("renders the child element with asChild", () => {
    render(
      <Button asChild>
        <a href="/settings/profile">Profile</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Profile" });
    expect(link).toHaveAttribute("href", "/settings/profile");
    expect(link.className).toContain("inline-flex");
  });

  it("paints lime for the primary action", () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole("button").className).toContain("bg-lime-500");
  });
});

describe("<Field />", () => {
  it("labels the control and announces the error", () => {
    render(
      <Field label="Email" htmlFor="email" error="Enter a valid email address.">
        <Input id="email" />
      </Field>,
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a valid email address.");
  });

  it("shows the hint only while there is no error", () => {
    const { rerender } = render(
      <Field label="Date of birth" htmlFor="dob" hint="We ask once, to apply the right age rules.">
        <Input id="dob" />
      </Field>,
    );
    expect(screen.getByText(/we ask once/i)).toBeInTheDocument();
    rerender(
      <Field label="Date of birth" htmlFor="dob" hint="We ask once." error="Required.">
        <Input id="dob" />
      </Field>,
    );
    expect(screen.queryByText(/we ask once/i)).toBeNull();
  });
});

describe("<Input />", () => {
  it("marks itself invalid for assistive technology", () => {
    render(<Input aria-label="Email" invalid />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("aria-invalid", "true");
  });
});

describe("<Dialog />", () => {
  it("opens with an accessible name and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Delete account</DialogTitle>
          <DialogDescription>This cannot be undone.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "Delete account" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("<Sheet />", () => {
  it("opens from an edge with an accessible name", async () => {
    const user = userEvent.setup();
    render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Menu</Button>
        </SheetTrigger>
        <SheetContent side="left" aria-describedby={undefined}>
          <SheetTitle>Navigation</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    await user.click(screen.getByRole("button", { name: "Menu" }));
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  });
});

describe("<Switch /> and <Checkbox />", () => {
  it("start off — nothing is pre-consented (D60)", () => {
    render(
      <>
        <Switch aria-label="Product analytics" />
        <Checkbox aria-label="Remember my spellings" />
      </>,
    );
    expect(screen.getByRole("switch", { name: "Product analytics" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Remember my spellings" })).not.toBeChecked();
  });

  it("reports a change", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Analytics" onCheckedChange={onCheckedChange} />);
    await user.click(screen.getByRole("switch"));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});

describe("<ProgressBar />", () => {
  it("clamps out-of-range values", () => {
    const { rerender } = render(<ProgressBar value={-20} label="Upload" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    rerender(<ProgressBar value={220} label="Upload" />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});

describe("<CommandDialog />", () => {
  it("has an accessible name even though the palette shows no heading", async () => {
    render(
      <CommandDialog
        open
        onOpenChange={() => undefined}
        label="Command palette"
        description="Search"
      >
        <CommandInput placeholder="Search projects and actions" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandGroup heading="Actions">
            <CommandItem value="new-project">New project</CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>,
    );
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search projects and actions")).toBeInTheDocument();
  });

  it("filters as the user types", async () => {
    const user = userEvent.setup();
    render(
      <Command>
        <CommandInput placeholder="Search" />
        <CommandList>
          <CommandEmpty>Nothing matches.</CommandEmpty>
          <CommandItem value="new-project">New project</CommandItem>
          <CommandItem value="open-settings">Open settings</CommandItem>
        </CommandList>
      </Command>,
    );
    await user.type(screen.getByPlaceholderText("Search"), "sett");
    expect(screen.queryByText("New project")).toBeNull();
    expect(screen.getByText("Open settings")).toBeInTheDocument();
  });
});

describe("<ContextMenu />", () => {
  function Fixture({ onSelect }: { readonly onSelect: () => void }): React.JSX.Element {
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div data-testid="cm-trigger">Right-click me</div>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="cm-content">
          <ContextMenuItem onSelect={onSelect}>
            Split here <ContextMenuShortcut>S</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" disabled>
            Delete word
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  it("opens on the contextmenu gesture and runs the item that was chosen", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<Fixture onSelect={onSelect} />);

    expect(screen.queryByTestId("cm-content")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("cm-trigger"), { clientX: 12, clientY: 20 });
    expect(await screen.findByTestId("cm-content")).toBeInTheDocument();

    await user.click(screen.getByText("Split here"));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("paints the destructive row red and refuses a disabled row", () => {
    render(<Fixture onSelect={vi.fn()} />);
    fireEvent.contextMenu(screen.getByTestId("cm-trigger"), { clientX: 12, clientY: 20 });

    const destructive = screen.getByText("Delete word");
    expect(destructive.className).toContain("text-red-400");
    expect(destructive).toHaveAttribute("data-disabled");
  });
});
