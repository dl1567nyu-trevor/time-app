#!/bin/bash
# 定位一个可用的 Node，并把它导出到 PATH。
# 供「启动.command」等脚本 source 使用。
#
# 查找顺序：
#   1. 已经在 PATH 里的 node
#   2. 安装到用户目录的 Node（本项目推荐位置）
#   3. /usr/local、Homebrew、nvm 等常见位置
#   4. 其他应用内部自带的运行时（兜底，可能随应用更新消失）
#
# 用法：  . "$(dirname "$0")/shared/node-path.sh"
# 成功后：$NODE_BIN 指向 node 可执行文件，PATH 已包含它的目录

find_node() {
  # 1) PATH 里已有
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
    NODE_SOURCE="PATH"
    return 0
  fi

  # 2) 用户级安装（推荐位置）
  local candidates=(
    "$HOME/.local/node/bin/node"
    "/usr/local/bin/node"
    "/opt/homebrew/bin/node"
    "/usr/local/opt/node/bin/node"
  )

  # 3) nvm：取版本号最大的一个
  if [ -d "$HOME/.nvm/versions/node" ]; then
    local newest
    newest="$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tail -1)"
    [ -n "$newest" ] && candidates+=("$HOME/.nvm/versions/node/$newest/bin/node")
  fi
  # fnm / volta / asdf
  candidates+=("$HOME/.volta/bin/node" "$HOME/.local/share/fnm/aliases/default/bin/node")

  # 4) 其他应用内置运行时（兜底）
  candidates+=(
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/node/bin/node"
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  )

  local c
  for c in "${candidates[@]}"; do
    if [ -x "$c" ]; then
      NODE_BIN="$c"
      case "$c" in
        */Applications/*) NODE_SOURCE="其他应用内置运行时（兜底，可能随应用更新失效）" ;;
        *)                NODE_SOURCE="本地安装" ;;
      esac
      export PATH="$(dirname "$c"):$PATH"
      return 0
    fi
  done

  return 1
}

if ! find_node; then
  echo "❌ 没有找到可用的 Node。" >&2
  echo "" >&2
  echo "请先安装 Node（官方独立包，不需要管理员密码）：" >&2
  echo "  curl -L -o /tmp/node.tar.gz https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-arm64.tar.gz" >&2
  echo "  mkdir -p ~/.local/node && tar -xzf /tmp/node.tar.gz -C ~/.local/node --strip-components=1" >&2
  return 1 2>/dev/null || exit 1
fi
