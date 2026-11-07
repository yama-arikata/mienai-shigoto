"""聞き取り → 台本 → 3D → 直し。Claude への頼み方と、返事の検査をまとめる。

Claude が書くのは「場面の文」と「物と動きのコード」だけ。
スクロールや字幕などの土台は kit/ の動く実装を使う。
"""
import json
import os
import pathlib
import re
import unicodedata

from guard import guard, normalize

HERE = pathlib.Path(__file__).resolve().parent
KIT = HERE / "kit"
THREE_VERSION = "0.160.0"

AXES = {
    "tema": "お客さんに見えない手間",
    "shippai": "素人がやると失敗する所",
    "junban": "やる順番",
    "matsu": "待つ時間",
}
INTAKE = [
    {"key": "job", "q": "お仕事は何ですか？", "ph": "左官、畳屋、屋根屋 など"},
    {"key": "work", "q": "お客さんに見せたい仕事を、1つ教えてください。", "ph": "土の壁をぬる など"},
    {"key": "looks", "q": "お客さんは、ふつうどこを見ていますか？", "ph": "仕上がりの色 など"},
]
MAX_QUESTIONS = 6
MIN_CHAPTERS, MAX_CHAPTERS = 3, 12
ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_TITLE, MAX_BODY, MAX_CODE, MAX_IMG = 60, 220, 90000, 40
# 考える深さ。完成まで5分程度に収めるため、深く考えるのは台本（絵の計画）だけ
SCENE_EFFORT, FIX_EFFORT, REVIEW_EFFORT = "medium", "high", "medium"
# 試験で場面のコードの考える深さだけ上げたいとき: STUDIO_SCENE_EFFORT=high（既定は上の medium のまま）
_EFFORTS = ("low", "medium", "high", "xhigh", "max")
if (os.environ.get("STUDIO_SCENE_EFFORT") or "").strip() in _EFFORTS:
    SCENE_EFFORT = os.environ["STUDIO_SCENE_EFFORT"].strip()
# 粘土の部品（K.clay）を Claude に教えるか。STUDIO_CLAY=0 で今までどおり（粘土なし・人の形は作らない）
CLAY = (os.environ.get("STUDIO_CLAY") or "1").strip() not in ("0", "off", "no", "false")
_CLAY_BLOCK = re.compile(r"<!--clay-->(.*?)<!--/clay-->", re.S)
_NOCLAY_BLOCK = re.compile(r"<!--noclay-->(.*?)<!--/noclay-->", re.S)


def api_doc():
    """Claude に渡す API.md。粘土あり／なしで、その部分だけ出し分ける。"""
    text = (KIT / "API.md").read_text(encoding="utf-8")
    if CLAY:
        return _NOCLAY_BLOCK.sub("", _CLAY_BLOCK.sub(lambda m: m.group(1), text))
    return _CLAY_BLOCK.sub("", _NOCLAY_BLOCK.sub(lambda m: m.group(1), text))


class SpecError(Exception):
    def __init__(self, errors):
        super().__init__("; ".join(errors))
        self.errors = errors


# ===== Claude に返させる形 =====
def _obj(props):
    return {"type": "object", "additionalProperties": False, "required": list(props), "properties": props}


S = {"type": "string"}
NUMS = {"type": "array", "items": {"type": "number"}}
CAM_ONE = _obj({"look": NUMS, "r": {"type": "number"}, "dir": NUMS})
CAM = {"type": "array", "items": CAM_ONE}

QUESTION_SCHEMA = _obj({"done": {"type": "boolean"}, "axis": {"type": "string", "enum": list(AXES)}, "question": S})
WORLD_KINDS = ["snow_night", "garage", "workshop", "room", "town_dusk", "field_day", "studio"]
SCRIPT_SCHEMA = _obj({
    "page_title": S, "tag": S, "note": S, "accent": S, "night": S,
    "chapters": {"type": "array", "items": _obj({"id": S, "title": S, "body": S, "basis": S, "confirm": S, "image_note": S})},
    "unknowns": {"type": "array", "items": S},
    "art": _obj({"place": {"type": "string", "enum": WORLD_KINDS}, "place_why": S, "hero": S, "invisible": S, "showpiece": S}),
    "scene_plan": S,
})
SCENE_SCHEMA = _obj({
    "cameras": {"type": "array", "items": _obj({"id": S, "cam": CAM})},
    "code": S,
})
EDITS = {"type": "array", "items": _obj({"find": S, "replace": S})}
REPAIR_SCHEMA = _obj({
    "fixed": {"type": "array", "items": S},
    "edits": EDITS,
    "camera_fixes": {"type": "array", "items": _obj({"chapter": S, "cam": CAM})},
    "text_fixes": {"type": "array", "items": _obj({"chapter": S, "title": S, "body": S})},
})
REVIEW_ITEMS = {
    "yomeru": "文字が読めるか",
    "katachi": "物の形が不自然でないか・本物に見えるか",
    "kakure": "粒や光で中が隠れていないか",
    "camera": "カメラが近すぎないか",
    "kire": "物が画面の端や字幕で切れていないか",
    "nafuda": "名札の先に、その物が見えるか",
    "imi": "場面の意味が絵で伝わるか",
    "hazukashii": "お客さんに見せて恥ずかしくないか",
}
REVIEW_SCHEMA = _obj({
    "passed": {"type": "boolean"},
    "reason": S,
    "issues": {"type": "array", "items": _obj({
        "image": {"type": "integer"},
        "item": {"type": "string", "enum": list(REVIEW_ITEMS)},
        "severity": {"type": "string", "enum": ["high", "low"]},
        "seen": S,
        "how_to_fix": S,
    })},
})


def _variant(name, props):
    props = dict(props)
    props["type"] = {"type": "string", "const": name}
    return _obj(props)


