#!/usr/bin/env python3
"""
从本机各类日志里清除飞书凭据。

要点：密钥从 ~/pi-feishu/.env 读取，**不在命令行里出现字面量**——
否则执行这个命令本身又会被记进会话日志，等于白干。
"""
import json
import os
import re
import sys
from pathlib import Path

HOME = Path.home()
ENV_FILE = HOME / "pi-feishu" / ".env"

# ── 读凭据 ────────────────────────────────────────────────────
if not ENV_FILE.exists():
    sys.exit(f"找不到 {ENV_FILE}")

env = {}
for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    env[k.strip()] = v.strip()

SECRET = env.get("FEISHU_APP_SECRET", "")
APP_ID = env.get("FEISHU_APP_ID", "")

targets = [(v, f"<REDACTED-{k}>") for k, v in
           [("SECRET", SECRET), ("APPID", APP_ID)] if v]

if not targets:
    sys.exit("没有可清理的凭据")

# ── 收集要扫描的文件 ──────────────────────────────────────────
roots = [
    HOME / ".pi" / "agent",
    HOME / ".pi-feishu",
    Path("/tmp"),
]
candidates = []
for root in roots:
    if not root.exists():
        continue
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.stat().st_size > 50 * 1024 * 1024:      # 跳过超大文件
            continue
        if path.name.startswith("server") and path.suffix == ".log":
            candidates.append(path)
        elif path.suffix in {".jsonl", ".json", ".log", ".txt"} or ".bak" in path.name:
            candidates.append(path)

# ── 逐个处理 ──────────────────────────────────────────────────
changed = []
for path in candidates:
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        continue
    if not any(literal in text for literal, _ in targets):
        continue

    hits = 0
    for literal, placeholder in targets:
        hits += text.count(literal)
        text = text.replace(literal, placeholder)

    # 写回前先确认是合法 JSONL（如果是 jsonl 的话）
    if path.suffix == ".jsonl":
        ok = True
        for ln in text.splitlines():
            if not ln.strip():
                continue
            try:
                json.loads(ln)
            except Exception:
                ok = False
                break
        if not ok:
            print(f"  ✖ 跳过（脱敏后会破坏 JSONL）: {path}")
            continue

    path.write_text(text, encoding="utf-8")
    changed.append((path, hits))

# ── 报告 ──────────────────────────────────────────────────────
if not changed:
    print("  ✅ 没找到任何包含凭据的日志文件")
    sys.exit(0)

print(f"  已清理 {len(changed)} 个文件：")
for path, hits in changed:
    try:
        shown = path.relative_to(HOME)
        shown = f"~/{shown}"
    except ValueError:
        shown = str(path)
    print(f"    {shown}  ({hits} 处)")
