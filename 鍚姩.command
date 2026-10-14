#!/bin/bash
# 放学啦 · 时间小计划 —— 双击即可启动
#
# 用法：在访达里双击本文件。会自动找到 Node、启动本地服务、打开浏览器。
# 想停止服务：关闭这个终端窗口，或按 Control + C。

cd "$(dirname "$0")" || exit 1

echo "==============================================="
echo "  放学啦 · 时间小计划  —— 正在启动"
echo "==============================================="
echo ""

# ---- 1. 找到 Node ----
if ! . "./shared/node-path.sh"; then
  echo ""
  echo "按回车键关闭窗口…"
  read -r _
  exit 1
fi
echo "✅ Node: $NODE_BIN ($("$NODE_BIN" -v 2>&1))  [$NODE_SOURCE]"

# ---- 2. 检查配置 ----
if [ ! -f .env ]; then
  echo "❌ 没有找到 .env 配置文件。"
  echo "   请把 .env.example 复制为 .env，并填入 DEEPSEEK_API_KEY。"
  echo ""
  echo "按回车键关闭窗口…"
  read -r _
  exit 1
fi
if ! grep -qE '^[[:space:]]*DEEPSEEK_API_KEY=[^[:space:]]+' .env && ! grep -qE '^[[:space:]]*OPENAI_API_KEY=[^[:space:]]+' .env; then
  echo "⚠️  .env 里似乎还没有填写 API 密钥，识别功能会退回到本地规则。"
fi

# ---- 3. 读取端口 ----
PORT="$(grep -E '^[[:space:]]*PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
PORT="${PORT:-4173}"
URL="http://127.0.0.1:${PORT}"

# ---- 4. 端口被占用时确认 ----
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已被占用，可能是本服务已经在运行。"
  if curl -s -o /dev/null -m 3 "$URL/"; then
    echo "✅ 打开后发现服务已经在正常运行，直接为你打开页面。"
    open "$URL"
    echo ""
    echo "（这个窗口可以直接关闭）"
    echo "按回车键关闭窗口…"
    read -r _
    exit 0
  fi
  printf "要结束占用端口的进程并重新启动吗？[y/N] "
  read -r answer
  case "$answer" in
    [yY]*) pkill -f "node server.mjs" ;;
    *) echo "已取消。"; echo ""; echo "按回车键关闭窗口…"; read -r _; exit 1 ;;
  esac
  sleep 1
fi

trap 'echo ""; echo "已停止服务。"; exit 0' INT TERM

# ---- 5. 启动服务 ----
echo "✅ 正在启动服务：$URL"
echo "   识别任务会把输入内容发送给配置的 AI 服务，请勿填写姓名等隐私信息。"
echo ""
echo "   ▸ 停止服务：按 Control + C，或直接关闭这个窗口"
echo "-----------------------------------------------"

# 等服务起来后再打开浏览器（最多等 10 秒）
(
  for _ in $(seq 1 40); do
    sleep 0.25
    if curl -s -o /dev/null -m 2 "$URL/"; then
      open "$URL"
      break
    fi
  done
) &

exec "$NODE_BIN" server.mjs