FIX_SCHEMA = _obj({
    "summary": S,
    "focus_chapter": S,
    "changes": {"type": "array", "items": {"anyOf": [
        _variant("set_text", {"chapter": S, "title": S, "body": S, "basis": S, "confirm": S}),
        _variant("add_chapter", {"after": S, "id": S, "title": S, "body": S, "basis": S, "confirm": S, "cam": CAM}),
        _variant("remove_chapter", {"chapter": S}),
        _variant("move_chapter", {"chapter": S, "after": S}),
        _variant("set_camera", {"chapter": S, "cam": CAM}),
        _variant("edit_code", {"find": S, "replace": S, "why": S}),
    ]}},
    "out_of_scope": {"type": "array", "items": _obj({"request": S, "reason": S})},
})


# ===== 頼み方 =====
RULES = """守ること:
- 職人が言っていない工程・数字・道具・理由を、事実として書かない。分からないものは書かずに聞く。
- 殺菌・滅菌・死滅・効果の言い切りや保証・健康の効果・全国の資格者数・地域で唯一や一番・商品名は書かない。意味が同じ言い換えもしない。
- 言葉は小学生にも分かる日本語。専門の言葉は職人が言ったものだけ、短く説明をそえる。
- 職人の仕事を大げさに持ち上げない。事実だけで「知らなかった」と思ってもらう。"""


def interview_system():
    axes = "\n".join(f"- {k}: {v}" for k, v in AXES.items())
    return f"""あなたは、職人さんに仕事の話を聞く聞き手です。お客さんには見えない仕事を3Dページにするための聞き取りをしています。

聞きたいことは次の4つです。
{axes}

やり方:
- 1回に1問だけ。短く、1文か2文で。小学生にも分かる言葉で。
- 相手が言った言葉をそのまま使って、もう1歩深く聞く。「たとえば」と答えを先に出して誘導しない。
- まだ聞いていない軸を優先する。答えが「わからない」「飛ばす」の軸は聞き直さない。
- 4つの軸が分かったら done を true にする。question は空でよい。

{RULES}"""


def script_system():
    PEOPLE = ("人の形は基本は作らない。職人が人を出してほしいと言ったとき、または人がいないと作業が伝わらないときだけ、最小限（手・腕だけ、または1人）で、顔を作らずに出す。主役は物と見えない仕事のまま。" if CLAY else "人の形は作らない。")
    return f"""あなたは職人さんの話を「見えない仕事の3Dページ」の台本にします。台本は場面（chapters）の並びです。

作り方:
- 場面は4〜8個。スクロールすると順に出ます。最初の場面は、お客さんが見ている所から入って「それだけではない」と気づかせる。最後の場面は、職人の言葉か、見えない所がまとめて見える場面で終える。
- 順番は職人が言った順番を守る。
- title は短く強く（30字まで）。**1行は11字まで**で、文の切れ目に <br> を入れる（言葉の途中で折り返さないように）。強調は <em>…</em> だけ使える。body は60字くらいまで。文は「です・ます」でそろえる。
- id は英小文字（例: bone, layer1）。
- basis には、その場面の元になった職人の言葉を**そのまま抜き書きする**（一字も変えない）。元の言葉が無い場面は作らない。
- 職人が言っていないのに場面に必要なこと（数字・理由など）は書かず、confirm に職人への質問として書く。問題なければ confirm は空。
- unknowns には、聞けなかったこと・分からないことを質問の形で書く。
- tag はページ左上の小さな見出し（「見えない仕事　ふすまの張り替え」のように）。note は「説明のための図です。形や大きさは実物と同じではありません」のように書く。
- accent は強調の色（暗い背景の上で読める明るい色）、night は字幕の下の暗い色。どちらも #rrggbb。その仕事の材料から選ぶ。

3Dの計画（art）を必ず書く。これでページの見ごたえが決まる:
- place: その仕事らしい場所を1つ選ぶ。snow_night（雪の夜の外）/ garage（車の作業場）/ workshop（木の作業場）/ room（家の部屋）/ town_dusk（夕方の町・道路）/ field_day（昼の屋外・畑・現場）/ studio（物だけを見せる撮影台）。place_why に理由を短く。
- hero: 主役の物と、本物らしく見える形の特徴。「箱型でよい」「単純な形でよい」とは書かない。
- invisible: お客さんに見えないもの（におい・しみ・湿り・熱・流れ・中の層・裏側など）を、どんな形と色で見せるか。
- showpiece: いちばんの見せ場の場面IDと、そこで画面に何が起きるか。
- scene_plan: 場面ごとに、何を見せて、どう変わるか（カメラの寄り引きも）。{PEOPLE}

答えが少ないとき（飛ばしが多いとき）:
- 3Dの見せ場を弱くしない。最初の3つの答え（仕事・見せたい仕事・お客さんが見ている所）と短い答えだけでも、「見えないものを大きく見せる場面」を必ず1つ作る。場面の数も4つ以上にする。
- ただし職人が言っていない工程は、字幕でも絵でも事実として描かない。絵で見せてよいのは「言った物」と「言ったことのイメージ」まで。たとえば薬剤を使うとしか聞いていないなら、入れ物と「使っている」ことまで見せて、どこにどう使うかは confirm で聞く。
- 効き目を言い切る絵にしない（においやしみが完全に消える絵を作らない）。
- においや湯気を、橙・赤・黄・琥珀の色で計画しない（火に見えます）。淡い黄緑や青白い色にする。
- 言葉の意味の説明（「〜とは〜のことです」）を自分で足さない。職人が言っていない説明になります。
- 実物に無い色や形で見せる場面は、image_note に短く書く（40字まで。例: においを色の帯で表した絵です）。それ以外は空。画面に「イメージ」の印と一緒に出る。

{RULES}"""


