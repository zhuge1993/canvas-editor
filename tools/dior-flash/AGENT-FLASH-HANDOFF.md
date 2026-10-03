# DiorLinux / FlowBoard — Agent 刷机交接

目标设备仅限 **Xiaomi Redmi Note 4G 单卡版，codename: dior**。

## 选择产物

优先使用最新一次 **Dior V1 full image** 成功运行产生的公开 artifact。

从该 artifact 中选择：

`DiorLinux-FlowBoard-V1-<commit>-SafeDirectRoot.zip`

不要优先使用历史 USB repair / 独立 DirectRoot 测试包；SafeDirectRoot 是从同一次最新 full-build rootfs 提取生成的。

## 安全契约

- 只刷 `userdata`
- 不刷 `boot`
- 不刷 `system`
- 不刷 `recovery`
- 保留已经真机验证成功的 **13,113,344-byte QCDT-trimmed boot**
- 手机必须由 fastboot 精确报告 `product=dior`
- 必须只有一台 fastboot 设备
- 写入前必须通过 ZIP / image SHA256、VERIFICATION.json、UUID 和 userdata 容量检查
- 不允许手工猜分区
- 不允许 force/绕过脚本的安全检查

## Windows 刷入

1. 解压 SafeDirectRoot ZIP 到普通本地目录。
2. 将 Android platform-tools 放到解压目录的 `platform-tools` 子目录，或保证 `fastboot.exe` 已在 PATH。
3. 手机进入 Fastboot。
4. USB 连接电脑。
5. 双击：

   `flash-directroot.cmd`

6. 脚本应先做检查，不满足条件立即停止。
7. 只有确认设备为 dior 且所有校验通过后，在提示时输入：

   `DIOR`

8. 等 userdata 写入完成并重启。刷写期间不要断电/拔线。

## 开机后的第一件事

系统会自动生成：

`/var/log/dior-hardware-firstboot.log`

先读取并保存完整内容。

然后再执行：

```sh
dior-hw-verify
dior-hw-smoke
dior-hw-probe
```

把三份完整输出保存回来。

## 必须验证

- FlowBoard 本机 HTTP：127.0.0.1:3000
- USB NCM：usb0
- USB ACM：ttyGS*
- framebuffer / 显示
- Atmel maXTouch 触摸
- gpio-keys
- WCNSS / wlan0 / NetworkManager Wi-Fi 扫描
- Q6/ADSP ONLINE
- ALSA sound card
- 摄像头 media/V4L2 节点
- VIDC 不再出现 firmware load failure
- 电池容量
- USB/充电电源节点
- thermal zones
- backlight
- LEDs
- haptic/vibrator
- Bluetooth hci_smd / hci0
- FM radio
- GPS/NMEA /dev/smd27
- rmnet / modem interfaces
- sensors
- microSD/MMC
- USB host

## 判断规则

编译成功、设备节点存在、固件文件存在，都不能单独等同于“硬件已完全可用”。

只有真机实际通过对应测试后才标记 PASS。

如果某项 FAIL：

1. 不要改刷机分区策略。
2. 不要刷 boot/system/recovery。
3. 不要回退已经成功的 DirectRoot/NCM/ACM。
4. 收集：
   - `/var/log/dior-hardware-firstboot.log`
   - `dior-hw-verify`
   - `dior-hw-smoke`
   - `dior-hw-probe`
   - 相关 `dmesg`
5. 基于真实失败继续修。

## FlowBoard

系统目标仍是长期运行完整 FlowBoard / Canvas Editor。

默认根管理员：

`804559340@qq.com`

QQ SMTP 在设备启动后单独配置：

`set stp <QQ邮箱授权码>`

授权码不得写入 Git、镜像、CI 日志或公开 artifact。
