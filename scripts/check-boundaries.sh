#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pattern='chadlands|mud[-_ ]room|reckoning|gigachad|strategy[-_ ]session|scoped_workspace|/home/ogle|\.\./(dotfiles|telegram_collector|ignis)'
mapfile -t files < <(git -C "$root" ls-files 'src/**' 'test/**' 'config.example.yaml' 'README.md' 'REAL_CREDENTIAL_SMOKE.md' 'UPSTREAM.md')
if ((${#files[@]})) && git -C "$root" grep -nEi "$pattern" -- "${files[@]}"; then
  echo 'collector boundary audit failed' >&2
  exit 1
fi
echo "collector boundary audit passed (${#files[@]} tracked files)"
