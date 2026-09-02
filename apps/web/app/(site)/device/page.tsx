import { Suspense } from "react";

import { DeviceApprovalView } from "./device-view";

import type { Metadata } from "next";

export const metadata: Metadata = { title: "Connect a device", robots: { index: false } };

export default function DevicePage(): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <DeviceApprovalView />
    </Suspense>
  );
}
