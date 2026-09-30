#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-$REPO_ROOT/out/dior-v1-first}"

if ! command -v pmbootstrap >/dev/null 2>&1; then
	echo "缺少 pmbootstrap。请先在 Linux 构建机安装并运行 pmbootstrap init。" >&2
	exit 1
fi
if ! command -v git >/dev/null 2>&1; then
	echo "缺少 git，无法锁定 V1 构建源码版本。" >&2
	exit 1
fi

DIRTY="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)"
if [ -n "$DIRTY" ]; then
	echo "V1 首刷要求仓库工作区干净，避免 manifest 的 Git HEAD 与实际构建源码不一致。" >&2
	echo "$DIRTY" >&2
	echo "请先提交/暂存到别处或清理这些改动，再重新构建。" >&2
	exit 1
fi

DEVICE="$(pmbootstrap config device 2>/dev/null || true)"
case "$DEVICE" in
	xiaomi-dior|dior) ;;
	*)
		echo "当前 pmbootstrap 设备不是 dior: ${DEVICE:-<未配置>}" >&2
		echo "请先运行 pmbootstrap init，选择 vendor=xiaomi、device=dior、UI=console。" >&2
		exit 1
		;;
esac

UI="$(pmbootstrap config ui 2>/dev/null || true)"
case "$UI" in
	console|"")
		;;
	*)
		echo "V1 首刷建议使用 console UI，当前 UI: $UI" >&2
		echo "桌面环境可能超过 dior 约 800 MiB 的 system 分区，不作为第一版首刷目标。" >&2
		exit 1
		;;
esac

if [ -d "$OUTPUT_DIR" ] && [ -n "$(find "$OUTPUT_DIR" -mindepth 1 -print -quit 2>/dev/null || true)" ]; then
	echo "V1 输出目录已有文件: $OUTPUT_DIR" >&2
	echo "请先移动旧产物，或设置 OUTPUT_DIR=/新的/空目录。" >&2
	exit 1
fi

echo "============================================================"
echo "DiorLinux / FlowBoard V1 首刷构建"
echo "device : $DEVICE"
echo "ui     : ${UI:-console}"
echo "output : $OUTPUT_DIR"
echo "mode   : standard（不使用 split）"
echo "============================================================"

REBUILD_FLOWBOARD_RELEASE=1 DIOR_INSTALL_MODE=standard OUTPUT_DIR="$OUTPUT_DIR" sh "$SCRIPT_DIR/build-image.sh"

if ! grep -q '^target_device=dior$' "$OUTPUT_DIR/BUILD-MANIFEST.txt"; then
	echo "V1 manifest 的 target_device 不是 dior，拒绝继续。" >&2
	exit 1
fi
if ! grep -q '^install_mode=standard$' "$OUTPUT_DIR/BUILD-MANIFEST.txt"; then
	echo "V1 manifest 不是 standard install，拒绝继续。" >&2
	exit 1
fi

echo
echo "V1 构建已完成。下一步："
echo "1. 关闭 Redmi Note 4G 单卡 dior。"
echo "2. 按住 音量减 + 电源 进入 Fastboot。"
echo "3. USB 连接当前这台 Linux 构建机。"
echo "4. 执行: OUTPUT_DIR='$OUTPUT_DIR' sh '$SCRIPT_DIR/flash-v1-first.sh'"
echo
echo "不要把这些产物刷到双卡版/gucci 或其他 Redmi Note。"
