import { vi } from "vitest";

/**
 * The `next/navigation` doubles.
 *
 * They live here rather than in `vitest.setup.ts` so a test can import the spies
 * without importing the setup file — importing a setup file from a test is how
 * you end up with two copies of it and assertions that never fire.
 */
export const routerMock = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};

export const searchParamsMock = { value: new URLSearchParams() };
export const pathnameMock = { value: "/" };

export function resetNavigationMocks(): void {
  searchParamsMock.value = new URLSearchParams();
  pathnameMock.value = "/";
}
