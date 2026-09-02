"use client";

import * as React from "react";

import { adminFetch, AdminFetchError } from "./admin-fetch";

import { useRuntimeConfig } from "@/components/providers";

export { AdminFetchError };

/** `useAdminFetch()(path, init)` — `admin-fetch.ts` bound to this deployment's API origin. */
export function useAdminFetch(): <T>(
  path: string,
  init?: { method?: string; body?: unknown },
) => Promise<T> {
  const config = useRuntimeConfig();
  return React.useCallback(
    <T>(path: string, init: { method?: string; body?: unknown } = {}) =>
      adminFetch<T>(config.apiOrigin, path, init),
    [config.apiOrigin],
  );
}
