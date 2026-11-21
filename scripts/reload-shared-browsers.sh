#!/bin/bash
# Kesonode：重载所有共用同一安装目录的浏览器（macOS）
#
# 背景：
#   一键升级只重启「执行升级的那一个」浏览器。其他浏览器虽然从同一个目录
#   加载扩展，但内存里还是旧代码，必须重新加载才会用新版。扩展受沙箱限制
#   不能执行本机脚本，所以这件事由外部脚本代劳。
#
# 用法：
#   bash scripts/reload-shared-browsers.sh [--list] [--dry-run] [--yes]
#                                          [--watch [秒]] [--app "浏览器名"] [共享目录]
#
#   --list          只列出检测到的浏览器，不做任何改动
#   --dry-run       只打印将要执行的命令，不真的重启
#   --yes           跳过确认
#   --watch [秒]    常驻监控共享目录（默认 5 秒）。一旦扩展文件发生变化
#                   （任一台一键升级），自动重载所有浏览器——这就是
#                   「一台升级，其余自动跟上」的模式。Ctrl+C 退出。
#   --app           手动追加一个浏览器（自动检测漏掉时用），可重复
#   共享目录        默认 ~/Downloads/Kesonode，也可传实际加载的目录
#
# 注意：重载会关闭所有窗口和标签页。浏览器通常会恢复上次会话，但没提交
#       的表单、正在进行的下载或操作可能丢失。请先保存手头工作。
#
# 检测原理：Chromium 系浏览器在 Secure Preferences / Preferences 的
# extensions.settings 里记录了解压扩展的 path。脚本扫描所有 profile 的
# 这两个文件，找出 path 指向共享目录的浏览器。

set -euo pipefail

SHARED="$HOME/Downloads/Kesonode"
DRY_RUN=0
LIST_ONLY=0
ASSUME_YES=0
WATCH=0
INTERVAL=5
EXTRA_APPS=()

while [ "$#" -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    --watch)
      WATCH=1
      if [ "$#" -ge 2 ] && [[ "$2" =~ ^[0-9]+$ ]]; then
        INTERVAL="$2"
        shift
      fi
      shift
      ;;
    --app)
      if [ "$#" -lt 2 ]; then
        printf '错误：--app 后面需要浏览器名称\n' >&2
        exit 1
      fi
      EXTRA_APPS+=("$2")
      shift 2
      ;;
    -h|--help)
      sed -n '2,27p' "$0"
      exit 0
      ;;
    --) shift; break ;;
    -*)
      printf '未知参数：%s（用 --help 查看用法）\n' "$1" >&2
      exit 1
      ;;
    *)
      SHARED="$1"
      shift
      ;;
  esac
done

if [ ! -d "$SHARED" ]; then
  printf '共享目录不存在：%s\n' "$SHARED" >&2
  printf '用第一个位置参数传实际加载的目录。\n' >&2
  exit 1
fi
if [ ! -f "$SHARED/manifest.json" ]; then
  printf '目录里没有 manifest.json，不是扩展加载目录：%s\n' "$SHARED" >&2
  exit 1
fi

# 扩展文件的指纹：版本号 + manifest 内容哈希。升级时 manifest 最后写入，
# 所以指纹变化意味着新版已经完整落盘，可以安全地让浏览器重新读取。
manifest_fingerprint() {
  python3 - "$SHARED/manifest.json" <<'PY'
import hashlib
import json
import sys

with open(sys.argv[1], "rb") as fh:
    raw = fh.read()
try:
    version = json.loads(raw).get("version", "?")
except (ValueError, AttributeError):
    version = "?"
print(f"{version}:{hashlib.sha256(raw).hexdigest()[:16]}")
PY
}

# 从各浏览器的 Preferences 里找 path 指向该目录的扩展。只读，不改动配置。
detect_apps() {
  local detected
  detected=$(python3 - "$SHARED" <<'PY'
import json
import os
import sys

shared = os.path.realpath(sys.argv[1])
base = os.path.expanduser("~/Library/Application Support")

# AppleScript 应用名 -> 配置目录（相对 Application Support）
BROWSERS = {
    "Google Chrome": "Google/Chrome",
    "Microsoft Edge": "Microsoft Edge",
    "Quark": "Quark",
    "Chromium": "Chromium",
    "Brave Browser": "BraveSoftware/Brave-Browser",
    "Vivaldi": "Vivaldi",
    "Opera": "com.operasoftware.Opera",
    "Yandex Browser": "Yandex/YandexBrowser",
}

for app, rel in BROWSERS.items():
    root = os.path.join(base, rel)
    if not os.path.isdir(root):
        continue
    profiles = ["Default"] + sorted(
        d for d in os.listdir(root)
        if d.startswith("Profile ") and os.path.isdir(os.path.join(root, d))
    )
    for profile in profiles:
        # Chromium 把解压扩展的路径记在 Secure Preferences 里，普通
        # Preferences 里也可能有；两个都看，命中一个就算。
        for filename in ("Secure Preferences", "Preferences"):
            prefs = os.path.join(root, profile, filename)
            if not os.path.isfile(prefs):
                continue
            try:
                with open(prefs, encoding="utf-8") as fh:
                    data = json.load(fh)
            except (OSError, ValueError):
                continue
            settings = (data.get("extensions") or {}).get("settings") or {}
            for entry in settings.values():
                path = entry.get("path") if isinstance(entry, dict) else None
                if path and os.path.realpath(path) == shared:
                    print(app)
                    break
            else:
                continue
            break
        else:
            continue
        break
PY
)
  APPS=()
  while IFS= read -r line; do
    [ -n "$line" ] && APPS+=("$line")
  done <<< "$detected"

  if [ "${#EXTRA_APPS[@]}" -gt 0 ]; then
    for extra in "${EXTRA_APPS[@]}"; do
      case " ${APPS[*]:-} " in
        *" $extra "*) ;;
        *) APPS+=("$extra") ;;
      esac
    done
  fi
}