def scene_system():
    api = api_doc()
    example = (KIT / "example.js").read_text(encoding="utf-8")
    return f"""あなたは「見えない仕事の3Dページ」の、物と動きを書く担当です。台本（場面の文）はもう決まっています。土台（スクロール・字幕・カメラの計算・照明）はできているので、物と動きだけを書きます。

返すもの:
- cameras: 場面ごとのカメラ。各場面に2つ（入ったとき・出るとき）。
- code: 関数の中身のJavaScript。

{api}

## 書き方の見本（別の仕事の見本。形や動きをまねせず、書き方だけ参考にする）
```js
{example}
```

きまり:
- code は600行まで。読み込みに時間のかかる計算をしない。
- 場面IDは台本のものだけを使う。
- 名札（label）やコードのコメントにも、台本と同じ守りを当てる。殺菌・死滅・効果の言い切り・保証・健康の効果・資格者数・地域で唯一・商品名は書かない。
- 物の主な部分に日本語の name を付ける。

絵の質のきまり（いちばん大事。お客さんに見せて恥ずかしくない絵にする）:
1. 最初に K.world で、台本の art.place の場所を作る。暗い床だけの場面は作らない。世界の飾り（木・家・棚の荷物）は背景としてそのまま使う。
2. 主役は本物に見えるまで作り込む。実物の大きさの比で作る。車は K.car、家は K.house、入れ物は K.bottle、層は K.strata を使う。部品が無い物は loft / lathe / shape / pillow で輪郭から作り、段・すき間・ふち・留め具を足す。箱を積んで済ませない。
3. 見えないものは、目で見える形にする。K.xray / K.cut / K.stain / K.wisp / K.flow / K.strata を使い、見せ場（art.showpiece）では世界を w.dim で暗くして、見えないものを主役にする。
4. 暗い床に暗い物を置かない。しみやにおいは周りとはっきり違う色にする。
5. 名札の点は、その物の表面ぴったりに置く（car.spot などで座標を取る）。点の先に物が見えない名札は検査で止まる。
6. カメラは、最初に主役の全体 → 見せ場で寄る → 最後にまた全体。主役が画面の端で切れないように r を決める。接写は見せたい物が全部入る大きさにする。
   **道具や材料を紹介する場面は、その物にカメラを寄せて、画面の主役にする**（look をその物に、r は物の2〜3倍）。遠くの床に小さく置いて終わりにしない。場面ごとに、字幕を隠しても別の絵に見えるようにする。使い方が分からない道具は、使っている動きを作らず、物を大きく見せるだけにする。入れ物のラベルには職人が言った呼び名を text で書いてよい（商品名は書かない）。
7. 職人が言っていない道具・工程を、仕事の事実として見せない。世界の飾りは別。分からない物は作らない。"""


def repair_system():
    api = api_doc()
    return f"""「見えない仕事の3Dページ」を確かめたら、問題が見つかりました。問題の一覧を読んで、**その問題だけ**を直します。

返すもの:
- fixed: 何を直したかを、小学生にも分かる短い言葉で1つずつ。直せなかった問題は書かない。
- edits: コードの置きかえ。find はコードの中に**ちょうど1回だけ**出てくる文字列を、そのまま書く。replace は置きかえ後。関係ない所は変えない。
- camera_fixes: 見せ方を直すときの場面のカメラ（look / r / dir を2つ）。近すぎるときは r を大きくする。
- text_fixes: 文字が長すぎて読めないときと、書けない言葉があるときだけ使う。短くするか、その主張を丸ごと消す。**新しい事実を足さない。同じ意味に言い換えて残さない。** 変えない欄は空文字。

直し方のきまり:
- fixed は日本語で書く。
- 画像の問題（形がおもちゃに見える・背景が寂しい・名札の先に何も無い等）は、言い訳せずに**物を作り直す**。カメラを逃がすだけで済ませない。物を足すときは `return function(p,t){{` の直前に足す edits を書く。
- 指摘の直し方に、職人が言っていない作業（薬剤をかける、工程を足す等）が書かれていても、その作業は絵にしない。場面が同じ絵に見えるという指摘なら、カメラをその物へ寄せて別の絵にする。
- 「車がそれらしくない」→ K.car に置きかえる。「背景が暗い床だけ」→ K.world を入れる。「しみが見えない」→ K.stain を明るい色で。「名札の先に何も無い」→ 物の表面の座標へ名札を動かすか、物を見えるようにする。

{api}

{RULES}"""


def review_system():
    items = "\n".join(f"- {k}: {v}" for k, v in REVIEW_ITEMS.items())
    return f"""あなたは「見えない仕事の3Dページ」の見た目を、厳しく確かめる係です。ブラウザで撮った画像（字幕込み）を見ます。

**すべて日本語で書く。** reason も seen も how_to_fix も、職人さんの画面にそのまま出ます。英語を混ぜない。小学生にも分かる言葉で書く。

見る項目（item）:
{items}

次のどれかが見えたら、必ず issues に書く（不合格）:
- nafuda: 名札の点の先に、その名前の物が見えない。何を指しているか分からない。
- kire: 主役の物が画面の端で切れている。字幕の下に隠れている。
- imi: 字幕を隠して絵だけ見たとき、何の場面か分からない。前の場面と同じ絵に見える。
- katachi: 本物に見えない（車がゴルフカートに見える、箱を積んだだけに見える、宙に浮いている）。
- hazukashii: お客さんに見せて恥ずかしい（背景が暗い床だけ、おもちゃのよう、安っぽい、見せ場に見ごたえがない、においや湯気が火に見える）。

きまり:
- **画像の中に見えた問題だけを書く。** 見えていないことを想像で書かない。コードのことは書かない。
- issues の image は画像の番号。seen には、その画像のどこに何が見えるかを書く（「画像3の右下の黒い塊は…」のように）。how_to_fix には直し方を短く。
- severity: high は「見る人が読めない・何か分からない・隠れて見えない・恥ずかしい」もの。low は「直すと良い」くらいのもの。**low も直す対象です。**
- ただの好みは書かない。書いたものは全部直す対象になる。問題と言えないものは書かない。
- how_to_fix に、字幕に無い作業を足す案を書かない（職人が言っていない作業は絵にできません。「薬剤をかける様子を見せる」はだめ）。場面が同じに見えるなら「その物に寄って大きく見せる」のように、見せ方で直す案を書く。
- においやしみが完全に消える絵を求めない（効き目の言い切りになります）。
- passed は issues が1つも無いときだけ true。reason に、そう判断した根拠を画像の番号をあげて書く。
- **仕事の中身が正しいかは判断しない。** それは職人本人にしか分からない。工程や言葉の正しさについて書かない。
- 左の暗い部分は字幕を読むための幕で、問題ではない。「テスト」の黄色い札は試験の印で、問題ではない。
- 「ここは職人に確認」の表示はわざと出している。問題ではない。"""


