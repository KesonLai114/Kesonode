#!/bin/sh
# Kesonode 一键升级助手（macOS / Linux）
#
# 浏览器扩展不能替换自己的代码，所以这一步必须由一个普通本机程序完成。
# 本脚本只做「找到 zip → 校验路径 → 解压 → 放进那个固定目录」，
# 绝不删除旧目录：旧的会被改名成 Kesonode.old-<时间戳>，确认新版没问题后可以自己删。
#
# 目标目录固定叫 Kesonode，不带版本号。这是升级能保住设置的前提：
# 每次都覆盖同一个目录，浏览器里加载的路径不变，扩展 ID 和所有设置才能保留。
#
# 用法：直接双击运行，或
#   sh upgrade.sh /path/to/kesonode-chrome-1.5.20.zip [目标目录]
# 目标目录默认是 ~/Downloads/Kesonode。

set -eu

printf '\n=== Kesonode 升级助手 ===\n\n'

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ZIP=""

if [ "$#" -ge 1 ] && [ -f "$1" ]; then
  ZIP=$1
fi

if [ -z "$ZIP" ]; then
  LATEST=""
  # 浏览器下载的 zip 默认落在 Downloads；也看一眼脚本自己所在的目录，
  # 方便用户把 zip 和随包脚本放在同一处。
  for DIR in "$HOME/Downloads" "$HOME/下载" "$HERE" "$HOME/Desktop"; do
    [ -d "$DIR" ] || continue
    for CANDIDATE in "$DIR"/kesonode-*.zip; do
      [ -f "$CANDIDATE" ] || continue
      if [ -z "$LATEST" ] || [ "$CANDIDATE" -nt "$LATEST" ]; then
        LATEST=$CANDIDATE
      fi
    done
  done

  if [ -z "$LATEST" ]; then
    printf '没有找到 kesonode-*.zip 安装包。\n'
    printf '请先在设置页点「下载安装包」，或把 zip 拖到本窗口后按回车：\n'
    read -r ZIP || ZIP=""
    [ -f "$ZIP" ] || { printf '文件不存在，已退出。\n'; exit 1; }
  else
    ZIP=$LATEST
    printf '找到安装包：%s\n' "$ZIP"
    printf '若这不是要升级的包，请把正确的 zip 拖到本窗口后按回车；直接回车继续。\n'
    read -r REPLY || REPLY=""
    if [ -n "$REPLY" ]; then
      REPLY=$(printf '%s' "$REPLY" | sed "s/^'//; s/'$//")
      [ -f "$REPLY" ] || { printf '文件不存在，已退出。\n'; exit 1; }
      ZIP=$REPLY
    fi
  fi
fi

printf '安装包：%s\n' "$ZIP"

# 目标目录：固定名字，不带版本号。旧版装在别处的话，把那个路径作为第二个参数传进来。
TARGET=${2:-"$HOME/Downloads/Kesonode"}
case "$TARGET" in
  */) TARGET=${TARGET%/} ;;
esac

# 拒绝路径穿越 / 绝对路径的压缩包。设置页已做过一次，这里独立再做一次：
# 真正写磁盘的是本脚本，不能只信任浏览器那边的判断。
if command -v unzip >/dev/null 2>&1; then
  if unzip -Z1 "$ZIP" 2>/dev/null | grep -Eq '(^/|(^|/)\.\.(/|$)|^[A-Za-z]:)'; then
    printf '\n压缩包包含不安全的路径，已停止解压。请重新下载安装包。\n'
    exit 1
  fi
fi

STAGING=$(mktemp -d "${TMPDIR:-/tmp}/kesonode-upgrade.XXXXXX") || {
  printf '无法创建临时目录，已退出。\n'; exit 1;
}

cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT INT TERM

if command -v unzip >/dev/null 2>&1; then
  # 不加 -x 排除项：发布包里本来没有 __MACOSX / .DS_Store，写了反而会在
  # 每次正常解压时打印两条 "excluded filename not matched" 的干扰信息。
  unzip -q "$ZIP" -d "$STAGING" || {
    printf '解压失败，请确认文件完整。\n'; exit 1;
  }
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$ZIP" "$STAGING" || {
    printf '解压失败，请确认文件完整。\n'; exit 1;
  }
