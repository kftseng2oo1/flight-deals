#!/bin/bash
# 第一次：建 repo + 推上去 + 開 GitHub Pages
# 需要 gh CLI 已登入（gh auth login）
set -e
REPO=flight-deals
cd "$(dirname "$0")"
git init -q 2>/dev/null || true
git add -A
git commit -qm "飛日韓 PWA" || true
gh repo create "$REPO" --public --source=. --push 2>/dev/null || git push -u origin main
gh api -X POST "repos/kftseng2oo1/$REPO/pages" -f 'source[branch]=main' -f 'source[path]=/' 2>/dev/null || true
echo "→ https://kftseng2oo1.github.io/$REPO/"
