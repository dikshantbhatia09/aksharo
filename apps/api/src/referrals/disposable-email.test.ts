import { describe, expect, it } from "vitest";

import { isDisposableEmail } from "./disposable-email.js";

describe("isDisposableEmail", () => {
  it("flags known disposable-inbox domains", () => {
    expect(isDisposableEmail("someone@mailinator.com")).toBe(true);
    expect(isDisposableEmail("SOMEONE@YOPMAIL.COM")).toBe(true);
  });

  it("does not flag an ordinary domain", () => {
    expect(isDisposableEmail("someone@gmail.com")).toBe(false);
    expect(isDisposableEmail("someone@example.test")).toBe(false);
  });

  it("does not throw on a malformed address", () => {
    expect(isDisposableEmail("not-an-email")).toBe(false);
  });
});
