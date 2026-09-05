/** ARCHITECTURE.md §6 — every editor action defined once, rendered thrice
 * (menubar, command palette, keyboard reference). */
export interface EditorActionContext {
  readonly canSplit: boolean; // a segment is selected
  readonly canWordEdit: boolean; // a word is selected
  readonly hideFillers: boolean;
  readonly follow: boolean;
  readonly playing: boolean;
  readonly togglePlay: () => void;
  readonly jog: (deltaMs: number) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly split: () => void;
  readonly mergeWithNext: () => void;
  readonly emphasize: () => void;
  readonly deleteWord: () => void;
  readonly openFind: () => void;
  readonly setHideFillers: (v: boolean) => void;
  readonly setFollow: (v: boolean) => void;
  readonly openExport: () => void;
  readonly openRetranscribe: () => void;
  readonly openShare: () => void;
  readonly openShortcuts: () => void;
  readonly goToProjects: () => void;
}

export type EditorMenuId = "file" | "edit" | "view" | "playback" | "language" | "help";

export interface EditorAction {
  readonly id: string;
  readonly label: string;
  readonly menu: EditorMenuId;
  readonly shortcut?: string;
  readonly destructive?: boolean;
  readonly checked?: (ctx: EditorActionContext) => boolean; // renders as checkbox item
  readonly enabled: (ctx: EditorActionContext) => boolean;
  readonly run: (ctx: EditorActionContext) => void;
}

const always = () => true;

export const EDITOR_ACTIONS: readonly EditorAction[] = [
  {
    id: "file.projects",
    label: "Back to projects",
    menu: "file",
    enabled: always,
    run: (c) => c.goToProjects(),
  },
  {
    id: "file.export",
    label: "Export…",
    menu: "file",
    shortcut: "Ctrl+E",
    enabled: always,
    run: (c) => c.openExport(),
  },
  { id: "file.share", label: "Share…", menu: "file", enabled: always, run: (c) => c.openShare() },
  {
    id: "edit.undo",
    label: "Undo",
    menu: "edit",
    shortcut: "Ctrl+Z",
    enabled: always,
    run: (c) => c.undo(),
  },
  {
    id: "edit.redo",
    label: "Redo",
    menu: "edit",
    shortcut: "Ctrl+Y",
    enabled: always,
    run: (c) => c.redo(),
  },
  {
    id: "edit.split",
    label: "Split segment",
    menu: "edit",
    shortcut: "S",
    enabled: (c) => c.canSplit,
    run: (c) => c.split(),
  },
  {
    id: "edit.merge",
    label: "Merge with next",
    menu: "edit",
    shortcut: "M",
    enabled: (c) => c.canSplit,
    run: (c) => c.mergeWithNext(),
  },
  {
    id: "edit.emphasize",
    label: "Emphasize word",
    menu: "edit",
    shortcut: "E",
    enabled: (c) => c.canWordEdit,
    run: (c) => c.emphasize(),
  },
  {
    id: "edit.deleteWord",
    label: "Delete word",
    menu: "edit",
    shortcut: "Del",
    destructive: true,
    enabled: (c) => c.canWordEdit,
    run: (c) => c.deleteWord(),
  },
  {
    id: "edit.find",
    label: "Find & replace…",
    menu: "edit",
    shortcut: "Ctrl+F",
    enabled: always,
    run: (c) => c.openFind(),
  },
  {
    id: "view.hideFillers",
    label: "Hide fillers",
    menu: "view",
    checked: (c) => c.hideFillers,
    enabled: always,
    run: (c) => c.setHideFillers(!c.hideFillers),
  },
  {
    id: "view.follow",
    label: "Follow playhead",
    menu: "view",
    checked: (c) => c.follow,
    enabled: always,
    run: (c) => c.setFollow(!c.follow),
  },
  {
    id: "playback.toggle",
    label: "Play / Pause",
    menu: "playback",
    shortcut: "Space",
    enabled: always,
    run: (c) => c.togglePlay(),
  },
  {
    id: "playback.back",
    label: "Jog back 1s",
    menu: "playback",
    shortcut: "J",
    enabled: always,
    run: (c) => c.jog(-1000),
  },
  {
    id: "playback.fwd",
    label: "Jog forward 1s",
    menu: "playback",
    shortcut: "L",
    enabled: always,
    run: (c) => c.jog(1000),
  },
  {
    id: "language.retranscribe",
    label: "Re-transcribe…",
    menu: "language",
    enabled: always,
    run: (c) => c.openRetranscribe(),
  },
  {
    id: "help.shortcuts",
    label: "Keyboard shortcuts",
    menu: "help",
    enabled: always,
    run: (c) => c.openShortcuts(),
  },
];

export const EDITOR_MENUS: readonly { id: EditorMenuId; label: string }[] = [
  { id: "file", label: "File" },
  { id: "edit", label: "Edit" },
  { id: "view", label: "View" },
  { id: "playback", label: "Playback" },
  { id: "language", label: "Language" },
  { id: "help", label: "Help" },
];
