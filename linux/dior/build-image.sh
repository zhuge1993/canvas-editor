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
REBUILD_FLOWBOARD_RELEASE="${REBUILD_FLOWBOARD_RELEASE:-0}"
DIOR_INSTALL_MODE="${DIOR_INSTALL_MODE:-split}"

case "$DIOR_INSTALL_MODE" in
	standard|split) ;;
	*)
		echo "DIOR_INSTALL_MODE 只能是 standard 或 split。" >&2
		exit 1
		;;
esac

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

find_support_aport() {
	package="$1"
	first=""
	for section in main community testing; do
		dir="$PMB_APORTS/$section/$package"
		[ -e "$dir" ] || continue
		[ -n "$first" ] || first="$dir"
		if aport_complete "$package" "$dir"; then
			printf '%s\n' "$dir"
			return 0
		fi
	done
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
		wcnss-wlan)
			# Accept newer pmaports layouts: validate only the local sources/features
			# that this APKBUILD actually references instead of forcing our historical layout.
			if grep -q 'wcnss-wlan\.initd' "$dir/APKBUILD"; then
				[ -f "$dir/wcnss-wlan.initd" ] || return 1
			fi
			if grep -q 'wcnss-wlan\.service' "$dir/APKBUILD"; then
				[ -f "$dir/wcnss-wlan.service" ] || return 1
			fi
			if grep -Eq 'subpackages=.*\$pkgname-openrc|default_openrc' "$dir/APKBUILD"; then
				[ -f "$dir/wcnss-wlan-openrc.post-install" ] || return 1
			fi
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
need sha256sum
need date
need sort

if [ ! -d "$PMB_APORTS" ]; then
	echo "找不到 pmbootstrap pmaports: $PMB_APORTS" >&2
	echo "先运行 pmbootstrap init；如果使用自定义 pmaports 路径，请设置 PMB_APORTS=/path/to/pmaports。" >&2
	exit 1
fi

# Require the exact xiaomi-dior profile. Do not infer the device from human-readable status output.
CONFIGURED_DEVICE="$(pmbootstrap config device 2>/dev/null || true)"
case "$CONFIGURED_DEVICE" in
	xiaomi-dior|dior)
		;;
	*)
		echo "当前 pmbootstrap 设备不是 xiaomi-dior: ${CONFIGURED_DEVICE:-<未配置>}" >&2
		echo "请先执行 pmbootstrap init，并选择 vendor=xiaomi、device=dior、轻量/console UI。" >&2
		exit 1
		;;
esac

DEVICE_APORT="$(find_aport device-xiaomi-dior)"
KERNEL_APORT="$(find_aport linux-xiaomi-dior)"
FIRMWARE_APORT="$(find_aport firmware-xiaomi-dior)"
WCNSS_APORT="$(find_support_aport wcnss-wlan)"

