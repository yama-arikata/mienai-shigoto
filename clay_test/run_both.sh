#!/bin/zsh
# 津軽塗の仮の答えで「粘土なし」「粘土あり」を1本ずつ本物の Claude で作り、費用を並べる。
# キーはこのターミナルの中だけで使う（ファイルにもログにも書かない）。
#   zsh clay_test/run_both.sh
set -u; setopt nullglob
cd "${0:A:h}/.." || exit 1
PORT=8994
# キーチェーンに裏方用のキー（yama-anthropic-api）があればそれを使う。無ければその場で聞く
ANTHROPIC_API_KEY=$(security find-generic-password -a "$USER" -s yama-anthropic-api -w 2>/dev/null) || { read -s "ANTHROPIC_API_KEY?APIキー: "; echo; }
export ANTHROPIC_API_KEY
[[ -n "$ANTHROPIC_API_KEY" ]] || { echo "キーが空でした"; exit 1; }
~/Documents/YAMA_TOOLS_LAB/wait_for_quiet_mac.sh --quiet || { echo "Macが混んでいたので止めました"; exit 1; }

run() {  # $1=0/1（粘土） $2=ラベル
  local before=$(ls -d studio/data/*/ 2>/dev/null)
  STUDIO_CLAY=$1 STUDIO_SCENE_EFFORT=high python3 studio/server.py --port $PORT > /tmp/clay_server_$2.log 2>&1 &
  local spid=$!
  for i in {1..60}; do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.5; done
  echo "=== $2 を作ります（STUDIO_CLAY=$1・考える量 high）==="
  node clay_test/run_one.mjs --port $PORT --answers clay_test/answers_tsugaru.json --label $2
  kill $spid 2>/dev/null; wait $spid 2>/dev/null
  local new=$(comm -13 <(echo "$before" | sort) <(ls -d studio/data/*/ | sort) | tail -1)
  echo "${new}usage.json" > clay_test/out/$2.usage_path
}
mkdir -p clay_test/out
run 0 noclay
run 1 clay
unset ANTHROPIC_API_KEY
echo "=== 費用くらべ ==="
python3 clay_test/compare_usage.py "$(cat clay_test/out/noclay.usage_path)" "$(cat clay_test/out/clay.usage_path)"
echo "絵は clay_test/out/noclay/ と clay_test/out/clay/ にあります。小梅に『終わった』と言ってください。"
