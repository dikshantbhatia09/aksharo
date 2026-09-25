"use client";

/**
 * The control primitives the Colors, Look, Effects and Anim tabs are built from.
 *
 * They are deliberately dumb: each takes a value and a `path` into the StyleDoc
 * and calls back with a `SetStyle` op for that one field. No panel keeps a copy
 * of the style — the editor's document is the only state — which is what makes
 * "the panel emits the right op" a testable statement about `ops.ts` rather
 * than about React.
 *
 * Every field wears the same row: label on the left, control on the right, and
 * a reset that only appears once the field differs from the catalogue style it
 * came from (08 §1's tokens throughout — `bg-0` for a control well against the
 * `bg-1` panel, one 32 px control height, lime reserved for state that is
 * actually *on*).
 */

import { ChevronDown, ChevronUp, CircleDivide, Droplet, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";

import type { Gradient, GradientStop, StyleDoc } from "@montaj/caption-styles";

import { type PanelScope, setStyleField, type SetStyleOp } from "./ops";

import { cn } from "@/lib/utils";

/** Shared row geometry, so a new field cannot drift from the others. */
const ROW = "editor-field-row flex min-h-8 items-center justify-between gap-3";
const LABEL = "editor-field-label text-sm text-fg-1";
const CLUSTER = "editor-field-cluster flex items-center gap-1.5";
const WELL = "editor-field-well h-8 rounded-sm border border-border bg-bg-2 text-xs text-fg-0";

/**
 * The catalogue value behind a dotted `path`, used to decide whether a field is
 * still at its style's default. `Reflect.get` rather than bracket access so the
 * lookup is not a dynamic-property sink.
 */
function valueAtPath(root: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    return Reflect.get(node, key);
  }, root);
}

export interface FieldProps<T> {
  readonly label: string;
  /** Dotted path into the StyleDoc, e.g. `"typography.sizePct"`. */
  readonly path: string;
  readonly value: T;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  /**
   * The catalogue style this document started from. Supplied, the field grows a
   * reset affordance whenever `value` no longer matches the catalogue's value
   * for `path`; omitted, the field simply has no reset.
   */
  readonly base?: StyleDoc;
  readonly className?: string;
}

/**
 * Per-row reset, the reference product's circular arrow: present only when
 * there is something to go back to, so a row at its default carries no noise.
 */
export function ResetButton({
  id,
  label,
  onReset,
  disabled = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly onReset: () => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onReset}
      disabled={disabled}
      aria-label={`Reset ${label}`}
      title={`Reset ${label}`}
      className="editor-reset text-fg-2 hover:text-fg-0 flex size-6 shrink-0 items-center justify-center rounded-[6px] transition-colors duration-[160ms]"
      data-testid={`${id}-reset`}
    >
      <RotateCcw className="size-3.5" aria-hidden="true" />
    </button>
  );
}

/** The reset for a field, or nothing when the field is already at its default. */
function useReset<T>(
  props: Pick<FieldProps<T>, "path" | "value" | "scope" | "onOp" | "base" | "label">,
  id: string,
): React.JSX.Element | null {
  const { path, value, scope, onOp, base, label } = props;
  if (base === undefined) return null;
  const fallback = valueAtPath(base, path);
  if (fallback === undefined) return null;
  return (
    <ResetButton
      id={id}
      label={label}
      disabled={fallback === value}
      onReset={() => {
        onOp(setStyleField(scope, path, fallback));
      }}
    />
  );
}

function fieldId(path: string): string {
  return `field-${path.replace(/\./g, "-")}`;
}

