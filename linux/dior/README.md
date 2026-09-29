# DiorLinux / FlowBoard image builder

这个目录负责把 **Redmi Note 4G 单卡版（xiaomi-dior）** 的 postmarketOS rootfs 和 FlowBoard 合成一套专用服务器镜像。

## 构建策略

这里不把 Android/Linux 3.4 旧内核强行升级到普通 PC/服务器的最新内核。dior 是 downstream 设备，镜像使用设备专用 boot/kernel；应用用户空间则尽量使用当前 postmarketOS/Alpine 软件栈。

FlowBoard 不在刷机后手工安装，而是通过本仓库的 `flowboard-server` 本地 APK，在 `pmbootstrap install` 创建 rootfs 时直接装入最终系统。

因此最终镜像已经包含：

- Node.js 运行依赖；
- FlowBoard 前端与服务端；
- `/opt/flowboard` 数据目录；
- OpenRC + systemd 两种服务定义；
- 开机自启链接；
- 默认根管理员邮箱 `804559340@qq.com`；
- 邀请码注册/用户上限/管理员画布管理代码。

## 一次性准备

构建机必须是 Linux。安装最新 pmbootstrap，然后：

```sh
pmbootstrap init
```

选择：

- vendor: `xiaomi`
- device: `dior`
- architecture: 由设备包决定（armv7）
- UI: 尽量选择 console/最轻量方案
- service manager: OpenRC 或 systemd 均可

如果当前 pmaports 已经移除了 dior，先不要硬编译仓库里的不完整 snapshot。见 `pmaports-snapshot/README.md`。

## 一键构建

在仓库根目录：

```sh
chmod +x linux/dior/build-image.sh
./linux/dior/build-image.sh
```

默认会：

1. 检查 pmbootstrap 当前配置是 dior；
2. 确认当前 pmaports 真的包含完整 `device-xiaomi-dior` 和 `linux-xiaomi-dior`；
3. 若 `frontend/FlowBoard-linux.tar.gz` 不存在，先构建应用发布包；
4. 把 `linux/dior/flowboard-apk` 注入当前 pmaports 的 `main/flowboard-server`；
5. 运行 `pmbootstrap checksum`；
6. 单独构建 FlowBoard APK；
7. 运行 `pmbootstrap install --split --add=flowboard-server`；
8. 导出到 `out/dior/`。

自定义 pmaports：

```sh
PMB_APORTS=/path/to/pmaports ./linux/dior/build-image.sh
```

自定义输出：

```sh
OUTPUT_DIR=/tmp/dior-image ./linux/dior/build-image.sh
```

## 刷机

构建脚本**不会自动刷机**。

确认手机型号后再进 fastboot。postmarketOS 的 dior 文档使用分开的 boot/rootfs 刷写流程；先查看 `out/dior` 中实际文件名，再执行对应的 boot 写入和 `pmbootstrap flasher flash_rootfs`。

不要把其他 Redmi Note 的 boot 镜像刷进 dior。

## 旧 pmaports snapshot

`pmaports-snapshot/` 是为了锁住旧设备定义和内核配置，方便我们后续继续补齐、审计和复现。

当前它仍缺少 `linux-xiaomi-dior/APKBUILD` 引用的 6 个 patch，所以脚本故意不会拿它静默替换一个完整 pmaports。等 6 个 patch 都按原始版本/哈希找齐后，再把 snapshot 升级为可独立构建的 fallback。
