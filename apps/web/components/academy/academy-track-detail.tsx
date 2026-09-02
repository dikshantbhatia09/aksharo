"use client";

import { Check, ExternalLink } from "lucide-react";
import Link from "next/link";
import * as React from "react";

import { useAcademyProgress, useMarkAcademyStepDone } from "@montaj/api-client";
import { Badge, Button, Card, toast } from "@montaj/ui";

import type { AcademyTrack } from "@/lib/content/schema";

import { MarkdownBody } from "@/lib/content/markdown";
import { messageForError } from "@/lib/errors";

/** `/academy/{trackId}`: steps, "Mark done", the embedded demo placeholder, body. */
export function AcademyTrackDetail({ track }: { readonly track: AcademyTrack }): React.JSX.Element {
  const progress = useAcademyProgress();
  const markDone = useMarkAcademyStepDone();

  const trackProgress = progress.data?.tracks.find((entry) => entry.trackId === track.id);
  const completedStepIds = new Set(trackProgress?.completedStepIds ?? []);
  const rewardGranted = trackProgress?.rewardGranted ?? false;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <Link href="/academy" className="text-fg-2 text-xs hover:underline">
          ← All tracks
        </Link>
        <h1 className="font-display text-fg-0 mt-2 text-2xl font-semibold tracking-tight">
          {track.title}
        </h1>
        <p className="text-fg-1 mt-1 text-sm">{track.outcome}</p>
      </div>

      {/* Demo video placeholder — resolved to a real asset by media (brief §1). */}
      <Card
        className="bg-bg-2 flex h-40 items-center justify-center text-sm"
        data-testid="academy-demo-video"
        data-asset-id={track.demoVideoAssetId}
      >
        <span className="text-fg-2">Demo video</span>
      </Card>

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-fg-0 text-base font-semibold">Steps</h2>
          <Badge tone={rewardGranted ? "accepted" : "neutral"}>
            {rewardGranted ? "Reward earned" : `${track.creditReward} credits on completion`}
          </Badge>
        </div>
        <ol className="flex flex-col gap-2" data-testid="academy-step-list">
          {track.steps.map((step, index) => {
            const done = completedStepIds.has(step.id);
            const isAutomatic = step.completionEvent !== undefined;
            return (
              <li key={step.id}>
                <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-2xs ${
                        done ? "bg-lime-500 text-black" : "bg-bg-2 text-fg-2"
                      }`}
                      aria-hidden
                    >
                      {done ? <Check className="size-3" /> : index + 1}
                    </span>
                    <div>
                      <p className="text-fg-0 text-sm font-medium">{step.title}</p>
                      <p className="text-fg-2 text-xs">{step.detail}</p>
                      {isAutomatic ? (
                        <p className="text-fg-2 mt-1 text-2xs italic">
                          Completes automatically when you finish an export.
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {!isAutomatic ? (
                    <Button
                      variant={done ? "outline" : "primary"}
                      size="sm"
                      disabled={done || markDone.isPending}
                      data-testid={`mark-done-${step.id}`}
                      onClick={() => {
                        markDone.mutate(
                          { trackId: track.id, stepId: step.id },
                          {
                            onSuccess: (result) => {
                              if (result.rewardGranted) {
                                toast.success("Track complete", {
                                  description: `${track.creditReward} credits added to your workspace.`,
                                });
                              }
                            },
                            onError: (error) => {
                              toast.error("Could not mark that step done", {
                                description: messageForError(error),
                              });
                            },
                          },
                        );
                      }}
                    >
                      {done ? "Done" : "Mark done"}
                    </Button>
                  ) : done ? (
                    <Badge tone="accepted">Done</Badge>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </Card>

      <MarkdownBody markdown={track.body} />

      <Card className="flex items-center justify-between gap-3 p-4">
        <p className="text-fg-1 text-sm">Need a hand with something specific?</p>
        <Link
          href="/help"
          className="text-accent inline-flex items-center gap-1 text-sm hover:underline"
        >
          Help centre <ExternalLink className="size-3.5" />
        </Link>
      </Card>
    </div>
  );
}
