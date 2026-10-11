#!/usr/bin/env bash
# 安装 git pre-commit hook —— 每次提交前自动跑隐私扫描。
# CI 里也会跑同样的检查，但本地拦截能让你在提交的那一刻就知道，
# 而不是等推上去被 CI 打回来。
#
#   bash scripts/install-hooks.sh
#   rm .git/hooks/pre-commit     # 卸载
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_DIR="$(git -C "$PROJECT_DIR" rev-parse --git-dir)"
HOOK="$PROJECT_DIR/$GIT_DIR/hooks/pre-commit"

if [ ! -d "$(dirname "$HOOK")" ]; then
  echo "✖ 找不到 .git/hooks 目录，这里不是 git 仓库？" >&2
  exit 1
fi

cat > "$HOOK" <<'HOOK_EOF'
#!/usr/bin/env bash
# 由 pi-feishu 的 scripts/install-hooks.sh 生成
ROOT="$(git rev-parse --show-toplevel)"
exec "$ROOT/scripts/check-privacy.sh" --staged
HOOK_EOF

chmod +x "$HOOK"

echo "✅ 已安装 pre-commit hook: $HOOK"
echo
echo "现在每次 git commit 前都会自动扫描暂存区，发现疑似密钥就拦下来。"
echo "卸载：rm $HOOK"
