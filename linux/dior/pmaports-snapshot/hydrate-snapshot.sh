#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
KERNEL_DIR="$SCRIPT_DIR/device/archived/linux-xiaomi-dior"
APKBUILD="$KERNEL_DIR/APKBUILD"

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
		curl -fL --retry 3 --connect-timeout 20 --max-time 180 -o "$target" "$url"
	}
elif command -v wget >/dev/null 2>&1; then
	fetch() {
		url="$1"
		target="$2"
		wget -O "$target" "$url"
	}
else
	echo "需要 curl 或 wget 下载历史补丁。" >&2
	exit 1
fi

expected_hash() {
	name="$1"
	awk -v target="$name" '$2 == target { print $1; exit }' "$APKBUILD"
}

verify_file() {
	name="$1"
	file="$2"
	expected="$(expected_hash "$name")"
	if [ -z "$expected" ]; then
		echo "APKBUILD 没有 $name 的 SHA-512，拒绝继续。" >&2
		return 1
	fi
	actual="$(sha512sum "$file" | awk '{print $1}')"
	if [ "$actual" != "$expected" ]; then
		echo "SHA-512 不匹配: $name" >&2
		echo "  expected: $expected" >&2
		echo "  actual  : $actual" >&2
		return 1
	fi
	return 0
}

download() {
	name="$1"
	url="$2"
	target="$KERNEL_DIR/$name"
	tmp="$target.tmp"

	if [ -f "$target" ]; then
		echo "已存在，验证 SHA-512: $name"
		verify_file "$name" "$target" || exit 1
		return
	fi

	echo "下载 $name"
	rm -f "$tmp"
	if ! fetch "$url" "$tmp"; then
		rm -f "$tmp"
		echo "下载失败: $name" >&2
		exit 1
	fi
	if ! verify_file "$name" "$tmp"; then
		rm -f "$tmp"
		echo "下载内容未通过锁定 SHA-512，拒绝落盘。" >&2
		exit 1
	fi
	mv "$tmp" "$target"
	echo "✓ $name"
}

# All six patches come from one immutable historical pmaports Git commit.
# The APKBUILD in that exact commit contains the same six SHA-512 values locked
# by this repository's archived linux-xiaomi-dior/APKBUILD.  We still verify
# every downloaded file locally before moving it into the snapshot directory.
MIRROR_COMMIT="5f47afd56cf72059b913fd1df94d469940e14f1f"
MIRROR_BASE="https://raw.githubusercontent.com/pipa-project/pmaports-pipa/$MIRROR_COMMIT/device/downstream/linux-xiaomi-dior"

download "gcc10-extern_YYLOC_global_declaration.patch" \
	"$MIRROR_BASE/gcc10-extern_YYLOC_global_declaration.patch"

download "linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch" \
	"$MIRROR_BASE/linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch"

download "kernel-use-the-gnu89-standard-explicitly.patch" \
	"$MIRROR_BASE/kernel-use-the-gnu89-standard-explicitly.patch"

download "linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch" \
	"$MIRROR_BASE/linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch"

download "0001-fix-refresh-rate.patch" \
	"$MIRROR_BASE/0001-fix-refresh-rate.patch"

download "0001-framebuffer-fixes.patch" \
	"$MIRROR_BASE/0001-framebuffer-fixes.patch"

echo
echo "6 个补丁均已通过单文件 SHA-512 校验；执行完整 snapshot 校验..."
sh "$SCRIPT_DIR/check-snapshot.sh"