if ! aport_complete device-xiaomi-dior "$DEVICE_APORT" \
	|| ! aport_complete linux-xiaomi-dior "$KERNEL_APORT" \
	|| ! aport_complete firmware-xiaomi-dior "$FIRMWARE_APORT" \
	|| ! aport_complete wcnss-wlan "$WCNSS_APORT"; then
	echo "当前 pmaports 的 xiaomi-dior aport 或 WCNSS helper 缺失/不完整，尝试仓库锁定快照..."
	report_aport device-xiaomi-dior "$DEVICE_APORT"
	report_aport linux-xiaomi-dior "$KERNEL_APORT"
	report_aport firmware-xiaomi-dior "$FIRMWARE_APORT"
	report_aport wcnss-wlan "$WCNSS_APORT"
	if ! sh "$SNAPSHOT_ROOT/check-snapshot.sh"; then
		if [ "${HYDRATE_SNAPSHOT:-1}" = "1" ]; then
			echo "快照缺文件，按固定历史来源下载并做 SHA-512 校验..."
			sh "$SNAPSHOT_ROOT/hydrate-snapshot.sh"
		fi
	fi
	if sh "$SNAPSHOT_ROOT/check-snapshot.sh"; then
		mkdir -p "$PMB_APORTS/device/testing"
		for package in device-xiaomi-dior linux-xiaomi-dior firmware-xiaomi-dior; do
			case "$package" in
				device-xiaomi-dior) current_dir="$DEVICE_APORT" ;;
				linux-xiaomi-dior) current_dir="$KERNEL_APORT" ;;
				firmware-xiaomi-dior) current_dir="$FIRMWARE_APORT" ;;
			esac

			# 当前 pmaports 中已经完整的包永远优先，不额外注入历史副本。
			if aport_complete "$package" "$current_dir"; then
				echo "继续使用当前完整 aport: $package -> $current_dir"
				continue
			fi

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

		# firmware-xiaomi-dior depends on the downstream WCNSS init helper.
		# Prefer any complete current pmaports copy; only inject our immutable snapshot when missing.
		WCNSS_APORT="$(find_support_aport wcnss-wlan)"
		if ! aport_complete wcnss-wlan "$WCNSS_APORT"; then
			source_dir="$SNAPSHOT_ROOT/main/wcnss-wlan"
			target_dir="$PMB_APORTS/main/wcnss-wlan"
			if ! aport_complete wcnss-wlan "$source_dir"; then
				echo "仓库锁定快照中的 wcnss-wlan 结构不完整，停止构建。" >&2
				exit 1
			fi
			if [ -e "$target_dir" ]; then
				echo "当前 pmaports 已有残缺 $target_dir；脚本不会覆盖，请先修复或移走。" >&2
				exit 1
			fi
			mkdir -p "$PMB_APORTS/main"
			cp -a "$source_dir" "$target_dir"
			echo "已注入锁定 WCNSS helper: wcnss-wlan"
			WCNSS_APORT="$(find_support_aport wcnss-wlan)"
		fi
	else
		echo "锁定快照尚未通过完整性校验，拒绝构建不完整内核。" >&2
		echo "缺失/哈希状态见上方输出和: linux/dior/pmaports-snapshot/README.md" >&2
		exit 1
	fi
fi

if ! aport_complete device-xiaomi-dior "$DEVICE_APORT" \
	|| ! aport_complete linux-xiaomi-dior "$KERNEL_APORT" \
	|| ! aport_complete firmware-xiaomi-dior "$FIRMWARE_APORT" \
	|| ! aport_complete wcnss-wlan "$WCNSS_APORT"; then
	echo "注入后 xiaomi-dior aport / WCNSS helper 仍缺失或结构不完整，停止构建。" >&2
	report_aport device-xiaomi-dior "$DEVICE_APORT"
	report_aport linux-xiaomi-dior "$KERNEL_APORT"
	report_aport firmware-xiaomi-dior "$FIRMWARE_APORT"
	report_aport wcnss-wlan "$WCNSS_APORT"
	echo "如果现有 pmaports 中已有同名残缺目录，请先自行修复或移走；脚本不会覆盖它。" >&2
	exit 1
fi

echo "dior device aport  : $DEVICE_APORT"
echo "dior kernel aport  : $KERNEL_APORT"
echo "dior firmware aport: $FIRMWARE_APORT"
echo "WCNSS helper aport : $WCNSS_APORT"

if [ "$REBUILD_FLOWBOARD_RELEASE" = "1" ] || [ ! -f "$FLOWBOARD_RELEASE" ]; then
	need pnpm
	if [ "$REBUILD_FLOWBOARD_RELEASE" = "1" ]; then
		echo "强制重建 FlowBoard Linux 发布包，避免把旧 tar 混入当前镜像..."
	else
		echo "未找到 $FLOWBOARD_RELEASE，先构建 FlowBoard Linux 发布包..."
	fi
	(
		cd "$FRONTEND_DIR"
		pnpm install --frozen-lockfile
		pnpm run build:linux
	)
	if [ "$FLOWBOARD_RELEASE" != "$FRONTEND_DIR/FlowBoard-linux.tar.gz" ]; then
		cp "$FRONTEND_DIR/FlowBoard-linux.tar.gz" "$FLOWBOARD_RELEASE"
	fi
