import { readFileSync, writeFileSync } from 'node:fs';
const path = 'apps/web/components/editor/timeline/Timeline.tsx';
let s = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
s = s.replace('  AudioWaveform,', '  AudioWaveform,\n  Link2,\n  Magnet,\n  Maximize2,\n  Plus,\n  Scissors,\n  SlidersHorizontal,');
s = s.replace('const RULER_HEIGHT = 24;', 'const RULER_HEIGHT = 26;').replace('const THUMB_LANE_HEIGHT = 32;', 'const THUMB_LANE_HEIGHT = 44;').replace('const WAVEFORM_HEIGHT = 64;', 'const WAVEFORM_HEIGHT = 44;').replace('const WORD_LANE_HEIGHT = 28;', 'const WORD_LANE_HEIGHT = 44;').replace('const SEGMENT_LANE_HEIGHT = 36;', 'const SEGMENT_LANE_HEIGHT = 42;').replace('const LANE_GAP = 2;', 'const LANE_GAP = 0;').replace('const TRACK_LABEL_WIDTH = 92;', 'const TRACK_LABEL_WIDTH = 124;');
s = s.replace('readonly onTogglePlay?: () => void;', 'readonly onTogglePlay?: () => void;\n  readonly onInsertWordAfter?: (afterWordId: string, text: string) => void;');
s = s.replace('  onTogglePlay,', '  onTogglePlay,\n  onInsertWordAfter,');
s = s.replace('const [msPerPx, setMsPerPx] = useState(30);', 'const [msPerPx, setMsPerPx] = useState(1000 / 158);\n  const [snapping, setSnapping] = useState(true);\n  const [linkedSelection, setLinkedSelection] = useState(true);\n  const [addingWord, setAddingWord] = useState(false);\n  const [newWord, setNewWord] = useState("");');
s = s.replaceAll('wordBoundaries: boundaries,', 'wordBoundaries: snapping ? boundaries : [],');
s = s.replaceAll('wordBoundaries: wordBoundariesOf(segment),', 'wordBoundaries: snapping ? wordBoundariesOf(segment) : [],');
s = s.replaceAll('      wordBoundariesOf,', '      wordBoundariesOf,\n      snapping,');
s = s.replace('        onSeek(word.s);', '        if (linkedSelection) onSeek(word.s);');
s = s.replace('        onSeek(lineChip.startMs);', '        if (linkedSelection) onSeek(lineChip.startMs);');
const downStart = s.indexOf('const onPointerDown =');
const downEnd = s.indexOf('const onPointerMove =', downStart);
const down = s.slice(downStart, downEnd).replace('      onSeek,', '      onSeek,\n      linkedSelection,');
s = s.slice(0, downStart) + down + s.slice(downEnd);
s = s.replace('className="flex shrink-0 flex-col overflow-hidden text-xs"', 'className="editor-timeline-labels flex shrink-0 flex-col overflow-hidden text-xs"');
s = s.replace('text-[#c5b882]', 'text-fg-2').replace('text-[#4ea1ff]', 'text-editor-emphasis');
s = s.replace('ctx.fillStyle = "#0b0b12";', 'ctx.fillStyle = "#212126";');
s = s.replace('ctx.fillStyle = "rgba(255,255,255,0.6)";', 'ctx.fillStyle = "#8b8b93";');
s = s.replace('ctx.fillStyle = "#0f0f16";', 'ctx.fillStyle = "#141416";');
s = s.replace('ctx.fillStyle = "rgba(124,143,240,0.25)";\n      ctx.strokeStyle = "#7c8ff0";', 'ctx.fillStyle = "#214a3c";\n      ctx.fillRect(waveformWindow.pxStart, laneTops.waveformTop + 3, waveformWindow.widthPx, WAVEFORM_HEIGHT - 6);\n      ctx.fillStyle = "#49a781";\n      ctx.strokeStyle = "#6dc99e";');
s = s.replace('ctx.strokeStyle = "rgba(255,255,255,0.5)";', 'ctx.strokeStyle = "#6dc99e";');
s = s.replaceAll('"rgba(197,184,130,0.85)"', '"#b0a76f"');
s = s.replaceAll('ctx.fillRect(x0, laneTops.wordTop, w, WORD_LANE_HEIGHT);', 'ctx.beginPath();\n        ctx.roundRect(x0, laneTops.wordTop + 4, w, WORD_LANE_HEIGHT - 8, Math.min(4, w / 2));\n        ctx.fill();');
s = s.replace('ctx.fillText(word.t, x0 + 2, laneTops.wordTop + WORD_LANE_HEIGHT - 9, w - 4);', 'ctx.fillText(word.t, x0 + 5, laneTops.wordTop + 16, Math.max(1, w - 10));\n          ctx.font = "9px sans-serif";\n          ctx.fillText("𝑇 Text", x0 + 5, laneTops.wordTop + 30, Math.max(1, w - 10));');
s = s.replace('ctx.fillText(text, x0 + 2, laneTops.wordTop + WORD_LANE_HEIGHT - 9, w - 4);', 'ctx.fillText(text, x0 + 5, laneTops.wordTop + 16, Math.max(1, w - 10));\n          ctx.font = "9px sans-serif";\n          ctx.fillText("𝑇 Text", x0 + 5, laneTops.wordTop + 30, Math.max(1, w - 10));');
// The empty segment strip remains available for dragging; only the selected
// segment needs a second outline while word/line chips already show all text.
const segStart = s.indexOf('    // Segment lane\n');
const segEnd = s.indexOf('    // Pass lanes:', segStart);
let segmentDraw = s.slice(segStart, segEnd);
segmentDraw = segmentDraw.replace('      const selected = segment.id === selectedSegmentId;', '      const selected = segment.id === selectedSegmentId;\n      if (!selected && segment.hidden !== true) continue;');
s = s.slice(0, segStart) + segmentDraw + s.slice(segEnd);

