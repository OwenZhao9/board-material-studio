#!/bin/zsh
# 双击启动「板材宣传素材工坊」
cd "$(dirname "$0")"

# 定位 node
NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -x "$p" ] && NODE_BIN="$p" && break
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "未找到 Node.js，请先安装：https://nodejs.org/zh-cn（或 brew install node）"
  read -k1 -s "?按任意键退出"
  exit 1
fi

# 延迟打开浏览器
( sleep 1.2 && open "http://localhost:3888" ) &

exec "$NODE_BIN" server.mjs