fi

if [ ! -s "$FLOWBOARD_RELEASE" ]; then
	echo "FlowBoard Linux 发布包不存在或为空: $FLOWBOARD_RELEASE" >&2
	exit 1
fi

if [ -d "$OUTPUT_DIR" ] && [ -n "$(find "$OUTPUT_DIR" -mindepth 1 -print -quit 2>/dev/null || true)" ]; then
	echo "输出目录不是空目录，拒绝把新镜像与旧产物混在一起: $OUTPUT_DIR" >&2
	echo "请先把旧产物移走，或设置 OUTPUT_DIR=/新的/空目录。" >&2
	exit 1
fi

LOCAL_APORT="$PMB_APORTS/main/flowboard-server"
mkdir -p "$LOCAL_APORT"
cp "$APORT_TEMPLATE/APKBUILD" "$LOCAL_APORT/APKBUILD"
cp "$APORT_TEMPLATE/flowboard-server.pre-install" "$LOCAL_APORT/flowboard-server.pre-install"
cp "$APORT_TEMPLATE/flowboard-server.post-install" "$LOCAL_APORT/flowboard-server.post-install"
cp "$APORT_TEMPLATE/dior-dropbear.initd" "$LOCAL_APORT/dior-dropbear.initd"
cp "$APORT_TEMPLATE/dior-firmware.initd" "$LOCAL_APORT/dior-firmware.initd"
cp "$APORT_TEMPLATE/dior-adsp.initd" "$LOCAL_APORT/dior-adsp.initd"
cp "$APORT_TEMPLATE/dior-bluetooth.initd" "$LOCAL_APORT/dior-bluetooth.initd"
cp "$APORT_TEMPLATE/dior-gps.initd" "$LOCAL_APORT/dior-gps.initd"
cp "$REPO_ROOT/tools/dior-hw/dior-hw-probe" "$LOCAL_APORT/dior-hw-probe"
cp "$REPO_ROOT/tools/dior-hw/dior-touch-test" "$LOCAL_APORT/dior-touch-test"
cp "$REPO_ROOT/tools/dior-hw/dior-hw-verify" "$LOCAL_APORT/dior-hw-verify"
cp "$REPO_ROOT/tools/dior-hw/dior-hw-smoke" "$LOCAL_APORT/dior-hw-smoke"
cp "$FLOWBOARD_RELEASE" "$LOCAL_APORT/flowboard-release.tar.gz"

echo "更新本地 flowboard-server 源文件校验..."
pmbootstrap checksum flowboard-server

echo "先单独构建 flowboard-server APK，尽早暴露打包错误..."
pmbootstrap build flowboard-server

echo "预构建 dior kernel，提前验证 GCC4/dtbtool 与 downstream 3.4 内核..."
pmbootstrap build linux-xiaomi-dior

echo "预构建 WCNSS helper，提前验证 downstream Wi-Fi 依赖..."
pmbootstrap build wcnss-wlan

echo "预构建 dior firmware，提前验证固定固件源与校验..."
pmbootstrap build firmware-xiaomi-dior

echo "预构建 dior device package，提前验证设备包依赖闭包..."
pmbootstrap build device-xiaomi-dior

if [ "$DIOR_INSTALL_MODE" = "standard" ]; then
	echo "生成 xiaomi-dior V1 标准 rootfs，并把 FlowBoard 直接装进系统分区镜像..."
	pmbootstrap install --add=flowboard-server
else
	echo "生成 xiaomi-dior 分离式 boot/rootfs 镜像，并把 FlowBoard 直接装进 rootfs..."
	pmbootstrap install --split --add=flowboard-server
