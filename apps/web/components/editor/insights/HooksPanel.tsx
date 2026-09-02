"use client";

import * as React from "react";

import type { InsightRow } from "@montaj/api-client";
import { Badge, Tabs, TabsContent, TabsList, TabsTrigger } from "@montaj/ui";

import { CopyButton } from "./CopyButton";

export interface HooksPanelProps {
  readonly row: InsightRow;
}

const PLATFORMS = [
  { id: "youtube", label: "YouTube" },
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
] as const;

interface PlatformVariant {
  readonly hooks: readonly string[];
  readonly titles: readonly string[];
  readonly hashtags: readonly string[];
}

/** Hooks/titles/hashtags with platform tabs and copy buttons (brief §5). */
export function HooksPanel({ row }: HooksPanelProps): React.JSX.Element {
  const output = row.output as unknown as Record<string, PlatformVariant | undefined>;
  const [platform, setPlatform] = React.useState<(typeof PLATFORMS)[number]["id"]>("youtube");
  const variant = output[platform];

  if (variant === undefined) {
    return (
      <p className="text-fg-3 text-sm" data-testid="hooks-empty">
        No hooks yet.
      </p>
    );
  }

  return (
    <Tabs
      value={platform}
      onValueChange={(value) => setPlatform(value as (typeof PLATFORMS)[number]["id"])}
      data-testid="hooks-panel"
    >
      <TabsList aria-label="Platform">
        {PLATFORMS.map((option) => (
          <TabsTrigger key={option.id} value={option.id}>
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {PLATFORMS.map((option) => (
        <TabsContent key={option.id} value={option.id} className="flex flex-col gap-4 pt-3">
          <VariantSection title="Hooks" items={output[option.id]?.hooks ?? []} joiner="\n\n" />
          <VariantSection title="Titles" items={output[option.id]?.titles ?? []} joiner="\n" />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-fg-2 text-xs font-medium">Hashtags</span>
              <CopyButton value={(output[option.id]?.hashtags ?? []).join(" ")} label="Hashtags" />
            </div>
            <div className="flex flex-wrap gap-1" data-testid={`hooks-hashtags-${option.id}`}>
              {(output[option.id]?.hashtags ?? []).map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          </div>
        </TabsContent>
      ))}
    </Tabs>
  );
}

function VariantSection({
  title,
  items,
  joiner,
}: {
  readonly title: string;
  readonly items: readonly string[];
  readonly joiner: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-fg-2 text-xs font-medium">{title}</span>
        <CopyButton value={items.join(joiner)} label={title} />
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((item, index) => (
          // Hooks/titles have no stable id of their own; the index is a stand-in.
          <li key={`${title}-${String(index)}`} className="text-fg-1 text-sm">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
