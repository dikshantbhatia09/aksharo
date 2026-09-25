"use client";

/**
 * A working harness for the right-hand panel: pick a style, change its colours,
 * look and animation, and watch the ops the editor would send.
 *
 * It holds the pieces A15 will hold for real — the effective style and the op
 * log — so the panel itself stays a pure "state in, op out" component.
 */

import { useMemo, useState } from "react";

import type { StyleDoc } from "@montaj/caption-styles";
import { mergeOverrides } from "@montaj/render-core";

import { type PanelScope, type SetStyleOp } from "./ops";
import { RightPanel } from "./RightPanel";
import { PICKABLE_STYLES } from "./system-styles";

export interface StyleGalleryProps {
  /** Defaults to the system catalogue; A15 passes the workspace's own. */
  readonly styles?: readonly StyleDoc[];
}

export function StyleGallery({ styles = PICKABLE_STYLES }: StyleGalleryProps): React.JSX.Element {
  const [styleId, setStyleId] = useState(styles[0]?.id ?? "");
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const [ops, setOps] = useState<SetStyleOp[]>([]);
  const scope: PanelScope = useMemo(() => ({ kind: "doc" }), []);

  const style = useMemo(() => {
    const base = styles.find((entry) => entry.id === styleId) ?? styles[0];
    if (base === undefined) return undefined;
    return mergeOverrides(base, overrides);
  }, [styles, styleId, overrides]);

  if (style === undefined)
    return <p className="text-fg-1 text-sm">The style catalogue is empty.</p>;

  return (
    <div className="flex gap-6">
      <RightPanel
        styles={styles}
        style={style}
        scope={scope}
        onOp={(op) => {
          setOps((previous) => [op, ...previous].slice(0, 20));
          if (op.styleRef !== undefined) {
            setStyleId(op.styleRef);
            setOverrides({});
          }
          if (op.overrides !== undefined) {
            setOverrides((previous) => mergeOverrides(previous, op.overrides));
          }
        }}
      />
      <pre
        className="border-border bg-bg-0 text-fg-1 max-h-[70vh] flex-1 overflow-auto rounded-sm border p-3 text-xs"
        data-testid="style-gallery-ops"
      >
        {ops.map((op) => JSON.stringify(op)).join("\n")}
      </pre>
    </div>
  );
}