fi

echo "验收最终 rootfs：FlowBoard / Node / Wi-Fi 固件 / 开机服务..."
pmbootstrap chroot -r -- sh -ec '
	apk info -e flowboard-server >/dev/null
	apk info -e nodejs >/dev/null
	apk info -e firmware-xiaomi-dior >/dev/null
	apk info -e wcnss-wlan >/dev/null
	apk info -e bluez >/dev/null
	apk info -e gpsd >/dev/null
	apk info -e gpsd >/dev/null

	test -s /opt/flowboard/server-bundle.cjs
	test -s /opt/flowboard/dist/index.html
	test -x /opt/flowboard/start-server.sh
	test -f /opt/flowboard/flowboard.env
	id flowboard >/dev/null 2>&1

	# Hardware contract established from the physical dior probe.
	# The downstream 3.4 kernel needs WCNSS firmware in the legacy root path.
	test -s /lib/firmware/wcnss.mdt
	test -s /lib/firmware/wlan/prima/WCNSS_qcom_wlan_nv.bin
	test -s /lib/firmware/wlan/prima/WCNSS_qcom_cfg.ini
	# Physical dior probe showed VIDC firmware download failures and no ALSA card.
	# Require the device own Qualcomm multimedia firmware/calibration payloads.
	test -s /lib/firmware/venus.mdt
	test -s /lib/firmware/venus.mbn
	test -s /etc/firmware/cpp_firmware_v1_2_0.fw
	test -s /lib/firmware/a300_pfp.fw
	test -s /lib/firmware/a330_pm4.fw
	test -s /etc/acdbdata/MTP/MTP_Handset_cal.acdb
	test -s /etc/acdbdata/MTP/MTP_Speaker_cal.acdb

	node -e '\''const [a,b]=process.versions.node.split(".").map(Number); if (!(a>20 || (a===20 && b>=19))) process.exit(1)'\''

	if command -v rc-update >/dev/null 2>&1; then
		test -x /etc/init.d/flowboard
		test -x /etc/init.d/wcnss-wlan
		test -x /etc/init.d/dior-dropbear
		test -x /etc/init.d/dior-firmware
		test -x /etc/init.d/dior-adsp
		test -x /etc/init.d/dior-bluetooth
		test -x /etc/init.d/dior-gps
		test -x /usr/local/sbin/dior-hw-verify
		test -x /usr/local/sbin/dior-hw-smoke
		rc-update show default | grep -Eq "(^|[[:space:]])flowboard([[:space:]]|$)"
		rc-update show default | grep -Eq "(^|[[:space:]])wcnss-wlan([[:space:]]|$)"
		rc-update show default | grep -Eq "(^|[[:space:]])dior-dropbear([[:space:]]|$)"
		rc-update show default | grep -Eq "(^|[[:space:]])dior-firmware([[:space:]]|$)"
		rc-update show default | grep -Eq "(^|[[:space:]])dior-adsp([[:space:]]|$)"
		rc-update show default | grep -Eq "(^|[[:space:]])dior-bluetooth([[:space:]]|$)"
		rc-update show default | grep -Eq "(^|[[:space:]])dior-gps([[:space:]]|$)"
		test -x /etc/init.d/bluetooth
		rc-update show default | grep -Eq "(^|[[:space:]])bluetooth([[:space:]]|$)"
		test -x /etc/init.d/gpsd
		grep -q '^DEVICES="/dev/smd27"
	elif command -v systemctl >/dev/null 2>&1; then
		test -f /usr/lib/systemd/system/flowboard.service
		test -f /usr/lib/systemd/system/wcnss-wlan.service
		test -L /etc/systemd/system/multi-user.target.wants/flowboard.service
		test -L /etc/systemd/system/multi-user.target.wants/wcnss-wlan.service
	else
		echo "rootfs 内没有可识别的 OpenRC/systemd，拒绝导出。" >&2
		exit 1
	fi
'