def fix_system():
    api = api_doc()
    return f"""職人本人が、できた3Dページを見ながら「ここは違う」と言いました。本人の言葉どおりに直す案を作ります。

変えられるもの（changes）:
- set_text: 場面の文。変えない欄は空文字。basis は本人の今の言葉から抜き書き。confirm は確認が要らなければ空。
- add_chapter / remove_chapter / move_chapter: 場面を足す・消す・順番を変える。after は前に来る場面ID（先頭なら空文字）。
- set_camera: 見せ方。
- edit_code: 物の形・色・数・動きをコードの置きかえで変える。find はコードの中に**ちょうど1回だけ**出てくる文字列をそのまま。why は何を変えたかを小学生にも分かる言葉で。

きまり:
- 本人が言ったことだけを直す。ついでに他を良くしない。
- **3Dで見せている物についての直しは、文だけでなく edit_code か set_camera で3Dも変える。**
- できない直し（別の物に作りかえる、ページの外のこと等）は、できたふりをせず out_of_scope に書く。
- summary は「何をどう直す案か」を1文で。focus_chapter は直した所がよく見える場面ID。

{api}

{RULES}"""


# ===== 頼む =====
def corpus(project):
    parts = [str(v) for v in project["intake"].values()]
    parts += [q["a"] for q in project["qa"] if q.get("a")]
    parts += project.get("said", [])
    return "\n".join(parts)


def qa_payload(project):
    return {
        "job": project["intake"].get("job"), "work": project["intake"].get("work"), "looks": project["intake"].get("looks"),
        "qa": [{"axis": AXES.get(q["axis"], q["axis"]), "question": q["q"], "answer": q.get("a") or "（わからない・飛ばした）"} for q in project["qa"]],
    }


def next_question(ask, project):
    data = qa_payload(project)
    data["asked"] = len(project["qa"])
    data["max_questions"] = MAX_QUESTIONS
    data["axes_not_asked"] = [AXES[a] for a in AXES if a not in {q["axis"] for q in project["qa"]}]
    raw, model = ask("question", interview_system(), data, QUESTION_SCHEMA, effort="low", max_tokens=4000)
    if not isinstance(raw, dict):
        raise SpecError(["返事の形が違います"])
    done = bool(raw.get("done")) or not str(raw.get("question") or "").strip()
    q = str(raw.get("question") or "").strip()
    if not done and guard(q):  # 聞き手が書けない言葉を持ち出さない
        raw, model = ask("question", interview_system(), {**data, "note": "前の質問に使えない言葉が入っていました。別の聞き方にしてください。"}, QUESTION_SCHEMA, effort="low", max_tokens=4000)
        q = str(raw.get("question") or "").strip()
        done = bool(raw.get("done")) or not q
        if not done and guard(q):
            raise SpecError(["質問に書けない言葉が入ったままでした"])
    if not done and not is_japanese(q):  # 職人の画面に出るので日本語だけ
        raw, model = ask("question", interview_system(), {**data, "note": "前の質問が日本語ではありませんでした。日本語で聞いてください。"}, QUESTION_SCHEMA, effort="low", max_tokens=4000)
        q = str(raw.get("question") or "").strip()
        done = bool(raw.get("done")) or not q
        if not done and (guard(q) or not is_japanese(q)):
            raise SpecError(["質問を日本語で作れませんでした"])
    axis = raw.get("axis") if raw.get("axis") in AXES else "tema"
    return {"done": done, "axis": axis, "axis_name": AXES[axis], "question": q}


def write_script(ask, project, on_text=None, note=""):
    data = qa_payload(project)
    if note:
        data["note"] = note
    raw, model = ask("script", script_system(), data, SCRIPT_SCHEMA, effort="high", max_tokens=24000, on_text=on_text)
    return raw, model


def write_scene(ask, project, script, on_text=None):
    data = {"job": project["intake"].get("job"), "work": project["intake"].get("work"),
            "chapters": [{"id": c["id"], "title": c["title"], "body": c["body"], "image_note": c.get("image_note") or ""} for c in script["chapters"]],
            "art": script.get("art") or {}, "scene_plan": script.get("scene_plan", "")}
    raw, model = ask("scene", scene_system(), data, SCENE_SCHEMA, effort=SCENE_EFFORT, max_tokens=48000, on_text=on_text)
    return raw, model


def ask_repair(ask, spec, problems, code_lines=None, on_text=None, work="", images=None):
    """images = 問題が見つかった画面（[{"data": base64, "chapter":…, "view":…}]）。直す係にも絵を見せる。"""
    data = {"problems": problems, "work": work, "code": spec["code"], "chapters": public_chapters(spec)}
    if code_lines:
        data["error_lines"] = code_lines
    user = data
    if images:
        user = []
        for i, im in enumerate(images, 1):
            user.append({"type": "text", "text": f"問題が見つかった画面{i}: 場面「{im.get('chapter')}」 {im.get('view')}"})
            user.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": im["data"]}})
        user.append({"type": "text", "text": json.dumps(data, ensure_ascii=False)})
    raw, model = ask("repair", repair_system(), user, REPAIR_SCHEMA, effort=FIX_EFFORT, max_tokens=32000, on_text=on_text)
    return raw, model


