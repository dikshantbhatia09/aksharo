"use client";

import * as React from "react";

import { useApiContext } from "@montaj/api-client";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ProgressBar,
  Textarea,
} from "@montaj/ui";

import {
  createPromptedEditPlan,
  PASS_KIND_LABELS,
  runPromptedEditPlan,
  type PromptedEditEngine,
  type PromptedEditPlanResponse,
} from "../../../lib/passes/prompted-edits-client";
import { estimatePromptedEditQuote } from "../../../lib/passes/prompted-edits-quote";
import { usePassRunProgress } from "../../../lib/passes/realtime";

export interface PromptedEditBoxProps {
  readonly projectId: string;
  /** For the client-side hold estimate before a plan exists (D07 §4). */
  readonly sourceDurationMs: number;
  readonly className?: string;
}

const ENGINE_OPTIONS: readonly { readonly id: PromptedEditEngine; readonly label: string }[] = [
  { id: "flash", label: "Flash — fast, VAD-only cut, 540p tracking" },
  { id: "pro", label: "Pro — LLM re-ranked cuts, full-res tracking" },
];

/**
 * The prompted-edits prompt box and plan preview sheet (D07 §4,
 * 08-ux-design-system §4): a free-text instruction, the planner's response
 * shown as passes/rationale/style/script and a credits hold estimate
 * *before* anything runs, an engine toggle that re-plans, and a run button
 * that starts the pass chain and shows the first pass's realtime progress
 * (the rest of the chain is server-driven — `PromptedChainAdvancer` —
 * and lands through the normal Passes tab review flow as each pass merges).
 */
export function PromptedEditBox({
  projectId,
  sourceDurationMs,
  className,
}: PromptedEditBoxProps): React.JSX.Element {
  const { client } = useApiContext();

  const [prompt, setPrompt] = React.useState("");
  const [engine, setEngine] = React.useState<PromptedEditEngine>("flash");
  const [planning, setPlanning] = React.useState(false);
  const [planError, setPlanError] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<PromptedEditPlanResponse | null>(null);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [runError, setRunError] = React.useState<string | null>(null);
  const [runningJobId, setRunningJobId] = React.useState<string | null>(null);

  const progress = usePassRunProgress(projectId, runningJobId);

  const requestPlan = React.useCallback(
    async (requestedEngine: PromptedEditEngine) => {
      if (prompt.trim() === "") return;
      setPlanning(true);
      setPlanError(null);
      try {
        const response = await client.call(createPromptedEditPlan, {
          params: { projectId },
          body: { prompt, engine: requestedEngine },
        });
        setPlan(response);
        setEngine(requestedEngine);
        setSheetOpen(true);
      } catch (error) {
        setPlanError(error instanceof Error ? error.message : "could not plan this edit");
      } finally {
        setPlanning(false);
      }
    },
    [client, projectId, prompt],
  );

  const changeEngine = React.useCallback(
    (nextEngine: PromptedEditEngine) => {
      setEngine(nextEngine);
      if (plan !== null) void requestPlan(nextEngine);
    },
    [plan, requestPlan],
  );

  const runPlan = React.useCallback(async () => {
    if (plan === null) return;
    setRunning(true);
    setRunError(null);
    try {
      const response = await client.call(runPromptedEditPlan, {
        params: { projectId, planId: plan.id },
      });
      setRunningJobId(response.jobId);
      setSheetOpen(false);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "could not run this plan");
    } finally {
      setRunning(false);
    }
  }, [client, projectId, plan]);

  const estimate =
    plan === null ? estimatePromptedEditQuote(sourceDurationMs, sourceDurationMs, engine) : null;

  return (
    <div
      data-testid="prompted-edit-box"
      className={className}
      style={{ display: "flex", flexDirection: "column", gap: 8 }}
    >
      <Textarea
        aria-label="Describe the edit you want"
        placeholder='e.g. "Cut the silences and add some background music"'
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        data-testid="prompted-edit-prompt"
      />
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button
          type="button"
          onClick={() => void requestPlan(engine)}
          disabled={planning || prompt.trim() === ""}
          data-testid="prompted-edit-plan-button"
        >
          {planning ? "Planning…" : "Plan this edit"}
        </Button>
        {estimate !== null ? (
          <span style={{ fontSize: 12 }} data-testid="prompted-edit-preplan-estimate">
            Estimated hold: {estimate.holdCredits} credits
          </span>
        ) : null}
        {progress !== null ? (
          <div style={{ flex: 1, maxWidth: 240 }} data-testid="prompted-edit-run-progress">
            <ProgressBar value={Math.round((progress.ratio ?? 0) * 100)} label="Prompted edit" />
            <span style={{ fontSize: 12 }}>
              {progress.status === "failed"
                ? `Failed: ${progress.error ?? "unknown error"}`
                : progress.status === "completed"
                  ? "First pass done — chain continues"
                  : (progress.message ?? "Running…")}
            </span>
          </div>
        ) : null}
      </div>
      {planError !== null ? (
        <p role="alert" data-testid="prompted-edit-plan-error">
          {planError}
        </p>
      ) : null}

      <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
        <DialogContent data-testid="prompted-edit-preview-sheet">
          <DialogHeader>
            <DialogTitle>Plan preview</DialogTitle>
          </DialogHeader>
          {plan !== null ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div
                style={{ display: "flex", gap: 6, flexWrap: "wrap" }}
                data-testid="plan-pass-chips"
              >
                {plan.passes.map((pass, index) => (
                  <Badge key={`${pass.kind}-${String(index)}`}>{PASS_KIND_LABELS[pass.kind]}</Badge>
                ))}
              </div>

              {plan.style !== undefined || plan.script !== undefined ? (
                <p style={{ fontSize: 12 }} data-testid="plan-style-script">
                  {plan.style !== undefined ? `Style: ${plan.style}` : ""}
                  {plan.style !== undefined && plan.script !== undefined ? " · " : ""}
                  {plan.script !== undefined ? `Script: ${plan.script}` : ""}
                </p>
              ) : null}

              <ul data-testid="plan-rationale">
                {plan.rationale.map((line, index) => (
                  <li key={index} style={{ fontSize: 13 }}>
                    {line}
                  </li>
                ))}
              </ul>

              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>Engine</span>
                {ENGINE_OPTIONS.map((option) => (
                  <label key={option.id} style={{ display: "flex", gap: 6, fontSize: 12 }}>
                    <input
                      type="radio"
                      name="prompted-edit-engine"
                      checked={engine === option.id}
                      onChange={() => changeEngine(option.id)}
                      aria-label={option.label}
                    />
                    {option.label}
                  </label>
                ))}
              </div>

              <p data-testid="plan-credits-estimate">
                Credits hold: <strong>{plan.holdCredits}</strong> (held on source minutes, settled
                on finished minutes once the chain completes)
              </p>

              {runError !== null ? (
                <p role="alert" data-testid="prompted-edit-run-error">
                  {runError}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setSheetOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => void runPlan()}
              disabled={running || plan === null}
              data-testid="confirm-run-prompted-edit"
            >
              {running ? "Starting…" : "Confirm & run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
