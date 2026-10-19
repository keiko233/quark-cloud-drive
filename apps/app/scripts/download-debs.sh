#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEB_DIR="${DEB_DIR:-$SERVER_DIR/.deb-cache}"
DEEPIN_WINE8_URL="${DEEPIN_WINE8_URL:-https://d.spark-app.store/amd64-store/depends/deepin-wine8/deepin-wine8-stable_8.16deepin41_spark1_amd64.deb}"
SPARK_QUARK_URL="${SPARK_QUARK_URL:-https://d.spark-app.store/store/network/cn.quarkclouddrive.spark/cn.quarkclouddrive.spark_3.2.6spark4_all.deb}"

mkdir -p "$DEB_DIR"

download_deb() {
  local url="$1" dest="$2" expected_size
  expected_size="$(curl -fsSI --max-time 30 "$url" 2>/dev/null \
    | awk 'tolower($1)=="content-length:"{gsub(/[^0-9]/,"",$2); print $2}' || true)"
  if [ -s "$dest" ] && [ -z "$expected_size" ] || [ -s "$dest" ] && [ "$(stat -c%s "$dest")" = "$expected_size" ]; then
    echo "Using cached $(basename "$dest")"
    return 0
  fi
  echo "Downloading $(basename "$dest")"
  curl -fL --retry 3 --retry-delay 2 --max-time 600 "$url" -o "$dest"
  echo "Saved $(basename "$dest") ($(stat -c%s "$dest") bytes)"
}

download_deb "$DEEPIN_WINE8_URL" "$DEB_DIR/deepin-wine8.deb"
download_deb "$SPARK_QUARK_URL" "$DEB_DIR/quark-spark.deb"

echo "Spark deb dependencies ready in $DEB_DIR"