def timeline(n):
    """kit.js と同じ計算。場面ごとの (a, b)。"""
    gap = min(.018, .16 / n)
    return [(i / n + (gap if i else 0), (i + 1) / n - (gap if i < n - 1 else 0)) for i in range(n)]


def review_points(spec):
    """Claude に見せる画面の一覧：各場面の真ん中＋切り替わりの途中＋スマホ。"""
    tl = timeline(len(spec["chapters"]))
    pts = []
    for c, (a, b) in zip(spec["chapters"][:8], tl):
        pts.append({"p": round((a + b) / 2, 4), "chapter": c["id"], "w": 960, "h": 540, "view": "PC"})
    mid = len(tl) // 2
    if mid:
        pts.append({"p": round(tl[mid][0] - .004, 4), "chapter": spec["chapters"][mid]["id"], "w": 960, "h": 540, "view": "PC・場面の切り替わりの途中"})
    longest = max(range(len(tl)), key=lambda i: len(plain(spec["chapters"][i]["body"])))
    a, b = tl[longest]
    pts.append({"p": round((a + b) / 2, 4), "chapter": spec["chapters"][longest]["id"], "w": 450, "h": 800, "view": "スマホ"})
    if len(tl) > 1:  # 見せ場はスマホでも見る（名札や主役が字幕の下に入りやすい）
        other = (longest + len(tl) // 2) % len(tl)
        a, b = tl[other]
        pts.append({"p": round((a + b) / 2, 4), "chapter": spec["chapters"][other]["id"], "w": 450, "h": 800, "view": "スマホ"})
    return pts


def ask_review(ask, images, spec, round_no, work="", on_text=None):
    """images = [{"data": base64, "p":…, "chapter":…, "view":…}]"""
    content = []
    for i, im in enumerate(images, 1):
        content.append({"type": "text", "text": f"画像{i}: 場面「{im.get('chapter')}」 {im.get('view')}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": im["data"]}})
    content.append({"type": "text", "text": json.dumps({
        "round": round_no, "work": work,
        "chapters": [{"id": c["id"], "title": plain(c["title"]), "body": plain(c["body"])} for c in spec["chapters"]],
    }, ensure_ascii=False)})
    raw, model = ask("review", review_system(), content, REVIEW_SCHEMA, effort=REVIEW_EFFORT, max_tokens=12000, on_text=on_text)
    if not isinstance(raw, dict):
        raise SpecError(["確かめた返事の形が違います"])
    if not _review_in_japanese(raw):  # 職人の画面に出るので、英語のまま通さない
        again = content + [{"type": "text", "text": "前の返事に日本語でない文がありました。reason と seen と how_to_fix を、すべて日本語で書き直してください。"}]
        raw2, model = ask("review", review_system(), again, REVIEW_SCHEMA, effort="medium", max_tokens=12000, on_text=on_text)
        if isinstance(raw2, dict):
            raw = raw2
    issues = []
    for it in raw.get("issues") or []:
        n = it.get("image")
        if isinstance(n, int) and 1 <= n <= len(images) and str(it.get("seen") or "").strip():  # 画像に結びつかない指摘は使わない
            name = REVIEW_ITEMS.get(it.get("item"), "")
            seen = str(it["seen"]) if is_japanese(it["seen"]) else f"画像{n}に直したい所があります（{name or '見た目'}）"
            fix = str(it.get("how_to_fix") or "")
            issues.append({"image": n, "item": it.get("item"), "item_name": name, "severity": "high" if it.get("severity") == "high" else "low",
                           "seen": seen[:240], "how_to_fix": (fix if is_japanese(fix) else "")[:240], "raw_seen": str(it["seen"])[:240], "raw_fix": fix[:240], "chapter": images[n - 1].get("chapter")})
    reason = str(raw.get("reason") or "")
    if not is_japanese(reason):
        reason = "理由の文を日本語にできませんでした。見つかった問題は下の一覧を見てください。" if issues else "問題は見つかりませんでした。"
    if not raw.get("passed") and not issues:  # 不合格なのに指摘が無いときは、理由を指摘にして直させる
        issues.append({"image": 1, "item": "imi", "item_name": REVIEW_ITEMS["imi"], "severity": "high", "seen": reason[:240], "how_to_fix": "", "raw_seen": reason[:240], "raw_fix": "", "chapter": images[0].get("chapter") if images else ""})
    # low も通さない。合否は機械が決める（指摘が1つでもあれば不合格）
    return {"passed": not issues, "reason": reason[:400], "issues": issues, "model": model}


def ask_fix(ask, spec, utterance, ctx, on_text=None, note=""):
    data = {"said_now": utterance, "seeing": ctx, "chapters": public_chapters(spec), "code": spec["code"]}
    if note:
        data["note"] = note
    raw, model = ask("fix", fix_system(), data, FIX_SCHEMA, effort="medium", max_tokens=16000, on_text=on_text)
    return raw, model


def public_chapters(spec):
    return [{k: c.get(k) for k in ("id", "title", "body", "confirm", "image_note", "cam")} for c in spec["chapters"]]


# ===== 検査 =====
def plain(text):
    return re.sub(r"<[^>]+>", "", text or "")


def is_japanese(text):
    """職人の画面に出す文か。かな・漢字があり、英字ばかりでないこと。"""
    t = str(text or "").strip()
    if not t:
        return True
    jp = len(re.findall(r"[\u3040-\u30ff\u3400-\u9fff]", t))
    latin = len(re.findall(r"[A-Za-z]", t))
    return jp >= 2 and latin <= jp * .6


def _review_in_japanese(raw):
    texts = [raw.get("reason")]
    for it in raw.get("issues") or []:
        texts += [it.get("seen"), it.get("how_to_fix")]
    return all(is_japanese(t) for t in texts)


