#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行: sudo ./install-linux.sh" >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="/opt/flowboard"
SERVICE_FILE="/etc/systemd/system/flowboard.service"

for required in server-bundle.cjs dist/index.html start-server.sh flowboard.service flowboard.env.example; do
  if [[ ! -e "$SOURCE_DIR/$required" ]]; then
    echo "安装包缺少 $required，请先执行 pnpm run build:linux 并解压 FlowBoard-linux.tar.gz" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs ca-certificates
  else
    echo "未找到 Node.js。请先安装 Node.js 20.19+。" >&2
    exit 1
  fi
fi

NODE_OK="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.stdout.write(a>20 || (a===20 && b>=19) ? "1" : "0")')"
if [[ "$NODE_OK" != "1" ]]; then
  echo "Node.js 版本过低：$(node --version)，需要 20.19+。" >&2
  echo "Debian 13 armhf 官方仓库提供符合要求的 Node.js 20.19.x。" >&2
  exit 1
fi

if ! id flowboard >/dev/null 2>&1; then
  useradd --system --home-dir "$TARGET_DIR" --create-home --shell /usr/sbin/nologin flowboard
fi

install -d -o flowboard -g flowboard -m 0750 "$TARGET_DIR"
install -d -o flowboard -g flowboard -m 0750 "$TARGET_DIR/project-data" "$TARGET_DIR/auth-data" "$TARGET_DIR/logs"

install -m 0644 "$SOURCE_DIR/server-bundle.cjs" "$TARGET_DIR/server-bundle.cjs"
rm -rf "$TARGET_DIR/dist"
cp -a "$SOURCE_DIR/dist" "$TARGET_DIR/dist"
install -m 0755 "$SOURCE_DIR/start-server.sh" "$TARGET_DIR/start-server.sh"
install -m 0644 "$SOURCE_DIR/flowboard.env.example" "$TARGET_DIR/flowboard.env.example"

if [[ ! -f "$TARGET_DIR/flowboard.env" ]]; then
  install -m 0600 -o flowboard -g flowboard "$SOURCE_DIR/flowboard.env.example" "$TARGET_DIR/flowboard.env"
fi

chown -R flowboard:flowboard "$TARGET_DIR"
chmod 0600 "$TARGET_DIR/flowboard.env"
install -m 0644 "$SOURCE_DIR/flowboard.service" "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable --now flowboard.service

echo
echo "FlowBoard 已安装到 $TARGET_DIR"
echo "服务状态: systemctl status flowboard --no-pager"
echo "实时日志: journalctl -u flowboard -f"
echo
echo "下一步配置 QQ SMTP（只需要授权码）："
echo "  sudo -u flowboard node /opt/flowboard/server-bundle.cjs set stp <授权码>"
echo "  sudo systemctl restart flowboard"
echo
echo "默认根管理员邮箱: 804559340@qq.com"
echo "默认最多注册用户: 20（可在 /opt/flowboard/flowboard.env 修改 FLOWBOARD_MAX_USERS）"
