# `editor/transcript/scripts` — script tabs and translation (A22)

`ScriptTabs` (the tab bar: Roman / Native / EN / +Add translation…) and
`RegenerateTranslationDialog` (the confirmation before a translation
regenerate replaces a user's edit), over the `@montaj/api-client` hooks this
work package added: `useTranscriptScripts`, `useTransliterateTranscript`,
`useTranslateTranscript`.

## Integration note — A15 and A19 are not on `main`

The brief's web scope assumes a live transcript editor (A15, "script tabs in
the editor become live: switching changes displayed text and the caption
preview script; editing in a script writes that script's override") and a
finished export dialog (A19, "per-export script selection is already in
A19's dialog — wire the list"). Neither exists on `main` as of this work
package: `apps/web/components/editor/` has no `transcript/` tree beyond what
A22 adds here, and there is no export dialog to find a script list in.

So this is what actually shipped, and what is deliberately left for A15/A19
to pick up:

- **`ScriptTabs`** is a complete, tested, self-contained tab bar. It takes
  `projectId`, `activeScript` and `onScriptChange` and owns nothing else — no
  assumption about where the caption preview or the word-level text editor
  live, because neither exists yet to assume about. The moment A15 has a
  transcript panel, dropping `<ScriptTabs projectId={id} activeScript={script}
onScriptChange={setScript} />` in above it and reacting to `onScriptChange`
  (re-render captions from `word.scripts[script]` or, for `translated`, from
  `segment.textOverrides.translated`) is the entire integration — the
  producers, the free/paid distinction, the regenerate confirmation and the
  error surfacing (`transcript/plan_required`) are already handled here.
- **The export dialog's script list** (`GET /projects/{id}/transcript/scripts`)
  is exactly `useTranscriptScripts(projectId).data.scripts.filter(s =>
s.available)` — there is nothing to build beyond calling the hook, once A19
  has a dialog to call it from. Not built here because there is no dialog
  component in this work package's file boundary to add it to.
- **Editing a word's text in a given script** ("editing in a script writes
  that script's override") is a transcript **editor** capability — it needs
  the word list, the caret, the segment boundaries, none of which exist
  outside A15's future components. It is not attempted here; the write path it
  would call (`EditWord{wordId, text, script}` for `roman`/`native`,
  `SetSegmentText{segmentId, script:"translated", text}` for a translation) is
  the ordinary EDG op batch (`packages/api-client`'s `useEdgOps`-style
  surface, once A15 builds against it) and needs no new endpoint from this
  work package.

## Files

```
ScriptTabs.tsx                    the tab bar; the two producers; error/plan-gate surfacing
RegenerateTranslationDialog.tsx   the "this replaces your edits" confirmation
```

## Testing

```sh
pnpm --filter @montaj/web test components/editor/transcript/scripts
```

`ScriptTabs.test.tsx` drives the real hooks against a mocked `fetch`
(`renderWithProviders`, `apps/web/test/harness.tsx`) rather than mocking the
hooks themselves, so a test failure here means the route, the query key or the
error mapping is actually wrong — the same reason every other web test in this
codebase does it this way.
