# Dior 长期 FlowBoard 服务器部署

适用于已经通过 userdata DirectRoot 运行 postmarketOS / Alpine 的 Redmi Note 4G。程序监听 `127.0.0.1:3000`，浏览器承担绘图，手机负责账号、画布、图片和分享接口。

## 免账号穿透与长期运行

当前免账号方式使用 Cloudflare Quick Tunnel。连上公网后，它分配一个 `https://名称.trycloudflare.com` 网址，不需要 Cloudflare 账号或自己的域名。保留正在运行的穿透进程时，短暂 WiFi 断线后可以重新连接；穿透进程退出、被监督进程重启或手机重启后可能分配新网址，因此这种方式不能承诺永久固定地址。持续 USB 供电能减少停机，不能保证公网地址永远不变。

穿透客户端将当前可用网址原子写入 `/var/lib/dior-tunnel/public-url`，并在启动、退出或停止时清空失效网址。FlowBoard 每次生成或列出分享链接、返回登录用户的入口地址及生成扫码入口时，重新读取这个小文件，无需为了换网址重启 FlowBoard。既有分享 token、权限和存储记录保持；换域名后需要使用“新网址 + 原分享路径”，旧域名是否还能访问由穿透服务决定。

使用自己的固定域名和命名隧道时，地址可以独立于局域网 DHCP 和手机重启保持。该方式需要对应账户与域名配置，作为后续选项保留。

局域网地址需要在路由器中给手机的固定 WLAN MAC 设置 DHCP 地址保留。不要随意指定静态 IP，避免与路由器地址池冲突。Dior 的旧 prima 驱动不支持在运行中修改 WLAN MAC，应关闭 NetworkManager 扫描随机地址，连接使用 `cloned-mac-address=preserve`。固定公网域名无需依赖手机的局域网 IP。

保留所有已授权 WiFi 的系统连接配置，让 NetworkManager 自动选择可用网络，不锁定单个 SSID。各配置使用 `connection.autoconnect=yes`、相同的 `connection.autoconnect-priority`、`connection.autoconnect-retries=0`，以及 `802-11-wireless.cloned-mac-address=preserve`、`802-11-wireless.powersave=2`。凭据文件权限为 `0600`，不放入源码或公开测试日志。相同优先级下选择由 NetworkManager 的可用网络与连接历史决定；当前连接正常时，不强制反复切换。写入自动连接设置后，还要分别验证实际 WiFi 认证、DHCP 地址、DNS 和公网通信。

## 程序升级与开机启动

在开发电脑运行 `pnpm run build:linux`，将 `FlowBoard-linux.tar.gz` 传到手机并解压，然后执行：

```sh
sudo ./install-linux.sh
sudo rc-update add flowboard default
sudo rc-service flowboard status
```

安装器保留 `/opt/flowboard/flowboard.env`、`project-data/`、`auth-data/` 和 `logs/`。已有手机只需更新这些程序与服务文件；这一步不需要刷写手机分区。

OpenRC 服务在本地文件系统就绪后启动，不等待 WiFi 认证或公网可用。它使用 `supervise-daemon`，进程退出后等待 3 秒重启，重试次数不设上限。启动后每 30 秒检查本机 `/api/health`，每次 HTTP 请求最多 5 秒；连续 3 次失败后，监督进程会终止旧 Node 进程并重新启动。检查仅访问回环地址，WiFi 或公网断线不会把正常运行的 FlowBoard 当作故障。

可单独验证：

```sh
sudo rc-service flowboard healthcheck
sudo rc-service flowboard status
```

手动 `rc-service flowboard stop` 会同时停止监督进程，服务会保持停止。重新启动或下次正常开机才会恢复。systemd 安装也保留进程退出重启，但此处的 HTTP 健康重启针对 Dior 的 OpenRC。

## 当前动态公网地址

免账号方式配置：

```sh
FLOWBOARD_HOST=127.0.0.1
FLOWBOARD_PORT=3000
FLOWBOARD_PUBLIC_URL_FILE=/var/lib/dior-tunnel/public-url
FLOWBOARD_PUBLIC_PROTOCOL=https
FLOWBOARD_COOKIE_SECURE=true
```

不要同时保留以前的占位 `FLOWBOARD_PUBLIC_HOST=draw.example.com`，因为显式公网主机始终优先于动态文件。文件只接受最多 1024 字节的单行 HTTPS 单级 `*.trycloudflare.com` origin，允许结尾一个 `/`；用户名、密码、额外端口、路径、查询参数、片段及其他域名都拒绝。文件缺失、清空或无效时使用原有可信请求头/局域网回退，不把任意文件内容拼进网址。显式 `FLOWBOARD_PUBLIC_PROTOCOL=http` 也保留既有 HTTP 行为，不启用这个 HTTPS 文件来源。

实际穿透部署见 [长期隧道部署](../linux/dior/always-on-tunnel/README.md)。公开 URL 文件不含认证 token，应让 `flowboard` 服务账号可以读取。

## 新网址邮件通知

已授权向注册玩家发信时，在私有运行配置中设置：

```sh
FLOWBOARD_TUNNEL_NOTIFY=true
```

