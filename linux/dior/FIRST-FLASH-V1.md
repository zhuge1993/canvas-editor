# DiorLinux / FlowBoard V1 第一版首刷

目标只有一个：**先让 Redmi Note 4G 单卡版（codename: dior）成功启动 Linux，并让完整 FlowBoard 在开机后自动运行。**

V1 暂时不把 frp/cloudflared 做成镜像硬依赖，不装桌面，不做 Docker/数据库，不继续扩功能。先验证 boot、rootfs、Wi-Fi、Node、FlowBoard 这一条主链。

## 0. 只适用于这个手机

- Xiaomi Redmi Note 4G **单卡版**
- codename: `dior`
- ARMv7 / Snapdragon 400 系
- 2 GB RAM / 8 GB eMMC

不要刷到 Redmi Note 4G 双卡版（常见 codename: gucci）或其他 Redmi Note。

## 1. 构建机准备

使用 Linux PC。安装最新 pmbootstrap、Git、Fastboot、Node/pnpm。

先运行：

```sh
pmbootstrap init
```

选择：

- vendor: `xiaomi`
- device: `dior`
- UI: `console`
- 不选桌面环境

V1 使用 `console` 是为了尽量压低 rootfs 体积。dior 的 system 分区很小，第一版不测试 XFCE/Phosh 等桌面。

## 2. 构建 V1

在本仓库根目录：

```sh
git checkout linux-server-armhf
chmod +x linux/dior/build-v1-first-flash.sh linux/dior/flash-v1-first.sh
./linux/dior/build-v1-first-flash.sh
```

脚本会：

1. 确认 pmbootstrap 当前设备是 dior；
2. 验证/补齐锁定的 dior device/kernel/firmware/WCNSS aport；
3. 对历史 kernel patch 做 SHA-512 校验；
4. 构建 FlowBoard Linux 发布包；
5. 构建 `flowboard-server` APK；
6. 构建 dior 3.4 kernel、WCNSS、firmware、device package；
7. 使用 **standard（非 split）** 安装 FlowBoard 到 rootfs；
8. `pmbootstrap export`；
9. 生成 `BUILD-MANIFEST.txt`、`FLASHING-NOTES.txt`、`SHA256SUMS`。

默认产物目录：

```
out/dior-v1-first/
```

## 3. 进入 Fastboot

关机后按住：

**音量减 + 电源**

直到出现 Fastboot 界面。

Linux 构建机确认：

```sh
fastboot devices
fastboot getvar product
```

product 必须能识别为 `dior`。本仓库的首刷脚本也会再次检查；不匹配会拒绝刷写。

## 4. 刷 V1

必须在**刚才构建 V1 的同一台 Linux PC / 同一套 pmbootstrap 工作目录**执行：

```sh
./linux/dior/flash-v1-first.sh
```

脚本会：

1. 校验 `SHA256SUMS`；
2. 校验 manifest 的 `target_device=dior`；
3. 校验 `install_mode=standard`；
4. 校验 Fastboot product；
5. 要求手工输入 `DIOR` 二次确认；
6. 执行：
   ```sh
   fastboot flash:raw boot out/dior-v1-first/boot.img-xiaomi-dior
   pmbootstrap flasher flash_rootfs
   ```
7. 成功后 `fastboot reboot`。

这套 boot/rootfs 刷法对应 dior 的 postmarketOS 设备安装方式。V1 不使用 split/netcat。

## 5. 首次启动

先确认 Linux 能启动，再做任何公网穿透。

登录 console 后检查：

```sh
uname -a
ip link
ip addr
```

### Wi-Fi

优先：

```sh
nmtui
```

如果没有 nmtui，可用：

```sh
nmcli device wifi list
nmcli device wifi connect '你的WiFi名称' password '你的WiFi密码'
```

确认联网：

```sh
ping -c 3 1.1.1.1
```

### FlowBoard 服务

OpenRC：

```sh
rc-service flowboard status
```

systemd：

```sh
systemctl status flowboard --no-pager
```

确认 Node 监听：

```sh
ss -lnt | grep 3000
```

应该看到：

```
127.0.0.1:3000
```

本机验证网页：

```sh
wget -qO- http://127.0.0.1:3000/ | head
```

## 6. 配 QQ SMTP

默认发件/根管理员邮箱：

```
804559340@qq.com
```

只输入 QQ SMTP 授权码：

```sh
su -s /bin/sh flowboard -c 'node /opt/flowboard/server-bundle.cjs set stp 你的QQ授权码'
```

然后重启 FlowBoard：

OpenRC：

```sh
rc-service flowboard restart
```

systemd：

```sh
systemctl restart flowboard
```

真实授权码不要提交 Git。

## 7. V1 验收标准

先只验这 7 项：

1. 手机能从 dior boot image 启动；
2. rootfs 能挂载并进入 console；
3. Wi-Fi 能拿到 IP；
4. Node.js 版本满足 FlowBoard；
5. FlowBoard 服务开机自动启动；
6. `127.0.0.1:3000` 能返回页面；
7. 根管理员邮箱能正常收验证码并完成首次注册。

这 7 项通过以后，才进入 V1.1：公网 tunnel 自启、真实多用户压力、长期运行和剩余优化。

## 8. 如果失败，先收这几个真实日志

不要反复重刷。把下面结果保存下来：

```sh
uname -a
ip addr
dmesg | tail -n 200
rc-service flowboard status 2>&1 || true
systemctl status flowboard --no-pager 2>&1 || true
journalctl -u flowboard -n 200 --no-pager 2>&1 || true
cat /opt/flowboard/logs/server.log 2>/dev/null || true
```

如果连 Linux 都没启动，优先记录 Fastboot 刷写输出和手机启动停在哪一步。
