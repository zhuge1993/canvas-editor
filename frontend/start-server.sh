#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/flowboard.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/flowboard.env"
  set +a
fi

export FLOWBOARD_HOST="${FLOWBOARD_HOST:-127.0.0.1}"
export FLOWBOARD_PORT="${FLOWBOARD_PORT:-3000}"
export FLOWBOARD_RUNTIME_DIR="$ROOT_DIR"

exec node "$ROOT_DIR/server-bundle.cjs" \
  --host "$FLOWBOARD_HOST" \
  --port "$FLOWBOARD_PORT" \
  --no-open
