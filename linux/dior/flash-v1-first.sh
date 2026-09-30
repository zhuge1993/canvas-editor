#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/out/dior-v1-first}"

need() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "缺少命令: $1" >&2
		exit 1
	}
}

need pmbootstrap
need fastboot
need sha256sum
need grep
need awk
need mktemp
need find

DEVICE="$(pmbootstrap config device 2>/dev/null || true)"
case "$DEVICE" in
	xiaomi-dior|dior) ;;
	*)
		echo "当前 pmbootstrap 设备不是 dior: ${DEVICE:-<未配置>}，拒绝刷机。" >&2
		exit 1
		;;
esac

if [ ! -f "$OUTPUT_DIR/BUILD-MANIFEST.txt" ] || [ ! -f "$OUTPUT_DIR/SHA256SUMS" ]; then
	echo "找不到 V1 构建清单/校验文件: $OUTPUT_DIR" >&2
	exit 1
fi

grep -q '^target_device=dior$' "$OUTPUT_DIR/BUILD-MANIFEST.txt" || {
	echo "BUILD-MANIFEST 目标不是 dior，拒绝刷机。" >&2
	exit 1
}
grep -q '^install_mode=standard$' "$OUTPUT_DIR/BUILD-MANIFEST.txt" || {
	echo "这不是 V1 standard 首刷产物，拒绝使用本脚本。" >&2
	exit 1
}

(
	cd "$OUTPUT_DIR"
	sha256sum -c SHA256SUMS
)

BOOT_IMAGE="$OUTPUT_DIR/boot.img-xiaomi-dior"
if [ ! -f "$BOOT_IMAGE" ]; then
	echo "没有找到标准 dior Android boot 镜像: $BOOT_IMAGE" >&2
	echo "请检查 pmbootstrap export 输出；V1 不会猜测其他 boot 文件名。" >&2
	exit 1
fi

# pmbootstrap flasher flash_rootfs 使用当前工作区，而不是 OUTPUT_DIR 里的副本。
# 重新导出当前工作区并与已校验的 V1 导出文件逐一比对，避免“校验 A、实际刷 B”。
VERIFY_EXPORT_DIR="$(mktemp -d)"
cleanup_verify_export() {
	rm -rf "$VERIFY_EXPORT_DIR"
}
trap cleanup_verify_export EXIT INT TERM

pmbootstrap export "$VERIFY_EXPORT_DIR" >/dev/null

verified_export_count=0
while IFS= read -r current_file; do
	[ -n "$current_file" ] || continue
	name="${current_file##*/}"
	expected_file="$OUTPUT_DIR/$name"
	if [ ! -f "$expected_file" ]; then
		echo "当前 pmbootstrap 工作区导出了未在 V1 校验目录出现的文件: $name" >&2
		exit 1
	fi
	current_hash="$(sha256sum "$current_file" | awk '{print $1}')"
	expected_hash="$(sha256sum "$expected_file" | awk '{print $1}')"
	if [ "$current_hash" != "$expected_hash" ]; then
		echo "当前 pmbootstrap 工作区与 V1 校验产物不一致: $name" >&2
		echo "请重新执行 build-v1-first-flash.sh，再进行刷机。" >&2
		exit 1
	fi
	verified_export_count=$((verified_export_count + 1))
done <<EOF
$(find "$VERIFY_EXPORT_DIR" -mindepth 1 -maxdepth 1 \( -type f -o -type l \) -print)
EOF

if [ "$verified_export_count" -eq 0 ]; then
	echo "当前 pmbootstrap 工作区没有可验证的导出文件，拒绝刷机。" >&2
	exit 1
fi

echo "当前 pmbootstrap 工作区与 V1 导出产物一致（$verified_export_count 个文件）。"

DEVICES="$(fastboot devices 2>/dev/null | awk 'NF {print $1}')"
DEVICE_COUNT="$(printf '%s\n' "$DEVICES" | awk 'NF {count++} END {print count+0}')"
if [ "$DEVICE_COUNT" -ne 1 ]; then
	echo "需要且只能连接 1 台 Fastboot 设备；当前检测到 $DEVICE_COUNT 台。" >&2
	fastboot devices || true
	exit 1
fi
FASTBOOT_SERIAL="$(printf '%s\n' "$DEVICES" | awk 'NF {print $1; exit}')"

check_same_fastboot_device() {
	current="$(fastboot devices 2>/dev/null | awk 'NF {print $1}')"
	count="$(printf '%s\n' "$current" | awk 'NF {count++} END {print count+0}')"
	[ "$count" -eq 1 ] && [ "$current" = "$FASTBOOT_SERIAL" ] || {
		echo "Fastboot 设备在刷写过程中发生变化，拒绝继续。" >&2
		echo "期望序列号: $FASTBOOT_SERIAL" >&2
		fastboot devices || true
		exit 1
	}
}

PRODUCT_OUTPUT="$(fastboot -s "$FASTBOOT_SERIAL" getvar product 2>&1 || true)"
PRODUCT="$(printf '%s\n' "$PRODUCT_OUTPUT" | awk -F: '
	tolower($1) ~ /^[[:space:]]*product[[:space:]]*$/ {
		value=$2
		gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
		print tolower(value)
		exit
	}
')"
if [ "$PRODUCT" != "dior" ]; then
	echo "Fastboot product 不是精确的 dior，拒绝刷机。" >&2
	echo "$PRODUCT_OUTPUT" >&2
	exit 1
fi

echo
echo "即将刷写：Xiaomi Redmi Note 4G 单卡版 / dior"
echo "boot  : $BOOT_IMAGE"
echo "rootfs: 当前 pmbootstrap V1 standard 安装产物"
echo
echo "这会覆盖手机现有 Linux/Android 相关系统内容。重要数据必须已经备份。"

printf "确认手机确实是单卡 dior，并继续刷写请输入 DIOR: "
IFS= read -r answer
[ "$answer" = "DIOR" ] || {
	echo "已取消。"
	exit 1
}

echo
echo "[1/2] 刷写 Android boot image..."
check_same_fastboot_device
fastboot -s "$FASTBOOT_SERIAL" flash:raw boot "$BOOT_IMAGE"

echo
echo "[2/2] 刷写 postmarketOS rootfs..."
check_same_fastboot_device
pmbootstrap flasher flash_rootfs

echo
echo "刷写命令均已成功完成。"
if [ "${REBOOT_AFTER_FLASH:-1}" = "1" ]; then
	echo "正在重启手机..."
	check_same_fastboot_device
	fastboot -s "$FASTBOOT_SERIAL" reboot
else
	echo "未自动重启。需要时执行: fastboot reboot"
fi

echo
echo "首次启动后按 FIRST-FLASH-V1.md 做 Wi-Fi 和 FlowBoard 检查。"