elif [ "$(uname -s)" = "Darwin" ] && command -v tar >/dev/null 2>&1; then
  # macOS 自带的是 bsdtar，能直接读 zip；Linux 的 GNU tar 不行。
  tar -xf "$ZIP" -C "$STAGING" || {
    printf '解压失败，请确认文件完整。\n'; exit 1;
  }
else
  printf '找不到可用的解压工具（unzip / python3）。请手动解压到这个目录。\n'
  exit 1
fi

# 安装包有两种排法：发布包里整个包放在一个 Kesonode 文件夹里（解压后直接得到
# 这个文件夹），商店包则是文件直接摊在根下。两种都要能认出来。
ROOT=""
if [ -f "$STAGING/manifest.json" ]; then
  ROOT="$STAGING"
else
  for DIR in "$STAGING"/*/; do
    [ -d "$DIR" ] || continue
    if [ -f "$DIR/manifest.json" ]; then
      ROOT="$DIR"
      break
    fi
  done
fi

if [ -z "$ROOT" ]; then
  printf '\n没有找到 manifest.json，这不是可直接加载的安装包。\n'
  printf '请重新下载安装包后再试。\n'
  exit 1
fi

PARENT=$(dirname "$TARGET")
mkdir -p "$PARENT" || { printf '无法创建目录：%s\n' "$PARENT"; exit 1; }

# 旧目录改名保留，不删：这一步是整个升级里唯一会动用户文件的地方，
# 留着它，新版万一有问题还能换回去。
if [ -e "$TARGET" ]; then
  OLD="$TARGET.old-$(date +%Y%m%d-%H%M%S)"
  if mv "$TARGET" "$OLD" 2>/dev/null; then
    printf '\n旧目录已改名保留：%s\n' "$OLD"
  else
    printf '\n无法把旧目录改名保留（%s 仍存在），已停止。请手动处理后重试。\n' "$TARGET"
    exit 1
  fi
fi

mkdir -p "$TARGET" || { printf '无法创建目录：%s\n' "$TARGET"; exit 1; }
# 复制内容而不是移动目录：STAGING 在临时盘上，跨盘 mv 会退化成复制 + 删除。
cp -R "$ROOT/." "$TARGET/" || { printf '复制到目标目录失败，已退出。\n'; exit 1; }

if [ ! -f "$TARGET/manifest.json" ]; then
  printf '\n目标目录里没有 manifest.json，安装失败。\n'
  exit 1
fi

COPIED=0
if command -v pbcopy >/dev/null 2>&1; then
  if printf '%s' "$TARGET" | pbcopy >/dev/null 2>&1; then COPIED=1; fi
elif command -v xclip >/dev/null 2>&1; then
  if printf '%s' "$TARGET" | xclip -selection clipboard >/dev/null 2>&1; then COPIED=1; fi
elif command -v wl-copy >/dev/null 2>&1; then
  if printf '%s' "$TARGET" | wl-copy >/dev/null 2>&1; then COPIED=1; fi
fi

# 尽力打开扩展管理页；不同浏览器对命令行传入 chrome:// 的支持不一致，
# 所以无论成功与否，下面都会把完整步骤打印出来。
if [ "$(uname -s)" = "Darwin" ]; then
  for APP in "Google Chrome" "Microsoft Edge" "Brave Browser"; do
    if open -Ra "$APP" >/dev/null 2>&1; then
      open -a "$APP" "chrome://extensions" >/dev/null 2>&1 || true
      break
    fi
  done
fi

printf '\n完成。新版目录：\n  %s\n' "$TARGET"
if [ "$COPIED" = "1" ]; then printf '路径已复制到剪贴板。\n'; fi
printf '\n接下来由浏览器确认（扩展无法代劳）：\n'
printf '  Chromium：打开 chrome://extensions（Edge 用 edge://extensions），\n'
printf '            找到旧的 Kesonode，点「重新加载」；\n'
printf '            如果它不在这个目录，点「加载已解压的扩展程序」并粘贴上面的路径。\n'
printf '  Firefox ：打开 about:debugging#/runtime/this-firefox，点「临时载入附加组件」，\n'
printf '            选择 %s/manifest.json\n' "$TARGET"
printf '\n这个目录的名字每次都一样，所以扩展 ID 和设置都会保留。\n'
printf '旧目录（改名成 .old-… 的那个）先别删，确认新版同步正常后再清理。\n\n'
printf '按回车键关闭本窗口……\n'
read -r _ || true
