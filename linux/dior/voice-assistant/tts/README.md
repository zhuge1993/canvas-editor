# Dior 离线中文语音合成

`offline_tts.py` 为语音助手提供离线 TTS，返回内存中的单声道 PCM16。手机的实际播放、音量控制、打断和回声消除由上层 `AudioDevice` 管理。合成器不打开 ALSA、不请求网络、不保存麦克风录音或持久的动态音频。共享推理服务默认通过 `create_persistent(max_cpus=2)` 工厂懒启动常驻 Piper，并在模型初始化后逐线程限制到最多两个继承允许的 CPU；构造、查询状态和固定缓存命中均不启动模型。原 `OfflineTTS` 类及 CLI 保留每次单独启动进程的路径，便于兼容和对照。

```python
from offline_tts import create_persistent

tts = create_persistent(base=private_tts_directory, engine="piper", max_cpus=2)
try:
    audio = tts.synthesize(text, cancel_event)
finally:
    tts.close()
```

下面是保留的单次进程接口：

```python
from offline_tts import OfflineTTS, TTSCancelled

tts = OfflineTTS(base=private_tts_directory, engine="piper")
audio = tts.synthesize(text, cancel_event)
# audio.pcm16: bytes
# audio.sample_rate: int
```

支持两种明确选择的引擎：

| 引擎 | 平台与音频 | 音质说明 |
| --- | --- | --- |
| `piper` | 固定官方 ARMv7l Piper 2023.11.14-2、ONNX Runtime 1.14.1、huayan x_low；16kHz | 本地 CPU 神经合成，官方质量等级为 x_low |
| `espeak` | Alpine ARMhf eSpeak-ng 1.52.0-r1，普通话 cmn；22.05kHz | 共振峰合成，机械音质的低资源兜底 |

两种路径都限制输入为 120 字符、实际音频最多 20 秒，生成时限默认 30 秒，一个实例同时仅执行一次合成。原 CLI/`OfflineTTS` 在动态合成后终止独立进程；Piper 工厂复用一个进程，取消或故障时回收该进程，下一次动态请求重新启动。超过时限或音频上限会明确失败，不静默截断。常驻路径使用一个已 unlink 的 tmpfs 临时 WAV inode，并在每次读取后清空，不累积命名文件；细节和计时边界见 [PERSISTENT.md](PERSISTENT.md)。

常用答复可以在安装时预生成。`build-fixed-cache.py` 只生成代码内固定白名单，当前为 11 句；手机已部署的合格缓存 PCM 总量是 **742144 字节**，总上限仍为 1MiB。固定答复包括“我在，请说。”、听不清/响应失败通知、改唤醒词的确认/取消和音量 0/50/100 等。生成资产只读；运行时读入有界 RAM，只对这些完全匹配的固定短句复用，不缓存动态问题、识别转写或 LLM 答案，也不会扩充磁盘缓存。

```text
python3 build-fixed-cache.py --base PRIVATE_ASSET_DIR --engine piper --timeout 60
```

默认输出为新的 `PRIVATE_ASSET_DIR/fixed-cache`。已有目录不会被自动删除或覆盖；需要重新生成时使用新的私有输出目录，核验后由安装程序替换。合成器自动加载有效 manifest 与逐文件校验和，坏缓存安全回到已选离线引擎。`cache_hit`、`worker_spawned` 与 `model_inference_this_call` 分开统计，缓存读取速度不能写成神经模型实时推理速度。

Linux 子进程在 exec 前设置 `PR_SET_PDEATHSIG(SIGTERM)`，随后核对父 PID，防止父进程提前退出造成遗漏。子进程禁止 core dump，地址空间上限为 1GiB，文件描述符上限为 64，并尊重继承的更低硬限制。预执行函数只进行这些内核操作；libc 的 prctl 在父进程预解析，不在多线程 fork 后加载库。父进程异常退出也会终止重模型子进程。Windows 主机的基础进程测试仍可运行，Linux 的父进程死亡测试在 Windows 明确跳过。

Piper 原版 ONNX Runtime 使用自动配置的原生线程池；`OMP_NUM_THREADS=2` 和仅在 exec 前设置 affinity 都不能保证其所有工作线程保持两核。共享服务指定 `max_cpus=2`：先继承选定 CPU，再在初始化 ACK 后、发送任何合成请求前逐线程设置和验证，每个请求重新核对，返回音频前也核对。检查最多 64 个线程、3 轮、0.5 秒，并受原取消和绝对时限约束；失败回收该 Piper 子进程且不返回音频。只限制自己的 Piper，父进程、LLM、ASR、内核和全局 CPU 策略不变。独立工厂调用的 `max_cpus=None` 保留原 CPU 集合；直接 runtime 分支和旧 CLI 不自动套用共享服务的两核配置。此路径使用 CPU，不声称使用 GPU。

