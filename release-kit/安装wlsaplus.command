#!/bin/bash
# ============================================
# WLSAPlus 1.0.9 一键安装 + 解除隔离（macOS，Apple 芯片）
# 适用于全新的 Mac：只用系统自带工具（hdiutil / xattr / ditto），
# 不安装 Homebrew / Node / Xcode，不访问任何境外网站。
# 安装包：wlsaplus1.0.9.dmg（放在本脚本同级或 ./download 里）
# ============================================

echo -ne "\033]0;安装 WLSAPlus\007"
echo "============================================"
echo "   WLSAPlus 1.0.9 一键安装 + 解除隔离"
echo "   （无需联网，无需科学上网）"
echo "============================================"
echo ""

fail() {
  echo ""
  echo "❌ $1"
  echo "   请把上面的信息截图发给我。"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || fail "无法进入脚本所在目录"

APP_NAME="WLSAPlus.app"
DEST="/Applications/$APP_NAME"
MNT=""

cleanup() {
  if [ -n "$MNT" ] && [ -d "$MNT" ]; then
    hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true
  fi
}
trap cleanup EXIT

remove_quarantine() {
  local TARGET="$1"
  if [ -e "$TARGET" ]; then
    echo "    取消隔离：$TARGET"
    xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
  fi
}

# ===== [1/6] 检查系统 =====
echo "==> [1/6] 检查系统..."
OS_VER="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
ARCH="$(uname -m)"
echo "    macOS：$OS_VER    芯片架构：$ARCH"
if [ "$ARCH" != "arm64" ]; then
  echo "    ⚠️ 本安装包只支持 Apple 芯片（M1/M2/M3/M4…），当前不是 arm64，可能无法运行。"
fi

# ===== [2/6] 先给本文件夹解除隔离 =====
echo "==> [2/6] 取消本文件夹（脚本、说明书、安装包）的隔离..."
remove_quarantine "$SCRIPT_DIR"

# ===== [3/6] 找安装包 =====
echo "==> [3/6] 查找 wlsaplus1.0.9.dmg..."
DMG=""
for C in \
  "$SCRIPT_DIR/wlsaplus1.0.9.dmg" \
  "$SCRIPT_DIR/download/wlsaplus1.0.9.dmg" \
  "$SCRIPT_DIR/Download/wlsaplus1.0.9.dmg" \
  "$HOME/Downloads/wlsaplus1.0.9.dmg"; do
  if [ -f "$C" ]; then DMG="$C"; break; fi
done
if [ -z "$DMG" ]; then
  DMG="$(find "$SCRIPT_DIR" -maxdepth 3 -iname 'wlsaplus*.dmg' -print -quit 2>/dev/null)"
fi
[ -n "$DMG" ] || fail "找不到 wlsaplus1.0.9.dmg。请把它和本脚本放在同一个文件夹（或 ./download 里）。"
echo "    找到：$DMG"
remove_quarantine "$DMG"

# ===== [4/6] 挂载 DMG =====
echo "==> [4/6] 挂载安装包..."
MNT="$(hdiutil attach -nobrowse -noverify -noautoopen "$DMG" 2>/dev/null | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -n 1)"
[ -n "$MNT" ] && [ -d "$MNT" ] || fail "挂载失败：安装包可能没下载完整，请重新下载 wlsaplus1.0.9.dmg。"
echo "    已挂载：$MNT"
SRC_APP="$(find "$MNT" -maxdepth 1 -name '*.app' -print -quit)"
[ -n "$SRC_APP" ] || fail "安装包里没有找到 .app"

# ===== [5/6] 安装到「应用程序」 =====
echo "==> [5/6] 安装到 /Applications..."
osascript -e 'tell application "WLSAPlus" to quit' >/dev/null 2>&1 || true
pkill -x WLSAPlus >/dev/null 2>&1 || true
sleep 1

if [ -w "/Applications" ]; then
  SUDO=""
else
  echo "    需要管理员密码（输入时屏幕不显示字符，输完按回车）"
  SUDO="sudo"
fi
if [ -e "$DEST" ]; then
  echo "    删除旧版本：$DEST"
  $SUDO rm -rf "$DEST" || fail "无法删除旧版本"
fi
$SUDO ditto "$SRC_APP" "$DEST" || fail "复制到 /Applications 失败"
echo "    已安装：$DEST"

# ===== [6/6] 解除隔离 =====
echo "==> [6/6] 解除应用的隔离属性..."
$SUDO xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
$SUDO xattr -cr "$DEST" 2>/dev/null || true
if xattr -lr "$DEST" 2>/dev/null | grep -q com.apple.quarantine; then
  echo "    ⚠️ 仍检测到隔离属性，首次打开请对 WLSAPlus 右键 → 打开"
else
  echo "    ✅ 已清除"
fi

cleanup
MNT=""

echo ""
echo "============================================"
echo "  ✅ 安装完成！正在打开 WLSAPlus…"
echo "============================================"
open "$DEST" || echo "    若没打开：在「应用程序」里双击 WLSAPlus"
echo ""
read -n 1 -s -r -p "按任意键关闭此窗口..."
echo ""
