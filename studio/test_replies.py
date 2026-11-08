"""試験モード専用：Claude の代わりに手書きの返事を返す。本番では読み込まれない。

`--test` のときだけ使う。ここの文は実際の職人の言葉ではなく、画面の流れを確かめるための作りものです。

見せたい仕事の欄に次の言葉を入れると、わざと失敗の道を通る:
  壊れる1   … 1回目は動かない → 直して動く
  壊れる2   … 何度直しても動かない → 正直に止まる
  二回とも  … 2回とも見た目に問題が残る → 残った問題を画面に出す
  悪くなる  … 直したら動かなくなる → 前の版に戻す
  禁止語入り … 台本に止める言葉が混ざる → 書き直させる
  禁止語消えない … 何度書かせても止める言葉が残る → 正直に止まる
  英語      … 1回目の目の返事が英語 → 日本語で聞き直す
  英語消えない … 目の返事がずっと英語 → 英語を画面に出さない
  小さい指摘 … 小さい指摘（low）だけで「合格」と言う → 不合格にして直させる
  灯油      … 答えが少ない車の見本（実際に飛ばしが多かった例）
  名札隠れ  … 名札の先が物に隠れる → Claudeの目と一緒に1回で直す
  防護服    … 粘土（K.clay）で作った防護服の作業者の見本
何も入れなければ、1回目は不合格 → 直して合格。
"""
import base64
import json
import pathlib
import re
import time

from brain import KIT

