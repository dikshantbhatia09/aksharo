"use client";

/**
 * The three control primitives the Colors, Look and Anim tabs are built from.
 *
 * They are deliberately dumb: each takes a value and a `path` into the StyleDoc
 * and calls back with a `SetStyle` op for that one field. No panel keeps a copy
 * of the style — the editor's document is the only state — which is what makes
 * "the panel emits the right op" a testable statement about `ops.ts` rather
 * than about React.
 */

import { useEffect, useState } from "react";

import type { Gradient, GradientStop } from "@montaj/caption-styles";

import { type PanelScope, setStyleField, type SetStyleOp } from "./ops";

import { cn } from "@/lib/utils";

export interface FieldProps<T> {
  readonly label: string;
  /** Dotted path into the StyleDoc, e.g. `"typography.sizePct"`. */
  readonly path: string;
  readonly value: T;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  readonly className?: string;
}

export function ColourField({
  label,
  path,
  value,
  scope,
  onOp,
  className,
}: FieldProps<string>): React.JSX.Element {
  const id = `field-${path.replace(/\./g, "-")}`;
  return (
    <label
      className={cn("flex items-center justify-between gap-3 text-sm", className)}
      htmlFor={id}
    >
      <span className="text-white/80">{label}</span>
      <input
        id={id}
        type="color"
        // `<input type=color>` only understands `#RRGGBB`.
        value={value.slice(0, 7)}
        onChange={(event) => {
          onOp(setStyleField(scope, path, event.target.value));
        }}
        className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
        data-testid={id}
      />
    </label>
  );
}

/**
 * A flat two-stop gradient seeded from a solid colour: the Solid → Gradient
 * mode switch's starting point, and what `ColorOrGradientField`'s Reset
 * button (K08) returns to. Both stops start at the same colour so switching
 * modes never changes what's on screen until the user actually drags a stop
 * — the least surprising default, and a real, schema-valid two-stop `Gradient`
 * to edit from rather than a placeholder. 90° matches the reference
 * product's own default (ADDENDUM-full-frame-audit.md, "New gap 3": "an
 * Angle slider at 90°").
 */
export function defaultGradient(seedColor: string): Gradient {
  return {
    stops: [
      { offset: 0, color: seedColor },
      { offset: 1, color: seedColor },
    ],
    angleDeg: 90,
  };
}

/** A new stop's offset when "+ Stop" is pressed: past the last stop, never past 1. */
function nextStopOffset(stops: readonly GradientStop[]): number {
  const last = stops[stops.length - 1];
  if (last === undefined) return 1;
  return Math.min(1, last.offset + (1 - last.offset) / 2 || 1);
}

/**
 * K08: CSS's `linear-gradient()` angle (0° up, clockwise) does not agree with
 * `render-core`'s own convention for this field (0° left-to-right, 90°
 * top-to-bottom, documented on `GradientSchema`) — this decorative preview
 * swatch is CSS, so it converts, or it would visibly disagree with the live
 * canvas right next to it for the same angle value.
 */
function cssGradientAngle(angleDeg: number): number {
  return angleDeg + 90;
}

export interface ColorOrGradientFieldProps {
  readonly label: string;
  readonly value: string | Gradient;
  readonly onChange: (next: string | Gradient) => void;
  /** Stable prefix for element ids / `data-testid`s, e.g. `"field-colors-text"`. */
  readonly idPrefix: string;
  readonly className?: string;
}

/**
 * Solid/Gradient toggle for one colour field (K08) — the reference product's
 * Emphasis-section Gradient sub-mode (ADDENDUM-full-frame-audit.md, "New gap
 * 3": a Stops editor, Reset, a gradient bar with handles, an Angle slider at
 * 90°). Solid keeps a plain hex input, matching `ColourField` above exactly;
 * Gradient reveals a stop list (colour + position, 2-6 stops, add/remove) and
 * an angle slider, plus a read-only preview bar in place of the reference
 * product's draggable "handles" — a stop's *position* is a number either way,
 * and a slider/numeric input is operable by keyboard and a screen reader
 * where a custom drag-to-reposition hit box is not (README golden rule:
 * "match behaviour and information density, not pixel-perfect branding").
 *
 * Generic over *how* the change is written — `onChange` rather than a
 * `path`/`scope`/`onOp` triple like every other field in this file — because
 * its two K08 call sites need different plumbing: `ColorsPanel`'s Text field
 * writes straight through `setStyleField`'s dotted path (`colors.text` is a
 * plain object once it is a `Gradient`, so a partial merge reaches
 * `colors.text.stops`/`.angleDeg` directly — `apps/web/lib/edg/ops.ts`'s
 * `mergeStyleOverrides` deep-merges plain objects field by field and replaces
 * arrays/primitives wholesale, so sending the whole new `stops` array on every
 * stop edit is exactly right), while the Emphasis section's colour writes
 * through `withDefaultEmphasisField` (`emphasisPresets` is an array, opaque
 * to a dotted path, so the whole array is rebuilt on every change — the same
 * shape every other Emphasis control in `RightPanel.tsx` already uses).
 */
