import { Card } from "@montaj/ui";

/** No-key billing state: credits remain usable, while external checkout is absent. */
export function FreeStackBillingNotice(): React.JSX.Element {
  return (
    <Card className="border-lime-500/40 flex flex-col gap-2" data-testid="free-stack-billing">
      <h2 className="text-fg-0 text-lg font-semibold">Credits are granted by your admin</h2>
      <p className="text-fg-2 text-sm">
        Payments are not configured in this build. Ask an administrator to grant credits when you
        need more; no checkout or payment details are required.
      </p>
    </Card>
  );
}
