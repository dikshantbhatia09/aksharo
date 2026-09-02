"use client";

import * as React from "react";

import type { InsightRow } from "@montaj/api-client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@montaj/ui";

import { CopyButton } from "./CopyButton";

export interface SummaryPanelProps {
  readonly row: InsightRow;
}

const LENGTHS = [
  { id: "short", label: "Short" },
  { id: "medium", label: "Medium" },
  { id: "long", label: "Long" },
] as const;

/** Summary with a length switch (brief §5): short / medium / long, each with its own copy. */
export function SummaryPanel({ row }: SummaryPanelProps): React.JSX.Element {
  const [length, setLength] = React.useState<(typeof LENGTHS)[number]["id"]>("medium");
  const output = row.output as Record<string, string>;

  return (
    <Tabs
      value={length}
      onValueChange={(value) => setLength(value as (typeof LENGTHS)[number]["id"])}
      data-testid="summary-panel"
    >
      <div className="flex items-center justify-between">
        <TabsList aria-label="Summary length">
          {LENGTHS.map((option) => (
            <TabsTrigger key={option.id} value={option.id}>
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <CopyButton value={output[length] ?? ""} label={`${length} summary`} />
      </div>
      {LENGTHS.map((option) => (
        <TabsContent key={option.id} value={option.id}>
          <p className="text-fg-1 text-sm whitespace-pre-wrap" data-testid={`summary-${option.id}`}>
            {output[option.id] ?? ""}
          </p>
        </TabsContent>
      ))}
    </Tabs>
  );
}
