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
  PageHeader,
  ACCENT,
  ACCENT_RAMP,
  NEUTRAL,
  SIGNAL,
  SURFACE,
  TEXT,
} from "@montaj/ui";

/** The Shirorekha type scale (DESIGN.md › Type), smallest first. */
const TYPE_SCALE = [
  { px: 11, className: "text-2xs", use: "Meta only: shortcut hints, timestamps" },
  { px: 12, className: "text-xs", use: "The smallest interactive text" },
  { px: 14, className: "text-sm", use: "Body, controls, tables" },
  { px: 16, className: "text-base", use: "Section headings" },
  { px: 18, className: "text-lg", use: "Dialog titles" },
  { px: 22, className: "text-xl", use: "Large figures" },
  { px: 28, className: "text-2xl", use: "Page titles (PageHeader md)" },
  { px: 36, className: "text-3xl", use: "Landing titles" },
  { px: 44, className: "text-[2.75rem] leading-[3rem]", use: "Hero (PageHeader lg)" },
] as const;

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
    <main
      className="mx-auto flex w-full max-w-5xl flex-col gap-12 bg-bg-0 px-4 py-10 sm:px-6"
      data-testid="ui-kit"
    >
      <PageHeader
        eyebrow="Shirorekha design system"
        title="UI kit"
        description="Every token and shared component in @montaj/ui, in the states that matter, for screenshot and accessibility review."
      />

      <Section title="Palette">
        <div className="flex flex-col gap-6" data-testid="kit-palette">
          <Swatches
            label="Surfaces"
            items={[
              ["bg-0 · page", SURFACE.bg0],
              ["bg-1 · surface", SURFACE.bg1],
              ["bg-2 · raised", SURFACE.bg2],
              ["sunken · rails", SURFACE.sunken],
              ["ink · video", SURFACE.ink],
              ["border", SURFACE.border],
            ]}
          />
          <Swatches
            label="Text"
            items={[
              ["fg-0 · primary", TEXT.fg0],
              ["fg-1 · secondary", TEXT.fg1],
              ["fg-2 · muted", TEXT.fg2],
              ["disabled", TEXT.disabled],
            ]}
          />
          <Swatches
            label="Accent (rani): the one filled primary, the shirorekha, selection"
            items={[
              ["accent", ACCENT.lime500],
              ["on-accent", ACCENT.onAccent],
              ...Object.entries(ACCENT_RAMP).map(
                ([step, value]) => [`accent-${step}`, value] as const,
              ),
            ]}
          />
          <Swatches
            label="Neutral ramp"
            items={Object.entries(NEUTRAL).map(
              ([step, value]) => [`neutral-${step}`, value] as const,
            )}
          />
          <Swatches
            label="Signals: state, never decoration"
            items={[
              ["proposed", SIGNAL.proposed],
              ["accepted", SIGNAL.accepted],
              ["rejected", SIGNAL.rejected],
              ["info", SIGNAL.info],
              ["warning", SIGNAL.warning],
            ]}
          />
        </div>
      </Section>

      <Section title="Type">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1">
            <p className="font-display text-3xl font-semibold [font-stretch:92%]">
              Anek Latin, the display face
            </p>
            <p className="text-sm text-fg-2">
              Page titles (through PageHeader), the marketing hero and large stat figures. Nowhere
              else.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="text-base">Inter, the interface face</p>
            <p className="text-sm text-fg-2">Every control, label, table and paragraph.</p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-mono text-sm">00:01:23.456 · 01JWORKSPACE · Ctrl K</p>
            <p className="text-sm text-fg-2">JetBrains Mono, for timecodes, IDs and keys.</p>
          </div>
          <p className="text-base">
            <span lang="hi">आज हम बात करेंगे एडिटिंग के बारे में</span>
            <span className="text-sm text-fg-2"> · Devanagari falls back to Noto.</span>
          </p>
          <ol className="flex flex-col divide-y divide-border rounded-md border border-border bg-surface">
            {TYPE_SCALE.map((step) => (
              <li
                key={step.px}
                className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span className="w-16 shrink-0 font-mono text-xs text-fg-2">{step.px} px</span>
                <span className={`${step.className} min-w-0 truncate text-fg-0`}>
                  Akshar, the written syllable
                </span>
                <span className="text-xs text-fg-2 sm:ml-auto sm:shrink-0">{step.use}</span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <Section title="PageHeader and the shirorekha">
        <div className="flex flex-col gap-4">
          <p className="max-w-2xl text-sm text-fg-1">
            The signature: a 32 × 3 px rani bar above each page title, the way Devanagari letters
            hang from their headline. Exactly once per page, through PageHeader. Never on cards,
            rows, dialog titles or buttons. The two samples below are demonstrations inside the kit,
            rendered as h2 so this page keeps one h1.
          </p>
          <div className="rounded-md border border-border bg-surface p-5">
            <PageHeader
              as="h2"
              eyebrow="Projects"
              title="Your captions"
              description="The md size, for every app page. Actions sit on the trailing edge."
              actions={
                <>
                  <Button variant="secondary">Import</Button>
                  <Button variant="primary">New project</Button>
                </>
              }
            />
          </div>
          <div className="rounded-md border border-border bg-surface p-5">
            <PageHeader
              as="h2"
              size="lg"
              title="Captions for Hindi and Hinglish"
              description="The lg size, for Home and the marketing hero only."
            />
          </div>
        </div>
      </Section>

      <Section title="Button">
        <p className="max-w-2xl text-sm text-fg-1">
          Primary is a rani fill with ink text and appears once per surface; everything else is
          secondary or ghost. Danger is filled in the rejected hue so it never reads as the brand
          action.
        </p>
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
          <Button variant="ghost" size="icon" aria-label="Suggest a style">
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
          action={<Button variant="secondary">Try with a sample</Button>}
        />
      </Section>
    </main>
  );
}

function Swatches({
  label,
  items,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-fg-1">{label}</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {items.map(([name, value]) => (
          <li
            key={name}
            className="flex min-w-0 items-center gap-2 rounded-sm border border-border bg-surface p-2"
          >
            <span
              aria-hidden="true"
              className="size-8 shrink-0 rounded-sm border border-border"
              style={{ backgroundColor: value }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs text-fg-1">{name}</span>
              <span className="font-mono text-2xs text-fg-2">{value}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
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
        <h2 className="text-fg-0 text-base font-semibold">{title}</h2>
        <Separator className="flex-1" />
      </div>
      {children}
    </section>
  );
}
