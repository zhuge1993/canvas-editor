# Dior V1 云端完整镜像构建

入口：GitHub Actions → **Dior V1 full image**。
`linux-server-armhf` 上的相关源码 push 会触发；不重复触发 PR 内核构建。
旧的 **Linux server build** 只生成应用包，不代表手机镜像构建通过。

新流程运行于 GitHub 的临时 Ubuntu VM，自动准备 pmbootstrap、pmaports，
在初始化 dior 配置前补入缺失的已校验快照，然后调用已有的
`build-v1-first-flash.sh`。不要求用户在电脑上重新编译。

构建流程：

- 完整 FlowBoard Linux 应用发布包；
- dior 3.4 内核、WCNSS helper、固件和设备 APK；
- standard / console / OpenRC rootfs；
- 包安装及自启检查、Node 版本检查、qcdt 和 boot/rootfs 产物检查；
- SHA-256 清单和完整镜像候选包上传。

成功产物：`DiorLinux-FlowBoard-V1-<commit>`，内含 tar.gz 和 SHA256SUMS。
镜像导出文件必须含 `boot.img-xiaomi-dior` 和 `xiaomi-dior.img`。
失败时只上传脱敏构建日志，不把残缺镜像当作成功产物上传。

镜像首次系统登录用户名为 `dior`。密码每次随机生成，只写进私有产物的
`FIRST-LOGIN.txt`，不提交 Git，也不写进上传的明文日志。
首次登录后执行 `passwd` 修改。这个账号不是 FlowBoard 的网页根管理员。
QQ SMTP 授权码不会放入镜像，FlowBoard 仍默认监听 127.0.0.1:3000。

保留期为 7 天。候选包及 FIRST-LOGIN.txt 必须保密，勿公开发布。
官方 pmbootstrap / pmaports 的实际源码 commit 写入 UPSTREAM-REVISIONS.txt。
内核和历史补丁的原有固定来源及 SHA-512 校验不变。

**构建成功不等于实机启动成功。** CI 不运行任何 Fastboot 刷机命令。
不要在另一台电脑上用“原 pmbootstrap 工作区”版 flash-v1-first.sh 硬刷下载包。
从云端下载后的刷写入口和分区验收，必须匹配真实导出的镜像后再交付。

如果 job 的 runner_id=0 且 steps 为空，说明 GitHub 尚未执行构建；
此时没有有效源码编译结果或真实镜像，不应通过重复 rerun 冒充进展。
