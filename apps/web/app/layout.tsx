import { BRAND } from "@montaj/config";

import "./globals.css";

import { fontVariables } from "./fonts";

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { Providers } from "@/components/providers";
import { readRuntimeConfig } from "@/lib/runtime-config";

export const metadata: Metadata = {
  title: {
    default: BRAND.name,
    template: `%s · ${BRAND.name}`,
  },
  description: "Caption, cut and reframe your video in the browser, the desktop app or your NLE.",
  metadataBase: new URL(`https://${BRAND.domain}`),
  applicationName: BRAND.name,
};

export const viewport: Viewport = {
  // The studio is dark-only in v1 (08 §1), so the browser paints its own chrome
  // dark too rather than flashing white before the CSS lands.
  colorScheme: "dark",
  themeColor: "#0B0B0E",
};

export default function RootLayout({ children }: { children: ReactNode }): React.JSX.Element {
  // A server component, so the API origin and the analytics keys are read at
  // request time rather than baked into the bundle at build time.
  const config = readRuntimeConfig();

  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <body className="min-h-dvh antialiased">
        <Providers config={config}>{children}</Providers>
      </body>
    </html>
  );
}
