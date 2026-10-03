# 本机语音助手核心

默认唤醒词为**二狗**。本目录实现状态机、短租约流式ASR、取消/打断、有限规则技能、
确认后修改唤醒词，以及可插拔本机LLM/TTS。这里只完成主机Fake I/O契约验证，
**没有据此声称手机麦克风、喇叭、自然人唤醒、AEC或全双工已经验证**。
手机设备与声学证据由硬件适配负责。

## 固定音频接口

`interfaces.AudioFrame(pcm16, aec_clean, at_monotonic, reference_active=False)`：
PCM16LE mono16k，每帧640字节/20ms。设备实现：

```python
start(on_frame)
capabilities()  # AudioCapabilities
play(pcm16, rate, *, generation, on_done)
interrupt()
set_volume(percent)
close()
```

`play`必须异步，只有实际drain结束才回调 `on_done(generation, True)`；取消/失败为False。
`interrupt`必须快速发出取消信号，不能在捕获回调/控制器锁内等待playback线程。
本机后端保持采播时钟，将后续语音换成零；已有有界缓冲到达硬件指针后回调False，
不执行可能阻塞采集的pcm_drop/prepare。音频时钟故障交由仅本voice服务重开恢复。
设备向控制器回调前应释放自身会与play/interrupt冲突的锁。`close`关闭采播并恢复保存的
mixer值。控制器不自行执行alsamixer、shell或PCM录音命令。

能力只在麦克风、喇叭、同时采播、AEC可用且AEC**实际验证**时显示full_duplex/barge_in。
没有验证AEC时，捕获可以继续，但播报期不把原始/有参考的帧送入唤醒和ASR；播报结束后
还有0.5秒自回声保护。该模式明确标为降级，不能描述为全双工。

## 工作与资源边界

- 捕获回调只计算320样本RMS、做VAD和有界入队，500ms预录25帧/16KiB。
  控制器锁忙时不等待，丢该帧并标记gap，随后中止该ASR段，不能将截断命令静默执行。
- 每次ASR最多50帧/32KiB待发，按200ms块自然流式送入既有本地socket。
- 未唤醒窗口最多4秒音频；对话最多15秒；socket lease最多20秒、排队等ready最多2秒。
  VAD静音/实际ASR端点即结束并返还共享ASR，不持有无限常驻客户端。
- 持续TV/噪声只触发一次VAD上升沿候选，不无间隙旋转wake leases；静音不调用ASR。
- ASR任务和回应任务各最多1个待处理，另有低频维护线程；闲置使用Condition等待。
- 3个控制器线程；温度读取在低频维护/主线程，捕获回调不访问sysfs。
- 超过65°C取消当前段/回应，保留原内核热保护，不改频率、CPU在线或硬件设置。
- 每次打断增加generation并取消旧工作；迟到的LLM/TTS和旧playback done不会复活旧答复。
- LLM建议只作为typed数据；模型文本、网页文本不会重入规则执行器。
- 联网查询默认Bing RSS优先、Wikipedia备用，只读HTTPS证据，查询120字符、3秒HTTP、32KiB响应、500字符摘要，
  固定来源host，不执行返回内容。结果含title/source_url/retrieved_utc/untrusted_data。
- 不保存PCM、默认转写日志、查询缓存或对话历史，不创建公网端口。

规则技能包括时间、当前名字、能力状态、0..100音量（含有限中文数字）、最大100/最小0、
±10音量、静音、取消，
以及显式“查一下/查询/搜索”的证据查询。音量动作经过温度门控和固定设备接口，
不接收shell、文件路径或模型任意工具名。联网功能须配置启用。

## 修改唤醒词

例：“二狗，把唤醒词改成小猪哥”。也可由LLM返回
`TypedIntent(kind='change_wake_word', value='小猪哥')`。

候选必须是2..8汉字或2..16ASCII字母数字，非空、无路径/控制字符。只提出候选并
播报确认问题；确认播报已drain后，10秒内另一个用户肯定回复才原子保存。
取消、超时、未drain确认、格式错误均不改配置。默认settings为
`/var/lib/dior-voice/settings.json`，仅version/wake_word、最多1KiB；fsync+原子替换，
不保存转写。重启读取新词；无效既有文件保留并报告load_error，不自动覆盖。

唤醒匹配对识别文本前缀做简单标点/空格清理，使用当前设置；不硬编码“小猪哥在”。
“以后叫你X/你的名字改成X/唤醒词改成X”由安全规则解析。
当前LocalLanguageModel适配器始终intent=None；TypedIntent是经契约测试的扩展接口，
这里不声称实际小模型已经能解析修改意图。“你是谁/你叫什么名字/叫啥”直接引用
当前设置回答，改名后同步新名。对话结束/取消/改词后和关闭时清除可用provider的
两轮短期内存摘要；clear_history不在捕获回调里执行，不保存聊天记录。

## provider/启动候选

TTS adapter为 `OfflineTTS(...).synthesize(text,cancel)`，返回PCM16 mono数据和采样率；
映射为AudioClip，最多20秒，文本最多120字符。espeak为机械合成声，不能称为神经自然声。
LLM adapter为 `LocalLanguageModel(...).generate(user_text,cancel,deadline,web_evidence)`，
返回LanguageReply(text, optionalTypedIntent)。无模型时仍可使用规则技能。

运行时CLI通过**安装时可信模块路径**选择provider，不通过语音输入决定模块、程序或路径：