FAKE_MODEL = "手書きの試験データ（Claudeではない）"
INTAKE_ANSWERS = {"job": "表具師（ふすまの張り替え）", "work": "ふすまの張り替え", "looks": "いちばん上の紙の柄"}
QUESTIONS = [
    ("tema", "ふすまの中には、お客さんに見えない手間がありますか？",
     "古い紙をはがして、中の骨の傷みを見ます。お客さんは上の紙しか見ていません。"),
    ("shippai", "素人がやると、どこで失敗しますか？",
     "下の紙を飛ばして上の紙だけ貼ると、骨の形が表に出てしまいます。"),
    ("junban", "やる順番を教えてください。",
     "古い紙をはがす、骨を見る、下の紙を3枚重ねて貼る、乾かす、上の紙を貼る、の順です。"),
    ("matsu", "待つ時間はありますか？",
     "下の紙を貼ったあとは、乾くまで待ちます。乾く前に上の紙を貼ると、しわになります。"),
]
SCRIPT = {
    "page_title": "ふすまの見えない紙",
    "tag": "見えない仕事　ふすまの張り替え（試験）",
    "note": "試験の見本です。説明のための図で、形や大きさは実物と同じではありません",
    "accent": "#e8b23a", "night": "#14161a",
    "chapters": [
        {"id": "omote", "title": "お客さんが見るのは、<br><em>上の紙</em>だけです。", "body": "ふすまの中に、どんな仕事があると思いますか。", "basis": "お客さんは上の紙しか見ていません。", "confirm": ""},
        {"id": "hone", "title": "まず、古い紙をはがして<br><em>骨</em>を見る。", "body": "はがすと、中の骨が出てきます。傷みがないかを見ます。", "basis": "古い紙をはがして、中の骨の傷みを見ます。", "confirm": ""},
        {"id": "shita", "title": "見えなくなる紙を、<br><em>3枚</em>重ねて貼る。", "body": "下の紙を飛ばすと、骨の形が表に出てしまいます。", "basis": "下の紙を飛ばして上の紙だけ貼ると、骨の形が表に出てしまいます。", "confirm": ""},
        {"id": "matsu", "title": "貼ったら、<br><em>乾くまで待つ。</em>", "body": "乾く前に上の紙を貼ると、しわになります。", "basis": "乾く前に上の紙を貼ると、しわになります。", "confirm": "乾くまで、どれくらい待ちますか？", "image_note": "ぬれている所を色で表した絵です"},
        {"id": "uwa", "title": "それから、<br>上の紙を貼る。", "body": "ここでやっと、お客さんの見る柄が出てきます。", "basis": "上の紙を貼る、の順です。", "confirm": ""},
        {"id": "ato", "title": "見えるのは上の紙。<br><em>中には何枚もある。</em>", "body": "上の紙の下に、見えない仕事が重なっています。", "basis": "お客さんは上の紙しか見ていません。", "confirm": ""},
    ],
    "unknowns": ["下の紙を貼るときに使うのりは、どんなものですか？"],
    "art": {"place": "room", "place_why": "ふすまは和室にある物だから", "hero": "敷居に立つふすま。引手と黒い縁で一目で分かる形", "invisible": "紙の下の骨と重なり。のりの湿りは青い色で見せる", "showpiece": "matsu 部屋を暗くして、ぬれている所を浮かび上がらせる"},
    "scene_plan": "ふすまを立てて見せる。古い紙をはがす→骨→下の紙3枚→待つ→上の紙→層を分けて見せる。",
}
CAMERAS = [
    {"id": "omote", "cam": [{"look": [0, .95, 0], "r": 1.25, "dir": [.45, .12, 1]}, {"look": [0, .95, 0], "r": 1.2, "dir": [.3, .1, 1]}]},
    {"id": "hone", "cam": [{"look": [0, .95, 0], "r": 1.2, "dir": [-.25, .1, 1]}, {"look": [.05, 1.1, 0], "r": .85, "dir": [-.45, .18, 1]}]},
    {"id": "shita", "cam": [{"look": [0, 1, .03], "r": 1.05, "dir": [.5, .2, 1]}, {"look": [0, 1, .03], "r": 1, "dir": [.35, .25, 1]}]},
    {"id": "matsu", "cam": [{"look": [0, .95, 0], "r": 1.15, "dir": [-.1, .05, 1]}, {"look": [0, .95, 0], "r": 1.1, "dir": [.05, .05, 1]}]},
    {"id": "uwa", "cam": [{"look": [0, .95, .03], "r": 1.15, "dir": [.6, .15, 1]}, {"look": [0, .95, .03], "r": 1.15, "dir": [.35, .12, 1]}]},
    {"id": "ato", "cam": [{"look": [.04, 1, .22], "r": 1.3, "dir": [1, .3, .9]}, {"look": [.04, 1, .22], "r": 1.3, "dir": [1.2, .28, .75]}]},
]
# 答えが少なかった実例（01565c6d と同じ入力）。1つしか答えがなくても、見せ場を弱くしない
SCRIPT_CAR = {
    "page_title": "車の中の灯油のにおい",
    "tag": "見えない仕事　車の中のにおい取り（試験）",
    "note": "試験の見本です。説明のための図で、形や大きさは実物と同じではありません",
    "accent": "#ffb347", "night": "#10141c",
    "chapters": [
        {"id": "car", "title": "お客さんが見るのは、<br><em>においが残っているかどうか</em>。", "body": "灯油をこぼした車の中の、においを取る仕事です。", "basis": "灯油をこぼした車の中の、においを取る仕事", "confirm": ""},
        {"id": "inside", "title": "外から見ても、<br>分かりません。", "body": "車の中の灯油のあとは、外からは見えません。", "basis": "車の中のにおいが残っているかどうか", "confirm": "灯油のあとは、どこにいちばん残りますか？"},
        {"id": "smell", "title": "灯油は、においが<br><em>なかなか取れません</em>。", "body": "目に見えないにおいが、車の中に残っているのです。", "basis": "灯油は、においがなかなか取れません。", "confirm": "", "image_note": "においを色の帯で表した絵です"},
        {"id": "agent", "title": "使うのは、<br><em>灯油専用</em>の消臭の薬剤。", "body": "どう使うかは、職人に聞いてから書きます。", "basis": "灯油専用の消臭の薬剤を使っています。", "confirm": "どこに、どのくらい使いますか？"},
    ],
    "unknowns": ["薬剤をどこに、どのくらい使いますか？"],
    "art": {"place": "snow_night", "place_why": "灯油を使う冬の家の前が似合う", "hero": "ふつうの乗用車。透けると中のマットと座席が見える", "invisible": "においは立ちのぼる橙色の帯、灯油のあとは床のしみ", "showpiece": "smell 世界を暗くして、車の中から立ちのぼる帯を見せる"},
    "scene_plan": "雪の夜の車→外側を透かす→しみとにおいの帯→薬剤の入れ物。",
}
CAMERAS_CAR = [
    {"id": "car", "cam": [{"look": [0, .75, 0], "r": 2.45, "dir": [1, .2, 1]}, {"look": [0, .75, 0], "r": 2.3, "dir": [.8, .18, 1]}]},
    {"id": "inside", "cam": [{"look": [-.2, .8, 0], "r": 2.6, "dir": [.25, .5, 1]}, {"look": [-.3, .75, 0], "r": 2.2, "dir": [.05, .62, 1]}]},
    {"id": "smell", "cam": [{"look": [-.5, .75, 0], "r": 1.9, "dir": [-.15, .68, 1]}, {"look": [-.55, .8, 0], "r": 1.75, "dir": [-.3, .6, 1]}]},
    {"id": "agent", "cam": [{"look": [-.3, .8, 0], "r": 1.9, "dir": [.4, .5, 1]}, {"look": [-.25, .8, 0], "r": 1.8, "dir": [.55, .45, 1]}]},
]
CODE_CAR = """const {world,car,bottle,stain,wisp,label,go,on,since,until} = K;
const w=world('snow_night',{clear:6});
const c=car({kind:'wagon',color:'#b9c0c9',at:[0,0,0],seat:'#8a8e93'});
const s1=stain(c.spot('rear_mat_r'),.3,{name:'こぼれた灯油のあと'});
const s2=stain(c.spot('rear_mat_l'),.2,{});
const smell=wisp(c.spot('rear_mat_r'),{n:7,spread:[.2,0,.18],height:1.05,width:.17,name:'におい'});
const smell2=wisp([-.3,.62,-.2],{n:9,spread:[1.25,.05,.55],height:.8,width:.14,opacity:.55});
const b=bottle({at:[.9,0,1.45],h:.42,r:.11,text:'灯油専用\\n消臭の薬剤',name:'灯油専用の消臭の薬剤'});
label('車の中',c.spot('seat_front_r'),{on:'inside',from:.7});
label('灯油のあと',c.spot('rear_mat_r'),{on:'smell'});
label('灯油専用の消臭の薬剤',[.9,.34,1.45],{on:'agent'});
return function(p,t){
 c.see(since('inside')*go('inside',.25,.85));
 w.dim(1-.55*go('inside',.3,.9));
 s1.set(since('inside')*go('inside',.4,.95));s2.set(since('inside')*go('inside',.5,1));
 const h=go('smell',0,.7);smell.set(h,h>0?1:0);smell2.set(go('smell',.2,.9),go('smell',.2,.5));
 b.visible=since('agent')>.01;
};
"""
# 粘土（K.clay）の見本：防護服を着た作業者が噴霧器で薬剤を吹きつける。見せたい仕事に「防護服」と入れると通る（試験用の作りもの）
SCRIPT_CLAY = {
    "page_title": "防護服の作業",
    "tag": "見えない仕事　防護服での吹きつけ（試験）",
    "note": "試験の見本です。説明のための図で、形や大きさは実物と同じではありません",
    "accent": "#9ad0ff", "night": "#14161a",
    "chapters": [
        {"id": "fuku", "title": "まず、<br><em>防護服</em>を着ます。", "body": "試験の見本です。粘土の部品で作った人の形です。", "basis": "", "confirm": ""},
        {"id": "mask", "title": "顔は、<br>マスクでおおいます。", "body": "試験の見本です。", "basis": "", "confirm": ""},
        {"id": "kiri", "title": "薬剤を、<br><em>霧にして</em>吹きつける。", "body": "試験の見本です。", "basis": "", "confirm": "", "image_note": "霧を白い筋で表した絵です"},
        {"id": "ato", "title": "見えるのは壁。<br>手間は見えない。", "body": "試験の見本です。", "basis": "", "confirm": ""},
    ],
    "unknowns": [],
    "art": {"place": "room", "place_why": "部屋の壁に吹きつける仕事だから", "hero": "防護服の作業者（粘土）", "invisible": "霧を白い筋で見せる", "showpiece": "kiri 部屋を暗くして霧を見せる"},
    "scene_plan": "作業者の全身→マスクに寄る→吹きつけ→後ろから全体。",
}
CAMERAS_CLAY = [
    {"id": "fuku", "cam": [{"look": [-1.3, .9, .2], "r": 1.0, "dir": [-.45, .18, 1]}, {"look": [-1.3, .9, .2], "r": .95, "dir": [-.3, .16, 1]}]},
    {"id": "mask", "cam": [{"look": [-1.4, 1.58, .25], "r": .36, "dir": [-.9, .12, .65]}, {"look": [-1.4, 1.58, .25], "r": .34, "dir": [-.75, .14, .75]}]},
    {"id": "kiri", "cam": [{"look": [-2.1, 1.1, .5], "r": 1.25, "dir": [.15, .3, 1]}, {"look": [-2.1, 1.1, .5], "r": 1.2, "dir": [.3, .3, 1]}]},
    {"id": "ato", "cam": [{"look": [-1.3, .9, .2], "r": 1.1, "dir": [.9, .2, .5]}, {"look": [-1.3, .9, .2], "r": 1.05, "dir": [.8, .22, .7]}]},
]
CODE_CLAY = """const {world,clay,tube,cyl,std,metal,spray,stain,label,go,on,since,until} = K;
const w=world('room',{w:6,d:5,cz:1});            // 奥の壁は z=-1.5
// ===== 作業する人：防護服を着た人を粘土で作る（前は +z。顔は作らない）=====
const SUIT='#ecebe6';
const man=clay([
 {cap:[[.12,.065,-.01],[.12,.06,.13]],r:.068,color:'#33373c',pair:true,k:.02},   // 長ぐつ
 {cap:[[.12,.1,0],[.12,.34,.01]],r:[.074,.07],color:'#33373c',pair:true,k:.02},   // 長ぐつの筒
 {cap:[[.12,.31,.01],[.12,.52,.03],[.11,.86,0]],r:[.083,.088,.105],pair:true,k:.03}, // 脚（ぶかぶかの服）
 {ell:[.12,.5,.075],r:[.06,.05,.025],pair:true,k:.03},                          // ひざのたるみ
 {ell:[0,.95,0],r:[.21,.13,.14]},                                                // 腰
 {ell:[0,1.16,0],r:[.215,.28,.155]},                                            // 胴
 {ell:[0,1.32,.015],r:[.205,.13,.15]},                                          // 胸
 {cap:[[0,1.46,.16],[0,1.18,.17],[0,.95,.15]],r:.014,k:.012},                   // 前のファスナーのふた
 {ball:[0,1.5,-.01],r:.1},                                                      // 首（フード）
 {ell:[0,1.62,-.01],r:[.12,.14,.13]},                                           // 頭（フード）
 {cap:[[.085,1.66,.085],[.07,1.73,.07],[0,1.75,.08],[-.07,1.73,.07],[-.085,1.66,.085],[-.08,1.55,.09],[0,1.5,.1],[.08,1.55,.09],[.085,1.66,.085]],r:.02,k:.02}, // フードのふち
 {ell:[0,1.6,.1],r:[.085,.09,.06],color:'#3b4046',k:.015},                      // マスク
 {ell:[0,1.665,.11],r:[.078,.036,.03],color:'#a9cfe0',k:.008},                  // のぞき窓
 {ball:[.072,1.55,.135],r:.036,color:'#c9a640',k:.008,pair:true},               // マスクの筒
 {cap:[[.2,1.38,0],[.28,1.14,.1],[.19,1.04,.29]],r:[.08,.07,.058]},             // 右うで（ノズルを持つ）
 {cap:[[-.2,1.38,0],[-.29,1.13,.05],[-.17,1.0,.21]],r:[.08,.07,.058]},          // 左うで
 {ball:[.18,1.035,.33],r:.052,color:'#3f86c8',k:.012},                          // 手ぶくろ
 {ball:[-.16,.995,.25],r:.052,color:'#3f86c8',k:.012},
],std({color:SUIT,roughness:.6}),{smooth:.06,at:[-1.3,0,.2],rot:[0,-1.2,0],name:'防護服を着た人'});
// 背中の薬剤タンク（粘土）
const tank=clay([{rbox:[0,1.17,-.235],size:[.32,.44,.15],r:.06},{ell:[0,1.4,-.235],r:[.13,.04,.06],color:'#2f3a33'},{cap:[[-.1,.94,-.23],[.1,.94,-.23]],r:.03,color:'#2f3a33'},{cap:[[.13,1.36,-.16],[.15,1.44,-.04],[.17,1.4,.11],[.14,1.15,.155]],r:.018,color:'#3d454d',k:.01,pair:true}],
 std({color:'#5d8f6c',roughness:.38}),{smooth:.04,at:[-1.3,0,.2],rot:[0,-1.2,0],name:'薬剤のタンク'});
// ノズル（金属の棒）とホース
const lance=K.group({at:[-1.3,0,.2],rot:[0,-1.2,0],name:'ノズル'});
tube([[.18,1.03,.3],[.16,1.04,.55],[.13,1.06,.78]],.011,metal('#b9bdc1'),{parent:lance,name:'ノズル'});
cyl(.018,.012,.06,metal('#8c9196'),{parent:lance,at:[.13,1.06,.8],rot:[Math.PI/2,0,0]});
tube([[-.08,.96,-.24],[-.2,.9,-.12],[-.22,.95,.08],[.16,1.02,.28]],.014,std({color:'#2f3337',roughness:.5}),{parent:lance,name:'ホース'});
// 吹きつけ：ノズルの先 → 奥の壁
const tip=new K.THREE.Vector3(.13,1.06,.83);lance.updateMatrixWorld(true);lance.localToWorld(tip);const T=(tip.x+2.98)/.93,HIT=[-2.98,1.2,tip.z+.36*T];
const sp=spray([tip.x,tip.y,tip.z],HIT,{spread:.22,n:70,color:'#d8f0ff',name:'霧にした薬剤'});
const wet=stain(HIT,.35,{normal:[1,0,0],color:'#7fb8d8',edge:'#cfe8f4',name:'ぬれた所'});
label('防護服',[-1.454,1.3,.26],{on:'fuku'});
return function(p,t){
 sp.set(on('kiri')*go('kiri',.1,.5));
 wet.set(since('kiri')*go('kiri',.3,.9)*.8,since('kiri')*go('kiri',.3,.9));
 w.dim(1-.4*on('kiri'));
};
"""
LABEL_GOOD = "label('骨',[.42,CY+.324,.016],{on:'ato'});"
LABEL_HIDDEN = "label('骨',[-.1,CY+.2,.016],{on:'ato'});"
THROW = "throw new Error('テスト：わざと壊しました');\n"
FIXES = {
    "紙は5枚重ねる": {
        "summary": "下の紙を3枚から5枚に増やします。",
        "focus_chapter": "ato",
        "changes": [
            {"type": "set_text", "chapter": "shita", "title": "見えなくなる紙を、<br><em>5枚</em>重ねて貼る。", "body": "", "basis": "紙は5枚重ねる", "confirm": ""},
            {"type": "edit_code", "find": "[['shita','#d7ceba'],['shita','#ded6c4'],['shita','#e6dfcf']]", "replace": "[['shita','#d7ceba'],['shita','#dbd2bf'],['shita','#ded6c4'],['shita','#e2dbca'],['shita','#e6dfcf']]", "why": "3Dの下の紙を5枚にしました"},
        ],
        "out_of_scope": [],
    },
    "骨はもっと太い": {
        "summary": "骨の木を太くします。",
        "focus_chapter": "hone",
        "changes": [{"type": "edit_code", "find": "box(.028,H-.03,.03,boneWoodV", "replace": "box(.07,H-.03,.03,boneWoodV", "why": "たての骨を太くしました"}],
        "out_of_scope": [],
    },
    "乾くまで半日": {
        "summary": "待つ時間の文を、本人の言葉に直します。",
        "focus_chapter": "matsu",
        "changes": [{"type": "set_text", "chapter": "matsu", "title": "貼ったら、<br><em>半日</em>待つ。", "body": "", "basis": "乾くまで半日", "confirm": ""}],
        "out_of_scope": [],
    },
    "待つのは上の紙の後": {
        "summary": "「待つ」の場面を、上の紙の後ろへ動かします。",
        "focus_chapter": "matsu",
        "changes": [{"type": "move_chapter", "chapter": "matsu", "after": "uwa"}],
        "out_of_scope": [],
    },
    "壁紙を花柄にして": {
        "summary": "",
        "focus_chapter": "",
        "changes": [],
        "out_of_scope": [{"request": "壁紙を花柄にして", "reason": "ふすまの仕事の説明ではないので、今はできません"}],
    },
    "壊すテスト": {
        "summary": "わざと壊す試験です。",
        "focus_chapter": "omote",
        "changes": [{"type": "edit_code", "find": "const w=world('room',{japanese:true,size:4});", "replace": THROW + "const w=world('room',{japanese:true,size:4});", "why": "わざと壊す"}],
        "out_of_scope": [],
    },
    "二度壊すテスト": {
        "summary": "直しても壊れる試験です。",
        "focus_chapter": "omote",
        "changes": [{"type": "edit_code", "find": "const w=world('room',{japanese:true,size:4});", "replace": "throw new Error('テスト：直らない壊れ方');\nconst w=world('room',{japanese:true,size:4});", "why": "わざと壊す"}],
        "out_of_scope": [],
    },
    "見つからないテスト": {
        "summary": "置きかえる所が見つからない試験です。",
        "focus_chapter": "omote",
        "changes": [{"type": "edit_code", "find": "ありえない文字列", "replace": "x", "why": "試験"}],
        "out_of_scope": [],
    },
}