is_running() {
  pgrep -f "$1.app/Contents/MacOS" >/dev/null 2>&1
}

# 重载所有正在运行的目标浏览器。返回 0 表示有浏览器被重启。
reload_browsers() {
  local app waited answer
  local running=()

  for app in "${APPS[@]}"; do
    if is_running "$app"; then
      running+=("$app")
    else
      printf '  %s 当前未运行，跳过。\n' "$app"
    fi
  done

  if [ "${#running[@]}" -eq 0 ]; then
    printf '没有正在运行的目标浏览器，无需操作。\n'
    return 1
  fi

  printf '\n注意：即将重启 %s\n' "${running[*]}"
  printf '所有标签页会关闭，重启时尝试恢复上次会话；未保存的输入可能丢失。\n'
  if [ "$DRY_RUN" -eq 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    printf '继续？[y/N] '
    read -r answer || answer=""
    case "$answer" in
      y|Y|yes|YES) ;;
      *) printf '已取消。\n'; return 1 ;;
    esac
  fi

  for app in "${running[@]}"; do
    printf '\n[%s] 退出浏览器…\n' "$app"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '  (dry-run) osascript -e "tell application \"%s\" to quit"\n' "$app"
    else
      osascript -e "tell application \"$app\" to quit" >/dev/null 2>&1 || true
      waited=0
      while is_running "$app" && [ "$waited" -lt 40 ]; do
        sleep 0.5
        waited=$((waited + 1))
      done
      if is_running "$app"; then
        printf '  20 秒内没有退出，跳过这个浏览器（请手动重启）。\n'
        continue
      fi
    fi

    printf '[%s] 重新打开（恢复上次会话）…\n' "$app"
    if [ "$DRY_RUN" -eq 1 ]; then
      printf '  (dry-run) open -a "%s" --args --restore-last-session\n' "$app"
    else
      open -a "$app" --args --restore-last-session >/dev/null 2>&1 || {
        printf '  打开 %s 失败，请手动打开。\n' "$app" >&2
      }
    fi
  done
  return 0
}

printf '共享扩展目录：%s\n' "$SHARED"
detect_apps

if [ "${#APPS[@]}" -eq 0 ]; then
  printf '没有找到从该目录加载扩展的浏览器。\n'
  printf '可用 --app 手动指定，例如：\n'
  printf '  bash %s --app "Google Chrome" "%s"\n' "$0" "$SHARED"
  exit 1
fi

printf '\n检测到以下浏览器从该目录加载扩展：\n'
for app in "${APPS[@]}"; do
  printf '  - %s\n' "$app"
done

if [ "$LIST_ONLY" -eq 1 ]; then
  printf '\n（--list：未做任何改动）\n'
  exit 0
fi

if [ "$WATCH" -eq 1 ]; then
  # 守护模式：检测到扩展文件变化就重载所有浏览器。升级时 manifest 最后
  # 写入，所以指纹变化代表新代码已经完整落盘。
  ASSUME_YES=1
  BASELINE=$(manifest_fingerprint)
  printf '\n守护模式已启动（每 %s 秒检查一次）。\n' "$INTERVAL"
  printf '任一台浏览器一键升级后，本脚本会自动重载所有共用该目录的浏览器。\n'
  printf '按 Ctrl+C 退出。\n'
  while true; do
    sleep "$INTERVAL"
    CURRENT=$(manifest_fingerprint 2>/dev/null) || continue
    if [ "$CURRENT" = "$BASELINE" ]; then
      continue
    fi
    printf '\n[%s] 检测到扩展文件变化：%s → %s\n' \
      "$(date '+%H:%M:%S')" "$BASELINE" "$CURRENT"
    # 等升级流程收尾（写文件 + 当前浏览器 reload），避免和它抢同一批文件。
    sleep 2
    reload_browsers || true
    BASELINE=$(manifest_fingerprint)
    printf '[%s] 已记录新版本 %s，继续监控…\n' "$(date '+%H:%M:%S')" "$BASELINE"
  done
fi

if reload_browsers; then
  printf '\n完成。请到各浏览器的扩展页确认 Kesonode 已显示新版本号。\n'
  printf '若标签页没恢复，检查该浏览器「启动时」是否设为「继续上次会话」。\n'
fi