它与 `FLOWBOARD_PUBLIC_URL_FILE` 共同启用通知，复用已有 `FLOWBOARD_SMTP_*` 配置及 `set stp` 授权码设置，不引入额外邮件平台。先保留或迁入原账号、画布和分享记录，再启用；只通知已注册、已验证、未禁用或删除的 `@qq.com` 邮箱，同邮箱重复账号合并。其他邮箱不会收到此类通知。

每轮先通过当前公网 HTTPS 地址读取 `/api/health`，要求 HTTP 200 且 `app=FlowBoard`、`status=ok`，保留 TLS 证书验证，不跟随跳转。只有穿透进程打印网址还不算网站可访问。通知包含当前网站入口及保留原分享路径的说明，账号和分享 token 不变。

队列和已发送去重记录存入私有 `auth-data/tunnel-notifications.json`，以文件/目录 `fsync` 确认。状态区分 `not_configured`、`awaiting_public_health`、`retry_pending`、`up_to_date` 和存储错误；未配置 SMTP 或断网时不假装已发送。失败从 30 秒开始退避重试，最长 30 分钟；网址变化会丢弃旧网址未发送任务，只通知当前新网址。已持久确认的同邮箱、同网址记录在正常服务重启后不重复发送。

SMTP 接受邮件与本地状态写盘无法构成同一个事务。如果恰好在 SMTP 接受后、去重状态落盘前崩溃，恢复重试仍可能产生重复邮件；每个“网址 + 邮箱”使用固定 `Message-ID`，但邮箱服务器并不保证据此去重。`sent` 表示 SMTP 的 DATA 250 已接受且本地状态保存，不能代替收件人实际查收。

## 后续固定域名配置

在私有 `/opt/flowboard/flowboard.env` 中设置实际域名，例如：

```sh
FLOWBOARD_HOST=127.0.0.1
FLOWBOARD_PORT=3000
FLOWBOARD_PUBLIC_HOST=draw.example.com
FLOWBOARD_PUBLIC_PROTOCOL=https
FLOWBOARD_COOKIE_SECURE=true
FLOWBOARD_TRUST_PROXY=false
```

`draw.example.com` 是示例占位符，需要替换成实际可控制的域名。`PUBLIC_HOST` 只填主机名及必要的公网端口，不能包含 `https://` 或路径。HTTPS 隧道回源到 `http://127.0.0.1:3000`。同机反向代理自动受信任，公网入口仍使用 HTTPS。

更新配置后执行 `sudo rc-service flowboard restart`。创建或列出查看、编辑分享时，返回的地址优先使用该域名和 HTTPS，不附加内部 `:3000`。已有分享 token 保持不变，只要没有撤销、设定有效期或删除对应项目，它们会继续生效。

固定 Cloudflare 命名隧道 / frp 的客户端配置与启动文件见 [长期隧道部署](../linux/dior/always-on-tunnel/README.md)。隧道必须使用持久身份；每次启动重新分配的临时网址不能满足固定链接要求。域名、隧道 token 和服务端账号由部署时填写，凭据放在手机私有配置中。

## 画布与分享的保存

`project-data/` 保存画布、版本和图片，`auth-data/` 保存账号、会话、邀请码及 `shares.json`。保存 JSON 和图片时先写同目录下独立临时文件，完成文件 `fsync`，再原子替换；Linux 下再完成父目录 `fsync`，随后才返回保存成功。写入或同步失败会返回错误。此前的数据在替换前仍可读取，临时文件会清理。

这能降低意外掉电时丢失已确认保存的风险，不能代替备份，也不能保证损坏的 eMMC 或控制器正确执行刷盘。应备份两个数据目录及私有配置。复制备份时先停止服务，备份完成再启动，保证账号与画布属于同一时刻：

```sh
sudo rc-service flowboard stop
# 将 project-data/、auth-data/、flowboard.env 备份到已有的可靠存储位置。
sudo rc-service flowboard start
```

## 持续供电与验收

保持 USB 电源连接，同时让系统的睡眠禁止服务开机启动；灭屏不应停止 Node 或 WiFi。持续供电后仍需检查温度、可用空间和日志，不能用关闭温控或磁盘保底空间来提高在线率。FlowBoard 默认保留 128 MiB 可用空间，并限制图片库 512 MiB。

以下检查应分别记录：

1. 启动后本机 `/api/health` 返回 `app=FlowBoard`、`status=ok`。
2. WiFi 完成认证，获取地址，能解析域名并访问公网。
3. 终止 Node 子进程后，监督进程启动新进程，原有查看、编辑链接仍可使用。
4. 本机 HTTP 卡住后，健康检查终止旧进程，网站恢复响应。
5. 手机重启后，FlowBoard、WiFi 和穿透自动启动；免账号模式记录新的当前网址，使用原分享 token 验证查看与编辑。固定域名模式另验原网址不变。
6. 从手机局域网外打开当前 HTTPS 网址和实际分享链接。

开发机回归命令为 `pnpm run test:server-lifetime`。测试使用独立临时目录，验证账号、会话、查看/编辑 token、画布及图片在进程强制终止后保持，注入 `fsync` 失败验证错误返回与旧数据保留，并验证健康检查的正常、错误应用和 HTTP 超时情况；动态 URL 文件变化后验证入口随之更新、分享 token/记录保持及非法内容安全回退。手机上的重启、网络和公网验收仍应单独实测。
