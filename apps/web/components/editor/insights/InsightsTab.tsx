"use client";

import * as React from "react";

import { useProjectInsights, useRequestInsights } from "@montaj/api-client";
import type { InsightKind, InsightRow } from "@montaj/api-client";
import { Button, EmptyState, Skeleton, Tabs, TabsContent, TabsList, TabsTrigger } from "@montaj/ui";

import { ChaptersPanel } from "./ChaptersPanel";
import { HooksPanel } from "./HooksPanel";
import { SummaryPanel } from "./SummaryPanel";

export interface InsightsTabProps {
  readonly projectId: string;
  /** Seek the preview player to `ms` (source time) — chapters' "jump to". */
  readonly onSeek?: (ms: number) => void;
  readonly className?: string;
}

const KINDS: readonly { readonly id: InsightKind; readonly label: string }[] = [
  { id: "chapters", label: "Chapters" },
  { id: "summary", label: "Summary" },
  { id: "hooks", label: "Hooks & titles" },
];

/**
 * The Insights tab (brief §5, F-206/F-207): chapters, summary and
 * hooks/titles/hashtags generated from the transcript, each with its own
 * regenerate action and the ASCI-friendly disclosure line.
 */
export function InsightsTab({ projectId, onSeek, className }: InsightsTabProps): React.JSX.Element {
  const [kind, setKind] = React.useState<InsightKind>("chapters");
  const { data, isPending, error, refetch } = useProjectInsights(projectId);
  const request = useRequestInsights(projectId);

  const isGenerating = request.isPending;

  return (
    <div className={className} data-testid="insights-tab">
      <Tabs value={kind} onValueChange={(value) => setKind(value as InsightKind)}>
        <TabsList aria-label="Insight kind">
          {KINDS.map((option) => (
            <TabsTrigger
              key={option.id}
              value={option.id}
              data-testid={`insights-tab-${option.id}`}
            >
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>

        {KINDS.map((option) => (
          <TabsContent key={option.id} value={option.id} className="flex flex-col gap-3 pt-3">
            <InsightsBody
              kind={option.id}
              isPending={isPending}
              error={error}
              row={data?.items.find((item) => item.kind === option.id)}
              isGenerating={isGenerating && kind === option.id}
              onGenerate={() => {
                setKind(option.id);
                request.mutate(
                  { kinds: [option.id], regenerate: data?.items.some((r) => r.kind === option.id) },
                  { onSettled: () => void refetch() },
                );
              }}
              {...(onSeek === undefined ? {} : { onSeek })}
            />
          </TabsContent>
        ))}
      </Tabs>

      {data?.disclosure !== undefined ? (
        <p className="text-fg-3 mt-4 text-xs italic" data-testid="insights-disclosure">
          {data.disclosure}
        </p>
      ) : null}
    </div>
  );
}

function InsightsBody({
  kind,
  isPending,
  error,
  row,
  isGenerating,
  onGenerate,
  onSeek,
}: {
  readonly kind: InsightKind;
  readonly isPending: boolean;
  readonly error: Error | null;
  readonly row: InsightRow | undefined;
  readonly isGenerating: boolean;
  readonly onGenerate: () => void;
  readonly onSeek?: (ms: number) => void;
}): React.JSX.Element {
  if (isPending) {
    return (
      <div className="flex flex-col gap-2" data-testid="insights-loading">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
      </div>
    );
  }

  if (error !== null) {
    return (
      <EmptyState
        title="Couldn't load insights"
        description={error.message || "Something went wrong. Try again."}
        action={
          <Button type="button" onClick={onGenerate} data-testid="insights-retry">
            Retry
          </Button>
        }
      />
    );
  }

  if (row === undefined) {
    return (
      <EmptyState
        title={`No ${kind} yet`}
        description="Generate this from the project's transcript."
        action={
          <Button
            type="button"
            onClick={onGenerate}
            disabled={isGenerating}
            data-testid="insights-generate"
          >
            {isGenerating ? "Generating…" : "Generate"}
          </Button>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onGenerate}
          disabled={isGenerating}
          data-testid="insights-regenerate"
        >
          {isGenerating ? "Regenerating…" : "Regenerate"}
        </Button>
      </div>
      {kind === "chapters" ? (
        <ChaptersPanel row={row} {...(onSeek === undefined ? {} : { onSeek })} />
      ) : null}
      {kind === "summary" ? <SummaryPanel row={row} /> : null}
      {kind === "hooks" ? <HooksPanel row={row} /> : null}
    </div>
  );
}
