#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 运行，例如: doas ./install-linux.sh 或 sudo ./install-linux.sh" >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="/opt/flowboard"
PLATFORM=""

if command -v apk >/dev/null 2>&1 && command -v rc-service >/dev/null 2>&1; then
  PLATFORM="openrc"
elif command -v apt-get >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  PLATFORM="systemd"
else
  echo "当前脚本支持 postmarketOS/Alpine(OpenRC) 和 Debian/Ubuntu(systemd)。" >&2
  exit 1
fi

for required in server-bundle.cjs dist/index.html start-server.sh flowboard.env.example; do
  if [[ ! -e "$SOURCE_DIR/$required" ]]; then
    echo "安装包缺少 $required，请先生成并解压 FlowBoard-linux.tar.gz" >&2
    exit 1
  fi
done

if [[ "$PLATFORM" == "openrc" && ! -e "$SOURCE_DIR/flowboard.openrc" ]]; then
  echo "安装包缺少 flowboard.openrc" >&2
  exit 1
fi
if [[ "$PLATFORM" == "systemd" && ! -e "$SOURCE_DIR/flowboard.service" ]]; then
  echo "安装包缺少 flowboard.service" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  if [[ "$PLATFORM" == "openrc" ]]; then
    apk add --no-cache nodejs ca-certificates
  else
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs ca-certificates
  fi
fi

NODE_OK="$(node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.stdout.write(a>20 || (a===20 && b>=19) ? "1" : "0")')"
if [[ "$NODE_OK" != "1" ]]; then
  echo "Node.js 版本过低：$(node --version)，需要 20.19+。" >&2
  echo "postmarketOS/Alpine 新版 ARMv7 Node.js 或 Debian 13 armhf 均可满足。" >&2
  exit 1
fi

if ! id flowboard >/dev/null 2>&1; then
  if [[ "$PLATFORM" == "openrc" ]]; then
    addgroup -S flowboard
    adduser -S -D -H -h "$TARGET_DIR" -s /sbin/nologin -G flowboard flowboard
  else
    useradd --system --home-dir "$TARGET_DIR" --create-home --shell /usr/sbin/nologin flowboard
  fi
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

if [[ "$PLATFORM" == "openrc" ]]; then
  install -m 0755 "$SOURCE_DIR/flowboard.openrc" /etc/init.d/flowboard
  rc-update add flowboard default >/dev/null 2>&1 || true
  rc-service flowboard restart
else
  install -m 0644 "$SOURCE_DIR/flowboard.service" /etc/systemd/system/flowboard.service
  systemctl daemon-reload
  systemctl enable --now flowboard.service
fi

echo
echo "FlowBoard 已安装到 $TARGET_DIR"
echo "运行平台: $PLATFORM"
if [[ "$PLATFORM" == "openrc" ]]; then
  echo "服务状态: rc-service flowboard status"
  echo "重启服务: rc-service flowboard restart"
else
  echo "服务状态: systemctl status flowboard --no-pager"
  echo "实时日志: journalctl -u flowboard -f"
fi
echo
echo "配置 QQ SMTP（只需要授权码）："
echo "  su -s /bin/sh flowboard -c 'node /opt/flowboard/server-bundle.cjs set stp <授权码>'"
echo
echo "默认根管理员邮箱: 804559340@qq.com"
echo "默认最多注册用户: 20（可在 /opt/flowboard/flowboard.env 修改 FLOWBOARD_MAX_USERS）"
