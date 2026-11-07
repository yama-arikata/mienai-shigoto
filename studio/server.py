#!/usr/bin/env python3
"""職人が自分で「見えない仕事の3Dページ」を作る道具。Python標準ライブラリだけ。

  python3 server.py            本番（ANTHROPIC_API_KEY が要る）
  python3 server.py --test     試験（Claudeの返事は手書き。データは終わると消える）
  python3 server.py --judge    審査員モード（合言葉と利用上限つき。データは _judge_data に分ける）
                               STUDIO_JUDGE_CODE に合言葉を入れて起動する。公開するホスト名は --judge-host で渡す

長い処理はサーバーの中で進める（画面を閉じても続く）。
ブラウザが要る手順（ページを開いて確かめる）だけ、画面が戻るのを待つ。
"""
import argparse
import base64
import contextlib
import hashlib
import hmac
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import brain
import claude
from guard import guard

HERE = pathlib.Path(__file__).resolve().parent
WEB = HERE / "web"
DATA = HERE / "data"
TEST_DATA = HERE / "_test"
JUDGE_DATA = HERE / "_judge_data"
TEST_JUDGE_DATA = HERE / "_test_judge"
PORT = 8985

# 「確かめて → 直す」を何周まで回すか。直したあとは必ずもう一度確かめるので、
# Claude の目で見る回数は最大 MAX_ROUNDS + 1 回、直す回数は最大 MAX_ROUNDS 回になる。
MAX_ROUNDS = int(os.environ.get("STUDIO_MAX_ROUNDS") or 2)
# 自動で直す回数の上限とは別に、時間の目安を超えたら次の直しに入らない（秒）
TIME_BUDGET = int(os.environ.get("STUDIO_TIME_BUDGET") or 270)

