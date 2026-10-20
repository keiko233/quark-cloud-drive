#!/usr/bin/env bash
set -euo pipefail

cd /opt/quark-app

if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: bun is required for development" >&2
    exit 1
fi

# The repository is bind-mounted in Compose while node_modules lives in a
# named volume. Reconcile dependencies only when the lockfile changed.
lock_hash="$(sha256sum bun.lock | awk '{print $1}')"
stamp="node_modules/.quark-dev-lock"
installed_hash="$(cat "$stamp" 2>/dev/null || true)"
if [ ! -d node_modules ] || [ "$installed_hash" != "$lock_hash" ]; then
    echo "--- Installing workspace dependencies (bun.lock changed) ---"
    bun install --frozen-lockfile
    printf '%s\n' "$lock_hash" > "$stamp"
fi

echo "--- Starting Bun dev supervisor ---"
exec bun dev