export function ColourField({
  label,
  path,
  value,
  scope,
  onOp,
  base,
  className,
}: FieldProps<string>): React.JSX.Element {
  const id = fieldId(path);
  const reset = useReset({ label, path, value, scope, onOp, base }, id);
  return (
    <div className={cn(ROW, className)}>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <div className={CLUSTER}>
        <span className="text-2xs text-fg-2 tabular-nums uppercase">{value.slice(0, 7)}</span>
        <input
          id={id}
          type="color"
          // `<input type=color>` only understands `#RRGGBB`.
          value={value.slice(0, 7)}
          onChange={(event) => {
            onOp(setStyleField(scope, path, event.target.value));
          }}
          className="panel-swatch"
          data-testid={id}
        />
        {reset}
      </div>
    </div>
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

/** The percentage a range input has filled, as the `--fill` custom property. */
function fillStyle(value: number, min: number, max: number): React.CSSProperties {
  const span = max - min;
  const pct = span === 0 ? 0 : Math.min(100, Math.max(0, ((value - min) / span) * 100));
  return { "--fill": `${String(pct)}%` } as React.CSSProperties;
}

/**
 * A segmented pair/triple: the panel's one-of-N control. Kalakar's own
 * Solid/Gradient and Captions/Edit switches (pixel-sampled from the
 * reference, 2026-09-12) fill the picked option with a plain raised
 * neutral, not the accent — the accent there is reserved for underline
 * tabs and true on/off toggles, confirmed separately.
 */
function segmentedItem(active: boolean): string {
  return cn(
    "h-7 rounded-[6px] border px-2.5 text-xs font-medium transition-colors duration-[160ms]",
    active
      ? "border-transparent bg-bg-3 text-fg-0"
      : "text-fg-2 hover:text-fg-0 border-transparent bg-transparent",
  );
}

const SEGMENTED_TRACK = "flex gap-0.5 rounded-sm border border-border bg-bg-0 p-0.5";

export interface ColorOrGradientFieldProps {
  readonly label: string;
  readonly value: string | Gradient;
  readonly onChange: (next: string | Gradient) => void;
  /** Stable prefix for element ids / `data-testid`s, e.g. `"field-colors-text"`. */
  readonly idPrefix: string;
  readonly className?: string;
  readonly resetValue?: string | Gradient;
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
  resetValue,
}: ColorOrGradientFieldProps): React.JSX.Element {
  const isGradient = typeof value !== "string";
  const solidValue = isGradient ? (value.stops[0]?.color ?? "#ffffffff") : value;
  const [hex, setHex] = useState(solidValue.slice(1, 7));
  useEffect(() => {
    setHex(solidValue.slice(1, 7));
  }, [solidValue]);

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
    <div
      className={cn("editor-color-field flex flex-col gap-2", className)}
      data-testid={`${idPrefix}-field`}
    >
      <div
        className={cn(SEGMENTED_TRACK, "editor-color-mode")}
        role="radiogroup"
        aria-label={`${label} fill type`}
      >
        <button
          type="button"
          role="radio"
          aria-checked={!isGradient}
          onClick={() => {
            if (isGradient) onChange(solidValue);
          }}
          className={segmentedItem(!isGradient)}
          data-testid={`${idPrefix}-mode-solid`}
        >
          <Droplet className="size-3.5" aria-hidden="true" /> Solid
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={isGradient}
          onClick={() => {
            if (!isGradient) onChange(defaultGradient(solidValue));
          }}
          className={segmentedItem(isGradient)}
          data-testid={`${idPrefix}-mode-gradient`}
        >
          <CircleDivide className="size-3.5" aria-hidden="true" /> Gradient
        </button>
      </div>

      {!isGradient ? (
        <div className="editor-color-row flex items-center justify-end gap-1.5">
          <label htmlFor={`${idPrefix}-hex`}>{label}</label>
          <div className="editor-color-well">
            <input
              type="color"
              value={solidValue.slice(0, 7)}
              onChange={(event) => {
                onChange(event.target.value);
              }}
              className="panel-swatch"
              aria-label={`${label} colour`}
              data-testid={`${idPrefix}-solid`}
            />
            <span className="text-editor-muted">#</span>
            <input
              id={`${idPrefix}-hex`}
              aria-label={`${label} hex`}
              value={hex}
              maxLength={6}
              className="editor-color-hex"
              onChange={(event) => setHex(event.target.value)}
              onBlur={() => {
                if (/^[0-9a-f]{6}$/i.test(hex)) onChange(`#${hex}`);
                else setHex(solidValue.slice(1, 7));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </div>
          <ResetButton
            id={idPrefix}
            label={label}
            onReset={() => onChange(resetValue ?? "#ffffff")}
          />
        </div>
      ) : (
        <div className="border-border flex flex-col gap-2 rounded-sm border p-2">
          <div
            className="h-4 w-full rounded-[6px]"
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
                className="panel-swatch w-7"
                aria-label={`Stop ${String(index + 1)} colour`}
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
                className="panel-range flex-1"
                style={fillStyle(stop.offset, 0, 1)}
                aria-label={`Stop ${String(index + 1)} position`}
                data-testid={`${idPrefix}-stop-${String(index)}-offset`}
              />
              <span className="text-2xs text-fg-2 w-9 text-right tabular-nums">
                {Math.round(stop.offset * 100)}%
              </span>
              <button
                type="button"
                onClick={() => {
                  removeStop(index);
                }}
                disabled={value.stops.length <= 2}
                className="text-fg-2 hover:text-fg-0 disabled:text-fg-disabled flex size-6 shrink-0 items-center justify-center rounded-[6px] text-xs transition-colors disabled:cursor-not-allowed disabled:hover:text-fg-disabled"
                data-testid={`${idPrefix}-stop-${String(index)}-remove`}
                aria-label={`Remove stop ${String(index + 1)}`}
              >
                &times;
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={addStop}
              disabled={value.stops.length >= 6}
              className="bg-bg-2 border-border text-fg-1 hover:text-fg-0 disabled:text-fg-disabled h-8 rounded-sm border px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed"
              data-testid={`${idPrefix}-add-stop`}
            >
              + Stop
            </button>
            <button
              type="button"
              onClick={() => {
                onChange(defaultGradient(solidValue));
              }}
              className="bg-bg-2 border-border text-fg-1 hover:text-fg-0 h-8 rounded-sm border px-2.5 text-xs font-medium transition-colors"
              data-testid={`${idPrefix}-reset`}
            >
              Reset
            </button>
          </div>
          <div className={ROW}>
            <label className={LABEL} htmlFor={`${idPrefix}-angle`}>
              Angle
            </label>
            <div className={CLUSTER}>
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
                className="panel-range w-[92px]"
                style={fillStyle(value.angleDeg, 0, 360)}
                data-testid={`${idPrefix}-angle`}
              />
              <span
                className={cn(
                  WELL,
                  "flex w-[62px] items-center justify-center gap-0.5 tabular-nums",
                )}
              >
                {value.angleDeg}
                <span className="text-2xs text-fg-2">&deg;</span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export interface NumberWellProps {
  readonly label: string;
  readonly path: string;
  readonly value: number;
  readonly scope: PanelScope;
  readonly onOp: (op: SetStyleOp) => void;
  readonly base?: StyleDoc;
  readonly unit?: string;
  readonly min?: number;
  readonly max?: number;
  /** Same convention as `SliderField`'s own `displayScale`/`displayDecimals`. */
  readonly displayScale?: number;
  readonly displayDecimals?: number;
  readonly className?: string;
}

/**
 * A plain, directly-editable value well with a reset — no slider. Kalakar's
 * own Position X/Y (pixel-sampled from the reference, 2026-09-12) is the one
 * numeric field on the Text tab with no visible track at all, unlike Font
 * Size/Shadow/every other slider on the same tab — positioning happens by
 * dragging the caption on the canvas, and this is the typed/numeric escape
 * hatch, not a second way to drag. Typing commits on blur or Enter; a
 * non-numeric or out-of-range entry reverts to the last committed value
 * rather than writing garbage.
 */
export function NumberWell({
  label,
  path,
  value,
  scope,
  onOp,
  base,
  unit,
  min = -Infinity,
  max = Infinity,
  displayScale = 1,
  displayDecimals = 0,
  className,
}: NumberWellProps): React.JSX.Element {
  const id = fieldId(path);
  const reset = useReset({ label, path, value, scope, onOp, base }, id);
  const shown = (value * displayScale).toFixed(displayDecimals);
  const [text, setText] = useState(shown);

  useEffect(() => {
    setText(shown);
  }, [shown]);

  function commit(): void {
    const parsed = Number.parseFloat(text);
    if (!Number.isFinite(parsed)) {
      setText(shown);
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed / displayScale));
    if (clamped !== value) onOp(setStyleField(scope, path, clamped));
    else setText(shown);
  }

  return (
    <div className={cn(CLUSTER, "flex-1", className)}>
      <span className={cn(WELL, "flex flex-1 items-center gap-1 px-2.5")}>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          aria-label={label}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="text-fg-0 w-full min-w-0 bg-transparent text-right tabular-nums outline-none"
          data-testid={id}
        />
        {unit === undefined ? null : <span className="text-2xs text-fg-2 shrink-0">{unit}</span>}
      </span>
      {reset}
    </div>
  );
}

export interface SliderFieldProps extends FieldProps<number> {
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly unit?: string;
  /**
   * Multiplies the stored value for the slider track and value well only
   * (e.g. `100` to show a 0–1 fraction like `layout.x` as `50.0 %`, matching
   * design/09's Position/Effects sliders). `min`/`max`/`step` stay in the
   * *stored* unit — the same 0–1 range every other caller of this field
   * already passes — and the reset button still compares the raw, unscaled
   * value against the catalogue style, so a field opting into this has no
   * other change in behaviour. Omitted (the default), rendering is
   * byte-identical to before this prop existed.
   */
  readonly displayScale?: number;
  /** Decimal places for the scaled display text; ignored unless `displayScale` is set. */
  readonly displayDecimals?: number;
}

export function SliderField({
  label,
  path,
  value,
  scope,
  onOp,
  base,
  min,
  max,
  step = 1,
  unit,
  displayScale = 1,
  displayDecimals = 0,
  className,
}: SliderFieldProps): React.JSX.Element {
  const id = fieldId(path);
  const reset = useReset({ label, path, value, scope, onOp, base }, id);
  const scaled = displayScale !== 1;
  const shownValue = value * displayScale;
  const shownMin = min * displayScale;
  const shownMax = max * displayScale;
  const shownStep = step * displayScale;
  return (
    <div className={cn(ROW, className)}>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <div className={CLUSTER}>
        <input
          id={id}
          type="range"
          min={shownMin}
          max={shownMax}
          step={shownStep}
          value={shownValue}
          onChange={(event) => {
            onOp(setStyleField(scope, path, Number(event.target.value) / displayScale));
          }}
          className="panel-range w-[92px]"
          style={fillStyle(shownValue, shownMin, shownMax)}
          data-testid={id}
        />
        <span
          className={cn(
            WELL,
            "editor-field-value flex w-[62px] items-center justify-center gap-0.5 px-2",
          )}
        >
          <input
            type="number"
            aria-label={`${label} value`}
            min={shownMin}
            max={shownMax}
            step={shownStep}
            key={shownValue}
            defaultValue={scaled ? shownValue.toFixed(displayDecimals) : value}
            onBlur={(event) => {
              const parsed = event.currentTarget.valueAsNumber;
              if (Number.isFinite(parsed))
                onOp(
                  setStyleField(scope, path, Math.min(max, Math.max(min, parsed / displayScale))),
                );
              else event.currentTarget.value = String(shownValue);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          {unit === undefined ? null : <span className="text-2xs text-fg-2">{unit}</span>}
        </span>
        {reset}
      </div>
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
  base,
  options,
  className,
}: SelectFieldProps<T>): React.JSX.Element {
  const id = fieldId(path);
  const reset = useReset({ label, path, value, scope, onOp, base }, id);
  return (
    <div className={cn(ROW, className)}>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <div className={CLUSTER}>
        <div className="relative">
          <select
            id={id}
            value={value}
            onChange={(event) => {
              onOp(setStyleField(scope, path, event.target.value));
            }}
            className={cn(
              WELL,
              "hover:border-fg-2/60 w-[168px] appearance-none pr-7 pl-2.5 transition-colors",
            )}
            data-testid={id}
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDown
            className="text-fg-2 pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2"
            aria-hidden="true"
          />
        </div>
        {reset}
      </div>
    </div>
  );
}

export interface SearchSelectFieldProps extends FieldProps<string> {
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly placeholder?: string;
}

export function FieldStepper({
  label,
  onPrevious,
  onNext,
}: {
  readonly label: string;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}): React.JSX.Element {
  return (
    <div className="editor-stepper">
      <button type="button" aria-label={`Previous ${label}`} onClick={onPrevious}>
        <ChevronUp aria-hidden="true" />
      </button>
      <button type="button" aria-label={`Next ${label}`} onClick={onNext}>
        <ChevronDown aria-hidden="true" />
      </button>
    </div>
  );
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
  base,
  options,
  placeholder,
  className,
}: SearchSelectFieldProps): React.JSX.Element {
  const id = fieldId(path);
  const listId = `${id}-options`;
  const [text, setText] = useState(value);
  const reset = useReset({ label, path, value, scope, onOp, base }, id);

  useEffect(() => {
    setText(value);
  }, [value]);

  function commit(next: string): void {
    const match = options.find(
      (option) => option.value.toLowerCase() === next.trim().toLowerCase(),
    );
    if (match !== undefined) onOp(setStyleField(scope, path, match.value));
  }

  function stepOption(delta: number): void {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + delta + options.length) % options.length];
    if (next !== undefined) {
      setText(next.value);
      onOp(setStyleField(scope, path, next.value));
    }
  }

  return (
    <div className={cn(ROW, className)}>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <div className={CLUSTER}>
        <div className="relative">
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
            className={cn(
              WELL,
              "placeholder:text-fg-2 hover:border-fg-2/60 w-[168px] pr-7 pl-2.5 transition-colors",
            )}
            data-testid={id}
          />
          <datalist id={listId}>
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </datalist>
        </div>
        <FieldStepper
          label={label}
          onPrevious={() => stepOption(-1)}
          onNext={() => stepOption(1)}
        />
        {reset}
      </div>
    </div>
  );
}

export function ToggleField({
  label,
  path,
  value,
  scope,
  onOp,
  base,
  className,
}: FieldProps<boolean>): React.JSX.Element {
  const id = fieldId(path);
  const reset = useReset({ label, path, value, scope, onOp, base }, id);
  return (
    <div className={cn(ROW, className)}>
      <label className={LABEL} htmlFor={id}>
        {label}
      </label>
      <div className={CLUSTER}>
        <input
          id={id}
          type="checkbox"
          role="switch"
          checked={value}
          onChange={(event) => {
            onOp(setStyleField(scope, path, event.target.checked));
          }}
          className="panel-switch"
          data-testid={id}
        />
        {reset}
      </div>
    </div>
  );
}
