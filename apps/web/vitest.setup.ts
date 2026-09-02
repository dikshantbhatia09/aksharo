import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import {
  pathnameMock,
  resetNavigationMocks,
  routerMock,
  searchParamsMock,
} from "./test/next-router";

/**
 * jsdom is missing three things Radix needs, and `next/navigation` has no
 * implementation outside the router. Providing them here keeps every test file
 * free of the same dozen lines of boilerplate.
 */

// React 19 only enables `act` support when the environment says it is a test.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

if (!("matchMedia" in globalThis)) {
  Object.defineProperty(globalThis, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

Element.prototype.scrollIntoView ??= (): void => {};
Element.prototype.hasPointerCapture ??= (): boolean => false;
Element.prototype.setPointerCapture ??= (): void => {};
Element.prototype.releasePointerCapture ??= (): void => {};

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
  usePathname: () => pathnameMock.value,
  useSearchParams: () => searchParamsMock.value,
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

afterEach(() => {
  cleanup();
  resetNavigationMocks();
  window.localStorage.clear();
});