```sh
python3 run_assistant.py \
  --audio-module /opt/dior-voice/runtime/audio_backend.py \
  --tts-module /opt/dior-voice/tts/offline_tts.py --tts-root /opt/dior-voice/tts \
  --tts-engine piper --settings /var/lib/dior-voice/settings.json \
  --asr-socket /run/dior-asr/recognize.sock
```

音频模块暴露 `create_device()`。可选LLM flags为 `--llm-module`、`--llm-binary`、
`--llm-model`，模型和程序必须先按提供者的哈希/设备gate验证。
CLI的 `--llm-threads` 默认4、`--llm-seconds` 默认25（1..30）、`--vad-rms` 默认180可调。
设备status报告error时，前台进程退出并close，让本服务supervisor恢复，不停止其它服务。
`--progress-cue`可启用chat/query等待前的固定短句“请稍等。”；Config默认False，
部署可显式选True。cue的drain不结束思考；generation和独立play-token防止晚到cue回调
清掉后续正常答复。固定短句cache命中不代表做了本轮神经模型推理。
本机小模型已测普通问答仍需数秒，不把提示音当成模型秒答。
`--status-only`不启动捕获，
仅输出配置能力；这不能替代真实声学检测。

OpenRC安装：独立dior-voice账号，仅给实际必需audio/dior-asr组；无wheel/video，
只本机，依赖localmount和已装dior-asr。代码/model root-owned不可写，settings目录0700，
settings0600。监督stdout/stderr不累计日志，停止只操作voice服务并执行close恢复mixer；
不重启网站、穿透，不刷分区或更改现有ASR包。开机监听须在真实设备能力gate通过后
启用，不能用Fake I/O通过替代硬件准备。

## 当前测试

```sh
python3 -B test_contracts.py
```

28项Fake I/O行为契约通过：默认/动态wake，固定volume，确认顺序/持久、取消/超时不写，
无效模型intent拒绝，typed建议仍需确认，未验证AEC真实降级和自播报抑制，qualified-clean
模拟打断的generation失效，5000静音帧零ASR及缓冲限界，热取消，stop线程退出，
晚到模型回复丢弃，网页/模型命令只当数据，无效既有settings保留。

另外已运行20秒wall-clock的主机FakeAudio闲置观测：1000帧，0次ASR，内存增长18137字节，
最大capture回调约0.166ms，stop后所有控制器线程退出。含tracemalloc的进程CPU时间
0.234秒（约1.17%单核）。600秒模拟静音帧也通过有界内存合同。
这些是主机控制器Fake I/O资源证据，不是手机ALSA/SpeexDSP的实际CPU占用或声学证明。

## 本机只读状态

常驻启动后可运行 `python3 voice_ctl.py`。默认AF_UNIX路径为
`/run/dior-voice/control.sock`，父目录必须service-owned0750，socket0660、group=dior-voice。
只接受 `{"op":"status"}`，无文本注入、确认、管理员操作或更改设置接口。
最多4连接，4KiB帧，绝对2秒收帧deadline；控制器忙时返回BUSY，不拖住捕获。
停止时关闭监听/连接，回收状态线程，只清理由本实例bind的socket。
因此无须每秒落盘状态或转写日志。

联网证据先请求Bing RSS，失败/无结果时才尝试Wikipedia，返回实际结果链接。
两种路径共用3秒单请求和总体deadline、32KiB预算；RSS实体/DTD拒绝，空结果不是成功。
DNS不受urlopen socket timeout约束，因此全部网络工作使用唯一有界daemon flight；
lookup主调用每20ms检查绝对deadline/cancel，旧DNS未完成时新调用返回busy，不再spawn。
晚于deadline或cancel的结果丢弃，不能进入新语音generation。后台最多一个网络flight，
可能卡住的DNS只能继续占这一slot，直至其退出或服务停止，不冒充已成功查询。
设备端会另行实际请求验证；本目录fake网络测试不标“联网已可用”。

## 可选专用KWS候选

`--kws-module/--kws-base/--kws-tts-base/--kws-threads`选择另行资格验证的
LocalKeywordSpotter。未提供backend时保留原有路径；提供后，IDLE只用独立后台KWS
任务，不用generic ASR反复猜短“二狗”。输入仍通过有界Span，不在capture同步IPC。
原生关键词命中只接受当前exact label与当前generation；单“二”不授权唤醒。

检测器保留最多1秒PCM replay加未消费队列，随后ASR只用于已确认的对话命令。
token timestamp是onset，不假称精确词末；不硬编码“耳钩→二狗”替换。
只有声学KWS已确认后，有限命令suffix才可忽略generic转写的前导误词；没有KWS命中
时从不启用这条容错。命中播放固定“我在，请说。”，后续实际回答可替换尚未drain的
ack/cue，旧play-token回调不能改变新播放状态。

改词在response worker先validate tokenizer/compile，确认后先set_keyword得到原生ack，
再atomic settings。失败不保存，uncertain ack或FS失败尝试恢复旧原生关键词。
不支持的英文候选拒绝；不在capture做文件/RPC。KWS死亡使本voice退出由supervisor恢复。
新增三个Fake契约检查同句命令、单“二”不接受、tokenizer/RPC先于持久化及失败不改。
这是可选接口，当前部署已经启用；专用KWS与数字注入联动记录见上级evidence。
部分独立合成短词失败且无真人输入，不标为自然唤醒或真人双讲验收完成。
