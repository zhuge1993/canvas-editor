# Voice安装与恢复

固定安装范围为 `/opt/dior-voice`、`/var/lib/dior-voice`、`/run/dior-voice` 和
`/etc/init.d/dior-voice`。仅控制 `rc-service --nodeps dior-voice`，不停止共享ASR、
FlowBoard或穿透，不刷分区。默认stage为 `/tmp/dior-kernel-test/voice-qa`，可由安装者
提供root-owned不可写的同类已验证stage：

```sh
python3 install-voice.py --stage /path/to/qualified-stage
python3 install-voice.py --stage /path/to/qualified-stage --repair-runtime
```

`--repair-runtime`要求已有完整安装，只替换本voice程序，不移动或复制模型。舞台runtime
manifest、native worker、Qwen模型、Piper资产和固定缓存分别受hash/大小/路径检查。
KWS为单独准备的root-owned固定资产，需要先按上级kws资料放入 `/opt/dior-voice/kws`。
OpenRC脚本已包含专用检测器参数；安装manifest记录其资产。
此脚本需要Linux root、OpenRC及预先准备的已验证资产；不负责网络下载，也不接收语音
或LLM传来的路径。

## 中断恢复

开始修改前持久化root-owned `/opt/.dior-voice-installing.json`，包含交易ID、固定
stage摘要、之前服务/runlevel状态和有限程序备份receipt，不含凭据或转写。
首装在创建ROOT和rename模型/TTS前先写marker。若中途退出，重新使用**同一已验证stage**
运行；已移动模型/TTS按receipt与固定hash复用，不要求从空stage再复制权重。

升级先仅停止voice，随后检查 `/proc` 的voice控制器/模型/TTS进程以及control socket
不可连接。旧进程未退出时拒绝替换，不用旧control.ready冒充新安装成功。

升级备份仅runtime、adapter、native worker、旧安装manifest和voice OpenRC脚本；上限
16MiB，路径 `/opt/dior-voice.previous`，只保留一份。Qwen、Piper和用户settings不复制。
替换/启动/readiness失败时恢复程序与旧服务/runlevel状态。首装失败保留已验证immutable
资产及marker以便resume，不删除用户state。

`.voice-stage`残留只允许清理指定managed目标对应的普通root-owned、nlink1、预算内
文件，且内容匹配批准SHA或批准内容的写入prefix。未知残留和未知backup文件保留并拒绝
继续；不按目录名盲目清理用户文件。rename后的文件及父目录均有fsync。

## 当前验证范围

修复版已在手机执行 `--repair-runtime` 并通过 readiness，独立账号与开机启动均已启用。
另完成语法及8组主机文件系统/模拟服务
契约：部分tmp恢复、未知tmp保留、程序备份、程序/服务恢复、模型/TTS不复制、未知backup
保留、已move首装resume，以及stop失败且旧PID仍在时阻止替换。
主机测试使用真实文件与SHA，但Linux ownership/fsync/OpenRC/readiness以fixture模拟，
其结果与实际手机升级记录分别保存，主机模拟不能替代Linux实测。

实际语音助手能力范围见上级README：专用KWS限定范围与数字注入联动已通过，不能把
软件安装或注入式检查当真人唤醒/双讲验收完成。
