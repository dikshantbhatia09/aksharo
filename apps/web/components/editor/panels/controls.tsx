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
