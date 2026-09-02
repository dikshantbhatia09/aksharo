"use client";

import * as React from "react";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@montaj/ui";

export interface CodeTab {
  readonly label: string;
  readonly language: string;
  readonly code: string;
}

/** A curl/Node/Python (or any language set) switcher over a plain `<pre>` block. */
export function CodeTabs({ tabs }: { tabs: readonly CodeTab[] }): React.JSX.Element {
  const first = tabs[0];
  if (first === undefined) return <></>;

  return (
    <Tabs defaultValue={first.label} className="flex flex-col gap-2">
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.label} value={tab.label}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.label} value={tab.label}>
          <pre className="bg-bg-2 overflow-x-auto rounded-sm p-4 text-xs">
            <code>{tab.code}</code>
          </pre>
        </TabsContent>
      ))}
    </Tabs>
  );
}
