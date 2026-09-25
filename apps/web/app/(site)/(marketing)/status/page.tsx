import { CircleAlert, CircleCheck, CircleHelp, CircleX } from "lucide-react";

import { BRAND } from "@montaj/config";
import { PageHeader } from "@montaj/ui";

import { isStatusUnknown, loadStatusSnapshot } from "./status-data";

import type { StatusComponentStatus } from "./status-data";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Status",
  description: `Live status for ${BRAND.name}'s API, AI worker, render service and job queue.`,
  alternates: { canonical: "/status" },
};

const STATUS_COPY: Record<StatusComponentStatus, string> = {
  operational: "Operational",
  degraded: "Degraded performance",
  down: "Down",
};

/**
 * Status is a signal, never the brand accent: each state carries its own
 * signal hue AND a distinct icon shape AND a word, so nothing depends on colour
 * alone (HIG accessibility.md › Vision: "Convey information with more than
 * color alone").
 */
const STATUS_TONE: Record<StatusComponentStatus, string> = {
  operational: "text-accepted",
  degraded: "text-warning",
  down: "text-rejected",
};

const STATUS_ICON: Record<StatusComponentStatus, typeof CircleCheck> = {
  operational: CircleCheck,
  degraded: CircleAlert,
  down: CircleX,
};

const formatWhen = (value: string): string =>
  new Date(value).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export default async function StatusPage(): Promise<React.JSX.Element> {
  const snapshot = await loadStatusSnapshot();
  const generated = new Date(snapshot.generatedAt);
  const isUnknown = isStatusUnknown(snapshot);

  const headline = isUnknown
    ? "Status data isn't available right now"
    : STATUS_COPY[snapshot.overall];

  const OverallIcon = isUnknown ? CircleHelp : STATUS_ICON[snapshot.overall];
  const overallTone = isUnknown ? "text-warning" : STATUS_TONE[snapshot.overall];

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <PageHeader
        title="System status"
        description={`Live status for ${BRAND.name}'s API, AI worker, render service and job queue.`}
      />

      <section
        aria-label="Current status"
        className="border-border bg-surface mt-8 flex items-start gap-3 rounded-md border p-5"
      >
        <OverallIcon
          aria-hidden="true"
          className={`${overallTone} mt-0.5 size-6 shrink-0`}
          strokeWidth={1.75}
        />
        <div className="min-w-0">
          <p className="text-fg-0 text-lg font-semibold">{headline}</p>
          <p className="text-fg-2 mt-1 text-sm" data-testid="status-generated-at">
            {Number.isNaN(generated.getTime())
              ? "Last updated: unknown"
              : `Last updated ${formatWhen(snapshot.generatedAt)}`}
            {" · "}
            <a href="/status/rss.xml">Incident RSS</a>
          </p>
        </div>
      </section>

      <h2 className="text-fg-0 mt-10 text-lg">Components</h2>
      <ul
        className="border-border bg-surface mt-3 flex flex-col rounded-md border"
        data-testid="status-components"
      >
        {snapshot.components.length === 0 ? (
          <li className="text-fg-2 px-5 py-4 text-sm">No component checks published yet.</li>
        ) : (
          snapshot.components.map((component) => {
            const Icon = STATUS_ICON[component.status];
            return (
              <li
                key={component.id}
                className="border-border flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-5 py-3 last:border-0"
              >
                <span className="text-fg-0 text-sm font-medium">{component.label}</span>
                <span className="text-fg-1 flex items-center gap-2 text-sm">
                  <Icon
                    aria-hidden="true"
                    className={`${STATUS_TONE[component.status]} size-4`}
                    strokeWidth={1.75}
                  />
                  {STATUS_COPY[component.status]}
                  {component.detail === undefined ? null : (
                    <span className="text-fg-2 text-xs">({component.detail})</span>
                  )}
                </span>
              </li>
            );
          })
        )}
      </ul>

      <h2 className="text-fg-0 mt-10 text-lg">Incident history</h2>
      <ul className="mt-3 flex flex-col" data-testid="status-incidents">
        {snapshot.incidents.length === 0 ? (
          <li className="border-border text-fg-2 rounded-md border border-dashed px-5 py-4 text-sm">
            No incidents in the last 90 days.
          </li>
        ) : (
          snapshot.incidents.map((incident) => (
            <li key={incident.id} className="border-border border-b py-5 first:pt-0 last:border-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-fg-0 font-medium">{incident.title}</span>
                <span className="text-fg-1 bg-bg-2 rounded-full px-2 py-0.5 text-2xs capitalize">
                  {incident.status}
                </span>
              </div>
              <p className="text-fg-1 mt-1 text-sm">{incident.body}</p>
              <p className="text-fg-2 mt-1 text-xs">
                {incident.component} · started {formatWhen(incident.startedAt)}
                {incident.resolvedAt === null
                  ? ""
                  : ` · resolved ${formatWhen(incident.resolvedAt)}`}
              </p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
