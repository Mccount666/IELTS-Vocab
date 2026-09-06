#!/bin/bash
# r21 回归：r8/r17/r18/r19/r20 旧冒烟逐个在全新 D1 库上跑
set -u
cd "$(dirname "$0")/.."

for t in r8 r17 r18 r19 r20; do
  state=".tmp-regress-$t"
  rm -rf "$state"
  npx wrangler d1 execute ielts_vocab --local --persist-to "$state" --file=schema.sql >/dev/null 2>&1
  npx wrangler dev --port 8788 --persist-to "$state" >/tmp/wrangler-$t.log 2>&1 &
  wpids+=($!)
  # 等健康检查
  up=0
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -m 2 http://127.0.0.1:8788/api/health | grep -q '"ok":true'; then up=1; break; fi
  done
  if [ "$up" != "1" ]; then
    echo "=== $t: dev server 启动失败 ==="
    tail -5 /tmp/wrangler-$t.log
  else
    echo "=== $t ==="
    node "$(pwd)/test/api-smoke-$t.mjs" 2>&1 | tail -8
  fi
  # 杀掉 wrangler dev 进程树（Git Bash 里 $_ 需转义）
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'wrangler dev' } | ForEach-Object { taskkill /PID \$_.ProcessId /T /F }" >/dev/null 2>&1
  sleep 2
done
rm -rf .tmp-regress-*
echo "回归完毕"
