# 网站语音输入与只读 AI 助手

网站登录用户可以将自己浏览器录制的声音转换成文字，也可以用文字或语音提问，再在浏览器播放手机生成的语音。请求经过网站现有会话认证。公开网页不能读取手机常驻助手的麦克风，不能执行系统命令或更改项目。

手机网站进程通过 `/run/dior-inference/inference.sock` 访问本地共享推理服务。网站和手机语音助手复用一份常驻 Qwen 模型、现有 ASR 服务及 Piper。模型处理由私有服务排队，手机本机语音会优先使用服务，网站请求可能收到“正在使用模型，请稍后重试”。电脑开发环境没有手机推理服务时，状态接口明确返回不可用；不会用模拟回答替代模型。

## HTTP 接口

所有接口要求有效的 `flowboard_session`，均返回 `Cache-Control: no-store`。修改 HTTP 方法、跨站请求、无效会话、无权读取的资源及超出大小限制的内容会被拒绝。网站语音接口不接受文件路径、模型路径、Shell 命令、设备节点或服务器麦克风选择。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| `GET /api/voice/status` | 登录 Cookie | `available`、`busy`、`capabilities` 和 `limits`；不返回手机进程 ID、路径或其他用户数据 |
| `POST /api/voice/transcribe` | `application/octet-stream`，PCM16LE、单声道、16000 Hz；0.1 至 20 秒，最多 640000 字节 | `{ text, durationMs }` |
| `POST /api/voice/ask` | JSON `{ text, context: { kind, id? } }`；`kind` 为 `workspace`、`project` 或 `canvas`；文本最多 1000 字 | `{ answer, spokenAnswer, sources, dataAnswer, dataSummary?, readOnly, summaryOnly, contextTruncated, questionTruncated }` |
| `POST /api/voice/speech` | JSON `{ text }`，最多 120 字 | `audio/wav`，PCM16LE、单声道、16000 Hz；浏览器获取 Blob 并播放，不生成可长期访问的录音链接 |

查询当前项目时，`context` 是 `{ "kind": "project", "id": "mproj_..." }`。画布使用 `canvas` 和画布 ID，首页使用 `workspace` 且没有 ID。上下文只指定资源；服务器负责读取并检查权限，不信任客户端提供的“项目内容”。

`spokenAnswer` 是最多 64 字的口头摘要，长项目名称也会缩短，较长统计优先在标点边界结束；页面仍展示完整 `answer`。自动问答用短摘要播放，避免长统计播报经常超出 20 秒音频上限。手动调用语音接口仍允许最多 120 字；实际生成超过 20 秒时提示缩短文本。本机小模型上下文为 512 token，私有桥明确裁剪最长 480 UTF-8 字节的问题和最长 224 UTF-8 字节的资源摘要；裁剪时返回 `questionTruncated` 或 `contextTruncated`。`summaryOnly` 表明当前只处理文本和资料摘要，不能分析画布图片。最近问题、工作记录、来源列表均有数量上限，完整数据继续在原项目/画布页面查看。

项目状态、角色记录、分类、今日新增/更新/完成和完成率等事实问题由服务器从有权访问的数据直接计算，`dataAnswer` 为 `true`，不会让小模型猜测数字。完成率与项目页面相同：已完成数量除以未取消记录数量。今日记录使用上海时区；今日完成按 `completedAt`，今日处理/验收/发布按阶段更新时间，其余今日记录按创建时间。

针对选中项目或画布的“分析”“建议”“怎么做”“优先级”等问题会调用真实本地模型。项目上下文只保留项目名称、数量及按优先级排序的少量未完成问题，画布只保留名称、图形数和少量文字；发送到模型的摘要不超过 224 UTF-8 字节。响应的 `dataSummary` 和 `answer` 前半段保留服务器计算的真实数据，再追加“分析建议”，避免把模型建议当作精确统计。`spokenAnswer` 播放模型建议。打招呼、自我介绍及无关常识提问不附加项目资料，不占用小模型有限上下文；其 `sources` 为空。所有请求仍验证所选资源和会话，且在模型返回后重新检查权限。

## 权限和运行边界

- 项目创建者及其当前 `view`/`edit` 成员可以查询项目。管理员身份不会自动扩大语音查询的范围。
- 工作区只汇总用户当前可访问的项目及用户自己拥有的画布。项目成员身份不自动授权访问创建者的其他画布。
- 查询其他人的单张画布时，需要已有的显式分享能力：`x-flowboard-share-token`，密码分享同时携带 `x-flowboard-share-password`。能力只适用于选中的画布，且检查过期、撤销及密码，不会扩大到整位所有者的数据。
- 模型处理后重新检查会话、成员和分享权限。处理中被撤销的权限会导致旧回答被丢弃，包括工作区汇总中原本可读的项目。
- 查询接口保持只读。实际要求删除、创建、修改项目或执行命令时会提示使用页面操作，不声称已经执行。“怎么修改布局”仍可以获得模型建议，“谁修改”“修改记录”仍能读取工作记录，二者均不写入数据。
- 每位用户同时最多一个请求，每分钟最多 20 次；网站全局最多两个在途请求。用户限流表最多 512 项，按分钟过期；私有推理服务另有自己的连接和队列上限。
- 上传绝对超时 12 秒；推理私有任务最长 30 秒，HTTP 留出少量传输/清理时间。浏览器取消会关闭对应 Unix 连接，私有服务随后取消自己的任务。
- 真机连续运行神经网络会升温。私有服务在温度降到配置准入温度（默认 52°C）后才开始动态推理，并在运行超过 65°C 时取消任务保护；等待冷却计入原 30 秒任务期限。状态接口用 `cooling`/`busy` 及“模型正在冷却”文案表示暂停，服务仍然已安装。温度传感器不可用时单独提示检测不可用和暂停处理，不把未知温度说成高温。
- 不把浏览器录音、识别文字、问答内容写入磁盘日志或缓存。TTS WAV 仅作为本次响应返回，网站问答在模型端不保留历史。
- 单份可读 JSON 最大 12 MiB，工作区扫描最多 512 份 JSON、32 MiB；达到上限时要求选择具体项目。目录按顺序迭代，不构建无限扫描队列。

## 可复现验证

`node tests/website-voice-http.mjs` 启动隔离的真实 HTTP 服务器及临时账户/项目。推理桥使用明确标注的模拟对象，测试认证、成员/分享边界、处理期间权限撤销、准确统计、限流、取消、输入大小、错误响应和无录音/聊天日志。这些结果不表示模型识别准确率或真人麦克风验收。

手机端完整链路使用 `tests/website-voice-real.ts`：

```sh
# 先在电脑构建，只生成测试用 CJS，不连接生产数据：
npx esbuild tests/website-voice-real.ts --bundle --platform=node --target=node14 --format=cjs --outfile=website-voice-real.cjs

# 在手机上以 flowboard UID 101 执行；输入是专门生成的测试 WAV：
FLOWBOARD_VOICE_SOCKET=/run/dior-inference/inference.sock \
FLOWBOARD_VOICE_TEST_WAV=/tmp/generated-test.wav \
node /tmp/website-voice-real.cjs
```

真实测试自动创建并删除自己的 `/tmp/flowboard-voice-http-*`，绑定临时回环端口，生成一次性测试会话，检查 HTTP 认证/隔离、真实 PCM 识别、真实模型回答和真实 WAV 响应。它不读取或写入 `/opt/flowboard` 的用户、画布、项目或分享数据。不提供 WAV/PCM 时明确报告未验证识别链路。测试报告不包含会话 Cookie。
