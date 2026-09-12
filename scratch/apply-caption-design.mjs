import { readFileSync, writeFileSync } from 'node:fs';

function edit(path, fn) {
  const before = readFileSync(path, 'utf8');
  const after = fn(before.replaceAll('\r\n', '\n'));
  writeFileSync(path, after);
}
function replace(text, before, after) {
  if (!text.includes(before)) throw new Error(`Missing replacement: ${before.slice(0, 100)}`);
  return text.replace(before, after);
}

edit('apps/web/components/shell/sidebar.tsx', s => s
  .replace('import { AudioLines, HardDrive, Monitor }', 'import { ArrowUpRight, AudioLines, HardDrive, Monitor }')
  .replace('export function UpgradeButton(): React.JSX.Element | null {', 'export function UpgradeButton({ editor = false }: { editor?: boolean } = {}): React.JSX.Element | null {')
  .replace('<Link href="/billing">Upgrade</Link>', '<Link href="/billing" className={editor ? "editor-upgrade" : undefined}>Upgrade{editor ? <ArrowUpRight className="size-[13px]" aria-hidden="true" /> : null}</Link>'));

edit('apps/web/app/(app)/p/[id]/editor-client.tsx', s => {
  s = s.replace('import { NeedsTranscription }', 'import "@/components/editor/editor.css";\n\nimport { NeedsTranscription }');
  s = s.replace('const OUTER_DEFAULT = { left: 76, style: 24 }', 'const OUTER_DEFAULT = { left: 80.127678, style: 19.872322 }');
  s = s.replace('const LEFTSPLIT_DEFAULT = { transcriptCol: 71, stage: 29 }', 'const LEFTSPLIT_DEFAULT = { transcriptCol: 70.647773, stage: 29.352227 }');
  s = s.replace('const TRANSCOL_DEFAULT = { main: 54, timeline: 46 }', 'const TRANSCOL_DEFAULT = { main: 54.196643, timeline: 45.803357 }');
  s = s.replaceAll('montaj-editor-outer-v2', 'montaj-editor-outer-design-v4').replaceAll('montaj-editor-leftsplit-v3', 'montaj-editor-leftsplit-design-v4').replaceAll('montaj-editor-transcriptcol-v3', 'montaj-editor-transcriptcol-design-v4');
  s = s.replace('<div className="flex h-dvh flex-col" data-testid="editor-root">', '<div className="caption-editor flex h-dvh min-h-0 flex-col overflow-hidden" data-testid="editor-root">');
  const headerStart = s.indexOf('      <header className="bg-bg-1 border-border flex h-[52px]');
  const headerEnd = s.indexOf('      </header>', headerStart) + '      </header>'.length;
  if (headerStart < 0) throw new Error('Missing editor header');
  s = s.slice(0, headerStart) + `      <EditorCommandPalette ctx={editorActionContext} />
      <RetranscribeDialog
        projectId={projectId}
        sourceLanguage={project?.sourceLanguage ?? null}
        open={retranscribeOpen}
        onOpenChange={setRetranscribeOpen}
      />
      <span data-testid="editor-pending-count" data-pending={String(snapshot.pendingCount)} className="sr-only">{snapshot.pendingCount}</span>
      {snapshot.offline ? <div data-testid="editor-offline" className="text-proposed px-3 text-xs">Offline — retrying…</div> : null}` + s.slice(headerEnd);
  // Secondary commands stay mounted in the tools popover, including script discovery.
  s = replace(s, '                      >\n                        <BulkActionsBar', `                      >
                        <EditorMenubar ctx={editorActionContext} />
                        <ScriptTabs projectId={projectId} activeScript={script} onScriptChange={setScript} onAvailable={onScriptsAvailable} />
                        <label className="text-fg-1 flex items-center gap-2 text-xs">
                          <input type="checkbox" checked={hideFillers} data-testid="hide-fillers-toggle" onChange={(event) => setHideFillers(event.target.checked)} />
                          Hide fillers
                        </label>
                        <BulkActionsBar`);
  s = replace(s, 'className="min-h-0 flex-1"\n        {...outerLayout}', 'className="editor-workspace min-h-0 flex-1"\n        {...outerLayout}');
  s = s.replace('className="border-border bg-bg-1 h-full min-w-0 border-r"', 'className="editor-transcript-panel bg-bg-1 h-full min-w-0 overflow-hidden rounded-[10px]"');
  s = s.replace('className="flex h-full min-w-0 flex-col gap-2 p-3"', 'className="editor-transcript-content flex h-full min-w-0 flex-col pr-2.5 pl-3.5"');
  s = s.replace('className="border-border bg-bg-1 scrollbar-thin h-full overflow-y-auto border-t p-2"', 'className="editor-timeline-panel bg-bg-1 scrollbar-thin h-full overflow-y-auto rounded-[10px]"');
  s = s.replace('className="bg-bg-0 flex h-full min-w-0 flex-col p-4"\n                style={{ containerType: "size" }}', 'className="editor-player-column bg-bg-0 flex h-full min-w-0 flex-col gap-2"');
  s = s.replace('className="min-h-0 flex-1 flex items-center justify-center"', 'className="editor-player-viewport flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[10px]" style={{ containerType: "size" }}');
  s = s.replace('className="relative max-h-full max-w-full"', 'className="editor-stage-box relative max-h-full max-w-full overflow-hidden rounded-[10px]"');
  s = s.replace('fullscreenTarget={stageBoxRef}', 'fullscreenTarget={stageBoxRef}\n                  onSeek={(ms) => playhead.seek(ms)}');
  s = s.replace('minSize="20rem"', 'minSize="320px"');
  s = s.replace('className="bg-bg-1 border-border scrollbar-thin flex h-full min-h-0 flex-col gap-2 overflow-y-auto border-l p-3"', 'className="editor-inspector flex h-full min-h-0 flex-col overflow-hidden rounded-[10px]"');
  return s;
});

