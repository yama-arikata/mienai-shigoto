// 1本作る：決まった答えで聞き取り → 作る → 確かめる、までを、見えないChromeで自動で進める。
// サーバー（python3 studio/server.py）は別に起動しておく。APIキーはこのスクリプトでは扱わない。
//   node clay_test/run_one.mjs --port 8994 --answers clay_test/answers_tsugaru.json --label clay
// 終わると、プロジェクトのID・usage.json の場所・PCとスマホの絵（clay_test/out/<label>/）を出す。
// 依存なし（Node 22 の fetch と WebSocket だけ）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const PORT = +arg('port', 8994), LABEL = arg('label', 'run'), ANS = JSON.parse(fs.readFileSync(arg('answers', 'clay_test/answers_tsugaru.json'), 'utf8'));
const MAX_MIN = +arg('minutes', 25);
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const OUT = path.resolve(arg('out', `clay_test/out/${LABEL}`));
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// --- 見えない Chrome を自分で立てる（終わったら止める）---
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'clay-test-'));
const DBG = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DBG}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--mute-audio', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { try { chrome.kill(); } catch (e) {} try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {} };
process.on('exit', cleanup); process.on('SIGINT', () => process.exit(130));
let ver; for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${DBG}/json/version`)).json(); } catch (e) { await sleep(200); } }
if (!ver) { console.error('Chrome が立ち上がりませんでした'); process.exit(1); }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let mid = 0; const wait = new Map(); const events = [];
ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); } else events.push(m); });
const send = (method, params = {}, sessionId) => new Promise(r => { const i = ++mid; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
async function tab(w, h) {
  const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S('Runtime.enable'); await S('Page.enable');
  await S('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 760 });
  return { S, sessionId, targetId, close: () => send('Target.closeTarget', { targetId }) };
}
const ui = await tab(1440, 900);
await ui.S('Page.navigate', { url: BASE + '/' }); await sleep(1500);
// サーバーへの呼び出しは、同じ画面の中から fetch する（サーバーは同じ所からの呼び出しだけ受ける）
async function api(method, p, body) {
  const expr = `fetch(${JSON.stringify(p)},{method:${JSON.stringify(method)},headers:{'content-type':'application/json'}${body ? `,body:${JSON.stringify(JSON.stringify(body))}` : ''}}).then(async r=>({status:r.status,body:await r.text()}))`;
  const r = await ui.S('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const v = r.result?.result?.value; if (!v) throw new Error('呼び出しに失敗: ' + p);
  let b; try { b = JSON.parse(v.body); } catch (e) { b = v.body; }
  return { status: v.status, body: b };
}

const t0 = Date.now();
let r = await api('POST', '/api/start', ANS.intake);
if (r.status !== 200 || !r.body.id) { console.error('はじめられませんでした', r); process.exit(1); }
const pid = r.body.id; log('プロジェクト', pid, '（', LABEL, '）');
const used = {};
let generated = false, again = 0;
while (true) {
  if (Date.now() - t0 > MAX_MIN * 60000) { console.error(`${MAX_MIN}分を超えたので止めます`); process.exit(2); }
  const p = (await api('GET', `/api/project?id=${pid}`)).body;
  if (p.stage === 'interview') {
    if (p.ask_error) { if (again++ > 1) { console.error('質問が作れません:', p.ask_error); process.exit(2); } await api('POST', '/api/ask_again', { id: pid }); }
    else if (p.pending && !p.asking) {
      const ax = p.pending.axis, list = ANS.qa[ax] || [], k = used[ax] || 0;
      used[ax] = k + 1;
      if (k < list.length) { log('質問', `[${ax}]`, p.pending.q); await api('POST', '/api/answer', { id: pid, answer: list[k] }); }
      else { log('質問（仮の答えが無いので飛ばす）', `[${ax}]`, p.pending.q); await api('POST', '/api/answer', { id: pid, skip: true }); }
    }
    await sleep(1500); continue;
  }
  if (p.stage === 'review' && !generated) {
    r = await api('POST', '/api/generate', { id: pid }); log('作りはじめ', r.status);
    generated = true;
    // 確かめる手順は画面の中で動くので、このプロジェクトの画面を開いておく
    await ui.S('Page.navigate', { url: `${BASE}/?id=${pid}` });
    await sleep(2000); continue;
  }
  const j = p.job || {};
  if (j.stage === 'paused' || j.stage === 'failed' || p.stage === 'failed') { console.error('止まりました:', j.error || p.stage); break; }
  if (p.stage === 'ready' && j.stage === 'done') { log('できあがり', `周回=${j.round} 直し=${j.fixes} 残った問題=${(j.remaining || []).length}`); break; }
  await sleep(3000);
}

// --- できたページを、PCとスマホで場面ごとに撮る ---
fs.mkdirSync(OUT, { recursive: true });
const p = (await api('GET', `/api/project?id=${pid}`)).body;
const n = (p.chapters || []).length;
if (n && p.current) {
  for (const [w, h] of [[1920, 1080], [375, 812]]) {
    const t = await tab(w, h);
    for (let i = 0; i < n; i++) {
      const at = ((i + .6) / n).toFixed(3);
      await t.S('Page.navigate', { url: `${BASE}/p/${pid}?p=${at}` }); await sleep(5000);
      const s = await t.S('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${String(i + 1).padStart(2, '0')}_${p.chapters[i].id}_${w}.png`), Buffer.from(s.result.data, 'base64'));
    }
    await t.close();
  }
}
const errs = events.filter(e => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
  .map(e => e.method === 'Runtime.exceptionThrown' ? e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text : e.params.args.map(a => a.value ?? a.description).join(' '));
const summary = { label: LABEL, id: pid, port: PORT, seconds: Math.round((Date.now() - t0) / 1000), stage: p.stage, job_stage: p.job?.stage, chapters: n, console_errors: errs.slice(0, 20), shots: OUT };
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
log('まとめ', JSON.stringify(summary));
log('usage.json はサーバーのデータの中: studio/data/' + pid + '/usage.json（試験モードなら studio/_test/' + pid + '/）');
process.exit(0);
