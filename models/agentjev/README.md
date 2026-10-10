# AgentJev-0.6B

使用完整已训练权重和原始候选决策头，输出 choice、boolean、score 的概率分布，不生成聊天文字。源码与 BF16 v1 权重固定在 manifest.json 的版本并验证 SHA256。首次准备只下载配置、分词器及决策权重，不另行下载 Qwen 基础权重。

## 电脑参考服务

从仓库根目录执行（建议 Python 3.12）：

```sh
python -m venv models/agentjev/.venv
# Windows 使用 models/agentjev/.venv/Scripts/python.exe
models/agentjev/.venv/bin/python -m pip install -r models/agentjev/requirements.txt
models/agentjev/.venv/bin/python models/agentjev/prepare.py
models/agentjev/.venv/bin/python models/agentjev/service.py
```

默认使用 FP32 CPU 计算，模型权重内存约 2.4GB，仅作为电脑参考实现。`--quantization int8` 动态量化 Linear 层，Embedding 仍为 FP32，需要另行对照精度；这个选项不能直接用于缺少 PyTorch 的 ARMv7 手机。

## 已安装的 ARMv7 手机服务

2026-10-10 在 Redmi Note 4G（dior，ARMv7，约 2GB RAM，Linux 3.4）完成实际运行与网页接入。手机使用 INT8 ONNX 编码器、FP32 原始训练候选头，以及标准库 Python 分词器，不依赖 PyTorch。三个模型文件共约 608MB，实测模型进程峰值 RSS 约 565MiB。它输出决策分布，不是聊天助手。

实际网页接口测试：选择 21.794 秒，真假 12.043 秒，评分 20.108 秒；直接模型接口短选择测试 15.46 秒。不同输入长度、候选数量和温度会改变耗时。这台旧手机目前不能保证秒级输出。分词器在 506 条文本上与 Hugging Face 分词器一致；这不证明模型的中文判断质量。

中文测试中，“项目中的登录页面打不开 / 是否存在程序故障”被判为否，网站测试中否概率约 56.8%。原始电脑 FP32 模型同样误判（否约 54.2%）。INT8 和批大小也会改变分布，业务阈值尚未校准，不能把概率当作已经验证的准确率。`phoneQualified: false` 表示中文准确性、长期热稳定性和长输入尚未完整验收，手机实际运行证据见 evidence/phone-verification.json。

手机安装布局：

```text
/opt/agentjev/app/           Python 服务与分词器代码
/opt/agentjev/assets/        tokenizer/config/temperatures 文件
/opt/agentjev/model/         encoder.int8.onnx、encoder.int8.onnx.data、head.onnx
/opt/agentjev/runtime/lib/   私有 GNU loader、GNU 库和 ONNX Runtime 1.14.1
/opt/agentjev/agentjev-worker
```

导出电脑上的模型后，按 native/README.md 准备 ARM worker 和私有库。将上述文件放在手机指定位置，以 root 执行 `python3 /opt/agentjev/app/install-service.py`。脚本建立无登录权限的 agentjev 用户、启动 OpenRC 服务，确认健康后加入默认启动级别。服务程序和模型文件应保持 root 所有、服务用户只读；不要上传电脑 FP32 权重替代 ONNX 文件。

手机命令为 `service.py --backend native --root /opt/agentjev --worker /opt/agentjev/agentjev-worker --threads 2 --max-tokens 512 --port 8149`。必须由私有 GNU loader 启动 worker，不能直接用 Alpine 的 musl loader 运行 GNU 程序。不会替换系统库或修改内核。

## 网页与运行边界

网站默认连接 http://127.0.0.1:8149；登录后点击“概率判断”，输入内容、问题和选项。参考范围由网站鉴权，只提供有权限的文字摘要；结果不执行命令或修改网站数据。服务仅监听回环地址，一次计算、繁忙立即拒绝、不排队；手机路径上限 512 token，超长输入拒绝、不静默截断。短路径最多批处理 4 条，批内总填充长度最多 256 token，保留完整候选决策头。

手机温度超过 45°C 或读不到温度时不接收计算，计算中超过 65°C 时停止 worker；模型计算期限 55 秒，网站等待上限 60 秒。worker 异常退出后父服务退出，OpenRC 有限重启。取消页面等待关闭 HTTP 连接，已开始的计算可能继续至该请求结束。日志不记录用户文本或概率。

旧“二狗”网页录音、语音问答、唤醒、聊天、播报和手机推理桥均已移除；`linux/dior/retire-assistant.py --apply` 清理设备上的旧安装与账户，网站和独立 ASR 保留。新服务没有录音入口。

第三方来源：AgentJev https://github.com/malevrigns/agent-jev（Apache-2.0），Qwen/Qwen3-0.6B 架构与分词器（Apache-2.0），ONNX Runtime（MIT）。二进制库及模型权重不提交源码仓库，私有 GNU 库和 ONNX 库的来源与哈希由 native/RUNTIME-SOURCES.json 固定。
