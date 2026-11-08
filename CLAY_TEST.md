# 粘土（K.clay）を本物の Claude で試す手順

題材は「津軽塗の職人」。**同じ聞き取りの答え**で、

1. 粘土なし（今までの部品だけ）
2. 粘土あり（K.clay を使ってよい）

の2本を作り、見た目と費用（トークン数・秒数）を並べて比べる。

> ⚠ `clay_test/answers_tsugaru.json` の答えは **仮の答え**（AIが一般的な知識で書いた試験用）。
> 職人さん本人の言葉ではない。津軽塗の工程も一般論の範囲で、断定しないように書いてある。
> できた作品を外に出すときは、この答えを使わないこと。

## 何が切り替わるか

| 環境変数 | 値 | 意味 |
|---|---|---|
| `STUDIO_CLAY` | `0`（既定） | 部品の説明書（API.md）から K.clay を消し、「人の形は作らない」の元の決まりで作る |
| `STUDIO_CLAY` | `1` | K.clay を説明書に載せる。人は「要るときだけ、顔を作らずに」 |
| `STUDIO_SCENE_EFFORT` | `high` | 場面のコードを書く工程の考える量を上げる（main の既定 medium は変えていない） |

`STUDIO_CLAY` はサーバーの起動時に読むので、**2本の間でサーバーを起動し直す**。

## 手順（ターミナルで。ワークツリーの一番上から）

```bash
cd mienai-shigoto   # リポジトリの一番上

# キーは画面に出さずに入れる（履歴にも残らない）
read -s ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
```

### 1本目：粘土なし

```bash
~/Documents/YAMA_TOOLS_LAB/wait_for_quiet_mac.sh --quiet && STUDIO_CLAY=0 STUDIO_SCENE_EFFORT=high python3 studio/server.py --port 8994
```

別のターミナルで（同じフォルダで）:

```bash
node clay_test/run_one.mjs --port 8994 --answers clay_test/answers_tsugaru.json --label noclay
```

終わると、プロジェクトのIDと、PC（1920×1080）とスマホ（375×812）の場面ごとの絵が
`clay_test/out/noclay/` に出る。サーバーは Ctrl+C で止める。

### 2本目：粘土あり

```bash
~/Documents/YAMA_TOOLS_LAB/wait_for_quiet_mac.sh --quiet && STUDIO_CLAY=1 STUDIO_SCENE_EFFORT=high python3 studio/server.py --port 8994
```

```bash
node clay_test/run_one.mjs --port 8994 --answers clay_test/answers_tsugaru.json --label clay
```

絵は `clay_test/out/clay/`。終わったらサーバーを Ctrl+C で止め、`unset ANTHROPIC_API_KEY`。

- `run_one.mjs` は聞き取り（答えが尽きた質問は飛ばす）→作る→確かめる、を自動で進める。キーは扱わない。
- 25分を超えたら止まる（`--minutes 40` で延ばせる）。
- ポートは 8994。8986・8981・8995・8997・8998 は使わない。

## 費用を比べる

1本ごとに `studio/data/<ID>/usage.json` ができる（キーも本文も入らない）。中身:

- `calls[]` … 1回ごとの工程（question / script / scene / review / repair など）・考える量・入力/出力/キャッシュのトークン数・秒数・金額の見積もり
- `builds[]` … 「作る」1回ぶんの工程別の合計と総秒数、`scene_effort` と `clay`

並べる:

```bash
python3 clay_test/compare_usage.py studio/data/<粘土なしのID>/usage.json studio/data/<粘土ありのID>/usage.json
```

金額の単価（Opus 5.5・100万トークンあたり）: 入力 $4 / 出力 $20 / キャッシュ読み $0.20 / キャッシュ書き $5（5分キャッシュ＝入力の1.25倍）。
出どころは claude-api スキルの価格表（2026-10-06 時点のキャッシュ）。モデル名が `claude-opus-5-5` 以外の回は金額を出さず「単価未確認」と書く。
**請求額そのものではない。** 正確な額は Claude Console の使用量で確かめる。

## 見比べるところ

- 場面ごとの絵を noclay / clay で並べ、**ひと目で違いが分かるか**（寄りの場面と引きの場面で分けて見る）
- 人が出る場面で、顔を作っていないか・人が主役になっていないか
- 「職人に確認」の札が、仮の答えに無いことを言っている場面に付いているか
- 作る時間とトークン数がどれだけ増えたか（K.clay の説明が増えるぶん、入力は少し増える）

## 終わったら

試した2本は `studio/data/<ID>/` に残る。要らなければフォルダごと消す（`clay_test/out/` も）。
