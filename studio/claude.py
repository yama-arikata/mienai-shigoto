"""Claude Messages API を標準ライブラリだけで呼ぶ（SSE で文字を受けながら）。

キーは環境変数 ANTHROPIC_API_KEY からだけ読む。書き出さない・表示しない。
"""
import json
import os
import time
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2026-10-21"
MODEL = "claude-opus-5-5"
FALLBACK_BETA = "server-side-fallback-2026-07-01"
NO_KEY = "APIキーが入っていないので、Claude に聞けません。ここで止まっています。やまさんに ANTHROPIC_API_KEY を入れて、サーバーを起動し直してもらってください。"


class ClaudeError(Exception):
    def __init__(self, message, code="claude_error"):
        super().__init__(message)
        self.code = code


def has_key():
    return bool(os.environ.get("ANTHROPIC_API_KEY"))


def _read_stream(res, on_text):
    text, stop, model, err = [], None, MODEL, None
    event = None
    for raw in res:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
            continue
        if not line.startswith("data:"):
            continue
        try:
            data = json.loads(line[5:].strip())
        except ValueError:
            continue
        kind = data.get("type") or event
        if kind == "message_start":
            model = (data.get("message") or {}).get("model") or model
        elif kind == "content_block_start":
            block = data.get("content_block") or {}
            if block.get("type") == "fallback":  # 別のモデルへ渡ったら、そこまでの文字は捨てる
                text = []
                model = (block.get("to") or {}).get("model") or model
                if on_text:
                    on_text("", True)
        elif kind == "content_block_delta":
            delta = data.get("delta") or {}
            if delta.get("type") == "text_delta":
                piece = delta.get("text") or ""
                text.append(piece)
                if on_text:
                    on_text(piece, False)
        elif kind == "message_delta":
            stop = (data.get("delta") or {}).get("stop_reason") or stop
        elif kind == "error":
            err = (data.get("error") or {})
    return "".join(text), stop, model, err


def ask(purpose, system, user, schema, effort="medium", max_tokens=32000, on_text=None):
    """決まった形のJSONを返させる。(内容, モデル名) を返す。"""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise ClaudeError(NO_KEY, "no_api_key")
    body = {
        "model": MODEL, "max_tokens": max_tokens, "stream": True, "system": system, "fallbacks": "default",
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": schema}},
        "messages": [{"role": "user", "content": user if isinstance(user, (str, list)) else json.dumps(user, ensure_ascii=False)}],
    }
    req = urllib.request.Request(API_URL, data=json.dumps(body).encode("utf-8"), method="POST", headers={
        "content-type": "application/json", "x-api-key": key, "accept": "text/event-stream",
        "anthropic-version": API_VERSION, "anthropic-beta": FALLBACK_BETA,
    })
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=300) as res:
                text, stop, model, err = _read_stream(res, on_text)
            if err:
                if err.get("type") in ("overloaded_error", "api_error", "rate_limit_error") and attempt == 0:
                    if on_text:
                        on_text("", True)
                    time.sleep(3)
                    continue
                raise ClaudeError(f"Claude の返事が途中で止まりました（{err.get('type')}）。")
            break
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = json.loads(exc.read().decode("utf-8")).get("error", {}).get("message", "")
            except Exception:
                pass
            if exc.code == 401:
                raise ClaudeError("APIキーが正しくありません（401）。やまさんにキーを確かめてもらってください。", "bad_key")
            if exc.code in (429, 500, 502, 503, 529) and attempt == 0:
                time.sleep(3)
                continue
            raise ClaudeError(f"Claude に届きましたが、エラーで返りました（{exc.code}）。{detail[:200]}")
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            if attempt == 0:
                time.sleep(3)
                continue
            raise ClaudeError(f"Claude に届きませんでした（{type(exc).__name__}）。ネットを確かめてください。")
    else:
        raise ClaudeError("Claude が混んでいて返事をもらえませんでした。少し待ってもう一度お願いします。")
    if stop == "refusal":
        raise ClaudeError("Claude がこの内容には答えられないと返しました。", "refusal")
    if stop == "max_tokens":
        raise ClaudeError("Claude の返事が長すぎて途中で切れました。", "too_long")
    try:
        return json.loads(text), model
    except ValueError:
        raise ClaudeError("Claude の返事を読めませんでした（形がくずれていました）。")
