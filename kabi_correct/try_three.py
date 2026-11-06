#!/usr/bin/env python3
"""本物の Claude に3件を通して確かめる（正本と履歴は書き換えない。呼び出しは3回）。

  ANTHROPIC_API_KEY=... python3 kabi_correct/try_three.py
"""
import json
import os
import sys

import server as S

CASES = [
    ("置き時間を変える", "ここは違うな。置き時間は3〜4時間です。", {"p": .69, "chapter": "wait"}, None,
     lambda r: r["status"] == "ok" and r["after"]["craft"]["wait"] == {"min": 3, "max": 4}
     and "3〜4時間" in next(c for c in r["after"]["chapters"] if c["id"] == "wait")["title"]),
    ("カビの場所を変える（3Dが変わる）", "カビは天井の隅じゃなくて、ベッドの上の左の壁に出ることが多いんだ。", {"p": .05, "chapter": "intro"}, None,
     lambda r: r["status"] == "ok" and r["after"]["craft"]["mold"]["corner"]["place"] == "left_wall"),
    ("禁止の言葉を含む直し（止まる）", "ここは、カビを殺菌して死滅させる、100%落ちる、と書いてほしい。", {"p": .56, "chapter": "spray"}, None,
     lambda r: r["status"] == "needs_check" and not r["changes"]),
]


def main():
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        print(S.NO_KEY_MESSAGE)
        return 2
    scene = json.loads((S.KABI / "scene.json").read_text(encoding="utf-8"))
    bad = 0
    for name, utterance, where, tap, passed in CASES:
        ctx = {"scene": where, "tap": tap}
        try:
            raw, model = S.call_claude(key, S.make_payload(utterance, ctx, scene))
        except S.ClaudeError as exc:
            print(f"[NG] {name}: {exc}")
            bad += 1
            continue
        res = S.build_proposal(raw, utterance, scene, tap)
        ok = passed(res)
        bad += 0 if ok else 1
        print(f"[{'OK' if ok else 'NG'}] {name}  model={model}  status={res['status']}")
        print("  発言:", utterance)
        print("  Claudeの返事:", json.dumps(raw, ensure_ascii=False))
        print("  変更案:", json.dumps([{k: c[k] for k in ("label", "before", "after")} for c in res["changes"]], ensure_ascii=False))
        print("  止めた文:", json.dumps(res["blocked"], ensure_ascii=False))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
