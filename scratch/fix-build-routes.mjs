import { readFileSync, writeFileSync } from 'node:fs';
const base = 'apps/web/app/(site)/(marketing)/docs/';
for (const file of ['developers/[version]/[tag]/page.tsx', 'developers/[version]/page.tsx', 'guides/[slug]/page.tsx', 'plugins/[slug]/page.tsx']) {
  const path = base + file;
  let s = readFileSync(path, 'utf8');
  s = s.replace(/export (default )?function (generateMetadata|\w+Page)\(\{\s*params,?\s*\}: \{\s*params: (\{[^}]+\});?\s*\}\): (Metadata|React.JSX.Element) \{/g,
    (_, def, name, type, returns) => `export ${def ?? ''}async function ${name}({ params: pendingParams }: { params: Promise<${type}> }): Promise<${returns}> {\n  const params = await pendingParams;`);
  writeFileSync(path, s);
}
const route = 'apps/web/app/(site)/r/[code]/route.ts';
writeFileSync(route, readFileSync(route, 'utf8').replace('export const AFFILIATE_COOKIE_NAME', 'const AFFILIATE_COOKIE_NAME').replace('export const AFFILIATE_COOKIE_DAYS', 'const AFFILIATE_COOKIE_DAYS'));
