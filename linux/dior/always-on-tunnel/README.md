# Dior 免账户穿透与固定公网入口

此目录为 Redmi Note 4G 的 FlowBoard 常驻服务器提供免账户 Quick Tunnel，以及备用的固定域名隧道。手机通过 WiFi 主动连出，网站继续监听 `127.0.0.1:3000`。用户没有账户或域名时，选择 `quick` 就可以申请当前运行期间的 HTTPS 地址。项目和分享权限的持久化由 [FlowBoard 常驻部署](../../../frontend/DIOR-ALWAYS-ON.md) 管理；主动撤销、改权限或删除项目的行为仍然生效。

安装器默认 `disabled`，不自行创建账户或启用服务。用户明确选择 `quick` 后可以直接启动免账户穿透，无需先提供域名、Tunnel UUID 或 token。只有备用的 `cloudflare`/`frp` 固定入口模式需要用户提供对应资源。程序记录当前公开 URL，并明确将公网连通标为未验证，实际连通结果由外网访问测试确认。

## 免账户模式：quick

安装已校验的 ARM cloudflared 和本目录服务后，以 root 选择 Quick Tunnel 并加入开机服务：

```sh
printf '%s\n' quick > /etc/dior-tunnel/provider
chown root:flowboard-tunnel /etc/dior-tunnel/provider
chmod 0640 /etc/dior-tunnel/provider
node /usr/local/libexec/dior-tunnel-check.cjs
rc-update add dior-tunnel default
rc-service dior-tunnel start
```

FlowBoard 的公开运行参数设置 `FLOWBOARD_PUBLIC_URL_FILE=/var/lib/dior-tunnel/public-url`，HTTPS/secure cookie 参数保持开启；不要设置优先级更高的固定 `FLOWBOARD_PUBLIC_HOST` 来覆盖当前 Quick URL。FlowBoard 每次生成或列出分享/编辑链接时读取最新公开文件，URL 更新不要求重启 FlowBoard。这个 wrapper 不读写 `flowboard.env`、账户数据库或分享记录。

`dior-quick-tunnel.cjs` 以 `flowboard-tunnel` 用户启动 cloudflared，回源固定为 `http://127.0.0.1:3000`，强制 HTTP/2、IPv4、禁用自动更新。显式指定 `/dev/null` 配置和 origin certificate，使用独立 HOME，并移除隧道账户相关环境变量，避免混入已有的命名隧道设置。它从 stdout/stderr 分块读取输出，只接受合法 `https://单标签.trycloudflare.com`，拒绝端口、用户名、额外域名、路径、query 和 fragment。

公开状态目录 `/var/lib/dior-tunnel` 由 `flowboard-tunnel` 拥有、模式 `0755`；URL 和状态文件为 `0644`，只有服务用户能修改，FlowBoard 可以读取。文件使用写入临时文件、fsync、rename 的方式原子更新：

```sh
cat /var/lib/dior-tunnel/public-url
cat /var/lib/dior-tunnel/status.json
```

`status.json` 的 `url-issued` 只表示客户端打印了地址，`publicConnectivityVerified` 保持 `false`。还需检查本地 `http://127.0.0.1:20241/ready`，并从外网实际打开当前网址、分享链接和编辑链接。启动新进程时清空上一进程的 URL，正常停止和客户端退出时也清空。若被 SIGKILL 或断电，下次开机/respawn 会先清空旧文件，再发布新地址。

同一 cloudflared 进程断网后重连时复用已申请的地址；OpenRC 在进程退出后延迟十秒重新启动。**新进程会申请新的随机域名，手机重启也可能换地址，旧分享网址不能保证继续可用。**项目、token 和权限记录保持原样，新生成链接使用当前域名。USB 一直供电并尽量维持进程运行可以减少地址变化，不能保证永久固定地址。需要跨重启不变的网址时，使用下方 named tunnel 或 VPS 方案。

