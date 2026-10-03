# Dior 中文动态唤醒词检测

本模块使用 sherpa-onnx **v1.10.29** 官方 ARMv7 GNU hard-float 预编译库与
WenetSpeech **3.3M** 中文 KWS 模型。运行在独立小型 C worker 进程中，musl
Python 只通过有界 JSONL 管道交互，不把 GNU/ORT 库加载进 Python。

普通话唤醒词使用完整 ppinyin token 序列，例如：

```text
èr g ǒu :1.5 #0.35 @二狗
x iǎo zh ū g ē :1.5 #0.35 @小猪哥
```

默认 score **1.5**、threshold **0.35**、CPU **2 线程**。单字“二”不是别名，
不把通用 ASR 的误字或半个名字扩展成唤醒。可配置名称为2至8个模型词表支持的
中文字符；同音字在纯语音中无法可靠区分。模型的自定义词接口与声学触发概率
权衡见 [官方 KWS 文档](https://k2-fsa.github.io/sherpa/onnx/kws/index.html)。

## 已验证范围

本机自动验收实际运行了 GNU loader、配对 ORT 和常驻 C API worker，模型只
加载一次。相同默认 profile 下，已正确长句生成音频的0.45、0.55、0.65、0.75秒
前缀加1.5秒实时静音尾均检测到完整“二狗”，命中墙钟约0.945至0.957秒；“二”
负例不命中。改名后，改名前已命中的同一长句旧名音频原生结果为空，新名称
“小猪哥”生成音频约1.286秒命中。该配对控制验证了真正的动态替换。

**独立 Piper 0.904秒“二狗”短片未命中**，标点变化及较低声学门槛未解决；
eSpeak 短片也未命中。长句派生前缀没有人工标注精确词末，可能含有后续语音的
一部分。它们是生成音源与派生输入控制，不能写成真实人声、口音、噪声或长期
误触率验证，也不能因此断言真实人声的短“二狗”不受支持。

`QUALIFICATION-SCOPE.json` 保留这些正负结果及限制。软件建造时的
`phone_verified:false` 指构建脚本本身不操作手机；实际设备验收由外部完整
验收记录提供。模型、库、词典、WAV、下载缓存和构建二进制均不保存在 Git。

## 依赖与构建

`SOURCE-PINS.json` 固定官方维护者 HF 分发 revision、完整包 SHA256、四个模型
文件的作者 revision/SHA256、pypinyin wheel 和 C/header 源码。
[官方 ARM32 部署文档](https://k2-fsa.github.io/sherpa/onnx/install/arm-embedded-linux.html)
列出了该维护者预编译分发。ARMv7 hard-float runtime 最高需要 GLIBC2.29；
本机复用已经验证的私有 GNU libc2.31/GCC10 目录，不替换系统 musl、Bionic、
内核或 Piper 配对 ORT1.14。KWS 使用自己的配对 `libonnxruntime.so`。

小 worker 使用 NDK17c Clang6 和 GCC4.9 binutils 编译，但 **GNU crt1/crti/crtn**
启动，不调用 Android `__libc_init`，也不重编 sherpa/ORT 大库：

```sh
python3 native/prepare-gnu.py --output EXTERNAL_GNU_STAGE
python3 native/build.py \
  --clang CLANG_EXE --binutils NDK_BINUTILS \
  --gnu-dev EXTERNAL_GNU_STAGE/gnu-dev \
  --private-libs PRIVATE_GLIBC_LIB --sherpa-libs SHERPA_RUNTIME_LIB \
  --output EXTERNAL_BUILD/kws-worker
python3 prepare-runtime.py --worker EXTERNAL_BUILD/kws-worker \
  --output EXTERNAL_KWS_PAYLOAD
```

首次 build 前应将 pins 对应的官方 runtime 解包到外部目录供链接，不能用
其他来源或不同版本的库替代。`prepare-runtime.py` 只下载/校验/阶段准备，不
安装手机或系统，也不创建服务。若通过 importlib 加载 `kws_adapter.py`，
factory 应将受信任的 payload 目录加入 Python path，使同目录的
`compile_keywords.py` 可用；词典由 converter 从 payload 的 pypinyin-vendor 读取。

## 运行接口与边界

`LocalKeywordSpotter(base,tts_base,keyword,threads=2)` 提供：

- `validate_keyword(word)`：编译完整 ppinyin，拒绝单字和不支持的词表。
- `feed(pcm16)`：恰好640 bytes，16kHz mono PCM16LE，20ms一帧。
- `set_keyword(word)`：RPC 成功后才更新当前名称；核心应在此后持久化。
- `reset()`、`ping()`、`status()`、`close()`。

每次动态修改、命中或30秒预算只重建 stream，不重新加载模型。v1.10.29 的
动态 stream 会追加 spotter 默认关键词，因此默认图使用不可到达的内部 blank
seed，真实名字全部注入当前 stream，避免旧词持续有效。内部 label 或非当前
名称不会唤醒；原始 `native_raw_keyword` 仍保留，避免负例证据被过滤隐藏。

输入每行16KiB；native有词表/有限数值/标签校验。Python响应队列最多8条，
stderr只保留16KiB，VM384MiB、FD64、core0；模型和配对库检查固定 hash 与
root所有权。父进程退出信号覆盖冷加载；外部 RPC 截止5秒，失败只清理自己的
子进程。C API 没有计算中断 callback，native的10秒检查发生在 decode 调用间。

`feed()` 应在有界识别消费者线程执行，不能直接阻塞 PCM I/O callback。
KWS末 token 的 timestamp 是 onset，不等于精确词末；同句命令应保留有限音频
preroll交给 ASR，并在可信声学唤醒上下文中处理，不能猜测或重写唤醒误字。

## 验收工具

```sh
python3 native/test-contract.py --tokens EXTERNAL_MODEL/tokens.txt \
  --output EXTERNAL_HOST_TEST
python3 run-native-benchmark.py --base EXTERNAL_KWS_PAYLOAD \
  --tts-base EXISTING_TTS_BASE --cases CASES_JSON \
  --threads 2 --tail-seconds 1.5 --report WRITABLE_RESULTS/kws.json
```

Host contract 使用真实 worker 源码与 fake C API，只检查协议/边界/释放，
不证明声学质量。真实 benchmark 一次加载模型，20ms输入按音频实际可用时间
送入，再送实时静音尾；没有用显式文件 EOF 冒充唤醒。cases 逐项指定
`name/keyword/wav/expect_hit`，应包含完整正例、单字/近音负例，以及同一已命中
旧名音频在改名后的负例。WAV CLI 仅适合 loader/model smoke，不能代替持续
PCM 流中的短词验收。
