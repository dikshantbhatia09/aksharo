import { PLAN_CATALOGUE, PLAN_MATRIX } from "@/content/site/pricing-data";

/** The full feature-by-plan comparison table, transcribed from 04 §Plans. */
export function PlanMatrix(): React.JSX.Element {
  return (
    <div className="overflow-x-auto" data-testid="plan-matrix">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-border border-b">
            <th scope="col" className="text-fg-2 py-3 pr-4 font-medium">
              Feature
            </th>
            {PLAN_CATALOGUE.map((plan) => (
              <th key={plan.key} scope="col" className="text-fg-0 px-4 py-3 font-semibold">
                {plan.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PLAN_MATRIX.map((row) => (
            <tr key={row.label} className="border-border border-b last:border-0">
              <th scope="row" className="text-fg-1 py-3 pr-4 font-normal">
                {row.label}
              </th>
              {PLAN_CATALOGUE.map((plan) => (
                <td key={plan.key} className="text-fg-1 px-4 py-3">
                  {row.values[plan.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