edit('apps/web/components/editor/transcript/CaptionsPanelHeader.tsx', s => s
  .replace('{open ? (\n          <div', '<div')
  .replace('role="menu"\n            aria-label="Caption Tools"', 'hidden={!open}\n            aria-label="Caption Tools"')
  .replace('          </div>\n        ) : null}', '          </div>'));

edit('apps/web/components/editor/transcript/SegmentCard.tsx', s => {
  s = s.replace('"group bg-bg-0 flex items-start gap-2 rounded-sm border p-2 transition-colors duration-[160ms]"', '"editor-caption-row group relative flex min-h-[57px] items-center gap-3.5 border-b py-2 transition-colors duration-[160ms]"');
  s = s.replace('selected ? "border-lime-500" : "border-border hover:border-fg-2/40"', 'selected ? "is-selected" : ""');
  s = s.replace('className="text-fg-2 shrink-0 pt-1 text-right text-2xs tabular-nums"', 'className="text-fg-disabled w-[22px] shrink-0 text-[12.5px] tabular-nums"');
  s = s.replace('className="text-fg-2 hover:text-fg-0 shrink-0 pt-1 font-mono text-2xs tabular-nums transition-colors duration-[160ms]"', 'className="editor-caption-timestamp text-fg-2 hover:text-fg-0 font-mono text-2xs tabular-nums"');
  s = s.replace('className="flex min-w-0 flex-1 flex-wrap items-center gap-1 text-sm leading-relaxed"', 'className="editor-caption-words flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1 text-[15px] leading-6"');
  s = s.replace('className="ml-auto flex shrink-0 items-center gap-0.5"', 'className="editor-caption-actions ml-auto flex shrink-0 items-center gap-2 pr-4"');
  s = s.replace('"text-fg-2 hover:text-fg-0 hover:bg-bg-2 flex size-6 items-center justify-center rounded-sm transition-[color,background-color,opacity]', '"editor-caption-hide text-fg-2 hover:text-fg-0 hover:bg-bg-2 flex size-6 items-center justify-center rounded-sm transition-[color,background-color,opacity]');
  return s;
});

edit('apps/web/components/editor/transcript/WordChip.tsx', s => s
  .replace('"bg-bg-2 text-fg-1 inline-block cursor-text rounded-[6px] px-1.5 py-0.5 text-xs outline-none transition-colors duration-[160ms]"', '"editor-word-chip text-fg-0 inline-block cursor-text rounded-[6px] px-0.5 py-0.5 text-[15px] outline-none transition-colors duration-[160ms]"')
  .replace('word.isEmphasized && "border border-[#FFB800] bg-[#FFB800]/15 text-[#FFB800] shadow-[0_0_8px_rgba(255,184,0,0.3)]"', 'word.isEmphasized && "editor-word-emphasis"'));
edit('apps/web/components/editor/transcript/TranscriptList.tsx', s => s.replace('const DEFAULT_ROW_HEIGHT = 64;', 'const DEFAULT_ROW_HEIGHT = 57;').replace('className="pb-1.5"', 'className="editor-transcript-measured-row"'));