def check_markup(text, what, errors):
    """使えるのは <br> と <em> だけ。& と残りの < > は使えない。"""
    rest = re.sub(r"<br\s*/?>|</?em>", "", text or "")
    if re.search(r"[<>&]", rest):
        errors.append(f"{what}: 使えない記号やタグが入っています")
    if (text or "").count("<em>") != (text or "").count("</em>"):
        errors.append(f"{what}: <em> の閉じ忘れ")


def num_list(v, n):
    return isinstance(v, list) and len(v) == n and all(isinstance(x, (int, float)) and not isinstance(x, bool) and abs(x) < 1e4 for x in v)


def check_cam(cam, what, errors):
    if not isinstance(cam, list) or not 1 <= len(cam) <= 2:
        errors.append(f"{what}: カメラは1つか2つ")
        return
    for e in cam:
        if not isinstance(e, dict) or not num_list(e.get("look"), 3) or not num_list(e.get("dir"), 3) or not isinstance(e.get("r"), (int, float)) or not .03 <= e["r"] <= 200:
            errors.append(f"{what}: カメラの look / dir は数字3つ、r は物の半径")
        elif not any(abs(x) > 1e-3 for x in e["dir"]):
            errors.append(f"{what}: カメラの dir が 0 です")


FORBID = [
    (r"\b(window|document|globalThis|navigator|localStorage|sessionStorage|indexedDB|cookie)\b", "ページの外や保存場所に触っています"),
    (r"\b(fetch|XMLHttpRequest|WebSocket|EventSource|Worker|SharedWorker|importScripts|postMessage|sendBeacon)\b", "通信はできません"),
    (r"\bimport\b|\brequire\s*\(", "外から読み込むことはできません"),
    (r"\beval\s*\(|\bFunction\s*\(|\.constructor\b", "文字列をコードとして動かせません"),
    (r"https?:|wss?:|//cdn", "外のアドレスは書けません"),
    (r"</?script|<!--|<iframe", "タグは書けません"),
    (r"\b(parent|top|opener)\s*\.\s*(postMessage|location|document|window)", "外の画面には触れません"),
]


def check_code(code):
    errors = []
    if not isinstance(code, str) or not code.strip():
        return ["コードがありません"]
    if len(code) > MAX_CODE:
        errors.append(f"コードが長すぎます（{len(code)}文字）")
    for pat, why in FORBID:
        m = re.search(pat, code)
        if m:
            errors.append(f"コードの「{m.group(0)}」: {why}")
    return errors


def validate_spec(spec):
    """形の検査。だめなら直す材料として文の一覧を返す。"""
    errors = []
    chs = spec.get("chapters")
    if not isinstance(chs, list) or not MIN_CHAPTERS <= len(chs) <= MAX_CHAPTERS:
        return [f"場面は{MIN_CHAPTERS}〜{MAX_CHAPTERS}個にする（今は{len(chs) if isinstance(chs, list) else 0}個）"]
    seen = set()
    for c in chs:
        cid = str(c.get("id"))
        if not ID_RE.match(cid):
            errors.append(f"場面ID「{cid}」: 英小文字で始める")
        if cid in seen:
            errors.append(f"場面ID「{cid}」が重なっています")
        seen.add(cid)
        for key, cap in (("title", MAX_TITLE), ("body", MAX_BODY)):
            text = c.get(key)
            if not isinstance(text, str) or not plain(text).strip():
                errors.append(f"場面「{cid}」の{key}がありません")
                continue
            if len(plain(text)) > cap:
                errors.append(f"場面「{cid}」の{key}が長すぎます（{len(plain(text))}字・{cap}字まで）")
            check_markup(text, f"場面「{cid}」の{key}", errors)
        note = c.get("image_note") or ""
        if len(note) > MAX_IMG or re.search(r"[<>&]", note):
            errors.append(f"場面「{cid}」の image_note は{MAX_IMG}字までの文字だけ")
        if "cam" in c:
            check_cam(c["cam"], f"場面「{cid}」", errors)
    for key in ("accent", "night"):
        if not HEX_RE.match(str(spec.get(key))):
            errors.append(f"{key} は #rrggbb で書く")
    for key in ("tag", "note", "title"):
        if not isinstance(spec.get(key), str) or len(spec[key]) > 80 or re.search(r"[<>&]", spec[key]):
            errors.append(f"{key} は80字までの文字だけ")
    return errors


def guard_lines(spec):
    return [f"{h['where']}に「{h['word']}」: {h['reason']}" for h in guard_spec(spec)]


def guard_spec(spec):
    """ページに出る文字すべてとコードの中を見る。"""
    hits = []
    for key in ("title", "tag", "note"):
        for h in guard(spec.get(key)):
            hits.append({**h, "where": key})
    for c in spec.get("chapters", []):
        for key in ("title", "body", "confirm", "image_note"):
            for h in guard(c.get(key)):
                hits.append({**h, "where": f"場面「{c.get('id')}」の{key}"})
    for u in spec.get("unknowns", []):
        for h in guard(u):
            hits.append({**h, "where": "確認リスト"})
    # コードの中は文字列とコメントだけ見る（識別子で誤って止めない）
    for frag in re.findall(r"'(?:[^'\\\n]|\\.)*'|\"(?:[^\"\\\n]|\\.)*\"|`(?:[^`\\]|\\.)*`|//[^\n]*", spec.get("code") or ""):
        for h in guard(frag):
            hits.append({**h, "where": "コードの中の文字"})
    return hits


def _squash(text):
    t = unicodedata.normalize("NFKC", plain(text or "")).lower()
    return re.sub(r"[\s、。，．,.・！？!?「」『』（）()…ー〜~\-—]", "", t)


