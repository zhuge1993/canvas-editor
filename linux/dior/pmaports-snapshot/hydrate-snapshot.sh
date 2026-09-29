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

# Generic downstream-kernel compatibility patches. SourceForge entries are a
# 2025 pmaports mirror; GitLab URLs are pinned/shared postmarketOS history.
download "gcc10-extern_YYLOC_global_declaration.patch" 	"https://sourceforge.net/projects/cactusrom/files/SourceFS/mnt/pmbootstrap/git/pmaports/device/testing/linux-samsung-treltexx/gcc10-extern_YYLOC_global_declaration.patch/download"

download "linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch" 	"https://gitlab.com/postmarketOS/pmaports/-/raw/ci-tests/device/.shared-patches/linux/linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch"

download "kernel-use-the-gnu89-standard-explicitly.patch" 	"https://sourceforge.net/projects/cactusrom/files/SourceFS/mnt/pmbootstrap/git/pmaports/device/testing/linux-samsung-treltexx/kernel-use-the-gnu89-standard-explicitly.patch/download"

download "linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch" 	"https://gitlab.com/postmarketOS/pmaports/-/raw/aa289aa350071e6afc54f6b6704ba28971b50466/device/.shared-patches/linux/linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch"

# Dior-specific display fixes from the 2025 pmaports mirror.
download "0001-fix-refresh-rate.patch" 	"https://sourceforge.net/projects/cactusrom/files/SourceFS/mnt/pmbootstrap/git/pmaports/device/testing/linux-xiaomi-dior/0001-fix-refresh-rate.patch/download"

download "0001-framebuffer-fixes.patch" 	"https://sourceforge.net/projects/cactusrom/files/SourceFS/mnt/pmbootstrap/git/pmaports/device/testing/linux-xiaomi-dior/0001-framebuffer-fixes.patch/download"

echo
echo "下载完成，执行锁定 APKBUILD SHA-512 校验..."
sh "$SCRIPT_DIR/check-snapshot.sh"
