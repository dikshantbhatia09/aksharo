"use client";

/**
 * The brand kit's overlays on this clip (2026-10-02): the logo in its corner
 * and the end card over its last seconds, each a switch. Off takes it off the
 * clip (one undo away, like any edit); on puts the workspace's kit's back, as
 * the kit has it now. Where they sit is render-core's call — off the captions,
 * the logo in the kit's corner — so there is nothing here to place.
 */

import NextLink from "next/link";

export interface BrandOverlaysFieldProps {
  /** The clip has a logo overlay. */
  readonly logoOn: boolean;
  /** The workspace's kit has a logo to put on. */
  readonly logoAvailable: boolean;
  /** The clip has an end card. */
  readonly endCardOn: boolean;
  /** The workspace's kit has an end card with something on it. */
  readonly endCardAvailable: boolean;
  readonly onLogo: (on: boolean) => void;
  readonly onEndCard: (on: boolean) => void;
}

function Toggle({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (on: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-fg-1 text-xs font-medium">
          {label}
        </label>
        <p className="text-fg-2 m-0 text-xs">{hint}</p>
      </div>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className="panel-switch mt-0.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        data-testid={id}
      />
    </div>
  );
}

export function BrandOverlaysField({
  logoOn,
  logoAvailable,
  endCardOn,
  endCardAvailable,
  onLogo,
  onEndCard,
}: BrandOverlaysFieldProps): React.JSX.Element {
  return (
    <div className="flex flex-col pb-3" data-testid="brand-overlays-field">
      <Toggle
        id="brand-overlay-logo"
        label="Logo"
        hint={
          logoOn || logoAvailable
            ? "In its corner, off the captions."
            : "Add a logo to your brand kit first."
        }
        checked={logoOn}
        disabled={!logoOn && !logoAvailable}
        onChange={onLogo}
      />
      <Toggle
        id="brand-overlay-end-card"
        label="End card"
        hint={
          endCardOn || endCardAvailable
            ? "Over the last seconds, on a dimmed frame."
            : "Set up an end card in your brand kit first."
        }
        checked={endCardOn}
        disabled={!endCardOn && !endCardAvailable}
        onChange={onEndCard}
      />
      {logoAvailable && endCardAvailable ? null : (
        <NextLink
          href="/settings/brand-kit"
          className="text-accent-300 hover:text-accent-200 w-fit rounded-sm pt-1 text-xs underline underline-offset-4"
          data-testid="brand-overlays-settings"
        >
          Brand kit settings
        </NextLink>
      )}
    </div>
  );
}
