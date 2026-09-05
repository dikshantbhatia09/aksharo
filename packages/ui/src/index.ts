/**
 * `@montaj/ui` — the Aksharo design system: tokens, shadcn/ui primitives and the
 * product components of `03-architecture/08-ux-design-system.md` §2.
 *
 * The package is consumed as **source**: `apps/web` lists it in
 * `transpilePackages`, so the app's own SWC pipeline compiles the `"use client"`
 * boundaries rather than a build step here having to preserve them. `pnpm build`
 * for this package is therefore a type-check gate, not an emit.
 *
 * Import `@montaj/ui/tokens.css` once, after `@import "tailwindcss"`.
 */

export { cn } from "./lib/cn";
export * from "./tokens";
export * from "./fonts/indic";

// --- Primitives -------------------------------------------------------------
export { Button, buttonVariants } from "./primitives/button";
export type { ButtonProps } from "./primitives/button";
export { Input, Textarea } from "./primitives/input";
export type { InputProps } from "./primitives/input";
export { Field, Label } from "./primitives/label";
export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "./primitives/dialog";
export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./primitives/sheet";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./primitives/tabs";
export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./primitives/tooltip";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./primitives/dropdown-menu";
// OC-02 menubar
export {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "./primitives/menubar";
export { Toaster, toast } from "./primitives/toast";
export {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "./primitives/command";
export { Checkbox, Separator, Switch } from "./primitives/toggles";
export { Badge, badgeVariants, Card, ProgressBar, Skeleton } from "./primitives/surface";
export type { BadgeProps } from "./primitives/surface";

// --- Product components -----------------------------------------------------
export {
  CreditMeter,
  daysOfRunway,
  formatCredits,
  formatMinutes,
  formatResetDate,
} from "./components/credit-meter";
export type { CreditMeterProps } from "./components/credit-meter";
export { formatEta, JOB_STAGES, JobProgress } from "./components/job-progress";
export type { JobProgressProps, JobStage } from "./components/job-progress";
export { PLAN_LABEL, UpgradeGate } from "./components/upgrade-gate";
export type { UpgradeGateProps } from "./components/upgrade-gate";
export {
  isAppleShortcutPlatform,
  LANGUAGE_LABEL,
  LangChip,
  ShortcutHint,
  shortcutKeys,
  StatusChip,
} from "./components/chips";
export type { ProjectStatus } from "./components/chips";
export { EmptyState } from "./components/empty-state";

/** Build-time identity of this package, used by diagnostics bundles. */
export interface PackageInfo {
  readonly name: `@montaj/${string}`;
  readonly implementedBy: string;
  readonly implemented: boolean;
}

export const PACKAGE_INFO: PackageInfo = {
  name: "@montaj/ui",
  implementedBy: "A13",
  implemented: true,
};
