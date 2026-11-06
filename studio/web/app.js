'use strict';
// 文字はすべて textContent で入れる（職人の言葉も Claude の言葉も、タグとして動かさない）
const $ = s => document.querySelector(s);
const view = $('#view');
const off = $('#off');
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
function put(el, ...kids) {  // null や false は入れない
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c);
}
async function get(path) {
  const r = await fetch(path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'http'), { status: r.status, body: d });
  return d;
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'http'), { status: r.status, body: d });
  return d;
}
// 審査員モードだけが返す 401・429。ボタンから投げた分もここで見せる
addEventListener('unhandledrejection', e => {
  const r = e.reason;
  if (r && r.status === 401) location.href = '/';
  else if (r && r.status === 429) toast(r.body.message);
});
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.tm);
  toast.tm = setTimeout(() => { t.hidden = true; }, 3200);
}
function snap(pct) {
  const s = $('#sumi'), i = s.firstElementChild;
  if (i.style.width === pct + '%') return;
  i.style.width = pct + '%';
  s.classList.remove('snap');
  void s.offsetWidth;
  s.classList.add('snap');
}
const min = sec => {
  sec = Math.max(0, Math.round(sec));
  return sec < 60 ? `${sec}秒` : `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
};
const ms = v => (v === null || v === undefined) ? '' : min(v / 1000);
const shotUrl = (name, stamp) => `/api/shot?id=${encodeURIComponent(P.id)}&name=${encodeURIComponent(name)}${stamp ? '&s=' + stamp : ''}`;
function zoomImg(src) {
  const z = h('div', { id: 'zoom', onclick: () => z.remove() }, h('img', { src, alt: '確かめた画面' }));
  document.body.append(z);
}

let STATE = null, P = null, screen = '', timer = null, serverLost = false;
const drafts = { job: '', work: '', looks: '' };

// ---------- 声で入れる（kabi と同じ）----------
function voiceFor(ta, onChange) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const note = h('div', { class: 'notice' }, '声で入れると、Chromeでは音声がGoogleへ送られます。');
  if (!SR) return { button: null, note: h('div', { class: 'notice' }, 'このブラウザでは声で入れられません。文字で書いてください。'), stop() {} };
  let rc = null, head = '';
  const btn = h('button', { type: 'button', class: 'thin' }, '声で答える');
  const stop = () => { if (rc) { try { rc.stop(); } catch (e) {} } rc = null; btn.textContent = '声で答える'; btn.classList.remove('rec-on'); };
  btn.addEventListener('click', () => {
    if (rc) return stop();
    head = ta.value ? ta.value + ' ' : '';
    rc = new SR();
    rc.lang = 'ja-JP'; rc.interimResults = true; rc.continuous = true;
    rc.onresult = e => { let s = ''; for (const a of e.results) s += a[0].transcript; ta.value = (head + s).slice(0, 800); ta.dispatchEvent(new Event('input', { bubbles: true })); };
    rc.onerror = e => { toast(e.error === 'not-allowed' ? 'マイクが使えません。文字で書いてください。' : '声を聞き取れませんでした。'); stop(); };
    rc.onend = () => { if (rc) stop(); };
    try { rc.start(); btn.textContent = '聞いています（押すと止まる）'; btn.classList.add('rec-on'); } catch (e) { stop(); }
  });
  return { button: btn, note, stop };
}
function stopBox(res) {
  return h('div', { class: 'stop', role: 'alert' },
    h('strong', {}, 'この言葉はページに書けません。'),
    (res.hits || []).map(x => h('div', {}, `「${x.word}」: ${x.reason}`)),
    h('div', {}, '別の言い方にするか、消してください。この答えはClaudeに送っていません。'));
}
function errBox(text) { return h('div', { class: 'stop', role: 'alert' }, text); }

// ---------- 画面の切り替え ----------
function setScreen(key, build, wide) {
  if (screen === key) return false;
  screen = key;
  view.className = wide ? 'wide' : '';
  view.replaceChildren();
  build();
  scrollTo(0, 0);
  return true;
}
function route() {
  if (!P) return;
  if (P.stage === 'interview') {
    if (P.pending && !P.asking) { setScreen(`q${P.qa.length}`, screenQuestion); snap(18 + 34 * Math.min(1, P.qa.length / 4)); return; }
    setScreen(`wait${P.qa.length}${P.ask_error ? 'e' : ''}`, screenAsking); return;
  }
  if (P.stage === 'review') { setScreen('review', screenReview); snap(55); return; }
  if (P.stage === 'building' || P.stage === 'failed') {
    if (P.stage === 'failed' && !P.job) { setScreen('review', screenReview); return; }
    setScreen('progress', screenProgress); updateProgress(); return;
  }
  if (P.stage === 'ready') { setScreen('result', screenResult, true); snap(100); updateResult(); }
}
let workLost = false; // 審査員モードで、再起動のあと作りかけが見つからなかった
async function load(id) {
  try {
    P = await get('/api/project?id=' + encodeURIComponent(id));
    if (serverLost) { serverLost = false; }
    route();
  } catch (e) {
    if (e.status === 404) { workLost = !!STATE.judge; history.replaceState(null, '', '/'); P = null; screen = ''; showHome(); return; }
    if (!serverLost) { serverLost = true; toast('サーバーにつながりません。起動しているか確かめてください。'); }
  }
  clearTimeout(timer);
  if (P) timer = setTimeout(() => load(P.id), 1000);
}
function openProject(id) {
  history.pushState(null, '', '/?id=' + id);
  load(id);
}


// ---------- 土壁の断面（CSSの3Dと手描きの質感。外から読み込まない）----------
// 層の順と言葉は sakan/SOURCES.md で確かめた見本に合わせる。これは左官の例で、道具が作った物ではない
const WALL_W = 250, WALL_H = 320;
const WALL_LAYERS = [ // 奥から手前へ
  { key: 'take', thick: 14, z: 0, gap: 0, side: '#8f7c3f', top: '#b5a35f', label: '竹を組んで、縄でしばる' },
  { key: 'ara', thick: 30, z: 10, gap: 62, side: '#553d27', top: '#8d6c4b', label: '荒壁の土。竹にすりこむ' },
  { key: 'naka', thick: 18, z: 40, gap: 124, side: '#8c7049', top: '#c7a97f', label: '中塗りの土で平らに' },
  { key: 'shikkui', thick: 5, z: 58, gap: 186, side: '#b5b2a6', top: '#f6f4ee', label: '見えるのは、ここだけ' },
];
function wallRandom(seed) { let x = seed; return () => (x = (x * 16807) % 2147483647) / 2147483647; }
function wallCanvas(paint) {
  const c = document.createElement('canvas');
  c.width = WALL_W * 2; c.height = WALL_H * 2;
  const g = c.getContext('2d');
  g.scale(2, 2);
  paint(g);
  return c;
}
function speckle(g, rnd, n, colors, size) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[Math.floor(rnd() * colors.length)];
    const r = size * (.4 + rnd());
    g.fillRect(rnd() * WALL_W, rnd() * WALL_H, r, r);
  }
}
function paintPole(g, x, y, len, w, vertical) {
  const grad = vertical ? g.createLinearGradient(x, 0, x + w, 0) : g.createLinearGradient(0, y, 0, y + w);
  grad.addColorStop(0, '#8f7c3f'); grad.addColorStop(.35, '#dcc97f'); grad.addColorStop(1, '#7c6a34');
  g.fillStyle = grad;
  if (vertical) g.fillRect(x, y, w, len); else g.fillRect(x, y, len, w);
  g.fillStyle = 'rgba(60,46,18,.65)';
  for (let d = 34; d < len; d += 92) { if (vertical) g.fillRect(x, y + d, w, 2); else g.fillRect(x + d, y, 2, w); }
}
const WALL_PAINT = {
  shikkui(g) {
    g.fillStyle = '#eceae3'; g.fillRect(0, 0, WALL_W, WALL_H);
    const rnd = wallRandom(11);
    g.lineCap = 'round';
    for (let i = 0; i < 90; i++) { // こての跡
      g.strokeStyle = `rgba(92,86,70,${.015 + rnd() * .035})`;
      g.lineWidth = 8 + rnd() * 22;
      const x = rnd() * WALL_W, y = rnd() * WALL_H;
      g.beginPath(); g.moveTo(x - 50, y + 8); g.quadraticCurveTo(x, y - 12, x + 50, y + 6); g.stroke();
    }
    speckle(g, rnd, 500, ['rgba(120,112,92,.10)', 'rgba(255,255,255,.35)'], 1.2);
  },
  naka(g) {
    g.fillStyle = '#b7986e'; g.fillRect(0, 0, WALL_W, WALL_H);
    speckle(g, wallRandom(23), 5200, ['rgba(92,68,38,.30)', 'rgba(232,212,170,.30)', 'rgba(60,44,24,.18)'], 1.3);
  },
  ara(g) {
    g.fillStyle = '#7d5e40'; g.fillRect(0, 0, WALL_W, WALL_H);
    const rnd = wallRandom(37);
    speckle(g, rnd, 6200, ['rgba(40,26,14,.36)', 'rgba(170,132,92,.26)'], 1.9);
    g.lineCap = 'round';
    for (let i = 0; i < 230; i++) { // わら
      g.strokeStyle = `rgba(228,202,132,${.35 + rnd() * .4})`;
      g.lineWidth = .7 + rnd() * .8;
      const x = rnd() * WALL_W, y = rnd() * WALL_H, a = rnd() * Math.PI * 2, l = 7 + rnd() * 17;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
  },
  takeV(g) { for (let x = 16; x < WALL_W - 8; x += 36) paintPole(g, x, 0, WALL_H, 9, true); },
  takeH(g) {
    const rnd = wallRandom(51);
    for (let y = 16; y < WALL_H - 8; y += 36) paintPole(g, 0, y, WALL_W, 8, false);
    g.strokeStyle = '#e4d4ae'; g.lineWidth = 1.3;
    for (let y = 16; y < WALL_H - 8; y += 36) for (let x = 16; x < WALL_W - 8; x += 36) { // 縄
      if (rnd() < .16) continue;
      g.beginPath(); g.moveTo(x - 1, y - 2); g.lineTo(x + 10, y + 10); g.moveTo(x + 10, y - 2); g.lineTo(x - 1, y + 10); g.stroke();
    }
  },
};
function makeWall(host, { labels = false } = {}) {
  const scene = h('div', { class: 'wallScene' });
  const stage = h('div', { class: 'wallStage', 'aria-hidden': 'true' }, scene);
  host.append(stage);
  const layers = WALL_LAYERS.map(l => {
    const slab = h('div', { class: 'wallSlab' });
    const face = (cls, css) => { const f = h('div', { class: cls }); f.style.cssText = css; slab.append(f); return f; };
    if (l.key === 'take') {
      for (const [k, z] of [['takeV', 0], ['takeH', 9]]) {
        const c = wallCanvas(WALL_PAINT[k]);
        c.className = 'wallFace';
        c.style.transform = `translateZ(${z}px)`;
        slab.append(c);
      }
    } else {
      const c = wallCanvas(WALL_PAINT[l.key]);
      c.className = 'wallFace';
      c.style.transform = `translateZ(${l.thick}px)`;
      slab.append(c);
      face('wallFace', `width:${l.thick}px;height:${WALL_H}px;background:${l.side};transform-origin:0 0;transform:rotateY(-90deg)`);
      face('wallFace', `width:${WALL_W}px;height:${l.thick}px;background:${l.top};transform-origin:0 0;transform:rotateX(90deg)`);
    }
    const dot = h('i', { class: 'wallDot' });
    slab.append(dot);
    scene.append(slab);
    const tag = labels ? h('div', { class: 'wallLabel ' + l.key }, l.label) : null;
    if (tag) stage.append(tag);
    return { ...l, slab, dot, tag };
  });
  let t = 0, shown = layers.length;
  function place() {
    for (const [i, l] of layers.entries()) {
      const off = i >= shown ? 70 : 0;
      l.slab.style.transform = `translateZ(${l.z + l.gap * t + off - 110}px)`;
      l.slab.classList.toggle('off', i >= shown);
    }
  }
  function relabel() {
    if (!labels) return;
    const b = stage.getBoundingClientRect();
    for (const [i, l] of layers.entries()) {
      const r = l.dot.getBoundingClientRect();
      const rowY = 6 + i * 24; // 奥の層ほど上の段に置いて、名前どうしを重ねない
      l.tag.style.transform = `translate(${Math.round(r.left - b.left)}px,${rowY}px)`;
      l.tag.style.height = `${Math.max(20, Math.round(r.top - b.top - rowY))}px`;
      const front = i === layers.length - 1;
      l.tag.style.opacity = front ? 1 : Math.max(0, Math.min(1, (t - .3 - (2 - i) * .14) / .16));
    }
  }
  function fit() {
    const w = stage.clientWidth, hh = stage.clientHeight;
    if (!w || !hh) return;
    const need = labels ? [470, 560] : [400, 440];
    scene.style.setProperty('--wall-scale', Math.min(w / need[0], hh / need[1], labels ? 1.5 : 1).toFixed(3));
    relabel();
  }
  if (window.ResizeObserver) new ResizeObserver(fit).observe(stage);
  place(); fit();
  return {
    stage,
    set(v) { t = v; place(); relabel(); },
    build(n) { if (n === shown) return; shown = n; place(); },
    get t() { return t; },
    fit,
  };
}
// はじめの画面だけ、白い壁が一度だけ開く。つまみで戻せる
function peelHero(host) {
  const wall = makeWall(host, { labels: true });
  const range = h('input', { type: 'range', min: 0, max: 100, value: 0, class: 'peel', 'aria-label': '壁をはがす量' });
  const hint = h('div', { class: 'peelRow' }, h('label', {}, 'つまみを動かすと、壁がはがれます'), range,
    h('div', { class: 'peelNote' }, '絵は左官の土壁の例です。'));
  host.append(hint);
  let stop = false;
  range.addEventListener('input', () => { stop = true; wall.set(range.value / 100); });
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) { wall.set(1); range.value = 100; return; }
  const t0 = performance.now() + 900, dur = 2400;
  const step = now => {
    if (stop || !wall.stage.isConnected) return;
    const x = Math.max(0, Math.min(1, (now - t0) / dur));
    const e = x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    wall.set(e); range.value = Math.round(e * 100);
    if (x < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- はじめ ----------
async function showHome() {
  snap(0);
  clearTimeout(timer);
  P = null;
  let list = [];
  try { list = (await get('/api/list')).projects; } catch (e) {}
  screen = '';
  setScreen('home', () => {
    const blocked = !STATE.test && !STATE.key;
    view.className = 'home';
    const art = h('div', { class: 'heroArt' });
    const lost = workLost && errBox('サーバーが再起動して、作りかけが消えました。すみません、もう一度はじめてください。');
    workLost = false;
    put(view, lost, h('div', { class: 'hero' }, art, h('div', { class: 'heroText' },
      h('h1', {}, 'お客さんが見るのは、', h('br', {}), 'いちばん上の一枚だけ。'),
      h('p', { class: 'lead' }, 'その奥でしている仕事を、話すだけで3Dのページにします。口で説明していた手間を、お客さんに見せられます。'),
      blocked && errBox(STATE.no_key_message),
      h('div', { class: 'row' }, h('button', { class: 'main', disabled: blocked, onclick: () => showIntake(0) }, 'はじめる')),
      h('p', { class: 'mute heroNote' }, 'いくつか質問に答えるだけです。文字でも声でも答えられます。言っていないことは書きません。分からない所は「ここは職人に確認」と出します。'))),
      list.length ? h('div', {}, h('h2', { style: 'margin-top:44px' }, '前に作ったもの'),
        h('ul', { class: 'list' }, list.map(x => h('li', {}, h('a', { href: '/?id=' + x.id, onclick: e => { e.preventDefault(); openProject(x.id); } },
          h('span', {}, x.title || '（名前なし）', ' ', h('span', { class: 'mute small' }, x.job)),
          h('span', { class: 'mute small' }, stageWord(x.stage))))))) : null);
    peelHero(art);
  });
}
const stageWord = s => ({ interview: '質問の途中', review: '答えを確かめる所', building: '作っている途中', ready: 'できたページあり', failed: '止まっている' }[s] || s);

// ---------- ① さいしょの質問 ----------
function showIntake(i) {
  screen = '';
  setScreen('intake' + i, () => {
    const item = STATE.intake[i];
    const ta = h('textarea', { placeholder: item.ph, 'aria-label': item.q, rows: 3, value: drafts[item.key] || '' });
    const msg = h('div', {});
    const next = h('button', { class: 'main', disabled: !(drafts[item.key] || '').trim() }, i < STATE.intake.length - 1 ? '次へ' : '質問へ進む');
    ta.addEventListener('input', () => { drafts[item.key] = ta.value; next.disabled = !ta.value.trim(); });
    const voice = voiceFor(ta);
    next.addEventListener('click', async () => {
      next.disabled = true;
      msg.replaceChildren();
      voice.stop();
      const words = await post('/api/words', { text: ta.value });
      if (words.stopped) { put(msg, stopBox(words)); next.disabled = false; return; }
      if (i < STATE.intake.length - 1) return showIntake(i + 1);
      try {
        const res = await post('/api/start', drafts);
        if (res.stopped) { put(msg, stopBox(res)); next.disabled = false; return; }
        drafts.job = drafts.work = drafts.looks = '';
        screen = '';
        openProject(res.id);
      } catch (e) {
        put(msg, errBox(e.body && e.body.message || 'はじめられませんでした。'));
        next.disabled = false;
      }
    });
    put(view, 
      h('div', { class: 'kicker' }, `はじめの質問 ${i + 1} / ${STATE.intake.length}`),
      h('h1', {}, item.q), ta, msg,
      STATE.test && h('div', { class: 'row' }, h('button', { class: 'thin', onclick: () => { ta.value = STATE.test_answers.intake[item.key]; ta.dispatchEvent(new Event('input', { bubbles: true })); } }, '試験の答えを入れる')),
      h('div', { class: 'row' }, next, voice.button, i > 0 && h('button', { class: 'thin', onclick: () => showIntake(i - 1) }, '前へ戻る')),
      voice.note);
    snap(4 + 4 * i);
    ta.focus();
  });
}

// ---------- ② 深掘りの質問 ----------
function screenAsking() {
  put(view, h('div', { class: 'kicker' }, '次の質問'),
    P.ask_error ? h('div', {}, errBox(P.ask_error), h('button', { class: 'main', onclick: async () => { await post('/api/ask_again', { id: P.id }); } }, 'もう一度聞く'))
      : h('h1', { class: 'mute' }, '答えを読んでいます…'));
}
function screenQuestion() {
  const pend = P.pending;
  const ta = h('textarea', { placeholder: 'ここに書いてください', 'aria-label': pend.q, rows: 4 });
  const msg = h('div', {});
  const next = h('button', { class: 'main', disabled: true }, '次へ');
  ta.addEventListener('input', () => { next.disabled = !ta.value.trim(); });
  const voice = voiceFor(ta);
  const send = async body => {
    next.disabled = true;
    msg.replaceChildren();
    voice.stop();
    try {
      const res = await post('/api/answer', { id: P.id, ...body });
      if (res.stopped) { put(msg, stopBox(res)); next.disabled = false; return; }
      load(P.id);
    } catch (e) { put(msg, errBox(e.status === 429 ? e.body.message : '送れませんでした。もう一度お願いします。')); next.disabled = false; }
  };
  next.addEventListener('click', () => send({ answer: ta.value }));
  put(view, 
    h('div', { class: 'kicker' }, `質問 ${P.qa.length + 1}　${pend.axis_name}`),
    h('h1', {}, pend.q), ta, msg,
    STATE.test && h('div', { class: 'row' }, h('button', { class: 'thin', onclick: () => { ta.value = STATE.test_answers.qa[P.qa.length] || ''; ta.dispatchEvent(new Event('input', { bubbles: true })); } }, '試験の答えを入れる')),
    h('div', { class: 'row' }, next, voice.button, h('button', { class: 'thin', onclick: () => send({ skip: true }) }, 'わからない・飛ばす')),
    voice.note);
  ta.focus();
}

// ---------- 答えの見直し ----------
function screenReview() {
  const msg = h('div', {});
  const field = (label, value, target) => {
    const ta = h('textarea', { 'aria-label': label, value });
    const note = h('div', {});
    ta.addEventListener('change', async () => {
      note.replaceChildren();
      const res = await post('/api/edit_answer', { id: P.id, answer: ta.value, ...target }).catch(() => null);
      if (!res) note.append(errBox('直せませんでした。'));
      else if (res.stopped) note.append(stopBox(res));
    });
    return h('div', { class: 'a' }, h('label', {}, label), ta, note);
  };
  const go = h('button', { class: 'main', onclick: async () => {
    go.disabled = true;
    try { await post('/api/generate', { id: P.id }); load(P.id); }
    catch (e) { put(msg, errBox(e.body && e.body.message || '作り始められませんでした。')); go.disabled = false; }
  } }, 'これで作る');
  put(view, 
    h('div', { class: 'kicker' }, '答えの見直し'),
    h('h1', {}, 'この答えをもとに作ります。'),
    h('p', { class: 'mute' }, '直したい所があれば、ここで書き直してください。作るのに数分かかります。'),
    h('div', { class: 'answers' },
      STATE.intake.map(i => field(i.q, P.intake[i.key] || '', { key: i.key })),
      P.qa.map((q, idx) => field(q.q, q.a, { index: idx }))),
    msg, h('div', { class: 'row' }, go));
}

// ---------- ③ 作る→確かめる→直す ----------
let prog = {};
function screenProgress() {
  prog = { title: h('h1', {}), kicker: h('div', { class: 'kicker' }), steps: h('ol', { class: 'steps' }), tick: h('div', { class: 'ticker' }), live: h('div', { class: 'livebox' }), log: h('ul', { class: 'log' }), act: h('div', { style: 'margin-bottom:26px' }), n: 0 };
  const side = h('div', { class: 'progWall' });
  put(view, h('div', { class: 'progGrid' }, side, h('div', { class: 'progMain' }, prog.kicker, prog.title, prog.tick, prog.steps, prog.live)), prog.act,
    h('h2', {}, '見つけた問題と、直した所'), prog.log,
    h('p', { class: 'notice' }, 'この確かめは、見た目と動きだけを見ています。仕事の中身が合っているかは、できたあとで、あなたの目で確かめてください。'),
    h('p', { class: 'notice' }, 'この画面は閉じても大丈夫です。作るのは裏で続きます。ページが動くかを確かめる所だけは、この画面を開いている間に進みます。'));
  prog.wall = makeWall(side);
  side.append(h('div', { class: 'peelNote' }, '壁の絵は、進み具合の目印です。'));
  prog.wall.set(.3);
  prog.wall.build(1);
}
function stepsOf(j) {
  const out = [];
  const st = j.stage;
  const making = st === 'script' || st === 'scene' || (st === 'paused' && !j.rounds.length);
  out.push({ label: '作っています', state: making ? 'now' : 'done', t: (j.times.script_ms || 0) + (j.times.scene_ms || 0) });
  if (!j.rounds.length) out.push({ label: '確かめています（1回目）', state: 'todo' });
  j.rounds.forEach((r, i) => {
    const last = i === j.rounds.length - 1;
    const checking = last && ['preflight', 'check', 'review', 'judge'].includes(st);
    const t = (r.machine ? r.machine.ms || 0 : 0) + (r.eye ? r.eye.ms || 0 : 0);
    out.push({ label: `確かめています（${r.round}回目）`, state: checking ? 'now' : r.verdict ? 'done' : 'todo', t, tail: r.verdict === 'pass' ? '大きな問題なし' : r.verdict === 'fail' ? '問題あり' : '' });
    if (r.fix || (last && st === 'fix')) out.push({ label: '直しています', state: last && st === 'fix' ? 'now' : 'done', t: r.fix ? r.fix.ms : null });
  });
  return out;
}
const LOG_WORD = { found: '見つけた', fixed: '直した', info: '進み具合', passed: '通った', left: '残った', reverted: '戻した' };
function logItem(x) {
  return h('li', {}, h('span', { class: 'who ' + x.kind }, LOG_WORD[x.kind] || ''),
    h('div', { class: 'grow' }, x.text, x.source ? h('span', { class: 'mute small' }, `（${x.source}）`) : null),
    x.image ? h('img', { src: shotUrl(x.image), alt: '問題が見つかった画面', onclick: () => zoomImg(shotUrl(x.image)) }) : null);
}
function updateProgress() {
  const j = P.job;
  if (!j || !prog.title) return;
  const round = j.round || 1;
  const words = {
    script: ['作っています', '台本を書いています'], scene: ['作っています', '3Dの物を作っています'],
    preflight: [`確かめています（${round}回目）`, '言葉と形を見ています'], check: [`確かめています（${round}回目）`, 'ページを動かして、画面を撮っています'],
    review: [`確かめています（${round}回目）`, 'Claudeが画面を見ています'], judge: [`確かめています（${round}回目）`, '結果をまとめています'],
    fix: ['直しています', '見つけた問題を直しています'], paused: ['止まっています', '途中で止まりました'], failed: ['止まりました', 'ページは作れませんでした'],
  }[j.stage] || ['', j.stage_name];
  prog.kicker.textContent = words[0];
  prog.title.textContent = words[1];
  prog.tick.textContent = j.ended ? `かかった時間 ${min(j.ended - j.started)}` : (j.stage === 'paused' || j.stage === 'failed') ? '' : `はじめてから ${min(j.now - j.started)}　この作業 ${min(j.now - j.stage_started)}`;
  prog.steps.replaceChildren(...stepsOf(j).map(s => h('li', { class: s.state }, s.label, s.t ? h('span', { class: 't' }, ms(s.t)) : null, s.tail ? h('span', { class: 't' }, s.tail) : null)));
  // 書いている途中の様子（止まって見えないように）
  if (j.live) {
    prog.live.hidden = false;
    const kids = [h('div', { class: 'small mute' }, j.stage === 'scene' ? `コードを書いています　${j.live.chars.toLocaleString()}字` : j.stage === 'review' ? `画面を見て、書いています　${j.live.chars.toLocaleString()}字` : `書いています　${j.live.chars.toLocaleString()}字`)];
    if (j.stage === 'script' && j.live.titles.length) kids.push(h('ul', {}, j.live.titles.map(t => h('li', {}, t))));
    prog.live.replaceChildren(...kids);
  } else if (j.stage === 'check') {
    prog.live.hidden = false;
    prog.live.replaceChildren(h('div', { class: 'small mute' }, 'パソコンとスマホの大きさで開いて、場面ごとに画面を撮っています。'));
  } else {
    prog.live.hidden = true;
  }
  // ログは増えた分だけ足す
  for (; prog.n < j.log.length; prog.n++) prog.log.prepend(logItem(j.log[prog.n]));
  // 止まったときの出口
  prog.act.replaceChildren();
  if (j.stage === 'paused') {
    put(prog.act, errBox(j.error || '止まりました。'), h('div', { class: 'row' },
      h('button', { class: 'main', disabled: !STATE.test && !STATE.key, onclick: async () => { await post('/api/resume', { id: P.id }); load(P.id); } }, '続きから')));
    snap(40);
  } else if (j.stage === 'failed') {
    put(prog.act, errBox(j.error || '止まりました。'),
      j.remaining && j.remaining.length ? h('div', { class: 'card' }, h('h2', {}, '残った問題'), h('ul', { class: 'log' }, j.remaining.map(x => h('li', {}, h('div', { class: 'grow' }, x.text))))) : null,
      h('div', { class: 'row' }, h('button', { class: 'main', onclick: () => { screen = ''; view.replaceChildren(); setScreen('review2', screenReview); } }, '答えを見直して、作り直す')));
  } else {
    const total = 1 + j.max_rounds * 2 + 1;
    const doneSteps = stepsOf(j).filter(s => s.state === 'done').length;
    snap(58 + Math.min(40, 40 * doneSteps / total));
    if (prog.wall) prog.wall.build(Math.min(4, 1 + Math.round(3 * Math.min(1, doneSteps / total))));
  }
  // ブラウザが要る手順
  if (j.stage === 'check' && j.check) runBuildCheck(j.check);
}

// 隠したページで動かして、結果と画面をサーバーへ返す
function openFrame(url, w, hh, onmsg) {
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts');
  f.title = '確かめ';
  f.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${hh}px;border:0`;
  const listener = e => { if (e.source === f.contentWindow && e.data && e.data.kit) onmsg(e.data); };
  addEventListener('message', listener);
  off.append(f);
  f.src = url;
  return { f, send(m) { f.contentWindow.postMessage(m, '*'); }, close() { removeEventListener('message', listener); f.remove(); } };
}
function checkFrame(url, w, hh, timeout = 45000) {
  return new Promise(resolve => {
    let ready = null, chapters = null, tm = null;
    const fr = openFrame(url + `?check=1&vw=${w}&vh=${hh}`, w, hh, m => {
      if (m.kit === 'ready') { ready = !!m.ok; chapters = m.chapters || null; }
      if (m.kit === 'shot' && fr.onshot) fr.onshot(m);
      if (m.kit === 'check') { clearTimeout(tm); fr.ready = ready; fr.chapters = chapters; resolve({ fr, check: m, ready }); }
    });
    tm = setTimeout(() => resolve({ fr, check: { ok: false, timeout: true, ran: false, errors: ['確かめる画面が、時間内に応えませんでした'], warnings: [], stats: {} }, ready }), timeout);
  });
}
function takeShot(fr, p, w, hh) {
  return new Promise((resolve, reject) => {
    const tag = Math.random().toString(36).slice(2);
    const tm = setTimeout(() => reject(new Error('shot timeout')), 15000);
    fr.onshot = m => { if (m.tag === tag) { clearTimeout(tm); resolve(String(m.url).replace(/^data:image\/jpeg;base64,/, '')); } };
    fr.send({ kit: 'shot', p, w, h: hh, tag });
  });
}
let checkBusy = null;
async function runBuildCheck(chk) {
  if (checkBusy === chk.nonce) return;
  checkBusy = chk.nonce;
  let check, images = [];
  const { fr, check: pc, ready } = await checkFrame(chk.url, 1280, 720);
  check = { ...pc, ran: ready !== false && !pc.timeout && !pc.syntax };
  // 名札の問題だけなら、絵は撮れる。Claudeの目にも一緒に見せて、1回の直しでまとめて直す
  const onlyLabels = () => !check.broken && !check.timeout && !check.syntax && (check.errors || []).length > 0 && check.errors.every(e => e.includes('名札'));
  try {
    if (check.ok || onlyLabels()) {
      const { fr: ph, check: pr } = await checkFrame(chk.url, 390, 770);
      ph.close();
      if (!pr.ok) { check.ok = false; check.errors = [...new Set([...(check.errors || []), ...(pr.errors || []).filter(e => !e.includes('名札')).map(e => 'スマホの画面で: ' + e)])]; if (pr.broken || pr.timeout) check.broken = true; }
    }
    if (check.ok || onlyLabels()) {
      for (const pt of chk.points) images.push({ data: await takeShot(fr, pt.p, pt.w, pt.h), chapter: pt.chapter, view: pt.view, p: pt.p });
    }
  } catch (e) {
    check.ok = false;
    check.errors = [...(check.errors || []), '画面を撮れませんでした'];
  }
  fr.close();
  try { await post('/api/report', { id: P.id, nonce: chk.nonce, check, images }); }
  catch (e) { checkBusy = null; toast('確かめた結果を送れませんでした。もう一度試します。'); }
  load(P.id);
}