mkdir -p "$OUTPUT_DIR"
pmbootstrap export "$OUTPUT_DIR"

# pmbootstrap export intentionally emits symlinks for several artifacts.
# Materialize file symlinks so out/dior can be copied/archive independently of the pmbootstrap workdir.
while IFS= read -r exported_link; do
	[ -n "$exported_link" ] || continue
	if [ ! -f "$exported_link" ]; then
		echo "导出目录包含非文件符号链接，拒绝生成不完整可移植产物: $exported_link" >&2
		exit 1
	fi
	materialized="$exported_link.materialized.$"
	cp -L "$exported_link" "$materialized"
	rm "$exported_link"
	mv "$materialized" "$exported_link"
done <<EOF
$(find "$OUTPUT_DIR" -type l -print)
EOF

BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
REPO_REVISION="unknown"
PMAPORTS_REVISION="unknown"
if command -v git >/dev/null 2>&1; then
	REPO_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
	PMAPORTS_REVISION="$(git -C "$PMB_APORTS" rev-parse HEAD 2>/dev/null || printf 'unknown')"
fi
PMBOOTSTRAP_VERSION="$(pmbootstrap --version 2>/dev/null | sed -n '1p')"
FLOWBOARD_RELEASE_SHA256="$(sha256sum "$FLOWBOARD_RELEASE" | sed 's/[[:space:]].*$//')"
DEVICE_APKBUILD_SHA256="$(sha256sum "$DEVICE_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"
KERNEL_APKBUILD_SHA256="$(sha256sum "$KERNEL_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"
FIRMWARE_APKBUILD_SHA256="$(sha256sum "$FIRMWARE_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"
WCNSS_APKBUILD_SHA256="$(sha256sum "$WCNSS_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"

cat > "$OUTPUT_DIR/BUILD-MANIFEST.txt" <<EOF
DiorLinux / FlowBoard build manifest
built_utc=$BUILD_TIME
target_vendor=xiaomi
target_device=dior
target_name=Redmi Note 4G single-SIM
target_arch=armv7
install_mode=$DIOR_INSTALL_MODE
repository_revision=$REPO_REVISION
pmaports_revision=$PMAPORTS_REVISION
pmbootstrap_version=$PMBOOTSTRAP_VERSION
flowboard_release_sha256=$FLOWBOARD_RELEASE_SHA256
device_aport=$DEVICE_APORT
device_apkbuild_sha256=$DEVICE_APKBUILD_SHA256
kernel_aport=$KERNEL_APORT
kernel_apkbuild_sha256=$KERNEL_APKBUILD_SHA256
firmware_aport=$FIRMWARE_APORT
firmware_apkbuild_sha256=$FIRMWARE_APKBUILD_SHA256
wcnss_aport=$WCNSS_APORT
wcnss_apkbuild_sha256=$WCNSS_APKBUILD_SHA256
flowboard_listen=127.0.0.1:3000
flowboard_root_admin=804559340@qq.com
auto_flash=false
EOF

cat > "$OUTPUT_DIR/FLASHING-NOTES.txt" <<'EOF'
DiorLinux / FlowBoard 刷机前检查

1. 这些产物只允许用于 Xiaomi Redmi Note 4G 单卡版，codename: dior。
2. 不要把这些 boot/rootfs 产物刷到其他 Redmi Note、双卡版或其他 MSM8226 设备。
3. build-image.sh 从不自动执行 fastboot flash。
4. 刷机前先在本目录执行: sha256sum -c SHA256SUMS
5. 先备份手机现有重要数据，并确认 bootloader/fastboot 状态。
6. 具体刷写步骤以当前 pmbootstrap/postmarketOS 对 xiaomi-dior 的导出结果为准。
7. FlowBoard 首次启动后应监听 127.0.0.1:3000，由同机反代/内网穿透对外提供 HTTPS。
8. QQ SMTP 授权码不要写入镜像或 Git；系统启动后单独执行 set stp 配置。
9. install_mode=standard 是第一版首刷路线：boot 用 fastboot flash:raw boot，rootfs 用 pmbootstrap flasher flash_rootfs。
10. install_mode=split 只留给以后 system 分区装不下时继续研究，不作为 V1 首刷默认路线。
EOF