NUM_RE = re.compile(r"\d+(?:\.\d+)?|[一二三四五六七八九十百千]+(?=(?:時間|分|秒|日|週|か月|カ月|ヶ月|月|年|回|枚|層|度|人|本|個|cm|mm|センチ|ミリ|メートル))")


def fact_check(spec, words):
    """言っていないことを事実にしない。元の言葉が見つからない場面は「ここは職人に確認」にする。"""
    said = _squash(words)
    said_nfkc = unicodedata.normalize("NFKC", words or "")
    flagged = []
    for c in spec["chapters"]:
        if c.get("checked") and not c.get("confirm"):  # 本人が「合っている」と言った場面
            continue
        reasons = []
        basis = _squash(c.get("basis"))
        if not basis:
            reasons.append("この場面の元になった言葉がありません。合っていますか？")
        elif basis not in said:
            reasons.append("この場面の元になった言葉が、聞き取りの中に見つかりません。合っていますか？")
        text = unicodedata.normalize("NFKC", plain(c.get("title", "")) + " " + plain(c.get("body", "")))
        missing = [n for n in NUM_RE.findall(text) if n not in said_nfkc]
        if missing:
            reasons.append(f"「{'、'.join(dict.fromkeys(missing))}」という数字は聞き取りにありません。合っていますか？")
        if reasons and not c.get("confirm"):
            c["confirm"] = reasons[0] if len(reasons) == 1 else reasons[1]
        if c.get("confirm"):
            flagged.append(c["id"])
    return flagged


def tidy_script(script, project):
    """形だけ整える（中身は変えない）。場面IDがだめなら機械で付け直す＝3Dの係が見る前に直す。"""
    used = set()
    work = project["intake"].get("work") or "仕事"
    for i, c in enumerate(script.get("chapters") or []):
        cid = str(c.get("id") or "")
        if not ID_RE.match(cid) or cid in used:
            cid = f"s{i + 1}"
        c["id"] = cid
        used.add(cid)
    clean = lambda v, cap: re.sub(r"[<>&]", "", str(v or "")).strip()[:cap]
    script["page_title"] = clean(script.get("page_title"), 60) or clean(work, 60)
    script["tag"] = clean(script.get("tag"), 60) or clean(f"見えない仕事　{work}", 60)
    script["note"] = clean(script.get("note"), 80) or "説明のための図です。形や大きさは実物と同じではありません"
    if not HEX_RE.match(str(script.get("accent"))):
        script["accent"] = "#f2c230"
    if not HEX_RE.match(str(script.get("night"))):
        script["night"] = "#14161a"
    script["unknowns"] = [str(u).strip()[:120] for u in (script.get("unknowns") or []) if str(u).strip()][:12]
    for c in script.get("chapters") or []:
        c["image_note"] = clean(c.get("image_note"), MAX_IMG)
    return script


def check_script(script):
    """3Dを作る前に、台本だけで見つかる問題。"""
    spec = merge_spec(script, {"cameras": [], "code": ""})
    for c in spec["chapters"]:
        c.pop("cam", None)
    errors = validate_spec(spec)
    for h in guard_spec(spec):
        errors.append(f"{h['where']}に「{h['word']}」: {h['reason']}")
    return list(dict.fromkeys(errors))


def merge_spec(script, scene):
    cams = {c.get("id"): c.get("cam") for c in scene.get("cameras", [])}
    chapters = []
    for c in script.get("chapters", []):
        chapters.append({"id": c.get("id"), "title": c.get("title"), "body": c.get("body"), "basis": c.get("basis", ""),
                         "confirm": (c.get("confirm") or "").strip(), "image_note": (c.get("image_note") or "").strip(), "cam": cams.get(c.get("id"))})
    return {"title": script.get("page_title") or "", "tag": script.get("tag") or "", "note": script.get("note") or "", "kit": 2,
            "accent": script.get("accent"), "night": script.get("night"), "chapters": chapters,
            "unknowns": [str(u) for u in script.get("unknowns", []) if str(u).strip()], "code": scene.get("code", "")}


def check_all(spec):
    """動かす前に分かるエラーをまとめて返す。"""
    errors = validate_spec(spec)
    for c in spec.get("chapters", []):
        if not c.get("cam"):
            errors.append(f"場面「{c.get('id')}」のカメラがありません")
    errors += check_code(spec.get("code"))
    ids = {c.get("id") for c in spec.get("chapters", [])}
    for m in re.finditer(r"\b(?:go|on|since|until)\(\s*['\"]([^'\"]+)['\"]", spec.get("code") or ""):
        if m.group(1) not in ids:
            errors.append(f"コードが場面ID「{m.group(1)}」を使っていますが、そんな場面はありません")
    return list(dict.fromkeys(errors))


# ===== 置きかえ =====
def apply_edits(code, edits):
    """find は1回だけ出てくること。なければ空白の違いだけ見直す。"""
    errors = []
    for e in edits or []:
        find, rep = e.get("find") or "", e.get("replace") or ""
        if not find:
            errors.append("edit の find が空です")
            continue
        n = code.count(find)
        if n == 1:
            code = code.replace(find, rep)
            continue
        if n > 1:
            errors.append(f"「{find[:40]}」がコードに{n}回あります。1回だけの所を書く")
            continue
        pat = r"\s+".join(re.escape(part) for part in find.split())
        hits = list(re.finditer(pat, code))
        if len(hits) == 1:
            code = code[:hits[0].start()] + rep + code[hits[0].end():]
        else:
            errors.append(f"「{find[:40]}」がコードに見つかりません")
    return code, errors


def chapter_of(spec, cid):
    for c in spec["chapters"]:
        if c["id"] == cid:
            return c
    return None


