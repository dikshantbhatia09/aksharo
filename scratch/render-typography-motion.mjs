import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const req = createRequire(path.resolve('apps/web/package.json'));
const { loadPack } = req('@montaj/fonts/node');
const { loadSystemStyleMap } = req('@montaj/caption-styles');
const { createHarfBuzzShaper, layoutSegment, animate } = req('@montaj/render-core');
const { SkiaNodeBackend } = createRequire(path.resolve('packages/render-skia-node/package.json'))('./dist/index.js');
const { registry } = await loadPack({ directory: path.resolve('packages/fonts/pack') });
const shaper = await createHarfBuzzShaper(registry);
const backend = await SkiaNodeBackend.create({shaper});
const styles = loadSystemStyleMap();
const out = path.resolve('scratch/typography-motion-qa');
mkdirSync(out,{recursive:true});
const samples = [
  ['Stop','blaming','the','Algorithm'],
  ['Acha','font','viewer','ko','Comfortable','feel','karata','hai'],
  ['Keep','your','TEXT','readable'],
];
for(const [i,id] of ['editorial-keyword-zoom','editorial-stack','editorial-ghost-type'].entries()){
  const style=styles.get(id);
  const words=samples[i].map((t,j)=>({wid:`0:${j}`,t,s:j*300,e:(j+1)*300,...(t==='TEXT'?{emphasisPresetId:'keyword'}:{})}));
  for(const tMs of [350,1050,1700,2500,2875]){
    const layout=layoutSegment({style,segment:{id:'demo',startMs:0,endMs:3000},words,canvas:{width:720,height:1280},registry,shaper,tMs});
    const commands=animate({style,layout,tMs});
    if(tMs===2500) writeFileSync(path.join(out,`${id}.json`),JSON.stringify({style,layout,commands},null,2));
    writeFileSync(path.join(out,`${id}-${tMs}.png`),backend.renderToPng(commands,{width:720,height:1280,background:'#e5a381'}));
  }
}
console.log(out);
