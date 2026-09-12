import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const release = '.next-caption-live-20260912';
const cssRoot = path.resolve('apps/web', release, 'static/css');
const evidence = [];
for (const file of readdirSync(cssRoot)) {
  const bytes = readFileSync(path.join(cssRoot, file));
  if (!bytes.toString().includes('editor-inspector-toggle')) continue;
  const url = `https://aksharo.crestmondtechnologies.com/_next/static/css/${file}`;
  const response = await fetch(url);
  const publicBytes = Buffer.from(await response.arrayBuffer());
  const localSha = createHash('sha256').update(bytes).digest('hex');
  const publicSha = createHash('sha256').update(publicBytes).digest('hex');
  if (response.status !== 200 || localSha !== publicSha) throw new Error('Public editor stylesheet differs from release');
  evidence.push({url, status:response.status, localSha, publicSha, matches:true});
}
if (!evidence.length) throw new Error('Editor stylesheet missing from release');
const result = {release, buildId:readFileSync(path.resolve('apps/web',release,'BUILD_ID'),'utf8').trim(),verifiedAt:new Date().toISOString(),assets:evidence};
writeFileSync('scratch/caption-live-assets-verification.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
