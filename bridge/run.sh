#!/usr/bin/env bash
# Fadi Bridge launcher.
#   ./run.sh           # create/reuse .venv, install deps, run on 127.0.0.1:8765
#   FADI_BRIDGE_PORT=9000 ./run.sh
# A token is auto-generated and printed in the startup log unless FADI_BRIDGE_TOKEN is set.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Prefer a 3.10–3.13 interpreter (best wheel availability); fall back to python3.
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1; then PY="$c"; break; fi
done
if [[ -z "$PY" ]]; then echo "No python3 found" >&2; exit 1; fi

VENV="$HERE/.venv"
if [[ ! -d "$VENV" ]]; then
  echo "Creating venv at $VENV using $PY"
  "$PY" -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate"

python -m pip install --quiet --upgrade pip
python -m pip install --quiet -r "$HERE/requirements.txt"
# Frozen contract package (editable so contract edits are picked up live).
python -m pip install --quiet -e "$HERE/../contracts"

exec python -m bridge
