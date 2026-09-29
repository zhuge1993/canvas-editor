#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/frontend"
APORT_TEMPLATE="$SCRIPT_DIR/flowboard-apk"
SNAPSHOT_ROOT="$SCRIPT_DIR/pmaports-snapshot"
PMB_APORTS="${PMB_APORTS:-$HOME/.local/var/pmbootstrap/cache_git/pmaports}"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/out/dior}"
FLOWBOARD_RELEASE="${FLOWBOARD_RELEASE:-$FRONTEND_DIR/FlowBoard-linux.tar.gz}"

need() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "缺少命令: $1" >&2
		exit 1
	}
}

find_aport() {
	package="$1"
	first=""
	candidates="$(find "$PMB_APORTS/device" -mindepth 2 -maxdepth 2 -type d -name "$package" -print 2>/dev/null || true)"
	[ -n "$candidates" ] || return 0

	while IFS= read -r dir; do
		[ -n "$first" ] || first="$dir"
		if aport_complete "$package" "$dir"; then
			printf '%s\n' "$dir"
			return 0
		fi
	done <<EOF
$candidates
EOF

	# No complete candidate: return one partial path so diagnostics can identify it.
	printf '%s\n' "$first"
}

aport_complete() {
	package="$1"
	dir="$2"
	[ -n "$dir" ] && [ -d "$dir" ] && [ -f "$dir/APKBUILD" ] || return 1

	case "$package" in
		device-xiaomi-dior)
			[ -f "$dir/deviceinfo" ] || return 1
			if grep -q 'kernel-cmdline\.conf' "$dir/APKBUILD"; then
				[ -f "$dir/kernel-cmdline.conf" ] || return 1
			fi
			;;
		linux-xiaomi-dior)
			[ -f "$dir/config-xiaomi-dior.armv7" ] || return 1
			for patch in $(sed -n 's/^[[:space:]]*\([^[:space:]]*\.patch\)[[:space:]]*$/\1/p' "$dir/APKBUILD"); do
				[ -e "$dir/$patch" ] || return 1
			done
			;;
		firmware-xiaomi-dior)
			# Firmware payloads are remote commit-pinned sources with hashes in APKBUILD.
			;;
		*)
			return 1
			;;
	esac
	return 0
}

report_aport() {
	package="$1"
	dir="$2"
	if aport_complete "$package" "$dir"; then
		echo "完整: $package -> $dir"
	elif [ -n "$dir" ]; then
		echo "残缺: $package -> $dir" >&2
	else
		echo "缺失: $package" >&2
	fi
}

need pmbootstrap
need find
need cp
need mkdir
need grep
need sed

if [ ! -d "$PMB_APORTS" ]; then
	echo "找不到 pmbootstrap pmaports: $PMB_APORTS" >&2
	echo "先运行 pmbootstrap init；如果使用自定义 pmaports 路径，请设置 PMB_APORTS=/path/to/pmaports。" >&2
	exit 1
fi

# Require an initialized xiaomi-dior profile. This avoids accidentally building for another phone.
STATUS="$(pmbootstrap status 2>/dev/null || true)"
if ! printf '%s\n' "$STATUS" | grep -Eqi 'xiaomi[- ]dior|device[^[:alnum:]]+dior|dior'; then
	echo "当前 pmbootstrap 配置看起来不是 xiaomi-dior。" >&2
	echo "请先执行 pmbootstrap init，并选择 vendor=xiaomi、device=dior、轻量/console UI。" >&2
	exit 1
fi

DEVICE_APORT="$(find_aport device-xiaomi-dior)"
KERNEL_APORT="$(find_aport linux-xiaomi-dior)"
FIRMWARE_APORT="$(find_aport firmware-xiaomi-dior)"

