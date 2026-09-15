import { chromium } from 'file:///C:/Users/diksh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const source = 'C:/Users/diksh/Downloads/downloaded-file (3).mp4';
const out = path.resolve('scratch/typography-motion-reference');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1080}});
try {
  await page.setContent('<video muted preload="auto"></video>');
  const meta = await page.evaluate(async src => {
    const v=document.querySelector('video');v.src=src;
    await new Promise((resolve,reject)=>{v.onloadeddata=resolve;v.onerror=()=>reject(new Error('Cannot decode reference video'));});
    return {duration:v.duration,width:v.videoWidth,height:v.videoHeight};
  },`data:video/mp4;base64,${readFileSync(source).toString('base64')}`);
  console.log(JSON.stringify(meta));
  writeFileSync(path.join(out,'metadata.json'),JSON.stringify(meta,null,2));
  const count=48;
  const frames=[];
  for(let i=0;i<count;i++){
    const time=Math.min(meta.duration-.05,(i+.25)*meta.duration/count);
    const data=await page.evaluate(async time=>{
      const v=document.querySelector('video');
      await new Promise(resolve=>{v.onseeked=resolve;v.currentTime=time;});
      const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
      c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png');
    },time);
    const file=`frame-${String(i).padStart(3,'0')}.png`;
    writeFileSync(path.join(out,file),Buffer.from(data.split(',')[1],'base64'));
    frames.push({time,file,data});
  }
  writeFileSync(path.join(out,'frames.json'),JSON.stringify(frames.map(({data,...rest})=>rest),null,2));
  for(let i=0;i<3;i++){
    await page.setContent(`<style>body{margin:0;padding:12px;background:#202024;color:white;font:14px system-ui}main{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}figure{margin:0}img{width:100%;display:block}figcaption{padding:4px}</style><main>${frames.slice(i*16,i*16+16).map(f=>`<figure><img src="${f.data}"><figcaption>${f.file} · ${f.time.toFixed(2)}s</figcaption></figure>`).join('')}</main>`);
    await page.screenshot({path:path.join(out,`overview-${i+1}.png`),fullPage:true});
  }
}finally{await browser.close();}

