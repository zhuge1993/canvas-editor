# 本地小模型与需求自动分派

当前手机服务已由 AgentJev-0.6B 换为 `BAAI/bge-small-zh-v1.5`：23,953,920 参数，4 层中文 BERT 语义模型，INT8 模型文件 23,902,853 字节（约 23MB）。模型、原始权重及配置固定在 manifest.json 的提交与 SHA256。它适合短文本分类、候选描述匹配，不生成聊天文字，也不解释推理过程。

2026-10-11 在 Redmi Note 4G（ARMv7、Linux 3.4）实测：手机 OpenAI 格式网关首次候选匹配 0.377–0.502 秒，复用候选描述后 0.129–0.159 秒；OpenAI 官方 Python 客户端通过公网隧道的三个短文本分类为 0.547–0.625 秒。worker 峰值 RSS 42,920KB（约 42MiB）。这些数字是短文本、少量选项和可运行温度下的观测，不包含等待冷却；长输入、更多选项、网络状况和温度会影响速度。记录见 evidence/phone-http.json 与 evidence/openai-sdk.json。

`distribution` 是候选文本与输入文本的余弦相似度，经温度 0.08 的 softmax 归一化后的匹配权重；它不是经过校准的“判断正确概率”。问题名称仅标注任务，决定分类含义的是候选描述。真假判断必须提供 `criteria.true/false` 两种完整描述；等级评分匹配给定等级文字，不具备通用逻辑推理或事实核验能力。部署验证覆盖协议、权限和几个选定例子，没有证明广泛业务准确性。

每条输入最多 128 个 BERT token（含 CLS/SEP），不截断；正文与网页参考摘要合并计算该限制。建议短文本与完整选项描述。最多 4 个问题、每题 16 个选择项或 10 个等级；一次请求、不排队、模型期限 10 秒。超过 45°C 或温度不可读时暂缓受理，计算期间超过 65°C 时停止 worker，由 OpenRC 有限重启。

输入编码一次，候选描述独立编码并以最多 128 项的内存缓存复用。逐条编码使动态激活量化不受其他批内文本影响，冷、热缓存下相同输入的分布经手机测试完全一致。缓存不落盘，日志不记录文本、匹配权重或 API 密钥。

## 手机布局与安装

```text
/opt/fast-decision/app/          service.py、engine.py、tokenizer.py、decision_contract.py
/opt/fast-decision/assets/       vocab.txt
/opt/fast-decision/encoder.int8.onnx
/opt/fast-decision/manifest.json
/opt/fast-decision/fast-decision-worker
/opt/fast-decision/runtime/lib/  私有 GNU loader 和 ONNX Runtime 1.14.1 库
```

手机不依赖 Torch 或 NumPy，使用标准库 Python 和原生 worker，私有 GNU 库不替换系统库。程序和模型为 root 所有，只允许服务账户读取，监听 `127.0.0.1:8149`，OpenRC 服务名 `fast-decision`。准备好以上文件后，以 root 执行 `python3 /opt/fast-decision/app/install-service.py`。旧 `/opt/agentjev`、其 OpenRC 服务和账户已从本次手机安装中移除；网站账号与项目数据保留。

在 Python 3.12 电脑上准备：

```sh
python -m pip install -r models/fast-decision/requirements.txt
python models/fast-decision/prepare.py
python models/fast-decision/native/prepare-runtime.py --root models/fast-decision/runtime
```

手机只需要导出的 INT8 图和词表，不需要原始 FP32 权重。`prepare.py` 校验固定的 HF 权重与配置，导出原始 CLS 表征并 L2 归一化，量化 MatMul/Gather，校验动态批输入和有限输出，写出 runtime/manifest.json。重新导出时将该运行 manifest 一并部署。

ARM cross build 使用 LLVM 6 clang、NDK r17c GNU binutils/libgcc、Ubuntu Focal ARMhf libc6-dev 2.31 头文件/startup objects。运行库的官方压缩包和哈希见 native/RUNTIME-SOURCES.json；只提取 GNU 与 ONNX ELF 库，不安装任何语音程序或权重。GNU 开发包为 `libc6-dev_2.31-0ubuntu9.18_armhf.deb`，SHA256 `fedd4b12c29a45094dacedf727101b6674c3f89ed07656eb5baffc072e0f411c`，来自 Ubuntu ports glibc 包目录。

```sh
python models/fast-decision/native/build.py --clang CLANG_EXE --binutils NDK_BIN_DIRECTORY --gnu-dev GNU_HEADERS_DIRECTORY --private-libs models/fast-decision/runtime/runtime/lib --onnx-libs models/fast-decision/runtime/runtime/lib --output models/fast-decision/runtime/fast-decision-worker
```

转移文件前后对照 SHA256。worker 通过私有 `ld-linux-armhf.so.3 --library-path` 启动，不直接使用 Alpine musl loader。

## 网站与 OpenAI 格式 API

项目内点击“提交需求”，提交者只填标题、描述与可选附件和公共业务字段，无需选择岗位或处理人。创建者在项目设置中配置角色职责和有编辑权限的成员；系统内部构造岗位候选，使用手机本机模型匹配需求开头，选出岗位后按项目内未完成任务数量选择处理人并一起保存。只有一个可处理岗位时直接分配，不运行语义竞争。原“快速判断”浮窗已移除。

路由最多使用需求开头96个Unicode字符和各岗位职责开头96个字符，完整正文仍保存。最多16个有可编辑处理人的岗位。最高余弦相似度需≥0.55，领先下一岗位≥0.015且匹配权重差≥0.02；这些是保守拒绝阈值，不是校准准确率。温度、超时、弱匹配、无处理人、配置变更或模型繁忙会保存待分派及原因，不自动重试；负责人可在事件详情中调整。缺少业务字段可在分派后补齐。不会自动发邮件或站内通知，通知仍需明确推送。

`POST /api/management/projects/:id/intake`要求登录、项目owner/edit权限与mutationId；服务器拒绝客户端指定roleId、assigneeId、recipientIds、status。重复mutationId返回同一事件，模型推断不占项目/全数据写锁，写入前再次检查会话、成员和职责配置。备份、历史与AI导出保留分派状态和原因；公开导出不新增账号ID。

手机五条技术/美工/策划实例在预设职责下全部正确路由，首次职责编码0.79秒，复用后0.11–0.15秒，见evidence/dispatch-cases.json。这些实例验证功能连接，不代表所有需求都能准确分派。

OpenAI 格式 API 接入说明见 frontend/docs/openai-compatible.md。API 使用独立 Bearer 密钥，仅判断调用方提供的文字，不读取账号、项目或画布。可以使用 OpenAI SDK，但请求发送到你自己的手机服务，不调用 OpenAI 模型。支持 `/v1/models`、`/v1/chat/completions` 和 SSE；没有通用文本生成、工具调用、图片或 JSON Schema 支持。

来源：[BAAI/bge-small-zh-v1.5](https://huggingface.co/BAAI/bge-small-zh-v1.5)（MIT），[FlagEmbedding](https://github.com/FlagOpen/FlagEmbedding)；ONNX Runtime C API header 和运行库为 MIT，附 LICENSE.onnxruntime。权重、可执行文件、缓存和密钥不提交源码。