if ! aport_complete device-xiaomi-dior "$DEVICE_APORT" \
	|| ! aport_complete linux-xiaomi-dior "$KERNEL_APORT" \
	|| ! aport_complete firmware-xiaomi-dior "$FIRMWARE_APORT"; then
	echo "当前 pmaports 的 xiaomi-dior aport 缺失或结构不完整，尝试仓库锁定快照..."
	report_aport device-xiaomi-dior "$DEVICE_APORT"
	report_aport linux-xiaomi-dior "$KERNEL_APORT"
	report_aport firmware-xiaomi-dior "$FIRMWARE_APORT"
	if ! sh "$SNAPSHOT_ROOT/check-snapshot.sh"; then
		if [ "${HYDRATE_SNAPSHOT:-1}" = "1" ]; then
			echo "快照缺文件，按固定历史来源下载并做 SHA-512 校验..."
			sh "$SNAPSHOT_ROOT/hydrate-snapshot.sh"
		fi
	fi
	if sh "$SNAPSHOT_ROOT/check-snapshot.sh"; then
		mkdir -p "$PMB_APORTS/device/testing"
		for package in device-xiaomi-dior linux-xiaomi-dior firmware-xiaomi-dior; do
			source_dir="$SNAPSHOT_ROOT/device/archived/$package"
			target_dir="$PMB_APORTS/device/testing/$package"
			if ! aport_complete "$package" "$source_dir"; then
				echo "仓库锁定快照中的 $package 结构不完整，停止构建。" >&2
				exit 1
			fi
			if [ -e "$target_dir" ]; then
				echo "保留当前 pmaports 已存在的 $target_dir（绝不覆盖用户 aport）"
			else
				cp -a "$source_dir" "$target_dir"
				echo "已注入锁定快照: $package"
			fi
		done
		DEVICE_APORT="$(find_aport device-xiaomi-dior)"
		KERNEL_APORT="$(find_aport linux-xiaomi-dior)"
		FIRMWARE_APORT="$(find_aport firmware-xiaomi-dior)"
	else
		echo "锁定快照尚未通过完整性校验，拒绝构建不完整内核。" >&2
		echo "缺失/哈希状态见上方输出和: linux/dior/pmaports-snapshot/README.md" >&2
		exit 1
	fi
fi

if ! aport_complete device-xiaomi-dior "$DEVICE_APORT" \
	|| ! aport_complete linux-xiaomi-dior "$KERNEL_APORT" \
	|| ! aport_complete firmware-xiaomi-dior "$FIRMWARE_APORT"; then
	echo "注入后 xiaomi-dior aport 仍缺失或结构不完整，停止构建。" >&2
	report_aport device-xiaomi-dior "$DEVICE_APORT"
	report_aport linux-xiaomi-dior "$KERNEL_APORT"
	report_aport firmware-xiaomi-dior "$FIRMWARE_APORT"
	echo "如果现有 pmaports 中已有同名残缺目录，请先自行修复或移走；脚本不会覆盖它。" >&2
	exit 1
fi

echo "dior device aport  : $DEVICE_APORT"
echo "dior kernel aport  : $KERNEL_APORT"
echo "dior firmware aport: $FIRMWARE_APORT"

if [ ! -f "$FLOWBOARD_RELEASE" ]; then
	need pnpm
	echo "未找到 $FLOWBOARD_RELEASE，先构建 FlowBoard Linux 发布包..."
	(
		cd "$FRONTEND_DIR"
		pnpm install --frozen-lockfile
		pnpm run build:linux
	)
fi

if [ ! -s "$FLOWBOARD_RELEASE" ]; then
	echo "FlowBoard Linux 发布包不存在或为空: $FLOWBOARD_RELEASE" >&2
	exit 1
fi

LOCAL_APORT="$PMB_APORTS/main/flowboard-server"
mkdir -p "$LOCAL_APORT"
cp "$APORT_TEMPLATE/APKBUILD" "$LOCAL_APORT/APKBUILD"
cp "$APORT_TEMPLATE/flowboard-server.pre-install" "$LOCAL_APORT/flowboard-server.pre-install"
cp "$APORT_TEMPLATE/flowboard-server.post-install" "$LOCAL_APORT/flowboard-server.post-install"
cp "$FLOWBOARD_RELEASE" "$LOCAL_APORT/flowboard-release.tar.gz"

echo "更新本地 flowboard-server 源文件校验..."
pmbootstrap checksum flowboard-server

echo "先单独构建 flowboard-server APK，尽早暴露打包错误..."
pmbootstrap build flowboard-server

echo "生成 xiaomi-dior 分离式 boot/rootfs 镜像，并把 FlowBoard 直接装进 rootfs..."
pmbootstrap install --split --add=flowboard-server

mkdir -p "$OUTPUT_DIR"
pmbootstrap export "$OUTPUT_DIR"

echo
echo "============================================================"
echo "DiorLinux / FlowBoard 镜像构建完成"
echo "输出目录: $OUTPUT_DIR"
echo "============================================================"
find "$OUTPUT_DIR" -maxdepth 1 -type f -printf '  %f\n' 2>/dev/null || ls -lh "$OUTPUT_DIR"
echo
echo "本脚本不会自动刷机。先核对手机确实是 Redmi Note 4G 单卡 dior。"
echo "postmarketOS 的 dior 流程通常是："
echo "  fastboot flash:raw boot <导出的 boot.img-xiaomi-dior>"
echo "  pmbootstrap flasher flash_rootfs"
echo
echo "首次启动后 FlowBoard 应由镜像内的服务自动启动。"
echo "默认监听: 127.0.0.1:3000"
echo "默认根管理员: 804559340@qq.com"
echo "SMTP: node /opt/flowboard/server-bundle.cjs set stp <QQ授权码>"