(
	cd "$OUTPUT_DIR"
	find . -type f ! -name SHA256SUMS -print \
		| LC_ALL=C sort \
		| while IFS= read -r file; do sha256sum "$file"; done \
		> SHA256SUMS
)

echo
echo "============================================================"
echo "DiorLinux / FlowBoard 镜像构建完成"
echo "输出目录: $OUTPUT_DIR"
echo "============================================================"
find "$OUTPUT_DIR" -maxdepth 1 -type f -printf '  %f\n' 2>/dev/null || ls -lh "$OUTPUT_DIR"
echo
echo "已生成:"
echo "  BUILD-MANIFEST.txt"
echo "  FLASHING-NOTES.txt"
echo "  SHA256SUMS"
echo
echo "本脚本不会自动刷机。先核对手机确实是 Redmi Note 4G 单卡 dior。"
echo "刷机前先执行: (cd \"$OUTPUT_DIR\" && sha256sum -c SHA256SUMS)"
echo
echo "首次启动后 FlowBoard 应由镜像内的服务自动启动。"
echo "默认监听: 127.0.0.1:3000"
echo "默认根管理员: 804559340@qq.com"
echo "SMTP: node /opt/flowboard/server-bundle.cjs set stp <QQ授权码>"
 /etc/conf.d/gpsd
		rc-update show default | grep -Eq "(^|[[:space:]])gpsd([[:space:]]|$)"
	elif command -v systemctl >/dev/null 2>&1; then
		test -f /usr/lib/systemd/system/flowboard.service
		test -f /usr/lib/systemd/system/wcnss-wlan.service
		test -L /etc/systemd/system/multi-user.target.wants/flowboard.service
		test -L /etc/systemd/system/multi-user.target.wants/wcnss-wlan.service
	else
		echo "rootfs 内没有可识别的 OpenRC/systemd，拒绝导出。" >&2
		exit 1
	fi
'

mkdir -p "$OUTPUT_DIR"
pmbootstrap export "$OUTPUT_DIR"

# pmbootstrap export intentionally emits symlinks for several artifacts.
# Materialize file symlinks so out/dior can be copied/archive independently of the pmbootstrap workdir.
while IFS= read -r exported_link; do
	[ -n "$exported_link" ] || continue
	if [ ! -f "$exported_link" ]; then
		echo "导出目录包含非文件符号链接，拒绝生成不完整可移植产物: $exported_link" >&2
		exit 1
	fi
	materialized="$exported_link.materialized.$"
	cp -L "$exported_link" "$materialized"
	rm "$exported_link"
	mv "$materialized" "$exported_link"
done <<EOF
$(find "$OUTPUT_DIR" -type l -print)
EOF

BUILD_TIME="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
REPO_REVISION="unknown"
PMAPORTS_REVISION="unknown"
if command -v git >/dev/null 2>&1; then
	REPO_REVISION="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || printf 'unknown')"
	PMAPORTS_REVISION="$(git -C "$PMB_APORTS" rev-parse HEAD 2>/dev/null || printf 'unknown')"
fi
PMBOOTSTRAP_VERSION="$(pmbootstrap --version 2>/dev/null | sed -n '1p')"
FLOWBOARD_RELEASE_SHA256="$(sha256sum "$FLOWBOARD_RELEASE" | sed 's/[[:space:]].*$//')"
DEVICE_APKBUILD_SHA256="$(sha256sum "$DEVICE_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"
KERNEL_APKBUILD_SHA256="$(sha256sum "$KERNEL_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"
FIRMWARE_APKBUILD_SHA256="$(sha256sum "$FIRMWARE_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"
WCNSS_APKBUILD_SHA256="$(sha256sum "$WCNSS_APORT/APKBUILD" | sed 's/[[:space:]].*$//')"

