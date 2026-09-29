"use client";

/**
 * Settings: "Clips need approval before posting" (2026-10-03).
 *
 * Off unless an owner or admin turns it on. On, a clip is posted only once it
 * is approved - by an owner or admin, or by a client through a review link -
 * and only the version that was approved; everyone else sees the switch, read
 * only, with who can change it. A switch that is on is one of the few places
 * the accent may appear (`DESIGN.md`).
 */
import * as React from "react";

import { Card, Skeleton, Switch, toast } from "@montaj/ui";

import { APPROVAL_SETTING_COPY, describeReviewError } from "./review-copy";
import { useApprovalSetting, useSetApprovalSetting } from "./use-review";

import { SettingsGroup } from "@/components/settings/section";

export function ApprovalSetting(): React.JSX.Element | null {
  const setting = useApprovalSetting();
  const change = useSetApprovalSetting();

  if (setting.isError) return null;
  const on = setting.data?.on ?? false;
  const canChange = setting.data?.canChange ?? false;

  return (
    <SettingsGroup
      title={APPROVAL_SETTING_COPY.title}
      description={APPROVAL_SETTING_COPY.description}
      testId="approval-setting"
    >
      <Card className="flex flex-col gap-3">
        {setting.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="flex items-start justify-between gap-4">
            <label htmlFor="clips-need-approval" className="flex min-w-0 flex-col gap-1">
              <span className="text-sm text-fg-0">{APPROVAL_SETTING_COPY.label}</span>
              <span className="text-xs text-fg-2">{APPROVAL_SETTING_COPY.hint}</span>
              {canChange ? null : (
                <span className="text-xs text-fg-2" data-testid="approval-setting-read-only">
                  {APPROVAL_SETTING_COPY.adminOnly}
                </span>
              )}
            </label>
            <Switch
              id="clips-need-approval"
              className="mt-1"
              checked={on}
              disabled={!canChange || change.isPending}
              onCheckedChange={(value) => {
                change.mutate(value, {
                  onSuccess: () => {
                    toast.success(value ? APPROVAL_SETTING_COPY.on : APPROVAL_SETTING_COPY.off);
                  },
                });
              }}
              data-testid="approval-setting-switch"
            />
          </div>
        )}
        {change.isError ? (
          <p role="alert" className="m-0 text-sm text-rejected">
            {describeReviewError(change.error)}
          </p>
        ) : null}
      </Card>
    </SettingsGroup>
  );
}
