# Dior 本地离线语音识别服务

采用已固定文件哈希的 bilingual Zipformer **chunk32** 模型和 sherpa-ncnn
v2.1.15 CPU ARMv7 NEON/OpenMP worker。默认 greedy search、4 线程、0.4 秒
端点静音规则。模型只加载一次，串行服务本机客户端；没有 TCP 监听、麦克风采集、
音频存储或服务端转写日志。

## 启动后使用

```sh
rc-service --nodeps dior-asr status
python3 /opt/dior-asr/asr-client.py --ready
python3 /opt/dior-asr/asr-client.py /path/to/pcm16-mono-16k.wav
```

客户端默认按音频实际可用时间，每 200ms 送一块，之后继续按真实时间送静音，
最多 3 秒等待实际端点。需要 16kHz、单声道、16 位 PCM WAV，端点模式最多
27 秒，为静音尾部保留预算。30 秒以内的文件也可显式结束：

```sh
python3 /opt/dior-asr/asr-client.py /path/to/input.wav --finish-mode eos
```

`eos` 是已知文件结束后的 flush，结果不能当作真实停说端点延迟。JSON 输出保留
原文、首个文本、最后真实块送入和返回时间、相对音频时间线的最终文本延迟、
常驻 worker PID、模型加载次数和峰值 RSS。`--events` 可把每块 partial/final
打印到客户端 stdout。服务不写这些内容。公开 WAV 测试属于录音文件流式模拟，
不是麦克风端到端验证。

## 本地协议

Socket：`/run/dior-asr/recognize.sock`，类型 AF_UNIX/SOCK_STREAM，权限0660，
专用 `dior-asr` 组。父目录0750，客户端组不能删除或替换 socket。

每条消息是一个 UTF-8 JSON 对象加换行。连接后依次读取 `queued` 和
`ready_session`，只有获得 `ready_session` 才开始发送音频：

```json
{"op":"feed","id":"chunk1","pcm16_base64":"AAAAAA=="}
{"op":"ping","id":"health1"}
{"op":"finish","id":"end1"}
```

`pcm16_base64` 必须是规范 Base64 的 PCM16LE mono16k，每块最多16000样本，
即1秒。输出 `partial` 或 `final`，回传相同 id；端点 final 的 reason 是
`endpoint`，显式 finish 是 `explicit_eos`。自然端点后可继续本连接的新段，
所有样本合计仍受30秒预算约束。显式 finish 返回后释放连接/序列锁。
`reset` 只清当前客户端的音频状态，不增加该连接的总音频预算。禁止客户端
`quit`、换模型、提供热词或改变全局 worker 设置。

## 长期运行边界

- 最多8个活动/等待连接，1个处理中的会话，FIFO等待最多90秒。
- 一条 JSON 最多64KiB、深度8；id最多64字节；每会话音频总量最多30秒。
- 获得处理权后20秒无完整输入超时，单会话 wall 上限60秒。
- 客户端断开、坏帧、超时后重建 native Stream，下一客户端不继承上一段音频。
- 每块处理前后读取原内核热区；温度超过65°C返回 `thermal_pause` 并丢弃本段，
  模型保持加载但不继续推理。没有修改温控、CPU在线设置、频率或内核保护。
- `OMP_WAIT_POLICY=PASSIVE`、`KMP_BLOCKTIME=0`、`OMP_THREAD_LIMIT=4`。
- native stdout 是最多4条响应的有界队列；stderr只保留16KiB内存环及计数。
- 无无限累计的转写、录音、native stdout、stderr或永久CPU总时限。
- native worker VM上限768MiB，FD上限64，不生成core；意外失败时清理旧进程并
  受5秒退避限制重载同一只读模型，重载次数由 readiness 如实展示。

服务账户 `dior-asr` 不属于 wheel/audio/video。既有 dior、flowboard 只加入
`dior-asr` 组，已有进程的组权限要等其下一次正常启动才生效；安装服务不会重启
网站、穿透或系统。SDK仅复用既有 `/opt/dior-android` 的只读 property FD和库。

## 源码和验证范围

实际 source commit 为 `c794e1439fce79932e989220aa1c2848ecbdcdcf`；上游
getter 返回的 `d4bb5a78` 是发布提交的父提交，属于 release 脚本生成字符串，
不是构建源码不一致。服务启动核对7个模型文件和 worker SHA256。

`source/` 包含 runner、worker、broker、客户端、独立兼容补丁、构建脚本和
固定来源/哈希资料。NDK r17c Clang6.0.2编译，GCC4.9链接，静态libc++、OpenMP。
APK AssetManager路径禁用；普通文件推理不变；fbank dither=0。

```sh
python3 source/test-broker-contract.py
```

这9组主机测试使用真实 socket stream 和假 native backend，只验证broker
协议、串行/断开隔离、边界、闲置超时及热暂停控制。它们不替代真机模型准确率、
SDK/native运行、Linux socket权限或OpenRC验证。实测结果由设备验收报告提供。