export function ColorOrGradientField({
  label,
  value,
  onChange,
  idPrefix,
  className,
}: ColorOrGradientFieldProps): React.JSX.Element {
  const isGradient = typeof value !== "string";
  const solidValue = isGradient ? (value.stops[0]?.color ?? "#ffffffff") : value;

  function setStop(index: number, patch: Partial<GradientStop>): void {
    if (!isGradient) return;
    onChange({
      ...value,
      stops: value.stops.map((stop, i) => (i === index ? { ...stop, ...patch } : stop)),
    });
  }

  function addStop(): void {
    if (!isGradient || value.stops.length >= 6) return;
    const last = value.stops[value.stops.length - 1];
    onChange({
      ...value,
      stops: [
        ...value.stops,
        { offset: nextStopOffset(value.stops), color: last?.color ?? "#ffffffff" },
      ],
    });
  }

  function removeStop(index: number): void {
    if (!isGradient || value.stops.length <= 2) return;
    onChange({ ...value, stops: value.stops.filter((_stop, i) => i !== index) });
  }

  return (
    <div className={cn("flex flex-col gap-2 text-sm", className)} data-testid={`${idPrefix}-field`}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-white/80">{label}</span>
        <div className="flex gap-1" role="radiogroup" aria-label={`${label} fill type`}>
          <button
            type="button"
            role="radio"
            aria-checked={!isGradient}
            onClick={() => {
              if (isGradient) onChange(solidValue);
            }}
            className={cn(
              "rounded-md px-2 py-1 text-xs",
              !isGradient ? "bg-white text-black" : "bg-white/10 text-white/80",
            )}
            data-testid={`${idPrefix}-mode-solid`}
          >
            Solid
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isGradient}
            onClick={() => {
              if (!isGradient) onChange(defaultGradient(solidValue));
            }}
            className={cn(
              "rounded-md px-2 py-1 text-xs",
              isGradient ? "bg-white text-black" : "bg-white/10 text-white/80",
            )}
            data-testid={`${idPrefix}-mode-gradient`}
          >
            Gradient
          </button>
        </div>
      </div>

      {!isGradient ? (
        <input
          type="color"
          value={solidValue.slice(0, 7)}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className="h-7 w-12 cursor-pointer rounded border border-white/10 bg-transparent"
          data-testid={`${idPrefix}-solid`}
        />
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-white/10 p-2">
          <div
            className="h-4 w-full rounded"
            style={{
              background: `linear-gradient(${String(cssGradientAngle(value.angleDeg))}deg, ${[
                ...value.stops,
              ]
                .sort((a, b) => a.offset - b.offset)
                .map((stop) => `${stop.color} ${String(stop.offset * 100)}%`)
                .join(", ")})`,
            }}
            data-testid={`${idPrefix}-preview`}
          />
          {value.stops.map((stop, index) => (
            // Stops have no stable id of their own (a StyleDoc array position,
            // like every other array field this panel edits) and the list only
            // ever grows/shrinks from its own end-adjacent controls, so index
            // keys are safe here — the same trade every emphasis-preset control
            // in `RightPanel.tsx` already makes.
            <div key={index} className="flex items-center gap-2">
              <input
                type="color"
                value={stop.color.slice(0, 7)}
                onChange={(event) => {
                  setStop(index, { color: event.target.value });
                }}
                className="h-6 w-8 cursor-pointer rounded border border-white/10 bg-transparent"
                data-testid={`${idPrefix}-stop-${String(index)}-color`}
              />
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={stop.offset}
                onChange={(event) => {
                  setStop(index, { offset: Number(event.target.value) });
                }}
                className="flex-1"
                aria-label={`Stop ${String(index + 1)} position`}
                data-testid={`${idPrefix}-stop-${String(index)}-offset`}
              />
              <span className="w-9 text-right text-xs tabular-nums text-white/60">
                {Math.round(stop.offset * 100)}%
              </span>
              <button
                type="button"
                onClick={() => {
                  removeStop(index);
                }}
                disabled={value.stops.length <= 2}
                className="rounded px-1.5 py-0.5 text-xs text-white/60 hover:text-white disabled:opacity-30"
                data-testid={`${idPrefix}-stop-${String(index)}-remove`}
                aria-label={`Remove stop ${String(index + 1)}`}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={addStop}
              disabled={value.stops.length >= 6}
              className="rounded-md bg-white/10 px-2 py-1 text-xs text-white/80 disabled:opacity-30"
              data-testid={`${idPrefix}-add-stop`}
            >
              + Stop
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(defaultGradient(solidValue));
              }}
              className="rounded-md bg-white/10 px-2 py-1 text-xs text-white/80"
              data-testid={`${idPrefix}-reset`}
            >
              Reset
            </button>
          </div>
          <label className="flex flex-col gap-1" htmlFor={`${idPrefix}-angle`}>
            <span className="flex items-center justify-between text-white/80">
              <span>Angle</span>
              <span className="tabular-nums text-white/60">{value.angleDeg}°</span>
            </span>
            <input
              id={`${idPrefix}-angle`}
              type="range"
              min={0}
              max={360}
              step={1}
              value={value.angleDeg}
              onChange={(event) => {
                onChange({ ...value, angleDeg: Number(event.target.value) });
              }}
              data-testid={`${idPrefix}-angle`}
            />
          </label>
        </div>
      )}
    </div>
  );
}

