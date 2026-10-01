#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEVICE_DIR="$SCRIPT_DIR/device/archived/device-xiaomi-dior"
KERNEL_DIR="$SCRIPT_DIR/device/archived/linux-xiaomi-dior"
DEVICE_APKBUILD="$DEVICE_DIR/APKBUILD"
KERNEL_APKBUILD="$KERNEL_DIR/APKBUILD"
WCNSS_DIR="$SCRIPT_DIR/main/wcnss-wlan"
WCNSS_APKBUILD="$WCNSS_DIR/APKBUILD"

for apkbuild in "$DEVICE_APKBUILD" "$KERNEL_APKBUILD" "$WCNSS_APKBUILD"; do
	if [ ! -f "$apkbuild" ]; then
		echo "缺少 $apkbuild" >&2
		exit 1
	fi
done

need() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "缺少命令: $1" >&2
		exit 1
	}
}
need sha512sum
need awk

failed=0

verify_source() {
	dir="$1"
	apkbuild="$2"
	name="$3"
	file="$dir/$name"
	expected="$(awk -v target="$name" '$2 == target { print $1; exit }' "$apkbuild")"

	if [ -z "$expected" ]; then
		echo "✗ $(basename "$apkbuild") 没有 $name 的 SHA-512" >&2
		failed=1
		return
	fi
	if [ ! -f "$file" ]; then
		echo "✗ 缺少 $file" >&2
		failed=1
		return
	fi

	actual="$(sha512sum "$file" | awk '{print $1}')"
	if [ "$actual" != "$expected" ]; then
		echo "✗ $name"
		echo "  expected: $expected"
		echo "  actual  : $actual"
		failed=1
	else
		echo "✓ $name"
	fi
}

echo "校验 dior device 本地源文件..."
verify_source "$DEVICE_DIR" "$DEVICE_APKBUILD" "deviceinfo"
verify_source "$DEVICE_DIR" "$DEVICE_APKBUILD" "kernel-cmdline.conf"

echo
echo "校验 dior kernel config + 6 patches..."
for name in \
	config-xiaomi-dior.armv7 \
	gcc10-extern_YYLOC_global_declaration.patch \
	linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch \
	kernel-use-the-gnu89-standard-explicitly.patch \
	linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch \
	0001-fix-refresh-rate.patch \
	0001-framebuffer-fixes.patch \
	0001-prima-nv-v1-compatibility.patch \
	0002-thermal-genl-group-name.patch
do
	verify_source "$KERNEL_DIR" "$KERNEL_APKBUILD" "$name"
done

echo
echo "校验 downstream WCNSS helper..."
verify_source "$WCNSS_DIR" "$WCNSS_APKBUILD" "wcnss-wlan.initd"
verify_source "$WCNSS_DIR" "$WCNSS_APKBUILD" "wcnss-wlan.service"
if [ ! -f "$WCNSS_DIR/wcnss-wlan-openrc.post-install" ]; then
	echo "✗ 缺少 $WCNSS_DIR/wcnss-wlan-openrc.post-install" >&2
	failed=1
else
	echo "✓ wcnss-wlan-openrc.post-install"
fi

if [ "$failed" -ne 0 ]; then
	echo
	echo "dior pmaports snapshot 仍不完整或文件哈希不匹配。" >&2
	exit 1
fi

echo
echo "dior device/kernel snapshot + WCNSS helper 已通过锁定源文件校验。"
