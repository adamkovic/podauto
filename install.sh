#!/bin/zsh
# PodCut installer — symlinks the extension into Premiere's CEP folder and
# enables unsigned-extension loading (PlayerDebugMode).
set -e

SRC="$(cd "$(dirname "$0")/com.adamk.podcut" && pwd)"
DEST_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$DEST_DIR/com.adamk.podcut"

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
ln -s "$SRC" "$DEST"
echo "Linked: $DEST -> $SRC"

# Allow unsigned (personal) extensions for recent CEP runtimes
for v in 10 11 12; do
  defaults write com.adobe.CSXS.$v PlayerDebugMode 1
done
echo "PlayerDebugMode enabled for CSXS 10/11/12."

if ! command -v ffmpeg >/dev/null 2>&1 && [ ! -x /opt/homebrew/bin/ffmpeg ] && [ ! -x /usr/local/bin/ffmpeg ]; then
  echo ""
  echo "⚠️  ffmpeg not found — PodCut needs it for audio analysis. Install with:"
  echo "    brew install ffmpeg"
fi

echo ""
echo "Done. Restart Premiere Pro, then open:  Window → Extensions → PodCut — Auto Podcast Editor"