export interface SliderFieldProps extends FieldProps<number> {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
}

export function SliderField({
  label,
  path,
  value,
  scope,
  onOp,
  min,
  max,
  step = 1,
  unit,
  className,
}: SliderFieldProps): React.JSX.Element {
  const id = `field-${path.replace(/\./g, "-")}`;
  return (
    <div className={cn("flex flex-col gap-1 text-sm", className)}>
      <label className="flex items-center justify-between text-white/80" htmlFor={id}>
        <span>{label}</span>
        <span className="tabular-nums text-white/60">
          {value}
          {unit ?? ""}
        </span>
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          onOp(setStyleField(scope, path, Number(event.target.value)));
        }}
        data-testid={id}
      />
    </div>
  );
}

export interface SelectFieldProps<T extends string> extends FieldProps<T> {
  readonly options: readonly { readonly value: T; readonly label: string }[];
}

export function SelectField<T extends string>({
  label,
  path,
  value,
  scope,
  onOp,
  options,
  className,
}: SelectFieldProps<T>): React.JSX.Element {
  const id = `field-${path.replace(/\./g, "-")}`;
  return (
    <label
      className={cn("flex items-center justify-between gap-3 text-sm", className)}
      htmlFor={id}
    >
      <span className="text-white/80">{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onOp(setStyleField(scope, path, event.target.value));
        }}
        className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
        data-testid={id}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface SearchSelectFieldProps extends FieldProps<string> {
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
}

/**
 * A searchable dropdown: a text input with a native `<datalist>`, so typing
 * filters the option list (browser-built autocomplete, no extra JS state
 * machine) while the field still only ever commits a value from `options` —
 * K01's Font Family picker, whose catalogue is too long for a plain
 * `<select>` to browse comfortably.
 *
 * The typed text is local state so a partial, not-yet-matching keystroke
 * does not get clobbered by the last committed `value` on every render; it
 * resyncs to `value` on blur (if what's typed never matched) and whenever
 * `value` changes from outside (switching the selected style, undo).
 */
export function SearchSelectField({
  label,
  path,
  value,
  scope,
  onOp,
  options,
  placeholder,
  className,
}: SearchSelectFieldProps): React.JSX.Element {
  const id = `field-${path.replace(/\./g, "-")}`;
  const listId = `${id}-options`;
  const [text, setText] = useState(value);

  useEffect(() => {
    setText(value);
  }, [value]);

  function commit(next: string): void {
    const match = options.find(
      (option) => option.value.toLowerCase() === next.trim().toLowerCase(),
    );
    if (match !== undefined) onOp(setStyleField(scope, path, match.value));
  }

  return (
    <label className={cn("flex flex-col gap-1 text-sm", className)} htmlFor={id}>
      <span className="text-white/80">{label}</span>
      <input
        id={id}
        type="text"
        list={listId}
        value={text}
        placeholder={placeholder}
        onChange={(event) => {
          setText(event.target.value);
          commit(event.target.value);
        }}
        onBlur={(event) => {
          if (!options.some((option) => option.value === event.target.value)) setText(value);
        }}
        className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-sm"
        data-testid={id}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </datalist>
    </label>
  );
}

export function ToggleField({
  label,
  path,
  value,
  scope,
  onOp,
  className,
}: FieldProps<boolean>): React.JSX.Element {
  const id = `field-${path.replace(/\./g, "-")}`;
  return (
    <label
      className={cn("flex items-center justify-between gap-3 text-sm", className)}
      htmlFor={id}
    >
      <span className="text-white/80">{label}</span>
      <input
        id={id}
        type="checkbox"
        checked={value}
        onChange={(event) => {
          onOp(setStyleField(scope, path, event.target.checked));
        }}
        data-testid={id}
      />
    </label>
  );
}
