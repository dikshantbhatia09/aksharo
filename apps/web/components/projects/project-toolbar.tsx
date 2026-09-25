"use client";

/**
 * `/projects`' toolbar: search, filters (status, language, folder, and —
 * Agency only — client tag), sort. Ctrl+K also searches (the command
 * palette's own input), so this field only needs to own the in-page list;
 * it does not have to be a second implementation of that shortcut.
 */
import { ChevronDown, Search } from "lucide-react";
import * as React from "react";

import { useEntitlement } from "@montaj/api-client";
import type { ProjectStatus } from "@montaj/api-client";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@montaj/ui";

import { QUICK_PICK_LANGUAGES } from "./quick-pick-row";

export type SortOrder = "newest" | "oldest" | "title";

export interface ProjectFilters {
  q: string;
  status: ProjectStatus | undefined;
  sourceLanguage: string | undefined;
  clientTag: string | undefined;
  sort: SortOrder;
}

export const EMPTY_FILTERS: ProjectFilters = {
  q: "",
  status: undefined,
  sourceLanguage: undefined,
  clientTag: undefined,
  sort: "newest",
};

const STATUS_OPTIONS: readonly { key: ProjectStatus; label: string }[] = [
  { key: "draft", label: "Draft" },
  { key: "active", label: "Active" },
  { key: "archived", label: "Archived" },
];

const SORT_OPTIONS: readonly { key: SortOrder; label: string }[] = [
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "title", label: "Title A–Z" },
];

function FilterMenu({
  label,
  value,
  options,
  onSelect,
  testId,
  /**
   * An applied filter is drawn raised, with its value as the label, so the
   * bar says "this is narrowing the list" in words as well as shape. Sort
   * always has a value and never narrows anything, so it opts out.
   */
  narrows = true,
}: {
  label: string;
  value: string | undefined;
  options: readonly { key: string; label: string }[];
  onSelect: (value: string | undefined) => void;
  testId: string;
  narrows?: boolean;
}): React.JSX.Element {
  const selected = options.find((option) => option.key === value)?.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            // A 36 px outlined button with a caret, not a pill. An applied
            // filter is raised (bg-2) and names its field, so "narrowed" is
            // read, not inferred from a colour.
            "flex h-9 items-center gap-1.5 rounded-sm border px-3 text-sm",
            "transition-colors duration-[160ms] ease-[var(--ease-out-soft)]",
            selected === undefined || !narrows
              ? "border-border text-fg-0 hover:bg-neutral-100/7"
              : "border-border-hover bg-bg-2 text-fg-0 hover:bg-bg-3",
          )}
          aria-label={selected === undefined ? label : `${label}: ${selected}`}
          data-testid={testId}
        >
          {selected !== undefined && narrows ? (
            <span className="text-fg-2" aria-hidden="true">
              {label}:
            </span>
          ) : null}
          {selected ?? label}
          <ChevronDown className="text-fg-2 size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={() => {
            onSelect(undefined);
          }}
          data-testid={`${testId}-clear`}
        >
          {label} (any)
        </DropdownMenuItem>
        {options.map((option) => (
          <DropdownMenuItem
            key={option.key}
            onSelect={() => {
              onSelect(option.key);
            }}
            data-testid={`${testId}-${option.key}`}
          >
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ProjectToolbar({
  filters,
  onChange,
  children,
}: {
  filters: ProjectFilters;
  onChange: (filters: ProjectFilters) => void;
  /** Controls the page adds to the right of the bar — the view toggle, Select. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const entitlement = useEntitlement();
  const isAgency = entitlement.data?.planKey === "agency";

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="project-toolbar">
      <span className="relative flex w-full items-center sm:w-auto">
        <Search
          className="text-fg-2 pointer-events-none absolute left-2.5 size-4"
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder="Search titles and transcripts"
          value={filters.q}
          onChange={(event) => {
            onChange({ ...filters, q: event.target.value });
          }}
          className="h-9 w-full pl-8 sm:w-[260px]"
          aria-label="Search projects"
          data-testid="project-search"
        />
      </span>

      <FilterMenu
        label="Status"
        value={filters.status}
        options={STATUS_OPTIONS}
        onSelect={(value) => {
          onChange({ ...filters, status: value as ProjectStatus | undefined });
        }}
        testId="filter-status"
      />

      <FilterMenu
        label="Language"
        value={filters.sourceLanguage}
        options={QUICK_PICK_LANGUAGES.map((entry) => ({ key: entry.key, label: entry.label }))}
        onSelect={(value) => {
          onChange({ ...filters, sourceLanguage: value });
        }}
        testId="filter-language"
      />

      {isAgency ? (
        <Input
          type="text"
          placeholder="Client tag"
          value={filters.clientTag ?? ""}
          onChange={(event) => {
            onChange({
              ...filters,
              clientTag: event.target.value === "" ? undefined : event.target.value,
            });
          }}
          className="h-9 w-40"
          aria-label="Filter by client tag"
          data-testid="filter-client-tag"
        />
      ) : null}

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <FilterMenu
          label="Sort"
          value={filters.sort}
          options={SORT_OPTIONS}
          onSelect={(value) => {
            onChange({ ...filters, sort: (value as SortOrder | undefined) ?? "newest" });
          }}
          testId="sort-order"
          narrows={false}
        />
        {children}
      </div>
    </div>
  );
}

/** Client-side ordering within the pages already loaded — see `ProjectToolbar`. */
export function sortProjects<T extends { title: string; createdAt: string }>(
  projects: readonly T[],
  sort: SortOrder,
): T[] {
  const copy = [...projects];
  if (sort === "title") return copy.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "oldest") return copy.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return copy.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