def _stream(obj, on_text, seconds):
    text = json.dumps(obj, ensure_ascii=False)
    if on_text:
        n = max(1, int(seconds / .15))
        step = max(1, len(text) // n)
        for i in range(0, len(text), step):
            on_text(text[i:i + step], False)
            time.sleep(.15)
    return obj


def _meta(user):
    """画像つきの返事でも、最後のJSON文を取り出す。"""
    if isinstance(user, dict):
        return user
    for item in reversed(user):
        if item.get("type") == "text" and item["text"].lstrip().startswith("{"):
            return json.loads(item["text"])
    return {}


def _photos_ok(user):
    """参考の写真が付いていたら、Claude に渡せる形（base64 の JPEG）かだけ確かめる。"""
    if isinstance(user, dict):
        return
    for item in user:
        if item.get("type") == "image":
            raw = base64.b64decode(item["source"]["data"], validate=True)
            if item["source"]["media_type"] != "image/jpeg" or raw[:2] != b"\xff\xd8":
                raise ValueError("photo")


def make_ask():
    def ask(purpose, system, user, schema, effort="medium", max_tokens=32000, on_text=None):
        if purpose in ("question", "script"):
            _photos_ok(user)
            user = _meta(user)  # 参考の写真が付いていても、最後のJSON文だけ読む
        if purpose == "question":
            n = user.get("asked", 0)
            time.sleep(.3)
            if n >= len(QUESTIONS):
                return {"done": True, "axis": "tema", "question": ""}, FAKE_MODEL
            a, q, _ = QUESTIONS[n]
            return {"done": False, "axis": a, "question": q}, FAKE_MODEL
        if purpose == "script":
            script = json.loads(json.dumps(SCRIPT, ensure_ascii=False))
            work = user.get("work") or ""
            if "灯油" in work:
                return _stream(json.loads(json.dumps(SCRIPT_CAR, ensure_ascii=False)), on_text, 2.5), FAKE_MODEL
            if "防護服" in work:
                return _stream(json.loads(json.dumps(SCRIPT_CLAY, ensure_ascii=False)), on_text, 2.5), FAKE_MODEL
            if "禁止語消えない" in work or ("禁止語入り" in work and not user.get("note")):
                script["chapters"][4]["body"] = "上の紙を貼ると、カビが殺菌されてきれいになります。"
            return _stream(script, on_text, 2.5), FAKE_MODEL
        if purpose == "scene":
            if "灯油" in (user.get("work") or ""):
                return _stream({"cameras": CAMERAS_CAR, "code": CODE_CAR}, on_text, 3.5), FAKE_MODEL
            if "防護服" in (user.get("work") or ""):
                return _stream({"cameras": CAMERAS_CLAY, "code": CODE_CLAY}, on_text, 3.5), FAKE_MODEL
            code = (KIT / "example.js").read_text(encoding="utf-8")
            if "名札隠れ" in (user.get("work") or ""):
                code = code.replace(LABEL_GOOD, LABEL_HIDDEN)
            if re.search(r"壊れる|悪くなる_", user.get("work") or ""):
                code = THROW + code
            return _stream({"cameras": CAMERAS, "code": code}, on_text, 3.5), FAKE_MODEL
        if purpose == "review":
            meta = _meta(user)
            work, rnd = meta.get("work") or "", meta.get("round")
            time.sleep(1.2)
            asked_again = user[-1]["type"] == "text" and "日本語でない文" in user[-1]["text"]
            if ("英語消えない" in work or ("英語" in work and not asked_again)) and rnd == 1:
                return {"passed": False, "reason": "Image 2 has a floating object.",
                        "issues": [{"image": 2, "item": "katachi", "severity": "low", "seen": "A floating object appears in the upper right of image 2.", "how_to_fix": "Move it down to the floor."}]}, FAKE_MODEL
            if "英語" in work and rnd == 1:
                return {"passed": False, "reason": "（手書き）画像2に、宙に浮いた物があります。",
                        "issues": [{"image": 2, "item": "katachi", "severity": "low", "seen": "（手書き）画像2の右上に、宙に浮いた物があります。", "how_to_fix": "床へ下ろす"}]}, FAKE_MODEL
            if "小さい指摘" in work and rnd == 1:
                return {"passed": True, "reason": "（手書き）大きな問題はありません。",
                        "issues": [{"image": 3, "item": "nafuda", "severity": "low", "seen": "（手書き）画像3の名札の先に、その物が見えません。", "how_to_fix": "名札を物の表面へ動かす"}]}, FAKE_MODEL
            if "灯油" in work or "防護服" in work:
                return {"passed": True, "reason": "（手書き）画像1〜画像8で、文字は読め、物も画面に収まっています。", "issues": []}, FAKE_MODEL
            if "二回とも" in work or "悪くなる" in work or rnd == 1:
                return {"passed": False, "reason": "（手書き）画像2で物が画面に対して大きく、画像6の名札が小さく読みにくいので不合格です。",
                        "issues": [
                            {"image": 2, "item": "camera", "severity": "high", "seen": "（手書き）画像2はふすまが画面いっぱいで、上と下が切れています。", "how_to_fix": "少し引いて全体を見せる"},
                            {"image": 6, "item": "yomeru", "severity": "low", "seen": "（手書き）画像6の名札の文字が小さめです。", "how_to_fix": "名札を減らすか近づける"},
                        ]}, FAKE_MODEL
            return {"passed": True, "reason": "（手書き）画像1〜画像8で、文字は幕の上で読め、物も画面に収まっています。", "issues": []}, FAKE_MODEL
        if purpose == "repair":
            meta = _meta(user)
            work, problems = meta.get("work") or "", meta.get("problems") or []
            time.sleep(1.5)
            joined = json.dumps(problems, ensure_ascii=False)
            raw = {"fixed": [], "edits": [], "camera_fixes": [], "text_fixes": []}
            if "壊れる2" in work:
                raw["fixed"].append("（手書き）直そうとしましたが、直っていません")
                return raw, FAKE_MODEL
            if "わざと壊し" in joined:
                raw["edits"].append({"find": THROW, "replace": ""})
                raw["fixed"].append("（手書き）動かなかった所を直しました")
            if "悪くなる" in work:
                raw["edits"].append({"find": "const w=world('room',{japanese:true,size:4});", "replace": "throw new Error('テスト：直して悪くなりました');\nconst w=world('room',{japanese:true,size:4});"})
                raw["fixed"].append("（手書き）直そうとしました")
                return raw, FAKE_MODEL
            if "隠れています" in joined and "名札" in joined:
                raw["edits"].append({"find": LABEL_HIDDEN, "replace": LABEL_GOOD})
                raw["fixed"].append("（手書き）名札の先を、見えている所へ動かしました")
            if "殺菌" in joined:
                raw["text_fixes"].append({"chapter": "uwa", "title": "", "body": "ここでやっと、お客さんの見る柄が出てきます。"})
                raw["fixed"].append("（手書き）書けない言葉の文を消しました")
            if "名札の先" in joined or "宙に浮いた" in joined or "floating" in joined:
                raw["camera_fixes"].append({"chapter": "hone", "cam": [{"look": [0, .95, 0], "r": round(1.25 + time.time() % 1 / 20, 3), "dir": [-.25, .1, 1]}, {"look": [.05, 1.05, 0], "r": 1.05, "dir": [-.45, .18, 1]}]})
                raw["fixed"].append("（手書き）見えていなかった物が入るように、カメラを動かしました")
            if "画面いっぱい" in joined:
                raw["camera_fixes"].append({"chapter": "hone", "cam": [{"look": [0, .95, 0], "r": round(1.3 + time.time() % 1 / 20, 3), "dir": [-.25, .1, 1]}, {"look": [.05, 1.05, 0], "r": 1.1, "dir": [-.45, .18, 1]}]})
                raw["fixed"].append("（手書き）カメラを少し引いて、ふすま全体が入るようにしました")
            return raw, FAKE_MODEL
        if purpose == "fix":
            said = user.get("said_now") or ""
            for key, reply in sorted(FIXES.items(), key=lambda kv: -len(kv[0])):
                if key in said:
                    return _stream(reply, on_text, 1.2), FAKE_MODEL
            return {"summary": "", "focus_chapter": "", "changes": [], "out_of_scope": [{"request": said, "reason": "（手書き）試験の返事に無い直しです"}]}, FAKE_MODEL
        raise ValueError(purpose)
    return ask
