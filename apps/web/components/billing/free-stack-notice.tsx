import { Card } from "@montaj/ui";

/**
 * No-key billing state: credits remain usable, while external checkout is
 * absent. A plain card, not an accent-bordered one: this is information, and
 * the accent is spent elsewhere on the screen (DESIGN.md > accent budget).
 */
export function FreeStackBillingNotice(): React.JSX.Element {
  return (
    <Card className="flex flex-col gap-2" data-testid="free-stack-billing">
      <h2 className="text-fg-0 text-base font-semibold">Credits are granted by your admin</h2>
      <p className="text-fg-2 text-sm">
        Payments are not set up in this build. Ask an administrator to grant credits when you need
        more; no checkout or payment details are required.
      </p>
    </Card>
  );
}