cat > "$OUTPUT_DIR/BUILD-MANIFEST.txt" <<EOF
DiorLinux / FlowBoard build manifest
built_utc=$BUILD_TIME
target_vendor=xiaomi
target_device=dior
target_name=Redmi Note 4G single-SIM
target_arch=armv7
install_mode=$DIOR_INSTALL_MODE
repository_revision=$REPO_REVISION
pmaports_revision=$PMAPORTS_REVISION
pmbootstrap_version=$PMBOOTSTRAP_VERSION
flowboard_release_sha256=$FLOWBOARD_RELEASE_SHA256
device_aport=$DEVICE_APORT
device_apkbuild_sha256=$DEVICE_APKBUILD_SHA256
kernel_aport=$KERNEL_APORT
kernel_apkbuild_sha256=$KERNEL_APKBUILD_SHA256
firmware_aport=$FIRMWARE_APORT
firmware_apkbuild_sha256=$FIRMWARE_APKBUILD_SHA256
wcnss_aport=$WCNSS_APORT
wcnss_apkbuild_sha256=$WCNSS_APKBUILD_SHA256
flowboard_listen=127.0.0.1:3000
flowboard_root_admin=804559340@qq.com
auto_flash=false
EOF

cat > "$OUTPUT_DIR/FLASHING-NOTES.txt" <<'EOF'
DiorLinux / FlowBoard 刷机前检查

1. 这些产物只允许用于 Xiaomi Redmi Note 4G 单卡版，codename: dior。
2. 不要把这些 boot/rootfs 产物刷到其他 Redmi Note、双卡版或其他 MSM8226 设备。
3. build-image.sh 从不自动执行 fastboot flash。
4. 刷机前先在本目录执行: sha256sum -c SHA256SUMS
5. 先备份手机现有重要数据，并确认 bootloader/fastboot 状态。
6. 具体刷写步骤以当前 pmbootstrap/postmarketOS 对 xiaomi-dior 的导出结果为准。
7. FlowBoard 首次启动后应监听 127.0.0.1:3000，由同机反代/内网穿透对外提供 HTTPS。
8. QQ SMTP 授权码不要写入镜像或 Git；系统启动后单独执行 set stp 配置。
9. install_mode=standard 是第一版首刷路线：boot 用 fastboot flash:raw boot，rootfs 用 pmbootstrap flasher flash_rootfs。
10. install_mode=split 只留给以后 system 分区装不下时继续研究，不作为 V1 首刷默认路线。
EOF

(
	cd "$OUTPUT_DIR"
	find . -type f ! -name SHA256SUMS -print \
		| LC_ALL=C sort \
		| while IFS= read -r file; do sha256sum "$file"; done \
		> SHA256SUMS
)

echo
echo "============================================================"
echo "DiorLinux / FlowBoard 镜像构建完成"
echo "输出目录: $OUTPUT_DIR"
echo "============================================================"
find "$OUTPUT_DIR" -maxdepth 1 -type f -printf '  %f\n' 2>/dev/null || ls -lh "$OUTPUT_DIR"
echo
echo "已生成:"
echo "  BUILD-MANIFEST.txt"
echo "  FLASHING-NOTES.txt"
echo "  SHA256SUMS"
echo
echo "本脚本不会自动刷机。先核对手机确实是 Redmi Note 4G 单卡 dior。"
echo "刷机前先执行: (cd \"$OUTPUT_DIR\" && sha256sum -c SHA256SUMS)"
echo
echo "首次启动后 FlowBoard 应由镜像内的服务自动启动。"
echo "默认监听: 127.0.0.1:3000"
echo "默认根管理员: 804559340@qq.com"
echo "SMTP: node /opt/flowboard/server-bundle.cjs set stp <QQ授权码>"
