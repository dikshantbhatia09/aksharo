import { chromium, expect } from '../apps/web/node_modules/@playwright/test/index.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Input, BufferSource, ALL_FORMATS, Output, BufferTarget, WebMOutputFormat, Conversion } from '../apps/web/node_modules/mediabunny/dist/modules/src/index.js';

const origin = process.env.DESIGN_ORIGIN || 'http://localhost:3111';
const api = process.env.DESIGN_API_ORIGIN || 'http://localhost:3001';
const out = path.resolve(process.env.DESIGN_OUTPUT || 'scratch/regional-script-qa');
mkdirSync(out, { recursive: true });
const ref = path.resolve('scratch/caption-design-reference');
const preview = readFileSync(path.join(ref, 'assets/preview-video.png'));
const projectId = '01JDESIGN000000000000000003';
const mediaId = '01JMEDIA000000000000000003';
const title = 'Regional Script QA';
// Real native-script sample text, one line per language: Bengali, Gurmukhi (Punjabi), Telugu.
const lines = [
  { text: 'ਤੁਹਾਡੇ ਕੈਪਸ਼ਨ ਨੂੰ ਜੀਵੰਤ ਬਣਾਓ', style: 'punjabi-native' },
  { text: 'আপনার ক্যাপশন জীবন্ত করুন', style: 'bengali-native' },
  { text: 'మీ శీర్షికలను సజీవంగా చేయండి', style: 'telugu-native' },
];
const words = [];
const segments = [];
let time = 440;
for (const [i, line] of lines.entries()) {
  const startIndex = words.length;
  const startMs = time;
  for (const t of line.text.split(' ')) {
    words.push({ wid: `0:${words.length}`, t, s: time, e: time + 500, c: .99, scripts: { roman: t }, sp: 'speaker1' });
    time += 600;
  }
  segments.push({ id: `segment-${i + 1}`, seq: String.fromCharCode(65 + i), startWordId: `0:${startIndex}`, endWordId: `0:${words.length - 1}`, startMs, endMs: time - 60, styleRef: line.style });
  time += 200;
}
const durationMs = time + 500;
const hot = {
  meta: { edgId: 'design-edg', projectId, revision: 1, schemaVersion: 2 },
  media: [{ mediaId, role: 'primary', durationMs }],
  transcript: { transcriptId: 'design-transcript', revision: 1, language: 'hi', scripts: ['roman'] },
  canvas: { aspect: '9:16', width: 1080, height: 1920 },
  styles: { defaultStyleId: 'plain-white', inline: { doc: {} } },
};
const project = { id: projectId, workspaceId: 'design-workspace', title, sourceLanguage: 'hi', status: 'ready', durationMs, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), media: [{ mediaId, role: 'primary', status: 'ready' }] };
const token = `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'design-user', ws: 'design-workspace', role: 'owner', kind: 'web', jti: 'design-session', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1919, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin === origin && route.request().method() === 'GET') return route.continue();
  return route.abort();
});
await context.routeWebSocket('**/*', socket => socket.close());
await context.addCookies([{ name: 'aksharo_rt', value: 'local-design-fixture', url: origin }]);
await context.route('**/api/session/refresh', route => route.fulfill({ json: { accessToken: token, expiresIn: 3600, workspaceId: 'design-workspace', role: 'owner' } }));
await context.route(`${origin}/design-preview.png`, route => route.fulfill({ contentType: 'image/png', body: preview }));
await context.route(`${api}/**`, async route => {
  const url = new URL(route.request().url());
  const p = url.pathname;
  let body;
  if (p === `/projects/${projectId}/edg`) body = { hot, segments, passes: [], revision: 1, schemaVersion: 2, nextCursor: null, updatedAt: new Date().toISOString() };
  else if (p.endsWith('/edg/ops')) body = { revision: 2, applied: [], rebased: [], rejected: [] };
  else if (p === `/projects/${projectId}/transcript`) body = { transcript: { id: 'design-transcript', projectId, revision: 1, language: 'hi', chunkCount: 1, durationMs }, chunks: [{ chunkIdx: 0, startMs: 0, endMs: durationMs, words }], nextCursor: null };
  else if (p.endsWith('/transcript/scripts')) body = { scripts: [{ script: 'roman', available: true, source: 'transcription' }] };
  else if (p === `/projects/${projectId}`) body = project;
  else if (p === '/projects') body = { items: [project], nextCursor: null };
  else if (p.endsWith('/urls')) body = { mediaId, proxy: `${origin}/design-video.webm`, thumbs: Array(10).fill(`${origin}/design-preview.png`), waveform: `${api}/design-waveform`, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  else if (p === '/design-waveform') body = { peakRate: 100, peaks: Array.from({ length: 800 }, (_, i) => .12 + Math.abs(Math.sin(i / 11)) * .8), rms: { rate: 10, values: Array(80).fill(.25) }, durationMs };
  else if (p === '/me') body = { id: 'design-user', name: 'QA', email: 'design@example.test', locale: 'en-IN', onboarding: { coachMarksShownAt: new Date().toISOString() } };
  else if (p.endsWith('/fonts') || p.endsWith('/brand-assets')) body = [];
  else if (p.includes('entitlement')) body = { planKey: 'free', status: 'active', limits: {}, features: {}, workspaceId: 'design-workspace' };
  else if (p === '/workspaces') body = { items: [{ id: 'design-workspace', name: 'Design QA', role: 'owner' }] };
  else if (p.includes('referrals')) body = { referralCode: null, promptEligible: false, shouldPrompt: false };
  else body = { items: [], nextCursor: null };
  await route.fulfill({ json: body, headers: { 'access-control-allow-origin': origin, 'access-control-allow-headers': '*' } });
});

try {
  console.log('Creating local media fixture');
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
    await new Promise(resolve => setTimeout(resolve, 2200)); recorder.stop(); clearInterval(timer); stream.getTracks().forEach(track => track.stop());
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
    const end = range?.[2] ? Math.min(Number(range[2]), seekableVideo.length - 1) : seekableVideo.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'video/webm', body: seekableVideo.subarray(start, end + 1), headers: { 'accept-ranges': 'bytes', 'content-length': String(end - start + 1), ...(range ? { 'content-range': `bytes ${start}-${end}/${seekableVideo.length}` } : {}) } });
  });

  await page.goto(`${origin}/p/${projectId}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('editor-root')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('caption-stage')).toHaveAttribute('data-state', 'ready', { timeout: 30000 });

  for (const seg of segments) {
    const midpoint = Math.round((seg.startMs + seg.endMs) / 2);
    await page.getByRole('slider', { name: 'Playback position', exact: true }).fill(String(midpoint));
    await page.waitForTimeout(300);
    await page.getByTestId('caption-stage').screenshot({ path: path.join(out, `${seg.styleRef}.png`) });
    console.log(`captured ${seg.styleRef} at ${midpoint}ms`);
  }
  console.log(JSON.stringify({ passed: true, errors }, null, 2));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') });
  console.error(error);
  console.error(JSON.stringify({ errors }, null, 2));
  process.exitCode = 1;
} finally {
  await browser.close();
}