const toolbarStart = s.indexOf('        <div className="text-fg-2 flex items-center gap-2 pb-2 text-xs">');
const toolbarEnd = s.indexOf('        <div className="flex items-start">', toolbarStart);
let toolbar = s.slice(toolbarStart, toolbarEnd);
const granStart = toolbar.indexOf('          <div className={SEGMENTED_TRACK}');
const granEnd = toolbar.indexOf('          <div className="relative flex items-center', granStart);
const granularity = toolbar.slice(granStart, granEnd).replace('className={SEGMENTED_TRACK}', 'className={cn(SEGMENTED_TRACK, "timeline-granularity")}');
const searchStart = granEnd;
const searchEnd = toolbar.indexOf('          {captionToolsAvailable', searchStart);
const search = toolbar.slice(searchStart, searchEnd);
const toolsStart = searchEnd;
const toolsEnd = toolbar.indexOf('          {outputModeAvailable', toolsStart);
let captionTools = toolbar.slice(toolsStart, toolsEnd);
captionTools = captionTools.replace('className={TOOLBAR_BUTTON}', 'className={TOOL_BUTTON}\n                aria-label="Caption Tools"\n                title="Caption Tools"');
captionTools = captionTools.replace('                Caption Tools\n                <ChevronDown className="size-3.5" aria-hidden="true" />', '                <SlidersHorizontal className="size-[17px]" aria-hidden="true" />');
const playStart = toolbar.indexOf('          <button');
const playEnd = toolbar.indexOf('          <div className={TOOLBAR_DIVIDER}', playStart);
const play = toolbar.slice(playStart, playEnd);
const moreStart = toolsEnd;
const moreEnd = toolbar.indexOf('          {selectedSegmentId !== undefined && onMergeSegments', moreStart);
const more = toolbar.slice(moreStart, moreEnd);
captionTools = captionTools.replace('                  <div\n                    data-testid="caption-tools-display-settings"', `                  <div className="flex items-center gap-2">${play}${search}</div>\n${more}\n                  <div\n                    data-testid="caption-tools-display-settings"`);
const zoomStart = toolbar.indexOf('          <button\n            type="button"\n            data-testid="timeline-zoom-in"');
const zoomEnd = toolbar.indexOf('          <div className={TOOLBAR_DIVIDER}', zoomStart);
const zoomButtons = toolbar.slice(zoomStart, zoomEnd);
const zoomInEnd = zoomButtons.indexOf('          </button>') + '          </button>'.length;
const zoomIn = zoomButtons.slice(0, zoomInEnd);
const zoomOut = zoomButtons.slice(zoomInEnd);
const newToolbar = `        <div className="editor-timeline-toolbar text-fg-2 flex items-center text-xs">
${granularity}
          <div className="relative">
            <button type="button" className={TOOLBAR_BUTTON} aria-expanded={addingWord} disabled={liveWords.length === 0 || onInsertWordAfter === undefined} onClick={() => setAddingWord((open) => !open)}><Plus className="size-[13px]" /> Word</button>
            {addingWord ? <form className="absolute top-full left-0 z-40 mt-2 flex gap-2 rounded-sm border border-border bg-bg-1 p-3" onSubmit={(event) => { event.preventDefault(); const anchor = liveWords.find((word) => word.wid === selectedWordId) ?? liveWords.findLast((word) => word.s <= playheadMs) ?? liveWords[0]; if (anchor !== undefined && newWord.trim() !== "") { onInsertWordAfter?.(anchor.wid, newWord.trim()); setNewWord(""); setAddingWord(false); } }}><input autoFocus aria-label="New word" value={newWord} onChange={(event) => setNewWord(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setAddingWord(false); }} className="w-32 rounded-sm border border-border bg-bg-2 px-2" /><button type="submit" className={TOOLBAR_BUTTON}>Add</button></form> : null}
          </div>
${captionTools}
          <div className={TOOLBAR_DIVIDER} aria-hidden="true" />
          <button type="button" className={TOOL_BUTTON} aria-label="Split caption" title="Split caption (S)" disabled={selectedSegmentId === undefined || onSplitSegment === undefined} onClick={() => { const segment = segments.find((entry) => entry.id === selectedSegmentId); const word = liveWords.find((entry) => entry.wid === selectedWordId) ?? liveWords.find((entry) => entry.s >= playheadMs); if (segment !== undefined && word !== undefined && wordIdWithin(word.wid, segment.startWordId, segment.endWordId)) onSplitSegment?.(segment.id, word.wid); }}><Scissors className="size-[17px]" /></button>
          <button type="button" data-testid="timeline-merge" className={TOOL_BUTTON} aria-label="Merge with next" title="Merge with next (M)" disabled={selectedSegmentId === undefined || onMergeSegments === undefined || segments.at(-1)?.id === selectedSegmentId} onClick={() => { const index = segments.findIndex((entry) => entry.id === selectedSegmentId); const next = segments[index + 1]; if (selectedSegmentId !== undefined && next !== undefined) onMergeSegments?.([selectedSegmentId, next.id]); }}><GitMerge className="size-[17px]" /></button>
          <div className={TOOLBAR_DIVIDER} aria-hidden="true" />
          <button type="button" className={TOOL_BUTTON} aria-label="Snap to word boundaries" title="Snap to word boundaries" aria-pressed={snapping} onClick={() => setSnapping((value) => !value)}><Magnet className="size-[17px]" /></button>
          <button type="button" className={TOOL_BUTTON} aria-label="Link selection to playback" title="Link selection to playback" aria-pressed={linkedSelection} onClick={() => setLinkedSelection((value) => !value)}><Link2 className="size-[17px]" /></button>
          <div className={TOOLBAR_DIVIDER} aria-hidden="true" />
          <div className="editor-timeline-zoom">
${zoomOut}
            <input type="range" className="panel-range" aria-label="Timeline zoom" min={0} max={100} value={100 - Math.log(msPerPx / 5) / Math.log(200) * 100} onChange={(event) => { const next = 5 * Math.pow(200, 1 - Number(event.target.value) / 100); const anchor = scrollMs + widthPx / 2 * msPerPx; setMsPerPx(next); setScrollMs(clampScroll(anchor - widthPx / 2 * next, { msPerPx: next, widthPx }, durationMs)); }} />
${zoomIn}
          </div>
          <button type="button" className={cn(TOOL_BUTTON, "ml-auto")} aria-label="Fit timeline" title="Fit timeline" onClick={() => { setMsPerPx(Math.max(5, Math.min(1000, durationMs / Math.max(1, widthPx)))); setScrollMs(0); }}><Maximize2 className="size-[17px]" /></button>
          <span data-testid="timeline-display-clock" className="sr-only">{formatMs(displayPlayheadMs)} / {formatMs(displayDuration)}</span>
        </div>
`;
s = s.slice(0, toolbarStart) + newToolbar + s.slice(toolbarEnd);
s = s.replace('"bg-bg-1 border-border flex w-full select-none items-start gap-3 border-t p-3"', '"editor-timeline bg-bg-1 flex w-full select-none items-start"');
s = s.replace('className="relative min-w-0 flex-1"', 'className="editor-timeline-column relative min-w-0 flex-1"');
s = s.replace('        <div className="flex items-start">', '        <div className="editor-timeline-tracks flex items-start">');
s = s.replace('className="bg-bg-0 block rounded-[6px]"', 'className="bg-editor-sunken block"');
s = s.replace('        <p className="sr-only" data-testid="timeline-aria-description"', '        <div className="editor-timeline-scroll"><input type="range" className="panel-range" aria-label="Timeline scroll" min={0} max={Math.max(0, durationMs - widthPx * msPerPx)} step={1} value={scrollMs} onChange={(event) => setScrollMs(Number(event.target.value))} /></div>\n        <p className="sr-only" data-testid="timeline-aria-description"');
writeFileSync(path, s);

const editorPath = 'apps/web/app/(app)/p/[id]/editor-client.tsx';
s = readFileSync(editorPath, 'utf8').replace('left: 80.127678, style: 19.872322', 'left: 79.553903, style: 20.446097');
s = s.replace('                          onSetWordTiming={onTimelineSetWordTiming}', '                          onSetWordTiming={onTimelineSetWordTiming}\n                          onInsertWordAfter={onInsertWordAfter}');
writeFileSync(editorPath, s);
