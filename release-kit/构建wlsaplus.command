#!/bin/bash
# ============================================
# wlsaplus 一键构建脚本（全程国内镜像）
# 适配 macOS Electron Forge（electron:make）
# 自动取消下载/构建文件的 macOS 隔离属性
# 双击即可运行
# ============================================

echo -ne "\033]0;构建 wlsaplus\007"
echo "============================================"
echo "   wlsaplus 一键构建脚本 (1.0.9+)"
echo "   （全程使用国内镜像，无需科学上网）"
echo "============================================"
echo ""

trap 'echo ""; echo "❌ 执行出错，请把上面的错误信息发给我"; read -n 1 -s -r -p "按任意键关闭..."; exit 1' ERR
set -e

# ===== 自动取消 macOS 隔离属性 =====
remove_quarantine() {
  local TARGET="$1"

  if [ -e "$TARGET" ]; then
    echo "    正在取消隔离：$TARGET"
    xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
  fi
}

# ===== [0/7] 清理旧的 npm 配置 =====
echo "==> [0/7] 清理旧的 npm 配置..."
if [ -f "$HOME/.npmrc" ]; then
  cp "$HOME/.npmrc" "$HOME/.npmrc.backup.$(date +%s)" 2>/dev/null || true
  sed -i '' '/^prefix=/d' "$HOME/.npmrc" 2>/dev/null || true
  sed -i '' '/^globalconfig=/d' "$HOME/.npmrc" 2>/dev/null || true
  echo "    已清理 ~/.npmrc 中的 prefix / globalconfig"
else
  echo "    ~/.npmrc 不存在，跳过"
fi

# ===== [1/7] 安装 nvm =====
echo "==> [1/7] 检查 nvm..."
if [ ! -s "$HOME/.nvm/nvm.sh" ]; then
  echo "    未检测到 nvm，正在从国内镜像安装..."
  bash -c "$(curl -fsSL https://gitee.com/RubyMetric/nvm-cn/raw/main/install.sh)"
else
  echo "    nvm 已安装，跳过"
fi

# 取消 nvm 安装文件的隔离属性
remove_quarantine "$HOME/.nvm"

# ===== [2/7] 加载 nvm =====
echo "==> [2/7] 加载 nvm 环境..."
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# ===== [3/7] 安装 Node.js =====
echo "==> [3/7] 配置 Node.js 国内镜像并安装 LTS 版本..."
export NVM_NODEJS_ORG_MIRROR="https://npmmirror.com/mirrors/node"

nvm install --lts

nvm use --lts --delete-prefix --silent 2>/dev/null || nvm use --lts

# 取消 Node.js 下载文件的隔离属性
remove_quarantine "$NVM_DIR"

echo "    Node.js 版本：$(node -v)"
echo "    npm 版本：$(npm -v)"

# ===== [4/7] 配置 npm 国内镜像 =====
echo "==> [4/7] 配置 npm 国内镜像..."
npm config set registry https://registry.npmmirror.com

# ===== [5/7] 配置 Electron / Forge 镜像 =====
echo "==> [5/7] 配置 Electron 和相关二进制国内镜像..."

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
export ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
# Electron Forge 也会读 ELECTRON_MIRROR
export ELECTRON_CACHE="${ELECTRON_CACHE:-$HOME/.cache/electron}"
export CSC_IDENTITY_AUTO_DISCOVERY=false

# ===== [6/7] 进入项目目录 =====
echo "==> [6/7] 进入项目目录..."
# 与 1.0.8 发布包相同约定：解压到「下载」后的路径
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -d "$SCRIPT_DIR/wlsaplus-enablemacos" ]; then
  PROJECT_DIR="$SCRIPT_DIR/wlsaplus-enablemacos"
else
  PROJECT_DIR="$HOME/Downloads/wlsaplusformac/wlsaplus-enablemacos"
fi

if [ ! -d "$PROJECT_DIR" ]; then
  echo ""
  echo "❌ 错误：项目目录不存在"
  echo "   期望路径：$PROJECT_DIR"
  echo "   或把本脚本与 wlsaplus-enablemacos 文件夹放在同一目录后再运行"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
fi

cd "$PROJECT_DIR"

echo "    当前目录：$(pwd)"
echo ""

# 取消项目目录已有下载文件的隔离属性
remove_quarantine "$PROJECT_DIR"

# ===== [7/7] 安装依赖并打包 =====
echo "==> [7/7] 安装依赖并打包（Forge / electron:make）..."

npm install

# npm 下载的全部依赖取消隔离
remove_quarantine "$PROJECT_DIR/node_modules"

# Electron 相关文件取消隔离
remove_quarantine "$PROJECT_DIR/node_modules/electron"
remove_quarantine "$PROJECT_DIR/node_modules/@electron"

echo ""
echo "==> npm 依赖安装完成，开始构建 macOS 包..."

npm run electron:make

# ===== 最终构建产物取消隔离 =====
echo ""
echo "==> 正在取消最终构建产物的 macOS 隔离属性..."

for DIR in "./out" "./out/make" "./dist" "./release"; do
  if [ -d "$DIR" ]; then
    remove_quarantine "$DIR"
  fi
done

find "$PROJECT_DIR" \
  -maxdepth 5 \
  \( -name "*.dmg" -o -name "*.app" -o -name "*.zip" \) \
  -exec xattr -dr com.apple.quarantine {} \; 2>/dev/null || true

# ===== 打开输出目录 =====
echo ""
echo "==> 打开输出目录..."

if [ -d "./out/make" ]; then
  open ./out/make
elif [ -d "./out" ]; then
  open ./out
elif [ -d "./dist" ]; then
  open ./dist
else
  echo "    未找到 out/make 等目录，请手动查看"
fi

echo ""
echo "============================================"
echo "  ✅ 全部完成！"
echo "  已自动取消相关下载文件及构建产物的"
echo "  macOS com.apple.quarantine 隔离属性。"
echo "  国内镜像：nvm-cn / npmmirror (node/npm/electron)"
echo "============================================"
echo ""
read -n 1 -s -r -p "按任意键关闭此窗口..."
