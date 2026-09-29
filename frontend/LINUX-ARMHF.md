# FlowBoard — Debian 13 ARMv7 / Redmi Note 4G 部署

这套 Linux 发布包用于 **Debian 13 armhf + Node.js 20.19+**。绘图核心仍在浏览器运行，手机承担账号、画布存储、分享、邮件验证和 API 服务，因此不会因为改成 Linux 而删减现有绘图功能。

## 推荐运行结构

```
Internet
   |
HTTPS 内网穿透 / 反向代理
   |
127.0.0.1:3000
   |
FlowBoard (Node.js)
   |
/opt/flowboard/{project-data,auth-data,logs}
```

默认只监听 `127.0.0.1`。如果你的穿透客户端运行在同一台手机上，直接把上游指向 `http://127.0.0.1:3000` 即可。

## 安装

先在开发机生成 Linux 包：

```bash
cd frontend
pnpm install --frozen-lockfile
pnpm run build:linux
```

得到 `FlowBoard-linux.tar.gz`。传到手机上的 Debian 13，解压后：

```bash
tar -xzf FlowBoard-linux.tar.gz
cd <解压目录>
sudo ./install-linux.sh
```

安装脚本会：

- 检查 Node.js 20.19+；Debian 系统缺失时尝试用 apt 安装。
- 创建低权限系统用户 `flowboard`。
- 安装到 `/opt/flowboard`。
- 创建并启用 systemd 服务。
- 保留已有 `flowboard.env` 和业务数据，不覆盖已有配置。

## QQ 邮箱验证码

发件邮箱固定默认使用：

```
804559340@qq.com
```

只需要设置 QQ 邮箱 SMTP 授权码：

```bash
sudo -u flowboard node /opt/flowboard/server-bundle.cjs set stp <你的QQ邮箱授权码>
sudo systemctl restart flowboard
```

也接受拼写 `set smtp <授权码>`。

配置写入 `/opt/flowboard/flowboard.env`，权限为 600。不要把真实授权码提交到 Git。

## 第一个管理员

首次访问注册页时：

- `804559340@qq.com` 不需要邀请码。
- 它完成邮箱验证码注册后自动成为根管理员。
- 根管理员不能被取消管理员权限，也不能从 Web 管理后台删除。
- 其他邮箱必须填写有效邀请码。

登录根管理员后，首页进入「管理」：

- 生成/停用邀请码，并设置每个邀请码允许使用的次数。
- 查看注册用户、授权普通管理员、删除用户。
- 查看所有用户画布。
- 直接打开并编辑任意用户画布。
- 整张画布复制到自己的账号。
- 从任意画布选择一个分组（含嵌套子组与图形）复制到自己的某张画布。

默认用户总量上限是 20：

```bash
FLOWBOARD_MAX_USERS=20
```

这不是并发数，而是服务器允许存在的注册账号总数。2 GB RAM 的手机建议从 10–20 人开始。

## 外部访问

推荐让穿透/反向代理终止 HTTPS，然后回源：

```
http://127.0.0.1:3000
```

如果有固定公网域名，在 `/opt/flowboard/flowboard.env` 里设置：

```bash
FLOWBOARD_PUBLIC_HOST=draw.example.com
FLOWBOARD_PUBLIC_PROTOCOL=https
FLOWBOARD_COOKIE_SECURE=true
```

修改后：

```bash
sudo systemctl restart flowboard
```

## 常用运维

```bash
systemctl status flowboard --no-pager
journalctl -u flowboard -f
systemctl restart flowboard
systemctl stop flowboard
```

健康检查：

```bash
curl http://127.0.0.1:3000/api/health
```

数据目录：

- `/opt/flowboard/project-data`：画布和资源。
- `/opt/flowboard/auth-data`：用户、会话、邀请码。
- `/opt/flowboard/logs`：应用日志。

升级应用时先备份这三个目录；Linux 发布包与业务数据分离。

## 2 GB RAM / 8 GB 存储建议

systemd 默认把 FlowBoard 服务最大内存限制为约 1.2 GB，`NODE_OPTIONS` 默认把 V8 heap 限到 768 MB。图片仍建议限制尺寸，并把长期备份迁移到 microSD/NAS。不要在这台手机上同时运行数据库、桌面环境和多个重型服务。
