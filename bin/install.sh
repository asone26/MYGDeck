#!/bin/bash
# 이 폴더(bin)를 PATH에 추가한다 (macOS, zsh). 새로 연 터미널부터 어디서든 mygdeck을 쓸 수 있다.
set -euo pipefail
BIN="$(cd "$(dirname "$0")" && pwd)"
RC="$HOME/.zshrc"
LINE="export PATH=\"$BIN:\$PATH\""
if grep -qsF "$LINE" "$RC"; then
  echo "이미 PATH에 있습니다: $BIN"
else
  printf '\n# mygdeck\n%s\n' "$LINE" >> "$RC"
  echo "PATH에 추가했습니다: $BIN ($RC)"
  echo "새 터미널을 열고 mygdeck 을 입력하세요."
fi
