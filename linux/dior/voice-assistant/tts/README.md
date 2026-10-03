# Dior 离线中文语音合成

`offline_tts.py` 为语音助手提供离线 TTS，返回内存中的单声道 PCM16。手机的实际播放、音量控制、打断和回声消除由上层 `AudioDevice` 管理。运行中的合成器不打开 ALSA、不请求网络、不保存动态音频文件。

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

每次合成使用独立进程，输入限制为 120 字符，实际音频最多 20 秒，生成时限默认 30 秒。普通回答控制在约 70 个汉字以内更稳。超过时限或音频上限会明确失败，不静默截断。取消会停止当前工作进程并丢弃过时音频；一个实例同时仅执行一次合成。

常用答复可以在安装时预生成。`build-fixed-cache.py` 只生成代码内固定白名单的最多十句话，PCM 总量上限为 1MiB，超出预算的低优先项会明确列为跳过。固定答复包括“我在，请说。”、改唤醒词的确认/取消和音量 0/50/100 等。生成资产只读；运行时读入有界 RAM，只对这些完全匹配的固定短句复用，不缓存动态问题、识别转写或 LLM 答案，也不会扩充磁盘缓存。

```text
python3 build-fixed-cache.py --base PRIVATE_ASSET_DIR --engine piper --timeout 60
```

默认输出为新的 `PRIVATE_ASSET_DIR/fixed-cache`。已有目录不会被自动删除或覆盖；需要重新生成时使用新的私有输出目录，核验后由安装程序替换。合成器自动加载有效 manifest 与逐文件校验和，坏缓存安全回到已选离线引擎。`cache_hit`、`worker_spawned` 与 `model_inference_this_call` 分开统计，缓存读取速度不能写成神经模型实时推理速度。

Linux 子进程在 exec 前设置 `PR_SET_PDEATHSIG(SIGTERM)`，随后核对父 PID，防止父进程提前退出造成遗漏。子进程禁止 core dump，地址空间上限为 1GiB，文件描述符上限为 64，并尊重继承的更低硬限制。预执行函数只进行这些内核操作；libc 的 prctl 在父进程预解析，不在多线程 fork 后加载库。父进程异常退出也会终止重模型子进程。Windows 主机的基础进程测试仍可运行，Linux 的父进程死亡测试在 Windows 明确跳过。

Piper 原版 ONNX Runtime 使用自动配置的原生线程池。`OMP_NUM_THREADS=2` 不保证该线程池只有两个线程，上层必须按实际 CPU、RSS 和温度执行资源策略。此路径没有声称使用 GPU。

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
```

`test-tts-lifetime.py` 以实际辅助进程测试取消、输出上限、时限和内存 WAV 解码；`test-parent-death.py` 在原生 Linux 核查子进程实际限制、确认其正在运行，再 SIGKILL 父进程，检查子进程结束。测试不使用真实录音，也不把辅助进程的结果称为手机 TTS 或声学播放通过。

固定缓存合同另覆盖：命中不启模型、不写运行文件；取消丢弃；非白名单和超出 1MiB 的数据拒绝；坏 PCM 校验和与错误 manifest 安全处理。测试使用明确的合成夹具，不把夹具当成真实 TTS 成功。
