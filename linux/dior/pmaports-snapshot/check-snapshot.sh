#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
KERNEL_DIR="$SCRIPT_DIR/device/archived/linux-xiaomi-dior"
APKBUILD="$KERNEL_DIR/APKBUILD"

if [ ! -f "$APKBUILD" ]; then
	echo "缺少 $APKBUILD" >&2
	exit 1
fi

need() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "缺少命令: $1" >&2
		exit 1
	}
}
need sha512sum
need awk

required="
config-xiaomi-dior.armv7
gcc10-extern_YYLOC_global_declaration.patch
linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch
kernel-use-the-gnu89-standard-explicitly.patch
linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch
0001-fix-refresh-rate.patch
0001-framebuffer-fixes.patch
"

failed=0
for name in $required; do
	file="$KERNEL_DIR/$name"
	expected="$(awk -v target="$name" '$2 == target { print $1; exit }' "$APKBUILD")"
	if [ -z "$expected" ]; then
		echo "✗ APKBUILD 没有 $name 的 SHA-512" >&2
		failed=1
		continue
	fi
	if [ ! -f "$file" ]; then
		echo "✗ 缺少 $name"
		failed=1
		continue
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
done

if [ "$failed" -ne 0 ]; then
	echo
	echo "dior pmaports snapshot 仍不完整或文件哈希不匹配。" >&2
	exit 1
fi

echo
echo "dior kernel config + 6 patches 已全部按 APKBUILD SHA-512 校验通过。"
