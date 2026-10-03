# Dior Qwen OpenCL 算子实测

这三种已测候选都能用 Adreno 305 算出真实 Qwen 权重矩阵的正确结果，但没有超过
现有 GGML CPU 基线。生产语音模型继续使用 CPU；本目录没有整模型 GPU 资格。
这项结论只覆盖下面的算子、形状与实现，不能推广为硬件永远无法加速。

## 实际范围与结果

从固定的 Qwen2.5-0.5B-Instruct Q4_0 GGUF 提取
`blk.0.attn_q.weight`，GGML shape `[896,896]`、type 2。
每个候选仅测 batch 1 和 batch 32，各有三个 GPU round。输入是合成的精确二进制
分数，不是捕获的真实模型激活。没有生成 token、执行整模型或改变生产模型后端。

| 候选与源码 | batch | CPU 暖图计算 ms | GPU 暖流水 ms | GPU/CPU 墙时比 | GPU 冷流程 ms |
|---|---:|---:|---:|---:|---:|
| [FP32 buffer](buffer-fp32.cpp) | 1 | 0.702 | 14.001 | 19.9× | 105.985 |
| FP32 buffer | 32 | 17.972 | 422.338 | 23.5× | 505.040 |
| [Q4 packed + 协作归约 / local tile](packed-q4.cpp) | 1 | 0.699 | 18.066 | 25.9× | 217.818 |
| Q4 packed + 协作归约 / local tile | 32 | 17.810 | 255.638 | 14.4× | 392.188 |
| [RGBA float4 image2d](image-float4.cpp) | 1 | 0.711 | 4.093 | 5.8× | 163.590 |
| RGBA float4 image2d | 32 | 17.791 | 55.670 | 3.1× | 140.191 |

CPU 数值为同一 case 第二次 GGML 图计算，2 threads。
GPU 暖值是 round 2、3 的输入上传、dispatch、回读墙时平均值。
冷值包含 GPU 初始化、编译、权重上传及首轮流水，**不包含前面的 host Q4 处理**。
kernel profiling 时间和各阶段原值保留在报告中，不能只拿 kernel 时间与 CPU 墙时相比。
这是有限的两次暖重复，没有运行调参矩阵或长期性能统计。

- GPU 与独立 PC binary64 累加参考相比，batch 1 最大误差为 0，batch 32 最大绝对
  误差为 `1.1920928955078125e-7`，全部输出元素通过比较。
- CPU 使用既有 b3927 的 Q4_0 × F32 MUL_MAT，其内部使用 Q8 激活点积。
  GPU 使用原 F32 激活，因此两条数学路径不同；CPU 与参考的量化差异另外记录，
  不冒充逐 bit 相同，也没有验证这些差异在整模型中的语义影响。
- packed 候选仅把每块 half scale 转为 float，保留四位数值；GPU 权重缓冲为
  501,760 B。其余两个候选的 FP32 权重为 3,211,264 B。
- 真机报告确认 OpenCL C 1.1 Adreno 305、8 KiB local memory、device 最大 workgroup
  256、相关 kernel 最大 workgroup 128。image 候选确认 READ_ONLY image2d 的
  `CL_RGBA + CL_FLOAT`、最大 `4096×4096`、12 个 read image 参数，prefill 选择 `16×8`。
- 三次报告的 kernel taint 均为 0，ASR、网站、隧道保护指纹均未变化。
  各 case 观察到的 child RSS 约 11–17 MiB、最高温度 48–50°C。

原始报告按字节保留：
[buffer](GPU-QWEN-OPERATOR.json)、[packed](GPU-QWEN-OPT1.json)、
[image](GPU-QWEN-OPT2.json)。它们的 `PASS_OPERATOR_SCOPE_ONLY` 只表示算子正确，
不表示 GPU 比 CPU 快、整模型已 offload 或语音模型获得加速。
[MANIFEST.json](MANIFEST.json) 固定来源、原源码 SHA、报告 SHA、已测 native SHA 和计时定义。

## 复现依赖

三个 C++ 文件与实际已测私有候选完全相同。本次发布没有重新构建或重新测试。
仓库没有包含 GGUF、`weights.q4`、`inputs.f32`、`reference.f32`、二进制、静态库、
NDK、厂商驱动或凭据。所有生成物应放在仓库外的私有工作目录。

构建需使用以下外部输入，并记录本次实际输入和输出哈希：

