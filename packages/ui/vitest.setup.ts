import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// Radix measures elements and Tailwind classes are not applied in jsdom, so the
// two browser APIs its primitives rely on have to exist before a component that
// portals or positions itself is rendered.
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

afterEach(() => {
  cleanup();
});
