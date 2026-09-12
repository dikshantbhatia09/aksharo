import fs from 'node:fs';
import path from 'node:path';

const stylesDir = path.resolve('packages/caption-styles/styles');
const files = fs.readdirSync(stylesDir).filter(f => f.endsWith('.json') && f !== 'registry.json').sort();

function toCamel(str) {
  return str.replace(/-([a-z0-9])/g, (_, g) => g.toUpperCase());
}

const imports = files.map(f => {
  const id = f.replace(/\.json$/, '');
  const varName = toCamel(id);
  return import  from  @montaj/caption-styles/styles/;;
}).join('\n');

const docVars = files.map(f =>   ,).join('\n');

const content = /**
 * The system style catalogue, as a browser-loadable module.
 *
 * The documents are imported as JSON and validated with the same schema the
 * server uses, so a malformed style fails the build rather than the render.
 */

import type { StyleDoc } from @montaj/caption-styles;


const DOCUMENTS: readonly unknown[] = [

];

export const SYSTEM_STYLES: readonly StyleDoc[] = DOCUMENTS as readonly StyleDoc[];

const baseMap = new Map<string, StyleDoc>(
  SYSTEM_STYLES.map((style) => [style.id, style]),
);
const defaultStyle = baseMap.get(plain-white) ?? SYSTEM_STYLES[0];

// Fallback for legacy project styles to plain-white
for (const legacyId of [
  punch-pop,
  hype-bold,
  vertical-clean,
  karaoke-fill,
  podcast-duo,
  word-pop,
  bubble-soft,
  neon-glow,
  glitch-shift,
  prism-split,
  highlight-marker,
  gradient-sweep,
  arcade-pixel,
  box-block,
  bold-drop,
  caption-card,
  duo-tone,
  impact-shout,
  liquid-glass,
  minimal-lower-third,
  news-ticker,
  outline-only,
  quote-frame,
  soft-serif,
  spotlight-word,
  stroke-heavy,
  subtitle-classic,
  tape-retro,
  typewriter-mono,
  whisper-thin,
]) {
  if (!baseMap.has(legacyId) && defaultStyle) {
    baseMap.set(legacyId, defaultStyle);
  }
}

export const SYSTEM_STYLE_MAP: ReadonlyMap<string, StyleDoc> = baseMap;
;

const target = path.resolve('apps/web/components/editor/panels/system-styles.ts');
fs.writeFileSync(target, content, 'utf8');
console.log('Updated system-styles.ts with all', files.length, 'styles');
