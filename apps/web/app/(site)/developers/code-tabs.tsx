"use client";

import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@montaj/ui";

export interface CodeTab {
  readonly label: string;
  readonly language: string;
  readonly code: string;
}

/**
 * A curl/Node/Python (or any language set) switcher over a plain `<pre>` block.
 *
 * The block sits on `bg-sunken` (an inset, like the timeline) and is focusable,
 * because a horizontally scrolling region has to be reachable by keyboard.
 */
export function CodeTabs({
  tabs,
  label,
}: {
  tabs: readonly CodeTab[];
  /** What the snippets do, e.g. "Create a project"; names the tab list and each block. */
  label?: string;
}): React.JSX.Element {
  const first = tabs[0];
  if (first === undefined) return <></>;

  return (
    <Tabs defaultValue={first.label} className="flex flex-col gap-2">
      <TabsList {...(label === undefined ? {} : { "aria-label": `${label}: language` })}>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.label} value={tab.label}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.label} value={tab.label}>
          <pre
            className="bg-sunken border-border text-fg-0 overflow-x-auto rounded-md border p-4 font-mono text-xs leading-relaxed"
            tabIndex={0}
            aria-label={label === undefined ? `${tab.label} example` : `${label} in ${tab.label}`}
          >
            <code>{tab.code}</code>
          </pre>
        </TabsContent>
      ))}
    </Tabs>
  );
}
