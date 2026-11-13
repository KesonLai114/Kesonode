#!/bin/sh
# Kesonode 一键升级助手（macOS / Linux）
#
# 浏览器扩展不能替换自己的代码，所以这一步必须由一个普通本机程序完成。
# 本脚本只做「找到 zip → 校验路径 → 解压到一个全新目录 → 复制路径」，
# 绝不覆盖正在运行的旧目录（chunks/ 带内容哈希，覆盖会混入旧 chunk）。
# 最后一步「移除旧版 / 加载已解压」仍由浏览器要求人工确认，脚本无法代劳。
#
# 用法：直接双击运行，或 sh upgrade.sh /path/to/kesonode-chrome-1.5.19.zip

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

# 拒绝路径穿越 / 绝对路径的压缩包。设置页已做过一次，这里独立再做一次：
# 真正写磁盘的是本脚本，不能只信任浏览器那边的判断。
if command -v unzip >/dev/null 2>&1; then
  if unzip -Z1 "$ZIP" 2>/dev/null | grep -Eq '(^/|(^|/)\.\.(/|$)|^[A-Za-z]:)'; then
    printf '\n压缩包包含不安全的路径，已停止解压。请重新下载安装包。\n'
    exit 1
  fi
fi

BASE=$(basename "$ZIP" .zip)
VERSION=$(printf '%s' "$BASE" | sed -n 's/.*-\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$/\1/p')
[ -n "$VERSION" ] || VERSION=$(date +%Y%m%d-%H%M%S)

DEST="$HOME/Downloads/Kesonode-v$VERSION"
SUFFIX=2
while [ -e "$DEST" ]; do
  DEST="$HOME/Downloads/Kesonode-v$VERSION-$SUFFIX"
  SUFFIX=$((SUFFIX + 1))
done

mkdir -p "$DEST" || { printf '无法创建目录：%s\n' "$DEST"; exit 1; }
printf '\n解压到全新目录：%s\n' "$DEST"

if command -v unzip >/dev/null 2>&1; then
  # 不加 -x 排除项：发布包里本来没有 __MACOSX / .DS_Store，写了反而会在
  # 每次正常解压时打印两条 "excluded filename not matched" 的干扰信息。
  unzip -q "$ZIP" -d "$DEST" || {
    printf '解压失败，请确认文件完整。\n'; exit 1;
  }
elif command -v python3 >/dev/null 2>&1; then
  python3 -m zipfile -e "$ZIP" "$DEST" || {
    printf '解压失败，请确认文件完整。\n'; exit 1;
  }
elif [ "$(uname -s)" = "Darwin" ] && command -v tar >/dev/null 2>&1; then
  # macOS 自带的是 bsdtar，能直接读 zip；Linux 的 GNU tar 不行。
  tar -xf "$ZIP" -C "$DEST" || { printf '解压失败，请确认文件完整。\n'; exit 1; }
else
  printf '找不到可用的解压工具（unzip / python3）。请手动解压到这个目录。\n'
  exit 1
fi

if [ ! -f "$DEST/manifest.json" ]; then
  printf '\n解压后的目录根下没有 manifest.json，这不是可直接加载的安装包。\n'
  printf '常见原因：解压时多套了一层文件夹。请勿加载这个目录。\n'
  exit 1
fi

COPIED=0
if command -v pbcopy >/dev/null 2>&1; then
  if printf '%s' "$DEST" | pbcopy >/dev/null 2>&1; then COPIED=1; fi
elif command -v xclip >/dev/null 2>&1; then
  if printf '%s' "$DEST" | xclip -selection clipboard >/dev/null 2>&1; then COPIED=1; fi
elif command -v wl-copy >/dev/null 2>&1; then
  if printf '%s' "$DEST" | wl-copy >/dev/null 2>&1; then COPIED=1; fi
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

printf '\n完成。新版目录：\n  %s\n' "$DEST"
if [ "$COPIED" = "1" ]; then printf '路径已复制到剪贴板。\n'; fi
printf '\n接下来由浏览器确认（扩展无法代劳）：\n'
printf '  Chromium：打开 chrome://extensions（Edge 用 edge://extensions），移除旧的 Kesonode，\n'
printf '            点「加载已解压的扩展程序」，粘贴上面的路径。\n'
printf '  Firefox ：打开 about:debugging#/runtime/this-firefox，点「临时载入附加组件」，\n'
printf '            选择 %s/manifest.json\n' "$DEST"
printf '\n安装包固定了扩展 ID，配置会自动保留，不需要导出 / 导入。\n'
printf '旧目录先别删，确认新版同步正常后再清理。\n\n'
printf '按回车键关闭本窗口……\n'
read -r _ || true
