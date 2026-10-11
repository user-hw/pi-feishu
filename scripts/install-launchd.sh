#!/usr/bin/env bash
# 安装为 launchd 用户级服务：登录自启、崩溃自动拉起
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
LABEL="com.pi-feishu"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/.pi-feishu"

if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "✖ 找不到 $PROJECT_DIR/.env，请先 cp .env.example .env 并填好凭据" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file-if-exists=$PROJECT_DIR/.env</string>
    <string>$PROJECT_DIR/src/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <!-- launchd 默认 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin，里面没有 node。
       RpcClient 内部用裸命令 spawn("node", ...) 起 pi 子进程，所以必须补上。 -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/server.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/server.err.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "✅ 已安装并启动：$PLIST"
echo
echo "  看日志   : tail -f $LOG_DIR/server.log"
echo "  看错误   : tail -f $LOG_DIR/server.err.log"
echo "  停止     : launchctl unload $PLIST"
echo "  重启     : launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo
echo "提醒：MacBook 合盖会休眠导致断连，需要 'sudo pmset -c disablesleep 1'。"
