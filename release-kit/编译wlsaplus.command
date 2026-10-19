#!/bin/bash
# ============================================
# WLSAPlus 2.0.0 一键从源码编译（macOS）
# 依赖：Xcode 命令行工具；不需要 Node / Homebrew / 开发者账号
# ============================================

echo -ne "\033]0;编译 WLSAPlus\007"
echo "============================================"
echo "   WLSAPlus 2.0.0 · 从源码编译"
echo "   （自研开源 MockMini · Apache-2.0）"
echo "============================================"
echo ""

fail() {
  echo ""
  echo "❌ $1"
  echo "   请把上面的信息截图发给维护者，或对照说明书排查。"
  read -n 1 -s -r -p "按任意键关闭..."
  echo ""
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# release-kit/ → 仓库根目录
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVE="$REPO_ROOT/native"
VERSION="${WLSAPLUS_VERSION:-2.0.0}"

[[ "$(uname -s)" == Darwin ]] || fail "请在 Mac 上运行本脚本。"

echo "==> [1/4] 检查系统与命令行工具..."
OS_VER="$(sw_vers -productVersion 2>/dev/null || echo unknown)"
ARCH="$(uname -m)"
echo "    macOS：$OS_VER    架构：$ARCH"

if ! xcode-select -p >/dev/null 2>&1; then
  echo "    未检测到 Xcode 命令行工具，正在拉起安装程序…"
  xcode-select --install 2>/dev/null || true
  fail "请先在弹出窗口中安装「命令行工具」，完成后重新双击本脚本。"
fi
xcrun --sdk macosx --show-sdk-path >/dev/null 2>&1 || fail "命令行工具不完整，请执行：xcode-select --install"

[[ -d "$NATIVE/scripts" ]] || fail "找不到 native/scripts。请确认本脚本位于仓库的 release-kit/ 目录（先 git clone 本仓库）。"
[[ -x "$NATIVE/scripts/build.sh" ]] || chmod +x "$NATIVE/scripts/build.sh" 2>/dev/null || true

echo "==> [2/4] 编译原生应用（版本 $VERSION，universal）..."
cd "$NATIVE" || fail "无法进入 $NATIVE"
WLSAPLUS_VERSION="$VERSION" bash scripts/build.sh || fail "编译失败。"

APP="$NATIVE/out/WLSAPlus.app"
[[ -d "$APP" ]] || fail "未找到 $APP"

echo "==> [3/4] 解除隔离属性…"
xattr -cr "$APP" 2>/dev/null || true

echo "==> [4/4] 打开应用…"
open "$APP" || fail "无法打开应用。"

echo ""
echo "✅ 完成：$APP"
echo "   可选安装到应用程序："
echo "   ditto \"$APP\" /Applications/WLSAPlus.app && xattr -cr /Applications/WLSAPlus.app"
echo ""
echo "   首次若提示「无法验证开发者」：右键应用 → 打开 → 打开。"
echo "   © daniel.ye"
echo ""
read -n 1 -s -r -p "按任意键关闭..."
echo ""
