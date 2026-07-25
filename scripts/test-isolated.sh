#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar -C "$root" --null -T <(while IFS= read -r -d '' file; do test -e "$root/$file" && printf '%s\0' "$file"; done < <(git -C "$root" ls-files --cached --others --exclude-standard -z)) -cf - | tar -C "$tmp" -xf -
for sibling in chadlands telegram_collector dotfiles ignis; do test ! -e "$tmp/../$sibling"; done
nix develop "$tmp" --command npm --prefix "$tmp" ci --ignore-scripts
nix develop "$tmp" --command npm --prefix "$tmp" run lint
nix develop "$tmp" --command npm --prefix "$tmp" test
