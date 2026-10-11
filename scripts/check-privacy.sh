#!/usr/bin/env bash
# 隐私 / 密钥扫描器
#
#   bash scripts/check-privacy.sh          # 扫描所有 git 已跟踪的文件
#   bash scripts/check-privacy.sh --staged # 只扫描暂存区（适合做 pre-commit hook）
#
# 退出码 0 = 干净，1 = 发现问题
#
# 这个脚本是给本项目定制的：它认识飞书的 App ID / open_id / chat_id 格式，
# 通用工具（如 gitleaks）默认并不认识这些。
set -uo pipefail

MODE="${1:-all}"
FAILED=0
FOUND=0

# ── 输出小工具 ────────────────────────────────────────────────
red()    { printf '\033[31m%s\033[0m' "$1"; }
green()  { printf '\033[32m%s\033[0m' "$1"; }
yellow() { printf '\033[33m%s\033[0m' "$1"; }
bold()   { printf '\033[1m%s\033[0m' "$1"; }

# ── 取得要扫描的文件清单 ──────────────────────────────────────
if [ "$MODE" = "--staged" ]; then
  FILE_LIST=$(git diff --cached --name-only --diff-filter=ACM)
  SCOPE="暂存区"
else
  FILE_LIST=$(git ls-files)
  SCOPE="所有已跟踪文件"
fi

# 跳过二进制文件
SKIP_EXT='\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|eot|pdf|zip|gz|tar|mp4|mov|dmg|exe)$'
SCAN_FILES=$(echo "$FILE_LIST" | grep -vE "$SKIP_EXT" | grep -v '^$' || true)

FILE_COUNT=$(echo "$SCAN_FILES" | grep -c . || true)
echo "$(bold "隐私扫描") — ${SCOPE}，共 ${FILE_COUNT} 个文本文件"
echo

if [ "$FILE_COUNT" -eq 0 ]; then
  echo "  没有可扫描的文件。"
  exit 0
fi

# ── 核心扫描函数 ──────────────────────────────────────────────
# check <名称> <grep -E 模式> [排除模式]
check() {
  local name="$1"
  local pattern="$2"
  local exclude="${3:-}"
  local hits

  # -I 跳过二进制，-i 忽略大小写（SECRET / Secret / secret 都要抓到），
  # 少写 -i 会漏报大写形式的密钥名，这个坑已经踩过一次。
  hits=$(echo "$SCAN_FILES" | tr '\n' '\0' | xargs -0 grep -nIiE -- "$pattern" 2>/dev/null || true)
  if [ -n "$exclude" ] && [ -n "$hits" ]; then
    hits=$(echo "$hits" | grep -vE "$exclude" || true)
  fi

  if [ -n "$hits" ]; then
    printf '  %s %s\n' "$(red '✖')" "$(bold "$name")"
    echo "$hits" | head -8 | sed 's/^/      /'
    local total
    total=$(echo "$hits" | wc -l | tr -d ' ')
    [ "$total" -gt 8 ] && echo "      … 还有 $((total - 8)) 处"
    FAILED=1
    FOUND=$((FOUND + 1))
  else
    printf '  %s %s\n' "$(green '✓')" "$name"
  fi
}

echo "$(bold '① 文件级检查')"

# .env 绝不能被跟踪
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  printf '  %s %s\n' "$(red '✖')" "$(bold '.env 被 git 跟踪了！')"
  echo "      .env 里有真实凭据，必须执行：git rm --cached .env"
  FAILED=1; FOUND=$((FOUND + 1))
else
  printf '  %s %s\n' "$(green '✓')" ".env 未被跟踪"
fi

# .gitignore 必须包含 .env
if grep -qE '^\.env$' .gitignore 2>/dev/null; then
  printf '  %s %s\n' "$(green '✓')" ".gitignore 已包含 .env"
else
  printf '  %s %s\n' "$(red '✖')" "$(bold '.gitignore 里缺少 .env 规则')"
  FAILED=1; FOUND=$((FOUND + 1))
fi

echo
echo "$(bold '② 飞书凭据')"

# 飞书 App ID：cli_ + 16 位十六进制（文档里的占位符是 xxx，不会被误报）
check "飞书 App ID（cli_ 开头）+ 十六进制" 'cli_[0-9a-fA-F]{16}' '\.env\.example'

# 飞书 App Secret：等号后面有真实值（.env.example 留空，所以只抓泄漏）
check "飞书 App Secret 赋值" 'FEISHU_APP_SECRET[[:space:]]*=[[:space:]]*[^[:space:]#]+' '\.env\.example'

# 飞书 open_id / chat_id：ou_ / oc_ + 32 位十六进制
# 全零 ID 是测试用的占位符（比如探测权限时故意构造一个不存在的会话），不是真隐私
check "飞书 open_id（ou_ + 32 位十六进制）" 'ou_[0-9a-f]{32}' 'ou_0{32}'
check "飞书 chat_id（oc_ + 32 位十六进制）" 'oc_[0-9a-f]{32}' 'oc_0{32}'

echo
echo "$(bold '③ 通用密钥')"

# 各类密钥赋值：等号/冒号后面跟 20 位以上的长串。
#
# 排除三类误报：
#   - .env.example / README 里的占位符文件
#   - process.env.XXX / os.environ 这类【代码引用】（不是字面量密钥）
#   - GitHub 的匿名邮箱
NON_LITERAL='process\.env|os\.environ|getenv|import\.meta|Deno\.env|ctx\.env|\$\{'
check "疑似密钥赋值（secret/token/key/password）" \
  '(secret|token|api[_-]?key|apikey|password|passwd|credential)[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9_/+.-]{20,}' \
  "\.env\.example|users\.noreply\.github\.com|${NON_LITERAL}"

# PEM 私钥块
check "PEM 私钥内容" '-----BEGIN [A-Z ]*PRIVATE KEY-----'

echo
echo "$(bold '④ 个人信息')"

# 个人主目录路径（放行文档里的通用占位名）
check "个人主目录路径（/Users/<名字>）" \
  '/Users/[a-zA-Z0-9._-]+' \
  '/Users/(you|your|user|username|me|someone|example|YOUR_USER)(/|$|")'

# 个人邮箱（放行 GitHub 的匿名邮箱和示例域名）
check "个人邮箱地址" \
  '[a-zA-Z0-9._%+-]+@(qq|163|126|gmail|outlook|hotmail|foxmail|icloud|yahoo)\.(com|cn)' \
  'noreply|example\.(com|org)'

echo

# ── 结果 ──────────────────────────────────────────────────────
if [ "$FAILED" -ne 0 ]; then
  echo "$(red "$(bold "✖ 发现 $FOUND 类问题，请先处理再提交。")")"
  echo
  echo "提示：如果命中的是文档里的示例，请把具体值换成明显的占位符，"
  echo "      例如把真实 ID 写成 cli_xxxxxxxxxxxxxxxx。"
  exit 1
fi

echo "$(green "$(bold '✓ 全部通过，没有发现隐私或密钥泄漏。')")"
