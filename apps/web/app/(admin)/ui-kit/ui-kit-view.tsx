"use client";

import { Sparkles } from "lucide-react";
import * as React from "react";

import {
  Badge,
  Button,
  Card,
  Checkbox,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CreditMeter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  Input,
  JOB_STAGES,
  JobProgress,
  LangChip,
  ProgressBar,
  Separator,
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  ShortcutHint,
  Skeleton,
  StatusChip,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UpgradeGate,
  ACCENT,
  SIGNAL,
  SURFACE,
  TEXT,
} from "@montaj/ui";

/**
 * Every component, in every state that matters, on one page.
 *
 * There is no Storybook in this repo (brief §2), so this route is the review
 * surface: Playwright screenshots it into `e2e/__screenshots__/` for Fable, and
 * the axe pass runs over it, which means a primitive that is inaccessible fails
 * a test rather than shipping into thirty screens.
 */
export function UiKitView(): React.JSX.Element {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10" data-testid="ui-kit">
      <header className="flex flex-col gap-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">UI kit</h1>
        <p className="text-fg-2 text-sm">
          Every design token and component in the shared UI package, for screenshot review.
        </p>
      </header>

      <Section title="Palette">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="kit-palette">
          {[
            ["bg-0", SURFACE.bg0],
            ["bg-1", SURFACE.bg1],
            ["bg-2", SURFACE.bg2],
            ["border", SURFACE.border],
            ["fg-0", TEXT.fg0],
            ["fg-1", TEXT.fg1],
            ["fg-2", TEXT.fg2],
            ["disabled", TEXT.disabled],
            ["lime-500", ACCENT.lime500],
            ["lime-600", ACCENT.lime600],
            ["proposed", SIGNAL.proposed],
            ["accepted", SIGNAL.accepted],
            ["rejected", SIGNAL.rejected],
            ["info", SIGNAL.info],
            ["warning", SIGNAL.warning],
          ].map(([name, value]) => (
            <div key={name} className="border-border flex items-center gap-2 rounded-sm border p-2">
              <span
                aria-hidden="true"
                className="size-8 shrink-0 rounded-sm"
                style={{ backgroundColor: value }}
              />
              <span className="flex flex-col">
                <span className="text-fg-1 text-xs">{name}</span>
                <span className="text-fg-2 font-mono text-2xs">{value}</span>
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Type">
        <div className="flex flex-col gap-2">
          <p className="font-display text-3xl font-semibold">Bricolage Grotesque display</p>
          <p className="text-xl">Inter, the UI face, at 22 px</p>
          <p className="text-sm">Inter at 14 px — the size most of the studio is set in.</p>
          <p className="font-mono text-sm">00:01:23.456 · JetBrains Mono for timecodes</p>
          <p className="text-fg-2 text-2xs">11 px, for meter captions and shortcut hints</p>
        </div>
      </Section>

      <Section title="Button">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="link">Link</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
          <Button variant="secondary" size="sm">
            Small
          </Button>
          <Button variant="secondary" size="lg">
            Large
          </Button>
          <Button variant="ghost" size="icon" aria-label="Sparkles">
            <Sparkles aria-hidden="true" />
          </Button>
        </div>
      </Section>

      <Section title="Form controls">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" htmlFor="kit-email" hint="We never show this to anyone.">
            <Input id="kit-email" placeholder="you@example.com" />
          </Field>
          <Field
            label="Email"
            htmlFor="kit-email-invalid"
            error="That does not look like an email."
          >
            <Input id="kit-email-invalid" defaultValue="not-an-email" invalid />
          </Field>
          <Field label="Notes" htmlFor="kit-notes">
            <Textarea id="kit-notes" placeholder="Anything we should know" />
          </Field>
          <div className="flex flex-col gap-3 pt-6">
            <label className="flex items-center gap-2 text-sm">
              <Switch id="kit-switch" defaultChecked={false} /> Switch (off by default)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox id="kit-checkbox" /> Checkbox
            </label>
          </div>
        </div>
      </Section>

      <Section title="CreditMeter">
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CreditMeter
              remainingTenths={4120}
              includedTenths={5000}
              resetsAt="2026-09-30T00:00:00.000Z"
              burnRateTenthsPerDay={180}
            />
          </Card>
          <Card>
            <CreditMeter
              remainingTenths={900}
              includedTenths={5000}
              resetsAt="2026-09-30T00:00:00.000Z"
            />
          </Card>
          <Card>
            <CreditMeter
              remainingTenths={200}
              includedTenths={5000}
              resetsAt="2026-09-30T00:00:00.000Z"
              streakDays={7}
              showStreak
              onTopUp={() => {
                toast("Checkout sheet lands with B03");
              }}
            />
          </Card>
        </div>
      </Section>

      <Section title="JobProgress">
        <div className="flex flex-col gap-4">
          {JOB_STAGES.map((stage) => (
            <JobProgress key={stage} stage={stage} progress={45} etaMs={95_000} />
          ))}
          <JobProgress
            stage="transcribing"
            error="We could not read the audio track. Try re-uploading the clip."
            onRetry={() => {
              toast("Retry");
            }}
          />
        </div>
      </Section>

      <Section title="UpgradeGate">
        <div className="grid gap-3 sm:grid-cols-2">
          <UpgradeGate
            requiredPlan="creator"
            feature="Exporting without a watermark"
            price="₹699/mo"
            onUpgrade={() => {
              toast("Checkout sheet lands with B03");
            }}
          />
          <UpgradeGate requiredPlan="studio" feature="4K export" />
        </div>
      </Section>

      <Section title="Chips and status">
        <div className="flex flex-wrap items-center gap-2">
          {(["draft", "queued", "processing", "ready", "failed", "archived"] as const).map(
            (status) => (
              <StatusChip key={status} status={status} />
            ),
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {["hi-Latn", "hi", "en", "ta", "bn", "ml"].map((language) => (
            <LangChip key={language} language={language} />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Badge>Neutral</Badge>
          <Badge tone="accent">Accent</Badge>
          <Badge tone="warning">Warning</Badge>
          <span className="text-fg-1 flex items-center gap-2 text-sm">
            Command palette <ShortcutHint keys={["Ctrl", "K"]} />
          </span>
        </div>
      </Section>

      <Section title="Progress and skeleton">
        <div className="flex flex-col gap-3">
          <ProgressBar value={20} label="Twenty per cent" />
          <ProgressBar value={60} tone="warning" label="Sixty per cent" />
          <ProgressBar value={95} tone="rejected" label="Ninety-five per cent" />
          <Skeleton className="h-8 w-64" />
        </div>
      </Section>

      <Section title="Overlays">
        <div className="flex flex-wrap items-center gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="secondary">Open dialog</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete this project?</DialogTitle>
                <DialogDescription>
                  The media, transcript and exports go with it. This cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="ghost">Keep it</Button>
                <Button variant="danger">Delete</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Sheet>
            <SheetTrigger asChild>
              <Button variant="secondary">Open sheet</Button>
            </SheetTrigger>
            <SheetContent aria-describedby={undefined}>
              <SheetHeader>
                <SheetTitle className="text-fg-0 text-base font-medium">Project details</SheetTitle>
              </SheetHeader>
              <SheetBody>
                <p className="text-fg-2 text-sm">The detail panel A14 fills in.</p>
              </SheetBody>
            </SheetContent>
          </Sheet>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">Open menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Open</DropdownMenuItem>
              <DropdownMenuItem>Duplicate</DropdownMenuItem>
              <DropdownMenuItem>Export</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="secondary">Hover me</Button>
            </TooltipTrigger>
            <TooltipContent>A tooltip, 200 ms in.</TooltipContent>
          </Tooltip>

          <Button
            variant="secondary"
            onClick={() => {
              toast.success("Saved", { description: "Your defaults are set." });
            }}
          >
            Show toast
          </Button>
        </div>
      </Section>

      <Section title="Tabs">
        <Tabs defaultValue="roman">
          <TabsList>
            <TabsTrigger value="roman">Roman</TabsTrigger>
            <TabsTrigger value="native">Native</TabsTrigger>
            <TabsTrigger value="en">English</TabsTrigger>
          </TabsList>
          <TabsContent value="roman">
            <p className="text-fg-1 text-sm">Aaj hum baat karenge editing ke baare mein.</p>
          </TabsContent>
          <TabsContent value="native">
            <p className="text-fg-1 text-sm" lang="hi">
              आज हम बात करेंगे एडिटिंग के बारे में।
            </p>
          </TabsContent>
          <TabsContent value="en">
            <p className="text-fg-1 text-sm">Today we are going to talk about editing.</p>
          </TabsContent>
        </Tabs>
      </Section>

      <Section title="Command palette (inline)">
        <div className="border-border bg-bg-1 max-w-md rounded-md border">
          <Command>
            <CommandInput placeholder="Search projects and actions" />
            <CommandList>
              <CommandEmpty>Nothing matches that.</CommandEmpty>
              <CommandGroup heading="Actions">
                <CommandItem value="new-project">
                  <Sparkles aria-hidden="true" />
                  New project
                  <ShortcutHint keys={["Ctrl", "N"]} />
                </CommandItem>
                <CommandItem value="settings">Open settings</CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </Section>

      <Section title="EmptyState">
        <EmptyState
          icon={<Sparkles />}
          title="No projects yet"
          description="Drop a clip and you will have captions in about a minute."
          action={<Button variant="primary">Try with a sample</Button>}
        />
      </Section>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4" data-kit-section={title}>
      <div className="flex items-center gap-3">
        <h2 className="text-fg-0 text-base font-medium">{title}</h2>
        <Separator className="flex-1" />
      </div>
      {children}
    </section>
  );
}
