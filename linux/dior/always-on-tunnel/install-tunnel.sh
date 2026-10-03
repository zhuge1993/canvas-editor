#!/bin/sh
set -eu
if [ "$(id -u)" != 0 ]; then
    printf '%s\n' 'Run this installer as root on the Dior Linux phone.' >&2
    exit 1
fi
case "$(uname -m)" in
    armv7l|armv8l) ;;
    *) printf '%s\n' 'This service installer is for the ARMv7 Dior appliance.' >&2; exit 1 ;;
esac
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
getent group flowboard-tunnel >/dev/null || addgroup -S flowboard-tunnel
id flowboard-tunnel >/dev/null 2>&1 || adduser -S -D -H -s /sbin/nologin -G flowboard-tunnel flowboard-tunnel
install -d -m 0750 -o root -g flowboard-tunnel /etc/dior-tunnel
install -d -m 0750 -o flowboard-tunnel -g flowboard-tunnel /var/log/dior-tunnel
install -d -m 0755 -o flowboard-tunnel -g flowboard-tunnel /var/lib/dior-tunnel
install -d -m 0755 /usr/local/libexec /usr/share/dior-tunnel
install -m 0755 "$base/dior-tunnel.initd" /etc/init.d/dior-tunnel
install -m 0755 "$base/dior-tunnel-run" /usr/local/libexec/dior-tunnel-run
install -m 0644 "$base/dior-tunnel-check.cjs" /usr/local/libexec/dior-tunnel-check.cjs
install -m 0644 "$base/dior-quick-tunnel.cjs" /usr/local/libexec/dior-quick-tunnel.cjs
for file in cloudflare.yml.example frpc.toml.example frps.toml.example Caddyfile.example clients.json; do
    install -m 0644 "$base/$file" "/usr/share/dior-tunnel/$file"
done
# Preserve an owner's configured provider, domain, and credentials on reinstallation.
if [ ! -e /etc/dior-tunnel/provider ]; then
    printf '%s\n' disabled > /etc/dior-tunnel/provider
    chmod 0640 /etc/dior-tunnel/provider
    chown root:flowboard-tunnel /etc/dior-tunnel/provider
fi
printf '%s\n' 'Installed tunnel service templates. No tunnel was started or enabled.'
printf '%s\n' 'Select quick for account-free temporary URLs, or configure cloudflare/frp for a fixed hostname.'