Cloudflare 官方将 Quick Tunnel 定义为免账户的临时入口，没有 uptime 保证，最多 200 个同时进行的请求，且不支持 SSE。当前手机部署是否符合绘图功能需要由实测确认。[Quick Tunnel 官方说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

## 备用：选择固定入口

| 路线 | 用户需要的现有资源 | 手机出站连接 | HTTPS 入口 |
| --- | --- | --- | --- |
| Named Cloudflare Tunnel | Cloudflare 账户、已托管的域名、一个命名隧道的 UUID 和凭据 JSON | IPv4 TCP 7844，协议 HTTP/2 | Cloudflare 对外提供同一域名 |
| 自有 VPS + frp | 可管理的公网 VPS、固定域名、frps 证书/CA 和双方私有 token | TLS over TCP，模板端口 7000 | VPS 上的 Caddy 提供同一域名 |

命名隧道与 DNS 记录独立于手机的 DHCP 地址。无需在家庭路由器映射 3000 端口。Cloudflare 客户端固定 `http2`，使这个仅提供 Web 的旧内核设备通过 TCP 工作；QUIC/UDP 和私有网络路由不是本服务模板的组成部分。frp 模板也使用 TCP，并验证 VPS 的 TLS 身份。

Cloudflare 的账号、域名和 Named Tunnel 由用户提供；已有 Tunnel 应复用其 UUID、凭据和 DNS 记录。创建新入口时，在用户可登录的电脑上完成官方的 `cloudflared tunnel login`、`tunnel create` 和 `tunnel route dns` 流程。仅把该隧道的凭据 JSON 放到手机；账号级 `cert.pem` 留在管理电脑。

## 客户端版本与 Linux 3.4

`clients.json` 固定官方已发布版本和 SHA-256，不从 `latest` 自动取新版本：

| 客户端 | 官方版本 | ARM 文件 | 已核对的 Go 构建 |
| --- | --- | --- | --- |
| cloudflared | 2026.9.1 | `cloudflared-linux-armhf` | Go 1.26.8，CGO=0，GOARM=7 |
| frpc/frps | 0.71.0 | `frp_0.71.0_linux_arm_hf.tar.gz` | frpc: Go 1.25.12，CGO=0，GOARM=7 |

两种 ARM 客户端均已核对为 little-endian ELF32 ARM，无动态解释器 `PT_INTERP`，不依赖 glibc loader。Go 官方对 Go 1.24 及之后的 Linux 最低要求为 kernel 3.2；Dior 的 3.4 处于这一版本范围。版本范围和 ELF 检查不能代替手机实测：上线前仍需在手机运行 `--version`、配置检查及真实连接/断网重连。内核需启用 `CONFIG_FUTEX` 和 `CONFIG_EPOLL`。Go 可能使用的新版 syscall 存在回退路径；本目录没有要求改用新 GCC 编译 Dior 内核。

下载到电脑的工作目录，并同时准备电脑端的原生语法检查工具：

```powershell
python linux/dior/always-on-tunnel/fetch-clients.py --output work/tunnel-runtime --windows-check-tools
```

下载器核对官方 release 元数据中的 SHA-256，检查 ARM ELF 和 Go build info。`CLIENT-VERIFICATION.json` 明确保留 `signature_verification=not_performed` 和 `native_dior_execution=not_performed`。这不是发行者签名验证，也不是手机兼容验证。二进制和压缩包只写入指定工作目录，不提交到 Git。

ARM 云隧道客户端 SHA-256：

```text
cloudflared: 95420507a720fb543122a5d69372fbde8f5c919790e95ddd4374a449e0a6f4dd
frp ARM_hf archive: eab1ecb45b00e2f9cf2ebc458fde570ceecb50689c4c5c728677f44825bf3d88
frpc extracted: a4d878a1d6435009a7da9223c9f77137d6b8eef8b9640d1dccbb88e6e5a4a748
```

将已校验的所选 ARM 程序传到手机临时目录，先执行 `timeout 15 ./cloudflared --version` 或 `timeout 15 ./frpc --version`。成功后再 `install -m 0755` 到 `/usr/local/bin/`。不要把 Windows EXE 或 ARM64 程序传成手机客户端。

## 安装服务

把本目录传到手机后，以 root 运行：

```sh
sh ./install-tunnel.sh
```

安装器建立独立的 `flowboard-tunnel` 无登录用户，安装 `dior-tunnel` OpenRC 服务、Quick wrapper 和检查器，并将示例保存到 `/usr/share/dior-tunnel/`。它保留已有 provider、配置和凭据，默认不加入开机 runlevel。依赖手机已有的 Node.js、OpenRC `supervise-daemon` 和 FlowBoard 服务。

填入实际固定 hostname 后，将 `/etc/dior-tunnel/public-url` 设为 `https://实际固定域名`，没有路径、端口或查询参数。`/opt/flowboard/flowboard.env` 中同步设置：

```text
FLOWBOARD_HOST=127.0.0.1
FLOWBOARD_PORT=3000
FLOWBOARD_PUBLIC_HOST=实际固定域名
FLOWBOARD_PUBLIC_PROTOCOL=https
FLOWBOARD_COOKIE_SECURE=true
FLOWBOARD_TRUST_PROXY=false
```

真实域名应同时出现在 FlowBoard 的 PUBLIC_HOST、隧道 ingress 或 VPS Caddy 配置、DNS 记录中。配置文件为 `root:flowboard-tunnel`、模式 `0640`，目录为 `0750`。凭据通过私有文件传入，不放在启动命令或 shell 历史中。

### Named Cloudflare Tunnel

将 `cloudflare.yml.example` 复制为 `/etc/dior-tunnel/cloudflare.yml`，只替换 `REPLACE_WITH_TUNNEL_UUID` 和 `REPLACE_WITH_FIXED_HOSTNAME`。将用户导出的该隧道凭据 JSON 安装到 `/etc/dior-tunnel/cloudflare-credentials.json`，设为 `root:flowboard-tunnel`、`0640`。凭据 JSON 中的 TunnelID 必须属于这个命名隧道。

将 provider 文件设为 `cloudflare`，并检查：

```sh
node /usr/local/libexec/dior-tunnel-check.cjs
cloudflared tunnel --config /etc/dior-tunnel/cloudflare.yml ingress validate
```

配置使用固定 hostname 的一条 FlowBoard ingress，末尾 `http_status:404` 捕获其他请求；metrics 仅绑定 `127.0.0.1:20241`。启动器再次强制 `http2` 和禁用自动升级。日志使用官方 `log-directory` 的大小轮换，避免永久向单个文件追加。

### 自有 VPS + frp

手机上将 `frpc.toml.example` 复制为 `/etc/dior-tunnel/frpc.toml`，两处 VPS hostname 一致替换。把双方共享的随机 token 安装为 `/etc/dior-tunnel/frp-token`，模式 `root:flowboard-tunnel 0640`；将验证 VPS 证书的 CA 安装为 `/etc/dior-tunnel/frp-ca.crt`。生产证书的 SAN 必须包含 VPS hostname。模板显式启用 TLS，指定可信 CA 和 serverName，`loginFailExit=false` 让初始 WiFi 缺失时持续重连。

VPS 管理员采用 `frps.toml.example` 配置 frps，私有 token 路径 `/etc/frp/dior-token`，证书和私钥路径 `/etc/frp/server.crt`、`/etc/frp/server.key`。模板将转发端口 63000 绑定 VPS 的 `127.0.0.1`，只允许这一端口；它由 `Caddyfile.example` 的固定 HTTPS hostname 反代。域名的 A/AAAA 记录指向 VPS，放行客户端 TLS 7000 和浏览器 HTTPS 443；Caddy 取证通常还需要公网 80。不要把只绑定 loopback 的 63000 直接公开。

将手机 provider 文件设为 `frp`，分别在对应机器验证：

```sh
node /usr/local/libexec/dior-tunnel-check.cjs
frpc verify -c /etc/dior-tunnel/frpc.toml
# 以下两项只在 VPS 上执行。
frps verify -c /etc/frp/frps.toml
caddy validate --config /etc/caddy/Caddyfile
```

VPS 需要将 frps 和 Caddy 加入自身开机服务；本目录不会自动连接 VPS 或替用户创建服务器。手机日志设置为 warn，保留三天 frpc 轮换日志；模板不开放 frpc/frps 管理 Web UI。

## 固定域名模式的开机自启和验收

固定入口及用户凭据全部检查成功后：

```sh
rc-update add dior-tunnel default
rc-service flowboard restart
rc-service dior-tunnel start
rc-service dior-tunnel status
```

服务依赖本地 FlowBoard，按顺序在 NetworkManager 之后启动，但不把网络在线设为启动前提。客户端自己重连；进程异常退出时 supervise-daemon 延迟十秒再启动，不限制总重启次数。没有网络时保留本地服务和数据。`GOMEMLIMIT=96MiB` 与 `GOGC=50` 是 Go 的软堆目标，`GOMAXPROCS=2` 限制并行 worker；它们不构成总 RSS 硬限制。

应逐项记录实际测试，而不是以 `rc-service status` 代替联网结果：

1. 确認 WiFi 有默认路由、可用 DNS 和正确时间，本地 `http://127.0.0.1:3000` 可用。
2. Cloudflare 场景读取 `http://127.0.0.1:20241/ready` 的 200；frp 场景确认 VPS 上固定 loopback 转发能够访问 FlowBoard。这仍不是外部浏览器测试。
3. 从外网访问用户的固定 HTTPS hostname，登录、打开绘图、创建并实际打开查看链接与编辑链接。
4. 保留同一份项目/分享数据库，断开 WiFi 后恢复，确认自动重连且原链接继续有效。
5. 手机正常重启，验证 WiFi、FlowBoard 和隧道自动启动，再从外网打开同一个已保存链接。

如果 WiFi、DNS、证书或公网服务故障，固定链接可能暂时不可访问；域名本身不因此更换。公网长期可用也依赖域名续费、VPS/Cloudflare 服务和家庭联网持续有效。USB 常供电不能代替这些条件。

## 已执行的电脑端检查

```sh
node linux/dior/always-on-tunnel/test-config.cjs
node linux/dior/always-on-tunnel/test-quick.cjs
bash -n linux/dior/always-on-tunnel/install-tunnel.sh \
    linux/dior/always-on-tunnel/dior-tunnel-run \
    linux/dior/always-on-tunnel/dior-tunnel.initd
```

配置检查允许显式 `quick` 模式且不要求账户或预先存在的 URL；命名隧道仍检查固定 hostname、ingress、404 fallback，frp 检查重连、TLS 与唯一代理。Quick wrapper 测试通过严格 URL 提取、跨 chunk/双输出流解析、过长行丢弃、原子更新、启动清空旧值、退出清空、正常停止向子进程传递信号，并始终保留“公网未验证”。官方同版本 Windows 客户端已执行 `--version`，`cloudflared ingress validate` 和 `frpc/frps verify` 均返回 0，使用的是自动清理的合成配置。这些电脑检查没有创建或连接公网隧道，不能代替 ARM 手机上的实际连接与重启验收。

可复现原生语法检查：

```powershell
python linux/dior/always-on-tunnel/verify-native-config.py --clients work/tunnel-runtime/windows-amd64 --openssl "C:/Program Files/Git/usr/bin/openssl.exe" --report work/tunnel-runtime/NATIVE-CONFIG-CHECK.json
```

## 官方依据

- [Go 最低系统要求](https://go.dev/wiki/MinimumRequirements)说明当前 Go 的 Linux kernel 3.2、FUTEX 和 EPOLL 基线。
- [Cloudflare 命名隧道配置](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/)说明固定 hostname、ingress 顺序和末尾规则。
- [Cloudflare 运行参数](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/)说明 HTTP/2、metrics、禁止自动更新和 log-directory 轮换。
- [Cloudflare 出站连接要求](https://developers.cloudflare.com/tunnel/configuration/)说明 TCP/UDP 7844 和 HTTP/2/QUIC 对应关系。
- [frp token 文件认证](https://gofrp.org/en/docs/features/common/authentication/)与 [TLS 证书身份验证](https://gofrp.org/en/docs/features/common/network/network-tls/)说明本模板的认证与 CA 设置。
- [frp 客户端配置](https://gofrp.org/en/docs/reference/client-configures/)和 [服务端配置](https://gofrp.org/en/docs/reference/server-configures/)说明持续重连、proxyBindAddr 与允许端口。
- [OpenRC supervise-daemon](https://github.com/OpenRC/openrc/blob/master/supervise-daemon-guide.md)说明后台监督和 unlimited respawn。