// ---------- できたページ ----------
let res = {};
function screenResult() {
  const frame = h('iframe', { sandbox: 'allow-scripts', title: 'できたページ' });
  const tag = h('div', { class: 'frameTag', hidden: true });
  res = { frame, tag, url: null, cur: { p: 0, chapter: '' }, picked: null, picking: false, panel: h('div', { class: 'panel' }), fixCard: null, fixKey: '', chapters: null, pendingGoto: null };
  put(view, h('div', { class: 'result' }, h('div', { class: 'frameWrap' }, frame, tag), res.panel));
  buildPanel();
}
addEventListener('message', e => {
  if (!res.frame || e.source !== res.frame.contentWindow || !e.data || !e.data.kit) return;
  const m = e.data;
  if (m.kit === 'state') { res.cur = { p: m.p, chapter: m.chapter }; if (res.onState) res.onState(); }
  if (m.kit === 'ready') { res.chapters = m.chapters || null; if (res.picking) res.frame.contentWindow.postMessage({ kit: 'pick', on: true }, '*'); if (res.pendingGoto) { gotoChapter(res.pendingGoto); res.pendingGoto = null; } }
  if (m.kit === 'picked') { res.picked = m.hit; if (res.onPick) res.onPick(); }
  if (res.onRec) res.onRec(m);
});
// 3Dと説明が縦に並ぶ画面（スマホ）では、3Dが画面の外に出ていることがある
function showFrame() {
  const r = res.frame.getBoundingClientRect();
  if (r.top < 0 || r.bottom > innerHeight) res.frame.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
function setFrame(url, label) {
  if (res.url === url) return;
  res.url = url;
  res.chapters = null;
  res.frame.src = url;
  res.tag.hidden = !label;
  res.tag.textContent = label || '';
}
function gotoChapter(id) {
  if (!res.chapters) { res.pendingGoto = id; return; }
  const c = res.chapters.find(x => x.id === id);
  if (c) res.frame.contentWindow.postMessage({ kit: 'goto', p: c.a + (c.b - c.a) * .5 }, '*');
}
function buildPanel() {
  res.top = h('div', { class: 'card tape' });
  res.ask = h('div', { class: 'card' });
  res.auto = h('div', { class: 'card' });
  res.out = h('div', { class: 'card' });
  res.panel.replaceChildren(res.top, res.ask, res.auto, res.out);
  buildOut();
}
function updateResult() {
  if (!res.frame) return;
  const fx = P.fix;
  if (fx && fx.stage === 'proposed' && res.showDraft) setFrame(`/p/${P.id}/draft?s=${fx.shot_stamp}`, '下書き（まだ当てていません）');
  else setFrame(`/p/${P.id}?v=${P.current}`, '');
  renderFix();
  renderAsk();
  renderAuto();
  if (fx && fx.stage === 'fix_check' && fx.check) runFixCheck(fx.check);
}

// 「最後に、あなたの目で」＋「ここは違う」
function renderFix() {
  const fx = P.fix;
  const key = fx ? `${fx.stage}:${fx.said}:${fx.shot_stamp || ''}` : (res.fixOpen ? 'open' : 'idle') + P.can_undo + P.person_fixes;
  if (res.fixKey === key) { if (fx && (fx.stage === 'fixing' || fx.stage === 'fix_repair') && res.fixTick) res.fixTick(fx); return; }
  res.fixKey = key;
  res.fixTick = null;
  const c = res.top;
  c.replaceChildren();
  if (!fx && !res.fixOpen) {
    put(c, h('h2', {}, '最後に、あなたの目で確かめてください'),
      h('p', { class: 'small' }, '自動で確かめたのは、見た目と動きだけです。仕事の中身が合っているかは、あなたにしか分かりません。スクロールして見てください。'),
      h('button', { class: 'main', onclick: () => { res.fixOpen = true; renderFix(); } }, 'ここは違う'),
      h('p', { class: 'small mute', style: 'margin:12px 0 0' }, `あなたが直した回数: ${P.person_fixes}回`),
      P.can_undo ? h('button', { class: 'thin', onclick: async () => { await post('/api/undo', { id: P.id }); toast('1つ前に戻しました'); load(P.id); } }, '1つ前に戻す') : null);
    return;
  }
  if (!fx) return renderFixInput(c);
  if (fx.stage === 'fixing' || fx.stage === 'fix_repair') {
    const t = h('p', { class: 'small mute' });
    res.fixTick = f => { t.textContent = `${min(f.now - f.started)}　${f.live ? f.live.chars.toLocaleString() + '字' : ''}`; };
    res.fixTick(fx);
    put(c, h('h2', {}, fx.stage === 'fixing' ? '直す案を作っています' : '案が動かなかったので、直しています'), h('p', { class: 'small' }, `「${fx.said}」`), t);
    return;
  }
  if (fx.stage === 'fix_check') { put(c, h('h2', {}, '案が動くか、確かめています')); return; }
  if (fx.stage === 'proposed') {
    res.showDraft = res.showDraft || false;
    put(c, h('h2', {}, 'こう直す案です'), h('p', { class: 'small' }, fx.summary),
      h('div', { class: 'ba' },
        fx.img_before ? h('figure', {}, h('figcaption', {}, '直す前'), h('img', { src: shotUrl(fx.img_before, fx.shot_stamp), alt: '直す前の画面', onclick: () => zoomImg(shotUrl(fx.img_before, fx.shot_stamp)) })) : null,
        fx.img_after ? h('figure', {}, h('figcaption', {}, '直したあと'), h('img', { src: shotUrl(fx.img_after, fx.shot_stamp), alt: '直したあとの画面', onclick: () => zoomImg(shotUrl(fx.img_after, fx.shot_stamp)) })) : null),
      h('ul', { class: 'diff' }, (fx.diff || []).map(d => h('li', {}, h('b', {}, d.label), h('del', {}, d.before), h('ins', {}, d.after)))),
      (fx.out_of_scope || []).length ? h('div', { class: 'stop small' }, h('strong', {}, 'これは今回直せません'), fx.out_of_scope.map(o => h('div', {}, `${o.request}: ${o.reason}`))) : null,
      h('div', { class: 'btnrow' },
        h('button', { class: 'main', onclick: async () => { res.showDraft = false; res.fixOpen = false; await post('/api/commit', { id: P.id }); toast('当てました。元に戻すこともできます。'); load(P.id); } }, 'これでいい'),
        h('button', { onclick: async () => { res.showDraft = false; res.fixOpen = true; res.againText = fx.said; await post('/api/cancel', { id: P.id }); load(P.id); } }, '違う')),
      h('button', { class: 'thin', style: 'margin-top:10px', onclick: () => { res.showDraft = !res.showDraft; res.fixKey = ''; if (res.showDraft) res.pendingGoto = fx.focus; updateResult(); showFrame(); } }, res.showDraft ? '今のページに戻して見る' : '直したあとを3Dで動かして見る'));
    return;
  }
  if (fx.stage === 'declined') {
    put(c, h('h2', {}, 'これは今はできません'),
      fx.summary ? h('p', { class: 'small' }, fx.summary) : null,
      (fx.out_of_scope || []).map(o => h('p', { class: 'small' }, `${o.request}: ${o.reason}`)),
      h('p', { class: 'small mute' }, 'ページは元のままです。'),
      h('button', { onclick: async () => { await post('/api/cancel', { id: P.id }); load(P.id); } }, '閉じる'));
    return;
  }
  if (fx.stage === 'fix_failed') {
    put(c, h('h2', {}, '直せませんでした'), errBox(fx.error || 'ページは元のままです。'),
      (fx.problems || []).map(x => h('p', { class: 'small mute' }, x)),
      fx.resumable ? h('button', { class: 'main', onclick: async () => { await post('/api/resume', { id: P.id }); load(P.id); } }, '続きから') : null,
      h('button', { style: 'margin-top:8px', onclick: async () => { await post('/api/cancel', { id: P.id }); load(P.id); } }, '閉じる'));
  }
}
function renderFixInput(c) {
  const ta = h('textarea', { placeholder: '「紙は5枚重ねる」のように書いてください', 'aria-label': 'どこが違いますか', rows: 3, value: res.againText || '' });
  res.againText = '';
  const msg = h('div', {});
  const here = h('p', { class: 'small mute' });
  const showHere = () => {
    const ch = (P.chapters || []).find(x => x.id === res.cur.chapter);
    here.textContent = `今見ている場面: ${ch ? ch.title : '―'}` + (res.picked ? `　指した物: ${res.picked.name}` : '');
  };
  res.onState = showHere;
  res.onPick = showHere;
  showHere();
  const voice = voiceFor(ta);
  const pick = h('button', { class: 'thin', onclick: () => {
    res.picking = !res.picking;
    pick.textContent = res.picking ? '指すのをやめる' : '3Dの中の物を指す';
    res.frame.contentWindow.postMessage({ kit: 'pick', on: res.picking }, '*');
    if (res.picking) { toast('3Dの中の物を押してください'); showFrame(); }
  } }, '3Dの中の物を指す');
  const send = h('button', { class: 'main', onclick: async () => {
    if (!ta.value.trim()) return;
    send.disabled = true; voice.stop(); msg.replaceChildren();
    try {
      const r = await post('/api/fix', { id: P.id, said: ta.value, ctx: { chapter: res.cur.chapter, p: res.cur.p, picked: res.picked } });
      if (r.stopped) { put(msg, stopBox(r)); send.disabled = false; return; }
      if (res.picking) { res.picking = false; res.frame.contentWindow.postMessage({ kit: 'pick', on: false }, '*'); }
      res.picked = null; res.fixOpen = false;
      load(P.id);
    } catch (e) { put(msg, errBox(e.body && e.body.message || '送れませんでした。')); send.disabled = false; }
  } }, '直す案を作る');
  put(c, h('h2', {}, 'どこが違いますか？'), here, ta, msg,
    h('div', { class: 'btnrow', style: 'margin-top:10px' }, voice.button, pick), voice.note,
    STATE.test ? h('div', { class: 'btnrow', style: 'margin-top:10px' }, ['紙は5枚重ねる', '骨はもっと太い', '待つのは上の紙の後', '壁紙を花柄にして', '壊すテスト', '二度壊すテスト', '見つからないテスト', '殺菌できる'].map(t => h('button', { class: 'thin', onclick: () => { ta.value = t; } }, t))) : null,
    h('div', { class: 'btnrow', style: 'margin-top:12px' }, send, h('button', { onclick: () => { voice.stop(); res.fixOpen = false; res.onState = null; res.onPick = null; if (res.picking) { res.picking = false; res.frame.contentWindow.postMessage({ kit: 'pick', on: false }, '*'); } renderFix(); } }, 'やめる')));
  ta.focus();
}

// 「ここは職人に確認」
function renderAsk() {
  const items = (P.chapters || []).filter(c => c.confirm);
  const unk = P.unknowns || [];
  const key = JSON.stringify([items.map(i => i.id + i.confirm), unk, P.current]);
  if (res.askKey === key) return;
  res.askKey = key;
  const c = res.ask;
  c.replaceChildren();
  c.hidden = !items.length && !unk.length;
  if (c.hidden) return;
  put(c, h('h2', {}, 'ここは職人に確認'));
  if (items.length) put(c, h('p', { class: 'small mute' }, 'お客さんのページにも、確認中と出ています。合っていれば消せます。'));
  for (const it of items) {
    put(c, h('div', { class: 'ask' }, h('b', {}, it.title), h('div', { class: 'q' }, it.confirm),
      h('div', { class: 'btnrow' },
        h('button', { class: 'thin', onclick: async () => { await post('/api/confirm', { id: P.id, chapter: it.id }); load(P.id); } }, '合っている'),
        h('button', { class: 'thin', onclick: () => { gotoChapter(it.id); res.fixOpen = true; res.againText = ''; res.fixKey = ''; renderFix(); scrollTo(0, 0); } }, '直す'))));
  }
  if (unk.length) {
    put(c, h('p', { class: 'small', style: 'font-weight:700;margin-bottom:4px' }, 'まだ聞けていないこと'));
    put(c, h('ul', { class: 'small', style: 'margin:0;padding-left:20px' }, unk.map(u => h('li', {}, u))));
  }
}

// 自動で確かめたこと（正しい・完成とは言わない）
function renderAuto() {
  const j = P.job;
  if (!j) return;
  const key = JSON.stringify([j.log.length, j.remaining.length, j.stage]);
  if (res.autoKey === key) return;
  res.autoKey = key;
  const c = res.auto;
  c.replaceChildren();
  const eyeCount = j.rounds.filter(r => r.eye).length;
  const high = j.remaining.filter(x => x.severity === 'high');
  const low = j.remaining.filter(x => x.severity !== 'high');
  put(c, h('h2', {}, '自動で確かめたこと'),
    h('p', { class: 'small' }, `見た目と動きを${j.rounds.length}回確かめて、${j.rounds.filter(r => r.fix && r.fix.to_version).length}回直しました。` + (j.reverted ? `直して悪くなった版は${j.reverted}回、前の版へ戻しました。` : '')));
  if (high.length) {
    put(c, h('div', { class: 'stop small' }, h('strong', {}, `直しきれなかった問題が${high.length}つあります`), high.map(x => h('div', { style: 'margin-top:6px' }, x.text))));
  } else {
    put(c, h('p', { class: 'small' }, low.length ? '動かなくなる問題はありません。下の点は直しきれませんでした。' : '見た目と動きに、問題は見つかりませんでした。'));
  }
  put(c, h('p', { class: 'small mute' }, 'これは「仕事の中身が合っている」という意味ではありません。'));
  if (low.length) put(c, h('div', { class: 'small', style: 'margin:6px 0' }, h('strong', {}, `直しきれなかった点 ${low.length}つ`), low.map(x => h('div', { style: 'margin-top:6px' }, x.text))));
  const times = j.rounds.map(r => `${r.round}回目 ${ms((r.machine ? r.machine.ms : 0) + (r.eye ? r.eye.ms || 0 : 0) + (r.fix ? r.fix.ms || 0 : 0))}`).join(' / ');
  put(c, h('details', {}, h('summary', { class: 'small' }, '見つけた問題と、直した所'),
    h('ul', { class: 'log' }, j.log.slice().reverse().map(logItem)),
    h('p', { class: 'small mute' }, `全部で ${min(j.ended - j.started)}。台本 ${ms(j.times.script_ms)}・3D ${ms(j.times.scene_ms)}・${times}`)));
}

// ⑤ 持ち出す
function buildOut() {
  const c = res.out;
  const msg = h('div', { class: 'small', style: 'margin-top:8px' });
  const copy = async () => {
    msg.replaceChildren();
    const d = await get('/api/export?id=' + P.id);
    let ok = false;
    try { await navigator.clipboard.writeText(d.html); ok = true; } catch (e) {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px', value: d.html });
      document.body.append(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch (e2) {}
      ta.remove();
    }
    const blob = new Blob([d.html], { type: 'text/html' });
    put(msg, h('p', { class: 'small', style: 'margin:0 0 6px' }, ok ? `コピーしました（1枚のHTML・${Math.round(d.bytes / 1024)}KB）。` : 'コピーできませんでした。ファイルで保存してください。'),
      d.test ? h('p', { class: 'small mute', style: 'margin:0 0 6px' }, 'テスト中なので「テスト」の札が入っています。') : null,
      h('a', { class: 'btn', style: 'min-height:44px;font-size:15px', href: URL.createObjectURL(blob), download: d.filename }, 'ファイルで保存'));
  };
  const link = async () => {
    msg.replaceChildren();
    const d = await get('/api/link?id=' + P.id);
    put(msg, h('div', { class: 'urlbox' }, d.url), h('p', { class: 'small mute', style: 'margin:0' }, d.note));
  };
  put(c, h('h2', {}, '持ち出す'),
    h('div', { class: 'btnrow' },
      h('button', { class: 'thin', onclick: copy }, 'コードをコピー'),
      h('button', { class: 'thin', onclick: () => startRecord(msg, 1280, 720) }, '動画を保存（横）'),
      h('button', { class: 'thin', onclick: () => startRecord(msg, 720, 1280) }, '動画を保存（縦）'),
      h('button', { class: 'thin', onclick: link }, 'リンクをもらう')),
    msg);
}
function startRecord(msg, w, hh) {
  const n = (P.chapters || []).length;
  const seconds = Math.max(20, n * 7);
  const total = seconds + 2;
  msg.replaceChildren();
  const bar = h('i', {});
  const text = h('p', { class: 'small', style: 'margin:0' }, `録っています。あと${total}秒ほどかかります。この画面を開いたままにしてください。`);
  const cancel = h('button', { class: 'thin', style: 'margin-top:6px', onclick: () => res.frame.contentWindow.postMessage({ kit: 'rec_cancel' }, '*') }, '録るのをやめる');
  put(msg, text, h('div', { class: 'prog' }, bar), cancel);
  res.onRec = m => {
    if (m.kit === 'rec_progress') { bar.style.width = (100 * m.el / m.total) + '%'; text.textContent = `録っています。あと${Math.ceil(m.total - m.el)}秒ほどかかります。この画面を開いたままにしてください。`; }
    if (m.kit === 'recorded') {
      res.onRec = null;
      const ext = m.type.includes('mp4') ? 'mp4' : 'webm';
      const url = URL.createObjectURL(m.blob);
      msg.replaceChildren(h('p', { class: 'small', style: 'margin:0 0 6px' }, `録れました（${Math.round(m.blob.size / 1024 / 1024 * 10) / 10}MB・字幕入り）。音はありません。`),
        h('a', { class: 'btn', style: 'min-height:44px;font-size:15px', href: url, download: `${P.title || '見えない仕事'}.${ext}` }, '動画をダウンロード'),
        h('video', { class: 'vid', src: url, controls: true, muted: true, playsinline: true }));
    }
    if (m.kit === 'rec_cancelled') { res.onRec = null; msg.replaceChildren(h('p', { class: 'small mute', style: 'margin:0' }, '録るのをやめました。')); }
    if (m.kit === 'rec_error') { res.onRec = null; msg.replaceChildren(errBox(m.message)); }
  };
  res.frame.contentWindow.postMessage({ kit: 'record', w, h: hh, seconds }, '*');
}

// 直す案の確かめ：下書きを動かし、前後の絵を撮る
let fixBusy = null;
async function runFixCheck(chk) {
  if (fixBusy === chk.nonce) return;
  fixBusy = chk.nonce;
  const { fr, check, ready } = await checkFrame(chk.url, 1280, 720);
  const out = { ...check, ran: ready !== false };
  const images = {};
  try {
    if (out.ok) {
      const ch = (fr.chapters || []).find(c => c.id === chk.focus);
      const p = ch ? ch.a + (ch.b - ch.a) * .55 : .5;
      images.after = await takeShot(fr, p, 960, 540);
      const before = await checkFrame(chk.before, 1280, 720);
      const old = (before.fr.chapters || []).find(c => c.id === chk.focus);
      images.before = await takeShot(before.fr, old ? old.a + (old.b - old.a) * .55 : p, 960, 540);
      before.fr.close();
    }
  } catch (e) {}
  fr.close();
  try { await post('/api/report', { id: P.id, nonce: chk.nonce, check: out, images }); }
  catch (e) { fixBusy = null; }
  res.showDraft = false;
  load(P.id);
}

// ---------- 起動 ----------
(async function start() {
  try { STATE = await get('/api/state'); }
  catch (e) { put(view, errBox('サーバーにつながりません。')); return; }
  if (STATE.test) $('#testBadge').hidden = false;
  const boot = () => {
    const id = new URLSearchParams(location.search).get('id');
    screen = '';
    res = {};
    if (id) load(id); else showHome();
  };
  addEventListener('popstate', boot);
  boot();
})();