两核约束的独占手机探针已通过，证据见 [LOCAL-OPT-AFFINITY-ENFORCED.json](../evidence/LOCAL-OPT-AFFINITY-ENFORCED.json)。140 个合成区间采样、560 条线程掩码均为 CPU 0–1，最高温度 57°C。短句冷启动耗时 **4.632 秒**，生成 1.272 秒音频；同一进程的较长句耗时 **5.829 秒**，生成 2.888 秒音频。早期未逐线程约束的暖短句约 1 秒只能作为历史原型数据，不能代表当前两核配置。该约束降低了这次探针的温升，代价是合成更慢；两句数据不构成长期热稳定或任意文本延迟保证。

全部版本、发布来源、字节数与 SHA-256 固定在 `DEPENDENCIES.json`。huayan 官方 MODEL_CARD 将 **Dataset License 标为 Unknown**；这不是已经核实的声线权重公开再分发授权。模型只放在用户私有目录，保留官方模型卡。eSpeak-ng 为 GPL-3.0-or-later；Ubuntu 私有 libc/GCC 库保留其各自上游许可与来源。

准备资产时使用 Git checkout 以外的目录，脚本会拒绝把模型或二进制输出到源码仓库内部：

```text
python fetch-assets.py --output-dir PRIVATE_ASSET_DIR --include all
python prepare-piper.py --output-dir PRIVATE_ASSET_DIR
python prepare-private-libs.py --output-dir PRIVATE_ASSET_DIR --readelf ARM_READELF_EXECUTABLE
```

`fetch-assets.py` 只访问锁定的官方 HTTPS URL，并核对每个文件的字节数和 SHA-256。curl 回退仍验证 TLS，不关闭证书验证。两个 prepare 脚本仅在私有目录展开资产和核查 ELF，不安装系统软件包、不更换 `/usr/lib`、Bionic SDK、GPU 驱动或内核。Alpine APK 可在手机用 `apk verify` 对原包验签，无需系统安装。

Piper 使用私有 glibc2.31 loader 与 library-path。其库最高要求 GLIBC2.29 和 GLIBCXX3.4.26；准备的 glibc ELF 声明最低 Linux ABI3.2.0、ARMv7 hardfloat。Piper 的 eSpeak 数据路径显式指定，避免通过私有 loader 运行时 `/proc/self/exe` 指向 loader 导致默认路径错误。ELF 边界检查不能代替 Linux3.4 手机上的实际模型运行。

```text
python3 offline_tts.py --base PRIVATE_ASSET_DIR --engine piper --timeout 60 --raw-stdout --report REPORT_JSON
python3 offline_tts.py --base PRIVATE_ASSET_DIR --engine espeak --raw-stdout --report REPORT_JSON
```

文本从 UTF-8 stdin 输入，原始 PCM 从 stdout 输出，统计信息写 stderr；指定 report 时仅写统计 JSON。由调用者将 PCM 交给真实播放器并核验发声。

```text
python test-tts-lifetime.py
python test-parent-death.py
python test-fixed-cache.py
python test-persistent-tts.py
```

`test-tts-lifetime.py` 以实际辅助进程测试取消、输出上限、时限和内存 WAV 解码；`test-parent-death.py` 在原生 Linux 核查子进程实际限制、确认其正在运行，再 SIGKILL 父进程，检查子进程结束。测试不使用真实录音，也不把辅助进程的结果称为手机 TTS 或声学播放通过。

固定缓存合同另覆盖：命中不启模型、不写运行文件；取消丢弃；非白名单和超出 1MiB 的数据拒绝；坏 PCM 校验和与错误 manifest 安全处理。测试使用明确的合成夹具，不把夹具当成真实 TTS 成功。

常驻基础组合已完成真实手机安装和自动联测；新增两核约束已通过独占 TTS 候选探针。共享服务采用上述两核参数，其最终网页和 ASR→实际播放联测由主任务另行执行、记录，不能由此探针代替。探针没有播放、录音或保存 PCM，不代表真人麦克风、扬声器听感或长期运行验收，也不承诺任意句子秒回复。
