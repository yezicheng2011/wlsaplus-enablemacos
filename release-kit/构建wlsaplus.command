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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR=""
# 1) 脚本在仓库内：.../wlsaplus-enablemacos/release-kit/本脚本 → 使用上一级仓库
if [ -f "$SCRIPT_DIR/../package.json" ] && [ -f "$SCRIPT_DIR/../electron/main.cjs" ]; then
  PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  echo "    使用仓库内路径（推荐）：$PROJECT_DIR"
# 2) 脚本与解压出的项目文件夹同级
elif [ -d "$SCRIPT_DIR/wlsaplus-enablemacos" ] && [ -f "$SCRIPT_DIR/wlsaplus-enablemacos/package.json" ]; then
  PROJECT_DIR="$SCRIPT_DIR/wlsaplus-enablemacos"
  echo "    使用与脚本同级的项目文件夹：$PROJECT_DIR"
# 3) 旧版约定：下载目录（容易是过期克隆，仅作回退）
elif [ -d "$HOME/Downloads/wlsaplusformac/wlsaplus-enablemacos" ]; then
  PROJECT_DIR="$HOME/Downloads/wlsaplusformac/wlsaplus-enablemacos"
  echo "    ⚠️ 回退到下载目录：$PROJECT_DIR"
  echo "    若白屏未修复，请改用 git clone 的仓库，或把本脚本放进仓库 release-kit/ 后再运行"
fi

if [ -z "$PROJECT_DIR" ] || [ ! -d "$PROJECT_DIR" ]; then
  echo ""
  echo "❌ 错误：找不到项目目录"
  echo "   请任选其一："
  echo "   A) git clone 后双击仓库内 release-kit/构建wlsaplus.command"
  echo "   B) 把本脚本与 wlsaplus-enablemacos 文件夹放在同一目录"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
fi

cd "$PROJECT_DIR"

echo "    当前目录：$(pwd)"
if [ -d .git ]; then
  echo "    正在 git fetch / pull origin main，确保不是旧克隆…"
  git fetch origin main 2>/dev/null || true
  git pull --ff-only origin main 2>/dev/null || git pull --ff-only 2>/dev/null || echo "    （pull 失败可忽略：若已是最新或无网络）"
  HEAD_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  HEAD_SUBJ="$(git log -1 --pretty=%s 2>/dev/null || true)"
  echo "    Git HEAD：$HEAD_SHORT $HEAD_SUBJ"
  if git merge-base --is-ancestor 2ea0edc HEAD 2>/dev/null; then
    echo "    ✅ 已包含 node_modules 白屏修复 2ea0edc"
  else
    echo ""
    echo "❌ 当前代码不含白屏修复提交 2ea0edc（及后续修复）。"
    echo "   请在本目录执行：git fetch origin && git checkout main && git pull"
    echo "   或重新 clone：https://github.com/yezicheng2011/wlsaplus-enablemacos"
    read -n 1 -s -r -p "按任意键关闭..."
    exit 1
  fi
  if git merge-base --is-ancestor fdd798b HEAD 2>/dev/null; then
    echo "    ✅ 已包含 loadFile 渲染加载修复 fdd798b"
  else
    echo ""
    echo "❌ 当前代码不含 loadFile 白屏修复提交 fdd798b。"
    echo "   请 git pull 最新 main 后再构建。"
    read -n 1 -s -r -p "按任意键关闭..."
    exit 1
  fi
fi

# 内容级校验：打包主进程必须用 loadFile（避免 file:// 在 asar/空格路径下白屏）
if ! grep -q "loadFile" "$PROJECT_DIR/electron/main.cjs" 2>/dev/null; then
  echo ""
  echo "❌ electron/main.cjs 缺少 loadFile（渲染页加载修复）。"
  echo "   当前目录很可能是旧克隆。请 git pull 最新 main 后再构建。"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
fi
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

if [ ! -f "./dist/wlsaplus/browser/index.html" ]; then
  echo ""
  echo "❌ 构建后缺少 dist/wlsaplus/browser/index.html，安装包会白屏。"
  echo "   请把上面的构建日志发给我。"
  read -n 1 -s -r -p "按任意键关闭..."
  exit 1
fi

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
# Electron Forge：可安装的 DMG/ZIP 在 out/make（.app 在 out/ 下）
# dist/ 只是 Angular 前端产物，不是安装包目录（1.0.8 的 out-builder 已废弃）
echo ""
echo "==> 打开安装包目录（优先 out/make）..."

OPENED=""
if [ -d "./out/make" ] && find "./out/make" -maxdepth 3 \( -name "*.dmg" -o -name "*.zip" \) 2>/dev/null | grep -q .; then
  open ./out/make
  OPENED="./out/make"
elif [ -d "./out/make" ]; then
  open ./out/make
  OPENED="./out/make"
elif [ -d "./out" ]; then
  open ./out
  OPENED="./out"
else
  echo "    未找到 out/make（Forge 安装包目录）。"
  echo "    说明：dist/ 只是网页前端构建结果，里面没有 .dmg/.app 安装包。"
  if [ -d "./dist" ]; then
    echo "    检测到 dist/ 存在，但不自动打开，避免和安装包搞混。"
  fi
fi

if [ -n "$OPENED" ]; then
  echo "    已打开：$OPENED"
  echo "    请在其中找 .dmg 或 .zip（不要到 dist/ 里找安装包）"
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
