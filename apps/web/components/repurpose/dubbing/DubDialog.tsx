"use client";

/**
 * "Dub this clip" (2026-10-04): the languages to dub into, the person's word
 * that they may clone the speaker's voice, and what it costs - before anything
 * is asked for.
 *
 * The clip's own language, and any it is already dubbed (or being dubbed)
 * into, cannot be picked. The confirm button stays off until a language is
 * picked and the voice box is ticked; the cost line is the API's own sum
 * (`dubCostTenths`), so what it says is what is held.
 */
import * as React from "react";

import {
  dubCostTenths,
  useCreateRepurposeDub,
  type RepurposeDubLanguage,
  type RepurposeDubLanguageCode,
  type RepurposeDubOffer,
} from "@montaj/api-client";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@montaj/ui";

import { DUB_COPY, creditsText } from "@/components/repurpose/dubbing/copy";
import { describeRefusal } from "@/components/repurpose/refusal";

export interface DubDialogProps {
  readonly runId: string;
  readonly offer: RepurposeDubOffer;
  readonly languages: readonly RepurposeDubLanguage[];
  readonly tenthsPerMinute: number;
  readonly title: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

export function DubDialog({
  runId,
  offer,
  languages,
  tenthsPerMinute,
  title,
  open,
  onOpenChange,
}: DubDialogProps): React.JSX.Element {
  const create = useCreateRepurposeDub();
  const [picked, setPicked] = React.useState<readonly RepurposeDubLanguageCode[]>([]);
  const [consent, setConsent] = React.useState(false);
  const own = offer.sourceLanguage?.code;
  const taken = new Set<string>(offer.taken);
  const choices = languages.filter((language) => language.code !== own);
  const costTenths = dubCostTenths(offer.durationMs ?? 0, picked.length, tenthsPerMinute);
  const refusal = create.isError ? describeRefusal(create.error, "dub").text : null;

  const toggle = (code: RepurposeDubLanguageCode): void => {
    setPicked((current) =>
      current.includes(code) ? current.filter((entry) => entry !== code) : [...current, code],
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setPicked([]);
          setConsent(false);
          create.reset();
        }
      }}
    >
      <DialogContent
        className="max-h-[88vh] max-w-lg overflow-y-auto"
        data-testid={`dub-dialog-${offer.clipId}`}
      >
        <DialogHeader>
          <DialogTitle>{DUB_COPY.dialogTitle}</DialogTitle>
          <DialogDescription>
            {DUB_COPY.dialogDescription(offer.sourceLanguage?.name ?? "")}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="mb-2 text-sm font-medium text-fg-0">{DUB_COPY.languagesLegend}</legend>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 p-0">
            {choices.map((language) => {
              const done = taken.has(language.code);
              const inputId = `dub-${offer.clipId}-${language.code}`;
              return (
                <li key={language.code} className="flex items-center gap-2">
                  <Checkbox
                    id={inputId}
                    checked={done || picked.includes(language.code)}
                    disabled={done || create.isPending}
                    onCheckedChange={() => {
                      toggle(language.code);
                    }}
                    data-testid={`dub-language-${language.code}`}
                  />
                  <label htmlFor={inputId} className="text-sm text-fg-1">
                    {language.name}
                    {done ? <span className="text-xs text-fg-2"> ({DUB_COPY.taken})</span> : null}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="flex items-start gap-2 rounded-sm border border-border bg-surface p-3">
          <Checkbox
            id={`dub-consent-${offer.clipId}`}
            checked={consent}
            disabled={create.isPending}
            onCheckedChange={(value) => {
              setConsent(value === true);
            }}
            data-testid="dub-consent"
          />
          <label htmlFor={`dub-consent-${offer.clipId}`} className="text-sm text-fg-0">
            {DUB_COPY.consent}
          </label>
        </div>

        <p className="m-0 text-sm text-fg-1" data-testid="dub-cost" aria-live="polite">
          {picked.length === 0
            ? DUB_COPY.pickSome
            : DUB_COPY.cost(creditsText(costTenths), creditsText(tenthsPerMinute))}
        </p>

        {refusal === null ? null : (
          <p role="alert" className="m-0 text-sm text-rejected" data-testid="dub-error">
            {refusal}
          </p>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
            }}
          >
            {DUB_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            disabled={picked.length === 0 || !consent || create.isPending}
            aria-label={
              create.isPending ? undefined : `${DUB_COPY.confirm(picked.length)}: ${title}`
            }
            onClick={() => {
              create.mutate(
                { runId, clipId: offer.clipId, body: { languages: [...picked], consent } },
                {
                  onSuccess: () => {
                    onOpenChange(false);
                    setPicked([]);
                    setConsent(false);
                  },
                },
              );
            }}
            data-testid="dub-confirm"
          >
            {create.isPending ? DUB_COPY.confirming : DUB_COPY.confirm(picked.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