1. [llama.cpp b3927](https://github.com/ggml-org/llama.cpp/tree/10433e8b457c4cfd759cbb41fc55fc398db4a5da)
   的 CPU `libggml.a` 与相同 headers。已测 archive SHA 为
   `d551d365e90639487b82de56fe0b5594310d01a2ae9d3f9e7945176066818a8d`；
   来源文件锁为 [../llm/SOURCE.json](../llm/SOURCE.json)。
2. Android NDK r17c Clang 6.0.2、GCC 4.9 linker、API19 ARMv7 softfp NEON；
   静态 libc++、libc++abi、android_support、unwind、libatomic，及
   [API19 兼容头](../llm/api19-compat.h)。此处不更换内核或 GPU SDK。
3. [Khronos OpenCL-Headers](https://github.com/KhronosGroup/OpenCL-Headers/tree/4fdcfb0ae675f2f63a9add9552e0af62c2b4ed30)，
   `CL_TARGET_OPENCL_VERSION=110`；[nlohmann/json v3.12.0](https://github.com/nlohmann/json/tree/v3.12.0)
   的单头文件，精确 SHA 见 manifest。

Clang 参数为 `-target armv7-none-linux-androideabi19 -std=c++14 -O3 -DNDEBUG
-D__ANDROID_API__=19 -D_GNU_SOURCE -D_XOPEN_SOURCE=600 -march=armv7-a
-mfloat-abi=softfp -mfpu=neon-vfpv4 -fPIC`，并使用 API19 platform sysroot、统一
NDK headers、android_support、静态 C++ headers、GGML／CL／JSON include 目录，
以及 `-include api19-compat.h`。路径需由构建者明确提供，不使用本机绝对路径。

GCC 4.9 链接上述 object、`libggml.a` 和静态依赖，使用 `--start-group/--end-group`、
`-pie -Wl,--hash-style=sysv -Wl,--dynamic-linker,/opt/dior-android/system/bin/linker
-lm -ldl`。不链接 OpenCL stub 或 ICD；运行时由 `dlopen` 加载原厂私有库。
检查 ELF32 ARM、解释器及 DT_NEEDED，重新构建的 SHA 可能变化，须独立资格验证，
不能沿用 manifest 中历史 binary 的资格。

## 私有 fixture 与执行边界

使用 manifest 固定 SHA 的官方 GGUF。此文件中矩阵的绝对起点为 **235,048,288**，
连续读取 **451,584 B**。该固定偏移仅适用于该精确 GGUF，不能用于其它转换或量化。

Q4_0 每块表示 32 个数：little-endian half scale 2 B，随后 16 B packed nibbles。
低四位减 8 得到前 16 项，高四位减 8 得到后 16 项，各乘 scale。
矩阵以 `weight[row*896+k]` 排列。fixture 格式为：

- `weights.q4`：上述原始 Q4_0 字节。
- `inputs.f32`：32×896 个 little-endian float，按 token 连续；
  `input[token,k] = ((k*37 + token*13) % 31 - 15) / 32.0`。
- `reference.f32`：32×896 个 little-endian float；独立 host 用 binary64 累加
  `sum_k(dequant_weight[row,k] * input[token,k])`，最后转 F32。

native 参数为私有 fixture 目录与 batch（只允许 1 或 32）。每次读取整份 fixture，
batch 1 只取第一条输入与第一条参考；两 case 可直接比较。

必须在操作者安排的独占维护窗口执行，与真人对话、网站模型请求分开；
本测试的实际 supervisor 检查 voice／inference UID 107／108 已停止，
ASR、网站、隧道只读保护。native 有 10 秒 alarm 与显式缓冲 64 MiB 限制；
外部 supervisor 还须执行 child RSS 128 MiB、每 case 10 秒、65°C 截止、有限输出和
进程组回收，并记录前后 taint／保护指纹。不得把未加这些边界的直接启动当作同一验收。

运行使用 `/opt/dior-android/run-native.py` 的
`runtime_environment('opencl', [])` 提供已验证的私有库搜索路径和只读 property FD，
在新进程中以普通 dior（UID 10000）启动已 SHA 校验的候选，继承该 FD。
只使用返回的 `LD_LIBRARY_PATH`／`ANDROID_PROPERTY_WORKSPACE` 与最小环境；
musl 进程不直接混载 Bionic 厂商库。标准 launcher 的 CLI 只允许其既有 probes，
不能把候选冒充或覆盖那些已资格程序。

整模型 GPU 接线、数日稳定性、真实模型激活分布、其它层／形状／量化和未来更好的
kernel 均不在本轮资格范围内。当前没有据此将生产模型改为 GPU。
