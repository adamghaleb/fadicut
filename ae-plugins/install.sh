#!/usr/bin/env bash
# Symlink the vendored Fadi CEP extensions into Adobe's extensions dir so After Effects
# / Photoshop load them. Run after cloning fadicut. Idempotent.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions"
mkdir -p "$DEST"

# Enable unsigned CEP extensions (needed for local dev panels)
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done

for ext in com.fadi.fadifx com.fadi.fadirange com.fadi.fadistrobe com.fadi.srt-importer; do
  if [ -d "$SRC/$ext" ]; then
    ln -sfn "$SRC/$ext" "$DEST/$ext"
    echo "  ✓ linked $ext"
  fi
done
echo "Done. Restart Adobe app → Window ▸ Extensions ▸ Fadi panels."
