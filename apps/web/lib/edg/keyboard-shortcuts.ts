/**
 * The editor's keyboard map (08 §4 / brief §4): `Space`, `J`/`K`/`L`, `S`
 * split, `M` merge, `E` emphasise, `Del` delete word, `Ctrl+F` find/replace,
 * `Ctrl+Z`/`Ctrl+Y` undo/redo. `A`/`R` (accept/reject a proposal) are
 * reserved for B20's Passes review and deliberately not bound here.
 *
 * `classify` is pure — a `KeyboardEvent`-shaped input in, an action name out —
 * so the mapping itself is unit-testable without mounting anything; the hook
 * below is the thin `window` listener around it.
 */
import { useEffect, useRef } from "react";

export type ShortcutAction =
  | "playPause"
  | "jogBack"
  | "jogPause"
  | "jogForward"
  | "split"
  | "merge"
  | "emphasize"
  | "deleteWord"
  | "find"
  | "undo"
  | "redo";

export interface KeyLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/**
 * `undefined` when the key combination is not one of the shortcuts above —
 * including every combination the browser or an OS IME needs for itself
 * (`Ctrl+C`, `Ctrl+V`, arrow keys, ...).
 */
export function classify(event: KeyLike): ShortcutAction | undefined {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

  if (mod && key === "f") return "find";
  if (mod && key === "z") return event.shiftKey ? "redo" : "undo";
  if (mod && key === "y") return "redo";
  if (mod || event.altKey) return undefined;

  switch (key) {
    case " ":
      return "playPause";
    case "j":
      return "jogBack";
    case "k":
      return "jogPause";
    case "l":
      return "jogForward";
    case "s":
      return "split";
    case "m":
      return "merge";
    case "e":
      return "emphasize";
    case "Delete":
    case "Backspace":
      return "deleteWord";
    default:
      return undefined;
  }
}

/** `true` when the event's target is a live text-entry surface the shortcut should not steal a keystroke from. */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // `isContentEditable` is the spec-correct check, but jsdom's implementation
  // does not compute it from the attribute the way a real browser does
  // (`keyboard-shortcuts.test.ts` caught this), so the attribute is read
  // directly too — `WordChip` sets it via React's `contentEditable` prop,
  // which lands on the DOM as the same `"true"`/`"false"` string either way.
  if (target.isContentEditable || target.getAttribute("contenteditable") === "true") return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export type ShortcutHandlers = Partial<Record<ShortcutAction, () => void>>;

/**
 * Binds the map to `window`. Ignored while a `WordChip` is mid-edit or a
 * dialog's text field has focus (`isTextEntryTarget`) — `Ctrl+F`/`Ctrl+Z`
 * still fire everywhere, since undoing or opening find while typing a word is
 * a normal editor expectation, matched by every text editor's own binding of
 * those two.
 *
 * `handlers` is read through a ref updated every render rather than
 * re-subscribed on every change: it closes over the editor's live selection
 * (which word or segment `S`/`M`/`E`/`Del` act on), and that changes on every
 * click — one `addEventListener` for the component's life is what keeps a
 * keyboard map from costing a DOM subscription per selection change while
 * still always calling this render's handlers, never a stale one's.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent): void {
      const action = classify(event);
      if (action === undefined) return;
      const isEditing = isTextEntryTarget(event.target);
      if (isEditing && action !== "find" && action !== "undo" && action !== "redo") return;
      // eslint-disable-next-line security/detect-object-injection -- bracket access on a typed/enumerated key, not attacker-controlled -- reviewed for docs/security/threat-model-audit-2026-09-03.md's eslint-plugin-security follow-up
      const handler = handlersRef.current[action];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}