ID_RE = re.compile(r"^[0-9a-f]{8}$")
UI_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src blob:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
PAGE_CSP = ("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/three@" + brain.THREE_VERSION + "/; "
            "style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
STATIC = {"index.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "app.css": "text/css; charset=utf-8"}
# はじめの画面の見本棚から開くもの。公開資料から作った手作りの見本だけ（親父さんの話を元にしたものは入れない）
SAMPLES = ("tsugaru", "sakan", "tsugite", "ringo", "rousui")
SAMPLE_DIR = HERE.parent
SAMPLE_CSP = ("default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/three@" + brain.THREE_VERSION + "/; "
              "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; media-src blob:; "
              "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'")
STAGE_NAMES = {
    "script": "台本を書いています", "scene": "目に見えないを形にしています", "preflight": "言葉と形を確かめています",
    "check": "確かめています", "review": "確かめています", "judge": "確かめています", "fix": "直しています",
    "paused": "止まっています", "done": "できあがり", "failed": "止まりました",
}
STOP_MSG = "この言葉はページに書けません。別の言い方にするか、消してください。"
JUDGE_NO_KEY = "いまClaudeにつながっていないので、新しく作ることができません。"
JUDGE_COOKIE = "studio_judge"
JUDGE_MIN_CODE = 12
JUDGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
JUDGE_PAGE = """<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>ひのめ</title>
<style>body{font-family:"Hiragino Sans","Yu Gothic UI","Noto Sans JP",system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#10233b;color:#f0f1ec}
form{width:min(400px,calc(100vw - 32px));background:#eceae3;color:#17222e;padding:28px 24px;border-top:6px solid #f2c230;box-sizing:border-box;box-shadow:7px 7px 0 #7d5e40,14px 14px 0 #b7986e}
h1{font-family:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif;font-weight:600;letter-spacing:.04em;font-size:25px;margin:0 0 10px}p{margin:0 0 18px;line-height:1.7}
input,button{box-sizing:border-box;width:100%;font:inherit;font-size:17px;padding:14px;border-radius:3px;border:2px solid #a9a698;background:#f8f7f2;color:#17222e}input:focus{outline:3px solid #f2c230;outline-offset:1px}
button{margin-top:12px;background:#f2c230;color:#1a1608;border:2px solid #1a1608;font-weight:800;cursor:pointer}button:focus-visible{outline:3px solid #10233b;outline-offset:2px}
.err{color:#b3321c;font-weight:700}</style></head><body><form method="post" action="/login"><h1>ひのめ</h1>
<p>審査の方へ。提出フォームにある合言葉を入れてください。</p>__ERR__<input name="code" type="password" autocomplete="off" aria-label="合言葉" autofocus required><button>開く</button></form></body></html>"""


def now():
    return time.time()


def safe_note(text, fallback="書けない言葉を含む問題でした"):
    """画面に出す短い文。止める言葉をそのまま出さない。"""
    text = str(text or "").strip()
    if guard(text):
        return fallback
    return text if brain.is_japanese(text) else "日本語にできなかった文です（中身は直す係に渡しています）"


def people_word(err, spec=None):
    """機械の言葉を、職人が読める言葉にする。Claude には元の文を渡す。"""
    text = safe_note(err)
    if text.startswith(("物を作る所でエラー", "場面のコードが動きません")) or re.search(r"[A-Za-z]{4,}Error|行）$", text):
        return "3Dの物を作る所で止まってしまい、ページが動きませんでした。"
    if spec:
        for c in spec.get("chapters", []):
            text = text.replace(f"場面「{c['id']}」", f"場面「{brain.plain(c['title'])}」")
    text = re.sub(r"（明るさ[\d.]+）", "", text)
    text = text.replace("。カメラの向きか大きさ(r)を直す", "").replace("。向き(dir)を変えるか、その物を消す", "")
    return text


class Stop(Exception):
    """これ以上進めない。理由を画面に出す。"""


class CallGate:
    """審査員モードだけ。Claude を呼ぶ回数の合計と、同時に呼ぶ数を止める。回数は再起動しても残す。"""
    USED_UP = "審査用に用意したClaudeの利用回数を使い切りました。ここから先は新しく作れません。できあがっているものは、そのまま見られます。"
    BUSY = "いま別の方が作っていて混んでいます。少し待って、もう一度お願いします。"

    def __init__(self, ask, path, max_calls, max_parallel, wait=120):
        self.ask, self.path, self.max_calls, self.max_parallel, self.wait = ask, pathlib.Path(path), max_calls, max_parallel, wait
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(max_parallel)
        self.active = 0
        self.used = json.loads(self.path.read_text(encoding="utf-8"))["used"] if self.path.is_file() else 0

    def refuse(self):
        """呼ぶ前に分かる理由。止めるなら (コード, 画面の文)。"""
        with self.lock:
            if self.used >= self.max_calls:
                return "used_up", self.USED_UP
            if self.active >= self.max_parallel:
                return "busy", self.BUSY
        return None

    def __call__(self, *args, **kwargs):
        if not self.slots.acquire(timeout=self.wait):
            raise claude.ClaudeError(self.BUSY, "busy")
        try:
            with self.lock:
                if self.used >= self.max_calls:
                    raise claude.ClaudeError(self.USED_UP, "used_up")
                self.used += 1  # 失敗しても料金がかかることがあるので、呼ぶ前に数える
                self.active += 1
                tmp = self.path.with_name(self.path.name + ".tmp")
                tmp.write_text(json.dumps({"used": self.used}), encoding="utf-8")
                tmp.replace(self.path)
            try:
                return self.ask(*args, **kwargs)
            finally:
                with self.lock:
                    self.active -= 1
        finally:
            self.slots.release()


class Judge:
    """審査員モードの入口。合言葉はここにだけ持ち、書き出さない。"""

    def __init__(self, code, hosts, gate):
        self.code = code.encode("utf-8")
        self.hosts = set(hosts)
        self.gate = gate
        self.session = hmac.new(self.code, b"studio-judge-session", hashlib.sha256).hexdigest()
        self.tries = threading.Lock()

    def code_ok(self, text):
        with self.tries:  # 外れたら待たせて、総当たりを遅くする
            ok = secrets.compare_digest(text.encode("utf-8"), self.code)
            if not ok:
                time.sleep(1)
        return ok

    def has_session(self, cookie_header):
        for part in (cookie_header or "").split(";"):
            name, _, value = part.strip().partition("=")
            if name == JUDGE_COOKIE and secrets.compare_digest(value.encode("utf-8"), self.session.encode("utf-8")):
                return True
        return False


class Store:
    def __init__(self, root, test):
        self.root = pathlib.Path(root)
        self.test = test
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks = {}
        self._lock = threading.Lock()

    def lock(self, pid):
        with self._lock:
            return self._locks.setdefault(pid, threading.RLock())

    def dir(self, pid):
        return self.root / pid

    def exists(self, pid):
        return bool(ID_RE.match(pid or "")) and (self.dir(pid) / "project.json").is_file()

    def load(self, pid):
        return json.loads((self.dir(pid) / "project.json").read_text(encoding="utf-8"))

    def _write(self, path, obj):
        tmp = path.with_name(path.name + f".{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
        tmp.replace(path)

    def save(self, project):
        project["updated"] = now()
        self._write(self.dir(project["id"]) / "project.json", project)

    @contextlib.contextmanager
    def edit(self, pid):
        with self.lock(pid):
            p = self.load(pid)
            yield p
            self.save(p)

    def create(self, intake):
        pid = secrets.token_hex(4)
        d = self.dir(pid)
        (d / "versions").mkdir(parents=True)
        (d / "shots").mkdir()
        p = {"id": pid, "created": now(), "updated": now(), "test": self.test, "stage": "interview", "intake": intake, "qa": [], "said": [],
             "pending": None, "asking": False, "ask_error": None, "current": None, "history": [], "versions": [], "person_fixes": 0, "job": None, "fix": None}
        self.save(p)
        return p

    def put_json(self, pid, name, obj):
        self._write(self.dir(pid) / name, obj)

    def get_json(self, pid, name):
        path = self.dir(pid) / name
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None

    def save_version(self, pid, spec, note, by):
        with self.edit(pid) as p:
            n = (p["versions"][-1]["n"] + 1) if p["versions"] else 1
            self._write(self.dir(pid) / "versions" / f"{n}.json", spec)
            p["versions"].append({"n": n, "note": note, "by": by, "at": now()})
        return n

    def spec(self, pid, n):
        path = self.dir(pid) / "versions" / f"{n}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None

    def memo(self, pid, kind, text, **more):
        with open(self.dir(pid) / "memo.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"at": now(), "kind": kind, "text": text, **more}, ensure_ascii=False) + "\n")

    def put_shot(self, pid, name, data):
        raw = base64.b64decode(data, validate=True)
        if raw[:2] != b"\xff\xd8" or len(raw) > 3_000_000:
            raise ValueError("bad image")
        (self.dir(pid) / "shots" / name).write_bytes(raw)

    def shot_path(self, pid, name):
        if not re.fullmatch(r"[a-z0-9_]{1,24}\.jpg", name or ""):
            return None
        path = self.dir(pid) / "shots" / name
        return path if path.is_file() else None

    def all(self):
        out = []
        for d in self.root.iterdir():
            if d.is_dir() and self.exists(d.name):
                try:
                    out.append(self.load(d.name))
                except ValueError:
                    pass
        return sorted(out, key=lambda p: -p.get("updated", 0))


class Live:
    """Claude が書いている途中の様子。ファイルに残さない。"""

    def __init__(self):
        self.text = ""
        self.since = now()

    def feed(self, piece, reset):
        self.text = "" if reset else self.text + piece

    def view(self):
        titles = [re.sub(r"<[^>]+>", "", t.replace("\\n", " ")) for t in re.findall(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"', self.text)]
        return {"chars": len(self.text), "lines": self.text.count("\\n"), "titles": titles[-12:], "since": self.since}


class Engine:
    RUN = ("script", "scene", "preflight", "review", "judge", "fix")
    FIX_RUN = ("fixing", "fix_repair")

    def __init__(self, store, ask, publisher, max_rounds=MAX_ROUNDS):
        self.store, self.ask, self.publisher, self.max_rounds = store, ask, publisher, max_rounds
        self.lock = threading.Lock()
        self.running, self.again = set(), set()
        self.live = {}

    # ---------- 動かす ----------
    def kick(self, pid):
        with self.lock:
            if pid in self.running:
                self.again.add(pid)
                return
            self.running.add(pid)
        threading.Thread(target=self._run, args=(pid,), daemon=True).start()

    def _run(self, pid):
        try:
            while True:
                self._advance(pid)
                with self.lock:
                    if pid in self.again:
                        self.again.discard(pid)
                        continue
                    self.running.discard(pid)
                    return
        except Exception:
            with self.lock:
                self.running.discard(pid)
            traceback.print_exc()

    def _advance(self, pid):
        while True:
            p = self.store.load(pid)
            job, fx = p.get("job"), p.get("fix")
            if fx and fx.get("stage") in self.FIX_RUN:
                self._guarded(pid, getattr(self, "step_" + fx["stage"]), "fix")
                continue
            if job and job.get("stage") in self.RUN:
                self._guarded(pid, getattr(self, "step_" + job["stage"]), "job")
                continue
            return

    def _guarded(self, pid, step, which):
        try:
            step(pid)
        except claude.ClaudeError as exc:
            self._halt(pid, which, str(exc), getattr(exc, "code", "claude_error"), resumable=True)
        except Stop as exc:
            self._halt(pid, which, str(exc), "stopped", resumable=False)
        except Exception as exc:  # 中身を画面に出さない。コンソールにだけ型と場所を出す
            traceback.print_exc()
            self._halt(pid, which, f"途中でエラーになりました（{type(exc).__name__}）。", "internal", resumable=True)

    def _halt(self, pid, which, message, code, resumable):
        with self.store.edit(pid) as p:
            if which == "fix":
                p["fix"].update({"resume": p["fix"]["stage"] if resumable else None, "stage": "fix_failed", "error": message, "code": code})
            else:
                j = p["job"]
                j.update({"resume": j["stage"] if resumable else None, "stage": "paused" if resumable else "failed", "error": message, "code": code})
                if not resumable:
                    p["stage"] = "failed"
        self.live.pop(pid, None)

    def set_stage(self, p, stage):
        p["job"]["stage"] = stage
        p["job"]["stage_started"] = now()

    def log(self, p, kind, text, **more):
        p["job"]["log"].append({"at": now(), "kind": kind, "text": str(text)[:300], **more})

    def _live(self, pid):
        lv = Live()
        self.live[pid] = lv
        return lv

    # ---------- 聞き取り ----------
    def ask_next(self, pid):
        def work():
            try:
                p = self.store.load(pid)
                if len(p["qa"]) >= brain.MAX_QUESTIONS:
                    q = {"done": True}
                else:
                    q = brain.next_question(self.ask, p)
                with self.store.edit(pid) as p:
                    p["asking"], p["ask_error"] = False, None
                    if q.get("done"):
                        p["pending"], p["stage"] = None, "review"
                    else:
                        p["pending"] = {"axis": q["axis"], "axis_name": q["axis_name"], "q": q["question"]}
            except (claude.ClaudeError, brain.SpecError) as exc:
                with self.store.edit(pid) as p:
                    p["asking"], p["ask_error"] = False, str(exc)
            except Exception as exc:
                traceback.print_exc()
                with self.store.edit(pid) as p:
                    p["asking"], p["ask_error"] = False, f"質問を作れませんでした（{type(exc).__name__}）。"
        with self.store.edit(pid) as p:
            p["asking"], p["ask_error"] = True, None
        threading.Thread(target=work, daemon=True).start()

    # ---------- 作る → 確かめる → 直す ----------
    def start_build(self, pid):
        with self.store.edit(pid) as p:
            t = now()
            p["stage"] = "building"
            p["current"], p["history"], p["person_fixes"], p["fix"] = None, [], 0, None
            p["job"] = {"kind": "build", "stage": "script", "stage_started": t, "started": t, "ended": None, "round": 0, "fixes": 0,
                        "max_rounds": self.max_rounds, "log": [], "rounds": [], "best": None, "remaining": [], "passed": False, "check": None,
                        "times": {}, "problems": None, "version": None, "reverted": 0, "error": None, "resume": None, "model": None}
        self.kick(pid)

    def resume(self, pid):
        with self.store.edit(pid) as p:
            fx, j = p.get("fix"), p.get("job")
            if fx and fx.get("resume"):
                fx.update({"stage": fx["resume"], "resume": None, "error": None})
            elif j and j.get("resume"):
                self.set_stage(p, j["resume"])
                j.update({"resume": None, "error": None})
            else:
                return False
        self.kick(pid)
        return True

    def step_script(self, pid):
        p = self.store.load(pid)
        t0 = now()
        lv = self._live(pid)
        raw, model = brain.write_script(self.ask, p, on_text=lv.feed)
        raw = brain.tidy_script(raw, p)
        errs = brain.check_script(raw)
        if errs:
            with self.store.edit(pid) as q:
                self.log(q, "found", "台本に直す所がありました。書き直しています。")
            self.store.memo(pid, "script_flagged", json.dumps(errs, ensure_ascii=False))
            lv = self._live(pid)
            raw, model = brain.write_script(self.ask, p, on_text=lv.feed, note="前の台本には次の問題がありました。主張ごと消すか、形を直してください。同じ意味の言い換えはしません: " + " / ".join(errs))
            raw = brain.tidy_script(raw, p)
            errs = brain.check_script(raw)
            if errs:
                self.store.memo(pid, "script_stopped", json.dumps(errs, ensure_ascii=False))
                raise Stop("台本に書けない言葉や形の問題が残ったので、ここで止めました。ページは作っていません。答えの言葉を見直して、もう一度お願いします。")
        self.store.put_json(pid, "script.json", raw)
        with self.store.edit(pid) as q:
            j = q["job"]
            j["times"]["script_ms"] = int((now() - t0) * 1000)
            j["model"] = model
            q["title"] = raw["page_title"]
            self.log(q, "info", f"台本ができました（場面{len(raw['chapters'])}つ）。")
            self.set_stage(q, "scene")

    def step_scene(self, pid):
        p = self.store.load(pid)
        t0 = now()
        script = self.store.get_json(pid, "script.json")
        lv = self._live(pid)
        raw, model = brain.write_scene(self.ask, p, script, on_text=lv.feed)
        spec = brain.merge_spec(script, raw)
        brain.fact_check(spec, brain.corpus(p))
        n = self.store.save_version(pid, spec, "最初の版", "auto")
        with self.store.edit(pid) as q:
            j = q["job"]
            j["times"]["scene_ms"] = int((now() - t0) * 1000)
            j["version"] = n
            self.log(q, "info", "3Dの物を作りました。")
            self._new_round(q, n)
            self.set_stage(q, "preflight")
        self.live.pop(pid, None)

    def _new_round(self, p, version):
        j = p["job"]
        j["round"] += 1
        j["rounds"].append({"round": j["round"], "version": version, "started": now(), "machine": None, "eye": None, "fix": None, "images": [], "verdict": None})

    def step_preflight(self, pid):
        p = self.store.load(pid)
        j = p["job"]
        spec = self.store.spec(pid, j["version"])
        errors = brain.check_all(spec) + brain.guard_lines(spec)
        with self.store.edit(pid) as q:
            jq = q["job"]
            r = jq["rounds"][-1]
            if errors:
                r["machine"] = {"ok": False, "errors": errors, "warnings": [], "stats": {}, "hard": True, "ms": 0}
                self.set_stage(q, "judge")
            else:
                pts = brain.review_points(spec)
                jq["check"] = {"nonce": secrets.token_hex(8), "kind": "build", "round": jq["round"], "version": jq["version"],
                               "url": f"/p/{pid}/v/{jq['version']}", "points": pts, "issued": now()}
                self.set_stage(q, "check")

    def report(self, pid, data):
        """ブラウザで確かめた結果を受け取る。"""
        with self.store.edit(pid) as p:
            fx = p.get("fix")
            if fx and fx.get("stage") == "fix_check":
                res = self._report_fix(p, data)
                fix_report = True
            else:
                fix_report = False
        if fix_report:
            self.kick(pid)  # 保存が終わってから動かす
            return res
        with self.store.edit(pid) as p:
            j = p.get("job")
            if not j or j.get("stage") != "check" or not j.get("check") or data.get("nonce") != j["check"]["nonce"]:
                return {"ok": False, "stale": True}
            chk = data.get("check") if isinstance(data.get("check"), dict) else {}
            errors = [str(e)[:300] for e in (chk.get("errors") or [])][:40]
            ok = bool(chk.get("ok")) and not errors
            r = j["rounds"][-1]
            r["machine"] = {"ok": ok, "errors": errors, "warnings": [str(e)[:200] for e in (chk.get("warnings") or [])][:20], "stats": chk.get("stats") if isinstance(chk.get("stats"), dict) else {},
                            "hard": bool(chk.get("broken") or chk.get("syntax") or chk.get("timeout") or not chk.get("ran", True)),
                            "ms": int((now() - j["check"]["issued"]) * 1000), "lines": [x for x in (chk.get("lines") or []) if isinstance(x, int)][:20]}
            images = []
            # 名札の問題だけなら絵は撮れている。Claudeの目にも見せて、1回の直しでまとめて直す
            soft = bool(errors) and not r["machine"]["hard"] and all("名札" in e for e in errors)
            r["machine"]["soft"] = soft
            if ok or soft:
                for i, im in enumerate((data.get("images") or [])[:12]):
                    name = f"r{j['round']}_{i}.jpg"
                    try:
                        self.store.put_shot(pid, name, im.get("data") or "")
                    except (ValueError, TypeError, AttributeError):
                        continue
                    images.append({"name": name, "chapter": str(im.get("chapter") or ""), "view": str(im.get("view") or ""), "p": im.get("p")})
                r["images"] = images
                if not images:
                    r["machine"].update({"ok": False, "soft": False, "errors": (errors if soft else []) + ["確かめる画像を撮れませんでした"], "hard": False})
            spec_now = self.store.spec(pid, r["version"])
            for e in r["machine"]["errors"][:6]:
                self.log(p, "found", people_word(e, spec_now), source="機械")
            j["check"] = None
            self.set_stage(p, "review" if r["machine"]["ok"] or r["machine"].get("soft") else "judge")
        self.kick(pid)
        return {"ok": True}

    def step_review(self, pid):
        p = self.store.load(pid)
        j = p["job"]
        r = j["rounds"][-1]
        spec = self.store.spec(pid, j["version"])
        t0 = now()
        imgs = []
        for im in r["images"]:
            raw = (self.store.dir(pid) / "shots" / im["name"]).read_bytes()
            imgs.append({"data": base64.b64encode(raw).decode("ascii"), "chapter": im["chapter"], "view": im["view"]})
        lv = self._live(pid)
        res = brain.ask_review(self.ask, imgs, spec, j["round"], work=p["intake"].get("work") or "", on_text=lv.feed)
        with self.store.edit(pid) as q:
            jq = q["job"]
            rq = jq["rounds"][-1]
            rq["eye"] = {"passed": res["passed"], "reason": safe_note(res["reason"], "（理由の文に書けない言葉が入っていました）"), "issues": res["issues"], "ms": int((now() - t0) * 1000), "model": res["model"]}
            for it in res["issues"]:
                self.log(q, "found", safe_note(it["seen"]), source="Claudeの目", severity=it["severity"], image=rq["images"][it["image"] - 1]["name"])
            self.set_stage(q, "judge")
        self.live.pop(pid, None)

    def problems_of(self, pid, r):
        """その版に残っている問題。画面にも、直す係にも渡す。"""
        out = []
        spec = self.store.spec(pid, r["version"])
        for e in (r["machine"] or {}).get("errors") or []:
            out.append({"kind": "machine", "text": people_word(e, spec), "raw": e, "severity": "high"})
        eye = r.get("eye") or {}
        for it in eye.get("issues") or []:
            out.append({"kind": "eye", "text": safe_note(it["seen"]), "raw": it.get("raw_seen") or it["seen"], "how_to_fix": it.get("raw_fix") or it.get("how_to_fix") or "", "item": it.get("item_name"), "chapter": it.get("chapter"),
                        "severity": it["severity"], "image": r["images"][it["image"] - 1]["name"] if it["image"] <= len(r["images"]) else None})
        return out

    def step_judge(self, pid):
        finish = False
        with self.store.edit(pid) as p:
            j = p["job"]
            r = j["rounds"][-1]
            m, eye = r["machine"], r.get("eye") or {}
            high = sum(1 for i in eye.get("issues", []) if i["severity"] == "high")
            low = sum(1 for i in eye.get("issues", []) if i["severity"] != "high")
            score = [1 if m.get("hard") else 0, len(m["errors"]), high, low]
            passed = bool(m["ok"] and eye.get("passed"))
            r["score"] = score
            r["verdict"] = "pass" if passed else "fail"
            best = j["best"]
            if passed or best is None or score <= best["score"]:
                j["best"] = {"version": r["version"], "round": r["round"], "score": score, "problems": self.problems_of(pid, r), "passed": passed, "lines": m.get("lines") or []}
            else:
                j["reverted"] += 1
                r["reverted_to"] = best["version"]
                self.log(p, "reverted", f"直したら前より悪くなったので、前の版（{best['version']}）に戻しました。")
                self.store.memo(pid, "reverted", f"v{r['version']} → v{best['version']}", score=score, best=best["score"])
            if passed:
                self.log(p, "passed", f"{r['round']}回目の確かめで、見た目と動きに問題は見つかりませんでした。")
                finish = True
            elif j["fixes"] >= self.max_rounds:
                finish = True
            elif j["fixes"] and now() - j["started"] > TIME_BUDGET:
                self.log(p, "left", "時間の目安を超えたので、ここで直すのをやめました。")
                finish = True
            else:
                self.set_stage(p, "fix")
        if finish:
            self.finish(pid)

    def finish(self, pid):
        with self.store.edit(pid) as p:
            j = p["job"]
            best = j["best"]
            j["ended"] = now()
            j["check"] = None
            j["remaining"] = best["problems"] if best else []
            j["passed"] = bool(best and best["passed"])
            if not best or best["score"][0]:
                self.set_stage(p, "failed")
                p["stage"] = "failed"
                j["error"] = "動くページになりませんでした。直しても動かなかったので、ここで止めました。"
                return
            p["current"] = best["version"]
            p["history"] = [best["version"]]
            p["stage"] = "ready"
            self.set_stage(p, "done")
            left = len(j["remaining"])
            if left:
                self.log(p, "left", f"直しきれなかった問題が{left}つ残っています。")

    def step_fix(self, pid):
        p = self.store.load(pid)
        j = p["job"]
        best = j["best"]
        spec = self.store.spec(pid, best["version"])
        t0 = now()
        problems = [{k: x.get(k) for k in ("kind", "raw", "how_to_fix", "item", "chapter", "severity") if x.get(k)} for x in best["problems"]]
        if j.get("problems"):
            problems += [{"kind": "note", "raw": t, "severity": "high"} for t in j["problems"]]
        last = j["rounds"][-1]
        if last["version"] != best["version"]:
            problems.append({"kind": "note", "severity": "high", "raw": "前の直しを当てたら悪くなったので、当てる前に戻しました。悪くなったときの問題: " + " / ".join(str(e)[:160] for e in last["machine"]["errors"][:6])})
        _, start = brain.build_html(spec, test=self.store.test)
        lines = brain.lines_of(spec, start, best.get("lines"))
        # 直す係にも、問題が見つかった画面を見せる（最大4枚）
        images = []
        seen_names = []
        for x in best["problems"]:
            name = x.get("image")
            if name and name not in seen_names and len(seen_names) < 4:
                seen_names.append(name)
        for rnd in j["rounds"]:
            for im in rnd.get("images") or []:
                if im["name"] in seen_names:
                    try:
                        images.append({"data": base64.b64encode((self.store.dir(pid) / "shots" / im["name"]).read_bytes()).decode("ascii"), "chapter": im["chapter"], "view": im["view"]})
                    except OSError:
                        pass
        lv = self._live(pid)
        raw, _ = brain.ask_repair(self.ask, spec, problems, code_lines=lines, on_text=lv.feed, work=p["intake"].get("work") or "", images=images)
        new, errs = brain.apply_repair(spec, raw)
        brain.fact_check(new, brain.corpus(p))
        ms = int((now() - t0) * 1000)
        changed = new != spec
        n = self.store.save_version(pid, new, "自動で直した版", "auto") if changed else None
        finish = False
        with self.store.edit(pid) as q:
            jq = q["job"]
            jq["fixes"] += 1
            rq = jq["rounds"][-1]
            fixed = [safe_note(t, "書けない言葉を消しました") for t in (raw or {}).get("fixed") or []][:8]
            rq["fix"] = {"ms": ms, "fixed": fixed if changed else [], "errors": errs[:6], "to_version": n}
            jq["problems"] = None
            if changed:
                for t in fixed or ["直しました"]:
                    self.log(q, "fixed", t)
                jq["version"] = n
                self._new_round(q, n)
                self.set_stage(q, "preflight")
            else:
                self.log(q, "left", "直す案を当てられませんでした。")
                if errs and jq["fixes"] < self.max_rounds:
                    jq["problems"] = ["前の直し案は当てられませんでした: " + " / ".join(errs)[:400]]
                else:
                    finish = True
        self.live.pop(pid, None)
        if finish:
            self.finish(pid)

    # ---------- 「ここは違う」 ----------
    def start_fix(self, pid, said, ctx):
        with self.store.edit(pid) as p:
            p["fix"] = {"stage": "fixing", "said": said, "ctx": ctx, "started": now(), "tries": 0, "note": "", "summary": "", "diff": [], "out_of_scope": [], "focus": "", "error": None, "resume": None, "check": None}
        self.kick(pid)

    def _said_project(self, p, said):
        q = dict(p)
        q["said"] = list(p.get("said", [])) + [said]
        return q

    def _after_change(self, pid, new, diff, summary, focus, out, base_tries):
        """下書きができたあとの共通の検査。"""
        problems = brain.check_all(new) + brain.guard_lines(new)
        with self.store.edit(pid) as p:
            fx = p["fix"]
            fx.update({"summary": safe_note(summary, "直す案を作りました。"), "diff": diff, "focus": focus, "out_of_scope": out})
            if problems:
                if fx["tries"] == 0:
                    fx["tries"] = 1
                    fx["note"] = "前の案には次の問題がありました。直してください: " + " / ".join(problems)[:800]
                    fx["stage"] = "fixing"
                    return
                self.store.memo(pid, "fix_stopped", fx["said"], problems=problems)
                fx.update({"stage": "fix_failed", "error": "直す案に問題が残ったので、当てていません。ページは元のままです。", "problems": [safe_note(x) for x in problems[:6]]})
                return
            self.store.put_json(pid, "draft.json", new)
            fx["stage"] = "fix_check"
            fx["check"] = {"nonce": secrets.token_hex(8), "kind": "fix", "url": f"/p/{pid}/draft", "before": f"/p/{pid}", "focus": focus, "issued": now()}

    def step_fixing(self, pid):
        p = self.store.load(pid)
        fx = p["fix"]
        spec = self.store.spec(pid, p["current"])
        lv = self._live(pid)
        raw, _ = brain.ask_fix(self.ask, spec, fx["said"], fx.get("ctx") or {}, on_text=lv.feed, note=fx.get("note") or "")
        self.live.pop(pid, None)
        out = [{"request": safe_note(o.get("request")), "reason": safe_note(o.get("reason"))} for o in (raw.get("out_of_scope") or [])][:6]
        new, diff, errors = brain.apply_fix(spec, raw.get("changes"))
        if errors:
            with self.store.edit(pid) as q:
                f = q["fix"]
                if f["tries"] == 0:
                    f["tries"] = 1
                    f["note"] = "前の案は当てられませんでした: " + " / ".join(errors)[:600]
                    return
                f.update({"stage": "fix_failed", "error": "直す案を当てられませんでした。ページは元のままです。", "problems": [safe_note(x) for x in errors[:6]]})
                return
        if not diff:
            with self.store.edit(pid) as q:
                q["fix"].update({"stage": "declined", "summary": safe_note(raw.get("summary") or ""), "out_of_scope": out})
            self.store.memo(pid, "fix_declined", fx["said"])
            return
        brain.fact_check(new, brain.corpus(self._said_project(p, fx["said"])))
        focus = raw.get("focus_chapter") if brain.chapter_of(new, raw.get("focus_chapter")) else new["chapters"][0]["id"]
        self._after_change(pid, new, diff, raw.get("summary") or "", focus, out, fx["tries"])

    def step_fix_repair(self, pid):
        p = self.store.load(pid)
        fx = p["fix"]
        draft = self.store.get_json(pid, "draft.json")
        _, start = brain.build_html(draft, test=self.store.test)
        lv = self._live(pid)
        raw, _ = brain.ask_repair(self.ask, draft, [{"kind": "machine", "raw": e, "severity": "high"} for e in fx.get("problems") or []], code_lines=brain.lines_of(draft, start, fx.get("lines")), on_text=lv.feed, work=p["intake"].get("work") or "")
        self.live.pop(pid, None)
        new, _errs = brain.apply_repair(draft, raw)
        if new == draft:
            with self.store.edit(pid) as q:
                q["fix"].update({"stage": "fix_failed", "error": "直してみましたが動かないままでした。ページは元のままです。"})
                with contextlib.suppress(FileNotFoundError):
                    (self.store.dir(pid) / "draft.json").unlink()
            return
        brain.fact_check(new, brain.corpus(self._said_project(p, fx["said"])))
        self._after_change(pid, new, fx["diff"], fx["summary"], fx["focus"], fx["out_of_scope"], fx["tries"])

    def _report_fix(self, p, data):
        pid = p["id"]
        fx = p["fix"]
        if not fx.get("check") or data.get("nonce") != fx["check"]["nonce"]:
            return {"ok": False, "stale": True}
        chk = data.get("check") if isinstance(data.get("check"), dict) else {}
        errors = [str(e)[:300] for e in (chk.get("errors") or [])][:20]
        fx["check"] = None
        if chk.get("ok") and not errors:
            for name in ("before", "after"):
                im = (data.get("images") or {}).get(name) if isinstance(data.get("images"), dict) else None
                try:
                    self.store.put_shot(pid, f"fix_{name}.jpg", im or "")
                    fx[f"img_{name}"] = f"fix_{name}.jpg"
                except (ValueError, TypeError):
                    fx[f"img_{name}"] = None
            fx["stage"] = "proposed"
            fx["shot_stamp"] = secrets.token_hex(3)
            return {"ok": True}
        if fx["tries"] == 0:
            fx["tries"] = 1
            fx["problems"] = errors
            fx["lines"] = [x for x in (chk.get("lines") or []) if isinstance(x, int)][:20]
            fx["stage"] = "fix_repair"
            return {"ok": True}
        fx.update({"stage": "fix_failed", "error": "直してみましたが、3Dが動かなくなったので当てていません。ページは元のままです。", "problems": [safe_note(e) for e in errors[:6]]})
        with contextlib.suppress(FileNotFoundError):
            (self.store.dir(pid) / "draft.json").unlink()
        return {"ok": True}

    def commit(self, pid):
        with self.store.lock(pid):
            p = self.store.load(pid)
            fx = p.get("fix")
            draft = self.store.get_json(pid, "draft.json")
            if not fx or fx.get("stage") != "proposed" or not draft:
                return False
            n = self.store.save_version(pid, draft, fx["said"], "person")
            with self.store.edit(pid) as q:
                q["current"] = n
                q["history"].append(n)
                q["said"].append(fx["said"])
                q["person_fixes"] += 1
                q["fix"] = None
            with contextlib.suppress(FileNotFoundError):
                (self.store.dir(pid) / "draft.json").unlink()
            self.store.memo(pid, "fix_commit", fx["said"], version=n)
            return True

    def cancel(self, pid):
        with self.store.edit(pid) as p:
            fx = p.get("fix")
            if fx:
                self.store.memo(pid, "fix_cancel", fx["said"])
            p["fix"] = None
        with contextlib.suppress(FileNotFoundError):
            (self.store.dir(pid) / "draft.json").unlink()
        return True

    def undo(self, pid):
        with self.store.edit(pid) as p:
            if len(p["history"]) < 2:
                return False
            p["history"].pop()
            p["current"] = p["history"][-1]
            p["person_fixes"] = max(0, p["person_fixes"] - 1)
        self.store.memo(pid, "undo", "")
        return True

    def confirm(self, pid, chapter):
        with self.store.lock(pid):
            p = self.store.load(pid)
            spec = self.store.spec(pid, p["current"])
            c = brain.chapter_of(spec, chapter)
            if not c or not c.get("confirm"):
                return False
            c["confirm"] = ""
            c["checked"] = True
            n = self.store.save_version(pid, spec, "本人が「合っている」と確かめた", "person")
            with self.store.edit(pid) as q:
                q["current"] = n
                q["history"].append(n)
        return True

    # ---------- 画面へ ----------
    def job_view(self, p):
        j = p.get("job")
        pid = p["id"]
        if not j:
            return None
        v = {k: j.get(k) for k in ("kind", "stage", "round", "fixes", "max_rounds", "log", "started", "ended", "stage_started", "remaining", "passed", "error", "code", "check", "times", "reverted", "model")}
        v["resumable"] = bool(j.get("resume"))
        v["stage_name"] = STAGE_NAMES.get(j["stage"], j["stage"])
        v["now"] = now()
        v["rounds"] = [{k: r.get(k) for k in ("round", "version", "started", "verdict", "reverted_to", "images", "score")} | {
            "machine": {k: (r.get("machine") or {}).get(k) for k in ("ok", "errors", "warnings", "stats", "ms", "hard")} if r.get("machine") else None,
            "eye": {k: (r.get("eye") or {}).get(k) for k in ("passed", "reason", "ms", "issues")} if r.get("eye") else None,
            "fix": r.get("fix"),
        } for r in j["rounds"]]
        lv = self.live.get(pid)
        v["live"] = lv.view() if lv else None
        v["alive"] = pid in self.running
        script = self.store.get_json(pid, "script.json")  # 実際に書かれた行だけを、途中の画面の札に出す
        v["titles"] = [brain.plain(c.get("title") or "") for c in (script or {}).get("chapters", [])]
        return v

    def fix_view(self, p):
        fx = p.get("fix")
        if not fx:
            return None
        v = {k: fx.get(k) for k in ("stage", "said", "summary", "diff", "out_of_scope", "focus", "error", "code", "problems", "check", "img_before", "img_after", "shot_stamp", "started")}
        v["resumable"] = bool(fx.get("resume"))
        v["now"] = now()
        lv = self.live.get(p["id"])
        v["live"] = lv.view() if lv else None
        return v

    def project_view(self, p):
        spec = self.store.spec(p["id"], p["current"]) if p.get("current") else None
        view = {
            "id": p["id"], "test": p["test"], "stage": p["stage"], "intake": p["intake"], "title": p.get("title") or "",
            "qa": [{"axis": q["axis"], "axis_name": brain.AXES.get(q["axis"], ""), "q": q["q"], "a": q.get("a") or "", "skipped": bool(q.get("skipped"))} for q in p["qa"]],
            "pending": p.get("pending"), "asking": p.get("asking"), "ask_error": p.get("ask_error"),
            "current": p.get("current"), "can_undo": len(p.get("history", [])) > 1, "person_fixes": p.get("person_fixes", 0),
            "job": self.job_view(p), "fix": self.fix_view(p), "max_questions": brain.MAX_QUESTIONS,
        }
        if spec:
            view["chapters"] = [{"id": c["id"], "title": brain.plain(c["title"]), "body": brain.plain(c["body"]), "confirm": c.get("confirm") or ""} for c in spec["chapters"]]
            view["unknowns"] = spec.get("unknowns") or []
        return view


class LocalPublisher:
    """今日はこのパソコンの中だけ。外へ出すときは、この形の別の Publisher に差し替える。"""
    note = "このパソコンの中だけで開けるリンクです。外の人には見えません。外へ公開する先は、まだ決まっていません。"

    def link(self, pid, base):
        return {"url": f"{base}/p/{pid}", "note": self.note, "public": False}


class JudgePublisher:
    note = "合言葉を知っている人だけが開けるリンクです。"

    def link(self, pid, base):
        return {"url": f"{base}/p/{pid}", "note": self.note, "public": False}


class Handler(BaseHTTPRequestHandler):
    judge = None
    store = None
    engine = None
    test_answers = None
    protocol_version = "HTTP/1.1"
    server_version = "studio"

    def log_message(self, fmt, *args):  # 本文もヘッダも書かない
        path = self.path.split("?")[0]
        if not path.startswith("/api/project"):
            print(f"{self.command} {path} {args[1] if len(args) > 1 else ''}", flush=True)

    def _send(self, code, data, ctype="application/json; charset=utf-8", csp=None):
        if not isinstance(data, (bytes, bytearray)):
            data = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if getattr(self, "_noindex", False):
            self.send_header("X-Robots-Tag", "noindex")
        if csp:
            self.send_header("Content-Security-Policy", csp)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _same_site(self):
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origins = {f"http://{h}" for h in allowed}
        if self.judge:
            allowed |= self.judge.hosts
            origins |= {f"https://{h}" for h in self.judge.hosts}
        if self.headers.get("Host") not in allowed:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in origins

    def _judge_page(self, code=401, err=""):
        html = JUDGE_PAGE.replace("__ERR__", f'<p class="err">{err}</p>' if err else "").encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")  # no-referrer だとフォームの Origin が null になる
        self.send_header("X-Robots-Tag", "noindex")
        self.send_header("Content-Security-Policy", JUDGE_CSP)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(html)

    def _judge_gate(self):
        """合言葉がまだなら入口を返して True。API は 401 だけ返す。"""
        if not self.judge or self.judge.has_session(self.headers.get("Cookie")):
            return False
        self.close_connection = True  # 読まなかった本文を次の要求と混ぜない
        if self.path.startswith("/api/"):
            self._send(401, {"error": "need_code", "message": "合言葉を入れてください。"})
        else:
            self._judge_page()
        return True

    def _judge_login(self):
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = -1
        if not 0 <= size <= 2000:
            self.close_connection = True
            return self._send(413, {"error": "too_large"})
        from urllib.parse import parse_qs
        text = parse_qs(self.rfile.read(size).decode("utf-8", "replace")).get("code", [""])[0]
        if not self.judge.code_ok(text):
            return self._judge_page(401, "合言葉が違います。")
        secure = "; Secure" if self.headers.get("Host") in self.judge.hosts else ""
        self.send_response(303)
        self.send_header("Location", "/")
        self.send_header("Set-Cookie", f"{JUDGE_COOKIE}={self.judge.session}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax{secure}")
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _query(self):
        from urllib.parse import parse_qs, urlsplit
        return {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}

    def _shared(self, token):
        for p in self.store.all():
            sh = p.get("share") or {}
            if sh.get("token") and secrets.compare_digest(sh["token"].encode(), token.encode()):
                return self.store.spec(p["id"], sh["version"])
        return None

    def _page(self, spec, csp=PAGE_CSP):
        html, _ = brain.build_html(spec, test=self.store.test)
        return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8", csp=csp)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._same_site():
            return self._send(403, {"error": "forbidden"})
        path = self.path.split("?", 1)[0]
        m = re.fullmatch(r"/s/([A-Za-z0-9_-]{22})", path)
        if m:  # 見るだけのリンク。合言葉なしで開ける（作った人が「リンクを作る」を押したものだけ）
            spec = self._shared(m.group(1))
            self._noindex = True
            return self._page(spec) if spec else self._send(404, {"error": "not_found"})
        if self._judge_gate():
            return
        q = self._query()
        if path == "/api/state":
            return self._send(200, {"test": self.store.test, "key": claude.has_key(), "no_key_message": claude.NO_KEY, "max_rounds": self.engine.max_rounds, "max_questions": brain.MAX_QUESTIONS,
                                    "intake": brain.INTAKE, "test_answers": self.test_answers, "model": claude.MODEL, "judge": bool(self.judge)})
        if path == "/api/list":
            return self._send(200, {"projects": [{"id": p["id"], "title": p.get("title") or p["intake"].get("work") or "", "job": p["intake"].get("job") or "", "stage": p["stage"], "updated": p.get("updated")} for p in self.store.all()]})
        m = re.fullmatch(r"/p/([0-9a-f]{8})(?:/(draft|v/(\d+)))?", path)
        if m:
            pid = m.group(1)
            if not self.store.exists(pid):
                return self._send(404, {"error": "not_found"})
            if m.group(2) == "draft":
                spec = self.store.get_json(pid, "draft.json")
            elif m.group(3):
                spec = self.store.spec(pid, int(m.group(3)))
            else:
                cur = self.store.load(pid).get("current")
                spec = self.store.spec(pid, cur) if cur else None
            if not spec:
                return self._send(404, {"error": "not_found"})
            return self._page(spec)
        if path in ("/api/project", "/api/export", "/api/link", "/api/shot"):
            pid = q.get("id") or ""
            if not self.store.exists(pid):
                return self._send(404, {"error": "not_found"})
            p = self.store.load(pid)
            if path == "/api/project":
                return self._send(200, self.engine.project_view(p))
            if path == "/api/shot":
                f = self.store.shot_path(pid, q.get("name"))
                return self._send(200, f.read_bytes(), "image/jpeg") if f else self._send(404, {"error": "not_found"})
            if not p.get("current"):
                return self._send(409, {"error": "not_ready"})
            if path == "/api/link":
                host = self.headers.get("Host")
                scheme = "https" if self.judge and host in self.judge.hosts else "http"
                return self._send(200, self.engine.publisher.link(pid, f"{scheme}://{host}"))
            html, _ = brain.build_html(self.store.spec(pid, p["current"]), test=self.store.test)
            name = re.sub(r"[^\w\-ぁ-んァ-ヶ一-龠ー]", "_", p.get("title") or "見えない仕事")[:40] + ".html"
            return self._send(200, {"html": html, "filename": name, "bytes": len(html.encode("utf-8")), "test": self.store.test})
        m = re.fullmatch(r"/mihon/([a-z]+)/(scene\.json)?", path)
        if m and m.group(1) in SAMPLES:
            f = SAMPLE_DIR / m.group(1) / (m.group(2) or "index.html")
            if f.is_file():
                return self._send(200, f.read_bytes(), "application/json; charset=utf-8" if m.group(2) else STATIC["index.html"], csp=SAMPLE_CSP)
            return self._send(404, {"error": "not_found"})
        m = re.fullmatch(r"/home/([a-z_]+\.jpg)", path)
        if m and (WEB / "home" / m.group(1)).is_file():
            return self._send(200, (WEB / "home" / m.group(1)).read_bytes(), "image/jpeg")
        name = "index.html" if path == "/" else path.lstrip("/")
        if name in STATIC and (WEB / name).is_file():
            return self._send(200, (WEB / name).read_bytes(), STATIC[name], csp=UI_CSP)
        return self._send(404, {"error": "not_found"})

    def do_POST(self):
        if self.judge and self.path == "/login" and self._same_site():
            return self._judge_login()
        if not self._same_site() or "application/json" not in (self.headers.get("Content-Type") or ""):
            self.close_connection = bool(self.judge) or self.close_connection
            return self._send(403, {"error": "forbidden"})
        if self._judge_gate():
            return
        path = self.path.split("?", 1)[0]
        cap = 24_000_000 if path == "/api/report" else 40_000
        try:
            size = int(self.headers.get("Content-Length") or 0)
            if size > cap:
                self.close_connection = True
                return self._send(413, {"error": "too_large"})
            data = json.loads(self.rfile.read(size).decode("utf-8") or "{}")
            if not isinstance(data, dict):
                raise ValueError
        except ValueError:
            return self._send(400, {"error": "bad_json"})
        if path == "/api/words":
            hits = guard(str(data.get("text") or ""))
            return self._send(200, {"stopped": bool(hits), "hits": hits, "message": STOP_MSG if hits else ""})
        needs_claude = path in ("/api/start", "/api/answer", "/api/ask_again", "/api/generate", "/api/resume", "/api/fix")
        if needs_claude and not (self.store.test or claude.has_key()):
            return self._send(503, {"error": "no_api_key", "message": claude.NO_KEY})
        if needs_claude and self.judge:
            no = self.judge.gate.refuse()
            if no:
                return self._send(429, {"error": no[0], "message": no[1]})
        if path == "/api/start":
            return self._start(data)
        pid = str(data.get("id") or "")
        if not self.store.exists(pid):
            return self._send(404, {"error": "not_found"})
        route = {"/api/answer": self._answer, "/api/ask_again": self._ask_again, "/api/edit_answer": self._edit_answer, "/api/generate": self._generate, "/api/report": self._report,
                 "/api/resume": self._resume, "/api/fix": self._fix, "/api/commit": self._commit, "/api/cancel": self._cancel, "/api/undo": self._undo, "/api/confirm": self._confirm,
                 "/api/share": self._share, "/api/unshare": self._unshare}.get(path)
        if not route:
            return self._send(404, {"error": "not_found"})
        return route(pid, data)

    def _stopped(self, pid, hits, text):
        if pid:
            self.store.memo(pid, "stopped_words", text, hits=hits)
        return self._send(200, {"stopped": True, "hits": hits, "message": STOP_MSG})

    def _start(self, data):
        intake = {}
        for item in brain.INTAKE:
            text = str(data.get(item["key"]) or "").strip()[:200]
            hits = guard(text)
            if hits:
                return self._send(200, {"stopped": True, "hits": hits, "message": STOP_MSG, "key": item["key"]})
            if not text and item["key"] != "looks":
                return self._send(400, {"error": "empty", "key": item["key"]})
            intake[item["key"]] = text
        p = self.store.create(intake)
        self.engine.ask_next(p["id"])
        return self._send(200, {"id": p["id"]})

    def _answer(self, pid, data):
        p = self.store.load(pid)
        if p["stage"] != "interview" or not p.get("pending") or p.get("asking"):
            return self._send(409, {"error": "not_waiting"})
        skipped = bool(data.get("skip"))
        text = "" if skipped else str(data.get("answer") or "").strip()[:800]
        if not skipped and not text:
            return self._send(400, {"error": "empty"})
        hits = guard(text)
        if hits:  # Claude に渡さない。答えとしても残さない。
            return self._stopped(pid, hits, text)
        with self.store.edit(pid) as q:
            pend = q["pending"]
            q["qa"].append({"axis": pend["axis"], "q": pend["q"], "a": text, "skipped": skipped})
            q["pending"] = None
        self.engine.ask_next(pid)
        return self._send(200, {"ok": True})

    def _ask_again(self, pid, data):
        self.engine.ask_next(pid)
        return self._send(200, {"ok": True})

    def _edit_answer(self, pid, data):
        text = str(data.get("answer") or "").strip()[:800]
        hits = guard(text)
        if hits:
            return self._stopped(pid, hits, text)
        key = data.get("key")
        with self.store.edit(pid) as p:
            if p["stage"] not in ("review", "failed", "interview"):
                return self._send(409, {"error": "locked"})
            if key in {i["key"] for i in brain.INTAKE}:
                if not text and key != "looks":
                    return self._send(400, {"error": "empty"})
                p["intake"][key] = text
            elif isinstance(data.get("index"), int) and 0 <= data["index"] < len(p["qa"]):
                q = p["qa"][data["index"]]
                q["a"], q["skipped"] = text, not text
            else:
                return self._send(400, {"error": "bad_target"})
        return self._send(200, {"ok": True})

    def _generate(self, pid, data):
        p = self.store.load(pid)
        if p["stage"] not in ("review", "failed", "ready") or p.get("job") and p["job"].get("stage") in Engine.RUN:
            return self._send(409, {"error": "busy"})
        if not any(q.get("a") for q in p["qa"]):
            return self._send(400, {"error": "no_answers", "message": "1つも答えがないと作れません。質問に1つは答えてください。"})
        self.engine.start_build(pid)
        return self._send(200, {"ok": True})

    def _report(self, pid, data):
        return self._send(200, self.engine.report(pid, data))

    def _resume(self, pid, data):
        return self._send(200, {"ok": self.engine.resume(pid)})

    def _fix(self, pid, data):
        p = self.store.load(pid)
        if p["stage"] != "ready" or (p.get("fix") and p["fix"]["stage"] in ("fixing", "fix_repair", "fix_check", "proposed")):
            return self._send(409, {"error": "busy"})
        said = str(data.get("said") or "").strip()[:800]
        if not said:
            return self._send(400, {"error": "empty"})
        hits = guard(said)
        if hits:  # Claude に渡さない
            return self._stopped(pid, hits, said)
        ctx = data.get("ctx") if isinstance(data.get("ctx"), dict) else {}
        ctx = {"chapter": str(ctx.get("chapter") or "")[:30], "p": ctx.get("p") if isinstance(ctx.get("p"), (int, float)) else None,
               "picked": ctx.get("picked") if isinstance(ctx.get("picked"), dict) else None}
        self.engine.start_fix(pid, said, ctx)
        return self._send(200, {"ok": True})

    def _commit(self, pid, data):
        return self._send(200, {"ok": self.engine.commit(pid)})

    def _cancel(self, pid, data):
        return self._send(200, {"ok": self.engine.cancel(pid)})

    def _undo(self, pid, data):
        return self._send(200, {"ok": self.engine.undo(pid)})

    def _share(self, pid, data):
        """いまの形を、合言葉なしで見られるリンクにする。あとで直しても、作り直すまでリンクの中身は変わらない。"""
        with self.store.edit(pid) as p:
            if not p.get("current"):
                return self._send(409, {"error": "not_ready"})
            p["share"] = {"token": secrets.token_urlsafe(16), "version": p["current"], "issued": now()}
            token = p["share"]["token"]
        host = self.headers.get("Host")
        scheme = "https" if self.judge and host in self.judge.hosts else "http"
        local = not (self.judge and host in self.judge.hosts)
        note = "このパソコンの中だけで開けるリンクです。外の人には見えません。" if local else "リンクを知っている人なら誰でも、合言葉なしで見られます（見るだけ。直したり作ったりはできません）。"
        return self._send(200, {"url": f"{scheme}://{host}/s/{token}", "note": note, "public": not local})

    def _unshare(self, pid, data):
        with self.store.edit(pid) as p:
            p.pop("share", None)
        return self._send(200, {"ok": True})

    def _confirm(self, pid, data):
        return self._send(200, {"ok": self.engine.confirm(pid, str(data.get("chapter") or ""))})


def recover(store):
    """サーバーが止まっている間に切れた仕事は「途中で止まった」にして、続きから動かせるようにする。"""
    for p in store.all():
        changed = False
        j = p.get("job")
        if j and j.get("stage") in Engine.RUN:
            j.update({"resume": j["stage"], "stage": "paused", "error": "サーバーが止まったので、途中で止まりました。続きからできます。", "code": "restarted"})
            changed = True
        if p.get("asking"):
            p["asking"] = False
            p["ask_error"] = "サーバーが止まったので、質問を作り直します。"
            changed = True
        fx = p.get("fix")
        if fx and fx.get("stage") in Engine.FIX_RUN:
            fx.update({"resume": fx["stage"], "stage": "fix_failed", "error": "サーバーが止まりました。続きからできます。", "code": "restarted"})
            changed = True
        if changed:
            store.save(p)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--test", action="store_true", help="Claudeの返事を手書きにする。データは終わると消える")
    ap.add_argument("--keep-test", action="store_true", help="試験データを消さない（再開の試験用）")
    ap.add_argument("--bind", default="127.0.0.1", help="待ち受ける住所。127.0.0.1 以外は審査員モードのときだけ使える")
    ap.add_argument("--judge", action="store_true", help="審査員モード。合言葉は環境変数 STUDIO_JUDGE_CODE から読む")
    ap.add_argument("--judge-host", action="append", default=[], help="公開するホスト名（https で来るもの）。複数回書ける")
    ap.add_argument("--judge-max-calls", type=int, default=int(os.environ.get("STUDIO_JUDGE_MAX_CALLS") or 120), help="Claude を呼ぶ回数の合計の上限")
    ap.add_argument("--judge-parallel", type=int, default=int(os.environ.get("STUDIO_JUDGE_PARALLEL") or 2), help="Claude を同時に呼ぶ数の上限")
    args = ap.parse_args()
    code = os.environ.pop("STUDIO_JUDGE_CODE", "")
    if args.bind != "127.0.0.1" and not (args.judge and args.judge_host):
        ap.error("--bind で外から受けるのは、--judge と --judge-host を付けたときだけです")
    if args.judge_host and not args.judge:
        ap.error("--judge-host は --judge と一緒に使います")
    if args.judge:
        if len(code) < JUDGE_MIN_CODE:
            ap.error(f"環境変数 STUDIO_JUDGE_CODE に {JUDGE_MIN_CODE} 文字以上の合言葉を入れてください")
        if args.judge_max_calls < 1 or args.judge_parallel < 1:
            ap.error("上限は1以上にしてください")
        for host in args.judge_host:
            if not re.fullmatch(r"[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?", host):
                ap.error("--judge-host は小文字のホスト名だけを書きます（https:// や / は付けません）")
    test_root = TEST_JUDGE_DATA if args.judge else TEST_DATA

    if args.test:
        import test_replies
        if test_root.exists() and not args.keep_test:
            shutil.rmtree(test_root)
        store = Store(test_root, True)
        ask = test_replies.make_ask()
        Handler.test_answers = {"intake": test_replies.INTAKE_ANSWERS, "qa": [a for _, _, a in test_replies.QUESTIONS]}
    else:
        store = Store(JUDGE_DATA if args.judge else DATA, False)
        ask = claude.ask
    recover(store)
    if args.judge:
        claude.NO_KEY = JUDGE_NO_KEY
        gate = CallGate(ask, store.root / "usage.json", args.judge_max_calls, args.judge_parallel)
        Handler.judge = Judge(code, args.judge_host, gate)
        ask = gate
    engine = Engine(store, ask, JudgePublisher() if args.judge else LocalPublisher())
    Handler.store, Handler.engine = store, engine

    def cleanup(*_):
        if args.test and not args.keep_test and test_root.exists():
            shutil.rmtree(test_root, ignore_errors=True)
        sys.exit(0)
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    httpd.daemon_threads = True
    mode = "試験モード（Claudeの返事は手書き・データは終わると消える）" if args.test else ("本番（Claudeにつながります）" if claude.has_key() else "本番・APIキーなし（画面で止まります）")
    print(f"http://127.0.0.1:{args.port}/  {mode}  確かめて直す周回の上限={engine.max_rounds}", flush=True)
    if args.judge:
        print(f"審査員モード  Claudeの上限={args.judge_max_calls}回（使用済み{gate.used}回）  同時={args.judge_parallel}  公開ホスト={','.join(args.judge_host) or 'なし'}  データ={store.root.name}", flush=True)
    try:
        httpd.serve_forever()
    finally:
        cleanup()


if __name__ == "__main__":
    main()
