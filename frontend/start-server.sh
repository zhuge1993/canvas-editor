#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT_DIR"

if [ -f "$ROOT_DIR/flowboard.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ROOT_DIR/flowboard.env"
  set +a
fi

if ! command -v node >/dev/null 2>&1; then
  echo "FlowBoard requires Node.js 20.19+." >&2
  exit 1
fi

NODE_OK="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.stdout.write(a>20 || (a===20 && b>=19) ? "1" : "0")')"
if [ "$NODE_OK" != "1" ]; then
  echo "FlowBoard requires Node.js 20.19+; current: $(node --version)" >&2
  exit 1
fi

export FLOWBOARD_HOST="${FLOWBOARD_HOST:-127.0.0.1}"
export FLOWBOARD_PORT="${FLOWBOARD_PORT:-3000}"
export FLOWBOARD_RUNTIME_DIR="$ROOT_DIR"

exec node "$ROOT_DIR/server-bundle.cjs" \
  --host "$FLOWBOARD_HOST" \
  --port "$FLOWBOARD_PORT" \
  --no-open \
  --no-console
