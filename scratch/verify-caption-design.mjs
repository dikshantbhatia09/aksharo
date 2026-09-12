import { chromium, expect } from '../apps/web/node_modules/@playwright/test/index.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Input, BufferSource, ALL_FORMATS, Output, BufferTarget, WebMOutputFormat, Conversion } from '../apps/web/node_modules/mediabunny/dist/modules/src/index.js';

const origin = process.env.DESIGN_ORIGIN || 'http://localhost:3111';
const api = process.env.DESIGN_API_ORIGIN || 'http://localhost:3112';
const out = path.resolve(process.env.DESIGN_OUTPUT || 'scratch/caption-design-qa');
mkdirSync(out, { recursive: true });
const ref = path.resolve('scratch/caption-design-reference');
const preview = readFileSync(path.join(ref, 'assets/preview-video.png'));
const filmstrip = readFileSync(path.join(ref, 'assets/filmstrip.png'));
const projectId = '01JDESIGN000000000000000001';
const mediaId = '01JMEDIA000000000000000001';
const title = 'vidssave.com 4 Bedroom Villa For Sale in Lonavala 480P';
const lines = ['baarish ho rahi hai,', 'bheeg rahe hain', 'lekin aapko ye', 'badhiya sa chaar', 'bedroom five bathroom', 'ka', 'bungalow', 'aapko dikhate hain', 'Lonavala mein', 'ye khoobsurat ghar'];
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
  styles: { defaultStyleId: 'plain-white', inline: { doc: { typography: { sizePct: 32 / 1920 * 100, textTransform: 'lowercase' }, layout: { y: .65, safeAreaPct: 0 } } } },
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
  console.log('Loading editor; fixture bytes:', video.length);
  await page.goto(`${origin}/p/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('editor-root')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('segment-card-segment-1')).toBeVisible();
  console.log('Editor is visible');
  console.log(await page.getByTestId('caption-stage-video').evaluate(el => ({src:el.currentSrc, duration:el.duration})));
  await page.evaluate(() => document.fonts.ready);
  if (process.env.DESIGN_CSS_OVERRIDE) await page.addStyleTag({ content: readFileSync('apps/web/components/editor/editor.css', 'utf8') });
  await expect.poll(() => page.getByTestId('caption-stage-video').evaluate(video => video.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(out, 'implemented-1919.png') });
  const rects = await page.evaluate(() => Object.fromEntries(['.editor-top-bar', '.editor-transcript-panel', '.editor-timeline-panel', '.editor-player-column', '.editor-player-viewport', '.editor-inspector', '.editor-captions-header'].map(selector => { const element = document.querySelector(selector); const { x, y, width, height } = element.getBoundingClientRect(); return [selector, { x, y, width, height, background: getComputedStyle(element).backgroundColor, radius: getComputedStyle(element).borderRadius }]; })));
  writeFileSync(path.join(out, 'geometry.json'), JSON.stringify(rects, null, 2));
  console.log(await page.locator('.editor-transcript-panel').evaluate(el => {const ancestors=[]; while(el) {ancestors.push({tag:el.tagName,classes:el.className,slot:el.getAttribute('data-slot'),inline:el.getAttribute('style'),bg:getComputedStyle(el).backgroundColor,width:getComputedStyle(el).width}); el=el.parentElement;}return ancestors;}));
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(200);
    await expect(page.getByTestId('editor-export-open')).toBeInViewport();
    await expect(page.getByRole('button', {name:'Fit timeline',exact:true})).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: path.join(out, `implemented-${width}.png`) });
  }
  await page.setViewportSize({ width: 1919, height: 900 });
  await page.getByRole('button',{name:'Collapse inspector',exact:true}).click();
  await expect(page.getByRole('button',{name:'Expand inspector',exact:true})).toHaveAttribute('aria-expanded','false');
  await page.getByRole('button',{name:'Expand inspector',exact:true}).click();
  await expect(page.getByTestId('editor-export-open')).toBeInViewport();
  await page.getByTestId('player-play-pause').click();
  await expect(page.getByTestId('player-play-pause')).toHaveAttribute('aria-label', 'Pause');
  await page.getByTestId('player-play-pause').click();
  await page.getByRole('slider', {name:'Playback position',exact:true}).fill('1000');
  console.log('After scrub', await page.getByTestId('caption-stage-video').evaluate(el => ({time:el.currentTime, seekable:Array.from({length:el.seekable.length},(_,i)=>[el.seekable.start(i),el.seekable.end(i)]),duration:el.duration,paused:el.paused,seeking:el.seeking,slider:document.querySelector('[aria-label="Playback position"]').value})));
  await expect.poll(() => page.getByTestId('caption-stage-video').evaluate(el => el.currentTime)).toBeGreaterThan(.9);
  await page.getByRole('slider', {name:'Playback position',exact:true}).fill('0');
  await page.getByRole('textbox', { name: 'Word "baarish"', exact: true }).click();
  await page.getByRole('textbox', { name: 'Word "baarish"', exact: true }).press('Enter');
  await page.keyboard.press('Control+a'); await page.keyboard.insertText('barsaat'); await page.keyboard.press('Enter');
  await expect(page.getByTestId('word-chip-0:0')).toContainText('barsaat');
  await page.getByRole('spinbutton', { name: 'Font Size value', exact: true }).fill('48');
  await page.getByRole('spinbutton', { name: 'Font Size value', exact: true }).press('Enter');
  await expect(page.getByTestId('field-typography-sizePct')).toHaveValue('48');
  await page.getByRole('radio', { name: 'Right', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Right', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByLabel('Color hex', { exact: true }).fill('aabbcc'); await page.getByLabel('Color hex', { exact: true }).press('Enter');
  await expect(page.getByTestId('field-colors-text-solid')).toHaveValue('#aabbcc');
  await page.getByRole('radio', { name: 'Edit', exact: true }).click();
  await expect(page.getByTestId('field-layout-maxWidthPct')).toBeVisible();
  await page.getByRole('radio', { name: 'Captions', exact: true }).click();
  await page.getByTestId('segment-card-segment-1').getByRole('button',{name:'Caption style',exact:true}).click();
  await expect(page.getByTestId('style-picker')).toBeVisible();
  await page.getByTestId('right-panel-tab-look').click();
  await page.getByTestId('safe-zone-toggle').click();
  await expect(page.getByTestId('safe-zone-switch')).toBeVisible();
  await page.getByTestId('safe-zone-switch').click();
  await expect(page.getByTestId('safe-zone-switch')).toHaveAttribute('aria-checked','false');
  await page.keyboard.press('Escape');
  await page.getByTestId('timeline-granularity-line').click(); await expect(page.getByTestId('timeline-granularity-line')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('timeline-granularity-word').click();
  await page.getByRole('button', { name: 'Snap to word boundaries', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Snap to word boundaries', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Fit timeline', exact: true }).click();
  await page.getByTestId('captions-panel-tools-trigger').click();
  await expect(page.getByTestId('hide-fillers-toggle')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('timeline-root').getByRole('button',{name:'Word',exact:true}).last().click();
  await page.getByRole('textbox',{name:'New word',exact:true}).fill('testword');
  await page.getByRole('button',{name:'Add',exact:true}).click();
  await expect(page.getByTestId('segment-card-segment-1')).toContainText('testword');
  await page.getByTestId('editor-export-open').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.waitForTimeout(500);
  console.log(JSON.stringify({ rects, operations: ops.map(op => op.type), errors, requests: [...new Set(requests)] }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') });
  console.error(error);
  console.error(JSON.stringify({ errors, requests: [...new Set(requests)], operations: ops }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
