#!/usr/bin/env bash
# 安全地更新 .env 里的飞书凭据。
#
#   bash scripts/set-secret.sh          # 更新 App Secret
#   bash scripts/set-secret.sh appid    # 更新 App ID
#
# 为什么需要这个脚本：
#   直接在命令行里写 `FEISHU_APP_SECRET=xxx` 会把密钥写进 shell 历史；
#   发给别人粘贴又会被记进聊天记录。这里用 read -s 隐藏输入，
#   密钥既不入 shell 历史，也不经过任何对话记录。
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

# 用 macOS 自带的 FileVault 卷判断不了什么，这里只做基本的文件检查
[ -f "$ENV_FILE" ] || { echo "✖ 找不到 $ENV_FILE" >&2; exit 1; }

field="secret"
key="FEISHU_APP_SECRET"
label="App Secret"
if [ "${1:-}" = "appid" ]; then
  key="FEISHU_APP_ID"
  label="App ID"
  field="appid"
fi

current=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- || true)
if [ -n "$current" ]; then
  # 只显示首尾各 4 个字符，方便你确认改的确实是同一个
  len=${#current}
  if [ "$len" -gt 12 ]; then
    masked="${current:0:4}$(printf '•%.0s' $(seq 1 $((len - 8))))${current: -4}"
  else
    masked="(已设置)"
  fi
  echo "当前 $label : $masked"
fi

echo
echo "请粘贴新的 $label（输入时不会显示，粘贴完按回车）："
printf '  > '
read -r -s new_value
echo
echo

if [ -z "$new_value" ]; then
  echo "✖ 输入为空，未做任何修改。" >&2
  exit 1
fi

# 简单校验长度，避免粘贴时漏字符
if [ "$field" = "secret" ] && [ "${#new_value}" -lt 16 ]; then
  echo "⚠️  新值只有 ${#new_value} 个字符，看起来不太对。确定要写入吗？(y/N)"
  read -r confirm
  [ "$confirm" = "y" ] || { echo "已取消。"; exit 1; }
fi

# 原子替换：先写临时文件再改名，避免中途失败留下半个文件
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if grep -qE "^${key}=" "$ENV_FILE"; then
  # 用 awk 替换，避免把值里的特殊字符喂给 sed
  awk -v k="$key" -v v="$new_value" \
    'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' \
    "$ENV_FILE" > "$tmp"
else
  cat "$ENV_FILE" > "$tmp"
  printf '%s=%s\n' "$key" "$new_value" >> "$tmp"
fi

cat "$tmp" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "✅ 已更新 $label 并写入 $ENV_FILE（权限已设为 600）"
echo

# 顺手把日志里可能残留的旧凭据清掉
if command -v python3 >/dev/null 2>&1 && [ -f "$PROJECT_DIR/scripts/redact-logs.py" ]; then
  echo "正在清理日志里可能残留的旧凭据…"
  python3 "$PROJECT_DIR/scripts/redact-logs.py" || true
  echo
fi

printf '现在重启服务让它生效？(Y/n) '
read -r restart
if [ "${restart:-Y}" != "n" ]; then
  if command -v launchctl >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/com.pi-feishu" 2>/dev/null \
      && echo "✅ 服务已重启" \
      || echo "ℹ️  没找到 launchd 服务（可能你是手动跑的），请自行重启"
  else
    echo "ℹ️  非 macOS，请自行重启服务"
  fi
fi
