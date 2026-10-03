# Qwen3.5 ARMv7 评估候选（未切为默认）

2026-10-03 状态：Qwen3.5-0.8B 已在 dior 真机运行，但本轮两种量化配置
没有稳定通过三轮称呼语义测试，**不替换生产主脑**。手机仍保留原 Qwen2.5-0.5B。
生成非空文字、接口返回成功、编译通过均不代表对话质量通过。
本目录没有模型权重、可执行文件、录音或用户聊天记录。

## 接入方式

参考 [Home Assistant 的 Conversation/ChatLog](https://developers.home-assistant.io/docs/core/entity/conversation/)
和 [Pipecat 的上下文管理](https://docs.pipecat.ai/pipecat/learn/context-management)，
语音控制器统一管理角色消息与 turn ticket。模型收到当前助手身份、用户消息及
已实际播放的回答；生成完成只是候选，播放失败或打断不会提交虚假的助手历史。
ACK、等待提示和失败提示不当作聊天回答。

实现位于 `../runtime/conversation.py`、`../runtime/assistant.py` 与 `../bridge/`。
已有固定技能继续由真实执行器处理。工具 schema/真实结果接口已经有契约测试，
本候选 native 仍只接受 system/user/assistant；不能宣称自由工具调用已接通。
`../evidence/CONVERSATION-HOST.json` 记录 134 项 Python 与 13 项 HTTP 回归，
其中推理/音频使用明确的 fake，不代表手机声学或模型质量验收。

## 固定来源

| 项目 | 版本与完整性 |
| --- | --- |
| 官方基础模型 | [Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B/tree/2fc06364715b967f1860aea9cf38778875588b17)，此档型号为 0.8B |
| 推理引擎 | [llama.cpp b11371](https://github.com/ggml-org/llama.cpp/tree/99b95488cac0f00ce3f05af113a8c1e287753f87)，`99b95488cac0f00ce3f05af113a8c1e287753f87` |
| 官方引擎源码归档 | 37816065 B，SHA256 `255b78039d32724d1b5ed3ba87dce1b8f7bd1e3f18a8361f4b9ea7365fec5c8b` |
| ggml-org Q4_0 | [版本 8fea6208](https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/tree/8fea620810c4afa23dd6443f999a48574c1611a3)，563036064 B，SHA256 `57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf` |
| Unsloth UD-Q4_K_XL | [版本 6ab46149](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/tree/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0)，558772480 B，SHA256 `3177ebd67afe4438374da19e690bc1b98756f7e0fea9240e1be404336156a7b5` |
| filesystem backport | [gulrak/filesystem](https://github.com/gulrak/filesystem/tree/8a2edd6d92ed820521d42c94d179462bf06b5ed3)，MIT，完整 header SHA256 `522791c2a2f1959193fdff61f4668c5ba894459753170b2246971272ee8ddc47` |

两份量化均指向同一 Qwen 基础模型；Unsloth 是量化发布者，不是 Qwen 官方权重发布者。
Qwen 官方 0.8B 默认非 thinking。本候选使用固定官方 tokenizer 的非 thinking 模板，
不沿用 Qwen2.5 的旧前缀。普通角色模板已由实际 C++ 函数与官方 Jinja 渲染比较。

## 实测与边界

`evidence/QWEN35-PHONE-*.json` 是手机 CPU ARMv7/NEON 实测，GPU 使用标志始终 false。
Q4_0 三线程身份回答约 20.0 秒，但下一轮触发 66°C 保护并恢复旧服务。
两线程系统缓存对照：冷身份回答 25.7 秒、暖缓存 9.6 秒；对应暖缓存峰值 56°C。
完整状态 checkpoint 的 248320 个 logits 与无缓存参考逐位一致，恢复约 15 毫秒。
短提示和 74-token 长提示均做过对照；诊断降温/重算耗时没有算成加速结果。

仅生成层通过的记录明确命名 `PASS_GENERATION_ONLY`。这不是语义通过：
真实三轮用户问题依次为“你叫什么名字？”、“请叫我小林。”、“我叫什么名字？”，
每组历史使用该模型自己上一轮的回复。独立 Windows x64、全新进程/上下文结果为：

| 权重与 system | 本组正确回答数 | 主要失败 |
| --- | ---: | --- |
| Qwen3.5 Q4_0，长 / 短 | 1/3，1/3 | 重复自身名字或把用户称呼当作自己改名 |
| Qwen3.5 UD-Q4_K_XL，长 / 短 | 2/3，1/3 | 最后一轮仍混淆用户与助手 |
| 原 Qwen2.5 Q4_0，长 / 短 | 3/3，2/3 | 完整上下文有改善，但并非稳定通用对话保证 |

准确 system、全部原话和逐项判断在 `evidence/SEMANTIC-SUMMARY.json`。
这些是有限测试句组，不能当作通用准确率或整个 Qwen3.5 系列的结论。
两种采样 seed、贪心/官方推荐采样、每 chunk 输出 logits 和一次完整 prefill 都有对照。
没有证据支持 ARM 独有错误或本轮 checkpoint 是重复回答的原因；尚未声称已经排除
所有上游引擎、量化或模型能力因素。PC 耗时不代表手机性能。

`QWEN35-PHONE-SAMPLING-DIAG.json` 保留一次真实测试编排失败：长提示 logits 对照通过，
下一请求把不适用于普通生成的诊断参数带了进去，被 `generation_limit` 拒绝。
该失败没有被计为语义通过，旧服务已恢复。官方采样语义对照在 PC 独立完成。

## 构建与运行

`build.py` 只构建，不下载、不安装、不改 kernel。使用原 API19/Clang6.0.2/NDKr17c
支持库，kernel 的 GCC4.9 与来源完全不变。实际构建 73 个核心单元。
1679 个源码文件核对中，仅两个 backend 枚举文件使用固定 filesystem backport；
没有改模型数学文件。详见来源、patch 与完整性 JSON。

```powershell
python -B build.py `
  --ndk C:/dependencies/android-ndk-r17c `
  --support C:/dependencies/api19-support `
  --source C:/sources/llama-b11371 `
  --json-include C:/sources/llama-b11371/vendor/nlohmann `
  --filesystem-header C:/dependencies/filesystem.hpp `
  --worker-source ./qwen35-worker-samplingdiag.cpp `
  --output C:/build/qwen35-evaluation `
  --cmake C:/tools/cmake.exe --ninja C:/tools/ninja.exe
```

ARM executable 需要既有私有 Bionic launcher、库路径和只读 Android property FD。
只设置 `LD_LIBRARY_PATH` 不足以初始化该旧 runtime。
私有 stdin JSONL 最大 16 KiB，最多 12 条角色消息/8 KiB 内容，ctx 1024、输出上限 128 token。
诊断 deadline 上限 120 秒仅用于测量，不是生产响应承诺。

保留 plain、system-cache、dialogue-cache、sampling 与 samplingdiag 五个源码版本，
便于复现证据。两个 checkpoint 合计最多 64 MiB，仅内存，不保存文件。
对话快照须匹配控制器已经确认的完整角色历史及精确 token 前缀；网页无状态请求
不改语音快照。`clear_cache` 由唯一推理线程清理并返回 `cache_cleared`。

`adapter.py` 目前仅固定原 Q4_0 评估文件，**不是自动选择的新默认 provider**。
它不能自行接受另一份模型或把通过生成层测试解释为可发布。
权重、二进制、原始 logits 与 PC 编译目录均留在仓库外的私有 `work/` 中。
