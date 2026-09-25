"use client";

import * as React from "react";

/**
 * "To editor" package download — a stub per the brief: the real package
 * (project bundle for re-import) ships in B15/C-phase. This tab exists so the
 * dialog's three-tab shape (`08 §4 v2`) is in place now.
 */
export function ToEditorTab(): React.JSX.Element {
  return (
    <div className="py-4 text-center" data-testid="export-to-editor-tab">
      <p className="text-fg-2 text-sm">Editor packages ship soon.</p>
      <p className="text-fg-2 mt-1 text-xs opacity-70">
        Round-trip a project into Premiere, After Effects or Resolve as a native package.
      </p>
    </div>
  );
}
