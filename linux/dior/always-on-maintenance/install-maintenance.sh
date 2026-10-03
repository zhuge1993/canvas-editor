#!/bin/sh
set -eu
[ "$(id -u)" = 0 ] || { echo 'Linux root required' >&2; exit 1; }
case "$(uname -m)" in armv7l|armv8l) ;; *) echo 'Dior ARMv7 appliance required' >&2; exit 1 ;; esac
command -v python3 >/dev/null
base=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 /usr/local/libexec /etc/periodic/hourly
install -m 0644 "$base/dior-maintenance.py" /usr/local/libexec/dior-maintenance.py
install -m 0755 "$base/dior-maintenance" /etc/periodic/hourly/dior-maintenance
rc-update add crond default
rc-service crond start
python3 /usr/local/libexec/dior-maintenance.py
