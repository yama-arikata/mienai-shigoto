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
function makeWall(host, { labels = false, names = null } = {}) {
  const scene = h('div', { class: 'wallScene' });
  const stage = h('div', { class: 'wallStage', 'aria-hidden': 'true' }, scene);
  host.append(stage);
  const layers = WALL_LAYERS.map((l, n) => {
    const slab = h('div', { class: 'wallSlab' });
    const clips = [];
    let topFace = null;
    const face = (cls, css) => { const f = h('div', { class: cls }); f.style.cssText = css; slab.append(f); return f; };
    if (l.key === 'take') {
      for (const [k, z] of [['takeV', 0], ['takeH', 9]]) {
        const c = wallCanvas(WALL_PAINT[k]);
        c.className = 'wallFace';
        c.style.transform = `translateZ(${z}px)`;
        slab.append(c);
        clips.push(c);
      }
    } else {
      const c = wallCanvas(WALL_PAINT[l.key]);
      c.className = 'wallFace';
      c.style.transform = `translateZ(${l.thick}px)`;
      slab.append(c);
      clips.push(c);
      clips.push(face('wallFace', `width:${l.thick}px;height:${WALL_H}px;background:${l.side};transform-origin:0 0;transform:rotateY(-90deg)`));
      topFace = face('wallFace', `width:${WALL_W}px;height:${l.thick}px;background:${l.top};transform-origin:0 0;transform:rotateX(90deg)`);
    }
    const dot = h('i', { class: 'wallDot' });
    slab.append(dot);
    scene.append(slab);
    const tag = labels ? h('div', { class: 'wallLabel ' + (names ? 'step' : l.key) }, names ? names[n] : l.label) : null;
    if (tag) stage.append(tag);
    const edge = names ? h('i', { class: 'wallEdge' }) : null;
    if (edge) slab.append(edge);
    return { ...l, slab, dot, tag, clips, topFace, edge };
  });
  let t = 0, shown = layers.length;
  function place() {
    for (const [i, l] of layers.entries()) {
      const off = i >= shown && !names ? 70 : 0;
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
      if (!names) l.tag.style.opacity = front ? 1 : Math.max(0, Math.min(1, (t - .3 - (2 - i) * .14) / .16));
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
    // cur 番目の層を、下から f（0〜1）まで塗る。cur より前は塗り終わり、後はまだ無い
    grow(cur, f) {
      shown = cur + 1; place();
      for (const [i, l] of layers.entries()) {
        const amount = i < cur ? 1 : i === cur ? f : 0;
        const clip = amount >= 1 ? 'none' : `inset(${((1 - amount) * 100).toFixed(1)}% 0 0 0)`;
        for (const c of l.clips) c.style.clipPath = clip;
        if (l.topFace) l.topFace.style.opacity = amount >= 1 ? 1 : 0;
        if (l.edge) {
          l.edge.hidden = i !== cur;
          l.edge.style.transform = `translateY(${((1 - amount) * WALL_H).toFixed(1)}px) translateZ(${l.thick + 1}px)`;
        }
        if (l.tag) l.tag.className = `wallLabel step ${i < cur ? 'done' : i === cur ? 'now' : 'todo'}`;
      }
    },
    get t() { return t; },
    fit,
  };
}
// はじめの画面：津軽塗の「模様」と「奥の仕事」をつまみで見比べる
const SAMPLE_NOTE = '見本。公開資料から作った例。職人さんの確認はこれから';
const SHELF = [
  { id: 'sakan', name: '左官の土壁' },
  { id: 'tsugite', name: '柱の継ぎ手' },
  { id: 'ringo', name: 'りんごのせん定' },
  { id: 'rousui', name: '水もれ調査' },
];
const SAMPLE_NAMES = { tsugaru: '津軽塗', ...Object.fromEntries(SHELF.map(x => [x.id, x.name])) };
function openSample(id) { history.pushState(null, '', '/?mihon=' + id); showSample(id); }
function sampleLink(id, attrs, ...kids) {
  return h('a', { href: '/?mihon=' + id, ...attrs, onclick: e => { e.preventDefault(); openSample(id); } }, ...kids);
}
function moyouStage() {
  const stage = h('div', { class: 'moyouStage' },
    h('img', { class: 'moyouPic', src: '/home/tsugaru_moyou.jpg', alt: '津軽塗の模様が出た丸盆と椀（見本の絵）' }),
    h('img', { class: 'moyouPic oku', src: '/home/tsugaru_oku.jpg', alt: '同じ塗りの断面。色の層が重なっている（見本の絵）' }),
    h('i', { class: 'moyouLine' }),
    h('div', { class: 'moyouTag' }, 'お客さんが見る模様'),
    h('div', { class: 'moyouTag right' }, 'その奥の仕事'));
  const range = h('input', { type: 'range', min: 0, max: 100, value: 50, class: 'peel', 'aria-label': '模様と奥の仕事を見比べる' });
  const set = v => { stage.style.setProperty('--v', v + '%'); range.value = v; };
  let stop = false;
  range.addEventListener('input', () => { stop = true; set(+range.value); });
  // 絵の上を指でなぞっても動く
  const fromX = e => { const r = stage.getBoundingClientRect(); set(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * 100)); };
  stage.addEventListener('pointerdown', e => { stop = true; stage.setPointerCapture(e.pointerId); fromX(e); });
  stage.addEventListener('pointermove', e => { if (stage.hasPointerCapture(e.pointerId)) fromX(e); });
  set(50);
  // 一度だけ、動くものだと分かるように小さく揺れる
  if (!matchMedia('(prefers-reduced-motion:reduce)').matches) {
    const t0 = performance.now() + 1000, dur = 1800;
    const step = now => {
      if (stop || !stage.isConnected) return;
      const x = (now - t0) / dur;
      if (x >= 1) return set(50);
      if (x > 0) set(Math.round(50 + Math.sin(x * Math.PI * 2) * 16));
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  return h('div', { class: 'moyou' }, stage,
    h('div', { class: 'moyouBar' }, h('span', {}, '模様'), range, h('span', {}, '奥の仕事')),
    h('p', { class: 'sampleNote' }, '津軽塗の', SAMPLE_NOTE, '。器の形と色は、説明のために描いた絵です。', sampleLink('tsugaru', { class: 'sampleOpen' }, '3Dで開いて見る')));
}
function shelf() {
  return h('section', { class: 'shelf' },
    h('h2', {}, 'ほかの仕事の見本'),
    h('p', { class: 'mute small' }, 'どれも人の手を入れて作った見本です。道具が作るページと同じ見た目になるとは限りません。'),
    h('div', { class: 'shelfRow' }, SHELF.map(x => sampleLink(x.id, { class: 'shelfItem' },
      h('img', { src: '/home/' + x.id + '.jpg', alt: '', loading: 'lazy' }),
      h('b', {}, x.name),
      h('span', { class: 'shelfNote' }, SAMPLE_NOTE)))));
}
// 見本は枠の中で開く。「もどる」でいつでもはじめの画面へ
function showSample(id) {
  if (!SAMPLE_NAMES[id]) { history.replaceState(null, '', '/'); return showHome(); }
  clearTimeout(timer);
  P = null;
  screen = '';
  setScreen('mihon' + id, () => {
    view.className = 'sample';
    put(view, h('div', { class: 'sampleTop' },
      h('button', { class: 'sampleBack', onclick: () => { history.pushState(null, '', '/'); screen = ''; showHome(); } }, '← もどる'),
      h('div', { class: 'sampleLabel' }, h('b', {}, SAMPLE_NAMES[id]), ' ', SAMPLE_NOTE)),
      h('iframe', { class: 'sampleFrame', src: '/mihon/' + id + '/', title: SAMPLE_NAMES[id] + 'の見本' }));
  });
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
    const lost = workLost && errBox('サーバーが再起動して、作りかけが消えました。すみません、もう一度はじめてください。');
    workLost = false;
    put(view, lost, moyouStage(),
      h('div', { class: 'homeGo' },
        h('div', {},
          h('h1', {}, h('span', {}, '見えない手間を、'), h('span', {}, '見える形に。')),
          h('p', { class: 'lead' }, 'いくつか質問に答えるだけで、あなたの仕事の奥を3Dのページにします。'),
          h('p', { class: 'mute small' }, '文字でも声でも答えられます。言っていないことは書きません。分からない所は「ここは職人に確認」と出します。')),
        h('div', { class: 'homeBtn' }, blocked && errBox(STATE.no_key_message),
          h('button', { class: 'main', disabled: blocked, onclick: () => showIntake(0) }, 'はじめる'))),
      shelf(),
      list.length ? h('div', {}, h('h2', { style: 'margin-top:44px' }, '前に作ったもの'),
        h('ul', { class: 'list' }, list.map(x => h('li', {}, h('a', { href: '/?id=' + x.id, onclick: e => { e.preventDefault(); openProject(x.id); } },
          h('span', {}, x.title || '（名前なし）', ' ', h('span', { class: 'mute small' }, x.job)),
          h('span', { class: 'mute small' }, stageWord(x.stage))))))) : null);
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
const BUILD_LAYERS = ['1　台本を書く', '2　3Dを作る', '3　確かめる', '4　直して仕上げる'];
function screenProgress() {
  view.classList.add('build');
  prog = { title: h('h1', {}), kicker: h('div', { class: 'kicker' }), steps: h('ol', { class: 'steps' }), tick: h('div', { class: 'ticker' }), live: h('div', { class: 'livebox' }), log: h('ul', { class: 'log' }), act: h('div', {}), n: 0,
    fuda: h('ol', { class: 'fuda' }), fudaN: 0, shots: h('div', { class: 'peekShots' }), shotsKey: '', logHead: h('h2', {}, '見つけた問題と、直した所'), layer: 0 };
  prog.fudaBox = h('div', { class: 'fudaBox' }, h('h2', {}, '台本に書かれた行'), prog.fuda);
  prog.fudaBox.hidden = true;
  prog.shotBox = h('div', { class: 'shotBox' }, h('h2', {}, 'できてきたページの画面'), prog.shots);
  prog.shotBox.hidden = true;
  const art = h('div', { class: 'buildArt' });
  put(view, h('div', { class: 'buildGrid' }, art, h('div', { class: 'buildInfo' }, prog.kicker, prog.title, prog.tick, prog.live, prog.act, prog.fudaBox, prog.shotBox, prog.logHead, prog.log,
    h('details', { class: 'fold plain' }, h('summary', {}, 'くわしい進み具合'), prog.steps),
    h('p', { class: 'notice' }, 'この確かめは、見た目と動きだけを見ています。仕事の中身が合っているかは、できたあとで、あなたの目で確かめてください。'),
    h('p', { class: 'notice' }, 'この画面は閉じても大丈夫です。作るのは裏で続きます。ページが動くかを確かめる所だけは、この画面を開いている間に進みます。'))));
  prog.wall = makeWall(art, { labels: true, names: BUILD_LAYERS });
  art.append(h('div', { class: 'buildNote' }, '壁の絵は、進み具合の目印です。あなたの仕事の絵ではありません。'));
  prog.wall.set(.8);
  prog.wall.grow(0, .02);
}
// いま塗っている層と、その塗り具合。塗り具合は経過時間から出す目印で、残り時間の見積もりではない
function growOf(j) {
  const st = j.stage;
  const check = ['preflight', 'check', 'review', 'judge'].includes(st);
  let layer = prog.layer;
  if (st === 'script') layer = 0;
  else if (st === 'scene') layer = 1;
  else if (st === 'fix' || (check && j.rounds.length > 1)) layer = 3;
  else if (check) layer = 2;
  if (st === 'paused' || st === 'failed') return { layer, f: prog.f || .5 };
  const tau = [25, 90, 40, 70][layer];
  return { layer, f: Math.min(.96, .04 + (1 - Math.exp(-Math.max(0, j.now - j.stage_started) / tau))) };
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
    prog.live.replaceChildren(h('div', { class: 'small mute' }, j.stage === 'scene' ? `コードを書いています　${j.live.chars.toLocaleString()}字` : j.stage === 'review' ? `画面を見て、書いています　${j.live.chars.toLocaleString()}字` : `書いています　${j.live.chars.toLocaleString()}字`));
  } else if (j.stage === 'check') {
    prog.live.hidden = false;
    prog.live.replaceChildren(h('div', { class: 'small mute' }, 'パソコンとスマホの大きさで開いて、場面ごとに画面を撮っています。'));
  } else {
    prog.live.hidden = true;
  }
  // ログは増えた分だけ足す
  for (; prog.n < j.log.length; prog.n++) prog.log.prepend(logItem(j.log[prog.n]));
  // 実際に書かれた行だけを札にする。書き終わった台本があれば、そちらを読む
  const titles = (j.titles && j.titles.length) ? j.titles : (j.live && j.stage === 'script' && j.live.titles) || [];
  for (; prog.fudaN < titles.length; prog.fudaN++) prog.fuda.append(h('li', {}, titles[prog.fudaN]));
  prog.fudaBox.hidden = !prog.fudaN;
  // 確かめるときに撮った、本物の画面
  const shotRound = j.rounds.slice().reverse().find(r => (r.images || []).length);
  if (shotRound) {
    const key = `${shotRound.round}:${shotRound.images.length}`;
    if (prog.shotsKey !== key) {
      prog.shotsKey = key;
      prog.shots.replaceChildren(...shotRound.images.filter(x => x.view === 'PC').map(x => h('img', { src: shotUrl(x.name, shotRound.round), alt: 'できてきたページの画面', onclick: () => zoomImg(shotUrl(x.name, shotRound.round)) })));
      prog.shotBox.hidden = !prog.shots.childElementCount;
    }
  }
  prog.logHead.hidden = !j.log.length;
  const grown = growOf(j);
  prog.layer = grown.layer; prog.f = grown.f;
  if (prog.wall) prog.wall.grow(grown.layer, grown.f);
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
  res = { frame, tag, url: null, cur: { p: 0, chapter: '' }, picked: null, picking: false, panel: h('div', { class: 'panel' }), fixCard: null, fixKey: '', chapters: null, pendingGoto: null, autoDone: false, auto: null };
  res.wrap = h('div', { class: 'frameWrap' }, frame, tag);
  res.rail = buildRail();
  res.stageCol = h('div', { class: 'stageCol' }, res.wrap, res.rail.el);
  put(view, h('div', { class: 'result' }, res.stageCol, res.panel));
  buildPanel();
}
addEventListener('message', e => {
  if (!res.frame || e.source !== res.frame.contentWindow || !e.data || !e.data.kit) return;
  const m = e.data;
  if (m.kit === 'state') { res.cur = { p: m.p, chapter: m.chapter }; if (res.onState) res.onState(); updateRail(); markAsk(); }
  if (m.kit === 'touch') stopAuto();
  if (m.kit === 'ready') {
    res.chapters = m.chapters || null;
    if (res.picking) res.frame.contentWindow.postMessage({ kit: 'pick', on: true }, '*');
    if (res.pendingGoto) { gotoChapter(res.pendingGoto); res.pendingGoto = null; }
    else startAuto();
    updateRail();
  }
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
// 開いたら少しだけ自動で進めて、中身の見える場面で止まる。さわったら、そこで止める
const AUTO_AT = .7, AUTO_MS = 6500;
function startAuto() {
  if (res.autoDone || P.fix || !res.chapters || !res.chapters.length) return;
  res.autoDone = true;
  const c = res.chapters.find(x => x.a <= AUTO_AT && AUTO_AT < x.b) || res.chapters[res.chapters.length - 1];
  const target = c.a + (c.b - c.a) * .5;
  const send = p => res.frame.contentWindow.postMessage({ kit: 'goto', p }, '*');
  if (matchMedia('(prefers-reduced-motion:reduce)').matches) { send(target); return; }
  const a = res.auto = { on: true };
  const t0 = performance.now() + 700;
  const step = now => {
    if (!a.on || !res.frame.isConnected) return;
    const x = Math.max(0, Math.min(1, (now - t0) / AUTO_MS));
    send(target * (x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2));
    if (x < 1) requestAnimationFrame(step); else stopAuto();
  };
  requestAnimationFrame(step);
  updateRail();
}
function stopAuto() {
  res.autoDone = true;
  if (res.auto) { res.auto.on = false; res.auto = null; updateRail(); }
}
addEventListener('blur', () => { if (res.frame && document.activeElement === res.frame) stopAuto(); });
// 3Dの下の帯：スクロールに慣れていなくても、押すだけで場面を動かせる
function buildRail() {
  const prev = h('button', { class: 'railBtn', onclick: () => stepChapter(-1) }, '◀ 前の場面');
  const next = h('button', { class: 'railBtn', onclick: () => stepChapter(1) }, '次の場面 ▶');
  const title = h('div', { class: 'railTitle' });
  const hint = h('div', { class: 'railHint' });
  const pips = h('div', { class: 'railPips' });
  return { el: h('div', { class: 'rail' }, prev, h('div', { class: 'railMid' }, title, pips, hint), next), prev, next, title, hint, pips, key: '' };
}
function chapterIndex() {
  const list = P && P.chapters || [];
  return list.findIndex(c => c.id === res.cur.chapter);
}
function stepChapter(d) {
  const list = P.chapters || [];
  const i = Math.max(0, chapterIndex());
  const to = list[Math.max(0, Math.min(list.length - 1, i + d))];
  if (to) gotoChapter(to.id);
}
function updateRail() {
  const r = res.rail;
  if (!r || !P) return;
  const list = P.chapters || [];
  const i = chapterIndex();
  const key = list.map(c => c.id + (c.confirm ? '?' : '')).join();
  if (r.key !== key) {
    r.key = key;
    r.pips.replaceChildren(...list.map(c => h('button', { class: 'pip' + (c.confirm ? ' ask' : ''), 'aria-label': c.title, title: c.title, onclick: () => gotoChapter(c.id) }, h('i', {}))));
  }
  [...r.pips.children].forEach((b, n) => b.classList.toggle('on', n === i));
  r.title.textContent = i >= 0 ? `場面 ${i + 1} / ${list.length}　${list[i].title}` : '';
  r.hint.textContent = res.auto ? '自動で進めています。さわると止まります。' : '3Dの上で上下に動かしても進みます。黄色の点は「職人に確認」の場面です。';
  r.prev.disabled = i <= 0;
  r.next.disabled = i < 0 || i >= list.length - 1;
}
function gotoChapter(id) {
  stopAuto();
  if (!res.chapters) { res.pendingGoto = id; return; }
  const c = res.chapters.find(x => x.id === id);
  if (c) res.frame.contentWindow.postMessage({ kit: 'goto', p: c.a + (c.b - c.a) * .5 }, '*');
}
function buildPanel() {
  res.top = h('div', { class: 'card tape' });
  res.ask = h('div', { class: 'card tape askCard' });
  res.autoBox = h('div', { class: 'card' });
  res.out = h('div', { class: 'card' });
  res.panel.replaceChildren(res.top, res.ask, res.autoBox, res.out);
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
  updateRail();
  if (fx && fx.stage === 'fix_check' && fx.check) runFixCheck(fx.check);
}

// 「最後に、あなたの目で」＋「ここは違う」
function renderFix() {
  const fx = P.fix;
  syncCompare(fx);
  const key = fx ? `${fx.stage}:${fx.said}:${fx.shot_stamp || ''}` : (res.fixOpen ? 'open' : 'idle') + P.can_undo + P.person_fixes;
  if (res.fixKey === key) { if (fx && (fx.stage === 'fixing' || fx.stage === 'fix_repair') && res.fixTick) res.fixTick(fx); return; }
  res.fixKey = key;
  res.fixTick = null;
  const c = res.top;
  c.replaceChildren();
  if (!fx && !res.fixOpen) {
    put(c, h('h2', {}, '最後に、あなたの目で確かめてください'),
      h('p', { class: 'small' }, '自動で確かめたのは、見た目と動きだけです。仕事の中身が合っているかは、あなたにしか分かりません。'),
      h('button', { class: 'main big', onclick: () => { res.fixOpen = true; renderFix(); } }, 'ここは違う'),
      P.person_fixes ? h('p', { class: 'small mute', style: 'margin:12px 0 0' }, `あなたが直した回数: ${P.person_fixes}回`) : null,
      P.can_undo ? h('button', { class: 'thin', style: 'margin-top:8px', onclick: async () => { await post('/api/undo', { id: P.id }); toast('1つ前に戻しました'); load(P.id); } }, '1つ前に戻す') : null);
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
    const canSee = fx.img_before && fx.img_after;
    put(c, h('h2', {}, 'こう直す案です'), h('p', { class: 'small' }, fx.summary),
      canSee && !res.showDraft ? res.cmpNote = h('p', { class: 'small cmpNote' }, 'つまみを動かすと、直す前と直したあとを見比べられます。') : null,
      (fx.out_of_scope || []).length ? h('div', { class: 'stop small' }, h('strong', {}, 'これは今回直せません'), fx.out_of_scope.map(o => h('div', {}, `${o.request}: ${o.reason}`))) : null,
      h('div', { class: 'btnrow' },
        h('button', { class: 'main', onclick: async () => { res.showDraft = false; res.fixOpen = false; res.pendingGoto = fx.focus || null; await post('/api/commit', { id: P.id }); toast('当てました。元に戻すこともできます。'); load(P.id); } }, 'これでいい'),
        h('button', { onclick: async () => { res.showDraft = false; res.fixOpen = true; res.againText = fx.said; await post('/api/cancel', { id: P.id }); load(P.id); } }, '違う')),
      h('button', { class: 'thin', style: 'margin-top:10px', onclick: () => { res.showDraft = !res.showDraft; res.fixKey = ''; if (res.showDraft) res.pendingGoto = fx.focus; updateResult(); showFrame(); } }, res.showDraft ? (canSee ? '絵で見比べる' : '今のページに戻して見る') : '直したあとを3Dで動かして見る'),
      (fx.diff || []).length ? h('details', { class: 'fold plain' }, h('summary', {}, '文章で見る'),
        h('ul', { class: 'diff' }, fx.diff.map(d => h('li', {}, h('b', {}, d.label), h('del', {}, d.before), h('ins', {}, d.after))))) : null);
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
// ---- 直す前と直したあとを、3Dと同じ大きさの枠で見比べる ----
function syncCompare(fx) {
  const want = fx && fx.stage === 'proposed' && !res.showDraft && fx.img_before && fx.img_after;
  const key = want ? `${fx.img_before}:${fx.img_after}:${fx.shot_stamp || ''}` : '';
  if (res.cmpKey === key) return;
  if (res.cmp) { res.cmp.close(); res.cmp = null; }
  res.cmpKey = key;
  res.rail.el.hidden = !!want;
  if (want) { stopAuto(); res.cmp = openCompare(shotUrl(fx.img_before, fx.shot_stamp), shotUrl(fx.img_after, fx.shot_stamp)); }
}
function openCompare(beforeUrl, afterUrl) {
  const before = h('img', { src: beforeUrl, alt: '直す前の画面', class: 'cmpImg' });
  const after = h('img', { src: afterUrl, alt: '直したあとの画面', class: 'cmpImg' });
  const line = h('i', { class: 'cmpLine' });
  const marks = h('div', { class: 'cmpMarks' });
  const tagB = h('div', { class: 'cmpTag left' }, '直す前'), tagA = h('div', { class: 'cmpTag right' }, '直したあと');
  const box = h('div', { class: 'cmpBox' }, before, after, marks, line, tagA, tagB);
  const stage = h('div', { class: 'cmpStage' }, box);
  const range = h('input', { type: 'range', min: 0, max: 100, value: 100, class: 'peel', 'aria-label': '線を動かして、直す前（左）と直したあと（右）を見比べる' });
  const toB = h('button', { class: 'cmpBtn', onclick: () => glide(0) }, '直す前');
  const toA = h('button', { class: 'cmpBtn', onclick: () => glide(100) }, '直したあと');
  const bar = h('div', { class: 'cmpBar' }, toB, range, toA);
  res.wrap.append(stage);
  res.wrap.classList.add('cmp');
  res.rail.el.after(bar);
  if (res.wrap.getBoundingClientRect().top < 0) res.wrap.scrollIntoView({ block: 'start' }); // スマホで下にいても、まず絵を見せる
  let anim = 0, closed = false, cur = 0;
  // cur は「直したあと」が見えている割合。線より左が直す前、右が直したあと。つまみは線と同じ位置にある
  const set = v => {
    cur = v;
    range.value = 100 - v;
    after.style.clipPath = `inset(0 0 0 ${100 - v}%)`;
    line.style.left = (100 - v) + '%';
    line.style.opacity = v > 0 && v < 100 ? 1 : 0;
    tagA.style.opacity = v > 8 ? 1 : 0;
    tagB.style.opacity = v < 92 ? 1 : 0;
    toB.classList.toggle('on', v < 50);
    toA.classList.toggle('on', v >= 50);
  };
  function glide(to, ms = 450, then) {
    cancelAnimationFrame(anim);
    if (matchMedia('(prefers-reduced-motion:reduce)').matches) { set(to); if (then) then(); return; }
    const from = cur, t0 = performance.now();
    const step = now => {
      if (closed) return;
      const x = Math.min(1, (now - t0) / ms), e = x < .5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
      set(from + (to - from) * e);
      if (x < 1) anim = requestAnimationFrame(step); else if (then) then();
    };
    anim = requestAnimationFrame(step);
  }
  range.addEventListener('input', () => { cancelAnimationFrame(anim); set(100 - range.value); });
  const fit = () => {
    const nw = before.naturalWidth, nh = before.naturalHeight;
    if (!nw || closed) return;
    if (innerWidth <= 980) res.wrap.style.height = Math.round(Math.min(res.wrap.clientWidth * nh / nw, innerHeight * .66)) + 'px';
    const k = Math.min(stage.clientWidth / nw, stage.clientHeight / nh);
    box.style.width = Math.round(nw * k) + 'px';
    box.style.height = Math.round(nh * k) + 'px';
  };
  const ro = window.ResizeObserver ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(stage);
  set(0);
  let loaded = 0;
  const onload = () => {
    if (++loaded < 2 || closed) return;
    fit();
    const rects = findChanges(before, after);
    marks.replaceChildren(...rects.map((r, i) => {
      const m = h('div', { class: 'cmpMark' }, i === 0 ? h('span', {}, 'ここが変わりました') : null);
      m.style.cssText = `left:${r.x}%;top:${r.y}%;width:${r.w}%;height:${r.h}%`;
      return m;
    }));
    if (res.cmpNote) res.cmpNote.textContent = rects.length ? '黄色の枠が、絵の変わった所です。つまみを動かすと見比べられます。' : '変わった所を枠で示せませんでした。つまみを動かして見比べてください。';
    setTimeout(() => { if (!closed && cur === 0) glide(100, 1500, () => marks.classList.add('on')); else marks.classList.add('on'); }, 700);
  };
  for (const im of [before, after]) { if (im.complete && im.naturalWidth) onload(); else im.addEventListener('load', onload); }
  return { close() {
    closed = true;
    cancelAnimationFrame(anim);
    if (ro) ro.disconnect();
    stage.remove(); bar.remove();
    res.wrap.classList.remove('cmp');
    res.wrap.style.height = '';
  } };
}
// 2枚の絵を小さくして比べ、大きく変わったかたまりを返す（%）。全体が変わっているときは枠を出さない
function findChanges(a, b) {
  const W = 64, H = Math.max(8, Math.round(W * a.naturalHeight / a.naturalWidth));
  const grab = im => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
  let da, db;
  try { da = grab(a); db = grab(b); } catch (e) { return []; }
  const hot = new Uint8Array(W * H);
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    const d = (Math.abs(da[i * 4] - db[i * 4]) + Math.abs(da[i * 4 + 1] - db[i * 4 + 1]) + Math.abs(da[i * 4 + 2] - db[i * 4 + 2])) / 3;
    if (d > 12) { hot[i] = 1; n++; }
  }
  if (!n || n > W * H * .5) return [];
  const seen = new Uint8Array(W * H), blobs = [];
  for (let i = 0; i < W * H; i++) {
    if (!hot[i] || seen[i]) continue;
    const stack = [i];
    seen[i] = 1;
    const o = { n: 0, x0: W, y0: H, x1: 0, y1: 0 };
    while (stack.length) {
      const k = stack.pop(), x = k % W, y = (k - x) / W;
      o.n++; o.x0 = Math.min(o.x0, x); o.x1 = Math.max(o.x1, x); o.y0 = Math.min(o.y0, y); o.y1 = Math.max(o.y1, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, m = ny * W + nx;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && hot[m] && !seen[m]) { seen[m] = 1; stack.push(m); }
      }
    }
    if (o.n >= 4) blobs.push(o);
  }
  // 近いかたまりは、ひとつの枠にまとめる
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < blobs.length && !again; i++) for (let j = i + 1; j < blobs.length; j++) {
      const p = blobs[i], q = blobs[j];
      if (Math.max(p.x0, q.x0) - Math.min(p.x1, q.x1) > 6 || Math.max(p.y0, q.y0) - Math.min(p.y1, q.y1) > 6) continue;
      blobs[i] = { n: p.n + q.n, x0: Math.min(p.x0, q.x0), x1: Math.max(p.x1, q.x1), y0: Math.min(p.y0, q.y0), y1: Math.max(p.y1, q.y1) };
      blobs.splice(j, 1);
      again = true;
      break;
    }
  }
  return blobs.sort((p, q) => q.n - p.n).slice(0, 3).map(o => {
    const x0 = Math.max(0, o.x0 - 1), y0 = Math.max(0, o.y0 - 1), x1 = Math.min(W, o.x1 + 2), y1 = Math.min(H, o.y1 + 2);
    return { x: x0 / W * 100, y: y0 / H * 100, w: (x1 - x0) / W * 100, h: (y1 - y0) / H * 100 };
  });
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
  put(c, h('h2', {}, 'ここは職人に確認', items.length ? h('span', { class: 'count' }, `あと${items.length}つ`) : null));
  if (items.length) put(c, h('p', { class: 'small mute' }, 'お客さんのページにも、確認中と出ています。合っていれば消せます。'));
  res.askRows = [];
  for (const it of items) {
    const row = h('div', { class: 'ask' }, h('button', { class: 'askGo', onclick: () => { gotoChapter(it.id); showFrame(); } }, it.title), h('div', { class: 'q' }, it.confirm),
      h('div', { class: 'btnrow' },
        h('button', { class: 'thin', onclick: async () => { await post('/api/confirm', { id: P.id, chapter: it.id }); load(P.id); } }, '合っている'),
        h('button', { class: 'thin', onclick: () => { gotoChapter(it.id); res.fixOpen = true; res.againText = ''; res.fixKey = ''; renderFix(); scrollTo(0, 0); } }, '直す')));
    res.askRows.push([it.id, row]);
    put(c, row);
  }
  if (unk.length) {
    put(c, h('details', { class: 'fold plain', open: !items.length || unk.length <= 2 }, h('summary', {}, `まだ聞けていないこと ${unk.length}つ`),
      h('ul', { class: 'small', style: 'margin:0;padding-left:20px' }, unk.map(u => h('li', {}, u)))));
  }
  markAsk();
}
function markAsk() {
  for (const [id, row] of res.askRows || []) row.classList.toggle('now', id === res.cur.chapter);
}

// 自動で確かめたこと（正しい・完成とは言わない）
function renderAuto() {
  const j = P.job;
  if (!j) return;
  const key = JSON.stringify([j.log.length, j.remaining.length, j.stage]);
  if (res.autoKey === key) return;
  res.autoKey = key;
  const c = res.autoBox;
  const wasOpen = c.querySelector('details')?.open;
  c.replaceChildren();
  const high = j.remaining.filter(x => x.severity === 'high');
  const low = j.remaining.filter(x => x.severity !== 'high');
  const body = h('div', {});
  put(body, h('p', { class: 'small' }, `見た目と動きを${j.rounds.length}回確かめて、${j.rounds.filter(r => r.fix && r.fix.to_version).length}回直しました。` + (j.reverted ? `直して悪くなった版は${j.reverted}回、前の版へ戻しました。` : '')));
  if (high.length) {
    put(body, h('div', { class: 'stop small' }, h('strong', {}, `直しきれなかった問題が${high.length}つあります`), high.map(x => h('div', { style: 'margin-top:6px' }, x.text))));
  } else {
    put(body, h('p', { class: 'small' }, low.length ? '動かなくなる問題はありません。下の点は直しきれませんでした。' : '見た目と動きに、問題は見つかりませんでした。'));
  }
  put(body, h('p', { class: 'small mute' }, 'これは「仕事の中身が合っている」という意味ではありません。'));
  if (low.length) put(body, h('div', { class: 'small', style: 'margin:6px 0' }, h('strong', {}, `直しきれなかった点 ${low.length}つ`), low.map(x => h('div', { style: 'margin-top:6px' }, x.text))));
  const times = j.rounds.map(r => `${r.round}回目 ${ms((r.machine ? r.machine.ms : 0) + (r.eye ? r.eye.ms || 0 : 0) + (r.fix ? r.fix.ms || 0 : 0))}`).join(' / ');
  put(body, h('details', {}, h('summary', { class: 'small' }, '見つけた問題と、直した所'),
    h('ul', { class: 'log' }, j.log.slice().reverse().map(logItem)),
    h('p', { class: 'small mute' }, `全部で ${min(j.ended - j.started)}。台本 ${ms(j.times.script_ms)}・3D ${ms(j.times.scene_ms)}・${times}`)));
  put(c, h('details', { class: 'fold', open: high.length > 0 || wasOpen }, h('summary', {}, high.length ? `自動で確かめたこと（直しきれなかった問題 ${high.length}つ）` : '自動で確かめたこと'), body));
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
  put(c, h('details', { class: 'fold', id: 'outFold' }, h('summary', {}, '持ち出す（コード・動画・リンク）'),
    h('div', { class: 'btnrow' },
      h('button', { class: 'thin', onclick: copy }, 'コードをコピー'),
      h('button', { class: 'thin', onclick: () => startRecord(msg, 1280, 720) }, '動画を保存（横）'),
      h('button', { class: 'thin', onclick: () => startRecord(msg, 720, 1280) }, '動画を保存（縦）'),
      h('button', { class: 'thin', onclick: link }, 'リンクをもらう')),
    msg));
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
      const [sw, sh] = innerWidth < 700 ? [540, 960] : [960, 540]; // スマホでは縦の絵で見比べる
      images.after = await takeShot(fr, p, sw, sh);
      const before = await checkFrame(chk.before, 1280, 720);
      const old = (before.fr.chapters || []).find(c => c.id === chk.focus);
      images.before = await takeShot(before.fr, old ? old.a + (old.b - old.a) * .55 : p, sw, sh);
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
    const q = new URLSearchParams(location.search), id = q.get('id'), mihon = q.get('mihon');
    screen = '';
    res = {};
    if (mihon) showSample(mihon); else if (id) load(id); else showHome();
  };
  addEventListener('popstate', boot);
  boot();
})();
