#!/usr/bin/env bash
# 让 pi-feishu 服务在你离开后保持在线。
#
#   bash scripts/keep-awake.sh lid-open   # 方案A：开盖 + 官方设置（推荐长期用）
#   bash scripts/keep-awake.sh lid-shut   # 方案B：合盖 + disablesleep（省事，非官方）
#   bash scripts/keep-awake.sh status     # 查看当前状态
#   bash scripts/keep-awake.sh off        # 全部撤销，恢复默认
#
# 需要 sudo 密码。
#
# 两个方案都只改【AC 电源】这一档 —— 拔掉电源即恢复正常的合盖休眠，
# 这是天然的兜底开关。
set -euo pipefail

action="${1:-status}"

read_setting() {
  pmset -g 2>/dev/null | awk -v key="$1" '$1 == key {print $2; found=1} END {if (!found) print "(未设置)"}'
}

show_status() {
  echo "── 当前状态 ──────────────────────────────"
  printf '  disablesleep      = %s    (1 = 合盖也不休眠)\n' "$(read_setting disablesleep)"
  printf '  AC sleep 定时      = %s 分钟  (0 = 永不空闲休眠)\n' "$(pmset -g custom 2>/dev/null | awk '/^AC Power:/{f=1} f && $1=="sleep"{print $2; exit}')"
  printf '  AC displaysleep    = %s 分钟\n' "$(pmset -g custom 2>/dev/null | awk '/^AC Power:/{f=1} f && $1=="displaysleep"{print $2; exit}')"
  printf '  当前供电           = %s\n' "$(pmset -g batt 2>/dev/null | head -1 | grep -oE "Battery Power|AC Power" || echo 未知)"
  echo
  echo "  最近的睡眠原因统计："
  pmset -g log 2>/dev/null | grep -oE "due to '[^']+'" | sort | uniq -c | sort -rn | head -5 | sed 's/^/    /'
  echo
}

case "$action" in
  status)
    show_status
    ;;

  lid-open)
    echo "方案 A：开盖 + 官方设置"
    echo "  → AC 电源下永不空闲休眠，但保留 10 分钟自动息屏"
    echo "  → 用的是官方文档化的 pmset 设置，不依赖任何 hack"
    echo "  → 要求：盖子开着，放在硬质平面上，通风良好"
    echo
    sudo pmset -c sleep 0
    sudo pmset -c disablesleep 0
    echo
    echo "✅ 已设置。现在可以合上盖子试试 —— 合盖后仍然会睡。"
    echo "   这是预期的：方案 A 靠的是「盖子开着 + 不空闲休眠」。"
    echo
    show_status
    ;;

  lid-shut)
    echo "方案 B：合盖 + disablesleep"
    echo "  → 合上盖子也不休眠，服务持续在线"
    echo "  → ⚠️ 这是 macOS 的非公开设置，会持续耗电发热"
    echo "  → ⚠️ 它会【同时禁用系统空闲休眠】，可能连手动「睡眠」也一起挡掉"
    echo "  → 建议只在出门期间开，回家用 off 撤销"
    echo
    sudo pmset -c disablesleep 1
    echo
    if [ "$(read_setting disablesleep)" = "1" ]; then
      echo "✅ 已开启。合上盖子服务也在线。"
      echo
      echo "   想睡觉时：bash $0 off"
    else
      echo "⚠️ 命令执行了但读数不对，请手动确认：pmset -g | grep disablesleep"
      exit 1
    fi
    echo
    show_status
    ;;

  off)
    sudo pmset -c disablesleep 0
    # 恢复 macOS 默认的 AC 空闲休眠（1 分钟太激进，恢复到 10 分钟）
    sudo pmset -c sleep 10
    echo "✅ 已恢复默认：合盖休眠、空闲休眠都回来了。"
    echo
    show_status
    ;;

  *)
    echo "用法: bash $0 [status|lid-open|lid-shut|off]" >&2
    exit 1
    ;;
esac
