# Redmi Note 4G (dior) — postmarketOS 服务器路线

> 目标：把单卡 Redmi Note 4G / `dior` 作为长期在线的 FlowBoard ARMv7 小服务器使用。

## 现实边界

`dior` 的社区 Linux 支持目前属于 **downstream kernel** 路线，而不是 mainline Linux。也就是说：

- 可以使用新的 postmarketOS / Alpine 用户空间、Node.js、OpenSSH，以及 OpenRC 或 systemd。
- 手机启动内核仍应使用 `dior` 的设备专用内核/设备包，不能直接把普通 Debian 的新内核刷进去。
- FlowBoard 本身只依赖 Node.js 和文件系统，不依赖桌面、GPU 或 Android，因此这种“设备内核 + 新用户空间”结构正适合长期服务。

## 构建/刷入系统

建议在一台普通 Linux PC 上安装最新 `pmbootstrap`，然后按 postmarketOS 的 `xiaomi-dior` 设备配置生成系统。当前稳定版是 postmarketOS v26.06，基于 Alpine 3.24；若 `dior` 当前只在 edge/testing 提供，就用 pmbootstrap 的 edge 通道构建。

典型流程：

```bash
pmbootstrap init
pmbootstrap install
pmbootstrap export
```

在 `pmbootstrap init` 中选择 Xiaomi / dior，并尽量使用无桌面或最轻量环境，因为本机只有 2 GB RAM / 8 GB eMMC。

进入 fastboot 后，按当前 postmarketOS 设备文档提供的方式写入 `boot` 和 rootfs。不同 pmaports 版本的导出文件名可能变化，所以刷写前先查看：

```bash
ls -lh /tmp/postmarketOS-export/
```

不要把其他 Redmi Note 型号的 boot.img 刷到 `dior`。

## 存储建议

8 GB eMMC 很紧张。建议：

- 系统 + FlowBoard 程序留在内部存储。
- 如果设备/内核对 microSD 稳定，项目备份、导出文件和长期图片资源优先放 microSD。
- 不安装桌面环境。
- 不在手机上安装 MySQL/PostgreSQL/Docker。
- FlowBoard 使用自身 JSON/资源存储即可。
- 定期备份 `/opt/flowboard/project-data`、`auth-data`、`flowboard.env`。

## 安装 FlowBoard

把开发机生成的 `FlowBoard-linux.tar.gz` 传到手机：

```bash
mkdir -p ~/flowboard-release
cd ~/flowboard-release
tar -xzf FlowBoard-linux.tar.gz
sudo ./install-linux.sh
```

安装器会分别检测 apk/apt 和 OpenRC/systemd，自动：

- 安装/检查 ARMv7 Node.js 和 CA 证书。
- 创建低权限 `flowboard` 用户。
- 安装到 `/opt/flowboard`。
- 根据系统注册 OpenRC 或 systemd 服务。
- 设置开机启动并立即启动。
- 保留已有业务数据和 `flowboard.env`。

如果系统是 OpenRC：

```bash
sudo rc-service flowboard status
sudo rc-service flowboard restart
```

如果系统是 systemd：

```bash
sudo systemctl status flowboard --no-pager
sudo systemctl restart flowboard
```

## SMTP

默认发件/根管理员邮箱固定为：

```
804559340@qq.com
```

QQ 邮箱开启 SMTP 并生成授权码后，在手机执行：

```bash
sudo su -s /bin/sh flowboard -c 'node /opt/flowboard/server-bundle.cjs set stp 你的授权码'
# OpenRC:
sudo rc-service flowboard restart
# 或 systemd:
sudo systemctl restart flowboard
```

无需再填写 SMTP 主机、端口和发件邮箱。

## 注册与管理员

- `804559340@qq.com` 首次注册免邀请码，并自动成为根管理员。
- 其他邮箱必须使用管理员生成的邀请码。
- 默认注册总人数上限：20。
- 管理员可在 Web 管理后台生成/停用邀请码。
- 根管理员可直接打开、编辑所有用户画布。
- 可复制整张别人的画布到自己账号。
- 可只选择别人画布中的一个分组（含嵌套分组和图形）复制到自己的某张画布。

## 内网穿透

FlowBoard 默认监听：

```
127.0.0.1:3000
```

让 frp/cloudflared/其他穿透客户端在同一台手机上回源到：

```
http://127.0.0.1:3000
```

有固定域名时，在 `/opt/flowboard/flowboard.env` 增加：

```bash
FLOWBOARD_PUBLIC_HOST=draw.example.com
FLOWBOARD_PUBLIC_PROTOCOL=https
FLOWBOARD_COOKIE_SECURE=true
```

然后：

```bash
sudo rc-service flowboard restart
```

服务器已经支持 `X-Forwarded-Host` / `X-Forwarded-Proto`，通过反代生成分享链接时不会错误拼接内部的 `:3000`。

## 资源限制

默认：

```bash
NODE_OPTIONS=--max-old-space-size=768
FLOWBOARD_MAX_USERS=20
```

对于 2 GB RAM 的手机，建议初期保持 10–20 个注册用户，并控制同时在线人数。前端绘图发生在访问者浏览器里，手机主要处理账号、JSON/图片存储和 HTTP 请求，因此比服务端渲染型绘图程序轻得多。
