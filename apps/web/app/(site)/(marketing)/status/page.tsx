import { BRAND } from "@montaj/config";

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

const STATUS_DOT: Record<StatusComponentStatus, string> = {
  operational: "bg-lime-500",
  degraded: "bg-amber-500",
  down: "bg-red-500",
};

export default async function StatusPage(): Promise<React.JSX.Element> {
  const snapshot = await loadStatusSnapshot();
  const generated = new Date(snapshot.generatedAt);
  const isUnknown = isStatusUnknown(snapshot);

  const headline = isUnknown
    ? "Status data isn't available right now"
    : STATUS_COPY[snapshot.overall];

  const dotClass = isUnknown ? "bg-amber-500" : STATUS_DOT[snapshot.overall];

  return (
    <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`h-3 w-3 rounded-full ${dotClass}`}
        />
        <h1 className="font-display text-fg-0 text-3xl font-semibold tracking-tight sm:text-4xl">
          {headline}
        </h1>
      </div>
      <p className="text-fg-2 mt-3 text-sm" data-testid="status-generated-at">
        {Number.isNaN(generated.getTime())
          ? "Last updated: unknown"
          : `Last updated ${generated.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`}
        {" · "}
        <a href="/status/rss.xml" className="underline">
          Incident RSS
        </a>
      </p>

      <ul className="mt-10 flex flex-col gap-3" data-testid="status-components">
        {snapshot.components.length === 0 ? (
          <li className="text-fg-2 text-sm">No component checks published yet.</li>
        ) : (
          snapshot.components.map((component) => (
            <li
              key={component.id}
              className="border-border flex items-center justify-between border-b pb-3"
            >
              <span className="text-fg-0 font-medium">{component.label}</span>
              <span className="text-fg-1 flex items-center gap-2 text-sm">
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-full ${STATUS_DOT[component.status]}`}
                />
                {STATUS_COPY[component.status]}
                {component.detail === undefined ? null : (
                  <span className="text-fg-2 text-xs">({component.detail})</span>
                )}
              </span>
            </li>
          ))
        )}
      </ul>

      <h2 className="text-fg-0 mt-12 text-lg font-semibold">Incident history</h2>
      <ul className="mt-4 flex flex-col gap-6" data-testid="status-incidents">
        {snapshot.incidents.length === 0 ? (
          <li className="text-fg-2 text-sm">No incidents in the last 90 days.</li>
        ) : (
          snapshot.incidents.map((incident) => (
            <li key={incident.id} className="border-border border-b pb-6 last:border-0">
              <div className="flex items-center justify-between">
                <span className="text-fg-0 font-medium">{incident.title}</span>
                <span className="text-fg-2 bg-bg-2 rounded-full px-2 py-0.5 text-2xs capitalize">
                  {incident.status}
                </span>
              </div>
              <p className="text-fg-1 mt-1 text-sm">{incident.body}</p>
              <p className="text-fg-2 mt-1 text-xs">
                {incident.component} · started{" "}
                {new Date(incident.startedAt).toLocaleString("en-IN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {incident.resolvedAt === null
                  ? ""
                  : ` · resolved ${new Date(incident.resolvedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}`}
              </p>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
