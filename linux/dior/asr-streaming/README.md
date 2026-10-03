# Dior Linux 流式离线语音识别

已在 Xiaomi Redmi Note 4G（dior，ARMv7 Cortex-A7）上安装并实际调用。
默认模型已由 Whisper tiny-q5 换为 **small 双语 Zipformer chunk32**，
引擎为固定版本 sherpa-ncnn v2.1.15，使用 **CPU NEON + OpenMP、4线程、greedy**。
**这不是 GPU ASR**：新识别路径不调用 OpenCL、GLES 或 Vulkan，也没有改动GPU SDK。

## 已测结果及范围

相同的4段公开中文 WAV，共55个参考字符，错误2字，3/4句逐字一致，严格字符
错误率2/55（约3.64%）。两条新闻和“几点了”正确；“达摩院”仍被识别为“打磨院”。
中英混合语音表现较弱，未将它剔除后宣称模型全面准确。未注入热词或参考文本。

真实手机服务按实际音频时间喂入 WAV，并追加按真实时间送入的静音，使用实际
`IsEndpoint` 完成。四句最终文本相对音频结束时间线的延迟分别约
**0.448、0.437、0.883、0.879秒**。这些是常驻模型后的流式录音模拟结果，
不是一整段录音在1秒内从零完成推理，也不是实际麦克风端到端测试。

未人工标注真实音素停说边界，因此时延以音频文件结束时间线为参照。
同一原生worker只加载模型一次，13项服务控制检查、4段语音和80次ping会话检查通过；
RSS稳定在约85.4MiB，没有随本轮会话数增加。20.037秒空闲观察中worker CPU ticks
增长为0。没有进行数日/数周压力运行，4个公开样本也不是代表性中文准确率基准；
它们是否进入过模型训练集未知。

已验证安装的37个文件哈希和权限、0750父目录/0660 socket、dior和flowboard的新建su客户端会话、
无授权账号拒绝、服务账号无额外组，以及只重启ASR后的旧worker回收。网站和穿透
进程未被这次ASR重启替换，既有5个画布分享仍返回200，内核tainted为0。
OpenRC已启用默认启动；本次未为验证而重启整台手机。

公开验收记录由维护者保存于 [evidence/phone-result.json](evidence/phone-result.json)、
[服务协议与语音记录](evidence/ASR-NEXT-SERVICE-INTEGRATION.json)、
[权限及ASR独立重启审计](evidence/ASR-NEXT-SERVICE-AUDIT.json)、
[4段中文服务准确率](evidence/ASR-NEXT-SERVICE-ACCURACY.json) 和
[包含中英混合的完整模型比较](evidence/ASR-NEXT-ACCURACY.json)。

## 本机调用

```sh
rc-service --nodeps dior-asr status
python3 /opt/dior-asr/asr-client.py --ready
python3 /opt/dior-asr/asr-client.py /path/to/pcm16-mono-16k.wav
```

服务只监听 `/run/dior-asr/recognize.sock`，没有公开TCP端口，没有自动录麦克风，
不会把音频和转写保存到服务端文件。使用者需要属于专用 `dior-asr` 组。
已有进程要在下次正常启动后才继承新组；ASR安装不为此重启网站。

默认CLI按200ms真实时间送块，等待端点，最多27秒WAV，为最多3秒静音尾留预算。
30秒以内的文件也可以显式EOF，但该模式不会声称真实停说端点时延：

```sh
python3 /opt/dior-asr/asr-client.py /path/to/input.wav --finish-mode eos
```

本地服务API、连接/音频/队列/温度/内存边界见
[runtime/README-runtime.md](runtime/README-runtime.md)。服务账号不属于wheel/audio/video；
每次客户端完成或断开后释放该段特征状态，模型继续驻留。

## 固定来源与构建

[model-sources.json](model-sources.json) 固定作者revision、官方下载归档SHA和七个模型
文件SHA；[provenance.json](provenance.json) 固定引擎/依赖/编译器与已测构建SHA。
真实源码commit为 `c794e1439fce79932e989220aa1c2848ecbdcdcf`。上游getter的
`d4bb5a78` 对应发布commit的父commit，来自上游发布脚本生成字符串，并非用了另一份
引擎源码。[上游版本文件](https://github.com/k2-fsa/sherpa-ncnn/blob/c794e1439fce79932e989220aa1c2848ecbdcdcf/sherpa-ncnn/csrc/version.cc)

构建和下载路径由参数或环境变量选择，见 [BUILDING.md](BUILDING.md)。NDK r17c
Clang6.0.2/GCC4.9链接，C++14库代码、静态libc++/OpenMP、私有Bionic解释器。
APK AssetManager路径在独立编译副本禁用；fbank dither为0，局部API19 rand_r兼容
不参与该识别特征。安装和打包见 [runtime/README-install.md](runtime/README-install.md)。

此目录只保存源码、许可证、参考文本、来源和哈希，**不包含模型权重、录音、二进制、
SDK或已下载的构建依赖**。重新编译的字节SHA可能因路径/工具输出变化，应保留新构建
清单并重新做设备gate，不冒用原来已测的worker SHA。固定安装入口默认仅接受已资格
验证的worker，防止无声替换。

## 复现公开比较

输入从官方公开URL按固定SHA下载到仓库外的缓存；`zh-short`是已记录的无损帧裁剪，
不合成、不重采样、不增益，不使用云端识别：

```sh
python3 eval/prepare-inputs.py --output /path/to/public-cache --with-opencc
python3 eval/score_asr.py --opencc-dir /path/to/public-cache/opencc \
  --hypotheses /path/to/results.json --report /path/to/accuracy.json
python3 tests/test-broker-contract.py
```

主机contract测试使用真实socket stream与假native backend，只验证控制协议和隔离。
安装后的实际CPU测试与只重启ASR审计分别可运行：

```sh
python3 tests/test-installed-service.py --wav-root /path/to/public-cache/audio
# 此审计需root读取安装权限；会只重启dior-asr，保留网站/穿透进程。
python3 tests/audit-installed-service.py
```

评分保留原始文本，同时报告严格CER和独立简繁规范CER。简繁规范不修复同音字、
机构名、数字或语气词错误；中英混合样本单列，重复音频不算新增独立准确率样本。