edit('apps/web/components/editor/panels/RightPanel.tsx', s => {
  s = s.replace('  const [tab, setTab]', '  const [mode, setMode] = useState<"captions" | "edit">("captions");\n  const [tab, setTab]');
  s = s.replace('"flex h-full min-h-0 w-full flex-col gap-3"', '"editor-right-panel flex h-full min-h-0 w-full flex-col"');
  const switchStart = s.indexOf('      {/*\n        design/09 §2');
  const switchEnd = s.indexOf('      <div className="flex items-center gap-1">', switchStart);
  s = s.slice(0, switchStart) + `      <div className="editor-inspector-mode" role="radiogroup" aria-label="Inspector mode">
        {(["captions", "edit"] as const).map((value) => (
          <button key={value} type="button" role="radio" aria-checked={mode === value} onClick={() => setMode(value)}>
            {value === "captions" ? "Captions" : "Edit"}
          </button>
        ))}
      </div>

` + s.slice(switchEnd);
  s = s.replace('<div className="flex items-center gap-1">\n        {/*', '<div className="editor-inspector-tabs" hidden={mode !== "captions"}>\n        {/*');
  s = s.replace('className="border-border scrollbar-thin flex min-w-0 flex-1 items-center gap-1 overflow-x-auto border-b"', 'className="scrollbar-thin flex min-w-0 flex-1 items-center gap-[26px] overflow-x-auto"');
  s = s.replace('"text-fg-2 hover:text-fg-0 -mb-px shrink-0 border-b-2 border-transparent px-2 py-2 text-sm font-medium transition-colors duration-[160ms]"', '"text-fg-2 hover:text-fg-0 shrink-0 border-b-2 border-transparent pt-3 pb-[9px] text-[13.5px] transition-colors duration-[160ms]"');
  s = s.replace('tab === entry.id ? "border-lime-500 text-fg-0"', 'tab === entry.id ? "border-fg-0 text-fg-0"');
  s = s.replace('      {tab === "style" ? (', `      {mode === "edit" ? (
        <div className="editor-inspector-body scrollbar-thin min-h-0 flex-1 overflow-y-auto">
          <Section title="Typography"><MoreStylesRow style={style} scope={scope} onOp={onOp} /></Section>
          <Section title="Layout">
            <SliderField label="Max width" path="layout.maxWidthPct" value={style.layout.maxWidthPct} min={20} max={100} unit="%" scope={scope} onOp={onOp} {...(base === undefined ? {} : { base })} />
            <SliderField label="Max lines" path="layout.maxLines" value={style.layout.maxLines} min={1} max={4} scope={scope} onOp={onOp} {...(base === undefined ? {} : { base })} />
          </Section>
          <EffectsPanel style={style} scope={scope} onOp={onOp} {...(base === undefined ? {} : { base })} />
        </div>
      ) : tab === "style" ? (`);
  s = s.replace('className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto"', 'className="editor-inspector-body scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto"');
  s = s.replace('          <StylePreviewCanvas\n', '          {tab === "anim" ? <StylePreviewCanvas\n').replace('            className="shrink-0"\n          />', '            className="shrink-0"\n          /> : null}');
  const effects = `              <EffectsPanel
                style={style}
                scope={scope}
                onOp={onOp}
                {...(base === undefined ? {} : { base })}
              />`;
  s = replace(s, effects, '');
  s = s.replace('<div className="flex shrink-0 justify-end">{footer}</div>', '<div className="editor-inspector-footer flex shrink-0 justify-end">{footer}</div>');
  s = s.replace('className="border-border flex flex-col gap-2.5 border-t pt-3 first:border-t-0 first:pt-0"', 'className="editor-inspector-section flex shrink-0 flex-col"');
  s = s.replace('className="text-fg-2 hover:text-fg-1 flex items-center gap-1.5 text-left transition-colors duration-[160ms]"', 'className="editor-section-heading text-fg-2 hover:text-fg-1 flex h-12 shrink-0 items-center gap-2 text-left transition-colors duration-[160ms]"');
  s = s.replace('className="text-2xs font-medium tracking-wide uppercase"', 'className="text-[11px] font-semibold tracking-[0.11em] uppercase"');
  s = s.replace('{open ? <div className="flex flex-col gap-2.5">{children}</div> : null}', '{open ? <div className="editor-section-fields flex flex-col">{children}</div> : null}');
  s = s.replaceAll('className="flex flex-col gap-3" data-testid=', 'className="flex shrink-0 flex-col" data-testid=');
  s = s.replace('          label="Size"\n          path="typography.sizePct"', '          label="Font Size"\n          path="typography.sizePct"');
  const moreStart = s.indexOf('        {/* Bold/Italic/Strikethrough:');
  const moreEnd = s.indexOf('        <TextAlignRow', moreStart);
  s = s.slice(0, moreStart) + s.slice(moreEnd);
  const positionStart = s.indexOf('        <SliderField\n          label="Max width"', s.indexOf('export function LookPanel'));
  const positionEnd = s.indexOf('      </Section>', positionStart);
  s = s.slice(0, positionStart) + s.slice(positionEnd);
  const strokeStart = s.indexOf('        <ColourField\n          label="Stroke"', s.indexOf('export function ColorsPanel'));
  const strokeEnd = s.indexOf('      </Section>', strokeStart);
  if (strokeStart >= 0) s = s.slice(0, strokeStart) + s.slice(strokeEnd);
  s = s.replace('label="Text"\n          value={style.colors.text}', 'label="Color"\n          value={style.colors.text}');
  return s;
});
