"use client";

/**
 * `/projects`' toolbar: search, filters (status, language, folder, and —
 * Agency only — client tag), sort. Ctrl+K also searches (the command
 * palette's own input), so this field only needs to own the in-page list;
 * it does not have to be a second implementation of that shortcut.
 */
import * as React from "react";

import { useEntitlement } from "@montaj/api-client";
import type { ProjectStatus } from "@montaj/api-client";
import {
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
}: {
  label: string;
  value: string | undefined;
  options: readonly { key: string; label: string }[];
  onSelect: (value: string | undefined) => void;
  testId: string;
}): React.JSX.Element {
  const selected = options.find((option) => option.key === value)?.label;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="border-border bg-bg-2 text-fg-1 hover:text-fg-0 rounded-full border px-3 py-1.5 text-sm"
          data-testid={testId}
        >
          {selected ?? label}
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
}: {
  filters: ProjectFilters;
  onChange: (filters: ProjectFilters) => void;
}): React.JSX.Element {
  const entitlement = useEntitlement();
  const isAgency = entitlement.data?.planKey === "agency";

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="project-toolbar">
      <Input
        type="search"
        placeholder="Search by title… (Ctrl+K also searches)"
        value={filters.q}
        onChange={(event) => {
          onChange({ ...filters, q: event.target.value });
        }}
        className="w-64"
        aria-label="Search projects"
        data-testid="project-search"
      />

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
            onChange({ ...filters, clientTag: event.target.value === "" ? undefined : event.target.value });
          }}
          className="w-40"
          aria-label="Filter by client tag"
          data-testid="filter-client-tag"
        />
      ) : null}

      <div className="ml-auto">
        <FilterMenu
          label="Sort"
          value={filters.sort}
          options={SORT_OPTIONS}
          onSelect={(value) => {
            onChange({ ...filters, sort: (value as SortOrder | undefined) ?? "newest" });
          }}
          testId="sort-order"
        />
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
