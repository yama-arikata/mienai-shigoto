#!/usr/bin/env python3
"""2本の usage.json を並べる（粘土なし／粘土あり）。

  python3 clay_test/compare_usage.py studio/data/<粘土なしのID>/usage.json studio/data/<粘土ありのID>/usage.json

最後に作った1本（builds の最後）の工程別トークン数・秒数・金額の見積もりを並べる。
金額は usage.json に書かれた単価の出どころ（price_source）で計算したもの。単価の無いモデルの回は数えない。
"""
import json
import sys

KEYS = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
SHORT = {"input_tokens": "入力", "output_tokens": "出力", "cache_creation_input_tokens": "キャッシュ書", "cache_read_input_tokens": "キャッシュ読"}


def load(path):
    u = json.load(open(path, encoding="utf-8"))
    b = (u.get("builds") or [None])[-1]
    interview = [c for c in u.get("calls", []) if c.get("purpose") == "question"]
    iv = {k: sum(c.get(k, 0) for c in interview) for k in KEYS}
    iv["usd"] = None if any(c.get("usd") is None for c in interview) else round(sum(c["usd"] for c in interview), 4)
    iv["seconds"] = round(sum(c.get("seconds", 0) for c in interview), 1)
    iv["calls"] = len(interview)
    return u, b, iv


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    names = ["粘土なし", "粘土あり"]
    rows = [load(p) for p in sys.argv[1:]]
    for name, (u, b, iv) in zip(names, rows):
        if not b:
            print(f"{name}: builds がありません（作り終えていない）")
    print("単価:", rows[0][0].get("price_source", "不明"))
    print()
    purposes = sorted({k for _, b, _ in rows if b for k in b["by_purpose"]} | {"question"})
    head = f"{'工程':<10}" + "".join(f"{n:>34}" for n in names)
    print(head)
    print("-" * len(head.encode("utf-8")))
    for pur in purposes:
        cells = []
        for _, b, iv in rows:
            box = iv if pur == "question" else (b or {}).get("by_purpose", {}).get(pur)
            if not box:
                cells.append(f"{'-':>34}")
                continue
            usd = box.get("usd")
            cells.append(f"{box.get('calls', 0):>3}回 入{box.get('input_tokens', 0):>7} 出{box.get('output_tokens', 0):>6} {box.get('seconds', 0):>5}秒 " + (f"${usd:.3f}" if usd is not None else "単価未確認"))
        print(f"{pur:<10}" + "".join(f"{c:>34}" for c in cells))
    print()
    for name, (u, b, iv) in zip(names, rows):
        if not b:
            continue
        t = b["total"]
        usd = (t.get("usd") or 0) + (iv.get("usd") or 0)  # 単価の無い回は0として足す（下に※を出す）
        print(f"{name}: 作るのに {b['build_seconds']}秒・結果={b['result']}・scene_effort={b.get('scene_effort')}・clay={b.get('clay')}")
        print("   作る工程の合計: " + " / ".join(f"{SHORT[k]} {t.get(k, 0)}" for k in KEYS) + f" / ${t.get('usd', 0):.3f}")
        print(f"   聞き取りも足すと: ${usd:.3f}（聞き取り {iv['calls']}回）" + ("  ※単価未確認の回あり" if t.get("unpriced_calls") else ""))


if __name__ == "__main__":
    main()
