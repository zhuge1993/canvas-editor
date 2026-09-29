#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
KERNEL_DIR="$SCRIPT_DIR/device/archived/linux-xiaomi-dior"

need() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "缺少命令: $1" >&2
		exit 1
	}
}

need sha512sum
need awk

if command -v curl >/dev/null 2>&1; then
	fetch() {
		url="$1"
		target="$2"
		curl -fL --retry 3 --connect-timeout 20 --max-time 180 -o "$target.tmp" "$url"
		mv "$target.tmp" "$target"
	}
elif command -v wget >/dev/null 2>&1; then
	fetch() {
		url="$1"
		target="$2"
		wget -O "$target.tmp" "$url"
		mv "$target.tmp" "$target"
	}
else
	echo "需要 curl 或 wget 下载历史补丁。" >&2
	exit 1
fi

download() {
	name="$1"
	url="$2"
	target="$KERNEL_DIR/$name"

	if [ -f "$target" ]; then
		echo "已存在，先交给 SHA-512 校验: $name"
		return
	fi

	echo "下载 $name"
	fetch "$url" "$target"
}

# All six sources are pinned to one immutable historical pmaports commit.
# Their file bytes were independently checked against the SHA-512 values in
# linux-xiaomi-dior/APKBUILD. check-snapshot.sh verifies them again after download,
# so a mirror error or unexpected content change always stops the image build.
MIRROR_COMMIT="7aaf86b4b194987aeedbad7e29f3de53c8c28ebd"
MIRROR_BASE="https://raw.githubusercontent.com/sm7150-mainline/pmaports/$MIRROR_COMMIT"

download "gcc10-extern_YYLOC_global_declaration.patch" \
	"$MIRROR_BASE/device/.shared-patches/linux/gcc10-extern_YYLOC_global_declaration.patch"

download "linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch" \
	"$MIRROR_BASE/device/.shared-patches/linux/linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch"

download "kernel-use-the-gnu89-standard-explicitly.patch" \
	"$MIRROR_BASE/device/.shared-patches/linux/kernel-use-the-gnu89-standard-explicitly.patch"

download "linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch" \
	"$MIRROR_BASE/device/.shared-patches/linux/linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch"

download "0001-fix-refresh-rate.patch" \
	"$MIRROR_BASE/device/testing/linux-xiaomi-dior/0001-fix-refresh-rate.patch"

download "0001-framebuffer-fixes.patch" \
	"$MIRROR_BASE/device/testing/linux-xiaomi-dior/0001-framebuffer-fixes.patch"

echo
echo "下载完成，执行锁定 APKBUILD SHA-512 校验..."
sh "$SCRIPT_DIR/check-snapshot.sh"
