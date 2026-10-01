#!/bin/sh
set -eu

[ "$(id -u)" = 0 ] || { echo 'Run as root on the Dior phone.' >&2; exit 1; }
case "$(uname -m):$(uname -r)" in armv7l:3.4.*|armv8l:3.4.*) ;; *) echo 'This compatibility setup is for Dior Linux 3.4.' >&2; exit 1 ;; esac

install -d -m 0755 /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/90-dior-prima-stable-mac.conf <<'EOF'
# The downstream prima SME keeps the MAC selected at driver startup.
[device-dior-prima]
match-device=interface-name:wlan0
wifi.scan-rand-mac-address=no
EOF

# Arguments are existing profile UUIDs; credentials are never accepted here.
for profile in "$@"; do
    nmcli connection modify uuid "$profile" \
        connection.autoconnect yes connection.autoconnect-retries 0 \
        connection.autoconnect-priority 100 \
        802-11-wireless.cloned-mac-address preserve \
        802-11-wireless.powersave 2
done

# Save a plausible boot-time clock. Network NTP corrects it after WiFi returns.
install -d -m 0755 /var/lib/misc
touch /var/lib/misc/openrc-shutdowntime
rc-update add swclock boot
if [ -f /etc/conf.d/chronyd ] && ! grep -q 'Dior 3.4 seccomp compatibility' /etc/conf.d/chronyd; then
    cat >> /etc/conf.d/chronyd <<'EOF'

# Dior 3.4 seccomp compatibility: this kernel has no filter mode.
# Keep chrony's own privilege dropping; override the distro's -F 1.
command_args="${command_args:-} -F 0"
EOF
fi
rc-update add chronyd default
rc-update add flowboard default
echo 'Saved multi-profile reconnect and clock configuration. Reboot once before validating the fresh prima MAC.'
