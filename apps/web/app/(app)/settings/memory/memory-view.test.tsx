import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MemoryEntry } from "@montaj/api-client";

import { MemoryView } from "./memory-view";

import { renderWithProviders } from "@/test/harness";

function withConsent(memory: boolean): void {
  window.localStorage.setItem(
    "aksharo.privacy",
    JSON.stringify({ analytics: false, memory, marketing: false, minor: false }),
  );
}

const ENTRY: MemoryEntry = {
  id: "01JMEMORY0000000000000000",
  kind: "glossary",
  key: "aksharo",
  value: "Aksharo",
  aliases: ["Akshara"],
  source: "manual",
  deviceOnly: false,
  hits: 3,
  expiresAt: "2027-09-02T00:00:00.000Z",
  lastUsedAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
};

describe("MemoryView", () => {
  it("shows the disabled state and never calls /memory when consent is off", () => {
    withConsent(false);
    const { fetchMock } = renderWithProviders(<MemoryView />);

    expect(screen.getByTestId("memory-disabled")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/memory"))).toBe(false);
  });

  it("lists entries with kind, aliases, hit count and expiry once consent is on", async () => {
    withConsent(true);
    renderWithProviders(<MemoryView />, { routes: { "/memory": [ENTRY] } });

    expect(await screen.findByTestId("memory-list")).toBeInTheDocument();
    expect(screen.getByText(/aksharo → Aksharo/)).toBeInTheDocument();
    expect(screen.getByText(/Also heard as: Akshara/)).toBeInTheDocument();
    expect(screen.getByText(/Applied 3 times/)).toBeInTheDocument();
  });

  it("shows the empty state when consent is on but nothing has been learned yet", async () => {
    withConsent(true);
    renderWithProviders(<MemoryView />, { routes: { "/memory": [] } });

    await waitFor(() => {
      expect(screen.getByText(/Nothing learned yet/)).toBeInTheDocument();
    });
  });

  it("offers the glossary add-term and CSV import controls once consent is on", async () => {
    withConsent(true);
    renderWithProviders(<MemoryView />, { routes: { "/memory": [] } });

    expect(await screen.findByTestId("memory-glossary-import")).toBeInTheDocument();
    expect(screen.getByTestId("memory-add-term-input")).toBeInTheDocument();
    expect(screen.getByTestId("memory-import-csv")).toBeInTheDocument();
  });

  it("offers edit and delete controls per entry", async () => {
    withConsent(true);
    renderWithProviders(<MemoryView />, { routes: { "/memory": [ENTRY] } });

    expect(await screen.findByTestId(`edit-memory-${ENTRY.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`delete-memory-${ENTRY.id}`)).toBeInTheDocument();
  });
});