def apply_fix(spec, changes):
    """変更案を当てる。元の spec は変えない。(新しい spec, 前後の一覧, エラー) を返す。"""
    new = json.loads(json.dumps(spec, ensure_ascii=False))
    diff, errors = [], []
    for ch in changes or []:
        kind = ch.get("type")
        if kind == "set_text":
            c = chapter_of(new, ch.get("chapter"))
            if not c:
                errors.append(f"場面「{ch.get('chapter')}」がありません")
                continue
            before = plain(c["title"]) + " / " + plain(c["body"])
            if ch.get("title"):
                c["title"] = ch["title"]
            if ch.get("body"):
                c["body"] = ch["body"]
            if ch.get("basis"):
                c["basis"] = ch["basis"]
            c["confirm"] = (ch.get("confirm") or "").strip()
            c.pop("checked", None)
            diff.append({"kind": "text", "label": "場面の文", "before": before, "after": plain(c["title"]) + " / " + plain(c["body"]), "chapter": c["id"]})
        elif kind == "add_chapter":
            cid = ch.get("id")
            if chapter_of(new, cid):
                errors.append(f"場面ID「{cid}」はもうあります")
                continue
            item = {"id": cid, "title": ch.get("title"), "body": ch.get("body"), "basis": ch.get("basis", ""), "confirm": (ch.get("confirm") or "").strip(), "cam": ch.get("cam")}
            at = 0 if not ch.get("after") else next((i + 1 for i, c in enumerate(new["chapters"]) if c["id"] == ch["after"]), None)
            if at is None:
                errors.append(f"場面「{ch.get('after')}」がありません")
                continue
            new["chapters"].insert(at, item)
            diff.append({"kind": "add", "label": "場面を足す", "before": "（なし）", "after": plain(ch.get("title")), "chapter": cid})
        elif kind == "remove_chapter":
            c = chapter_of(new, ch.get("chapter"))
            if not c:
                errors.append(f"場面「{ch.get('chapter')}」がありません")
                continue
            new["chapters"].remove(c)
            diff.append({"kind": "remove", "label": "場面を消す", "before": plain(c["title"]), "after": "（なし）"})
        elif kind == "move_chapter":
            c = chapter_of(new, ch.get("chapter"))
            if not c:
                errors.append(f"場面「{ch.get('chapter')}」がありません")
                continue
            before = "→".join(plain(x["title"])[:10] for x in new["chapters"])
            new["chapters"].remove(c)
            at = 0 if not ch.get("after") else next((i + 1 for i, x in enumerate(new["chapters"]) if x["id"] == ch["after"]), None)
            if at is None:
                errors.append(f"場面「{ch.get('after')}」がありません")
                new["chapters"].append(c)
                continue
            new["chapters"].insert(at, c)
            diff.append({"kind": "order", "label": "場面の順番", "before": before, "after": "→".join(plain(x["title"])[:10] for x in new["chapters"]), "chapter": c["id"]})
        elif kind == "set_camera":
            c = chapter_of(new, ch.get("chapter"))
            if not c:
                errors.append(f"場面「{ch.get('chapter')}」がありません")
                continue
            c["cam"] = ch.get("cam")
            diff.append({"kind": "camera", "label": "3Dの見せ方", "before": "前の見せ方", "after": "向きを変えました", "chapter": c["id"]})
        elif kind == "edit_code":
            code, errs = apply_edits(new["code"], [ch])
            if errs:
                errors += errs
                continue
            new["code"] = code
            diff.append({"kind": "code", "label": "3Dの物", "before": "前の形", "after": plain(ch.get("why") or "形や動きを変えました")[:120]})
        else:
            errors.append(f"知らない変更: {kind}")
    return new, diff, errors


def apply_repair(spec, raw):
    new = json.loads(json.dumps(spec, ensure_ascii=False))
    new["code"], errors = apply_edits(new["code"], (raw or {}).get("edits"))
    for t in (raw or {}).get("camera_fixes") or []:
        c = chapter_of(new, t.get("chapter"))
        if not c:
            errors.append(f"場面「{t.get('chapter')}」がありません")
            continue
        c["cam"] = t.get("cam")
    for t in (raw or {}).get("text_fixes") or []:
        c = chapter_of(new, t.get("chapter"))
        if not c:
            errors.append(f"場面「{t.get('chapter')}」がありません")
            continue
        if t.get("title"):
            c["title"] = t["title"]
        if t.get("body"):
            c["body"] = t["body"]
    return new, errors


# ===== 1枚のHTMLにする（/p/<id> と「コードをコピー」は同じ中身）=====
def _script_json(obj):
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return text.replace("<", "\\u003c").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build_html(spec, test=False):
    """(HTML, コードが始まる行番号) を返す。"""
    tpl = (KIT / "page.html").read_text(encoding="utf-8")
    kit = (KIT / "kit.js").read_text(encoding="utf-8").replace("/*{{PARTS}}*/", (KIT / "parts.js").read_text(encoding="utf-8"))
    data = {"tag": spec["tag"], "note": spec["note"], "accent": spec["accent"], "night": spec["night"], "test": bool(test), "kit": spec.get("kit") or 1,
            "chapters": [{"id": c["id"], "title": c["title"], "body": c["body"], "confirm": c.get("confirm") or "", "image_note": c.get("image_note") or "", "cam": c["cam"]} for c in spec["chapters"]]}
    title = re.sub(r"[<>&\"]", "", spec.get("title") or "見えない仕事")
    head, rest = tpl.split("{{CODE}}")
    head = head.replace("{{TITLE}}", title)
    head = head.replace("{{SPEC}}", _script_json(data))
    head = head.replace("{{KIT}}", kit)
    start = head.count("\n") + 1
    return head + spec["code"].replace("</", "<\\/") + rest, start


def lines_of(spec, start, lines):
    """エラーの行番号を、コードの行の中身に直す（Claude が直しやすいように）。"""
    code = spec["code"].split("\n")
    out = []
    for ln in lines or []:
        i = (ln or 0) - start
        if 0 <= i < len(code):
            out.append({"line": i + 1, "text": code[i][:200]})
    return out
