import { chromium, expect } from '../apps/web/node_modules/@playwright/test/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Input, BufferSource, ALL_FORMATS, Output, BufferTarget, WebMOutputFormat, Conversion } from '../apps/web/node_modules/mediabunny/dist/modules/src/index.js';

const origin = process.env.DESIGN_ORIGIN || 'http://localhost:3111';
const api = process.env.DESIGN_API_ORIGIN || 'http://localhost:3112';
const out = path.resolve(process.env.DESIGN_OUTPUT || 'scratch/typography-browser-qa');
mkdirSync(out, { recursive: true });
const ref = path.resolve('scratch/caption-design-reference');
const preview = readFileSync(path.join(ref, 'assets/preview-video.png'));
const filmstrip = readFileSync(path.join(ref, 'assets/filmstrip.png'));
const projectId = '01JDESIGN000000000000000001';
const mediaId = '01JMEDIA000000000000000001';
const title = 'Typography Motion';
const lines = ['Make your captions feel alive', 'bheeg rahe hain', 'lekin aapko ye', 'badhiya sa chaar', 'bedroom five bathroom', 'ka', 'bungalow', 'aapko dikhate hain', 'Lonavala mein', 'ye khoobsurat ghar'];
const emphasized = new Set(['baarish', 'bheeg', 'chaar', 'bedroom', 'five', 'bathroom', 'bungalow']);
const words = [];
const segments = [];
let time = 440;
for (const [i, line] of lines.entries()) {
  const startIndex = words.length;
  const startMs = time;
  for (const t of line.split(' ')) {
    words.push({ wid: `0:${words.length}`, t, s: time, e: time + 240, c: .99, scripts: { roman: t }, isEmphasized: emphasized.has(t), sp: 'speaker1' });
    time += 300;
  }
  segments.push({ id: `segment-${i + 1}`, seq: String.fromCharCode(65 + i), startWordId: `0:${startIndex}`, endWordId: `0:${words.length - 1}`, startMs, endMs: time - 60 });
  time += 100;
}
const durationMs = 20060;
const hot = {
  meta: { edgId: 'design-edg', projectId, revision: 1, schemaVersion: 2 },
  media: [{ mediaId, role: 'primary', durationMs }],
  transcript: { transcriptId: 'design-transcript', revision: 1, language: 'hi', scripts: ['roman'] },
  canvas: { aspect: '9:16', width: 1080, height: 1920 },
  styles: { defaultStyleId: 'editorial-keyword-zoom', inline: { doc: {} } },
};
const project = { id: projectId, workspaceId: 'design-workspace', title, sourceLanguage: 'hi', status: 'ready', durationMs, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), media: [{ mediaId, role: 'primary', status: 'ready' }] };
const token = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'design-user', ws: 'design-workspace', role: 'owner', kind: 'web', jti: 'design-session', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1919, height: 900 } });
const page = await context.newPage();
const errors = [];
const ops = [];
const requests = [];
page.on('pageerror', error => errors.push(error.message));
// Only document/static reads may reach the web host. All project/auth/API
// traffic is intercepted below, including when verifying the public bundle.
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin === origin && route.request().method() === 'GET') return route.continue();
  return route.abort();
});
await context.routeWebSocket('**/*', socket => socket.close());
await context.addCookies([{ name: 'aksharo_rt', value: 'local-design-fixture', url: origin }]);
await context.route('**/api/session/refresh', route => route.fulfill({ json: { accessToken: token, expiresIn: 3600, workspaceId: 'design-workspace', role: 'owner' } }));
await context.route(`${origin}/design-preview.png`, route => route.fulfill({ contentType: 'image/png', body: preview }));
await context.route(`${origin}/design-filmstrip.png`, route => route.fulfill({ contentType: 'image/png', body: filmstrip }));
await context.route(`${api}/**`, async route => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  requests.push(p);
  let body;
  if (p === `/projects/${projectId}/edg`) body = { hot, segments, passes: [], revision: 1, schemaVersion: 2, nextCursor: null, updatedAt: new Date().toISOString() };
  else if (p.endsWith('/edg/ops')) {
    const request = route.request().postDataJSON();
    ops.push(...request.ops);
    body = { revision: 1 + ops.length, applied: request.ops.map(op => op.opId), rebased: [], rejected: [] };
  }
  else if (p === `/projects/${projectId}/transcript`) body = { transcript: { id: 'design-transcript', projectId, revision: 1, language: 'hi', chunkCount: 1, durationMs }, chunks: [{ chunkIdx: 0, startMs: 0, endMs: durationMs, words }], nextCursor: null };
  else if (p.endsWith('/transcript/scripts')) body = { scripts: [{ script: 'roman', available: true, source: 'transcription' }] };
  else if (p === `/projects/${projectId}`) body = project;
  else if (p === '/projects') body = { items: [project], nextCursor: null };
  else if (p.endsWith('/urls')) body = { mediaId, proxy: `${origin}/design-video.webm`, thumbs: Array(30).fill(`${origin}/design-preview.png`), waveform: `${api}/design-waveform`, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  else if (p === '/design-waveform') body = { peakRate: 100, peaks: Array.from({ length: 2100 }, (_, i) => .12 + Math.abs(Math.sin(i / 11) * Math.cos(i / 7)) * .8), rms: { rate: 10, values: Array(210).fill(.25) }, durationMs };
  else if (p === '/me') body = { id: 'design-user', name: 'Dikshant Bhatia', email: 'design@example.test', locale: 'en-IN', onboarding: { coachMarksShownAt: new Date().toISOString() } };
  else if (p.endsWith('/fonts') || p.endsWith('/brand-assets')) body = [];
  else if (p.includes('entitlement')) body = { planKey: 'free', status: 'active', limits: {}, features: {}, workspaceId: 'design-workspace' };
  else if (p === '/workspaces') body = { items: [{ id: 'design-workspace', name: 'Design QA', role: 'owner' }] };
  else if (p.includes('referrals')) body = { referralCode: null, promptEligible: false, shouldPrompt: false };
  else body = { items: [], nextCursor: null };
  await route.fulfill({ json: body, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*' } });
});

try {
  console.log('Creating local media fixture');
  // A real local media fixture made from the supplied still. No live service
  // receives test traffic; all API requests above are intercepted.
  await page.goto('about:blank');
  const video = await page.evaluate(async data => {
    const img = new Image(); img.src = data; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = 540; canvas.height = 960;
    canvas.getContext('2d').drawImage(img, 0, 0, 540, 960);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const chunks = [];
    const finished = new Promise(resolve => { recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); });
    recorder.ondataavailable = event => chunks.push(event.data);
    recorder.start();
    const timer = setInterval(() => canvas.getContext('2d').drawImage(img, 0, 0, 540, 960), 100);
    await new Promise(resolve => setTimeout(resolve, 2000)); recorder.stop(); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
    return finished;
  }, `data:image/png;base64,${preview.toString('base64')}`);
  const mediaInput = new Input({ source: new BufferSource(Uint8Array.from(video)), formats: ALL_FORMATS });
  const mediaTarget = new BufferTarget();
  const mediaOutput = new Output({ target: mediaTarget, format: new WebMOutputFormat() });
  const conversion = await Conversion.init({ input: mediaInput, output: mediaOutput });
  await conversion.execute();
  const seekableVideo = Buffer.from(mediaTarget.buffer);
  mediaInput.dispose();
  await context.route(`${origin}/design-video.webm`, route => {
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]),seekableVideo.length-1) : seekableVideo.length-1;
    return route.fulfill({status:range?206:200, contentType:'video/webm',body:seekableVideo.subarray(start,end+1),headers:{'accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${seekableVideo.length}`}:{})}});
  });

  await page.goto(`${origin}/p/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('editor-root')).toBeVisible({timeout:30000});
  await expect(page.getByTestId('caption-stage')).toHaveAttribute('data-state','ready',{timeout:30000});
  // `caption-stage-overlay` is a MakeWebGLCanvasSurface (CanvasKit) canvas.
  // Reading it via `canvas.toDataURL()` in-page is unreliable: without
  // `preserveDrawingBuffer`, the browser is free to clear the WebGL drawing
  // buffer once it has composited a frame, so a later `page.evaluate` often
  // reads back a blank/stale buffer rather than what was last painted.
  // Playwright's own `.screenshot()` captures the actually-composited pixels
  // (the same path used for the `${id}.png` files, which do show three
  // distinct layouts), so use that for comparisons instead of the canvas API.
  const shot = async () => (await page.getByTestId('caption-stage-overlay').screenshot()).toString('base64');
  await page.getByRole('slider',{name:'Playback position',exact:true}).fill('1800');
  await page.getByTestId('right-panel-tab-style').click();
  await page.getByTestId('style-picker-search').fill('typography');
  const snapshots=[];
  for(const id of ['editorial-keyword-zoom','editorial-stack','editorial-ghost-type']){
    await expect(page.getByTestId(`style-picker-tile-${id}`)).toBeVisible();
    await expect(page.getByTestId(`style-preview-${id}`)).toHaveAttribute('data-state','ready');
    await page.getByTestId(`style-picker-tile-${id}`).click();
    await expect(page.getByTestId(`style-picker-tile-${id}`)).toHaveAttribute('aria-pressed','true');
    await page.waitForTimeout(450);
    await page.getByTestId('caption-stage').screenshot({path:path.join(out,`${id}.png`)});
    snapshots.push(await shot());
  }
  expect(new Set(snapshots).size).toBe(3);
  await page.getByTestId('right-panel-tab-anim').click();
  await expect(page.getByLabel('Typography motion',{exact:true})).toHaveValue('echo');
  await page.getByLabel('Typography motion',{exact:true}).selectOption('stack');
  await expect(page.getByLabel('Typography motion',{exact:true})).toHaveValue('stack');
  await page.screenshot({path:path.join(out,'editor-typography-controls.png')});
  await page.getByLabel('Typography motion',{exact:true}).selectOption('focus');
  await page.getByRole('slider',{name:'Playback position',exact:true}).fill('1100');
  await page.waitForTimeout(250);
  const before = await shot();
  await page.getByRole('slider',{name:'Playback position',exact:true}).fill('1800');
  await page.waitForTimeout(250);
  const after = await shot();
  expect(after).not.toBe(before);
  await page.getByRole('slider',{name:'Playback position',exact:true}).fill('1100');
  await page.waitForTimeout(250);
  expect(await shot()).toBe(before);
  expect(ops.some(op=>op.styleRef==='editorial-stack')).toBe(true);
  expect(errors.filter(e=>!e.includes('WebSocket'))).toEqual([]);
  const report={passed:true,presets:3,distinctFrames:true,deterministicSeek:true,operations:ops.map(op=>({type:op.type,styleRef:op.styleRef,overrides:op.overrides})),errors};
  writeFileSync(path.join(out,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}catch(error){
  await page.screenshot({path:path.join(out,'failure.png')});
  console.error(error);console.error(JSON.stringify({errors,requests:[...new Set(requests)],ops},null,2));process.exitCode=1;
}finally{await browser.close();}

