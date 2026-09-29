# FlowBoard ARMv7 Linux 部署

FlowBoard 的 Linux 服务端不需要桌面、GPU 或 Electron。浏览器继续承担画布渲染，Linux 设备负责账号、画布持久化、分享、邮件验证码和管理 API，所以现有绘图能力不因服务器迁移到 Linux 而删减。

## 推荐平台

### Redmi Note 4G / dior

优先使用 **postmarketOS / Alpine**。该机型是社区 downstream-kernel 设备，因此应保留设备专用内核，同时使用尽可能新的 Linux 用户空间；安装器同时支持 postmarketOS 的 OpenRC 与 systemd 变体。具体看 [PMOS-DIOR.md](./PMOS-DIOR.md)。

### 其他 ARMv7 主机

也支持 Debian 13 armhf + systemd，只要 Node.js >= 20.19。

## 生成发布包

在开发机：

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm run build:linux
```

生成：

```
FlowBoard-linux.tar.gz
```

包内包含前端静态资源、单文件 Node 服务 bundle、OpenRC/systemd 服务文件和自动安装脚本。

## 安装

解压后以 root 运行：

```bash
./install-linux.sh
```

安装器会把包管理器和服务管理器分开识别：

- `apk` → postmarketOS/Alpine 软件包。
- `apt` → Debian/Ubuntu 软件包。
- `OpenRC` → 安装 `flowboard.openrc`。
- `systemd` → 安装 `flowboard.service`。

程序目录：

```
/opt/flowboard
├── server-bundle.cjs
├── dist/
├── flowboard.env
├── project-data/
├── auth-data/
└── logs/
```

业务数据与程序文件分离，升级时不要覆盖三个数据目录和 `flowboard.env`。

## QQ SMTP 快速配置

默认邮箱：

```
804559340@qq.com
```

只填 QQ 邮箱授权码：

```bash
node /opt/flowboard/server-bundle.cjs set stp <授权码>
```

实际运行时请以 `flowboard` 用户执行，避免把配置文件所有者改成 root。

独立的 `set stp` 命令只会更新 `/opt/flowboard/flowboard.env`。如果服务已经在运行，需要重启一次让新授权码进入正在运行的 Node 进程：

```bash
# OpenRC
sudo rc-service flowboard restart

# systemd
sudo systemctl restart flowboard
```

Web 管理后台保存 SMTP 时会在当前服务进程内立即生效，不需要额外重启。

## 账号策略

- 默认根管理员：`804559340@qq.com`。
- 根管理员首次注册免邀请码。
- 其他注册必须邀请码。
- 默认 `FLOWBOARD_MAX_USERS=20`。
- 管理后台可创建一次或多次使用的邀请码、停用邀请码、管理用户与管理员权限。
- 根管理员不可被 Web 后台删除或取消管理员权限。

## 管理画布

管理员可以：

- 查看所有用户的画布。
- 用原始完整编辑器直接编辑任何用户画布，保存后所有权仍属于原用户。
- 把整张画布复制到自己。
- 读取任意画布的分组列表，把指定分组连同嵌套子组、图形和内部绑定复制到自己的目标画布。

普通用户仍只在自己的首页看到自己的画布。

## 外部访问

默认监听 `127.0.0.1:3000`，推荐把内网穿透或 HTTPS 反代指向该地址。服务端识别 `X-Forwarded-Host` 和 `X-Forwarded-Proto`，分享链接可使用外部域名。

环境变量：

```bash
FLOWBOARD_PUBLIC_HOST=draw.example.com
FLOWBOARD_PUBLIC_PROTOCOL=https
FLOWBOARD_COOKIE_SECURE=true
```

## 低配优化

默认 V8 heap 上限 768 MB。不要在 2 GB RAM 手机上同时运行桌面、数据库、容器平台或 Chromium 服务端渲染。FlowBoard 的 SVG/Canvas 绘制在客户端浏览器完成，更适合这种低功耗 ARMv7 常驻服务器。
